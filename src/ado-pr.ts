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
  BranchBuildMinimal,
  BranchBuildsRunner,
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

/**
 * Azure DevOps policy-type id of the "Build" policy (captured from a live
 * `az repos pr policy list` payload, see tests/fixtures/). Matching on the id
 * keeps build detection working when the type's display name is localised or
 * differs from the bare "Build" string (e.g. "Build validation").
 */
export const ADO_BUILD_POLICY_TYPE_ID = '0609b952-1397-4640-95ec-e00a01b2c241';
const BUILD_POLICY_DISPLAY_RE = /^\s*build\b|build validation/i;

export function isHumanReviewPolicy(e: PolicyEvaluationMinimal): boolean {
  return HUMAN_POLICY_RE.test(String(e?.configuration?.type?.displayName ?? ''));
}

export function isBuildPolicy(e: PolicyEvaluationMinimal): boolean {
  const typeId = String(e?.configuration?.type?.id ?? '')
    .trim()
    .toLowerCase();
  if (typeId && typeId === ADO_BUILD_POLICY_TYPE_ID) return true;
  return BUILD_POLICY_DISPLAY_RE.test(String(e?.configuration?.type?.displayName ?? ''));
}

/** Human-readable policy label for logs/evidence (type + policy display name). */
function policyLabel(e: PolicyEvaluationMinimal): string {
  const typeName = String(e?.configuration?.type?.displayName ?? '').trim() || 'policy';
  const specific =
    String(e?.configuration?.settings?.displayName ?? '').trim() ||
    String(e?.context?.buildDefinitionName ?? '').trim();
  return specific && specific !== typeName ? `${typeName} (${specific})` : typeName;
}

