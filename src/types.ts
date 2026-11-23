export interface CommandAssertion {
  type: 'command';
  name: string;
  run: string;
  timeoutSeconds: number;
}

/**
 * The `run` field of a command assertion may be a single string (the original
 * shape, still valid) or one command per platform. The config layer resolves it
 * to a single string before anything reaches the runner, so `CommandAssertion.run`
 * stays a string at runtime.
 *
 * Both keys are optional so the JSON can be authored incrementally, but a config
 * that does not carry a command for the platform it is being read on is
 * rejected rather than run against the other platform's shell.
 */
export interface PlatformCommand {
  windows?: string;
  linux?: string;
}

export interface AdoPrAssertion {
  type: 'ado-pr';
  name: string;
  pollTimeoutMinutes: number;
  pollIntervalSeconds: number;
  skipIfNoPr: boolean;
  ignoreHumanPolicies?: boolean;
}

export interface ReviewAssertion {
  type: 'opencode-review';
  name: string;
  agent: string;
  prompt?: string;
  timeoutSeconds: number;
}

export type GateAssertion = CommandAssertion | AdoPrAssertion | ReviewAssertion;

export interface GateConfig {
  enabled: boolean;
  maxRetries: number;
  assertions: GateAssertion[];
}

export interface ProcessOutcome {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface AssertionOutcome {
  name: string;
  passed: boolean;
  evidence: string;
}

export type ShellFn = (args: string[], cwd: string, timeoutMs: number) => Promise<string>;

export interface ShellInvocation {
  file: string;
  args: string[];
}

export interface BuildLogArtifact {
  buildId: number;
  archivePath?: string;
  extractedPath?: string;
  error?: string;
}

export type BuildLogExtractor = (
  archivePath: string,
  destination: string,
  cwd: string,
  timeoutMs: number
) => Promise<void>;

export interface BuildLogDownloadOptions {
  tempRoot?: string;
  timeoutMs?: number;
  shell?: ShellFn;
  extract?: BuildLogExtractor;
  isAborted?: () => boolean;
}

export type BuildLogArtifactRunner = (
  projectName: string,
  buildId: number,
  cwd: string,
  isAborted?: () => boolean
) => Promise<BuildLogArtifact>;

export interface AdoPrPollOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  isAborted?: () => boolean;
  buildLogArtifact?: BuildLogArtifactRunner;
  /**
   * Best-effort branch build cross-check used when the PR's required policy set
   * carries no build policy. Returns the raw `az pipelines builds list` JSON.
   * Injected by tests; defaults to the `az` call in `ado-pr.ts`.
   */
  listBranchBuilds?: BranchBuildsRunner;
}

export type BranchBuildsRunner = (
  projectName: string,
  branch: string,
  cwd: string
) => Promise<string>;

export interface PolicyEvaluationMinimal {
  configuration?: {
    isBlocking?: boolean;
    isRequired?: boolean;
    type?: { displayName?: string; id?: string };
    settings?: { displayName?: string; buildDefinitionId?: number };
  };
  status?: string;
  context?: {
    buildId?: number | string | null;
    buildDefinitionName?: string;
    buildOutputPreview?: {
      jobName?: string;
      taskName?: string;
      errors?: Array<{ message?: string | null }>;
    } | null;
  } | null;
}

/** Raw shape of one entry in `az pipelines builds list --output json`. */
export interface BranchBuildMinimal {
  id?: number;
  status?: string;
  result?: string;
  definition?: { id?: number; name?: string };
}

export interface TerminalBuildFailure {
  buildId: number | null;
  status: string;
  definitionName?: string;
  jobName?: string;
  taskName?: string;
  previewErrors: string[];
}

/**
 * V2-shaped reviewer-session client. The concrete implementation is built from
 * the OpenCode V2 plugin `Context` in `gate.ts`; the abstraction stays narrow so
 * `runReviewAssertion` remains unit-testable without a live server.
 */
export interface ReviewSessionClient {
  session: {
    create(input?: { directory?: string }): Promise<{ id?: string }>;
    prompt(input: { sessionID: string; text: string; agent?: string }): Promise<void>;
    /** Concatenated assistant text produced in the session so far. */
    context(input: { sessionID: string }): Promise<string>;
    abort?(input: { sessionID: string }): Promise<void>;
  };
}
