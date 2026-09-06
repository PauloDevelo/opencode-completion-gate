import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeTempProject } from './helpers.js';

function cfg(assertions: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ enabled: true, maxRetries: 3, assertions, ...extra });
}

function makeFakeClient() {
  return {
    session: {
      get: vi.fn(),
      promptAsync: vi.fn(async () => ({ info: {}, parts: [] })),
    },
    tui: { showToast: vi.fn(async () => {}) },
  } as unknown;
}

async function setup(files: Record<string, string>) {
  vi.resetModules();
  const dir = makeTempProject({ '.opencode/completion-gate.json': Object.values(files)[0] });
  const mod = await import('../src/core.js');
  const client = makeFakeClient();
  const hooks = await (mod.default as unknown)({ client });
  await hooks.event({
    event: {
      type: 'session.created',
      properties: { info: { id: 's1', directory: dir, parentID: undefined } },
    },
  });
  await hooks['chat.message']({ sessionID: 's1' }, {
    parts: [{ type: 'text', text: '[completion-gate]' }],
  } as unknown);
  return { dir, client, hooks, mod };
}

// Slash /gate aborts the command flow with a sentinel rejection (no LLM
// turn) AFTER arming the gate â€” helpers swallow it and keep going.
async function runGateSlash(hooks: unknown, sessionID: string, args: string, text: string) {
  const out = { parts: [{ type: 'text', text }] } as unknown;
  await hooks['command.execute.before']({ command: 'gate', sessionID, arguments: args }, out).catch(
    () => {}
  );
  return out;
}

async function setupWithSlashCommand(files: Record<string, string>) {
  vi.resetModules();
  const dir = makeTempProject({ '.opencode/completion-gate.json': Object.values(files)[0] });
  const mod = await import('../src/core.js');
  const client = makeFakeClient();
  const hooks = await (mod.default as unknown)({ client });
  await hooks.event({
    event: {
      type: 'session.created',
      properties: { info: { id: 's1', directory: dir, parentID: undefined } },
    },
  });
  await runGateSlash(hooks, 's1', '', '[completion-gate]');
  return { dir, client, hooks, mod };
}

async function setupCommandOnly(files: Record<string, string>) {
  vi.resetModules();
  const dir = makeTempProject(files);
  const mod = await import('../src/core.js');
  const client = makeFakeClient();
  const hooks = await (mod.default as unknown)({ client });
  await hooks.event({
    event: {
      type: 'session.created',
      properties: { info: { id: 's1', directory: dir, parentID: undefined } },
    },
  });
  return { dir, client, hooks, mod };
}

async function setupResumedWithSlashCommand(files: Record<string, string>) {
  vi.resetModules();
  const dir = makeTempProject({ '.opencode/completion-gate.json': Object.values(files)[0] });
  const mod = await import('../src/core.js');
  const client = makeFakeClient();
  client.session.get.mockResolvedValue({
    data: { id: 'resumed', directory: dir, parentID: undefined },
    error: undefined,
  });
  const hooks = await (mod.default as unknown)({ client });
  const out = await runGateSlash(hooks, 'resumed', '', '[completion-gate]');
  return { dir, client, hooks, mod, out };
}

async function fireIdle(hooks: unknown, sessionID = 's1') {
  await hooks.event({
    event: { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } },
  });
}

const OK_CMD = {
  type: 'command',
  name: 'ok',
  run: 'node -e "process.exit(0)"',
  timeoutSeconds: 30,
};
const BAD_CMD = {
  type: 'command',
  name: 'bad',
  run: 'node -e "console.error(\'boom\'); process.exit(1)"',
  timeoutSeconds: 30,
};

