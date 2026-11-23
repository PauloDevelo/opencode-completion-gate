/**
 * Compatibility facade for the programmatic utilities entry point.
 *
 * The plugin implementation lives in ./gate. Keep this module's public API
 * stable for existing imports from the package's ./utils subpath.
 */

export { default } from './gate.js';
export { evaluateAssertions, runCommandAssertion } from './gate.js';

export {
  buildShellInvocation,
  execFileOut,
  execShell,
  quoteWin,
  runCommand,
  truncateTail,
} from './process.js';
export {
  findGateConfigPath,
  loadGateConfig,
  parseOnlyCommand,
  effectiveMaxRetries,
} from './config.js';
export {
  ADO_BUILD_POLICY_TYPE_ID,
  defaultBuildLogArtifact,
  downloadBuildLogs,
  evaluateBranchBuilds,
  extractTerminalBuildFailures,
  isBuildPolicy,
  isHumanReviewPolicy,
  pickActivePr,
  pickActivePrDetails,
  requiredPoliciesGreen,
  runAdoPrAssertion,
} from './ado-pr.js';
export { parseVerdict, runReviewAssertion } from './review.js';
export { RUN_RECORD_DIR_ENV, buildRunRecord, runRecordDir, writeRunRecord } from './run-record.js';
export type { RunRecord, RunRecordAssertion, RunRecordInput } from './run-record.js';
export type {
  AdoPrAssertion,
  AdoPrPollOptions,
  AssertionOutcome,
  BranchBuildMinimal,
  BranchBuildsRunner,
  BuildLogArtifact,
  BuildLogArtifactRunner,
  BuildLogDownloadOptions,
  BuildLogExtractor,
  CommandAssertion,
  GateAssertion,
  GateConfig,
  PolicyEvaluationMinimal,
  ProcessOutcome,
  ReviewAssertion,
  ReviewSessionClient,
  ShellFn,
  ShellInvocation,
  TerminalBuildFailure,
} from './types.js';
export type {
  BranchBuildsEvaluation,
  PickPrDetailsResult,
  PickPrResult,
  RequiredPoliciesResult,
} from './ado-pr.js';
export type { GateMode } from './config.js';
