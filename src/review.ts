import { describeSdkError, logDiag, truncateTail } from './process.js';
import { GateAborted, fail, pass } from './config.js';
import type { AssertionOutcome, ReviewAssertion, ReviewSessionClient } from './types.js';

export function parseVerdict(output: string): 'PASS' | 'FAIL' | null {
  const matches = [...output.matchAll(/VERDICT:\s*\b(PASS|FAIL)\b/gi)];
  const last = matches[matches.length - 1];
  return last ? (last[1].toUpperCase() as 'PASS' | 'FAIL') : null;
}

function unwrapSdk<T>(res: unknown): T {
  if (res && typeof res === 'object' && ('data' in res || 'error' in res)) {
    const r = res as { data?: T; error?: unknown };
    if (r.error != null)
      throw new Error(
        typeof r.error === 'string'
          ? r.error
          : r.error && typeof r.error === 'object' && 'message' in r.error
            ? String(r.error.message)
            : JSON.stringify(r.error)
      );
    return r.data as T;
  }
  return res as T;
}

function reviewerText(res: unknown): string {
  const parts = (res as { parts?: unknown })?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(
      (p: unknown): p is { type: 'text'; text?: unknown } =>
        !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text'
    )
    .map((p) => String(p.text ?? ''))
    .join('\n');
}

export async function runReviewAssertion(
  a: ReviewAssertion,
  cwd: string,
  client?: ReviewSessionClient,
  isAborted?: () => boolean
): Promise<AssertionOutcome> {
  if (isAborted?.()) throw new GateAborted();
  if (!client?.session)
    return fail(a.name, 'no opencode SDK client available to run the reviewer session');
  const prompt = [
    a.prompt ?? 'Review the changes on this branch against the task requirements.',
    'Finish your reply with a final line containing exactly "VERDICT: PASS" or "VERDICT: FAIL" followed by a one-line justification.',
  ].join('\n');
  try {
    const created = unwrapSdk<{ id?: string }>(
      await client.session.create({ query: { directory: cwd } })
    );
    const sessionId = created?.id;
    if (!sessionId)
      return fail(a.name, 'could not create reviewer session (no session id in response)');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raced = await Promise.race([
        client.session
          .prompt({
            path: { id: sessionId },
            body: { agent: a.agent, parts: [{ type: 'text', text: prompt }] },
          })
          .then(
            (r: unknown) => ({ ok: true as const, r }),
            (err: unknown) => ({ ok: false as const, err })
          ),
        new Promise<{ timedOut: true }>((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true }), a.timeoutSeconds * 1000);
        }),
      ]);
      if ('timedOut' in raced) {
        try {
          await Promise.resolve(client.session.abort?.({ path: { id: sessionId } }));
        } catch {
          /* best effort */
        }
        return fail(
          a.name,
          `review timed out after ${a.timeoutSeconds}s (reviewer session aborted)`
        );
      }
      if (!raced.ok) return fail(a.name, `reviewer session failed: ${describeSdkError(raced.err)}`);
      const text = reviewerText(unwrapSdk(raced.r));
      const verdict = parseVerdict(text);
      logDiag(`review "${a.name}": verdict=${verdict ?? 'none'}`);
      const evidence = truncateTail(text);
      if (verdict === 'PASS') return pass(a.name);
      if (verdict === 'FAIL') return fail(a.name, `reviewer rejected:\n${evidence}`);
      return fail(a.name, `reviewer produced no VERDICT line:\n${evidence}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    return fail(a.name, `reviewer session failed: ${describeSdkError(err)}`);
  }
}
