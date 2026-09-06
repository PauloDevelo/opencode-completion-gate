import { describe, expect, it } from 'vitest';
import { buildShellInvocation, execShell, quoteWin } from '../src/core.js';

function withPlatform<T>(platform: 'win32' | 'linux', fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return fn();
  } finally {
    if (original?.get) Object.defineProperty(process, 'platform', original);
    else if (original) Object.defineProperty(process, 'platform', { value: original.value });
  }
}

describe('quoteWin', () => {
  it('leaves plain tokens untouched', () => {
    expect(quoteWin('az')).toBe('az');
    expect(quoteWin('--source-branch')).toBe('--source-branch');
    expect(quoteWin('D:\\repos\\proj')).toBe('D:\\repos\\proj');
  });
  it('quotes tokens with whitespace', () => {
    expect(quoteWin('my branch')).toBe('"my branch"');
  });
  it('doubles embedded quotes inside quoted tokens', () => {
    expect(quoteWin('say "hi"')).toBe('"say ""hi"""');
  });
  it('quotes cmd metacharacters', () => {
    for (const ch of ['^', '&', '|', '<', '>']) {
      expect(quoteWin(`a${ch}b`)).toBe(`"a${ch}b"`);
    }
  });
});

describe('buildShellInvocation', () => {
  const prevComSpec = process.env.ComSpec;

  it('routes through cmd.exe on win32 with a single quoted command line', () => {
    process.env.ComSpec = 'C:\\Windows\\system32\\cmd.exe';
    try {
      const inv = withPlatform('win32', () => buildShellInvocation(['git', '--version']));
      expect(inv.file).toBe('C:\\Windows\\system32\\cmd.exe');
      expect(inv.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      // exactly one trailing argv element: the outer-quoted command line
      expect(inv.args.length).toBe(4);
      expect(inv.args[3]).toBe('"git --version"');
    } finally {
      if (prevComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = prevComSpec;
    }
  });

  it('quotes tokens that need it on win32', () => {
    const inv = withPlatform('win32', () =>
      buildShellInvocation(['git', '-C', 'D:\\dir with space', 'status'])
    );
    expect(inv.args[3]).toBe('"git -C "D:\\dir with space" status"');
  });

  it('passes argv straight through on non-win32', () => {
    const inv = withPlatform('linux', () => buildShellInvocation(['az', 'repos', 'pr', 'list']));
    expect(inv).toEqual({ file: 'az', args: ['repos', 'pr', 'list'] });
  });
});

describe('execShell on real Windows cmd shim', () => {
  it('runs git through the cmd path', { skip: process.platform !== 'win32' }, async () => {
    const out = await execShell(['git', '--version'], process.cwd(), 15_000);
    expect(out).toMatch(/git version/);
  });

  it(
    'delivers quoted tokens with spaces intact to the child',
    { skip: process.platform !== 'win32' },
    async () => {
      const out = await execShell(['node', '-e', `console.log('ok done')`], process.cwd(), 15_000);
      expect(out.trim()).toBe('ok done');
    }
  );

  it(
    'maps nonzero exit codes to actionable errors',
    { skip: process.platform !== 'win32' },
    async () => {
      await expect(
        execShell(['node', '-e', 'process.exit(7)'], process.cwd(), 15_000)
      ).rejects.toThrow(/code 7/);
    }
  );
});
