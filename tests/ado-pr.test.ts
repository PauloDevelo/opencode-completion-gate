import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  downloadBuildLogs,
  extractTerminalBuildFailures,
  pickActivePr,
  pickActivePrDetails,
  requiredPoliciesGreen,
  runAdoPrAssertion,
} from '../src/core.js';
import type { BuildLogArtifactRunner, ShellFn } from '../src/core.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

const PR_ONE = JSON.stringify([{ id: 42, title: 'feat' }]);
const PR_MANY = JSON.stringify([{ id: 42 }, { id: 43 }]);
const POL_GREEN = JSON.stringify([
  { configuration: { isRequired: true, type: { displayName: 'Build' } }, status: 'succeeded' },
  { configuration: { isRequired: false }, status: 'rejected' },
]);
const POL_RUNNING = JSON.stringify([
  { configuration: { isRequired: true, type: { displayName: 'Build' } }, status: 'running' },
]);

describe('pickActivePr', () => {
  it('accepts exactly one PR', () => {
    expect(pickActivePr(PR_ONE)).toEqual({ ok: true, prId: 42 });
  });
  it('reports none', () => {
    expect(pickActivePr('[]')).toMatchObject({ ok: false, reason: 'none' });
  });
  it('reports multiple', () => {
    const r = pickActivePr(PR_MANY);
    expect(r).toMatchObject({ ok: false, reason: 'multiple' });
    if (!r.ok && r.reason === 'multiple') expect(r.detail).toContain('42');
  });
  it('reports unparsable', () => {
    expect(pickActivePr('{oops')).toMatchObject({ ok: false, reason: 'unparsable' });
  });
});

describe('pickActivePrDetails', () => {
  it('returns the project name needed by the build logs endpoint', () => {
    const result = pickActivePrDetails(fixture('pr-list-active.json'));
    expect(result).toEqual({
      ok: true,
      prId: 60887,
      projectName: 'Aquadvanced-Energy',
    });
  });

  it('keeps a valid PR usable when the project name is absent', () => {
    expect(pickActivePrDetails(PR_ONE)).toEqual({ ok: true, prId: 42 });
  });
});

describe('extractTerminalBuildFailures', () => {
  it('extracts only the terminal blocking Build policy and its preview context', () => {
    expect(extractTerminalBuildFailures(fixture('pr-policy-real-red.json'))).toEqual([
      {
        buildId: 383110,
        status: 'rejected',
        definitionName: 'AquadvancedEnergy-BackEnd-CI',
        jobName: 'backend_build',
        taskName: 'Build solution AquadvancedEnergy',
        previewErrors: [
          expect.stringContaining('Error CS7036'),
          expect.stringContaining('dotnet.exe'),
          expect.stringContaining('Dotnet command failed'),
        ],
      },
    ]);
  });

  it('accepts a numeric-string build ID and reports missing IDs without throwing', () => {
    const policyJson = JSON.stringify([
      {
        configuration: { isBlocking: true, type: { displayName: 'Build' } },
        status: 'broken',
        context: { buildId: '12345', buildDefinitionName: 'CI' },
      },
      {
        configuration: { isBlocking: true, type: { displayName: 'Build' } },
        status: 'rejected',
        context: { buildDefinitionName: 'CI without ID' },
      },
    ]);

    expect(extractTerminalBuildFailures(policyJson)).toMatchObject([
      { buildId: 12345, definitionName: 'CI' },
      { buildId: null, definitionName: 'CI without ID' },
    ]);
  });

  it('does not extract queued builds or ignored human policies', () => {
    const policyJson = JSON.stringify([
      {
        configuration: { isBlocking: true, type: { displayName: 'Build' } },
        status: 'running',
        context: { buildId: 12345 },
      },
      {
        configuration: { isBlocking: true, type: { displayName: 'Comment requirements' } },
        status: 'rejected',
        context: { buildId: 67890 },
      },
    ]);

    expect(extractTerminalBuildFailures(policyJson, { ignoreHumanPolicies: true })).toEqual([]);
  });
});

