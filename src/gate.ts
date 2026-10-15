import { Plugin } from '@opencode/plugin';
import {
  brief,
  describeSdkError,
  execShell,
  logDiag,
  runCommand,
  truncateTail,
} from './process.js';
import {
  consumeBootstrapGateCommand,
  effectiveMaxRetries,
  fail,
  GateAborted,
  loadGateConfig,
  parseOnlyCommand,
  readBootstrapGateCommand,
  validateTopLevelSessionMetadata,
  type GateMode,
} from './config.js';
import { runAdoPrAssertion } from './ado-pr.js';
import { runReviewAssertion } from './review.js';
import type {
  AdoPrPollOptions,
  AssertionOutcome,
  CommandAssertion,
  GateAssertion,
  ReviewSessionClient,
} from './types.js';

/** The V2 plugin context, as passed to `setup`. */
type GateContext = Plugin.Context;

// ---------------------------------------------------------------------------
// Plugin state + handlers
// ---------------------------------------------------------------------------

const MARKER = '[completion-gate]';
const INTERNAL_MARKER = '[completion-gate-internal]';
// Out-of-band gate arming for orchestration launchers (e.g. Invoke-HerdrOpenCode.ps1):
// the launcher sets these process-scoped env vars before spawning opencode, and
// the session.created handler below consumes them (one-shot). Nothing enters the
// --prompt chat transcript; confirmation is a synthetic session message. _B64 takes
// precedence when both are set (it avoids shell-quoting pitfalls in the launcher).
const TOGGLE_RE = /^\[completion-gate\](?:\s+(.*?))?\s*$/i;
const INJECTED_FAILURE_RE =
  /^✖ Completion gate failed — "[^"]+"\. Fix these issues, then finish again\.\n\n```[\s\S]*\n```\n\n\(RETRY \d+\/\d+\)$/;
const INJECTED_SUCCESS_RE = /^✅ Completion gate passed \([^\n]*\)\. You may report done\.$/;

interface GateSessionState {
  sessionID: string;
  directory: string;
  gateEnabled: boolean;
  extraCommand?: string;
  gateMode: GateMode;
  /** Per-session retry cap for command-only mode (`/gate --only ... --retries N`).
   *  Null/absent = fall back to the project config (or the default 3). */
  sessionMaxRetries: number | null;
  retries: number;
  lastOutcome: 'pass' | 'fail' | null;
  escalated: boolean;
  busy: boolean;
  deleted: boolean;
}

type BootstrapCommand = ReturnType<typeof readBootstrapGateCommand>;

interface GateRuntime {
  sessions: Map<string, GateSessionState>;
  deleted: Set<string>;
  generations: Map<string, number>;
  bootstrapPending: BootstrapCommand;
  bootstrapCaptured: boolean;
  seen: Set<string>;
}

// OpenCode V2 evaluates a plugin once per location/host, so the same module can
// run several times in one process. Keep the gate's mutable state on globalThis
// so every instance shares one session registry and one retry budget; each
// instance still registers its own location-scoped `/gate` command and its own
// event subscription, and the shared `busy` flag serializes evaluations.
const RUNTIME_KEY = Symbol.for('opencode.completion-gate.runtime.v2');

function runtime(): GateRuntime {
  const store = globalThis as unknown as Record<symbol, GateRuntime | undefined>;
  let rt = store[RUNTIME_KEY];
  if (!rt) {
    rt = {
      sessions: new Map(),
      deleted: new Set(),
      generations: new Map(),
      bootstrapPending: null,
      bootstrapCaptured: false,
      seen: new Set(),
    };
    store[RUNTIME_KEY] = rt;
  }
  return rt;
}

function getSessionGeneration(sessionID: string): number {
  return runtime().generations.get(sessionID) ?? 0;
}

function advanceSessionGeneration(sessionID: string): void {
  const rt = runtime();
  rt.generations.set(sessionID, (rt.generations.get(sessionID) ?? 0) + 1);
}

