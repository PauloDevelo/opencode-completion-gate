import type { Hooks, Plugin, PluginInput } from '@opencode-ai/plugin';
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

// ---------------------------------------------------------------------------
// Plugin state + hooks
// ---------------------------------------------------------------------------

// NOTE: deliberately NOT exported — opencode's legacy plugin loader requires
// every runtime export of a plugin module to be a function (or {server});
// a string export makes the whole plugin fail to load ("Plugin export is not
// a function").
const MARKER = '[completion-gate]';
const INTERNAL_MARKER = '[completion-gate-internal]';
// Out-of-band gate arming for orchestration launchers (e.g. Invoke-HerdrOpenCode.ps1):
// the launcher sets these process-scoped env vars before spawning opencode, and
// the session.created handler below consumes them (one-shot). Nothing enters the
// --prompt chat transcript; confirmation is toast-only. _B64 takes precedence
// when both are set (it avoids shell-quoting pitfalls in the launcher).
const TOGGLE_RE = /^\[completion-gate\](?:\s+(.*?))?\s*$/i;
const INJECTED_FAILURE_RE =
  /^✖ Completion gate failed — "[^"]+"\. Fix these issues, then finish again\.\n\n```[\s\S]*\n```\n\n\(RETRY \d+\/\d+\)$/;
const INJECTED_SUCCESS_RE = /^✅ Completion gate passed \([^\n]*\)\. You may report done\.$/;

type PluginClient = PluginInput['client'];
type HookOutput = Parameters<NonNullable<Hooks['command.execute.before']>>[1] & {
  noReply?: boolean;
};

interface GateSessionState {
  sessionID: string;
  directory: string;
  currentAgent?: string;
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

const sessions = new Map<string, GateSessionState>();
const deletedSessionIDs = new Set<string>();
const sessionGenerations = new Map<string, number>();

function getSessionGeneration(sessionID: string): number {
  return sessionGenerations.get(sessionID) ?? 0;
}

function advanceSessionGeneration(sessionID: string): void {
  sessionGenerations.set(sessionID, getSessionGeneration(sessionID) + 1);
}

type SessionMetadata = { id?: unknown; directory?: unknown; parentID?: unknown };

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

async function getOrRegisterSession(
  client: PluginClient,
  sessionID: string
): Promise<GateSessionState | null> {
  const existing = sessions.get(sessionID);
  if (existing) return existing.deleted ? null : existing;

  const lookupSessionID = sessionID;
  const lookupGeneration = getSessionGeneration(lookupSessionID);

  try {
    const info = unwrapSdk<SessionMetadata>(
      await client.session.get({ path: { id: lookupSessionID } })
    );
    const validated = validateTopLevelSessionMetadata(info, lookupSessionID);
    if (!validated) {
      logDiag(
        `lazy registration rejected session ${lookupSessionID}: invalid top-level session metadata`
      );
      return null;
    }
    if (
      deletedSessionIDs.has(lookupSessionID) ||
      getSessionGeneration(lookupSessionID) !== lookupGeneration
    ) {
      logDiag(
        `lazy registration ignored session ${lookupSessionID}: session was deleted or superseded while lookup was pending`
      );
      return null;
    }

    const state = createGateSessionState(validated.sessionID, validated.directory);
    sessions.set(state.sessionID, state);
    logDiag(`lazily registered session ${state.sessionID} (${state.directory})`);
    return state;
  } catch (err) {
    logDiag(`lazy registration lookup failed for ${sessionID}: ${describeSdkError(err)}`);
    return null;
  }
}

async function safeToast(
  client: PluginClient,
  message: string,
  variant: 'info' | 'error' = 'info'
): Promise<void> {
  try {
    await client.tui.showToast({ body: { variant, message } });
  } catch {
    // Ignore — TUI may not be available (e.g. headless mode). State is
    // already mutated and diag logging covers observability.
  }
}

function clearParts(output: HookOutput): void {
  // Toast-only /gate: leave nothing in the chat transcript or model payload.
  // Mutating in place preserves the hook's output object identity.
  if (Array.isArray(output?.parts)) output.parts.length = 0;
}

// Suppress the agent turn after a slash command. OpenCode unconditionally
// dispatches an LLM turn after every slash command — empty parts do NOT
// prevent it, and an empty turn right after real work can make the model
// re-emit the previous turn's tool calls. There is no supported skip flag
// (anomalyco/opencode#28292; fix PR anomalyco/opencode#46579 is open), so the
// only working mechanism today is throwing out of `command.execute.before`,
// which aborts the command flow and keeps the model idle. The toast carries
// the confirmation. Set to false to fall back to parts-clearing only (the
// turn still fires — not recommended).
const ABORT_COMMAND_TURN = true;

type ToggleKind = 'enabled' | 'disabled' | 'status' | 'usage';

async function applyToggle(
  client: PluginClient,
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
    await safeToast(client, notice);
    return { notice, kind: 'status' };
  }

