import { describeSdkError, logDiag, truncateTail } from './process.js';
import { GateAborted, fail, pass } from './config.js';
import type { AssertionOutcome, ReviewAssertion, ReviewSessionClient } from './types.js';

export function parseVerdict(output: string): 'PASS' | 'FAIL' | null {
  const matches = [...output.matchAll(/VERDICT:\s*\b(PASS|FAIL)\b/gi)];
  const last = matches[matches.length - 1];
  return last ? (last[1].toUpperCase() as 'PASS' | 'FAIL') : null;
}

export async function runReviewAssertion(
  a: ReviewAssertion,
  cwd: string,
  client?: ReviewSessionClient,
  isAborted?: () => boolean
): Promise<AssertionOutcome> {
  if (isAborted?.()) throw new GateAborted();
  if (!client?.session)
    return fail(a.name, 'no opencode plugin context available to run the reviewer session');
  const prompt = [
    a.prompt ?? 'Review the changes on this branch against the task requirements.',
    'Finish your reply with a final line containing exactly "VERDICT: PASS" or "VERDICT: FAIL" followed by a one-line justification.',
  ].join('\n');
  let sessionId: string | undefined;
  try {
    const created = await client.session.create({ directory: cwd });
    sessionId = created?.id;
    if (!sessionId)
      return fail(a.name, 'could not create reviewer session (no session id in response)');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raced = await Promise.race([
        (async () => {
          await client.session.prompt({
            sessionID: sessionId as string,
            text: prompt,
            agent: a.agent,
          });
          const text = await client.session.context({ sessionID: sessionId as string });
          return { ok: true as const, text };
        })().then(
          (r) => r,
          (err: unknown) => ({ ok: false as const, err })
        ),
        new Promise<{ timedOut: true }>((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true }), a.timeoutSeconds * 1000);
        }),
      ]);
      if ('timedOut' in raced) {
        try {
          await Promise.resolve(client.session.abort?.({ sessionID: sessionId as string }));
        } catch {
          /* best effort */
        }
        return fail(
          a.name,
          `review timed out after ${a.timeoutSeconds}s (reviewer session aborted)`
        );
      }
      if (!raced.ok) return fail(a.name, `reviewer session failed: ${describeSdkError(raced.err)}`);
      const text = raced.text;
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
