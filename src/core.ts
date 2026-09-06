import type { Hooks, Plugin, PluginInput } from '@opencode-ai/plugin';
import { readFileSync, appendFileSync, existsSync, mkdirSync, mkdtempSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, tmpdir } from 'os';
import { exec, execFile } from 'child_process';
import type { SpawnOptions } from 'child_process';

const BASE_DIR = join(homedir(), '.config', 'opencode');

function logDiag(msg: string): void {
  try {
    appendFileSync(join(BASE_DIR, 'gate-diag.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // best-effort diagnostics — ignore write failures
  }
}

/** First non-empty line of a multi-line text, capped — for compact log lines. */
function brief(s: string): string {
  const line =
    s
      .replace(/\r\n/g, '\n')
      .split('\n')
      .find((l) => l.trim() !== '') ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandAssertion {
  type: 'command';
  name: string;
  run: string;
  timeoutSeconds: number;
}

export interface AdoPrAssertion {
  type: 'ado-pr';
  name: string;
  pollTimeoutMinutes: number;
  pollIntervalSeconds: number;
  skipIfNoPr: boolean;
  /** When true, blocking human-review policies (reviewer approvals, comment
   *  requirements) no longer hold the gate — only automated policies do. */
  ignoreHumanPolicies?: boolean;
}

export interface ReviewAssertion {
  type: 'opencode-review';
  name: string;
  agent: string;
  prompt?: string;
  timeoutSeconds: number;
}

export type GateAssertion = CommandAssertion | AdoPrAssertion | ReviewAssertion;

export interface GateConfig {
  enabled: boolean;
  maxRetries: number;
  assertions: GateAssertion[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function truncateTail(text: string, maxLines = 50): string {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '');
  if (lines.length <= maxLines) return lines.join('\n');
  return `[... ${lines.length - maxLines} earlier lines omitted]\n${lines.slice(-maxLines).join('\n')}`;
}

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function validateGateConfig(raw: unknown): GateConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.enabled === false) return null;
  if (!Array.isArray(obj.assertions)) return null;
  const assertions: GateAssertion[] = [];
  for (const a of obj.assertions) {
    if (!a || typeof a !== 'object') return null;
    const nameOf = (fb: string) => (typeof a.name === 'string' && a.name.trim() ? a.name : fb);
    switch (a.type) {
      case 'command':
        if (typeof a.run !== 'string' || !a.run.trim()) return null;
        assertions.push({
          type: 'command',
          name: nameOf(a.run.split(/\s+/)[0]),
          run: a.run,
          timeoutSeconds: positiveInt(a.timeoutSeconds, 300),
        });
        break;
      case 'ado-pr':
        assertions.push({
          type: 'ado-pr',
          name: nameOf('ado-pr'),
          pollTimeoutMinutes: positiveInt(a.pollTimeoutMinutes, 15),
          pollIntervalSeconds: positiveInt(a.pollIntervalSeconds, 30),
          skipIfNoPr: a.skipIfNoPr === true,
          ignoreHumanPolicies: a.ignoreHumanPolicies === true,
        });
        break;
      case 'opencode-review':
        assertions.push({
          type: 'opencode-review',
          name: nameOf('self-review'),
          agent: typeof a.agent === 'string' && a.agent.trim() ? a.agent : 'reviewer',
          prompt: typeof a.prompt === 'string' && a.prompt.trim() ? a.prompt : undefined,
          timeoutSeconds: positiveInt(a.timeoutSeconds, 900),
        });
        break;
      default:
        return null;
    }
  }
  if (assertions.length === 0) return null;
  return { enabled: true, maxRetries: positiveInt(obj.maxRetries, 3), assertions };
}

export function findGateConfigPath(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    try {
      const candidate = join(dir, '.opencode', 'completion-gate.json');
      if (existsSync(candidate)) return candidate;
      // stop at git root (.git is a DIR in normal repos, a FILE in worktrees) or at the drive root
      if (existsSync(join(dir, '.git'))) return null;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    } catch {
      return null;
    }
  }
}

export function loadGateConfig(
  startDir: string
): { path: string; projectRoot: string; config: GateConfig } | null {
  const path = findGateConfigPath(startDir);
  if (!path) return null;
  let config: GateConfig | null = null;
  try {
    config = validateGateConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    config = null;
  }
  if (!config) return null;
  return { path, projectRoot: dirname(dirname(path)), config }; // strip ".opencode/<file>"
}

// ---------------------------------------------------------------------------
// Process runners
// ---------------------------------------------------------------------------

export interface ProcessOutcome {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function outcomeFromErr(err: (Error & { code?: unknown; killed?: boolean }) | null): number | null {
  if (!err) return 0;
  return typeof err.code === 'number' ? err.code : null;
}

export function runCommand(cmd: string, cwd: string, timeoutMs: number): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let childTimedOut = false; // declared BEFORE exec so the callback closure sees it initialized
    const child = exec(
      cmd,
      { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        resolve({
          code: outcomeFromErr(err),
          timedOut: Boolean(err && err.killed) || childTimedOut,
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
        });
      }
    );
    const timer = setTimeout(() => {
      childTimedOut = true;
      try {
        child.kill();
      } catch {
        // child already exited — nothing to kill
      }
      if (process.platform === 'win32' && child.pid) {
        exec(`taskkill /PID ${child.pid} /T /F`, { windowsHide: true }, () => {});
      }
    }, timeoutMs);
  });
}