describe('downloadBuildLogs', () => {
  function shellThatWritesArchive(): { shell: ShellFn; calls: string[][] } {
    const calls: string[][] = [];
    const shell: ShellFn = async (args) => {
      calls.push(args);
      const archivePath = args[args.indexOf('--out-file') + 1];
      mkdirSync(dirname(archivePath), { recursive: true });
      writeFileSync(archivePath, 'zip bytes');
      return '';
    };
    return { shell, calls };
  }

  it('downloads the ZIP with az devops invoke and extracts it', async () => {
    const tempParent = join(tmpdir(), 'opencode');
    mkdirSync(tempParent, { recursive: true });
    const tempRoot = mkdtempSync(join(tempParent, 'completion-gate-artifact-test-'));
    const { shell, calls } = shellThatWritesArchive();
    const extracted: string[] = [];
    const extract = async (archivePath: string, destination: string) => {
      extracted.push(`${archivePath}|${destination}`);
    };

    const result = await downloadBuildLogs('Aquadvanced-Energy', 383110, 'C:/project', {
      tempRoot,
      shell,
      extract,
    });

    expect(result.error).toBeUndefined();
    expect(result.archivePath).toMatch(/build-383110-logs\.zip$/);
    expect(result.extractedPath).toMatch(/extracted$/);
    expect(extracted).toEqual([`${result.archivePath}|${result.extractedPath}`]);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        'az',
        'devops',
        'invoke',
        '--area',
        'build',
        '--resource',
        'logs',
        '--api-version',
        '7.1',
        '--accept-media-type',
        'application/zip',
      ])
    );
    expect(calls[0]).toContain('project=Aquadvanced-Energy');
    expect(calls[0]).toContain('buildId=383110');
  });

  it('keeps the original failure when downloading fails', async () => {
    const shell: ShellFn = async () => {
      throw new Error('az unavailable');
    };
    const extract = vi.fn(async () => {});
    const result = await downloadBuildLogs('Aquadvanced-Energy', 383110, 'C:/project', {
      shell,
      extract,
    });

    expect(result.archivePath).toBeUndefined();
    expect(result.extractedPath).toBeUndefined();
    expect(result.error).toContain('az unavailable');
    expect(extract).not.toHaveBeenCalled();
  });

  it('retains the ZIP path when extraction fails', async () => {
    const { shell } = shellThatWritesArchive();
    const extract = async () => {
      throw new Error('tar failed');
    };
    const result = await downloadBuildLogs('Aquadvanced-Energy', 383110, 'C:/project', {
      shell,
      extract,
    });

    expect(result.archivePath).toMatch(/build-383110-logs\.zip$/);
    expect(result.extractedPath).toBeUndefined();
    expect(result.error).toContain('tar failed');
  });

  it('reports a missing archive even when az exits zero', async () => {
    const shell: ShellFn = async () => '';
    const result = await downloadBuildLogs('Aquadvanced-Energy', 383110, 'C:/project', {
      tempRoot: mkdtempSync(join(tmpdir(), 'opencode', 'completion-gate-artifact-test-')),
      shell,
      extract: async () => {},
    });

    expect(result.archivePath).toBeUndefined();
    expect(result.extractedPath).toBeUndefined();
    expect(result.error).toContain('no archive file');
  });
});

const PR_WITH_PROJECT = JSON.stringify([
  {
    pullRequestId: 42,
    repository: { project: { name: 'Aquadvanced-Energy' } },
  },
]);

