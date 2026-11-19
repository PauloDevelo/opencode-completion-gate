/**
 * Structured evidence that a gate evaluation actually ran.
 *
 * The orchestrator (branch-sync `syncd`) refuses to call a hop green unless it
 * can see what the gate evaluated. `gate-diag.log` is not usable for that: it is
 * shared by every concurrent session, it records verdicts only, and it is a log
 * rather than a contract. Every evaluation writes one JSON record instead:
 *
 *   { "version": 1, "sessionId": "...", "configPath": "...", "platform": "linux",
 *     "startedAt": "...", "finishedAt": "...", "expected": 3, "evaluated": 3,
 *     "outcome": "passed", "assertions": [{ "name": "build", "passed": true }] }
 *
 * Two rules make the record trustworthy:
 *
 * - `outcome` is `passed` only when every EXPECTED assertion produced a passing
 *   result. Short-circuiting means the tail assertions never ran, and "verified 1
 *   of 3" must never read as a pass.
 * - an evaluation that expected nothing is `failed`, because zero observations is
 *   not a pass.
 *
 * Writing is best effort: a record that cannot be written must not break the gate,
 * so the failure is logged and the caller carries on.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { AssertionOutcome } from './types.js';
import { logDiag } from './process.js';

export const RUN_RECORD_DIR_ENV = 'OPENCODE_GATE_RUN_DIR';

export interface RunRecordInput {
  sessionId: string;
  configPath: string | null;
  projectRoot: string;
  startedAt: string;
  finishedAt: string;
  expectedAssertions: string[];
  results: AssertionOutcome[];
}

export interface RunRecordAssertion {
  name: string;
  passed: boolean;
  evidence?: string;
}

export interface RunRecord {
  version: 1;
  sessionId: string;
  configPath: string | null;
  projectRoot: string;
  platform: string;
  startedAt: string;
  finishedAt: string;
  expected: number;
  evaluated: number;
  outcome: 'passed' | 'failed';
  assertions: RunRecordAssertion[];
}

const EVIDENCE_LIMIT = 200;

function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? '';
  return line.length > EVIDENCE_LIMIT ? `${line.slice(0, EVIDENCE_LIMIT - 3)}...` : line;
}

export function buildRunRecord(input: RunRecordInput): RunRecord {
  const assertions: RunRecordAssertion[] = input.results.map((result) =>
    result.passed
      ? { name: result.name, passed: true }
      : { name: result.name, passed: false, evidence: firstLine(result.evidence) }
  );

  const byName = new Map(assertions.map((a) => [a.name, a]));
  const everyExpectedPassed =
    input.expectedAssertions.length > 0 &&
    input.expectedAssertions.every((name) => byName.get(name)?.passed === true);

  return {
    version: 1,
    sessionId: input.sessionId,
    configPath: input.configPath,
    projectRoot: input.projectRoot,
    platform: process.platform,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    expected: input.expectedAssertions.length,
    evaluated: assertions.length,
    outcome: everyExpectedPassed ? 'passed' : 'failed',
    assertions,
  };
}

export function runRecordDir(): string {
  const configured = process.env[RUN_RECORD_DIR_ENV]?.trim();
  if (configured) return configured;
  return join(homedir(), '.config', 'opencode', 'gate-runs');
}

function fileNameFor(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe || 'session'}.json`;
}

export function writeRunRecord(input: RunRecordInput): { path: string; record: RunRecord } | null {
  const record = buildRunRecord(input);
  const path = join(runRecordDir(), fileNameFor(input.sessionId));
  try {
    mkdirSync(runRecordDir(), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch (err) {
    logDiag(
      `run record: could not write ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
  logDiag(`run record: ${record.outcome} for ${input.sessionId} at ${path}`);
  return { path, record };
}
