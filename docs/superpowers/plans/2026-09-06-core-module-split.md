# Core Module Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the monolithic `src/core.ts` into focused modules while preserving all current exports, package import paths, runtime behavior, and tests.

**Architecture:** Move shared interfaces into `types.ts`; isolate configuration, process/shell, Azure DevOps, reviewer, and gate orchestration responsibilities into dedicated modules. Keep `core.ts` as a compatibility facade that re-exports the existing public surface and default-exports the plugin from `gate.ts`.

**Tech Stack:** TypeScript ESM, Node.js 18+, OpenCode plugin SDK, esbuild, Vitest, ESLint, Prettier.

## Global Constraints

- Preserve every current named export from `src/core.ts` and `opencode-completion-gate/utils`.
- Keep `src/plugin.ts` default-export-only for OpenCode's legacy loader.
- Keep `src/index.ts` re-exporting `./core.js`.
- Make no functional changes to gate behavior, error semantics, shell safety, retry handling, or public TypeScript contracts.
- Keep `ReviewSessionClient` as the existing minimal public structural interface.
- Keep `GateAborted` silent and preserve existing evaluation checkpoints.
- Do not include generated `dist/` or `coverage/` output.

---

### Task 1: Extract shared types and low-level process utilities

**Files:**
- Create: `src/types.ts`
- Create: `src/process.ts`
- Modify: `src/core.ts`

**Interfaces:**
- Produces shared types and process exports consumed by later modules: `ProcessOutcome`, `ShellFn`, `ShellInvocation`, `runCommand`, `execFileOut`, `truncateTail`, `quoteWin`, `buildShellInvocation`, and `execShell`.
- `src/core.ts` remains temporarily import-compatible while the move is staged.

- [ ] **Step 1: Move shared interfaces and type aliases into `src/types.ts`**

Move the public assertion/config/process/session/SDK seam declarations without changing names or field types. Keep `ReviewSessionClient` as its existing minimal structural interface, and keep `GateSessionState` internal unless another extracted module needs it.

- [ ] **Step 2: Move process helpers into `src/process.ts`**

Move diagnostics, `brief`, `describeSdkError`, `truncateTail`, `outcomeFromErr`, `runCommand`, `execFileOut`, `quoteWin`, `buildShellInvocation`, and `execShell`. Import only shared types and Node dependencies. Preserve Windows quoting, timeouts, max buffers, and error text exactly.

- [ ] **Step 3: Update `core.ts` imports and exports**

Replace moved definitions with imports and explicit re-exports. Keep behavior working before the remaining modules are extracted.

- [ ] **Step 4: Run focused process tests**

Run:

```powershell
npx vitest run tests/command-runner.test.ts tests/shell.test.ts
npm run lint
```

Expected: all focused tests pass and lint reports zero errors/warnings.

### Task 2: Extract configuration and assertion implementations

**Files:**
- Create: `src/config.ts`
- Create: `src/ado-pr.ts`
- Create: `src/review.ts`
- Modify: `src/core.ts`

**Interfaces:**
- `config.ts` produces config/session helpers: `findGateConfigPath`, `loadGateConfig`, `parseOnlyCommand`, `effectiveMaxRetries`, and bootstrap/session metadata helpers.
- `ado-pr.ts` produces all current ADO exports and `runAdoPrAssertion`.
- `review.ts` produces `parseVerdict`, `runReviewAssertion`, and the public `ReviewSessionClient` interface.
- Each module depends on `types.ts` and low-level helpers, never on gate state or plugin hooks.

- [ ] **Step 1: Move config validation and parsing into `src/config.ts`**

Move positive integer handling, config validation/loading, path walking, bootstrap environment parsing/consumption, session metadata validation, `parseOnlyCommand`, and `effectiveMaxRetries`. Preserve malformed-input behavior and defaults.

- [ ] **Step 2: Move Azure DevOps code into `src/ado-pr.ts`**

Move PR selection, policy types/status evaluation, build preview/failure extraction, shell invocation use, build-log downloading/extraction, and ADO polling. Preserve artifact paths, polling deadlines, abort checkpoints, and evidence text.

- [ ] **Step 3: Move reviewer code into `src/review.ts`**

Move `ReviewSessionClient`, SDK unwrapping/error formatting use, reviewer response parsing, verdict parsing, and `runReviewAssertion`. Preserve timeout/abort behavior and missing-verdict failures.

- [ ] **Step 4: Rewire `core.ts` exports**

Remove duplicate implementations from `core.ts`, import the extracted modules where the temporary facade needs them, and explicitly re-export every previously public utility/type.

- [ ] **Step 5: Run assertion-focused tests**

Run:

```powershell
npx vitest run tests/config.test.ts tests/ado-pr.test.ts tests/review.test.ts tests/abort.test.ts
npm run build
npm run lint
```

Expected: tests, declarations/bundles, and lint all pass.

### Task 3: Extract gate orchestration and finalize the compatibility facade

**Files:**
- Create: `src/gate.ts`
- Modify: `src/core.ts`
- Modify: `src/plugin.ts` only if import wiring requires it

**Interfaces:**
- `gate.ts` default-exports the `Plugin` implementation and owns all mutable session state and hooks.
- `core.ts` default-exports `gate` and re-exports the complete public named API.
- `plugin.ts` remains default-export-only and continues importing the facade.

- [ ] **Step 1: Move gate state and hook orchestration into `src/gate.ts`**

Move session maps, bootstrap/toggle handling, toast/parts helpers, assertion orchestration, turn-end flow, and the plugin event/command/chat hooks. Import config, process, ADO, and review functions explicitly. Preserve all abort, retry, success, escalation, and disabled-state behavior.

- [ ] **Step 2: Reduce `core.ts` to the compatibility facade**

The file should contain only imports/re-exports and the default plugin export. Ensure all symbols currently imported from `../src/core.js` and `./core.js` remain available.

- [ ] **Step 3: Verify export compatibility**

Run:

```powershell
npm run build
npm run lint
npm test
```

Expected: declarations compile, lint is clean, and all existing tests pass without import changes.

### Task 4: Full regression and maintainability review

**Files:**
- Inspect: `src/*.ts`, `tests/**/*.ts`, `src/index.ts`, `src/plugin.ts`

**Interfaces:**
- Consumes the completed module split.
- Produces verified package artifacts and a reviewed diff with no generated files or accidental public/API changes.

- [ ] **Step 1: Run complete quality checks**

Run:

```powershell
npm run lint
npm run build
npm test
npm run test:coverage
git diff --check
```

- [ ] **Step 2: Inspect module boundaries and exports**

Confirm `core.ts` is a thin facade, `gate.ts` is the only mutable hook owner, integration modules do not import the plugin/session registry, and `src/index.ts`/`src/plugin.ts` retain their current entrypoint contracts.

- [ ] **Step 3: Review the final diff**

Confirm no user-facing strings, generated artifacts, package metadata, or unrelated files changed. Confirm the existing tests still import the compatibility facade.