const POL_BUILD_RED_WITH_CONTEXT = JSON.stringify([
  {
    configuration: { isBlocking: true, type: { displayName: 'Build' } },
    status: 'rejected',
    context: {
      buildId: 383110,
      buildDefinitionName: 'AquadvancedEnergy-BackEnd-CI',
      buildOutputPreview: {
        jobName: 'backend_build',
        taskName: 'Build solution AquadvancedEnergy',
        errors: [{ message: 'Error CS7036: missing entityKey' }],
      },
    },
  },
  {
    configuration: { isBlocking: true, type: { displayName: 'Build' } },
    status: 'broken',
    context: { buildId: 383110, buildDefinitionName: 'same build' },
  },
]);

function shellForPrAndPolicy(policyJson: string): ShellFn {
  return async (args) => {
    const key = args.join(' ');
    if (key.includes('branch --show-current')) return 'feat/test\n';
    if (key.includes('repos pr list')) return PR_WITH_PROJECT;
    if (key.includes('repos pr policy')) return policyJson;
    throw new Error(`unexpected shell call: ${key}`);
  };
}

describe('runAdoPrAssertion build-log artifacts', () => {
  const a = {
    type: 'ado-pr' as const,
    name: 'pr-gate',
    pollTimeoutMinutes: 1,
    pollIntervalSeconds: 5,
    skipIfNoPr: false,
  };

  it('downloads one artifact for each distinct failed Build ID and reports extracted logs first', async () => {
    const calls: Array<{ projectName: string; buildId: number }> = [];
    const artifacts: BuildLogArtifactRunner = async (projectName, buildId) => {
      calls.push({ projectName, buildId });
      return {
        buildId,
        extractedPath: 'C:/Temp/opencode/completion-gate-logs-383110-x/extracted',
        archivePath: 'C:/Temp/opencode/completion-gate-logs-383110-x/build-383110-logs.zip',
      };
    };

    const result = await runAdoPrAssertion(
      { ...a, pollTimeoutMinutes: 1 },
      'C:/proj',
      shellForPrAndPolicy(POL_BUILD_RED_WITH_CONTEXT),
      { buildLogArtifact: artifacts }
    );

    expect(result.passed).toBe(false);
    expect(calls).toEqual([{ projectName: 'Aquadvanced-Energy', buildId: 383110 }]);
    expect(result.evidence.indexOf('extracted')).toBeLessThan(
      result.evidence.indexOf('build-383110-logs.zip')
    );
    expect(result.evidence).toContain('backend_build');
    expect(result.evidence).toContain('Build solution AquadvancedEnergy');
    expect(result.evidence).toContain('Error CS7036: missing entityKey');
  });

  it('keeps CI preview evidence when artifact download fails', async () => {
    const result = await runAdoPrAssertion(
      a,
      'C:/proj',
      shellForPrAndPolicy(POL_BUILD_RED_WITH_CONTEXT),
      {
        buildLogArtifact: async () => ({ buildId: 383110, error: 'az unavailable' }),
      }
    );

    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('PR !42');
    expect(result.evidence).toContain('Error CS7036: missing entityKey');
    expect(result.evidence).toContain('az unavailable');
  });

  it('does not download artifacts for a terminal non-Build policy', async () => {
    let downloads = 0;
    const policy = JSON.stringify([
      {
        configuration: { isBlocking: true, type: { displayName: 'Status' } },
        status: 'rejected',
      },
    ]);

    const result = await runAdoPrAssertion(a, 'C:/proj', shellForPrAndPolicy(policy), {
      buildLogArtifact: async () => {
        downloads += 1;
        return { buildId: 1 };
      },
    });

    expect(result.passed).toBe(false);
    expect(downloads).toBe(0);
  });

  it('does not download artifacts while a Build policy is queued', async () => {
    let downloads = 0;
    let clock = 0;
    const policy = JSON.stringify([
      {
        configuration: { isBlocking: true, type: { displayName: 'Build' } },
        status: 'queued',
      },
    ]);

    const result = await runAdoPrAssertion(a, 'C:/proj', shellForPrAndPolicy(policy), {
      now: () => (clock += 60_000),
      sleep: async () => {},
      buildLogArtifact: async () => {
        downloads += 1;
        throw new Error('artifact runner must not run for queued builds');
      },
    });

    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('did not reach green within 1 min');
    expect(downloads).toBe(0);
  });

  it('survives a throwing artifact runner without hiding the CI failure', async () => {
    const result = await runAdoPrAssertion(
      a,
      'C:/proj',
      shellForPrAndPolicy(POL_BUILD_RED_WITH_CONTEXT),
      {
        buildLogArtifact: async () => {
          throw new Error('runner exploded');
        },
      }
    );

    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('PR !42');
    expect(result.evidence).toContain('Build log artifact error');
    expect(result.evidence).toContain('runner exploded');
  });
});

