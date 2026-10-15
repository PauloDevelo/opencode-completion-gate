import type { TestClient } from './helpers.js';
import { describe, expect, it, vi } from 'vitest';
import { makeTempProject, startPlugin } from './helpers.js';

function makeFakeClient(): TestClient {
  return {
    session: {
      get: vi.fn(),
      promptAsync: vi.fn(async () => ({ info: {}, parts: [] })),
      create: vi.fn(async () => ({ id: 'rev1' })),
      switchAgent: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
      context: vi.fn(async () => []),
      abort: vi.fn(async () => {}),
    },
    tui: { showToast: vi.fn(async () => {}) },
  };
}

async function registeredSession(
  hooks: Awaited<ReturnType<typeof startPlugin>>,
  id: string,
  directory: string
) {
  await hooks.event({
    event: {
      type: 'session.created',
      properties: { info: { id, directory, parentID: undefined } },
    },
  });
}

function reviewConfig(): string {
  return JSON.stringify({
    enabled: true,
    maxRetries: 1,
    assertions: [
      { type: 'opencode-review', name: 'self-review', agent: 'reviewer', timeoutSeconds: 30 },
    ],
  });
}

describe('V2 hardening', () => {
  it('disposes the /gate command and prompt-hook registrations on cleanup', async () => {
    const client = makeFakeClient();
    const hooks = await startPlugin(client);
    await hooks.dispose();
    expect(hooks.registrations.commandDispose).toHaveBeenCalled();
    expect(hooks.registrations.hookDispose).toHaveBeenCalled();
  });

  it('accepts a composed /gate token in command arguments', async () => {
    const client = makeFakeClient();
    const hooks = await startPlugin(client);
    await registeredSession(hooks, 's1', 'D:/nowhere');

    await hooks['command.execute.before'](
      { command: 'gate', sessionID: 's1', arguments: '/gate off' },
      { parts: [{ type: 'text', text: '/gate off' }] }
    );

    expect(client.tui.showToast).toHaveBeenLastCalledWith({
      body: { variant: 'info', message: 'Completion gate disabled for this session.' },
    });
  });

  it('does not double-handle a prompt delivered again with the same message id', async () => {
    const client = makeFakeClient();
    const hooks = await startPlugin(client);
    await registeredSession(hooks, 's1', 'D:/nowhere');

    const out = { parts: [{ type: 'text', text: '[completion-gate] status' }] };
    await hooks['chat.message']({ sessionID: 's1', messageID: 'm1' }, out);
    await hooks['chat.message'](
      { sessionID: 's1', messageID: 'm1' },
      { parts: [{ type: 'text', text: '[completion-gate] status' }] }
    );

    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
  });

  it('creates the reviewer session in the configured project directory', async () => {
    const client = makeFakeClient();
    client.session.context!.mockResolvedValue([
      { type: 'assistant', content: [{ type: 'text', text: 'looks good\nVERDICT: PASS' }] },
    ]);
    const dir = makeTempProject({ '.opencode/completion-gate.json': reviewConfig() });
    const hooks = await startPlugin(client);
    await registeredSession(hooks, 's1', dir);

    await hooks['command.execute.before'](
      { command: 'gate', sessionID: 's1', arguments: '' },
      { parts: [{ type: 'text', text: '[completion-gate]' }] }
    );

    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalled());
    const texts = client.session.promptAsync.mock.calls.map((c) => c[0].body.parts[0].text);
    expect(texts.some((t) => t.includes('Completion gate passed'))).toBe(true);
    expect(client.session.create).toHaveBeenCalledWith({
      title: 'completion-gate self-review',
      location: { directory: dir },
    });
  });

  it('fails the review assertion when the configured agent cannot be selected', async () => {
    const client = makeFakeClient();
    client.session.switchAgent!.mockRejectedValue(new Error('agent "reviewer" not found'));
    const dir = makeTempProject({ '.opencode/completion-gate.json': reviewConfig() });
    const hooks = await startPlugin(client);
    await registeredSession(hooks, 's1', dir);

    await hooks['command.execute.before'](
      { command: 'gate', sessionID: 's1', arguments: '' },
      { parts: [{ type: 'text', text: '[completion-gate]' }] }
    );

    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalled());
    const texts = client.session.promptAsync.mock.calls.map((c) => c[0].body.parts[0].text);
    expect(texts.some((t) => t.includes('Completion gate failed'))).toBe(true);
    expect(texts.some((t) => t.includes('reviewer" not found'))).toBe(true);
  });
});