export function execFileOut(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  spawnOpts?: SpawnOptions
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, ...spawnOpts },
      (err, stdout, stderr) => {
        resolve({
          code: outcomeFromErr(err),
          timedOut: Boolean(err && err.killed),
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
        });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Assertion outcomes
// ---------------------------------------------------------------------------

export interface AssertionOutcome {
  name: string;
  passed: boolean;
  evidence: string;
}

function pass(name: string): AssertionOutcome {
  return { name, passed: true, evidence: '' };
}

function fail(name: string, evidence: string): AssertionOutcome {
  return { name, passed: false, evidence: evidence.trim() };
}

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
  if (!r.timedOut && r.code === 0) return pass(a.name);
  const why = r.timedOut ? `command timed out after ${a.timeoutSeconds}s` : `exit code ${r.code}`;
  return fail(
    a.name,
    `${why}\n${truncateTail([r.stderr, r.stdout].filter((s) => s.trim()).join('\n---\n'))}`
  );
}

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
const BOOTSTRAP_COMMAND_ENV = 'OPENCODE_GATE_BOOTSTRAP_COMMAND';
const BOOTSTRAP_COMMAND_B64_ENV = 'OPENCODE_GATE_BOOTSTRAP_COMMAND_B64';
const BOOTSTRAP_MODE_ENV = 'OPENCODE_GATE_BOOTSTRAP_MODE';
const BOOTSTRAP_MAX_RETRIES_ENV = 'OPENCODE_GATE_BOOTSTRAP_MAX_RETRIES';

/** Parses a positive-integer token with config-file semantics (floor, > 0). */
function parsePositiveIntToken(tok: string): number | null {
  const n = Number(tok);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Reads a pending out-of-band gate bootstrap command, if the launcher set one. */
function readBootstrapGateCommand(): {
  command: string;
  mode: GateMode;
  maxRetries?: number;
} | null {
  const b64 = process.env[BOOTSTRAP_COMMAND_B64_ENV];
  const plain = process.env[BOOTSTRAP_COMMAND_ENV];
  let command = '';
  if (typeof b64 === 'string' && b64.trim() !== '') {
    // Node's base64 decoder is lenient (skips invalid chars), so reject
    // non-canonical input explicitly instead of arming on mojibake.
    const compact = b64.trim().replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/]*={0,2}$/.test(compact) && compact.length % 4 === 0) {
      try {
        command = Buffer.from(compact, 'base64').toString('utf8');
      } catch {
        command = '';
      }
    }
  } else if (typeof plain === 'string') {
    command = plain;
  }
  command = command.trim();
  if (!command) return null;
  const mode: GateMode =
    process.env[BOOTSTRAP_MODE_ENV]?.trim().toLowerCase() === 'combined'
      ? 'combined'
      : 'command-only';
  // Session retry override — command-only only; invalid/missing falls back.
  let maxRetries: number | undefined;
  if (mode === 'command-only') {
    const raw = process.env[BOOTSTRAP_MAX_RETRIES_ENV];
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = parsePositiveIntToken(raw.trim());
      if (parsed !== null) maxRetries = parsed;
    }
  }
  return maxRetries !== undefined ? { command, mode, maxRetries } : { command, mode };
}

/** One-shot consumption: later sessions in the same process must not re-arm. */
function consumeBootstrapGateCommand(): void {
  delete process.env[BOOTSTRAP_COMMAND_B64_ENV];
  delete process.env[BOOTSTRAP_COMMAND_ENV];
  delete process.env[BOOTSTRAP_MODE_ENV];
  delete process.env[BOOTSTRAP_MAX_RETRIES_ENV];
}
const TOGGLE_RE = /^\[completion-gate\](?:\s+(.*?))?\s*$/i;
const INJECTED_FAILURE_RE =
  /^✖ Completion gate failed — "[^"]+"\. Fix these issues, then finish again\.\n\n```[\s\S]*\n```\n\n\(RETRY \d+\/\d+\)$/;
const INJECTED_SUCCESS_RE = /^✅ Completion gate passed \([^\n]*\)\. You may report done\.$/;

type GateMode = 'combined' | 'command-only';

type PluginClient = PluginInput['client'];
type HookOutput = Parameters<NonNullable<Hooks['command.execute.before']>>[1] & {
  noReply?: boolean;
};

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

/**
 * Splits a `--only` remainder into the session command plus an optional
 * `--retries N` (alias `--max-retries N`) override. The flag is recognized
 * only as a leading or trailing token sequence so a command that merely
 * mentions `--retries` mid-line stays untouched; when both ends carry the
 * flag the leading value wins.
 */
