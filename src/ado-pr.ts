import { existsSync, mkdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  brief,
  describeSdkError,
  execFileOut,
  execShell,
  logDiag,
  truncateTail,
} from './process.js';
import { GateAborted, fail, pass } from './config.js';
import type {
  AdoPrAssertion,
  AdoPrPollOptions,
  AssertionOutcome,
  BuildLogArtifact,
  BuildLogArtifactRunner,
  BuildLogDownloadOptions,
  BuildLogExtractor,
  PolicyEvaluationMinimal,
  ShellFn,
  TerminalBuildFailure,
} from './types.js';

export type PickPrResult =
  | { ok: true; prId: number }
  | { ok: false; reason: 'none' | 'multiple' | 'unparsable'; detail: string };
export type PickPrDetailsResult =
  | { ok: true; prId: number; projectName?: string }
  | { ok: false; reason: 'none' | 'multiple' | 'unparsable'; detail: string };

export function pickActivePrDetails(prListJson: string): PickPrDetailsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(prListJson);
  } catch {
    return { ok: false, reason: 'unparsable', detail: 'az repos pr list returned invalid JSON' };
  }
  if (!Array.isArray(parsed))
    return { ok: false, reason: 'unparsable', detail: 'expected an array of PRs' };
  if (parsed.length === 0)
    return { ok: false, reason: 'none', detail: 'no active PR found for this branch' };
  const ids = parsed
    .map((p: unknown) => {
      if (!p || typeof p !== 'object') return undefined;
      const entry = p as { pullRequestId?: unknown; id?: unknown };
      return typeof entry.pullRequestId === 'number' ? entry.pullRequestId : entry.id;
    })
    .filter((n): n is number => typeof n === 'number');
  if (ids.length !== parsed.length)
    return { ok: false, reason: 'unparsable', detail: 'PR entries missing numeric pullRequestId' };
  if (ids.length > 1)
    return {
      ok: false,
      reason: 'multiple',
      detail: `multiple active PRs for this branch: ${ids.join(', ')}`,
    };
  const projectName = (parsed[0] as { repository?: { project?: { name?: unknown } } }).repository
    ?.project?.name;
  return typeof projectName === 'string' && projectName.trim()
    ? { ok: true, prId: ids[0], projectName }
    : { ok: true, prId: ids[0] };
}

export function pickActivePr(prListJson: string): PickPrResult {
  const result = pickActivePrDetails(prListJson);
  return result.ok ? { ok: true, prId: result.prId } : result;
}

const GREEN_POLICY_STATUSES = new Set(['approved', 'succeeded', 'notapplicable']);
const IN_PROGRESS_POLICY_STATUSES = new Set(['queued', 'running']);
const HUMAN_POLICY_RE = /minimum number of reviewers|required reviewers|comment requirements/i;

export function isHumanReviewPolicy(e: PolicyEvaluationMinimal): boolean {
  return HUMAN_POLICY_RE.test(String(e?.configuration?.type?.displayName ?? ''));
}