function describePolicy(e: PolicyEvaluationMinimal): string {
  return `${policyLabel(e)}=${String(e?.status ?? '?')}`;
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
    .filter((e) => isBuildPolicy(e))
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

export interface RequiredPoliciesResult {
  green: boolean;
  retryable: boolean;
  detail: string;
  /** Required policies (after human-policy filtering) that were actually evaluated. */
  evaluated: Array<{ name: string; status: string; build: boolean }>;
  /**
   * `true` when the required set contains no ADO build policy: a PR cannot be
   * called green on policy status alone without build evidence.
   */
  missingBuildPolicy: boolean;
}

export function requiredPoliciesGreen(
  policyListJson: string,
  opts: { ignoreHumanPolicies?: boolean } = {}
): RequiredPoliciesResult {
  const notGreen = (detail: string, evaluated: RequiredPoliciesResult['evaluated'] = []) => ({
    green: false,
    retryable: false,
    detail,
    evaluated,
    missingBuildPolicy: false,
  });
  let evals: PolicyEvaluationMinimal[];
  try {
    evals = JSON.parse(policyListJson);
  } catch {
    return notGreen('az repos pr policy list returned invalid JSON');
  }
  if (!Array.isArray(evals)) return notGreen('expected an array of policy evaluations');
  const allRequired = evals.filter(
    (e) => e?.configuration?.isBlocking === true || e?.configuration?.isRequired === true
  );
  if (allRequired.length === 0) return notGreen('no blocking policies found on this PR');
  const ignored = opts.ignoreHumanPolicies ? allRequired.filter(isHumanReviewPolicy) : [];
  const required = opts.ignoreHumanPolicies
    ? allRequired.filter((e) => !isHumanReviewPolicy(e))
    : allRequired;
  if (required.length === 0) {
    const names = ignored.map(describePolicy).join(', ');
    return {
      green: true,
      retryable: false,
      detail: `only human-review policies on this PR (${names}) — ignored via ignoreHumanPolicies`,
      evaluated: [],
      missingBuildPolicy: false,
    };
  }
  const evaluated = required.map((e) => ({
    name: policyLabel(e),
    status: String(e?.status ?? '?'),
    build: isBuildPolicy(e),
  }));
  const bad = required.filter(
    (e) => !GREEN_POLICY_STATUSES.has(String(e.status ?? '').toLowerCase())
  );
  if (bad.length > 0) {
    const names = bad
      .map((e) => `${e.configuration?.type?.displayName ?? 'policy'}: ${String(e.status ?? '?')}`)
      .join('; ');
    const skipped = ignored.length > 0 ? ` (${ignored.length} human policy(ies) ignored)` : '';
    // A policy that is still queued/running means the PR's policy set is in flux: another
    // rejection can be a stale evaluation left over from the previous build or analysis (e.g. a
    // blocking SonarQube "Status" policy with invalidateOnSourceUpdate=false still showing the
    // previous analysis's rejection while the new CI build runs). Poll until nothing is in
    // progress, then judge terminality on the settled evaluations.
    const stillSettling = bad.some((e) =>
      IN_PROGRESS_POLICY_STATUSES.has(String(e.status ?? '').toLowerCase())
    );
    const onlyHumanRemaining = bad.every(isHumanReviewPolicy);
    return {
      green: false,
      retryable: stillSettling || onlyHumanRemaining,
      detail: `PR policies not green — ${names}${skipped}`,
      evaluated,
      // A red required policy already fails the assertion: the missing-build
      // cross-check is only for the "everything green but no build policy" shape.
      missingBuildPolicy: false,
    };
  }
  const greenDetail = `${required.length} required policy(ies) green: ${evaluated
    .map((p) => `${p.name}=${p.status}`)
    .join('; ')}`;
  if (!evaluated.some((p) => p.build)) {
    // Green policy statuses with no build policy in the required set is exactly the hole
    // behind incident ses_df62aaf7affeWd8Nq01SxfPQuw: the gate reported green while a
    // required build was red. Never pass on that shape — the caller cross-checks the
    // branch builds and only then reports green.
    return {
      green: false,
      retryable: false,
      detail: `${greenDetail} — no build policy was evaluated`,
      evaluated,
      missingBuildPolicy: true,
    };
  }
  if (ignored.length > 0) {
    const names = ignored.map(describePolicy).join(', ');
    return {
      green: true,
      retryable: false,
      detail: `${greenDetail}, ${ignored.length} human policy(ies) ignored (${names})`,
      evaluated,
      missingBuildPolicy: false,
    };
  }
  return {
    green: true,
    retryable: false,
    detail: greenDetail,
    evaluated,
    missingBuildPolicy: false,
  };
}

const BUILD_LOG_TIMEOUT_MS = 120_000;
const BUILD_LIST_TIMEOUT_MS = 120_000;
const FAILED_BUILD_RESULTS = new Set(['failed', 'partiallysucceeded']);
const CANCELED_BUILD_RESULTS = new Set(['canceled', 'cancelled']);
const SUCCEEDED_BUILD_RESULTS = new Set(['succeeded']);
const PENDING_BUILD_STATUSES = new Set(['inprogress', 'notstarted', 'postponed', 'cancelling']);

export interface BranchBuildsEvaluation {
  hasBuilds: boolean;
  green: boolean;
  retryable: boolean;
  detail: string;
}

/**
 * Judge a branch's builds from `az pipelines builds list --output json`, taking the
 * latest build of each definition. Used as the second opinion when a PR's required
 * policy set carries no build policy: policy status alone must never be reported as
 * green without build evidence (incident ses_df62aaf7affeWd8Nq01SxfPQuw).
 */
export function evaluateBranchBuilds(buildsJson: string): BranchBuildsEvaluation {
  const notGreen = (detail: string, retryable = false): BranchBuildsEvaluation => ({
    hasBuilds: false,
    green: false,
    retryable,
    detail,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(buildsJson);
  } catch {
    return notGreen('build cross-check: az pipelines builds list returned invalid JSON');
  }
  if (!Array.isArray(parsed)) return notGreen('build cross-check: expected an array of builds');
  const builds = parsed
    .filter((b): b is BranchBuildMinimal => Boolean(b) && typeof b === 'object')
    .map((b) => ({
      id: typeof b.id === 'number' ? b.id : null,
      name: String(b.definition?.name ?? `build ${b.definition?.id ?? '?'}`),
      status: String(b.status ?? '').toLowerCase(),
      result: String(b.result ?? '').toLowerCase(),
    }));
  if (builds.length === 0)
    return notGreen(
      'build cross-check: no builds found for this branch — cannot confirm a build is green'
    );

  const latestByDefinition = new Map<string, (typeof builds)[number]>();
  for (const build of builds) {
    const current = latestByDefinition.get(build.name);
    if (!current) {
      latestByDefinition.set(build.name, build);
      continue;
    }
    const newer = build.id !== null && current.id !== null ? build.id > current.id : false;
    if (newer) latestByDefinition.set(build.name, build);
  }
  const latest = [...latestByDefinition.values()];
  const label = (b: (typeof builds)[number]): string =>
    `${b.name}=${b.result || b.status || 'unknown'}${b.id !== null ? ` (build #${b.id})` : ''}`;
  const settled = latest.filter((b) => !PENDING_BUILD_STATUSES.has(b.status));

  const failed = settled.filter((b) => FAILED_BUILD_RESULTS.has(b.result));
  if (failed.length > 0)
    return notGreen(
      `build cross-check: failed build(s) on this branch (${failed.map(label).join('; ')})`
    );
  const canceled = settled.filter((b) => CANCELED_BUILD_RESULTS.has(b.result));
  if (canceled.length > 0)
    return notGreen(`build cross-check: build(s) canceled (${canceled.map(label).join('; ')})`);
  const unknown = settled.filter((b) => !SUCCEEDED_BUILD_RESULTS.has(b.result));
  if (unknown.length > 0)
    return notGreen(
      `build cross-check: build(s) in an unrecognised state (${unknown.map(label).join('; ')})`
    );
  const pending = latest.filter((b) => PENDING_BUILD_STATUSES.has(b.status));
  if (pending.length > 0)
    return {
      hasBuilds: true,
      green: false,
      retryable: true,
      detail: `build cross-check: build(s) still in progress (${pending.map(label).join('; ')})`,
    };
  return {
    hasBuilds: true,
    green: true,
    retryable: false,
    detail: `build cross-check: ${latest.length} build(s) green (${latest.map(label).join('; ')})`,
  };
}

function defaultBranchBuildsRunner(shell: ShellFn): BranchBuildsRunner {
  return (projectName, branch, cwd) =>
    shell(
      [
        'az',
        'pipelines',
        'builds',
        'list',
        '--project',
        projectName,
        '--branch',
        branch,
        '--top',
        '20',
        '--output',
        'json',
      ],
      cwd,
      BUILD_LIST_TIMEOUT_MS
    );
}

async function crossCheckBranchBuilds(
  projectName: string | undefined,
  branch: string,
  cwd: string,
  listBranchBuilds: BranchBuildsRunner
): Promise<BranchBuildsEvaluation> {
  if (!projectName)
    return {
      hasBuilds: false,
      green: false,
      retryable: false,
      detail: 'build cross-check unavailable: active PR payload has no repository project name',
    };
  try {
    return evaluateBranchBuilds(await listBranchBuilds(projectName, branch, cwd));
  } catch (err: unknown) {
    if (err instanceof GateAborted) throw err;
    return {
      hasBuilds: false,
      green: false,
      retryable: false,
      detail: `build cross-check unavailable: ${describeSdkError(err)}`,
    };
  }
}

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
  const listBranchBuilds = opts.listBranchBuilds ?? defaultBranchBuildsRunner(shell);
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
      let lastDetail = g.detail;
      if (g.green) {
        // A silent pass is unexplainable after the fact: record which policies were
        // actually evaluated and in what state.
        logDiag(`ado-pr: ${g.detail}`);
        return pass(a.name, g.detail);
      }
      if (g.missingBuildPolicy) {
        // No build policy in the required set: policy status alone is not evidence that a
        // required build is green. Cross-check the branch builds before saying anything.
        if (opts.isAborted?.()) throw new GateAborted();
        const cross = await crossCheckBranchBuilds(pr.projectName, branch, cwd, listBranchBuilds);
        lastDetail = `${g.detail}; ${cross.detail}`;
        if (cross.green) {
          logDiag(`ado-pr: PR !${pr.prId} green via build cross-check — ${lastDetail}`);
          return pass(a.name, `PR !${pr.prId}: ${lastDetail}`);
        }
        if (!cross.retryable)
          return fail(a.name, `PR !${pr.prId} has no required build policy — ${lastDetail}`);
        // Build still running: fall through to the polling deadline.
      } else if (!g.retryable) {
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
          `PR !${pr.prId} did not reach green within ${a.pollTimeoutMinutes} min — ${lastDetail}`
        );
      if (opts.isAborted?.()) throw new GateAborted();
      await sleep(intervalMs);
    }
  } catch (err: unknown) {
    if (err instanceof GateAborted) throw err;
    return fail(a.name, describeSdkError(err));
  }
}
