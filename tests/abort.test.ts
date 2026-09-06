import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { evaluateAssertions, runAdoPrAssertion } from '../src/core.js';
import type { ShellFn } from '../src/core.js';

const TMP = mkdtempSync(join(tmpdir(), 'opencode-gate-abort-'));
/** Forward slashes so the path survives inside a double-quoted node -e body. */
function markerPath(name: string): string {
  return join(TMP, name).split('\\').join('/');
}
function cmdWriteMarker(markerFile: string, delayMs: number) {
  const js = `setTimeout(()=>{require('fs').writeFileSync('${markerFile}','1');process.exit(0)},${delayMs})`;
  return { type: 'command' as const, name: markerFile, run: `node -e "${js}"`, timeoutSeconds: 30 };
}

const PR_ONE = JSON.stringify([{ id: 42 }]);
const POL_RED = JSON.stringify([
  { configuration: { isBlocking: true, type: { displayName: 'Build' } }, status: 'running' },
]);

describe('mid-run abort (gate turned off while evaluating)', () => {
  it('runs nothing when already aborted at start', async () => {
    const marker = markerPath('never-started.ran');
    const res = await evaluateAssertions([cmdWriteMarker(marker, 0)], TMP, undefined, () => true);
    expect(res).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  it('stops between assertions and yields no outcome when aborted mid-list', async () => {
    const ranA = markerPath('ran-a.ran');
    const ranB = markerPath('ran-b.ran');
    let aborted = false;
    setTimeout(() => {
      aborted = true;
    }, 50);
    const res = await evaluateAssertions(
      [cmdWriteMarker(ranA, 200), cmdWriteMarker(ranB, 0)],
      TMP,
      undefined,
      () => aborted
    );
    expect(res).toBeNull();
    expect(existsSync(ranA)).toBe(true);
    expect(existsSync(ranB)).toBe(false);
  });

  it('aborts ado-pr polling between rounds instead of sleeping again', async () => {
    let policyCalls = 0;
    let releasePolicy!: () => void;
    const policyGate = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    const shell: ShellFn = async (args) => {
      const key = args.join(' ');
      if (args[0] === 'git') return 'feat/x\n';
      if (key.includes('repos pr list')) return PR_ONE;
      if (key.includes('repos pr policy')) {
        policyCalls += 1;
        await policyGate;
        return POL_RED;
      }
      throw new Error(`unexpected shell call: ${key}`);
    };
    let aborted = false;
    const pending = runAdoPrAssertion(
      {
        type: 'ado-pr',
        name: 'pr',
        pollTimeoutMinutes: 5,
        pollIntervalSeconds: 5,
        skipIfNoPr: false,
      },
      TMP,
      shell,
      { sleep: async () => {}, now: () => Date.now(), isAborted: () => aborted }
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(policyCalls).toBe(1);
    aborted = true;
    releasePolicy();
    await expect(pending).rejects.toThrow();
    expect(policyCalls).toBe(1); // no second round started
  });

  it('ado-pr without isAborted keeps polling to the deadline (regression guard)', async () => {
    const shell: ShellFn = async (args) => {
      const key = args.join(' ');
      if (args[0] === 'git') return 'feat/x\n';
      if (key.includes('repos pr list')) return PR_ONE;
      if (key.includes('repos pr policy')) return POL_RED;
      throw new Error(`unexpected shell call: ${key}`);
    };
    let t = 0;
    const r = await runAdoPrAssertion(
      {
        type: 'ado-pr',
        name: 'pr',
        pollTimeoutMinutes: 1,
        pollIntervalSeconds: 5,
        skipIfNoPr: false,
      },
      TMP,
      shell,
      { sleep: async () => {}, now: () => (t += 30_000) }
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('did not reach green');
  });
});
