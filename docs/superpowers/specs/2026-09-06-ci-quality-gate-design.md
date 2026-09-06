# CI Quality Gate Design

## Goal

Make the build CI a blocking quality gate that enforces the repository's existing
lint, build, test, and coverage standards while keeping the current Node runtime
compatibility matrix.

## Scope

- Keep the existing Node 18, 20, and 22 CI matrix.
- Run `npm run test:coverage` on Node 20 so Vitest's configured 80% thresholds
  for lines, functions, branches, and statements are enforced in CI.
- Continue running the regular test command on Node 18 and Node 22.
- Keep `CI Success` as the aggregate job intended for branch protection.
- Remove all existing ESLint `no-explicit-any` warnings from `src/core.ts` by
  using SDK types or `unknown` with explicit narrowing.
- Make `@typescript-eslint/no-explicit-any` an error and run lint with
  `--max-warnings=0`, so any future warning fails CI.

## Design

The existing matrix job remains responsible for linting, building, and testing
on all supported Node versions. Only the Node 20 test step uses coverage. The
existing `ci-success` job continues to depend on the matrix job and exits
nonzero whenever any matrix leg fails, preserving a single stable required
status-check name for branch protection.

The type cleanup is behavior-preserving. OpenCode SDK types are used for known
client and event structures. External command, Azure DevOps, and reviewer
payloads remain runtime-validated at their boundaries and use `unknown` plus
small local shape interfaces rather than `any`. No public API or gate behavior
changes.

## Failure Handling

- A lint warning or error fails its matrix leg.
- A type/build error fails its matrix leg.
- A test failure or coverage threshold failure fails its matrix leg.
- `CI Success` reports failure when the matrix job is not successful.
- GitHub branch protection must configure `CI Success` as a required check; that
  repository setting is outside the checked-in workflow files.

## Verification

- Run `npm run lint` and confirm zero warnings and zero errors.
- Run `npm run build` and confirm declaration generation and bundling succeed.
- Run `npm run test:coverage` and confirm all tests and configured thresholds
  pass.
- Inspect the workflow diff to confirm coverage is limited to Node 20 and the
  aggregate job still gates all matrix results.