function parseBuildId(value: unknown): number | null {
  const id =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function extractTerminalBuildFailures(
  policyListJson: string,
  opts: { ignoreHumanPolicies?: boolean } = {}
): TerminalBuildFailure[] {
  let evals: PolicyEvaluationMinimal[];
  try {
    evals = JSON.parse(policyListJson);
  } catch {
    return [];
  }
  if (!Array.isArray(evals)) return [];
  return evals
    .filter((e) => e?.configuration?.isBlocking === true || e?.configuration?.isRequired === true)
    .filter((e) => String(e?.configuration?.type?.displayName ?? '').toLowerCase() === 'build')
    .filter((e) => !(opts.ignoreHumanPolicies && isHumanReviewPolicy(e)))
    .filter((e) => {
      const status = String(e?.status ?? '').toLowerCase();
      return !GREEN_POLICY_STATUSES.has(status) && !IN_PROGRESS_POLICY_STATUSES.has(status);
    })
    .map((e) => {
      const context = e.context;
      const preview = context?.buildOutputPreview;
      const failure: TerminalBuildFailure = {
        buildId: parseBuildId(context?.buildId),
        status: String(e?.status ?? ''),
        previewErrors: Array.isArray(preview?.errors)
          ? preview.errors
              .map((error) => error?.message)
              .filter(
                (message): message is string => typeof message === 'string' && message.trim() !== ''
              )
          : [],
      };
      if (typeof context?.buildDefinitionName === 'string')
        failure.definitionName = context.buildDefinitionName;
      if (typeof preview?.jobName === 'string') failure.jobName = preview.jobName;
      if (typeof preview?.taskName === 'string') failure.taskName = preview.taskName;
      return failure;
    });
}

function formatBuildPreview(build: TerminalBuildFailure): string {
  const lines = [
    build.definitionName ? `Build definition: ${build.definitionName}` : '',
    `Build policy status: ${build.status}`,
    build.jobName ? `Job: ${build.jobName}` : '',
    build.taskName ? `Task: ${build.taskName}` : '',
  ];
  if (build.previewErrors.length > 0) {
    lines.push('Preview errors:');
    for (const line of truncateTail(build.previewErrors.join('\n'), 20).split('\n'))
      lines.push(line);
  }
  return lines.filter((l) => l.trim() !== '').join('\n');
}

export function requiredPoliciesGreen(
  policyListJson: string,
  opts: { ignoreHumanPolicies?: boolean } = {}
): { green: boolean; retryable: boolean; detail: string } {
  let evals: PolicyEvaluationMinimal[];
  try {
    evals = JSON.parse(policyListJson);
  } catch {
    return {
      green: false,
      retryable: false,
      detail: 'az repos pr policy list returned invalid JSON',
    };
  }
  if (!Array.isArray(evals))
    return { green: false, retryable: false, detail: 'expected an array of policy evaluations' };
  const allRequired = evals.filter(
    (e) => e?.configuration?.isBlocking === true || e?.configuration?.isRequired === true
  );
  if (allRequired.length === 0)
    return { green: false, retryable: false, detail: 'no blocking policies found on this PR' };
  const ignored = opts.ignoreHumanPolicies ? allRequired.filter(isHumanReviewPolicy) : [];
  const required = opts.ignoreHumanPolicies
    ? allRequired.filter((e) => !isHumanReviewPolicy(e))
    : allRequired;
  if (required.length === 0) {
    const names = ignored.map((e) => e.configuration?.type?.displayName ?? 'policy').join(', ');
    return {
      green: true,
      retryable: false,
      detail: `only human-review policies on this PR (${names}) — ignored via ignoreHumanPolicies`,
    };
  }
  const bad = required.filter(
    (e) => !GREEN_POLICY_STATUSES.has(String(e.status ?? '').toLowerCase())
  );
  if (bad.length > 0) {
    const names = bad
      .map((e) => `${e.configuration?.type?.displayName ?? 'policy'}: ${String(e.status ?? '?')}`)
      .join('; ');
    const skipped = ignored.length > 0 ? ` (${ignored.length} human policy(ies) ignored)` : '';
    const hasTerminalAutomatedFailure = bad.some(
      (e) =>
        !isHumanReviewPolicy(e) &&
        !IN_PROGRESS_POLICY_STATUSES.has(String(e.status ?? '').toLowerCase())
    );
    return {
      green: false,
      retryable: !hasTerminalAutomatedFailure,
      detail: `PR policies not green — ${names}${skipped}`,
    };
  }
  const greenDetail = `${required.length} required policy(ies) green`;
  if (ignored.length > 0) {
    const names = ignored.map((e) => e.configuration?.type?.displayName ?? 'policy').join(', ');
    return {
      green: true,
      retryable: false,
      detail: `${greenDetail}, ${ignored.length} human policy(ies) ignored (${names})`,
    };
  }
  return { green: true, retryable: false, detail: greenDetail };
}

const BUILD_LOG_TIMEOUT_MS = 120_000;
const defaultBuildLogExtractor: BuildLogExtractor = async (
  archivePath,
  destination,
  cwd,
  timeoutMs
) => {
  const r = await execFileOut('tar', ['-xf', archivePath, '-C', destination], cwd, timeoutMs);
  if (r.timedOut) throw new Error(`tar timed out extracting ${archivePath}`);
  if (r.code !== 0)
    throw new Error(
      `tar failed (code ${r.code}): ${brief(truncateTail([r.stderr, r.stdout].filter((s) => s.trim()).join('\n'), 20))}`
    );
};

export async function downloadBuildLogs(
  projectName: string,
  buildId: number,
  cwd: string,
  options: BuildLogDownloadOptions = {}
): Promise<BuildLogArtifact> {
  const timeoutMs = options.timeoutMs ?? BUILD_LOG_TIMEOUT_MS;
  const shell = options.shell ?? execShell;
  const extract = options.extract ?? defaultBuildLogExtractor;
  if (options.isAborted?.()) throw new GateAborted();
  const root = options.tempRoot ?? join(tmpdir(), 'opencode');
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    /* best effort */
  }
  let workDir: string;
  try {
    workDir = mkdtempSync(join(root, `completion-gate-logs-${buildId}-`));
  } catch (err: unknown) {
    return {
      buildId,
      error: `could not create artifact directory under ${root}: ${describeSdkError(err)}`,
    };
  }
  const archivePath = join(workDir, `build-${buildId}-logs.zip`);
  const destination = join(workDir, 'extracted');
  logDiag(`build-logs "${projectName}" #${buildId}: downloading to ${archivePath}`);
  try {
    await shell(
      [
        'az',
        'devops',
        'invoke',
        '--detect',
        'true',
        '--area',
        'build',
        '--resource',
        'logs',
        '--route-parameters',
        `project=${projectName}`,
        `buildId=${buildId}`,
        '--api-version',
        '7.1',
        '--http-method',
        'GET',
        '--accept-media-type',
        'application/zip',
        '--out-file',
        archivePath,
      ],
      cwd,
      timeoutMs
    );
  } catch (err: unknown) {
    logDiag(
      `build-logs "${projectName}" #${buildId}: download failed — ${brief(describeSdkError(err))}`
    );
    return { buildId, error: `download failed: ${describeSdkError(err)}` };
  }
  if (!existsSync(archivePath))
    return { buildId, error: 'az devops invoke succeeded but produced no archive file' };
  const result: BuildLogArtifact = { buildId, archivePath };
  if (options.isAborted?.()) throw new GateAborted();
  try {
    mkdirSync(destination, { recursive: true });
    await extract(archivePath, destination, cwd, timeoutMs);
    result.extractedPath = destination;
  } catch (err: unknown) {
    result.error = `extraction failed: ${describeSdkError(err)}`;
  }
  return result;
}

