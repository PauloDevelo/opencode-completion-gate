import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

/** Creates a temp project dir under the pre-approved sandbox root.
 *  Writes each entry (relative path -> content), plus a `.git` FILE so
 *  findGateConfigPath stops walking up here. */
export function makeTempProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'opencode', 'completion-gate-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  writeFileSync(join(root, '.git'), 'gitdir: nowhere', 'utf8');
  return root;
}
