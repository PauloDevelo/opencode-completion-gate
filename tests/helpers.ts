import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { vi } from 'vitest';
import type { Mock } from 'vitest';

export interface TestOutput {
  parts: Array<{ type: string; text?: string }>;
  noReply?: boolean;
}
export interface TestClient {
  session: {
    get: Mock;
    promptAsync: Mock;
    create?: Mock;
    prompt?: Mock;
    abort?: Mock;
    switchAgent?: Mock;
    wait?: Mock;
    context?: Mock;
  };
  tui: { showToast: Mock };
}
export interface TestHooks {
  event(input: { event: Record<string, unknown> }): Promise<void>;
  'chat.message'(
    input: { sessionID: string; agent?: string; messageID?: string },
    output: TestOutput
  ): Promise<void>;
  'command.execute.before'(
    input: { command: string; sessionID: string; arguments: string },
    output: TestOutput
  ): Promise<void>;
  /** Run the plugin's setup cleanup (disposes registrations + subscription). */
  dispose(): Promise<void>;
  /** Registration-disposal spies, for asserting cleanup behavior. */
  registrations: { commandDispose: Mock; hookDispose: Mock };
}

// ---------------------------------------------------------------------------
// V2 test harness
//
// The production plugin targets the OpenCode V2 API (`Plugin.define` + a
// `ctx` with event/command/session domains). Tests still drive it through a
// V1-shaped surface (`hooks.event`, `hooks['command.execute.before']`,
// `hooks['chat.message']`) and assert on a V1-shaped client
// (`session.promptAsync`, `tui.showToast`). `startPlugin` bridges the two: it
// builds a V2 `ctx` whose domains translate to the supplied test client, so a
// test's assertions keep reading the calls it expects.
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

function toV2Event(event: AnyRecord): { type: string; data: AnyRecord } {
  const properties = (event.properties ?? {}) as AnyRecord;
  const type = String(event.type ?? '');
  if (type === 'session.created') {
    const info = (properties.info ?? {}) as {
      id?: unknown;
      directory?: unknown;
      parentID?: unknown;
    };
    return {
      type,
      data: {
        sessionID: info.id,
        parentID: info.parentID,
        location: { directory: info.directory },
      },
    };
  }
  if (type === 'session.deleted') {
    const info = (properties.info ?? {}) as { id?: unknown };
    return { type, data: { sessionID: info.id } };
  }
  if (type === 'session.status') {
    const status = (properties.status ?? {}) as { type?: unknown };
    if (status.type === 'idle')
      return { type: 'session.idle', data: { sessionID: properties.sessionID } };
    return { type, data: { sessionID: properties.sessionID } };
  }
  return { type, data: properties };
}

/** Load a fresh plugin module and wire it to a V2 `ctx` backed by `client`. */
export async function startPlugin(client: TestClient): Promise<TestHooks> {
  const mod = await import('../src/core.js');
  // The plugin keeps its mutable runtime on globalThis (shared across the
  // per-location instances OpenCode loads). Reset it so tests stay isolated
  // despite `vi.resetModules()` not clearing globalThis.
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('opencode.completion-gate.runtime.v2')];
  const registrations: {
    command?: { execute: (input: unknown) => Promise<void> };
    commandDispose: Mock;
    hookDispose: Mock;
  } = { commandDispose: vi.fn(async () => {}), hookDispose: vi.fn(async () => {}) };

  // Event stream: an async iterable fed by the harness.
  const queue: AnyRecord[] = [];
  let pending: ((r: { value: unknown; done: boolean }) => void) | null = null;
  let closed = false;
  const push = (event: AnyRecord) => {
    if (closed) return;
    if (pending) {
      const p = pending;
      pending = null;
      p({ value: event, done: false });
    } else queue.push(event);
  };
  const close = () => {
    closed = true;
    if (pending) {
      const p = pending;
      pending = null;
      p({ value: undefined, done: true });
    }
  };
  const subscribe = (opts?: { signal?: AbortSignal }) => {
    opts?.signal?.addEventListener('abort', close);
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          queue.length
            ? Promise.resolve({ value: queue.shift(), done: false })
            : closed
              ? Promise.resolve({ value: undefined, done: true })
              : new Promise((resolve) => {
                  pending = resolve;
                }),
        return: () => {
          close();
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };
  };

  const session = {
    get: async ({ sessionID }: { sessionID: string }) => {
      const res = (await client.session.get({ path: { id: sessionID } })) as AnyRecord | null;
      const info =
        res && typeof res === 'object' && 'data' in res ? (res.data as AnyRecord | undefined) : res;
      if (info == null) throw new Error('session lookup returned no data');
      return {
        id: info.id,
        parentID: info.parentID,
        location: { directory: info.directory },
      };
    },
    prompt: async ({ sessionID, text }: { sessionID: string; text: string }) =>
      client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: 'text', text }] },
      }),
    synthetic: async ({ text }: { sessionID: string; text: string }) =>
      client.tui.showToast({ body: { variant: 'info', message: text } }),
    create: client.session.create ?? (async () => ({ id: 'review-1' })),
    switchAgent: client.session.switchAgent ?? (async () => {}),
    wait: client.session.wait ?? (async () => {}),
    context: client.session.context ?? (async () => []),
    interrupt: client.session.abort ?? (async () => {}),
    hook: async (_name: string, cb: unknown) => {
      promptHook = cb as (event: unknown) => Promise<void>;
      return { dispose: registrations.hookDispose };
    },
  };

  let promptHook: ((event: unknown) => Promise<void>) | undefined;

  const ctx = {
    app: { version: '2.0.29' },
    location: { directory: process.cwd(), project: { id: 'test' } },
    options: {},
    event: { subscribe },
    session,
    command: {
      list: async () => [],
      reload: async () => {},
      transform: async (cb: (editor: { add: (def: unknown) => void }) => void) => {
        cb({
          add: (def) => (registrations.command = def as { execute: (i: unknown) => Promise<void> }),
        });
        return { dispose: registrations.commandDispose };
      },
    },
  };

  const cleanup = await (mod.default as { setup: (ctx: unknown) => Promise<unknown> }).setup(ctx);

  const settle = () => new Promise((r) => setTimeout(r, 0));

  return {
    event: async ({ event }) => {
      push(toV2Event(event));
      await settle();
    },
    'command.execute.before': async ({ command, sessionID, arguments: args }, output) => {
      if (command !== 'gate') return; // non-gate commands are not ours — leave untouched
      if (registrations.command) {
        await registrations.command.execute({
          sessionID,
          prompt: { text: args },
          delivery: 'steer',
        });
      }
      await settle();
      void output; // V2 command execution never mutates the hook output
    },
    'chat.message': async ({ sessionID, messageID }, output) => {
      if (!Array.isArray(output?.parts) || output.parts.length === 0) return;
      const textPart = output.parts.find((p) => p?.type === 'text');
      if (!textPart || !promptHook) return;
      const draft = {
        sessionID,
        messageID,
        prompt: { text: textPart.text ?? '' },
        metadata: {},
        delivery: 'steer',
      };
      await promptHook(draft);
      if (draft.prompt.text) textPart.text = draft.prompt.text;
      else output.parts.length = 0;
    },
    dispose: async () => {
      if (typeof cleanup === 'function') await cleanup();
    },
    registrations,
  };
}

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