export function parseOnlyCommand(remainder: string): {
  command: string;
  maxRetries?: number;
  invalidRetry: boolean;
} {
  if (!/^\s/.test(remainder)) return { command: '', invalidRetry: false };
  let body = remainder.trim();
  let leading: number | null = null;
  let trailing: number | null = null;
  let invalid = false;

  const leadingMatch = /^--(?:retries|max-retries)(?:\s+|=)(\S+)\s*/i.exec(body);
  if (leadingMatch) {
    const parsed = parsePositiveIntToken(leadingMatch[1]);
    if (parsed === null) invalid = true;
    else leading = parsed;
    body = body.slice(leadingMatch[0].length).trim();
  } else if (/^--(?:retries|max-retries)(?:\s*=\s*)?$/i.test(body)) {
    invalid = true;
  }

  const trailingMatch = /\s+--(?:retries|max-retries)(?:\s+|=)(\S+)\s*$/i.exec(body);
  if (trailingMatch) {
    const parsed = parsePositiveIntToken(trailingMatch[1]);
    if (parsed === null) invalid = true;
    else trailing = parsed;
    body = body.slice(0, trailingMatch.index).trim();
  } else if (/\s+--(?:retries|max-retries)(?:\s*=\s*)?$/i.test(body)) {
    invalid = true;
  }

  const maxRetries = leading ?? trailing ?? undefined;
  return {
    command: body,
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    invalidRetry: invalid,
  };
}

/** Effective retry cap for a session: session override wins in command-only
 *  mode, otherwise the project config (or the default 3). */
export function effectiveMaxRetries(
  state: Pick<GateSessionState, 'gateMode' | 'sessionMaxRetries'>,
  configMaxRetries: number
): { value: number; source: 'session' | 'config' } {
  if (state.gateMode === 'command-only' && state.sessionMaxRetries !== null) {
    return { value: state.sessionMaxRetries, source: 'session' };
  }
  return { value: configMaxRetries, source: 'config' };
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

interface SessionMetadata {
  id?: unknown;
  directory?: unknown;
  parentID?: unknown;
}

interface ValidatedSessionMetadata {
  sessionID: string;
  directory: string;
}

function validateTopLevelSessionMetadata(
  info: unknown,
  expectedSessionID?: string
): ValidatedSessionMetadata | null {
  if (!info || typeof info !== 'object') return null;
  const metadata = info as SessionMetadata;
  if (
    typeof metadata.id !== 'string' ||
    metadata.id.trim() === '' ||
    (expectedSessionID !== undefined && metadata.id !== expectedSessionID) ||
    typeof metadata.directory !== 'string' ||
    metadata.directory.trim() === '' ||
    metadata.parentID !== undefined
  ) {
    return null;
  }
  return { sessionID: metadata.id, directory: metadata.directory };
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
// ado-pr assertion
// ---------------------------------------------------------------------------

export type PickPrResult =
  | { ok: true; prId: number }
  | { ok: false; reason: 'none' | 'multiple' | 'unparsable'; detail: string };

export type PickPrDetailsResult =
  | { ok: true; prId: number; projectName?: string }
  | { ok: false; reason: 'none' | 'multiple' | 'unparsable'; detail: string };

export function pickActivePrDetails(prListJson: string): PickPrDetailsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(prListJson);
  } catch {
    return { ok: false, reason: 'unparsable', detail: 'az repos pr list returned invalid JSON' };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'unparsable', detail: 'expected an array of PRs' };
  }
  if (parsed.length === 0) {
    return { ok: false, reason: 'none', detail: 'no active PR found for this branch' };
  }
  // Real `az repos pr list --output json` payloads carry the numeric id in
  // `pullRequestId` (verified live); accept plain `id` as a fallback.
  const ids = parsed
    .map((p: unknown) => {
      if (!p || typeof p !== 'object') return undefined;
      const entry = p as { pullRequestId?: unknown; id?: unknown };
      return typeof entry.pullRequestId === 'number' ? entry.pullRequestId : entry.id;
    })
    .filter((n): n is number => typeof n === 'number');
  if (ids.length !== parsed.length) {
    return { ok: false, reason: 'unparsable', detail: 'PR entries missing numeric pullRequestId' };
  }
  if (ids.length > 1) {
    return {
      ok: false,
      reason: 'multiple',
      detail: `multiple active PRs for this branch: ${ids.join(', ')}`,
    };
  }
  const projectName =
    typeof (parsed[0] as { repository?: { project?: { name?: unknown } } }).repository?.project
      ?.name === 'string' &&
    (
      (parsed[0] as { repository?: { project?: { name?: unknown } } }).repository?.project
        ?.name as string
    ).trim()
      ? ((parsed[0] as { repository?: { project?: { name?: unknown } } }).repository?.project
          ?.name as string)
      : undefined;
  return projectName ? { ok: true, prId: ids[0], projectName } : { ok: true, prId: ids[0] };
}

