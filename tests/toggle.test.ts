import type { TestClient, TestHooks, TestOutput, TestPlugin } from './helpers.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeTempProject } from './helpers.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual }; // keep real fs; we only need resetModules isolation
});

function makeFakeClient() {
  return {
    session: {
      get: vi.fn(),
      promptAsync: vi.fn(async () => ({ info: {}, parts: [] })),
    },
    tui: { showToast: vi.fn(async () => {}) },
  } as TestClient;
}

async function freshHooks(client: TestClient) {
  vi.resetModules();
  const mod = await import('../src/core.js');
  const hooks = await (mod.default as TestPlugin)({ client });
  return hooks;
}

describe('/gate toggle via chat.message', () => {
  let client: TestClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  async function registeredSession(hooks: TestHooks, id = 's1', directory = 'D:/nowhere') {
    await hooks.event({
      event: {
        type: 'session.created',
        properties: { info: { id, directory, parentID: undefined } },
      },
    });
  }

  function partsWith(text: string) {
    return { parts: [{ type: 'text', text }] } as TestOutput;
  }

  // Slash /gate is fully handled by the plugin: it arms/reports, shows a
  // toast, then throws a sentinel to abort the command flow so the model
  // stays idle (no LLM turn). The rejection IS the expected outcome.
  async function runGateSlash(hooks: TestHooks, sessionID: string, args: string, text: string) {
    const out = partsWith(text);
    await expect(
      hooks['command.execute.before']({ command: 'gate', sessionID, arguments: args }, out)
    ).rejects.toThrow();
    return out;
  }

  function expectAnchor(out: TestOutput, snippet: string) {
    expect(out.parts).toHaveLength(1);
    expect(out.parts[0].text).toContain(snippet);
    expect(out.parts[0].text).toContain('acknowledge briefly');
  }

  it('consumes the internal orchestration directive without exposing the gate command', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const out = partsWith(
      '[completion-gate-internal] --only node -e "process.exit(0)"\nTranslate this group.'
    );

    await hooks['chat.message']({ sessionID: 's1' }, out);

    expect(out.parts[0].text).toBe('Translate this group.');
    const status = partsWith('[completion-gate] status');
    await hooks['chat.message']({ sessionID: 's1' }, status);
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: expect.stringContaining('mode=command-only') },
    });
    expect(client.tui.showToast.mock.calls.at(-1)[0].body.message).toContain(
      'extraCommand=configured'
    );
  });

  it('bare marker enables the gate and constrains the turn with an anchor', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const out = partsWith('[completion-gate]');
    await hooks['chat.message']({ sessionID: 's1' }, out);
    // chat.message cannot abort the turn — it swaps in an anchor instead.
    expectAnchor(out, 'Completion gate enabled for this session.');
    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: { variant: 'info', message: 'Completion gate enabled for this session.' },
    });
  });

  it('direct chat custom arguments enable the gate and register the command', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const out = partsWith('[completion-gate] python scripts/assert_task_done.py');

    await hooks['chat.message']({ sessionID: 's1' }, out);

    expectAnchor(out, 'Completion gate armed (combined)');
    const status = partsWith('[completion-gate] status');
    await hooks['chat.message']({ sessionID: 's1' }, status);
    expectAnchor(status, 'Completion gate: ENABLED');
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: expect.stringContaining('extraCommand=configured') },
    });
  });

  it('direct chat accepts custom commands beginning with RETRY', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const out = partsWith('[completion-gate] RETRY custom-check');

    await hooks['chat.message']({ sessionID: 's1' }, out);

    expectAnchor(out, 'Completion gate armed (combined)');
    const status = partsWith('[completion-gate] status');
    await hooks['chat.message']({ sessionID: 's1' }, status);
    expectAnchor(status, 'Completion gate: ENABLED');
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: expect.stringContaining('extraCommand=configured') },
    });
  });

  it('slash command enables the gate and aborts the turn (no LLM call)', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);

    const out = await runGateSlash(hooks, 's1', '', '[completion-gate]');
    expect(out.parts).toHaveLength(0);
    expect(out.noReply).toBe(true);
    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: { variant: 'info', message: 'Completion gate enabled for this session.' },
    });

    // Gate is armed despite the aborted turn — status reports ENABLED.
    const status = partsWith('[completion-gate] status');
    await hooks['chat.message']({ sessionID: 's1' }, status);
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: expect.stringContaining('Completion gate: ENABLED') },
    });
  });

  it('slash command off disables the gate and shows a toast', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const enabledOut = await runGateSlash(hooks, 's1', '', '[completion-gate]');
    expect(enabledOut.parts).toHaveLength(0);

    const out = await runGateSlash(hooks, 's1', 'off', '[completion-gate] off');
    expect(out.parts).toHaveLength(0);
    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: { variant: 'info', message: 'Completion gate disabled for this session.' },
    });
  });

  it('slash command status reports the current gate state', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    await runGateSlash(hooks, 's1', '', '[completion-gate]');
    const out = await runGateSlash(hooks, 's1', 'status', '[completion-gate] status');

    expect(out.parts).toHaveLength(0);
    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: { variant: 'info', message: expect.stringContaining('Completion gate: ENABLED') },
    });
  });

  it('slash command with custom arguments enables the gate and registers the command', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const out = await runGateSlash(
      hooks,
      's1',
      'python scripts/assert_task_done.py',
      '[completion-gate] python scripts/assert_task_done.py'
    );

    expect(out.parts).toHaveLength(0);
    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: {
        variant: 'info',
        message: expect.stringContaining('Completion gate armed (combined)'),
      },
    });
  });

  it('slash command --only enables command-only mode and reports configured status without exposing the command', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const out = await runGateSlash(
      hooks,
      's1',
      '--only python scripts/assert_task_done.py',
      '[completion-gate] --only python scripts/assert_task_done.py'
    );

    expect(out.parts).toHaveLength(0);
    const status = await runGateSlash(hooks, 's1', 'status', '[completion-gate] status');
    expect(status.parts).toHaveLength(0);
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: expect.stringContaining('extraCommand=configured') },
    });
    expect(client.tui.showToast.mock.calls.at(-1)[0].body.message).toContain('mode=command-only');
  });

  it('invalid --only usage preserves the existing command-only state', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    await runGateSlash(
      hooks,
      's1',
      '--only python scripts/assert_task_done.py',
      '[completion-gate] --only python scripts/assert_task_done.py'
    );

    const invalid = await runGateSlash(hooks, 's1', '--only', '[completion-gate] --only');
    expect(invalid.parts).toHaveLength(0);
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'error', message: 'Usage: /gate --only "command" [--retries N]' },
    });

    const status = await runGateSlash(hooks, 's1', 'status', '[completion-gate] status');
    expect(status.parts).toHaveLength(0);
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: expect.stringContaining('Completion gate: ENABLED') },
    });
  });

  it.each(['--onlyfoo', '--only=foo'])(
    'rejects malformed --only prefix %s without changing state',
    async (argument) => {
      const hooks = await freshHooks(client);
      await registeredSession(hooks);
      const invalid = await runGateSlash(hooks, 's1', argument, `[completion-gate] ${argument}`);

      expect(invalid.parts).toHaveLength(0);
      const status = await runGateSlash(hooks, 's1', 'status', '[completion-gate] status');
      expect(status.parts).toHaveLength(0);
      expect(client.tui.showToast).toHaveBeenLastCalledWith({
        body: { variant: 'info', message: expect.stringContaining('Completion gate: disabled') },
      });
    }
  );

  it('accepts case-insensitive --only syntax with a separate command remainder', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const out = await runGateSlash(
      hooks,
      's1',
      '--ONLY python scripts/assert_task_done.py',
      '[completion-gate] --ONLY python scripts/assert_task_done.py'
    );

    expect(out.parts).toHaveLength(0);
    const status = await runGateSlash(hooks, 's1', 'status', '[completion-gate] status');
    expect(status.parts).toHaveLength(0);
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: expect.stringContaining('mode=command-only') },
    });
  });

  it('preserves command-only mode through toggles and switches to combined mode for a normal command', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const only = '--only python scripts/assert_task_done.py';
    await runGateSlash(hooks, 's1', only, `[completion-gate] ${only}`);

    for (const argument of ['off', 'on', '']) {
      await runGateSlash(hooks, 's1', argument, `[completion-gate] ${argument}`);
      const status = partsWith('[completion-gate] status');
      await hooks['chat.message']({ sessionID: 's1' }, status);
      expect(client.tui.showToast).toHaveBeenLastCalledWith({
        body: { variant: 'info', message: expect.stringContaining('mode=command-only') },
      });
      expect(client.tui.showToast.mock.calls.at(-1)[0].body.message).toContain(
        'extraCommand=configured'
      );
    }

    await runGateSlash(
      hooks,
      's1',
      'node scripts/other_assertion.js',
      '[completion-gate] node scripts/other_assertion.js'
    );
    const combined = partsWith('[completion-gate] status');
    await hooks['chat.message']({ sessionID: 's1' }, combined);
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: expect.stringContaining('mode=combined') },
    });
    expect(client.tui.showToast.mock.calls.at(-1)[0].body.message).toContain(
      'extraCommand=configured'
    );
  });

  it('replaces a command-only command and executes only the replacement', async () => {
    const hooks = await freshHooks(client);
    const projectDir = makeTempProject({
      '.opencode/completion-gate.json': JSON.stringify({
        enabled: true,
        assertions: [{ type: 'command', run: 'node -e "process.exit(0)"' }],
      }),
    });
    await registeredSession(hooks, 's1', projectDir);
    const markerDir = mkdtempSync(join(tmpdir(), 'opencode-gate-replace-'));
    const markerA = join(markerDir, 'command-a.txt').split('\\').join('/');
    const markerB = join(markerDir, 'command-b.txt').split('\\').join('/');
    const commandA = `node -e "require('fs').writeFileSync('${markerA}','A')"`;
    const commandB = `node -e "require('fs').writeFileSync('${markerB}','B')"`;

    await runGateSlash(hooks, 's1', `--only ${commandA}`, `[completion-gate] --only ${commandA}`);
    await runGateSlash(hooks, 's1', `--only ${commandB}`, `[completion-gate] --only ${commandB}`);

    // The first registration kicked an immediate evaluation of A — wait for
    // it to settle, then start a fresh cycle so idle evaluates the
    // replacement B (a genuine message resets the pass streak).
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalled());
    expect(readFileSync(markerA, 'utf8')).toBe('A');
    await hooks['chat.message']({ sessionID: 's1' }, {
      parts: [{ type: 'text', text: 'please proceed' }],
    } as TestOutput);
    await hooks.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
    });
    await vi.waitFor(() => expect(existsSync(markerB)).toBe(true));
    expect(readFileSync(markerB, 'utf8')).toBe('B');

    const status = partsWith('[completion-gate] status');
    await hooks['chat.message']({ sessionID: 's1' }, status);
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: expect.stringContaining('extraCommand=configured') },
    });
    expect(client.tui.showToast.mock.calls.at(-1)[0].body.message).toContain('mode=command-only');
  });

  it('accepts the direct --only compatibility message and keeps generated messages untouched', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const direct = partsWith('[completion-gate] --only python scripts/assert_task_done.py');
    await hooks['chat.message']({ sessionID: 's1' }, direct);
    expectAnchor(direct, 'Completion gate armed (command-only)');

    const status = partsWith('[completion-gate] status');
    await hooks['chat.message']({ sessionID: 's1' }, status);
    expectAnchor(status, 'mode=command-only');
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: expect.stringContaining('mode=command-only') },
    });
    expect(client.tui.showToast.mock.calls.at(-1)[0].body.message).toContain(
      'extraCommand=configured'
    );

    const generated =
      '[completion-gate] ✖ Completion gate failed — "check". Fix these issues, then finish again.\n\n```\nboom\n```\n\n(RETRY 1/3)';
    const generatedOut = partsWith(generated);
    await hooks['chat.message']({ sessionID: 's1' }, generatedOut);
    expect(generatedOut.parts[0].text).toBe(generated);
  });

  it('preserves and replaces a custom command across gate toggles without exposing its contents', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);

    await runGateSlash(
      hooks,
      's1',
      'python scripts/assert_task_done.py',
      '[completion-gate] python scripts/assert_task_done.py'
    );
    await runGateSlash(hooks, 's1', 'off', '[completion-gate] off');
    await runGateSlash(hooks, 's1', 'on', '[completion-gate] on');

    const statusAfterToggle = partsWith('[completion-gate] status');
    await hooks['chat.message']({ sessionID: 's1' }, statusAfterToggle);
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: expect.stringContaining('extraCommand=configured') },
    });

    await runGateSlash(
      hooks,
      's1',
      'node scripts/other_assertion.js',
      '[completion-gate] node scripts/other_assertion.js'
    );
    const statusAfterReplacement = partsWith('[completion-gate] status');
    await hooks['chat.message']({ sessionID: 's1' }, statusAfterReplacement);
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: expect.stringContaining('extraCommand=configured') },
    });
  });

  it('lazily registers an unregistered resumed session before reporting disabled status', async () => {
    const hooks = await freshHooks(client);
    client.session.get.mockResolvedValue({
      data: { id: 'resumed', directory: 'D:/nowhere', parentID: undefined },
      error: undefined,
    });

    const out = await runGateSlash(hooks, 'resumed', 'status', '[completion-gate] status');

    expect(out.parts).toHaveLength(0);
    expect(client.session.get).toHaveBeenCalledWith({ path: { id: 'resumed' } });
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: expect.stringContaining('Completion gate: disabled') },
    });
  });

  it('unrelated slash commands are left untouched', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const out = partsWith('original command content');

    await hooks['command.execute.before'](
      { command: 'review', sessionID: 's1', arguments: '' },
      out
    );

    expect(out.parts[0].text).toBe('original command content');
  });

  it('command names other than lowercase gate are left untouched', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const out = partsWith('original command content');

    await hooks['command.execute.before']({ command: 'Gate', sessionID: 's1', arguments: '' }, out);

    expect(out.parts[0].text).toBe('original command content');
  });

  it('explicit off disables; status reports state', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const off = partsWith('[completion-gate] off');
    await hooks['chat.message']({ sessionID: 's1' }, off);
    expectAnchor(off, 'Completion gate disabled for this session.');
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: 'Completion gate disabled for this session.' },
    });

    const st = partsWith('[completion-gate] status');
    await hooks['chat.message']({ sessionID: 's1' }, st);
    expectAnchor(st, 'Completion gate: disabled');
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: expect.stringContaining('Completion gate: disabled') },
    });
  });

  it.each([
    '[completion-gate] ✖ Completion gate failed — "bad". Fix these issues, then finish again.\n\n```\nboom\n```\n\n(RETRY 1/3)',
    '[completion-gate] ✅ Completion gate passed (ok). You may report done.',
  ])('ignores an injected plugin message (%s)', async (injected) => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const out = partsWith(injected);
    await hooks['chat.message']({ sessionID: 's1' }, out);
    expect(out.parts[0].text).toBe(injected);
  });

  it('a genuine user message does not get rewritten', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const out = partsWith('please also update the docs');
    await hooks['chat.message']({ sessionID: 's1' }, out);
    expect(out.parts[0].text).toBe('please also update the docs');
  });

  it('subagent sessions (with parentID) are never registered', async () => {
    const hooks = await freshHooks(client);
    await hooks.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'kid', directory: 'D:/nowhere', parentID: 's1' } },
      },
    });
    const out = partsWith('[completion-gate]');
    await hooks['chat.message']({ sessionID: 'kid' }, out);
    expect(out.parts[0].text).toBe('[completion-gate]'); // hook bailed out — no rewrite
  });

  it.each([
    ['empty string', ''],
    ['null', null],
    ['false', false],
  ])(
    'leaves the command unchanged for a malformed fetched parentID (%s)',
    async (_label, parentID) => {
      const hooks = await freshHooks(client);
      client.session.get.mockResolvedValue({
        data: { id: 'malformed-parent', directory: 'D:/nowhere', parentID },
        error: undefined,
      });
      const out = partsWith('[completion-gate] status');

      await hooks['command.execute.before'](
        { command: 'gate', sessionID: 'malformed-parent', arguments: 'status' },
        out
      );

      expect(out.parts[0].text).toBe('[completion-gate] status');
    }
  );

  it.each([
    ['empty string', ''],
    ['null', null],
    ['false', false],
  ])(
    'does not register an eagerly created session with malformed parentID (%s)',
    async (_label, parentID) => {
      const hooks = await freshHooks(client);
      await hooks.event({
        event: {
          type: 'session.created',
          properties: { info: { id: 'malformed-parent', directory: 'D:/nowhere', parentID } },
        },
      });

      const chat = partsWith('[completion-gate]');
      await hooks['chat.message']({ sessionID: 'malformed-parent' }, chat);
      expect(chat.parts[0].text).toBe('[completion-gate]');

      const command = partsWith('[completion-gate] status');
      await hooks['command.execute.before'](
        { command: 'gate', sessionID: 'malformed-parent', arguments: 'status' },
        command
      );

      expect(client.session.get).toHaveBeenCalledWith({ path: { id: 'malformed-parent' } });
      expect(command.parts[0].text).toBe('[completion-gate] status');
    }
  );

  it('leaves the command output unchanged when resumed-session lookup fails', async () => {
    const hooks = await freshHooks(client);
    client.session.get.mockRejectedValue(new Error('session lookup failed'));
    const out = partsWith('[completion-gate] status');

    await expect(
      hooks['command.execute.before'](
        { command: 'gate', sessionID: 'resumed', arguments: 'status' },
        out
      )
    ).resolves.toBeUndefined();

    expect(client.session.get).toHaveBeenCalledWith({ path: { id: 'resumed' } });
    expect(out.parts[0].text).toBe('[completion-gate] status');
  });

  it('leaves the command output unchanged for an SDK error envelope', async () => {
    const hooks = await freshHooks(client);
    client.session.get.mockResolvedValue({
      data: undefined,
      error: { message: 'not found' },
    });
    const out = partsWith('[completion-gate] status');

    await expect(
      hooks['command.execute.before'](
        { command: 'gate', sessionID: 'resumed', arguments: 'status' },
        out
      )
    ).resolves.toBeUndefined();

    expect(client.session.get).toHaveBeenCalledWith({ path: { id: 'resumed' } });
    expect(out.parts[0].text).toBe('[completion-gate] status');
  });

  it('still enables the gate and aborts the turn when showToast fails (headless)', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    client.tui.showToast.mockRejectedValueOnce(new Error('no TUI'));
    const out = partsWith('[completion-gate]');

    await expect(
      hooks['command.execute.before']({ command: 'gate', sessionID: 's1', arguments: '' }, out)
    ).rejects.toThrow('Completion gate enabled for this session.');

    expect(out.parts).toHaveLength(0);
    const status = partsWith('[completion-gate] status');
    await hooks['chat.message']({ sessionID: 's1' }, status);
    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: expect.stringContaining('Completion gate: ENABLED') },
    });
  });

  it('slash enable kicks an immediate evaluation without any idle event', async () => {
    const hooks = await freshHooks(client);
    const projectDir = makeTempProject({
      '.opencode/completion-gate.json': JSON.stringify({
        enabled: true,
        assertions: [{ type: 'command', run: 'node -e "process.exit(0)"' }],
      }),
    });
    await registeredSession(hooks, 's1', projectDir);

    await runGateSlash(hooks, 's1', '', '[completion-gate]');

    // No session.status idle was ever fired — the kick alone must drive the
    // gate to a passing success notice.
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    expect(client.session.promptAsync.mock.calls[0][0].body.parts[0].text).toContain(
      'Completion gate passed'
    );
  });

  it('slash enable warns when no config is found and no command is set', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks); // D:/nowhere — no config up the tree

    await runGateSlash(hooks, 's1', '', '[completion-gate]');

    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'error', message: expect.stringContaining('nothing to run') },
    });
  });

  it('sentinel rejection carries the confirmation text', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);

    await expect(
      hooks['command.execute.before'](
        { command: 'gate', sessionID: 's1', arguments: 'off' },
        partsWith('[completion-gate] off')
      )
    ).rejects.toThrow('Completion gate disabled for this session.');
    await expect(
      hooks['command.execute.before'](
        { command: 'gate', sessionID: 's1', arguments: 'status' },
        partsWith('[completion-gate] status')
      )
    ).rejects.toThrow('Completion gate: disabled');
    await expect(
      hooks['command.execute.before'](
        { command: 'gate', sessionID: 's1', arguments: '--only' },
        partsWith('[completion-gate] --only')
      )
    ).rejects.toThrow('Usage: /gate --only "command"');
  });

  it('ignores an already-cleared payload in chat.message without resetting state', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const out = partsWith('[completion-gate]');
    await expect(
      hooks['command.execute.before']({ command: 'gate', sessionID: 's1', arguments: '' }, out)
    ).rejects.toThrow();
    expect(out.parts).toHaveLength(0);

    // Second hook sees the cleared payload: no crash, no extra toast, no rewrite.
    const toastCalls = client.tui.showToast.mock.calls.length;
    await hooks['chat.message']({ sessionID: 's1' }, out);
    expect(out.parts).toHaveLength(0);
    expect(client.tui.showToast.mock.calls.length).toBe(toastCalls);
  });

  it('clears a lone internal directive with no remainder', async () => {
    const hooks = await freshHooks(client);
    await registeredSession(hooks);
    const out = partsWith('[completion-gate-internal] --only node -e "process.exit(0)"');

    await hooks['chat.message']({ sessionID: 's1' }, out);

    expect(out.parts).toHaveLength(0);
  });
});