describe('requiredPoliciesGreen', () => {
  it('green when all required policies approved/succeeded', () => {
    expect(requiredPoliciesGreen(POL_GREEN)).toMatchObject({ green: true });
  });
  it('red lists offending policies', () => {
    const r = requiredPoliciesGreen(POL_RUNNING);
    expect(r.green).toBe(false);
    expect(r.detail).toContain('Build: running');
  });
  it('red when zero required policies (misconfigured PR)', () => {
    expect(requiredPoliciesGreen('[]').green).toBe(false);
  });
});

describe('runAdoPrAssertion', () => {
  const a = {
    type: 'ado-pr' as const,
    name: 'pr-gate',
    pollTimeoutMinutes: 1,
    pollIntervalSeconds: 5,
    skipIfNoPr: false,
  };
  const POL_HUMANS_RED = JSON.stringify([
    { configuration: { isBlocking: true, type: { displayName: 'Build' } }, status: 'succeeded' },
    {
      configuration: { isBlocking: true, type: { displayName: 'Comment requirements' } },
      status: 'rejected',
    },
    {
      configuration: { isBlocking: true, type: { displayName: 'Minimum number of reviewers' } },
      status: 'queued',
    },
  ]);

  function fakeShell(script: Record<string, string>): ShellFn {
    return async (args) => {
      const key = args.join(' ');
      for (const [pattern, resp] of Object.entries(script)) {
        if (key.includes(pattern)) return resp;
      }
      if (args[0] === 'git') return 'feat/test\n';
      throw new Error(`unexpected shell call: ${key}`);
    };
  }

  it('passes when PR exists and policies are green', async () => {
    const shell = fakeShell({ 'repos pr list': PR_ONE, 'repos pr policy': POL_GREEN });
    expect(await runAdoPrAssertion(a, 'C:/proj', shell)).toEqual({
      name: 'pr-gate',
      passed: true,
      evidence: '',
    });
  });

  it('fails immediately when no PR and skipIfNoPr=false', async () => {
    const shell = fakeShell({ 'repos pr list': '[]' });
    const r = await runAdoPrAssertion(a, 'C:/proj', shell);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('no active PR');
  });

  it('passes-through when no PR and skipIfNoPr=true', async () => {
    const shell = fakeShell({ 'repos pr list': '[]' });
    const r = await runAdoPrAssertion({ ...a, skipIfNoPr: true }, 'C:/proj', shell);
    expect(r.passed).toBe(true);
  });

  it('fails listing ambiguous PRs', async () => {
    const shell = fakeShell({ 'repos pr list': PR_MANY });
    const r = await runAdoPrAssertion(a, 'C:/proj', shell);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('multiple');
  });

  it('resolves branch first and fails clearly when detached', async () => {
    const calls: string[][] = [];
    const shell: ShellFn = async (args) => {
      calls.push(args);
      throw new Error('HEAD detached');
    };
    const r = await runAdoPrAssertion(a, 'C:/proj', shell);
    expect(calls[0]?.[0]).toBe('git');
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('could not resolve current branch');
  });

  it('resolves after policies turn green on a later poll', async () => {
    const policyResponses = [POL_RUNNING, POL_GREEN];
    let policyCalls = 0;
    const sleeps: number[] = [];
    const shell: ShellFn = async (args) => {
      if (args[0] === 'git') return 'feat/test\n';
      if (args.join(' ').includes('repos pr list')) return PR_ONE;
      if (args.join(' ').includes('repos pr policy'))
        return policyResponses[Math.min(policyCalls++, policyResponses.length - 1)];
      throw new Error(`unexpected shell call: ${args.join(' ')}`);
    };
    const r = await runAdoPrAssertion(a, 'C:/proj', shell, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(r.passed).toBe(true);
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(sleeps[0]).toBe(5000);
  });

  it.each(['rejected', 'broken'])(
    'fails immediately when a blocking policy is %s',
    async (status) => {
      const policyCalls: string[] = [];
      const sleeps: number[] = [];
      const shell: ShellFn = async (args) => {
        const key = args.join(' ');
        if (args[0] === 'git') return 'feat/test\n';
        if (key.includes('repos pr list')) return PR_ONE;
        if (key.includes('repos pr policy')) {
          policyCalls.push(key);
          return JSON.stringify([
            { configuration: { isBlocking: true, type: { displayName: 'Build' } }, status },
          ]);
        }
        throw new Error(`unexpected shell call: ${key}`);
      };

      const r = await runAdoPrAssertion(a, 'C:/proj', shell, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });

      expect(r.passed).toBe(false);
      expect(r.evidence).toContain(`Build: ${status}`);
      expect(policyCalls).toHaveLength(1);
      expect(sleeps).toHaveLength(0);
    }
  );

  it('fails when the polling deadline is exhausted while policies stay red', async () => {
    const shell = fakeShell({ 'repos pr list': PR_ONE, 'repos pr policy': POL_RUNNING });
    let t = 1_000_000;
    const r = await runAdoPrAssertion(a, 'C:/proj', shell, {
      sleep: async () => {},
      now: () => (t += 30_000),
    });
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('!42');
    expect(r.evidence).toContain('within 1 min');
  });

  it('treats NotApplicable as green regardless of case', () => {
    const json = JSON.stringify([
      {
        configuration: { isRequired: true, type: { displayName: 'Build' } },
        status: 'NotApplicable',
      },
    ]);
    expect(requiredPoliciesGreen(json)).toMatchObject({ green: true });
  });

  it('fails when the policy list is invalid JSON', async () => {
    const shell = fakeShell({ 'repos pr list': PR_ONE, 'repos pr policy': '{oops' });
    let t = 0;
    const r = await runAdoPrAssertion(a, 'C:/proj', shell, { now: () => (t += 60_000) });
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('invalid JSON');
  });

  it('passes while only human-review policies are pending when ignoreHumanPolicies=true', async () => {
    const shell = fakeShell({ 'repos pr list': PR_ONE, 'repos pr policy': POL_HUMANS_RED });
    const r = await runAdoPrAssertion({ ...a, ignoreHumanPolicies: true }, 'C:/proj', shell);
    expect(r.passed).toBe(true);
  });

  it('keeps waiting on human-review policies by default', async () => {
    let policyCalls = 0;
    const shell: ShellFn = async (args) => {
      const key = args.join(' ');
      if (args[0] === 'git') return 'feat/test\n';
      if (key.includes('repos pr list')) return PR_ONE;
      if (key.includes('repos pr policy')) {
        policyCalls += 1;
        return POL_HUMANS_RED;
      }
      throw new Error(`unexpected shell call: ${key}`);
    };
    let t = 0;
    const r = await runAdoPrAssertion(a, 'C:/proj', shell, {
      sleep: async () => {},
      now: () => (t += 30_000),
    });
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('Comment requirements');
    expect(policyCalls).toBeGreaterThan(1);
  });
});