export const defaultBuildLogArtifact: BuildLogArtifactRunner = (
  projectName,
  buildId,
  cwd,
  isAborted
) => downloadBuildLogs(projectName, buildId, cwd, { isAborted });

export async function runAdoPrAssertion(
  a: AdoPrAssertion,
  cwd: string,
  shell: ShellFn,
  opts: AdoPrPollOptions = {}
): Promise<AssertionOutcome> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? (() => Date.now());
  const intervalMs = Math.max(5, a.pollIntervalSeconds) * 1000;
  const deadline = now() + Math.max(1, a.pollTimeoutMinutes) * 60_000;
  let branch: string;
  try {
    branch = (await shell(['git', '-C', cwd, 'branch', '--show-current'], cwd, 10_000)).trim();
  } catch (err: unknown) {
    return fail(a.name, `could not resolve current branch: ${describeSdkError(err)}`);
  }
  if (!branch) return fail(a.name, 'not on a branch (detached HEAD?) — nothing to check a PR for');
  try {
    for (;;) {
      if (opts.isAborted?.()) throw new GateAborted();
      const listJson = await shell(
        [
          'az',
          'repos',
          'pr',
          'list',
          '--source-branch',
          branch,
          '--status',
          'active',
          '--output',
          'json',
        ],
        cwd,
        120_000
      );
      const pr = pickActivePrDetails(listJson);
      if (!pr.ok) {
        if (pr.reason === 'none' && a.skipIfNoPr) return pass(a.name);
        return fail(
          a.name,
          pr.reason === 'none'
            ? `no active PR for branch "${branch}" — open one before finishing`
            : pr.detail
        );
      }
      const policyJson = await shell(
        ['az', 'repos', 'pr', 'policy', 'list', '--id', String(pr.prId), '--output', 'json'],
        cwd,
        120_000
      );
      const g = requiredPoliciesGreen(policyJson, {
        ignoreHumanPolicies: a.ignoreHumanPolicies === true,
      });
      if (g.green) return pass(a.name);
      if (!g.retryable) {
        const artifactEvidence: string[] = [];
        const seenBuildIds = new Set<number>();
        for (const build of extractTerminalBuildFailures(policyJson, {
          ignoreHumanPolicies: a.ignoreHumanPolicies === true,
        })) {
          if (build.buildId !== null) {
            if (seenBuildIds.has(build.buildId)) continue;
            seenBuildIds.add(build.buildId);
          }
          artifactEvidence.push(formatBuildPreview(build));
          if (build.buildId === null) {
            artifactEvidence.push(
              'Build logs unavailable: terminal Build policy has no valid buildId.'
            );
            continue;
          }
          if (!pr.projectName) {
            artifactEvidence.push(
              `Build logs unavailable for build ${build.buildId}: active PR payload has no repository project name.`
            );
            continue;
          }
          if (opts.isAborted?.()) throw new GateAborted();
          try {
            const artifact = await (opts.buildLogArtifact ?? defaultBuildLogArtifact)(
              pr.projectName,
              build.buildId,
              cwd,
              opts.isAborted
            );
            if (artifact.extractedPath)
              artifactEvidence.push(`Build logs extracted directory: ${artifact.extractedPath}`);
            if (artifact.archivePath)
              artifactEvidence.push(`Build logs ZIP: ${artifact.archivePath}`);
            if (artifact.error)
              artifactEvidence.push(`Build log artifact error: ${artifact.error}`);
          } catch (err: unknown) {
            if (err instanceof GateAborted) throw err;
            artifactEvidence.push(`Build log artifact error: ${describeSdkError(err)}`);
          }
        }
        return fail(
          a.name,
          [`PR !${pr.prId} has terminal policy failure — ${g.detail}`, ...artifactEvidence]
            .filter(Boolean)
            .join('\n')
        );
      }
      if (now() + intervalMs >= deadline)
        return fail(
          a.name,
          `PR !${pr.prId} did not reach green within ${a.pollTimeoutMinutes} min — ${g.detail}`
        );
      if (opts.isAborted?.()) throw new GateAborted();
      await sleep(intervalMs);
    }
  } catch (err: unknown) {
    if (err instanceof GateAborted) throw err;
    return fail(a.name, describeSdkError(err));
  }
}
