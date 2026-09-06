import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { AssertionOutcome, GateAssertion, GateConfig } from './types.js';

export type GateMode = 'combined' | 'command-only';

export class GateAborted extends Error {}

export function pass(name: string): AssertionOutcome {
  return { name, passed: true, evidence: '' };
}

export function fail(name: string, evidence: string): AssertionOutcome {
  return { name, passed: false, evidence: evidence.trim() };
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
  return { path, projectRoot: dirname(dirname(path)), config };
}

const BOOTSTRAP_COMMAND_ENV = 'OPENCODE_GATE_BOOTSTRAP_COMMAND';
const BOOTSTRAP_COMMAND_B64_ENV = 'OPENCODE_GATE_BOOTSTRAP_COMMAND_B64';
const BOOTSTRAP_MODE_ENV = 'OPENCODE_GATE_BOOTSTRAP_MODE';
const BOOTSTRAP_MAX_RETRIES_ENV = 'OPENCODE_GATE_BOOTSTRAP_MAX_RETRIES';

function parsePositiveIntToken(tok: string): number | null {
  const n = Number(tok);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function readBootstrapGateCommand(): {
  command: string;
  mode: GateMode;
  maxRetries?: number;
} | null {
  const b64 = process.env[BOOTSTRAP_COMMAND_B64_ENV];
  const plain = process.env[BOOTSTRAP_COMMAND_ENV];
  let command = '';
  if (typeof b64 === 'string' && b64.trim() !== '') {
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

export function consumeBootstrapGateCommand(): void {
  delete process.env[BOOTSTRAP_COMMAND_B64_ENV];
  delete process.env[BOOTSTRAP_COMMAND_ENV];
  delete process.env[BOOTSTRAP_MODE_ENV];
  delete process.env[BOOTSTRAP_MAX_RETRIES_ENV];
}

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
  } else if (/^--(?:retries|max-retries)(?:\s*=\s*)?$/i.test(body)) invalid = true;
  const trailingMatch = /\s+--(?:retries|max-retries)(?:\s+|=)(\S+)\s*$/i.exec(body);
  if (trailingMatch) {
    const parsed = parsePositiveIntToken(trailingMatch[1]);
    if (parsed === null) invalid = true;
    else trailing = parsed;
    body = body.slice(0, trailingMatch.index).trim();
  } else if (/\s+--(?:retries|max-retries)(?:\s*=\s*)?$/i.test(body)) invalid = true;
  const maxRetries = leading ?? trailing ?? undefined;
  return {
    command: body,
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    invalidRetry: invalid,
  };
}

export function effectiveMaxRetries(
  state: { gateMode: GateMode; sessionMaxRetries: number | null },
  configMaxRetries: number
): { value: number; source: 'session' | 'config' } {
  if (state.gateMode === 'command-only' && state.sessionMaxRetries !== null)
    return { value: state.sessionMaxRetries, source: 'session' };
  return { value: configMaxRetries, source: 'config' };
}

interface SessionMetadata {
  id?: unknown;
  directory?: unknown;
  parentID?: unknown;
}

export interface ValidatedSessionMetadata {
  sessionID: string;
  directory: string;
}

export function validateTopLevelSessionMetadata(
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
  )
    return null;
  return { sessionID: metadata.id, directory: metadata.directory };
}
