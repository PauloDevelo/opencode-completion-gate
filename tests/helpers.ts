import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import type { Mock } from 'vitest';

export interface TestOutput {
  parts: Array<{ type: string; text?: string }>;
  noReply?: boolean;
}
export interface TestClient {
  session: { get: Mock; promptAsync: Mock; create: Mock; prompt: Mock; abort?: Mock };
  tui: { showToast: Mock };
}
export interface TestHooks {
  event(input: { event: Record<string, unknown> }): Promise<void>;
  'chat.message'(input: { sessionID: string }, output: TestOutput): Promise<void>;
  'command.execute.before'(
    input: { command: string; sessionID: string; arguments: string },
    output: TestOutput
  ): Promise<void>;
}

export type TestPlugin = (input: { client: TestClient }) => Promise<TestHooks>;

/** Creates a temp project dir under the pre-approved sandbox root.
 *  Writes each entry (relative path -> content), plus a `.git` FILE so
 *  findGateConfigPath stops walking up here. */
export function makeTempProject(files: Record<string, string>): string {
  mkdirSync(join(tmpdir(), 'opencode'), { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'opencode', 'completion-gate-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  writeFileSync(join(root, '.git'), 'gitdir: nowhere', 'utf8');
  return root;
}
