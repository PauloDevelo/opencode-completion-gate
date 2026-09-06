import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { findGateConfigPath, loadGateConfig, truncateTail } from '../src/core.js';
import { makeTempProject } from './helpers.js';

describe('truncateTail', () => {
  it('returns text unchanged when under the limit', () => {
    expect(truncateTail('a\nb\nc')).toBe('a\nb\nc');
  });

  it('keeps the LAST n lines and prepends an omission notice', () => {
    const text = Array.from({ length: 60 }, (_, i) => `line${i + 1}`).join('\n');
    const out = truncateTail(text, 50);
    expect(out).toContain('[... 10 earlier lines omitted]');
    expect(out).toContain('line51');
    expect(out).toContain('line60');
    expect(out).not.toContain('line10\n');
  });
});

describe('findGateConfigPath', () => {
  it('finds .opencode/completion-gate.json in the start dir', () => {
    const dir = makeTempProject({ '.opencode/completion-gate.json': '{}' });
    expect(findGateConfigPath(dir)).toBe(join(dir, '.opencode', 'completion-gate.json'));
  });

  it('walks up from a subdirectory', () => {
    const dir = makeTempProject({ '.opencode/completion-gate.json': '{}' });
    expect(findGateConfigPath(join(dir, 'src', 'sub'))).toBe(
      join(dir, '.opencode', 'completion-gate.json')
    );
  });

  it('returns null when no config exists anywhere up the tree', () => {
    const dir = makeTempProject({});
    expect(findGateConfigPath(dir)).toBeNull();
  });

  it('does NOT escape past the git root', () => {
    // temp dirs are NOT nested inside a repo containing a config, so this holds by construction;
    // explicit guard: a child project without config but with .git file yields null even though
    // an ancestor might theoretically have one.
    const parent = makeTempProject({ '.opencode/completion-gate.json': '{}' });
    const child = join(parent, 'other-repo');
    mkdirSync(join(child, '.opencode'), { recursive: true });
    writeFileSync(join(child, '.git'), 'gitdir: x');
    expect(findGateConfigPath(child)).toBeNull();
  });
});

describe('loadGateConfig', () => {
  it('loads a valid full config with defaults applied', () => {
    const dir = makeTempProject({
      '.opencode/completion-gate.json': JSON.stringify({
        assertions: [
          { type: 'command', run: 'node -e "process.exit(0)"' },
          { type: 'ado-pr', skipIfNoPr: true },
          { type: 'opencode-review', agent: 'reviewer' },
        ],
      }),
    });
    const loaded = loadGateConfig(dir)!;
    expect(loaded.path).toBe(join(dir, '.opencode', 'completion-gate.json'));
    expect(loaded.projectRoot).toBe(dir);
    expect(loaded.config.enabled).toBe(true);
    expect(loaded.config.maxRetries).toBe(3);
    expect(loaded.config.assertions).toEqual([
      { type: 'command', name: 'node', run: 'node -e "process.exit(0)"', timeoutSeconds: 300 },
      {
        type: 'ado-pr',
        name: 'ado-pr',
        pollTimeoutMinutes: 15,
        pollIntervalSeconds: 30,
        skipIfNoPr: true,
        ignoreHumanPolicies: false,
      },
      {
        type: 'opencode-review',
        name: 'self-review',
        agent: 'reviewer',
        prompt: undefined,
        timeoutSeconds: 900,
      },
    ]);
  });

  it('parses ignoreHumanPolicies=true on an ado-pr assertion', () => {
    const dir = makeTempProject({
      '.opencode/completion-gate.json': JSON.stringify({
        assertions: [{ type: 'ado-pr', ignoreHumanPolicies: true }],
      }),
    });
    const loaded = loadGateConfig(dir)!;
    expect(loaded.config.assertions[0]).toMatchObject({
      type: 'ado-pr',
      ignoreHumanPolicies: true,
    });
  });

  it('returns null when disabled', () => {
    const dir = makeTempProject({
      '.opencode/completion-gate.json': JSON.stringify({
        enabled: false,
        assertions: [{ type: 'command', run: 'x' }],
      }),
    });
    expect(loadGateConfig(dir)).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    const dir = makeTempProject({ '.opencode/completion-gate.json': '{oops' });
    expect(loadGateConfig(dir)).toBeNull();
  });

  it('returns null when assertions missing/empty/unknown-type', () => {
    for (const raw of ['{}', '{"assertions":[]}', '{"assertions":[{"type":"wat"}]}']) {
      const dir = makeTempProject({ '.opencode/completion-gate.json': raw });
      expect(loadGateConfig(dir)).toBeNull();
    }
  });

  it('rejects a command assertion without run', () => {
    const dir = makeTempProject({
      '.opencode/completion-gate.json': JSON.stringify({
        assertions: [{ type: 'command', name: 'nope' }],
      }),
    });
    expect(loadGateConfig(dir)).toBeNull();
  });
});