export function pickActivePr(prListJson: string): PickPrResult {
  const result = pickActivePrDetails(prListJson);
  return result.ok ? { ok: true, prId: result.prId } : result;
}

const GREEN_POLICY_STATUSES = new Set(['approved', 'succeeded', 'notapplicable']);
const IN_PROGRESS_POLICY_STATUSES = new Set(['queued', 'running']);

export interface PolicyEvaluationMinimal {
  configuration?: { isBlocking?: boolean; isRequired?: boolean; type?: { displayName?: string } };
  status?: string;
  context?: {
    buildId?: number | string | null;
    buildDefinitionName?: string;
    buildOutputPreview?: {
      jobName?: string;
      taskName?: string;
      errors?: Array<{ message?: string | null }>;
    } | null;
  } | null;
}

/** Policy types that only a human can turn green (approvals, comment threads).
 *  Matched case-insensitively against configuration.type.displayName. */
const HUMAN_POLICY_RE = /minimum number of reviewers|required reviewers|comment requirements/i;

export function isHumanReviewPolicy(e: PolicyEvaluationMinimal): boolean {
  return HUMAN_POLICY_RE.test(String(e?.configuration?.type?.displayName ?? ''));
}

export interface TerminalBuildFailure {
  buildId: number | null;
  status: string;
  definitionName?: string;
  jobName?: string;
  taskName?: string;
  previewErrors: string[];
}

