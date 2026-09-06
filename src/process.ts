import { appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec, execFile } from 'child_process';
import type { SpawnOptions } from 'child_process';
import type { ProcessOutcome, ShellFn, ShellInvocation } from './types.js';

const BASE_DIR = join(homedir(), '.config', 'opencode');

export function logDiag(msg: string): void {
  try {
    appendFileSync(join(BASE_DIR, 'gate-diag.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // best-effort diagnostics — ignore write failures
  }
}

export function brief(s: string): string {
  const line =
    s
      .replace(/\r\n/g, '\n')
      .split('\n')
      .find((l) => l.trim() !== '') ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

export function truncateTail(text: string, maxLines = 50): string {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '');
  if (lines.length <= maxLines) return lines.join('\n');
  return `[... ${lines.length - maxLines} earlier lines omitted]\n${lines.slice(-maxLines).join('\n')}`;
}

function outcomeFromErr(err: (Error & { code?: unknown; killed?: boolean }) | null): number | null {
  if (!err) return 0;
  return typeof err.code === 'number' ? err.code : null;
}

export function runCommand(cmd: string, cwd: string, timeoutMs: number): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let childTimedOut = false;
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

export function quoteWin(s: string): string {
  return /[\s"^&|<>]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildShellInvocation(args: string[]): ShellInvocation {
  if (process.platform !== 'win32') return { file: args[0], args: args.slice(1) };
  const cmdline = [args[0], ...args.slice(1)].map(quoteWin).join(' ');
  return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${cmdline}"`] };
}

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

export function describeSdkError(err: unknown): string {
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
