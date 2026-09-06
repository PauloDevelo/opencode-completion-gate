import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempProject } from './helpers.js';

const RETRY_ENV = 'OPENCODE_GATE_BOOTSTRAP_MAX_RETRIES';
const B64_ENV = 'OPENCODE_GATE_BOOTSTRAP_COMMAND_B64';
const PLAIN_ENV = 'OPENCODE_GATE_BOOTSTRAP_COMMAND';
const MODE_ENV = 'OPENCODE_GATE_BOOTSTRAP_MODE';

function makeFakeClient() {
  return {
    session: {
      get: vi.fn(),
      promptAsync: vi.fn(async () => ({ info: {}, parts: [] })),
    },
    tui: { showToast: vi.fn(async () => {}) },
  } as unknown;
}

async function freshHooks(client: unknown) {
  vi.resetModules();
  const mod = await import('../src/core.js');
  const hooks = await (mod.default as unknown)({ client });
  return { hooks, mod };
}

async function runGateSlash(hooks: unknown, sessionID: string, args: string, text: string) {
  const out = { parts: [{ type: 'text', text }] } as unknown;
  await expect(
    hooks['command.execute.before']({ command: 'gate', sessionID, arguments: args }, out)
  ).rejects.toThrow();
  return out;
}

async function registerSession(hooks: unknown, id: string, directory: string) {
  await hooks.event({
    event: {
      type: 'session.created',
      properties: { info: { id, directory, parentID: undefined } },
    },
  });
}

function lastToast(client: unknown): string {
  return client.tui.showToast.mock.calls.at(-1)[0].body.message as string;
}