describe('requiredPoliciesGreen ignoreHumanPolicies', () => {
  const POL_HUMANS_RED = JSON.stringify([
    { configuration: { isBlocking: true, type: { displayName: 'Build' } }, status: 'succeeded' },
    {
      configuration: { isBlocking: true, type: { displayName: 'Comment requirements' } },
      status: 'rejected',
    },
    {
      configuration: { isBlocking: true, type: { displayName: 'Minimum number of reviewers' } },
      status: 'queued',
    },
  ]);

  it('still blocks on human-review policies without the flag', () => {
    const r = requiredPoliciesGreen(POL_HUMANS_RED);
    expect(r.green).toBe(false);
    expect(r.detail).toContain('Comment requirements');
  });

  it('skips human-review policies when the flag is on and Build is green', () => {
    const r = requiredPoliciesGreen(POL_HUMANS_RED, { ignoreHumanPolicies: true });
    expect(r.green).toBe(true);
    expect(r.detail).toContain('2 human policy(ies) ignored');
  });

  it('still fails on automated policies when the flag is on', () => {
    const json = JSON.stringify([
      { configuration: { isBlocking: true, type: { displayName: 'Build' } }, status: 'rejected' },
      {
        configuration: { isBlocking: true, type: { displayName: 'Required reviewers' } },
        status: 'queued',
      },
    ]);
    const r = requiredPoliciesGreen(json, { ignoreHumanPolicies: true });
    expect(r.green).toBe(false);
    expect(r.detail).toContain('Build: rejected');
  });

  it('goes green when ONLY human policies remain and they are ignored', () => {
    const json = JSON.stringify([
      {
        configuration: { isBlocking: true, type: { displayName: 'Comment requirements' } },
        status: 'rejected',
      },
      {
        configuration: { isBlocking: true, type: { displayName: 'Minimum number of reviewers' } },
        status: 'queued',
      },
    ]);
    const r = requiredPoliciesGreen(json, { ignoreHumanPolicies: true });
    expect(r.green).toBe(true);
  });

  it('flag off keeps zero-blocking-policies failure unchanged', () => {
    expect(requiredPoliciesGreen('[]').green).toBe(false);
    expect(requiredPoliciesGreen('[]', { ignoreHumanPolicies: true }).green).toBe(false);
  });
});