  if (/^--only/i.test(rawArgument.trim())) {
    const onlyMatch = /^--only(.*)$/i.exec(rawArgument.trim());
    const remainder = onlyMatch?.[1] ?? '';
    const parsed = parseOnlyCommand(remainder);
    if (!parsed.command || parsed.invalidRetry) {
      const notice = 'Usage: /gate --only "command" [--retries N]';
      await safeToast(client, notice, 'error');
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
    await safeToast(client, notice);
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
    await safeToast(client, notice);
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
  await safeToast(client, notice);
  logDiag(`gate ${arg} on ${state.sessionID}`);
  return { notice, kind: state.gateEnabled ? 'enabled' : 'disabled' };
}

// Warn at enable time when there is nothing to run: without this, an enabled
// gate on a session whose directory resolves to no config looks dead.
async function warnIfNothingToRun(client: PluginClient, state: GateSessionState): Promise<void> {
  if (state.extraCommand) return;
  if (loadGateConfig(state.directory)) return;
  const msg = `Completion gate enabled but nothing to run: no .opencode/completion-gate.json found from ${state.directory}.`;
  logDiag(`gate on ${state.sessionID}: ${msg}`);
  await safeToast(client, msg, 'error');
}

// Start an evaluation right away (fire-and-forget). Needed because enabling
// via slash aborts the command turn, so no fresh idle event follows to kick
// the gate — without this the gate would stay dormant until the next real
// turn. Shared with the idle handler; the busy flag serializes overlaps.
function kickGateTurnEnd(client: PluginClient, state: GateSessionState, reason: string): void {
  if (state.deleted || !state.gateEnabled || state.busy) return;
  if (process.env.OPENCODE_GATE_DISABLED === '1') return;
  state.busy = true;
  logDiag(`gate kick on ${state.sessionID} (${reason}) — evaluation starting`);
  runGateTurnEnd(client, state)
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

function unwrapSdk<T>(res: unknown): T {
  if (res && typeof res === 'object' && ('data' in res || 'error' in res)) {
    const r = res as { data?: T; error?: unknown };
    if (r.error != null) {
      const e = r.error;
      throw new Error(
        typeof e === 'string'
          ? e
          : e && typeof e === 'object' && 'message' in e
            ? String(e.message)
            : JSON.stringify(e)
      );
    }
    return r.data as T;
  }
  return res as T;
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

async function runGateTurnEnd(client: PluginClient, state: GateSessionState): Promise<void> {
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

  const results = await evaluateAssertions(assertions, projectRoot, client, isAborted);
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
    await client.session
      .promptAsync({
        path: { id: state.sessionID },
        body: {
          ...(state.currentAgent ? { agent: state.currentAgent } : {}),
          parts: [
            {
              type: 'text',
              text: `${MARKER} ✅ Completion gate passed (${results.map((r) => r.name).join(', ')}). You may report done.`,
            },
          ],
        },
      })
      .catch((err: unknown) => logDiag(`success prompt error: ${describeSdkError(err)}`));
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
      await client.tui
        .showToast({
          body: {
            variant: 'error',
            message: `→ Completion gate "${last.name}" still failing after ${cap.value} retries — manual attention needed`,
            duration: 15000,
          },
        })
        .catch(() => {});
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
  await client.session
    .promptAsync({
      path: { id: state.sessionID },
      body: {
        ...(state.currentAgent ? { agent: state.currentAgent } : {}),
        parts: [{ type: 'text', text: injectFailureText(state, last, cap.value) }],
      },
    })
    .catch((err: unknown) => logDiag(`retry prompt error: ${describeSdkError(err)}`));
}

const plugin: Plugin = async ({ client }) => {
  return {
    event: async ({ event }) => {
      try {
        if (event.type === 'session.deleted') {
          const info = (event.properties as { info?: unknown } | undefined)?.info;
          const deletedInfo =
            info && typeof info === 'object' ? (info as { id?: unknown }) : undefined;
          if (typeof deletedInfo?.id === 'string' && deletedInfo.id.trim() !== '') {
            const sessionID = deletedInfo.id;
            deletedSessionIDs.add(sessionID);
            advanceSessionGeneration(sessionID);
            const state = sessions.get(sessionID);
            if (state) {
              state.deleted = true;
              state.gateEnabled = false;
            }
            sessions.delete(sessionID);
          }
          return;
        }
        if (event.type === 'session.created') {
          const info = (event.properties as { info?: unknown }).info;
          const validated = validateTopLevelSessionMetadata(info);
          if (!validated) {
            logDiag('session.created ignored: invalid top-level session metadata');
            return;
          }
          deletedSessionIDs.delete(validated.sessionID);
          advanceSessionGeneration(validated.sessionID);
          const created = createGateSessionState(validated.sessionID, validated.directory);
          sessions.set(created.sessionID, created);
          logDiag(`registered session ${created.sessionID} (${created.directory})`);
          // Out-of-band arming (toast-only, no chat): consume a launcher-provided
          // bootstrap command exactly once so only the startup session arms.
          const bootstrap = readBootstrapGateCommand();
          if (bootstrap) {
            consumeBootstrapGateCommand();
            created.extraCommand = bootstrap.command;
            created.gateMode = bootstrap.mode;
            created.sessionMaxRetries =
              bootstrap.mode === 'command-only' && bootstrap.maxRetries !== undefined
                ? bootstrap.maxRetries
                : null;
            created.gateEnabled = true;
            created.retries = 0;
            created.escalated = false;
            created.lastOutcome = null;
            logDiag(
              `gate bootstrap ${bootstrap.mode} custom command registered on ${created.sessionID}` +
                (created.sessionMaxRetries !== null
                  ? ` (session maxRetries=${created.sessionMaxRetries})`
                  : '')
            );
            await client.tui
              .showToast({
                body: {
                  variant: 'info',
                  message:
                    created.sessionMaxRetries !== null
                      ? `Completion gate armed (${bootstrap.mode}): ${bootstrap.command} · maxRetries=${created.sessionMaxRetries}`
                      : `Completion gate armed (${bootstrap.mode}): ${bootstrap.command}`,
                },
              })
              .catch(() => {});
          }
        }
        if (event.type === 'session.status') {
          const props = event.properties as {
            sessionID?: unknown;
            status?: { type?: unknown };
          };
          if (typeof props.sessionID !== 'string') return;
          const state = sessions.get(props.sessionID);
          if (!state || !state.gateEnabled || state.busy) return;
          if (props.status?.type !== 'idle') return;
          if (process.env.OPENCODE_GATE_DISABLED === '1') return;
          logDiag(`session ${props.sessionID} went idle — gate turn-end starting`);
          kickGateTurnEnd(client, state, 'idle');
          return;
        }
      } catch (err) {
        logDiag(`event error: ${err}`);
      }
    },

    'command.execute.before': async (
      { command, sessionID, arguments: commandArguments },
      output
    ) => {
      let applied: { notice: string; kind: ToggleKind } | null = null;
      try {
        if (command !== 'gate') return;
        const state = await getOrRegisterSession(client, sessionID);
        if (!state || state.deleted) return;
        applied = await applyToggle(client, state, commandArguments);
        // Forward-compatible: anomalyco/opencode#46579 adds output.noReply to
        // skip the agent turn. Unreleased in 1.18.x — ignored until then.
        (output as HookOutput).noReply = true;
        clearParts(output as HookOutput);
        if (applied.kind === 'enabled') {
          await warnIfNothingToRun(client, state);
          kickGateTurnEnd(client, state, 'enabled via /gate');
        }
      } catch (err) {
        logDiag(`command.execute.before error: ${err}`);
      }
      // Throw OUTSIDE the try/catch so our own handler cannot swallow it:
      // aborting the command flow is what keeps the model idle (no LLM turn).
      if (applied !== null && ABORT_COMMAND_TURN) {
        logDiag(`gate command handled on ${sessionID} — aborting turn (sentinel)`);
        throw new Error(applied.notice);
      }
    },

    'chat.message': async ({ sessionID, agent }, output) => {
      try {
        const state = sessions.get(sessionID);
        if (!state || state.deleted) return;
        if (typeof agent === 'string' && agent.trim() !== '') state.currentAgent = agent;
        if (!Array.isArray(output?.parts) || output.parts.length === 0) return; // already cleared (toast-only) — nothing to do
        const textPart = output.parts.find((p) => p?.type === 'text');
        if (!textPart) return;
        const text: string = textPart?.text ?? '';

        if (text.trimStart().startsWith(INTERNAL_MARKER)) {
          const lines = text.split(/\r?\n/);
          const directive = lines.shift()?.trim() ?? '';
          const argument = directive.slice(INTERNAL_MARKER.length).trim();
          if (/^--only\s+/i.test(argument)) {
            await applyToggle(client, state, argument);
            const remainder = lines.join('\n').replace(/^\n+/, '');
            if (!remainder) clearParts(output);
            else textPart.text = remainder;
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
        const applied = await applyToggle(client, state, argument);
        if (applied.kind === 'enabled') await warnIfNothingToRun(client, state);
        // Throwing here does NOT abort the turn (the host silently catches
        // chat.message errors), so constrain the inevitable turn instead: an
        // anchor stops the model from re-emitting previous tool calls on what
        // would otherwise be a near-empty message. Prefer the /gate slash
        // command (turn fully suppressed) for silent toggling.
        textPart.text = `${applied.notice} (Plugin-handled; acknowledge briefly, take no other action, call no tools.)`;
      } catch (err) {
        logDiag(`chat.message error: ${err}`);
      }
    },
  };
};

export default plugin;