describe('--only --retries override (RED)', () => {
  beforeEach(() => {
    delete process.env[RETRY_ENV];
    delete process.env[B64_ENV];
    delete process.env[PLAIN_ENV];
    delete process.env[MODE_ENV];
  });
  afterEach(() => {
    delete process.env[RETRY_ENV];
    delete process.env[B64_ENV];
    delete process.env[PLAIN_ENV];
    delete process.env[MODE_ENV];
  });

  it('parses a trailing --retries flag and reports it in status', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const dir = makeTempProject({});
    await registerSession(hooks, 's1', dir);

    await runGateSlash(
      hooks,
      's1',
      '--only node -e "process.exit(0)" --retries 5',
      '[completion-gate] --only node -e "process.exit(0)" --retries 5'
    );
    await runGateSlash(hooks, 's1', 'status', '[completion-gate] status');
    expect(lastToast(client)).toContain('mode=command-only');
    expect(lastToast(client)).toContain('maxRetries=5');
  });

  it('effective cap uses the session override, not the project config', async () => {
    const client = makeFakeClient();
    const dir = makeTempProject({
      '.opencode/completion-gate.json': JSON.stringify({
        enabled: true,
        maxRetries: 9,
        assertions: [
          { type: 'command', name: 'ok', run: 'node -e "process.exit(0)"', timeoutSeconds: 30 },
        ],
      }),
    });
    const { hooks } = await freshHooks(client);
    await registerSession(hooks, 's1', dir);
    await runGateSlash(
      hooks,
      's1',
      '--only node -e "process.exit(1)" --retries 1',
      '[completion-gate] --only x'
    );
    client.session.promptAsync.mockClear();

    await hooks.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
    });
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    expect(client.session.promptAsync.mock.calls[0][0].body.parts[0].text).toContain('RETRY 1/1');
  });

  it('accepts a leading --retries flag and strips it from the stored command', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const dir = makeTempProject({});
    await registerSession(hooks, 's1', dir);

    await runGateSlash(
      hooks,
      's1',
      '--only --retries 4 node -e "process.exit(0)"',
      '[completion-gate] --only --retries 4 node -e "process.exit(0)"'
    );
    expect(lastToast(client)).toBe(
      'Completion gate armed (command-only): node -e "process.exit(0)" Â· maxRetries=4'
    );
    await runGateSlash(hooks, 's1', 'status', '[completion-gate] status');
    expect(lastToast(client)).toContain('maxRetries=4 (session)');
  });

  it('accepts the --max-retries alias', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const dir = makeTempProject({});
    await registerSession(hooks, 's1', dir);

    await runGateSlash(
      hooks,
      's1',
      '--only node -e "process.exit(0)" --max-retries 6',
      '[completion-gate] --only node -e "process.exit(0)" --max-retries 6'
    );
    await runGateSlash(hooks, 's1', 'status', '[completion-gate] status');
    expect(lastToast(client)).toContain('maxRetries=6 (session)');
  });

  it('accepts equals-form retry flags and uses the override in retry text', async () => {
    const client = makeFakeClient();
    const dir = makeTempProject({});
    const { hooks } = await freshHooks(client);
    await registerSession(hooks, 's1', dir);

    await runGateSlash(
      hooks,
      's1',
      '--only node -e "process.exit(1)" --retries=5',
      '[completion-gate] --only node -e "process.exit(1)" --retries=5'
    );
    client.session.promptAsync.mockClear();
    await hooks.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
    });
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    expect(client.session.promptAsync.mock.calls[0][0].body.parts[0].text).toContain('RETRY 1/5');
  });

  it('rejects invalid retry values and preserves the previous command-only state', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const dir = makeTempProject({});
    await registerSession(hooks, 's1', dir);
    await runGateSlash(
      hooks,
      's1',
      '--only node -e "process.exit(0)" --retries 2',
      '[completion-gate] --only node -e "process.exit(0)" --retries 2'
    );

    for (const bad of [
      '--only node -e "x" --retries abc',
      '--only node -e "x" --retries 0',
      '--only node -e "x" --retries',
    ]) {
      await runGateSlash(hooks, 's1', bad, `[completion-gate] ${bad}`);
      expect(lastToast(client)).toBe('Usage: /gate --only "command" [--retries N]');
    }
    // Previous override survives the rejected updates.
    await runGateSlash(hooks, 's1', 'status', '[completion-gate] status');
    expect(lastToast(client)).toContain('maxRetries=2 (session)');
    expect(lastToast(client)).toContain('mode=command-only');
  });

  it('re-arming --only without a flag clears the override back to config fallback', async () => {
    const client = makeFakeClient();
    const dir = makeTempProject({
      '.opencode/completion-gate.json': JSON.stringify({
        enabled: true,
        maxRetries: 8,
        assertions: [
          { type: 'command', name: 'ok', run: 'node -e "process.exit(0)"', timeoutSeconds: 30 },
        ],
      }),
    });
    const { hooks } = await freshHooks(client);
    await registerSession(hooks, 's1', dir);
    await runGateSlash(
      hooks,
      's1',
      '--only node -e "process.exit(0)" --retries 2',
      '[completion-gate] --only x --retries 2'
    );
    await runGateSlash(
      hooks,
      's1',
      '--only node -e "process.exit(0)"',
      '[completion-gate] --only x'
    );
    await runGateSlash(hooks, 's1', 'status', '[completion-gate] status');
    expect(lastToast(client)).toContain('maxRetries=8 (config)');
  });

  it('/gate off/on preserves the session override', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const dir = makeTempProject({});
    await registerSession(hooks, 's1', dir);
    await runGateSlash(
      hooks,
      's1',
      '--only node -e "process.exit(0)" --retries 5',
      '[completion-gate] --only x --retries 5'
    );
    await runGateSlash(hooks, 's1', 'off', '[completion-gate] off');
    await runGateSlash(hooks, 's1', 'on', '[completion-gate] on');
    await runGateSlash(hooks, 's1', 'status', '[completion-gate] status');
    expect(lastToast(client)).toContain('maxRetries=5 (session)');
  });

  it('combined mode keeps --retries tokens as part of the command', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const dir = makeTempProject({});
    await registerSession(hooks, 's1', dir);

    await runGateSlash(hooks, 's1', 'echo hi --retries 5', '[completion-gate] echo hi --retries 5');
    expect(lastToast(client)).toBe('Completion gate armed (combined): echo hi --retries 5');
    await runGateSlash(hooks, 's1', 'status', '[completion-gate] status');
    expect(lastToast(client)).toContain('mode=combined');
  });

  it('leaves a mid-command --retries sequence inside the stored command', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const dir = makeTempProject({});
    await registerSession(hooks, 's1', dir);

    await runGateSlash(
      hooks,
      's1',
      '--only echo --retries 5 done',
      '[completion-gate] --only echo --retries 5 done'
    );
    expect(lastToast(client)).toBe('Completion gate armed (command-only): echo --retries 5 done');
  });

  it('escalates after the session cap, not the config cap', async () => {
    const client = makeFakeClient();
    const dir = makeTempProject({
      '.opencode/completion-gate.json': JSON.stringify({
        enabled: true,
        maxRetries: 9,
        assertions: [
          { type: 'command', name: 'ok', run: 'node -e "process.exit(0)"', timeoutSeconds: 30 },
        ],
      }),
    });
    const { hooks } = await freshHooks(client);
    await registerSession(hooks, 's1', dir);
    await runGateSlash(
      hooks,
      's1',
      '--only node -e "process.exit(1)" --retries 1',
      '[completion-gate] --only x'
    );
    client.session.promptAsync.mockClear();
    client.tui.showToast.mockClear();

    await hooks.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
    });
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    await hooks.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
    });
    await vi.waitFor(() => expect(client.tui.showToast).toHaveBeenCalled());
    expect(client.tui.showToast.mock.calls[0][0].body.message).toContain('after 1 retries');
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it('legacy internal directive honors --retries', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const dir = makeTempProject({});
    await registerSession(hooks, 's1', dir);

    await hooks['chat.message']({ sessionID: 's1' }, {
      parts: [
        {
          type: 'text',
          text: '[completion-gate-internal] --only node -e "process.exit(0)" --retries 3',
        },
      ],
    } as unknown);
    await runGateSlash(hooks, 's1', 'status', '[completion-gate] status');
    expect(lastToast(client)).toContain('maxRetries=3 (session)');
  });

  it('bootstrap retry env arms command-only with the override', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const dir = makeTempProject({});
    process.env[PLAIN_ENV] = 'node -e "process.exit(0)"';
    process.env[RETRY_ENV] = '7';

    await hooks.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'boot1', directory: dir, parentID: undefined } },
      },
    });
    expect(lastToast(client)).toContain('maxRetries=7');
    expect(process.env[RETRY_ENV]).toBeUndefined();
  });

  it('bootstrap retry env is ignored in combined mode and invalid values fall back', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const dir = makeTempProject({
      '.opencode/completion-gate.json': JSON.stringify({
        enabled: true,
        maxRetries: 3,
        assertions: [
          { type: 'command', name: 'ok', run: 'node -e "process.exit(0)"', timeoutSeconds: 30 },
        ],
      }),
    });
    process.env[PLAIN_ENV] = 'node -e "process.exit(0)"';
    process.env[MODE_ENV] = 'combined';
    process.env[RETRY_ENV] = '11';

    await hooks.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'boot-combined', directory: dir, parentID: undefined } },
      },
    });
    expect(lastToast(client)).not.toContain('maxRetries=');
    expect(process.env[RETRY_ENV]).toBeUndefined();
  });

  it('bootstrap with an invalid retry value still arms with config fallback', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const dir = makeTempProject({});
    process.env[PLAIN_ENV] = 'node -e "process.exit(0)"';
    process.env[RETRY_ENV] = 'nope';

    await hooks.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'boot-invalid', directory: dir, parentID: undefined } },
      },
    });
    expect(lastToast(client)).toBe(
      'Completion gate armed (command-only): node -e "process.exit(0)"'
    );
  });
});

