export interface CommandAssertion {
  type: 'command';
  name: string;
  run: string;
  timeoutSeconds: number;
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
}

export interface PolicyEvaluationMinimal {
  configuration?: { isBlocking?: boolean; isRequired?: boolean; type?: { displayName?: string } };
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
