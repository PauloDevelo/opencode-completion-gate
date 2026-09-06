import { describe, expect, it } from 'vitest';
import { runCommand, runCommandAssertion } from '../src/core.js';
import type { CommandAssertion } from '../src/core.js';

describe('runCommand', () => {
  it('captures exit code 0 and combined streams', async () => {
    const r = await runCommand(
      "node -e \"console.error('E'); console.log('O')\"",
      process.cwd(),
      15_000
    );
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdout.trim()).toBe('O');
    expect(r.stderr.trim()).toBe('E');
  });

  it('captures nonzero exit codes', async () => {
    const r = await runCommand('node -e "process.exit(7)"', process.cwd(), 15_000);
    expect(r.code).toBe(7);
  });

  it('flags timeouts', async () => {
    const r = await runCommand('node -e "setTimeout(function(){},10000)"', process.cwd(), 400);
    expect(r.timedOut).toBe(true);
  }, 20_000);
});

describe('runCommandAssertion', () => {
  const cwd = process.cwd();

  it('passes on exit code 0', async () => {
    const a: CommandAssertion = {
      type: 'command',
      name: 'ok',
      run: 'node -e "process.exit(0)"',
      timeoutSeconds: 30,
    };
    expect(await runCommandAssertion(a, cwd)).toEqual({ name: 'ok', passed: true, evidence: '' });
  });

  it('fails with exit code + stderr evidence', async () => {
    const a: CommandAssertion = {
      type: 'command',
      name: 'ut',
      run: 'node -e "console.error(\'boom\'); process.exit(1)"',
      timeoutSeconds: 30,
    };
    const r = await runCommandAssertion(a, cwd);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('exit code 1');
    expect(r.evidence).toContain('boom');
  });

  it('fails on timeout with evidence', async () => {
    const a: CommandAssertion = {
      type: 'command',
      name: 'slow',
      run: 'node -e "setTimeout(function(){},10000)"',
      timeoutSeconds: 1,
    };
    const r = await runCommandAssertion(a, cwd);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('timed out');
  }, 20_000);

  it('truncates huge failure output through truncateTail', async () => {
    const a: CommandAssertion = {
      type: 'command',
      name: 'big',
      run: 'node -e "for(let i=0;i<200;i++) console.error(\'L\'+i); process.exit(1)"',
      timeoutSeconds: 30,
    };
    const r = await runCommandAssertion(a, cwd);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('earlier lines omitted');
    expect(r.evidence).toContain('L199');
  });
});