describe('real az output shapes (live-captured fixtures)', () => {
  // Fixtures sanitized from a real capture on suezsmartsolutions/Aquadvanced-Energy:
  // `az repos pr list --status active --output json` (!60887) and
  // `az repos pr policy list --id 60887 --output json` (Build policy isBlocking=true,
  // status=rejected; non-blocking "Required reviewers" policy). The green variant is
  // derived from the same payload with each status replaced by "succeeded".
  it('pickActivePr accepts a real single-PR list via pullRequestId', () => {
    expect(pickActivePr(fixture('pr-list-active.json'))).toEqual({ ok: true, prId: 60887 });
  });

  it('pickActivePr handles a real empty list', () => {
    expect(pickActivePr(fixture('pr-list-empty.json'))).toMatchObject({
      ok: false,
      reason: 'none',
    });
  });

  it('requiredPoliciesGreen is red on the real rejected blocking Build policy', () => {
    const r = requiredPoliciesGreen(fixture('pr-policy-real-red.json'));
    expect(r.green).toBe(false);
    expect(r.detail).toContain('Build: rejected');
  });

  it('ignores the non-blocking Required reviewers policy present in the real payload', () => {
    const evals: any[] = JSON.parse(fixture('pr-policy-real-red.json'));
    const onlyNonBlocking = JSON.stringify(
      evals.filter((e) => e.configuration?.isBlocking !== true)
    );
    const r = requiredPoliciesGreen(onlyNonBlocking);
    expect(r.green).toBe(false);
    expect(r.detail).toContain('no blocking policies');
  });

  it('requiredPoliciesGreen goes green over the derived-real green payload', () => {
    const r = requiredPoliciesGreen(fixture('pr-policy-real-green-derived.json'));
    expect(r.green).toBe(true);
    expect(r.detail).toContain('6 required policy(ies) green');
  });
});