function parseBuildId(value: unknown): number | null {
  const id =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function extractTerminalBuildFailures(
  policyListJson: string,
  opts: { ignoreHumanPolicies?: boolean } = {}
): TerminalBuildFailure[] {
  let evals: PolicyEvaluationMinimal[];
  try {
    evals = JSON.parse(policyListJson);
  } catch {
    return [];
  }
  if (!Array.isArray(evals)) return [];

  return evals
    .filter((e) => e?.configuration?.isBlocking === true || e?.configuration?.isRequired === true)
    .filter((e) => String(e?.configuration?.type?.displayName ?? '').toLowerCase() === 'build')
    .filter((e) => !(opts.ignoreHumanPolicies && isHumanReviewPolicy(e)))
    .filter((e) => {
      const status = String(e?.status ?? '').toLowerCase();
      return !GREEN_POLICY_STATUSES.has(status) && !IN_PROGRESS_POLICY_STATUSES.has(status);
    })
    .map((e) => {
      const context = e.context;
      const preview = context?.buildOutputPreview;
      const failure: TerminalBuildFailure = {
        buildId: parseBuildId(context?.buildId),
        status: String(e?.status ?? ''),
        previewErrors: Array.isArray(preview?.errors)
          ? preview.errors
              .map((error) => error?.message)
              .filter(
                (message): message is string => typeof message === 'string' && message.trim() !== ''
              )
          : [],
      };
      if (typeof context?.buildDefinitionName === 'string')
        failure.definitionName = context.buildDefinitionName;
      if (typeof preview?.jobName === 'string') failure.jobName = preview.jobName;
      if (typeof preview?.taskName === 'string') failure.taskName = preview.taskName;
      return failure;
    });
}

/** Compact per-build diagnostic block for retry evidence: definition, status,
 *  job, task, then the (tail-truncated) preview error lines. */
function formatBuildPreview(build: TerminalBuildFailure): string {
  const lines = [
    build.definitionName ? `Build definition: ${build.definitionName}` : '',
    `Build policy status: ${build.status}`,
    build.jobName ? `Job: ${build.jobName}` : '',
    build.taskName ? `Task: ${build.taskName}` : '',
  ];
  if (build.previewErrors.length > 0) {
    lines.push('Preview errors:');
    for (const line of truncateTail(build.previewErrors.join('\n'), 20).split('\n'))
      lines.push(line);
  }
  return lines.filter((l) => l.trim() !== '').join('\n');
}

export function requiredPoliciesGreen(
  policyListJson: string,
  opts: { ignoreHumanPolicies?: boolean } = {}
): { green: boolean; retryable: boolean; detail: string } {
  let evals: PolicyEvaluationMinimal[];
  try {
    evals = JSON.parse(policyListJson);
  } catch {
    return {
      green: false,
      retryable: false,
      detail: 'az repos pr policy list returned invalid JSON',
    };
  }
  if (!Array.isArray(evals))
    return { green: false, retryable: false, detail: 'expected an array of policy evaluations' };
  // Real `az repos pr policy list --output json` payloads mark blocking rules
  // with `configuration.isBlocking` (verified live: Build policy isBlocking=true
  // status=rejected); `isRequired` kept as a legacy fallback.
  const allRequired = evals.filter(
    (e) => e?.configuration?.isBlocking === true || e?.configuration?.isRequired === true
  );
  if (allRequired.length === 0)
    return { green: false, retryable: false, detail: 'no blocking policies found on this PR' };
  const ignored = opts.ignoreHumanPolicies ? allRequired.filter(isHumanReviewPolicy) : [];
  const required = opts.ignoreHumanPolicies
    ? allRequired.filter((e) => !isHumanReviewPolicy(e))
    : allRequired;
  if (required.length === 0) {
    const names = ignored.map((e) => e.configuration?.type?.displayName ?? 'policy').join(', ');
    return {
      green: true,
      retryable: false,
      detail: `only human-review policies on this PR (${names}) — ignored via ignoreHumanPolicies`,
    };
  }
  const bad = required.filter(
    (e) => !GREEN_POLICY_STATUSES.has(String(e.status ?? '').toLowerCase())
  );
  if (bad.length > 0) {
    const names = bad
      .map((e) => `${e.configuration?.type?.displayName ?? 'policy'}: ${String(e.status ?? '?')}`)
      .join('; ');
    const skipped = ignored.length > 0 ? ` (${ignored.length} human policy(ies) ignored)` : '';
    // Human-review policies can change only after a person acts, so keep
    // polling them. For automated policies, only queued/running are pending;
    // rejected, broken, and unknown statuses are terminal failures.
    const hasTerminalAutomatedFailure = bad.some(
      (e) =>
        !isHumanReviewPolicy(e) &&
        !IN_PROGRESS_POLICY_STATUSES.has(String(e.status ?? '').toLowerCase())
    );
    return {
      green: false,
      retryable: !hasTerminalAutomatedFailure,
      detail: `PR policies not green — ${names}${skipped}`,
    };
  }
  const greenDetail = `${required.length} required policy(ies) green`;
  if (ignored.length > 0) {
    const names = ignored.map((e) => e.configuration?.type?.displayName ?? 'policy').join(', ');
    return {
      green: true,
      retryable: false,
      detail: `${greenDetail}, ${ignored.length} human policy(ies) ignored (${names})`,
    };
  }
  return { green: true, retryable: false, detail: greenDetail };
}

export type ShellFn = (args: string[], cwd: string, timeoutMs: number) => Promise<string>;

/**
 * Quote a single token for a cmd.exe command line (Windows only).
 * Tokens containing whitespace, double quotes or cmd metacharacters are wrapped
 * in double quotes with inner quotes doubled (cmd's "" convention).
 */
export function quoteWin(s: string): string {
  return /[\s"^&|<>]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface ShellInvocation {
  file: string;
  args: string[];
}

/**
 * Build the execFile invocation for a shell command.
 * - win32: route through cmd.exe (/d /s /c) because `az` is az.cmd and git/npm
 *   shims are batch files that Node refuses to spawn without a shell
 *   (CVE-2024-27980 hardening). The caller must pass the result to execFileOut
 *   with windowsVerbatimArguments so our quoting reaches cmd untouched; /s makes
 *   cmd strip exactly the outer quotes we add around the joined command line.
 * - other platforms: direct argv passthrough.
 */
export function buildShellInvocation(args: string[]): ShellInvocation {
  if (process.platform !== 'win32') return { file: args[0], args: args.slice(1) };
  const cmdline = [args[0], ...args.slice(1)].map(quoteWin).join(' ');
  return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${cmdline}"`] };
}

/**
 * Production ShellFn built on execFileOut; rejects with actionable stderr.
 *
 * CONSTRAINT: every element of `args` must be an operator-controlled token
 * (fixed CLI flags, branch names, numeric PR ids, repo paths) — never raw,
 * untrusted user input. On Windows the tokens are re-quoted onto a single
 * cmd.exe command line, which is safe ONLY under that constraint.
 *
 * Tree-kill semantics: execFileOut's timeout kills the DIRECT child. On win32
 * that child is cmd.exe — its /c grandchildren may linger past a timeout.
 */
export const execShell: ShellFn = async (args, cwd, timeoutMs) => {
  const inv = buildShellInvocation(args);
  const r = await execFileOut(inv.file, inv.args, cwd, timeoutMs, {
    windowsVerbatimArguments: true,
  });
  if (r.timedOut) throw new Error(`${args[0]} timed out`);
  if (r.code !== 0) {
    const detail = truncateTail([r.stderr, r.stdout].filter((s) => s.trim()).join('\n'), 20);
    throw new Error(`${args.join(' ')} failed (code ${r.code}):\n${detail}`);
  }
  return r.stdout;
};

// ---------------------------------------------------------------------------
// Failed Build log artifacts
// ---------------------------------------------------------------------------

export interface BuildLogArtifact {
  buildId: number;
  archivePath?: string;
  extractedPath?: string;
  error?: string;
}

export type BuildLogExtractor = (
  archivePath: string,
  destination: string,
  cwd: string,
  timeoutMs: number
) => Promise<void>;

export interface BuildLogDownloadOptions {
  /** Parent directory for the per-download work dir; defaults to <tmpdir>/opencode. */
  tempRoot?: string;
  /** Timeout for both the az download and the extraction; defaults to 120s. */
  timeoutMs?: number;
  shell?: ShellFn;
  extract?: BuildLogExtractor;
  isAborted?: () => boolean;
}

export type BuildLogArtifactRunner = (
  projectName: string,
  buildId: number,
  cwd: string,
  isAborted?: () => boolean
) => Promise<BuildLogArtifact>;

const BUILD_LOG_TIMEOUT_MS = 120_000;

const defaultBuildLogExtractor: BuildLogExtractor = async (
  archivePath,
  destination,
  cwd,
  timeoutMs
) => {
  const r = await execFileOut('tar', ['-xf', archivePath, '-C', destination], cwd, timeoutMs);
  if (r.timedOut) throw new Error(`tar timed out extracting ${archivePath}`);
  if (r.code !== 0) {
    const detail = truncateTail([r.stderr, r.stdout].filter((s) => s.trim()).join('\n'), 20);
    throw new Error(`tar failed (code ${r.code}): ${brief(detail)}`);
  }
};

/**
 * Download one build's complete log bundle via `az devops invoke` (Build Logs
 * REST endpoint, application/zip) and extract it beside the archive.
 *
 * CONSTRAINT: projectName/buildId come from parsed Azure DevOps payloads and
 * are passed as single operator-controlled tokens through the Windows shell
 * adapter — same safety model as the rest of the ado-pr assertion.
 *
 * Best-effort by design: download/extraction failures return `{ error }` and
 * never throw (except GateAborted), so the original CI failure evidence is
 * always preserved by the caller.
 */
export async function downloadBuildLogs(
  projectName: string,
  buildId: number,
  cwd: string,
  options: BuildLogDownloadOptions = {}
): Promise<BuildLogArtifact> {
  const timeoutMs = options.timeoutMs ?? BUILD_LOG_TIMEOUT_MS;
  const shell = options.shell ?? execShell;
  const extract = options.extract ?? defaultBuildLogExtractor;
  if (options.isAborted?.()) throw new GateAborted();

  const root = options.tempRoot ?? join(tmpdir(), 'opencode');
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    // temp root creation is best-effort; mkdtemp below reports failures
  }
  let workDir: string;
  try {
    workDir = mkdtempSync(join(root, `completion-gate-logs-${buildId}-`));
  } catch (err: unknown) {
    return {
      buildId,
      error: `could not create artifact directory under ${root}: ${describeSdkError(err)}`,
    };
  }

  const archivePath = join(workDir, `build-${buildId}-logs.zip`);
  const destination = join(workDir, 'extracted');

  logDiag(`build-logs "${projectName}" #${buildId}: downloading to ${archivePath}`);
  try {
    await shell(
      [
        'az',
        'devops',
        'invoke',
        '--detect',
        'true',
        '--area',
        'build',
        '--resource',
        'logs',
        '--route-parameters',
        `project=${projectName}`,
        `buildId=${buildId}`,
        '--api-version',
        '7.1',
        '--http-method',
        'GET',
        '--accept-media-type',
        'application/zip',
        '--out-file',
        archivePath,
      ],
      cwd,
      timeoutMs
    );
  } catch (err: unknown) {
    logDiag(
      `build-logs "${projectName}" #${buildId}: download failed — ${brief(describeSdkError(err))}`
    );
    return { buildId, error: `download failed: ${describeSdkError(err)}` };
  }
  if (!existsSync(archivePath)) {
    logDiag(`build-logs "${projectName}" #${buildId}: az exited zero but wrote no archive file`);
    return { buildId, error: 'az devops invoke succeeded but produced no archive file' };
  }

  const result: BuildLogArtifact = { buildId, archivePath };
  if (options.isAborted?.()) throw new GateAborted();

  try {
    mkdirSync(destination, { recursive: true });
    await extract(archivePath, destination, cwd, timeoutMs);
    result.extractedPath = destination;
    logDiag(`build-logs "${projectName}" #${buildId}: extracted to ${destination}`);
  } catch (err: unknown) {
    result.error = `extraction failed: ${describeSdkError(err)}`;
    logDiag(`build-logs "${projectName}" #${buildId}: extraction failed — ${brief(result.error)}`);
  }
  return result;
}

export const defaultBuildLogArtifact: BuildLogArtifactRunner = (
  projectName,
  buildId,
  cwd,
  isAborted
) => downloadBuildLogs(projectName, buildId, cwd, { isAborted });

export interface AdoPrPollOptions {
  /** Waits between poll rounds; defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock used for the polling deadline baseline and checks; defaults to Date.now. */
  now?: () => number;
  /** Checked at each poll-round boundary; when it fires the assertion aborts. */
  isAborted?: () => boolean;
  /**
   * Downloads + extracts failed Build logs on terminal Build-policy failures.
   * Defaults to {@link defaultBuildLogArtifact} (az devops invoke + tar);
   * tests inject fakes here.
   */
  buildLogArtifact?: BuildLogArtifactRunner;
}

export async function runAdoPrAssertion(
  a: AdoPrAssertion,
  cwd: string,
  shell: ShellFn,
  opts: AdoPrPollOptions = {}
): Promise<AssertionOutcome> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? (() => Date.now());
  const intervalMs = Math.max(5, a.pollIntervalSeconds) * 1000;
  const deadline = now() + Math.max(1, a.pollTimeoutMinutes) * 60_000;

  // Resolve the current branch first; a resolver error is a hard failure —
  // proceeding toward az with an empty --source-branch would mislead.
  let branch: string;
  logDiag(`ado-pr "${a.name}": resolving current branch`);
  try {
    branch = (await shell(['git', '-C', cwd, 'branch', '--show-current'], cwd, 10_000)).trim();
  } catch (err: unknown) {
    return fail(a.name, `could not resolve current branch: ${describeSdkError(err)}`);
  }
  if (!branch) return fail(a.name, 'not on a branch (detached HEAD?) — nothing to check a PR for');
  logDiag(
    `ado-pr "${a.name}": branch="${branch}", polling every ${intervalMs / 1000}s up to ${a.pollTimeoutMinutes} min`
  );

  let round = 0;
  try {
    for (;;) {
      if (opts.isAborted?.()) throw new GateAborted();
      round += 1;
      const listJson = await shell(
        [
          'az',
          'repos',
          'pr',
          'list',
          '--source-branch',
          branch,
          '--status',
          'active',
          '--output',
          'json',
        ],
        cwd,
        120_000
      );
      const pr = pickActivePrDetails(listJson);
      if (!pr.ok) {
        if (pr.reason === 'none' && a.skipIfNoPr) {
          logDiag(`ado-pr "${a.name}": no active PR — skipIfNoPr=true, passing`);
          return pass(a.name);
        }
        return fail(
          a.name,
          pr.reason === 'none'
            ? `no active PR for branch "${branch}" — open one before finishing`
            : pr.detail
        );
      }
      logDiag(`ado-pr "${a.name}": round ${round} — active PR !${pr.prId}, checking policies`);
      const policyJson = await shell(
        ['az', 'repos', 'pr', 'policy', 'list', '--id', String(pr.prId), '--output', 'json'],
        cwd,
        120_000
      );
      const g = requiredPoliciesGreen(policyJson, {
        ignoreHumanPolicies: a.ignoreHumanPolicies === true,
      });
      if (g.green) {
        logDiag(`ado-pr "${a.name}": PR !${pr.prId} green (${g.detail})`);
        return pass(a.name);
      }
      if (!g.retryable) {
        const baseEvidence = `PR !${pr.prId} has terminal policy failure — ${g.detail}`;
        const buildFailures = extractTerminalBuildFailures(policyJson, {
          ignoreHumanPolicies: a.ignoreHumanPolicies === true,
        });
        const artifactEvidence: string[] = [];
        const seenBuildIds = new Set<number>();

        for (const build of buildFailures) {
          // One artifact bundle per distinct failed build; duplicate policy
          // entries for the same build are collapsed entirely.
          if (build.buildId !== null) {
            if (seenBuildIds.has(build.buildId)) continue;
            seenBuildIds.add(build.buildId);
          }
          artifactEvidence.push(formatBuildPreview(build));
          if (build.buildId === null) {
            artifactEvidence.push(
              'Build logs unavailable: terminal Build policy has no valid buildId.'
            );
            continue;
          }
          if (!pr.projectName) {
            artifactEvidence.push(
              `Build logs unavailable for build ${build.buildId}: active PR payload has no repository project name.`
            );
            continue;
          }
          if (opts.isAborted?.()) throw new GateAborted();
          try {
            const artifact = await (opts.buildLogArtifact ?? defaultBuildLogArtifact)(
              pr.projectName,
              build.buildId,
              cwd,
              opts.isAborted
            );
            if (artifact.extractedPath)
              artifactEvidence.push(`Build logs extracted directory: ${artifact.extractedPath}`);
            if (artifact.archivePath)
              artifactEvidence.push(`Build logs ZIP: ${artifact.archivePath}`);
            if (artifact.error)
              artifactEvidence.push(`Build log artifact error: ${artifact.error}`);
          } catch (err: unknown) {
            if (err instanceof GateAborted) throw err;
            artifactEvidence.push(`Build log artifact error: ${describeSdkError(err)}`);
          }
        }

        logDiag(
          `ado-pr "${a.name}": PR !${pr.prId} has terminal policy failure — ${brief(g.detail)}; stopping polling`
        );
        return fail(a.name, [baseEvidence, ...artifactEvidence].filter(Boolean).join('\n'));
      }
      logDiag(`ado-pr "${a.name}": PR !${pr.prId} not green yet — ${brief(g.detail)}`);
      if (now() + intervalMs >= deadline) {
        return fail(
          a.name,
          `PR !${pr.prId} did not reach green within ${a.pollTimeoutMinutes} min — ${g.detail}`
        );
      }
      if (opts.isAborted?.()) throw new GateAborted();
      await sleep(intervalMs);
    }
  } catch (err: unknown) {
    if (err instanceof GateAborted) throw err;
    return fail(a.name, describeSdkError(err));
  }
}