describe('turn-end gate flow', () => {
  beforeEach(() => {
    delete process.env.OPENCODE_GATE_DISABLED;
  });
  afterEach(() => {
    delete process.env.OPENCODE_GATE_DISABLED;
  });

  it('injects a retry message with evidence when an assertion fails', async () => {
    const { client, hooks } = await setup({
      c: cfg([{ type: 'command', name: 'bad', run: BAD_CMD.run, timeoutSeconds: 30 }], {
        maxRetries: 3,
      }),
    });
    await fireIdle(hooks);
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    const call = client.session.promptAsync.mock.calls[0][0];
    expect(call.path.id).toBe('s1');
    expect(call.body.parts[0].text).toContain('Completion gate failed');
    expect(call.body.parts[0].text).toContain('bad');
    expect(call.body.parts[0].text).toContain('boom');
    expect(call.body.parts[0].text).toContain('RETRY 1/3');
  });

  it('slash command enables turn-end gating', async () => {
    const { client, hooks } = await setupWithSlashCommand({
      c: cfg([{ type: 'command', name: 'bad', run: BAD_CMD.run, timeoutSeconds: 30 }]),
    });

    await fireIdle(hooks);

    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    expect(client.session.promptAsync.mock.calls[0][0].body.parts[0].text).toContain(
      'Completion gate failed'
    );
  });

  it('runs a registered session command before configured assertions', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'opencode-gate-order-'));
    const marker = join(markerDir, 'order.txt').split('\\').join('/');
    const configured = {
      type: 'command',
      name: 'configured',
      run: `node -e "require('fs').appendFileSync('${marker}','configured')"`,
      timeoutSeconds: 30,
    };
    const { client, hooks } = await setup({ c: cfg([configured]) });
    await runGateSlash(
      hooks,
      's1',
      `node -e "require('fs').appendFileSync('${marker}','session')"`,
      '[completion-gate] custom command'
    );

    await fireIdle(hooks);
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    expect(readFileSync(marker, 'utf8')).toBe('sessionconfigured');
  });

  it('command-only mode runs the session command and skips configured assertions', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'opencode-gate-only-'));
    const marker = join(markerDir, 'order.txt').split('\\').join('/');
    const configured = {
      type: 'command',
      name: 'configured',
      run: `node -e "require('fs').appendFileSync('${marker}','configured')"`,
      timeoutSeconds: 30,
    };
    const { client, hooks } = await setup({ c: cfg([configured]) });
    await runGateSlash(
      hooks,
      's1',
      `--only node -e "require('fs').appendFileSync('${marker}','session')"`,
      '[completion-gate] --only session command'
    );

    await fireIdle(hooks);
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    expect(readFileSync(marker, 'utf8')).toBe('session');
  });

  it('command-only mode executes and reports feedback without a project config', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'opencode-gate-invalid-config-'));
    const marker = join(markerDir, 'session.txt').split('\\').join('/');
    const { client, hooks } = await setupCommandOnly({});
    const command = `node -e "require('fs').writeFileSync('${marker}','ran')"`;

    await runGateSlash(
      hooks,
      's1',
      `--only ${command}`,
      '[completion-gate] --only session command'
    );
    await fireIdle(hooks);

    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    expect(client.session.promptAsync.mock.calls[0][0].body.parts[0].text).toContain(
      'Completion gate passed'
    );
  });

  it('combined mode runs the session command and configured assertions in sequence', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'opencode-gate-combined-'));
    const marker = join(markerDir, 'order.txt').split('\\').join('/');
    const configured = {
      type: 'command',
      name: 'configured',
      run: `node -e "require('fs').appendFileSync('${marker}','configured')"`,
      timeoutSeconds: 30,
    };
    const { client, hooks } = await setup({ c: cfg([configured]) });
    await runGateSlash(
      hooks,
      's1',
      `node -e "require('fs').appendFileSync('${marker}','session')"`,
      '[completion-gate] session command'
    );

    await fireIdle(hooks);
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    expect(readFileSync(marker, 'utf8')).toBe('sessionconfigured');
  });

  it('short-circuits configured assertions when the session command fails', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'opencode-gate-session-command-'));
    const marker = join(markerDir, 'configured.txt').split('\\').join('/');
    const { client, hooks } = await setup({
      c: cfg([
        {
          type: 'command',
          name: 'configured',
          run: `node -e "require('fs').writeFileSync('${marker}','ran')"`,
          timeoutSeconds: 30,
        },
      ]),
    });
    await runGateSlash(
      hooks,
      's1',
      'node -e "console.error(\'session command boom\'); process.exit(1)"',
      '[completion-gate] custom command'
    );

    await fireIdle(hooks);
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    const evidence = client.session.promptAsync.mock.calls[0][0].body.parts[0].text;
    expect(existsSync(marker)).toBe(false);
    expect(evidence).toContain('session-command');
    expect(evidence).toContain('session command boom');
  });

  it('resumed sessions can enable the gate and evaluate retries without session.created', async () => {
    const {
      client,
      hooks,
      out: _out,
    } = await setupResumedWithSlashCommand({
      c: cfg([{ type: 'command', name: 'bad', run: BAD_CMD.run, timeoutSeconds: 30 }]),
    });

    expect(client.session.get).toHaveBeenCalledWith({ path: { id: 'resumed' } });
    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: { variant: 'info', message: 'Completion gate enabled for this session.' },
    });

    await fireIdle(hooks, 'resumed');

    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    const call = client.session.promptAsync.mock.calls[0][0];
    expect(call.path.id).toBe('resumed');
    expect(call.body.parts[0].text).toContain('Completion gate failed');
    expect(call.body.parts[0].text).toContain('boom');
  });

  it('does not resurrect a resumed session deleted while lazy registration is pending', async () => {
    vi.resetModules();
    const dir = makeTempProject({
      '.opencode/completion-gate.json': cfg([
        { type: 'command', name: 'bad', run: BAD_CMD.run, timeoutSeconds: 30 },
      ]),
    });
    const mod = await import('../src/core.js');
    const client = makeFakeClient();
    let resolveLookup!: (value: unknown) => void;
    const lookup = new Promise<unknown>((resolve) => {
      resolveLookup = resolve;
    });
    client.session.get.mockReturnValue(lookup);
    const hooks = await (mod.default as unknown)({ client });
    const out = { parts: [{ type: 'text', text: '[completion-gate]' }] } as unknown;

    const commandPromise = hooks['command.execute.before'](
      { command: 'gate', sessionID: 'resumed-race', arguments: '' },
      out
    );
    await vi.waitFor(() =>
      expect(client.session.get).toHaveBeenCalledWith({ path: { id: 'resumed-race' } })
    );

    await hooks.event({
      event: { type: 'session.deleted', properties: { info: { id: 'resumed-race' } } },
    });
    resolveLookup({
      data: { id: 'resumed-race', directory: dir, parentID: undefined },
      error: undefined,
    });
    await commandPromise;

    // Regression: a lookup that completes after deletion must not rewrite the command or recreate gate state.
    expect(out.parts[0].text).toBe('[completion-gate]');

    await fireIdle(hooks, 'resumed-race');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(client.tui.showToast).not.toHaveBeenCalled();
  });

  it('stays silent when an enabled session is deleted during a failing assertion', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'opencode-gate-delete-'));
    const marker = join(markerDir, 'state.txt').split('\\').join('/');
    const slowBad = {
      type: 'command',
      name: 'slow-bad',
      run: `node -e "const fs=require('fs'); fs.writeFileSync('${marker}','running'); setTimeout(() => { console.error('boom'); fs.writeFileSync('${marker}','finished'); process.exit(1); }, 500)"`,
      timeoutSeconds: 30,
    };
    const { client, hooks } = await setupWithSlashCommand({ c: cfg([slowBad]) });
    client.tui.showToast.mockClear();

    await fireIdle(hooks);
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));

    await hooks.event({
      event: { type: 'session.deleted', properties: { info: { id: 's1' } } },
    });
    await vi.waitFor(() => expect(readFileSync(marker, 'utf8')).toBe('finished'), {
      timeout: 2000,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Regression: deleting an enabled session must cancel an in-flight failure before it can notify.
    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(client.tui.showToast).not.toHaveBeenCalled();
  });

  it('removes deleted sessions before idle gating or later gate commands can use stale state', async () => {
    const { client, hooks } = await setupWithSlashCommand({
      c: cfg([{ type: 'command', name: 'bad', run: BAD_CMD.run, timeoutSeconds: 30 }]),
    });
    client.tui.showToast.mockClear();

    await hooks.event({
      event: { type: 'session.deleted', properties: { info: { id: 's1' } } },
    });

    await fireIdle(hooks);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(client.tui.showToast).not.toHaveBeenCalled();

    client.session.get.mockRejectedValue(new Error('session no longer exists'));
    const out = { parts: [{ type: 'text', text: '[completion-gate] status' }] } as unknown;
    await hooks['command.execute.before'](
      { command: 'gate', sessionID: 's1', arguments: 'status' },
      out
    );

    expect(client.session.get).toHaveBeenCalledWith({ path: { id: 's1' } });
    expect(out.parts[0].text).toBe('[completion-gate] status');
  });

  it('does not gate a fetched resumed session with parentID', async () => {
    vi.resetModules();
    const dir = makeTempProject({
      '.opencode/completion-gate.json': cfg([
        { type: 'command', name: 'bad', run: BAD_CMD.run, timeoutSeconds: 30 },
      ]),
    });
    const mod = await import('../src/core.js');
    const client = makeFakeClient();
    client.session.get.mockResolvedValue({
      data: { id: 'child', directory: dir, parentID: 'root' },
      error: undefined,
    });
    const hooks = await (mod.default as unknown)({ client });
    const out = { parts: [{ type: 'text', text: '[completion-gate]' }] } as unknown;

    await hooks['command.execute.before'](
      { command: 'gate', sessionID: 'child', arguments: '' },
      out
    );
    await fireIdle(hooks, 'child');
    await new Promise((r) => setTimeout(r, 300));

    expect(client.session.get).toHaveBeenCalledWith({ path: { id: 'child' } });
    expect(out.parts[0].text).toBe('[completion-gate]');
    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(client.tui.showToast).not.toHaveBeenCalled();
  });

  it.each([
    ['empty string', ''],
    ['null', null],
    ['false', false],
  ])('does not gate a fetched session with malformed parentID (%s)', async (_label, parentID) => {
    vi.resetModules();
    const dir = makeTempProject({
      '.opencode/completion-gate.json': cfg([
        { type: 'command', name: 'bad', run: BAD_CMD.run, timeoutSeconds: 30 },
      ]),
    });
    const mod = await import('../src/core.js');
    const client = makeFakeClient();
    client.session.get.mockResolvedValue({
      data: { id: 'malformed-parent', directory: dir, parentID },
      error: undefined,
    });
    const hooks = await (mod.default as unknown)({ client });
    const out = { parts: [{ type: 'text', text: '[completion-gate]' }] } as unknown;

    await hooks['command.execute.before'](
      { command: 'gate', sessionID: 'malformed-parent', arguments: '' },
      out
    );
    await fireIdle(hooks, 'malformed-parent');
    await new Promise((r) => setTimeout(r, 300));

    expect(out.parts[0].text).toBe('[completion-gate]');
    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(client.tui.showToast).not.toHaveBeenCalled();
  });

  it('slash command off prevents subsequent turn-end gating', async () => {
    const { client, hooks } = await setupWithSlashCommand({
      c: cfg([{ type: 'command', name: 'bad', run: BAD_CMD.run, timeoutSeconds: 30 }]),
    });
    client.tui.showToast.mockClear();
    client.tui.showToast.mockClear();
    await runGateSlash(hooks, 's1', 'off', '[completion-gate] off');
    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: { variant: 'info', message: 'Completion gate disabled for this session.' },
    });
    client.tui.showToast.mockClear();

    await fireIdle(hooks);
    await new Promise((r) => setTimeout(r, 300));

    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(client.tui.showToast).not.toHaveBeenCalled();
  });

  it('stops injecting after the retry cap and escalates via error toast once', async () => {
    const { client, hooks } = await setup({
      c: cfg([{ type: 'command', name: 'bad', run: BAD_CMD.run, timeoutSeconds: 30 }], {
        maxRetries: 1,
      }),
    });
    client.tui.showToast.mockClear();
    await fireIdle(hooks);
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1)); // retry 1/1

    await fireIdle(hooks); // cap reached â†’ escalate
    await vi.waitFor(() => expect(client.tui.showToast).toHaveBeenCalledTimes(1));
    expect(client.tui.showToast.mock.calls[0][0].body.variant).toBe('error');
    expect(client.tui.showToast.mock.calls[0][0].body.message).toContain('still failing');

    await fireIdle(hooks); // exhausted â†’ nothing more
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
  });

  it('announces success once and stays silent on consecutive passes', async () => {
    const { client, hooks } = await setup({ c: cfg([OK_CMD]) });
    await fireIdle(hooks);
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    expect(client.session.promptAsync.mock.calls[0][0].body.parts[0].text).toContain('passed');

    await fireIdle(hooks); // consecutive pass â†’ silent
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it('does not re-run assertions after a pass until a genuine user message arrives', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'opencode-gate-count-'));
    const marker = join(markerDir, 'runs.txt').split('\\').join('/');
    const COUNT_CMD = {
      type: 'command',
      name: 'count',
      run: `node -e "require('fs').appendFileSync('${marker}','x')"`,
      timeoutSeconds: 30,
    };
    const { client, hooks } = await setup({ c: cfg([COUNT_CMD]) });

    await fireIdle(hooks); // pass #1 â†’ success note
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    // success note wakes the agent; its next idle must NOT re-run the assertions
    await fireIdle(hooks);
    await new Promise((r) => setTimeout(r, 400));
    expect(readFileSync(marker, 'utf8')).toBe('x');
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);

    // a genuine user message restarts validation
    await hooks['chat.message']({ sessionID: 's1' }, {
      parts: [{ type: 'text', text: 'one more change please' }],
    } as unknown);
    await fireIdle(hooks);
    await new Promise((r) => setTimeout(r, 400));
    expect(readFileSync(marker, 'utf8')).toBe('xx');
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2); // fresh success note for the new cycle
  });

  it('short-circuits: failing first assertion prevents later ones from running', async () => {
    const spy = vi.spyOn(console, 'log');
    const { client, hooks } = await setup({
      c: cfg([
        {
          type: 'command',
          name: 'first-bad',
          run: 'node -e "process.exit(1)"',
          timeoutSeconds: 30,
        },
        {
          type: 'command',
          name: 'never-runs',
          run: 'node -e "console.log(\'SHOULD_NOT_RUN\'); process.exit(0)"',
          timeoutSeconds: 30,
        },
      ]),
    });
    await fireIdle(hooks);
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('SHOULD_NOT_RUN'));
    expect(client.session.promptAsync.mock.calls[0][0].body.parts[0].text).toContain('first-bad');
    spy.mockRestore();
  });

  it('kill switch OPENCODE_GATE_DISABLED=1 disables gating entirely', async () => {
    const { client, hooks } = await setup({ c: cfg([BAD_CMD]) });
    client.tui.showToast.mockClear();
    process.env.OPENCODE_GATE_DISABLED = '1';
    await fireIdle(hooks);
    await new Promise((r) => setTimeout(r, 300));
    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(client.tui.showToast).not.toHaveBeenCalled();
  });

  it('unknown assertion types surface as failures (forward-compatible)', async () => {
    // config validator rejects unknown types â†’ gate skips silently; assert no crash & no toast
    const { client, hooks } = await setup({
      c: '{"enabled":true,"maxRetries":3,"assertions":[{"type":"mystery"}]}',
    });
    client.tui.showToast.mockClear();
    await fireIdle(hooks);
    await new Promise((r) => setTimeout(r, 200));
    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(client.tui.showToast).not.toHaveBeenCalled();
  });

  it('genuine user message resets the fix-cycle budget after escalation', async () => {
    const { client, hooks } = await setup({
      c: cfg([{ type: 'command', name: 'bad', run: BAD_CMD.run, timeoutSeconds: 30 }], {
        maxRetries: 1,
      }),
    });
    await fireIdle(hooks); // fail â†’ inject RETRY 1/1
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));

    await fireIdle(hooks); // cap reached â†’ escalate
    await vi.waitFor(() => expect(client.tui.showToast).toHaveBeenCalledTimes(1));

    await hooks['chat.message']({ sessionID: 's1' }, {
      parts: [{ type: 'text', text: 'try a different approach' }],
    } as unknown);

    await fireIdle(hooks); // budget restored â†’ injects again instead of staying escalated
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2));
    expect(client.tui.showToast).toHaveBeenCalledTimes(1); // escalation was cleared, not repeated
    expect(client.session.promptAsync.mock.calls[1][0].body.parts[0].text).toContain('RETRY 1/1');
  });

  it('turning the gate off mid-run stops it before injecting a retry or escalation', async () => {
    const SLOW_BAD = {
      type: 'command',
      name: 'slow-bad',
      run: 'node -e "setTimeout(() => { console.error(\'boom\'); process.exit(1); }, 500)"',
      timeoutSeconds: 30,
    };
    const { client, hooks } = await setup({ c: cfg([SLOW_BAD], { maxRetries: 2 }) });
    client.tui.showToast.mockClear();

    // First cycle completes normally: RETRY 1/2 injected.
    await fireIdle(hooks);
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));

    // Second cycle: disable the gate WHILE the slow assertion is still running.
    await fireIdle(hooks);
    await new Promise((r) => setTimeout(r, 150));
    await hooks['chat.message']({ sessionID: 's1' }, {
      parts: [{ type: 'text', text: '[completion-gate] off' }],
    } as unknown);

    // The command eventually fails â€” but the aborted run must stay silent.
    await new Promise((r) => setTimeout(r, 1200));
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: { variant: 'info', message: 'Completion gate disabled for this session.' },
    });
  });
});
