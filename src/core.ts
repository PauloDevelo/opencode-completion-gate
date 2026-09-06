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
  defaultBuildLogArtifact,
  downloadBuildLogs,
  extractTerminalBuildFailures,
  isHumanReviewPolicy,
  pickActivePr,
  pickActivePrDetails,
  requiredPoliciesGreen,
  runAdoPrAssertion,
} from './ado-pr.js';
export { parseVerdict, runReviewAssertion } from './review.js';
export type {
  AdoPrAssertion,
  AdoPrPollOptions,
  AssertionOutcome,
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
export type { PickPrDetailsResult, PickPrResult } from './ado-pr.js';
export type { GateMode } from './config.js';