// ---------------------------------------------------------------------------
// opencode-review assertion
// ---------------------------------------------------------------------------

export function parseVerdict(output: string): 'PASS' | 'FAIL' | null {
  const matches = [...output.matchAll(/VERDICT:\s*\b(PASS|FAIL)\b/gi)];
  const last = matches[matches.length - 1];
  return last ? (last[1].toUpperCase() as 'PASS' | 'FAIL') : null;
}

// Minimal seam over the opencode SDK client handed to the plugin factory.
// Shapes follow @opencode-ai/sdk v1 (types.gen.d.ts):
//   session.create({ query?: { directory } })              -> Session
//   session.prompt({ path: { id }, body: { agent?, parts } }) -> { info, parts }
//   session.abort({ path: { id } })                        -> boolean
// hey-api clients resolve to { data?, error? }; unwrapSdk also accepts payloads
// returned directly, so unit tests can pass simpler fakes.
export interface ReviewSessionClient {
  session: {
    create(options?: unknown): Promise<unknown>;
    prompt(options: unknown): Promise<unknown>;
    abort?(options: unknown): Promise<unknown>;
  };
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

function reviewerText(res: unknown): string {
  const parts = (res as { parts?: unknown })?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p: unknown): p is { type: 'text'; text?: unknown } => {
      return !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text';
    })
    .map((p) => String(p.text ?? ''))
    .join('\n');
}

