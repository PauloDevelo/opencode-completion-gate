import { describe, expect, it, vi } from 'vitest';
import { parseVerdict, runReviewAssertion } from '../src/core.js';
import type { ReviewAssertion, ReviewSessionClient } from '../src/core.js';

describe('parseVerdict', () => {
  it('finds PASS', () => expect(parseVerdict('blah\nVERDICT: PASS')).toBe('PASS'));
  it('is case-insensitive', () => expect(parseVerdict('verdict: pass')).toBe('PASS'));
  it('takes the LAST occurrence', () =>
    expect(parseVerdict('VERDICT: PASS ... VERDICT: FAIL')).toBe('FAIL'));
  it('null when absent', () => expect(parseVerdict('looks fine to me')).toBeNull());
  it('requires a word boundary', () => expect(parseVerdict('VERDICT: PASSED')).toBeNull());
});

const a: ReviewAssertion = {
  type: 'opencode-review',
  name: 'rev',
  agent: 'reviewer',
  prompt: 'Check it.',
  timeoutSeconds: 60,
};

interface FakeClientOptions {
  createResult?: unknown; // resolved value of session.create
  createThrows?: unknown;
  promptText?: string;
  promptParts?: unknown[];
  promptResult?: unknown;
  promptError?: unknown;
  promptNeverResolves?: boolean;
  abort?: boolean; // whether client.session.abort exists
}

interface PromptRequest {
  path: { id: string };
  body: { agent?: string; parts: Array<{ type: 'text'; text: string }> };
}

function fakeClient(opts: FakeClientOptions = {}) {
  const create = vi.fn(async (_options: unknown) => {
    if (opts.createThrows !== undefined) throw opts.createThrows;
    return opts.createResult ?? { data: { id: 'rev-s1' }, error: undefined };
  });
  const prompt = vi.fn(
    (_o: unknown) =>
      new Promise((resolve, reject) => {
        if (opts.promptError !== undefined) return reject(opts.promptError);
        if (opts.promptNeverResolves) return; // hangs until the assertion times out
        resolve(
          opts.promptResult ?? {
            data: {
              info: {},
              parts: opts.promptParts ?? [{ type: 'text', text: opts.promptText ?? '' }],
            },
            error: undefined,
          }
        );
      })
  );
  const client: ReviewSessionClient & {
    session: { create: typeof create; prompt: typeof prompt };
  } = {
    session: { create, prompt },
  };
  const abort = vi.fn(async () => ({ data: true, error: undefined }));
  if (opts.abort !== false) client.session.abort = abort;
  return { client, create, prompt, abort };
}

function heyApiError(message: string) {
  return { data: undefined, error: { message } };
}

describe('runReviewAssertion (SDK reviewer session)', () => {
  it('passes on VERDICT: PASS, creating the session in the project dir and prompting the configured agent', async () => {
    const f = fakeClient({ promptText: 'analysis...\nVERDICT: PASS' });
    const r = await runReviewAssertion(a, 'C:/proj', f.client);
    expect(r.passed).toBe(true);

    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.create.mock.calls[0][0]).toEqual({ query: { directory: 'C:/proj' } });

    expect(f.prompt).toHaveBeenCalledTimes(1);
    const call = f.prompt.mock.calls[0][0] as PromptRequest;
    expect(call.path).toEqual({ id: 'rev-s1' });
    expect(call.body.agent).toBe('reviewer');
    expect(call.body.parts[0].text).toContain('Check it.');
    expect(call.body.parts[0].text).toContain('VERDICT:');
    expect(f.abort).not.toHaveBeenCalled();
  });

  it('fails on VERDICT: FAIL with reviewer text evidence', async () => {
    const f = fakeClient({ promptText: 'VERDICT: FAIL because reasons' });
    const r = await runReviewAssertion(a, 'C:/proj', f.client);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('because reasons');
  });

  it('joins multiple text parts into one review output', async () => {
    const f = fakeClient({
      promptParts: [
        { type: 'text', text: 'part one' },
        { type: 'step-start' },
        { type: 'text', text: 'part two\nVERDICT: FAIL x' },
      ],
    });
    const r = await runReviewAssertion(a, 'C:/proj', f.client);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('part one');
    expect(r.evidence).toContain('part two');
  });

  it('fails when no verdict line is present', async () => {
    const f = fakeClient({ promptText: 'I reviewed it, LGTM' });
    const r = await runReviewAssertion(a, 'C:/proj', f.client);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('no VERDICT');
  });

  it('maps hey-api error responses to failed outcomes with actionable evidence', async () => {
    const f = fakeClient({ promptResult: heyApiError('agent "reviewer" not found') });
    const r = await runReviewAssertion(a, 'C:/proj', f.client);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('reviewer session failed');
    expect(r.evidence).toContain('reviewer" not found');
  });

  it('fails cleanly when session.prompt rejects (transport error)', async () => {
    const f = fakeClient({ promptError: new Error('socket hang up') });
    const r = await runReviewAssertion(a, 'C:/proj', f.client);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('socket hang up');
  });

  it('fails when session.create fails', async () => {
    const f = fakeClient({
      createResult: heyApiError('unauthorized'),
      promptText: 'never reached',
    });
    const r = await runReviewAssertion(a, 'C:/proj', f.client);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('unauthorized');
    expect(f.prompt).not.toHaveBeenCalled();
  });

  it('fails when create returns no session id', async () => {
    const f = fakeClient({ createResult: {} });
    const r = await runReviewAssertion(a, 'C:/proj', f.client);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('no session id');
  });

  it('times out, aborts the reviewer session and reports the timeout', async () => {
    const f = fakeClient({ promptNeverResolves: true });
    const r = await runReviewAssertion({ ...a, timeoutSeconds: 1 }, 'C:/proj', f.client);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('timed out after 1s');
    expect(r.evidence).toContain('aborted');
    await vi.waitFor(() => expect(f.abort).toHaveBeenCalledWith({ path: { id: 'rev-s1' } }));
  }, 10_000);

  it('survives a missing or failing abort on timeout', async () => {
    const withoutAbort = fakeClient({ promptNeverResolves: true, abort: false });
    const r1 = await runReviewAssertion(
      { ...a, timeoutSeconds: 1 },
      'C:/proj',
      withoutAbort.client
    );
    expect(r1.evidence).toContain('timed out');

    const throwingAbort = fakeClient({ promptNeverResolves: true });
    throwingAbort.abort.mockRejectedValue(new Error('abort failed'));
    const r2 = await runReviewAssertion(
      { ...a, timeoutSeconds: 1 },
      'C:/proj',
      throwingAbort.client
    );
    expect(r2.evidence).toContain('timed out');
  }, 15_000);

  it('accepts plain-payload fakes (no hey-api envelope)', async () => {
    const f = fakeClient({
      createResult: { id: 'plain-1' },
      promptResult: { info: {}, parts: [{ type: 'text', text: 'ok\nVERDICT: PASS' }] },
    });
    const r = await runReviewAssertion(a, 'C:/proj', f.client);
    expect(r.passed).toBe(true);
  });

  it('fail-closed when no client is provided', async () => {
    const r = await runReviewAssertion(a, 'C:/proj', undefined);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('no opencode SDK client');
  });
});
