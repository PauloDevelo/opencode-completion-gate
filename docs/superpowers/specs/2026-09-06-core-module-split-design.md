# Core Module Split Design

## Goal

Split the 1,751-line `src/core.ts` into focused modules that are easier for a
human to read and maintain, without changing runtime behavior, public exports,
or package import paths.

## Scope

- Preserve every current named export from `src/core.ts` and `opencode-completion-gate/utils`.
- Keep `src/plugin.ts` default-export-only for OpenCode's legacy loader.
- Keep `src/index.ts` re-exporting `./core.js`.
- Replace the monolithic implementation with focused modules for shared types,
  configuration, process/shell execution, Azure DevOps assertions, reviewer
  assertions, and plugin/session orchestration.
- Keep tests importing from `../src/core.js` unless a focused internal import is
  required for a test boundary.
- Make no functional changes to gate behavior, error semantics, shell safety,
  retry handling, or public TypeScript contracts.

## Module Boundaries

### `src/types.ts`

Contains shared public interfaces and internal structural types used by multiple
modules, including assertion/config types, process outcomes, session state,
shell seams, assertion outcomes, and SDK client seams.

### `src/config.ts`

Owns config-file discovery/loading and all pure gate configuration/session
parsing: validation, positive integer defaults, `/gate --only` parsing, retry
cap calculation, session metadata validation, and bootstrap command parsing.

### `src/process.ts`

Owns diagnostics and process primitives: text/error formatting, tail
truncation, `runCommand`, `execFileOut`, Windows shell invocation, quoting,
and the production `execShell` implementation.

### `src/ado-pr.ts`

Owns Azure DevOps integration: active PR selection, policy status evaluation,
terminal build failure extraction, build-log downloading/extraction, and ADO
policy polling.

### `src/review.ts`

Owns isolated OpenCode reviewer sessions, reviewer response parsing, verdict
parsing, and the `opencode-review` assertion.

### `src/gate.ts`

Owns mutable session registries, `/gate` toggle handling, assertion
orchestration, turn-end retry/success/escalation flow, and OpenCode event/chat
hooks. It is the only module that owns plugin state and registers hooks.

### `src/core.ts`

Becomes a compatibility facade. It re-exports the complete existing public
named surface and default-exports the plugin from `gate.ts`. No consumer should
need to change imports.

## Dependency Direction

```text
types
  ^
  |
process <- config <- gate
   ^       ^       |
   |       |       +--> ado-pr
   |       +----------> review
   +-------------------+

core -> gate and re-exports public symbols
plugin -> core (default export only)
index -> core (utils subpath)
```

`ado-pr.ts` and `review.ts` may use shared process helpers and types, but they
must not import the plugin or session registry. `gate.ts` coordinates them and
retains all mutable state.

## Compatibility and Error Semantics

- Existing `src/core.ts` named imports remain valid.
- `opencode-completion-gate/utils` continues to expose the same named exports.
- `ReviewSessionClient` remains the existing minimal public structural interface;
  internal SDK-derived types must not replace it publicly.
- Config, process, Azure DevOps, reviewer, and session metadata validation keeps
  its current all-or-nothing and malformed-input behavior.
- Timeouts, exit codes, Windows quoting, process termination, and diagnostic
  messages retain their current behavior.
- `GateAborted` remains silent and stops evaluations at existing checkpoints.
- Toast and prompt failures remain best-effort.

## Verification

- Run `npm run lint` with zero errors and warnings.
- Run `npm run build` and verify bundles plus declarations compile.
- Run `npm test` and `npm run test:coverage` with all existing tests passing.
- Confirm configured coverage thresholds remain satisfied.
- Confirm tests and package utility imports still resolve through `src/core.ts`
  and `src/index.ts` without import-path changes.
- Inspect the final diff for accidental behavior, string, export, or generated
  artifact changes.
