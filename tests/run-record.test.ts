import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RUN_RECORD_DIR_ENV, buildRunRecord, runRecordDir, writeRunRecord } from '../src/core.js';
import { makeTempProject, startPlugin } from './helpers.js';
import type { TestClient, TestOutput } from './helpers.js';

const PASSING = { name: 'build', passed: true, evidence: '' };
const FAILING = { name: 'tests', passed: false, evidence: 'exit code 1\nboom' };

function input(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    configPath: '/proj/.opencode/completion-gate.json',
    projectRoot: '/proj',
    startedAt: '2026-11-19T10:00:00.000Z',
    finishedAt: '2026-11-19T10:01:00.000Z',
    expectedAssertions: ['build'],
    results: [PASSING],
    ...overrides,
  };
}

describe('buildRunRecord', () => {
  it('marks the run passed only when every expected assertion passed', () => {
    const record = buildRunRecord(input({ expectedAssertions: ['build'], results: [PASSING] }));

    expect(record.outcome).toBe('passed');
    expect(record.assertions).toEqual([{ name: 'build', passed: true }]);
    expect(record.configPath).toBe('/proj/.opencode/completion-gate.json');
    expect(record.finishedAt).toBe('2026-11-19T10:01:00.000Z');
  });

  it('marks the run failed when an expected assertion never ran', () => {
    // Short-circuiting is the normal case: assertion 2 never executes.
    const record = buildRunRecord(
      input({ expectedAssertions: ['build', 'tests'], results: [PASSING] })
    );

    expect(record.outcome).toBe('failed');
    expect(record.evaluated).toBe(1);
    expect(record.expected).toBe(2);
  });

  it('marks the run failed when nothing was expected', () => {
    // Zero observations is never a pass.
    const record = buildRunRecord(input({ expectedAssertions: [], results: [] }));

    expect(record.outcome).toBe('failed');
  });

  it('records the failure evidence as a bounded single line', () => {
    const record = buildRunRecord(input({ expectedAssertions: ['tests'], results: [FAILING] }));

    expect(record.outcome).toBe('failed');
    expect(record.assertions[0]).toMatchObject({ name: 'tests', passed: false });
    expect(record.assertions[0].evidence).toBe('exit code 1');
    expect(record.assertions[0].evidence.length).toBeLessThanOrEqual(200);
  });

  it('records passing-assertion evidence so a pass says what it saw', () => {
    const passingWithEvidence = {
      name: 'ado-pr',
      passed: true,
      evidence: '1 required policy(ies) green: Build=succeeded',
    };
    const record = buildRunRecord(
      input({ expectedAssertions: ['ado-pr'], results: [passingWithEvidence] })
    );

    expect(record.outcome).toBe('passed');
    expect(record.assertions[0]).toEqual({
      name: 'ado-pr',
      passed: true,
      evidence: '1 required policy(ies) green: Build=succeeded',
    });
  });
});

describe('writeRunRecord', () => {
  it('writes <session>.json into the configured directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-runs-'));
    vi.stubEnv(RUN_RECORD_DIR_ENV, dir);

    const written = writeRunRecord(input({ sessionId: 'ses_abc' }))!;

    expect(written).not.toBeNull();
    expect(written.path).toBe(join(dir, 'ses_abc.json'));
    const stored = JSON.parse(readFileSync(written.path, 'utf8'));
    expect(stored).toMatchObject({ outcome: 'passed', sessionId: 'ses_abc' });
    vi.unstubAllEnvs();
  });

  it('falls back to the opencode config directory', () => {
    vi.stubEnv(RUN_RECORD_DIR_ENV, '');

    expect(runRecordDir()).toMatch(/gate-runs$/);
    vi.unstubAllEnvs();
  });

  it('does not throw when the record cannot be written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-runs-'));
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not a directory');
    vi.stubEnv(RUN_RECORD_DIR_ENV, join(blocked, 'sub'));

    expect(writeRunRecord(input())).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe('turn end', () => {
  it('writes a run record the orchestrator can read', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'gate-runs-'));
    vi.stubEnv(RUN_RECORD_DIR_ENV, runDir);
    vi.resetModules();

    const dir = makeTempProject({
      '.opencode/completion-gate.json': JSON.stringify({
        enabled: true,
        maxRetries: 1,
        assertions: [
          { type: 'command', name: 'noop', run: 'node -e "process.exit(0)"', timeoutSeconds: 30 },
        ],
      }),
    });
    const hooks = await startPlugin({
      session: { get: vi.fn(), promptAsync: vi.fn(async () => ({ info: {}, parts: [] })) },
      tui: { showToast: vi.fn(async () => {}) },
    } as TestClient);

    await hooks.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'ses_record', directory: dir, parentID: undefined } },
      },
    });
    await hooks['chat.message']({ sessionID: 'ses_record' }, {
      parts: [{ type: 'text', text: '[completion-gate]' }],
    } as TestOutput);
    await hooks.event({
      event: {
        type: 'session.execution.succeeded',
        properties: { sessionID: 'ses_record' },
      },
    });

    const path = join(runDir, 'ses_record.json');
    await vi.waitFor(() => expect(existsSync(path)).toBe(true));
    const record = JSON.parse(readFileSync(path, 'utf8'));
    expect(record.outcome).toBe('passed');
    expect(record.assertions.map((a: { name: string }) => a.name)).toEqual(['noop']);
    expect(record.evaluated).toBe(1);
    vi.unstubAllEnvs();
  });
});
