# CI Quality Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CI enforce coverage and zero ESLint warnings while preserving the Node 18/20/22 compatibility matrix and existing aggregate `CI Success` check.

**Architecture:** Keep `.github/workflows/ci.yml` as the single CI workflow. Run the existing lint, build, and regular tests on every matrix leg, but use `npm run test:coverage` on Node 20 so Vitest's configured thresholds are blocking. Remove the current explicit-`any` lint warnings in `src/core.ts` using SDK types or `unknown` with narrow local interfaces, then make the lint rule and warning budget strict.

**Tech Stack:** GitHub Actions, Node.js 18/20/22, npm, TypeScript 5, ESLint 9 with `typescript-eslint`, Vitest 1 with V8 coverage, esbuild.

## Global Constraints

- Keep the existing Node 18, 20, and 22 CI matrix.
- Run `npm run test:coverage` on Node 20 only.
- Continue running the regular test command on Node 18 and Node 22.
- Keep `CI Success` as the aggregate job intended for branch protection.
- Remove all existing ESLint `no-explicit-any` warnings from `src/core.ts`.
- Make `@typescript-eslint/no-explicit-any` an error and run lint with `--max-warnings=0`.
- Preserve public APIs and gate behavior; type cleanup must be behavior-preserving.
- Do not alter repository branch-protection settings, release workflow, or package version.
- Do not include generated `dist/` or `coverage/` output in the change.

---

### Task 1: Define the strict lint and coverage commands

**Files:**
- Modify: `package.json:scripts.lint`
- Modify: `eslint.config.mjs` rule `@typescript-eslint/no-explicit-any`
- Modify: `.github/workflows/ci.yml` test step

**Interfaces:**
- Produces the CI contract used by all later tasks: `npm run lint` fails on any ESLint warning, and Node 20 runs `npm run test:coverage`.

- [ ] **Step 1: Update the lint command and rule severity**

Change the package script from:

```json
"lint": "eslint src tests"
```

to:

```json
"lint": "eslint src tests --max-warnings=0"
```

Change the existing ESLint rule from `'warn'` to `'error'`:

```js
'@typescript-eslint/no-explicit-any': 'error'
```

- [ ] **Step 2: Select coverage only on Node 20 in the workflow**

Replace the unconditional test command:

```yaml
- name: Test
  run: npm test
```

with a matrix-aware command:

```yaml
- name: Test
  run: ${{ matrix.node-version == 20 && 'npm run test:coverage' || 'npm test' }}
```

Keep the matrix, job names, `ci-success` dependency, and failure check unchanged.

- [ ] **Step 3: Validate the configuration changes before type cleanup**

Run:

```powershell
npm run lint
```

Expected: command fails only because the existing explicit-`any` warnings are now errors; record the complete warning/error locations for Task 2. Do not weaken the rule or restore a warning baseline.

### Task 2: Remove explicit-any diagnostics from `src/core.ts`

**Files:**
- Modify: `src/core.ts` type declarations, runtime payload boundaries, and SDK callback code

**Interfaces:**
- Consumes: the strict ESLint configuration from Task 1.
- Produces: `src/core.ts` with no `@typescript-eslint/no-explicit-any` diagnostics and unchanged runtime behavior.

- [ ] **Step 1: Inventory every explicit-any diagnostic**

Run:

```powershell
npx eslint src/core.ts --format stylish
```

Use the reported locations to cover all explicit `any` instances, including the config cast, child-process error shape, OpenCode client parameters, hook output mutation, PR payload parsing, reviewer response parsing, and event payload parsing.

- [ ] **Step 2: Replace untyped error values with `unknown` and a narrow helper shape**

Use `unknown` in catch/error-related boundaries and narrow before reading properties. For child-process errors, define a local shape such as:

```ts
type ProcessError = Error & { code?: number | string; killed?: boolean };
```

Update `outcomeFromErr` to accept `ProcessError | null`, preserving numeric exit-code handling. For generic caught errors, use `describeSdkError` or `err instanceof Error` checks already established in the file instead of property access through `any`.

- [ ] **Step 3: Replace `Record<string, any>` and untyped JSON payloads**

Use `Record<string, unknown>` for configuration input and add local runtime-narrowing helpers or small interfaces for known nested values. Keep config validation all-or-nothing: malformed data must still return `null`, and defaults must remain unchanged.

For Azure DevOps JSON, parse into `unknown`, verify arrays/objects before reading fields, and use local interfaces for PR entries, repositories, policies, and build-log response shapes. Do not assert a broad `any` object merely to bypass narrowing.

- [ ] **Step 4: Type OpenCode client and hook/event values without changing hook behavior**

Import the relevant client/event/output types from `@opencode-ai/plugin` if available in the installed SDK. If a stable exported type is unavailable, define minimal local structural types containing only the methods/properties used by the plugin. Use `unknown` for event properties and narrow by event type before accessing `info`, `sessionID`, or `status`.

Preserve these behaviors exactly:

- session creation/deletion registration and cleanup
- lazy session lookup
- toast failures remaining best-effort
- slash-command output mutation and `noReply`
- chat-message text-part handling
- asynchronous prompt error logging

- [ ] **Step 5: Type reviewer response and output-part parsing**

Define local structural types for reviewer response parts and hook output parts. Narrow arrays and text parts before reading `type`, `text`, or mutating `textPart.text`. Keep missing or malformed reviewer verdicts as failures and keep injected gate messages untouched.

- [ ] **Step 6: Run lint and fix only type-safety issues it reports**

Run:

```powershell
npm run lint
```

Expected: PASS with zero warnings and zero errors. If TypeScript or ESLint reports a new narrowing issue, fix the local type/interface rather than adding `any`, disabling the rule, or changing runtime validation.

### Task 3: Verify build, coverage, and workflow behavior

**Files:**
- Test: `src/core.ts`, `tests/**/*.test.ts`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: strict lint configuration and typed `core.ts` from Tasks 1 and 2.
- Produces: verified build artifact generation, passing coverage thresholds, and a workflow whose Node 20 leg is the blocking coverage gate.

- [ ] **Step 1: Run the build**

Run:

```powershell
npm run build
```

Expected: esbuild creates both bundles and TypeScript emits declarations without errors.

- [ ] **Step 2: Run the coverage suite**

Run:

```powershell
npm run test:coverage
```

Expected: all Vitest tests pass and the configured 80% lines, functions, branches, and statements thresholds pass.

- [ ] **Step 3: Run the regular test suite**

Run:

```powershell
npm test
```

Expected: all tests pass without coverage instrumentation.

- [ ] **Step 4: Inspect the final workflow and diff**

Run:

```powershell
git diff --check
git diff -- .github/workflows/ci.yml package.json eslint.config.mjs src/core.ts
```

Confirm that coverage is selected only for `matrix.node-version == 20`, all matrix legs still run lint and build, and `ci-success` still has `needs: [test]` and fails unless the matrix job succeeds.

- [ ] **Step 5: Run the complete local quality sequence**

Run:

```powershell
npm run lint
npm run build
npm run test:coverage
```

Expected: all three commands exit successfully; this is the evidence required before reporting the quality gate as complete.