function createGateSessionState(sessionID: string, directory: string): GateSessionState {
  return {
    sessionID,
    directory,
    gateEnabled: false,
    gateMode: 'combined',
    sessionMaxRetries: null,
    retries: 0,
    lastOutcome: null,
    escalated: false,
    busy: false,
    deleted: false,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Minimal structural view of the V2 event stream we consume. */
interface GateEvent {
  type?: unknown;
  data?: {
    sessionID?: unknown;
    parentID?: unknown;
    location?: { directory?: unknown };
  };
}

async function getOrRegisterSession(
  ctx: GateContext,
  sessionID: string
): Promise<GateSessionState | null> {
  const rt = runtime();
  const existing = rt.sessions.get(sessionID);
  if (existing) return existing.deleted ? null : existing;

  const lookupSessionID = sessionID;
  const lookupGeneration = getSessionGeneration(lookupSessionID);

  try {
    const info = (await ctx.session.get({ sessionID: lookupSessionID })) as {
      id?: unknown;
      parentID?: unknown;
      location?: { directory?: unknown };
    };
    const validated = validateTopLevelSessionMetadata({
      id: info?.id,
      directory: info?.location?.directory,
      parentID: info?.parentID,
    });
    if (!validated) {
      logDiag(
        `lazy registration rejected session ${lookupSessionID}: invalid top-level session metadata`
      );
      return null;
    }
    if (
      rt.deleted.has(lookupSessionID) ||
      getSessionGeneration(lookupSessionID) !== lookupGeneration
    ) {
      logDiag(
        `lazy registration ignored session ${lookupSessionID}: session was deleted or superseded while lookup was pending`
      );
      return null;
    }

    const state = createGateSessionState(validated.sessionID, validated.directory);
    rt.sessions.set(state.sessionID, state);
    logDiag(`lazily registered session ${state.sessionID} (${state.directory})`);
    return state;
  } catch (err) {
    logDiag(`lazy registration lookup failed for ${sessionID}: ${describeSdkError(err)}`);
    return null;
  }
}

/**
 * Surface a notice to the user as a synthetic session message. V2 server plugins
 * have no toast surface (`ui.toast` only exists for TUI plugins), so the previous
 * `client.tui.showToast` feedback becomes a transcript message plus a diag line.
 */
async function notify(ctx: GateContext, state: GateSessionState, message: string): Promise<void> {
  logDiag(`notify ${state.sessionID}: ${message}`);
  try {
    await ctx.session.synthetic({ sessionID: state.sessionID, text: message });
  } catch (err) {
    logDiag(`notify failed: ${describeSdkError(err)}`);
  }
}

/**
 * Drive the agent loop by submitting a prompt. Used for failure evidence and the
 * success notice: unlike `ctx.session.synthetic`, `ctx.session.prompt` is the
 * direct successor of V1 `promptAsync` and guarantees the model runs a turn.
 * The injected text is marked with MARKER so the prompt hook recognises it and
 * does not treat it as a genuine user message that resets the retry budget.
 */
async function injectPrompt(ctx: GateContext, sessionID: string, text: string): Promise<void> {
  try {
    await ctx.session.prompt({ sessionID, text });
  } catch (err) {
    logDiag(`prompt injection error: ${describeSdkError(err)}`);
  }
}

type ToggleKind = 'enabled' | 'disabled' | 'status' | 'usage';

async function applyToggle(
  ctx: GateContext,
  state: GateSessionState,
  rawArgument: string
): Promise<{ notice: string; kind: ToggleKind }> {
  const normalized = rawArgument.trim().toLowerCase();
  const arg = normalized || 'on';

  if (arg === 'status') {
    const loaded = loadGateConfig(state.directory);
    const cap =
      state.gateMode === 'command-only' && state.sessionMaxRetries !== null
        ? { value: state.sessionMaxRetries, source: 'session' as const }
        : { value: loaded?.config.maxRetries ?? 3, source: 'config' as const };
    const notice = `Completion gate: ${state.gateEnabled ? 'ENABLED' : 'disabled'} · retries=${state.retries} · lastOutcome=${state.lastOutcome ?? 'n/a'} · extraCommand=${state.extraCommand ? 'configured' : 'none'} · mode=${state.gateMode} · maxRetries=${cap.value} (${cap.source})`;
    await notify(ctx, state, notice);
    return { notice, kind: 'status' };
  }

  if (/^--only/i.test(rawArgument.trim())) {
    const onlyMatch = /^--only(.*)$/i.exec(rawArgument.trim());
    const remainder = onlyMatch?.[1] ?? '';
    const parsed = parseOnlyCommand(remainder);
    if (!parsed.command || parsed.invalidRetry) {
      const notice = 'Usage: /gate --only "command" [--retries N]';
      await notify(ctx, state, notice);
      return { notice, kind: 'usage' };
    }
    state.extraCommand = parsed.command;
    state.gateMode = 'command-only';
    state.sessionMaxRetries = parsed.maxRetries ?? null;
    state.gateEnabled = true;
    state.retries = 0;
    state.escalated = false;
    state.lastOutcome = null;
    const notice =
      parsed.maxRetries !== undefined
        ? `Completion gate armed (command-only): ${parsed.command} · maxRetries=${parsed.maxRetries}`
        : `Completion gate armed (command-only): ${parsed.command}`;
    await notify(ctx, state, notice);
    logDiag(
      `gate command-only custom command registered on ${state.sessionID}` +
        (parsed.maxRetries !== undefined ? ` (session maxRetries=${parsed.maxRetries})` : '')
    );
    return { notice, kind: 'enabled' };
  }

  if (arg !== 'on' && arg !== 'off') {
    state.extraCommand = rawArgument.trim();
    state.gateMode = 'combined';
    state.gateEnabled = true;
    state.retries = 0;
    state.escalated = false;
    state.lastOutcome = null;
    const notice = `Completion gate armed (combined): ${state.extraCommand}`;
    await notify(ctx, state, notice);
    logDiag(`gate custom command registered on ${state.sessionID}`);
    return { notice, kind: 'enabled' };
  }

  state.gateEnabled = arg === 'on';
  if (state.gateEnabled) {
    state.retries = 0;
    state.escalated = false;
    state.lastOutcome = null;
  }
  const notice = `Completion gate ${state.gateEnabled ? 'enabled' : 'disabled'} for this session.`;
  await notify(ctx, state, notice);
  logDiag(`gate ${arg} on ${state.sessionID}`);
  return { notice, kind: state.gateEnabled ? 'enabled' : 'disabled' };
}

// Warn at enable time when there is nothing to run: without this, an enabled
// gate on a session whose directory resolves to no config looks dead.
async function warnIfNothingToRun(ctx: GateContext, state: GateSessionState): Promise<void> {
  if (state.extraCommand) return;
  if (loadGateConfig(state.directory)) return;
  const msg = `Completion gate enabled but nothing to run: no .opencode/completion-gate.json found from ${state.directory}.`;
  logDiag(`gate on ${state.sessionID}: ${msg}`);
  await notify(ctx, state, msg);
}

// Start an evaluation right away (fire-and-forget). The `/gate` command and the
// session-created wake-up do not produce a fresh idle event, so the gate would
// otherwise stay dormant until the next real turn. The busy flag serializes
// overlaps with the idle handler.
function kickGateTurnEnd(ctx: GateContext, state: GateSessionState, reason: string): void {
  if (state.deleted || !state.gateEnabled || state.busy) return;
  if (process.env.OPENCODE_GATE_DISABLED === '1') return;
  state.busy = true;
  logDiag(`gate kick on ${state.sessionID} (${reason}) — evaluation starting`);
  runGateTurnEnd(ctx, state)
    .catch((err: unknown) => logDiag(`gate flow error: ${describeSdkError(err)}`))
    .finally(() => {
      state.busy = false;
    });
}

// ---------------------------------------------------------------------------
// Assertion orchestration
// ---------------------------------------------------------------------------

export async function runCommandAssertion(
  a: CommandAssertion,
  cwd: string,
  isAborted?: () => boolean
): Promise<AssertionOutcome> {
  if (isAborted?.()) throw new GateAborted();
  logDiag(
    `command "${a.name}": running ${JSON.stringify(a.run)} (cwd=${cwd}, timeout=${a.timeoutSeconds}s)`
  );
  const r = await runCommand(a.run, cwd, a.timeoutSeconds * 1000);
  logDiag(
    r.timedOut
      ? `command "${a.name}": TIMED OUT after ${a.timeoutSeconds}s`
      : `command "${a.name}": exit code ${r.code}`
  );
  if (!r.timedOut && r.code === 0) return { name: a.name, passed: true, evidence: '' };
  const why = r.timedOut ? `command timed out after ${a.timeoutSeconds}s` : `exit code ${r.code}`;
  return fail(
    a.name,
    `${why}\n${truncateTail([r.stderr, r.stdout].filter((s) => s.trim()).join('\n---\n'))}`
  );
}

export async function evaluateAssertions(
  assertions: GateAssertion[],
  projectRoot: string,
  client?: ReviewSessionClient,
  isAborted?: () => boolean,
  adoOpts?: AdoPrPollOptions
): Promise<AssertionOutcome[] | null> {
  const results: AssertionOutcome[] = [];
  for (const a of assertions) {
    if (isAborted?.()) return null;
    let result: AssertionOutcome;
    logDiag(`evaluating assertion "${a.name}" (${a.type})`);
    try {
      if (a.type === 'command') {
        result = await runCommandAssertion(a, projectRoot, isAborted);
      } else if (a.type === 'ado-pr') {
        result = await runAdoPrAssertion(a, projectRoot, execShell, { ...adoOpts, isAborted });
      } else {
        result = await runReviewAssertion(a, projectRoot, client, isAborted);
      }
    } catch (err: unknown) {
      if (err instanceof GateAborted) {
        logDiag(`assertion "${a.name}" aborted mid-run`);
        return null;
      }
      result = fail(a.name, `gate could not run this assertion: ${describeSdkError(err)}`);
    }
    results.push(result);
    if (!result.passed) {
      logDiag(
        `assertion "${a.name}" FAILED — ${brief(result.evidence)} (stopping here, remaining assertions skipped)`
      );
      break; // short-circuit — evidence focuses on one problem
    }
    logDiag(`assertion "${a.name}" passed`);
  }
  return results;
}

// Build a V2 reviewer-session client from the plugin context. Used by the
// `opencode-review` assertion.
function buildReviewClient(ctx: GateContext): ReviewSessionClient {
  const assistantText = (
    messages: ReadonlyArray<{
      type?: unknown;
      content?: ReadonlyArray<{ type?: unknown; text?: unknown }>;
    }>
  ): string => {
    const out: string[] = [];
    for (const message of messages ?? []) {
      if (!message || message.type !== 'assistant') continue;
      for (const content of message.content ?? []) {
        if (content && content.type === 'text' && typeof content.text === 'string')
          out.push(content.text);
      }
    }
    return out.join('\n');
  };

  return {
    session: {
      create: async () => {
        const created = await ctx.session.create({ title: 'completion-gate self-review' });
        return { id: created?.id };
      },
      prompt: async ({ sessionID, text, agent }) => {
        if (agent) {
          try {
            await ctx.session.switchAgent({ sessionID, agent });
          } catch (err) {
            logDiag(`review switchAgent failed: ${describeSdkError(err)}`);
          }
        }
        await ctx.session.prompt({ sessionID, text });
        await ctx.session.wait({ sessionID });
      },
      context: async ({ sessionID }) => {
        const messages = (await ctx.session.context({ sessionID })) as ReadonlyArray<{
          type?: unknown;
          content?: ReadonlyArray<{ type?: unknown; text?: unknown }>;
        }>;
        return assistantText(messages);
      },
      abort: async ({ sessionID }) => {
        try {
          await ctx.session.interrupt({ sessionID });
        } catch {
          /* best effort */
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Turn-end gate flow
// ---------------------------------------------------------------------------

function injectFailureText(
  state: GateSessionState,
  outcome: AssertionOutcome,
  maxRetries: number
): string {
  return [
    `${MARKER} ✖ Completion gate failed — "${outcome.name}". Fix these issues, then finish again.`,
    '',
    '```',
    outcome.evidence,
    '```',
    '',
    `(RETRY ${state.retries}/${maxRetries})`,
  ].join('\n');
}

async function runGateTurnEnd(ctx: GateContext, state: GateSessionState): Promise<void> {
  const isAborted = (): boolean =>
    state.deleted || !state.gateEnabled || process.env.OPENCODE_GATE_DISABLED === '1';
  if (state.lastOutcome === 'pass') {
    // Already green this streak (success note injected). Re-running all
    // assertions on every subsequent idle would waste minutes of builds/tests;
    // a genuine user message resets the cycle instead.
    logDiag(`gate turn-end skipped on ${state.sessionID} — already green this streak`);
    return;
  }
  const loaded = loadGateConfig(state.directory);
  if (!loaded && !state.extraCommand) {
    logDiag(
      `gate turn-end on ${state.sessionID}: no .opencode/completion-gate.json found from ${state.directory} — nothing to run`
    );
    return;
  }
  const projectRoot = loaded?.projectRoot ?? state.directory;
  const config = loaded?.config ?? { maxRetries: 3, assertions: [] };
  const cap = effectiveMaxRetries(state, config.maxRetries);
  const sessionAssertion: CommandAssertion = {
    type: 'command',
    name: 'session-command',
    run: state.extraCommand ?? '',
    timeoutSeconds: 300,
  };
  const assertions: GateAssertion[] = state.extraCommand
    ? state.gateMode === 'command-only'
      ? [sessionAssertion]
      : [sessionAssertion, ...config.assertions]
    : config.assertions;
  logDiag(
    `gate turn-end on ${state.sessionID}: ${loaded ? `config ${loaded.path}` : 'command-only without project config'} (${assertions.length} assertion(s), maxRetries=${cap.value} (${cap.source}), retries so far=${state.retries})`
  );

  const results = await evaluateAssertions(
    assertions,
    projectRoot,
    buildReviewClient(ctx),
    isAborted
  );
  if (results === null) {
    logDiag(
      `gate turn-end ABORTED on ${state.sessionID} — gate was disabled mid-run, staying silent`
    );
    return;
  }
  const last = results[results.length - 1];
  if (!last) return;

  if (last.passed) {
    logDiag(`gate PASSED on ${state.sessionID}: all ${results.length} assertion(s) green`);
    if (isAborted()) {
      logDiag(`gate turn-end ABORTED on ${state.sessionID} — gate disabled before success notice`);
      return;
    }
    state.lastOutcome = 'pass';
    await injectPrompt(
      ctx,
      state.sessionID,
      `${MARKER} ✅ Completion gate passed (${results.map((r) => r.name).join(', ')}). You may report done.`
    );
    return;
  }

  if (isAborted()) {
    logDiag(`gate turn-end ABORTED on ${state.sessionID} — gate disabled before retry injection`);
    return;
  }
  state.lastOutcome = 'fail';
  if (state.retries >= cap.value) {
    if (!state.escalated) {
      state.escalated = true;
      await notify(
        ctx,
        state,
        `→ Completion gate "${last.name}" still failing after ${cap.value} retries — manual attention needed`
      );
      logDiag(
        `gate ESCALATED on ${state.sessionID}: "${last.name}" still failing after ${cap.value} retries — manual attention needed`
      );
    }
    return;
  }

  state.retries += 1;
  logDiag(
    `gate FAILED on ${state.sessionID}: "${last.name}" — retry ${state.retries}/${cap.value}, injecting fix request`
  );
  await injectPrompt(ctx, state.sessionID, injectFailureText(state, last, cap.value));
}

// ---------------------------------------------------------------------------
// Prompt hook: retry-budget reset + legacy in-band directives
// ---------------------------------------------------------------------------

interface PromptHookEvent {
  sessionID?: unknown;
  prompt?: { text?: string };
}

async function handlePrompt(ctx: GateContext, event: PromptHookEvent): Promise<void> {
  const sessionID = asString(event?.sessionID);
  if (!sessionID) return;
  const state = runtime().sessions.get(sessionID);
  if (!state || state.deleted) return;
  const text: string = event?.prompt?.text ?? '';

  if (text.trimStart().startsWith(INTERNAL_MARKER)) {
    const lines = text.split(/\r?\n/);
    const directive = lines.shift()?.trim() ?? '';
    const argument = directive.slice(INTERNAL_MARKER.length).trim();
    if (/^--only\s+/i.test(argument)) {
      await applyToggle(ctx, state, argument);
      const remainder = lines.join('\n').replace(/^\n+/, '');
      if (event.prompt) event.prompt.text = remainder;
    }
    return;
  }

  if (!text.trimStart().startsWith(MARKER)) {
    // genuine user message → reset the fix-cycle budget
    state.retries = 0;
    state.escalated = false;
    state.lastOutcome = null;
    return;
  }

  const t = TOGGLE_RE.exec(text.trim());
  const argument = (t?.[1] ?? '').trim();
  if (!t || INJECTED_FAILURE_RE.test(argument) || INJECTED_SUCCESS_RE.test(argument)) return; // leave plugin-injected notices untouched

  const applied = await applyToggle(ctx, state, argument);
  if (applied.kind === 'enabled') await warnIfNothingToRun(ctx, state);
  // The prompt hook cannot suppress the turn the way V1's command hook could, so
  // constrain it instead: an anchor stops the model from re-emitting previous
  // tool calls on what would otherwise be a near-empty message. Prefer the /gate
  // slash command (fully plugin-owned, no model turn) for silent toggling.
  if (event.prompt)
    event.prompt.text = `${applied.notice} (Plugin-handled; acknowledge briefly, take no other action, call no tools.)`;
}

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

/** Arm the gate from a launcher bootstrap exactly once, on the first session. */
async function armBootstrapIfPending(ctx: GateContext, state: GateSessionState): Promise<void> {
  const rt = runtime();
  // Fall back to a fresh env read for launchers that set the vars slightly
  // after plugin start.
  const bootstrap = rt.bootstrapPending ?? readBootstrapGateCommand();
  rt.bootstrapPending = null;
  if (!bootstrap) return;
  consumeBootstrapGateCommand();
  state.extraCommand = bootstrap.command;
  state.gateMode = bootstrap.mode;
  state.sessionMaxRetries =
    bootstrap.mode === 'command-only' && bootstrap.maxRetries !== undefined
      ? bootstrap.maxRetries
      : null;
  state.gateEnabled = true;
  state.retries = 0;
  state.escalated = false;
  state.lastOutcome = null;
  logDiag(
    `gate bootstrap ${bootstrap.mode} custom command registered on ${state.sessionID}` +
      (state.sessionMaxRetries !== null ? ` (session maxRetries=${state.sessionMaxRetries})` : '')
  );
  await notify(
    ctx,
    state,
    state.sessionMaxRetries !== null
      ? `Completion gate armed (${bootstrap.mode}): ${bootstrap.command} · maxRetries=${state.sessionMaxRetries}`
      : `Completion gate armed (${bootstrap.mode}): ${bootstrap.command}`
  );
}

async function handleEvent(ctx: GateContext, event: GateEvent): Promise<void> {
  const type = typeof event.type === 'string' ? event.type : '';
  const rt = runtime();

  if (type === 'session.deleted') {
    const sessionID = asString(event.data?.sessionID);
    if (!sessionID) return;
    rt.deleted.add(sessionID);
    advanceSessionGeneration(sessionID);
    const state = rt.sessions.get(sessionID);
    if (state) {
      state.deleted = true;
      state.gateEnabled = false;
    }
    rt.sessions.delete(sessionID);
    return;
  }

  if (type === 'session.created') {
    const validated = validateTopLevelSessionMetadata({
      id: event.data?.sessionID,
      directory: event.data?.location?.directory,
      parentID: event.data?.parentID,
    });
    if (!validated) {
      logDiag('session.created ignored: invalid top-level session metadata');
      return;
    }
    // The event reaches every plugin instance; register once, idempotently.
    const existing = rt.sessions.get(validated.sessionID);
    if (existing && !existing.deleted) return;
    rt.deleted.delete(validated.sessionID);
    advanceSessionGeneration(validated.sessionID);
    const created = createGateSessionState(validated.sessionID, validated.directory);
    rt.sessions.set(created.sessionID, created);
    logDiag(`registered session ${created.sessionID} (${created.directory})`);

    // Out-of-band arming (message-only, no chat): consume a launcher-provided
    // bootstrap command exactly once so only the startup session arms.
    await armBootstrapIfPending(ctx, created);
    return;
  }

  // A turn ends when its execution finishes. This core does not emit
  // session.idle; `session.execution.succeeded` is the observed turn-end signal
  // (keep session.idle too for forward-compatibility).
  if (type === 'session.idle' || type === 'session.execution.succeeded') {
    const sessionID = asString(event.data?.sessionID);
    if (!sessionID) return;
    let state = rt.sessions.get(sessionID);
    if (!state || state.deleted) {
      // The subscription can miss the initial session.created (e.g. a private
      // server that creates its first session before plugins finish loading),
      // so register lazily on first turn end too.
      state = (await getOrRegisterSession(ctx, sessionID)) ?? undefined;
      if (!state) return;
      await armBootstrapIfPending(ctx, state);
    }
    if (!state.gateEnabled || state.busy) return;
    if (process.env.OPENCODE_GATE_DISABLED === '1') return;
    logDiag(`session ${sessionID} went idle — gate turn-end starting`);
    kickGateTurnEnd(ctx, state, 'idle');
    return;
  }
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = Plugin.define({
  id: 'opencode.completion-gate',
  async setup(ctx) {
    // Capture launcher settings before the first session event. Launchers can
    // clean up their environment after starting OpenCode but before the host
    // emits session.created. Captured once per process, shared across the
    // plugin instances OpenCode loads per location.
    const rt = runtime();
    if (!rt.bootstrapCaptured) {
      rt.bootstrapPending = readBootstrapGateCommand();
      rt.bootstrapCaptured = true;
      if (rt.bootstrapPending) consumeBootstrapGateCommand();
      logDiag(
        `completion-gate: first setup (bootstrap=${rt.bootstrapPending ? rt.bootstrapPending.mode : 'none'})`
      );
    }

    // Own the `/gate` command outright (V2 has no global command.execute.before).
    await ctx.command.transform((editor) => {
      editor.add({
        name: 'gate',
        description:
          'Control the completion gate for this session (/gate [on|off|status|command] or /gate --only command)',
        execute: async ({ sessionID, prompt }) => {
          try {
            const state = await getOrRegisterSession(ctx, sessionID);
            if (!state || state.deleted) return;
            const argument = (prompt?.text ?? '').trim();
            const applied = await applyToggle(ctx, state, argument);
            if (applied.kind === 'enabled') {
              await warnIfNothingToRun(ctx, state);
              kickGateTurnEnd(ctx, state, 'enabled via /gate');
            }
          } catch (err) {
            logDiag(`gate command error: ${describeSdkError(err)}`);
          }
        },
      });
    });

    // Prompt hook: reset the fix-cycle budget on genuine user messages and keep
    // honoring the legacy [completion-gate-internal] --only directive.
    await ctx.session.hook('prompt', async (event) => {
      try {
        await handlePrompt(ctx, event as unknown as PromptHookEvent);
      } catch (err) {
        logDiag(`prompt hook error: ${describeSdkError(err)}`);
      }
    });

    // OpenCode loads one plugin instance per location, and every instance's
    // subscription sees the whole server stream. Subscribe on every instance
    // (robust against instance lifecycle), but dedupe by event id so a single
    // event is handled once regardless of how many subscriptions receive it.
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            const evt = raw as unknown as GateEvent & { id?: unknown };
            const type = typeof evt.type === 'string' ? evt.type : '';
            if (
              type !== 'session.created' &&
              type !== 'session.deleted' &&
              type !== 'session.idle' &&
              type !== 'session.execution.succeeded'
            )
              continue;
            const id = asString(evt.id);
            if (id) {
              if (rt.seen.has(id)) continue;
              rt.seen.add(id);
              if (rt.seen.size > 5000) rt.seen.clear();
            }
            await handleEvent(ctx, evt);
          } catch (err) {
            logDiag(`event error: ${describeSdkError(err)}`);
          }
        }
      } catch (err) {
        if (!controller.signal.aborted)
          logDiag(`event subscription error: ${describeSdkError(err)}`);
      }
    })();

    return () => {
      controller.abort();
    };
  },
});

export default plugin;