describe('parseOnlyCommand units', () => {
  it('handles leading/trailing flags, aliases, and invalid input', async () => {
    vi.resetModules();
    const mod = await import('../src/core.js');
    expect(mod.parseOnlyCommand(' node -e "x" --retries 5')).toEqual({
      command: 'node -e "x"',
      maxRetries: 5,
      invalidRetry: false,
    });
    expect(mod.parseOnlyCommand(' --retries 5 node -e "x"').maxRetries).toBe(5);
    expect(mod.parseOnlyCommand(' node --max-retries 2').maxRetries).toBe(2);
    expect(mod.parseOnlyCommand('foo').command).toBe('');
    expect(mod.parseOnlyCommand(' node --retries abc').invalidRetry).toBe(true);
    expect(mod.parseOnlyCommand(' node --retries').invalidRetry).toBe(true);
    expect(mod.parseOnlyCommand(' echo --retries 5 done').command).toBe('echo --retries 5 done');
    expect(mod.effectiveMaxRetries({ gateMode: 'command-only', sessionMaxRetries: 4 }, 9)).toEqual({
      value: 4,
      source: 'session',
    });
    expect(
      mod.effectiveMaxRetries({ gateMode: 'command-only', sessionMaxRetries: null }, 9)
    ).toEqual({ value: 9, source: 'config' });
  });
});