function describeSdkError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Runs the review assertion through an isolated reviewer SESSION on the same
 * opencode server (via the plugin's SDK `client`) instead of spawning the
 * `opencode` CLI — which cannot be started without a shell on win32 (npm
 * installs .cmd/.ps1 shims that Node refuses to execute directly).
 *
 * NOTE: this reviewer session is top-level, so it lands in this gate instance's
 * own sessions registry via session.created — but it stays gateEnabled=false,
 * keeping the gate inert for it (review prompts can never trigger gating).
 */
export async function runReviewAssertion(
  a: ReviewAssertion,
  cwd: string,
  client?: ReviewSessionClient,
  isAborted?: () => boolean
): Promise<AssertionOutcome> {
  if (isAborted?.()) throw new GateAborted();
  if (!client?.session)
    return fail(a.name, 'no opencode SDK client available to run the reviewer session');
  logDiag(`review "${a.name}": creating reviewer session in ${cwd}`);
  const prompt = [
    a.prompt ?? 'Review the changes on this branch against the task requirements.',
    'Finish your reply with a final line containing exactly "VERDICT: PASS" or "VERDICT: FAIL" followed by a one-line justification.',
  ].join('\n');

  try {
    // Create the reviewer session inside the gated repo so the reviewer agent
    // runs against that directory's working tree.
    const created = unwrapSdk<{ id?: string }>(
      await client.session.create({ query: { directory: cwd } })
    );
    const sessionId = created?.id;
    if (!sessionId)
      return fail(a.name, 'could not create reviewer session (no session id in response)');
    logDiag(
      `review "${a.name}": reviewer session ${sessionId} — prompting agent "${a.agent}" (timeout=${a.timeoutSeconds}s)`
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raced = await Promise.race([
        client.session
          .prompt({
            path: { id: sessionId },
            body: { agent: a.agent, parts: [{ type: 'text', text: prompt }] },
          })
          .then(
            (r: unknown) => ({ ok: true as const, r }),
            (err: unknown) => ({ ok: false as const, err })
          ),
        new Promise<{ timedOut: true }>((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true }), a.timeoutSeconds * 1000);
        }),
      ]);

      if ('timedOut' in raced) {
        logDiag(
          `review "${a.name}": TIMED OUT after ${a.timeoutSeconds}s — aborting reviewer session`
        );
        try {
          await Promise.resolve(client.session.abort?.({ path: { id: sessionId } }));
        } catch {
          // abort is best-effort; the timeout failure stands on its own
        }
        return fail(
          a.name,
          `review timed out after ${a.timeoutSeconds}s (reviewer session aborted)`
        );
      }
      if (!raced.ok) {
        return fail(a.name, `reviewer session failed: ${describeSdkError(raced.err)}`);
      }

      const text = reviewerText(unwrapSdk(raced.r));
      const verdict = parseVerdict(text);
      logDiag(`review "${a.name}": verdict=${verdict ?? 'none'}`);
      const evidence = truncateTail(text);
      if (verdict === 'PASS') return pass(a.name);
      if (verdict === 'FAIL') return fail(a.name, `reviewer rejected:\n${evidence}`);
      return fail(a.name, `reviewer produced no VERDICT line:\n${evidence}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    return fail(a.name, `reviewer session failed: ${describeSdkError(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Assertion orchestration
// ---------------------------------------------------------------------------

/** Thrown by runners at checkpoint boundaries when isAborted() fires; caught by
 *  evaluateAssertions which then returns null ("no decision — run cancelled"). */
class GateAborted extends Error {}

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
      body: { parts: [{ type: 'text', text: injectFailureText(state, last, cap.value) }] },
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

    'chat.message': async ({ sessionID }, output) => {
      try {
        const state = sessions.get(sessionID);
        if (!state || state.deleted) return;
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
