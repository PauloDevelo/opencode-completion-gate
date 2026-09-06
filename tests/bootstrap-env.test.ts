import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeTempProject } from './helpers.js';

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
  return { hooks: await (mod.default as unknown)({ client }) };
}

function toB64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function fireCreated(hooks: unknown, id: string, directory: string) {
  return hooks.event({
    event: {
      type: 'session.created',
      properties: { info: { id, directory, parentID: undefined } },
    },
  });
}

function fireIdle(hooks: unknown, sessionID: string) {
  return hooks.event({
    event: { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } },
  });
}

describe('out-of-band bootstrap arming (toast-only, no chat)', () => {
  beforeEach(() => {
    delete process.env[B64_ENV];
    delete process.env[PLAIN_ENV];
    delete process.env[MODE_ENV];
  });
  afterEach(() => {
    delete process.env[B64_ENV];
    delete process.env[PLAIN_ENV];
    delete process.env[MODE_ENV];
  });

  it('arms command-only from B64 env on session.created with a toast carrying the command', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const dir = makeTempProject({}); // no project config -> command-only without config
    const command = 'node -e "process.exit(0)"';
    process.env[B64_ENV] = toB64(command);
    process.env[MODE_ENV] = 'command-only';

    await fireCreated(hooks, 'boot1', dir);

    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: { variant: 'info', message: `Completion gate armed (command-only): ${command}` },
    });

    await fireIdle(hooks, 'boot1');
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    expect(client.session.promptAsync.mock.calls[0][0].body.parts[0].text).toContain(
      'Completion gate passed'
    );
    expect(client.session.promptAsync.mock.calls[0][0].body.parts[0].text).toContain(
      'session-command'
    );
  });

  it('consumes the bootstrap once: a second session in the same process stays disabled', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const dir = makeTempProject({});
    process.env[B64_ENV] = toB64('node -e "process.exit(0)"');

    await fireCreated(hooks, 'first', dir);
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(process.env[B64_ENV]).toBeUndefined();

    client.tui.showToast.mockClear();
    await fireCreated(hooks, 'second', dir);
    expect(client.tui.showToast).not.toHaveBeenCalled();

    await fireIdle(hooks, 'second');
    await new Promise((r) => setTimeout(r, 300));
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it('falls back to the plain env var when B64 is absent', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const dir = makeTempProject({});
    const command = 'node -e "process.exit(0)"';
    process.env[PLAIN_ENV] = command;

    await fireCreated(hooks, 'plain1', dir);

    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: { variant: 'info', message: `Completion gate armed (command-only): ${command}` },
    });
    await fireIdle(hooks, 'plain1');
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
  });

  it('ignores invalid B64 and leaves the session disabled', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const dir = makeTempProject({});
    process.env[B64_ENV] = '!!!not-valid-base64!!!';

    await fireCreated(hooks, 'bad-b64', dir);

    expect(client.tui.showToast).not.toHaveBeenCalled();
    await fireIdle(hooks, 'bad-b64');
    await new Promise((r) => setTimeout(r, 300));
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it('combined bootstrap mode runs the session command before configured assertions', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const markerDir = mkdtempSync(join(tmpdir(), 'opencode-gate-bootstrap-combined-'));
    const marker = join(markerDir, 'order.txt').split('\\').join('/');
    const configured = {
      type: 'command',
      name: 'configured',
      run: `node -e "require('fs').appendFileSync('${marker}','configured')"`,
      timeoutSeconds: 30,
    };
    const dir = makeTempProject({
      '.opencode/completion-gate.json': JSON.stringify({
        enabled: true,
        maxRetries: 3,
        assertions: [configured],
      }),
    });
    const sessionCommand = `node -e "require('fs').appendFileSync('${marker}','session')"`;
    process.env[B64_ENV] = toB64(sessionCommand);
    process.env[MODE_ENV] = 'combined';

    await fireCreated(hooks, 'combined1', dir);
    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: { variant: 'info', message: `Completion gate armed (combined): ${sessionCommand}` },
    });

    await fireIdle(hooks, 'combined1');
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    expect(readFileSync(marker, 'utf8')).toBe('sessionconfigured');
  });

  it('bootstrap command-only executes without a project config and reports the marker', async () => {
    const client = makeFakeClient();
    const { hooks } = await freshHooks(client);
    const markerDir = mkdtempSync(join(tmpdir(), 'opencode-gate-bootstrap-only-'));
    const marker = join(markerDir, 'session.txt').split('\\').join('/');
    const dir = makeTempProject({});
    const command = `node -e "require('fs').writeFileSync('${marker}','ran')"`;
    process.env[PLAIN_ENV] = command;

    await fireCreated(hooks, 'only1', dir);
    await fireIdle(hooks, 'only1');

    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    expect(client.session.promptAsync.mock.calls[0][0].body.parts[0].text).toContain(
      'Completion gate passed'
    );
  });
});
