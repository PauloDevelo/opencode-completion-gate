---
name: creating-completion-gate-commands
description: Use when creating an executable command for an OpenCode completion-gate command assertion, including its tests, diagnostics, and colocated README.md.
license: MIT
compatibility: opencode
metadata:
  version: "1.0.0"
  author: "PauloDevelo"
  tags: ["opencode", "completion-gate", "command", "testing", "diagnostics"]
  updated: "2026-09-06"
---

# Creating Completion-Gate Commands

Use this skill to create one project-local executable command that can be run by
the completion-gate plugin. Create the command, its tests, and a colocated
`README.md`; do **not** configure the gate itself.

## Required workflow

1. **Ask for the exact command directory path.** Do not infer it from the
   repository root or silently choose a scripts directory.
2. Inspect that directory and its project context before writing anything:
   manifests, source files, test files, package scripts, build/lint/type-check
   commands, and nearby documentation.
3. Identify the existing language, package manager, test framework, formatter,
   and naming/layout conventions. Reuse existing dependencies and patterns; do
   not impose TypeScript/Vitest or add a new framework.
4. Ask for missing command-specific requirements: what is validated, inputs and
   arguments, pass criteria, expected working directory, and actionable fixes.
5. Define the command contract before implementation: invocation, usage errors,
   exit codes, stdout/stderr behavior, diagnostic categories, ordering, and any
   output limit.
6. Create only these artifacts in the selected directory:
   - executable command implementation;
   - tests using the project's existing test framework;
   - `README.md` documenting the command.
7. Run focused tests, then the relevant existing lint, type-check, or build
   command when available. Report checks that cannot be run.

If the project language or test framework cannot be identified, stop and ask
the user. Do not guess and do not create a parallel toolchain.

## Completion-gate contract

A command assertion runs in the project root and passes only when the process
exits with code `0` before its configured timeout. Any validation failure,
invalid usage, or unexpected execution error must exit nonzero. The gate
captures command output and normally retains approximately the last 50
non-empty lines, so every failure must be understandable from its own line.

The skill creates no `.opencode/completion-gate.json` entry. Document an
optional assertion for the user to add later, for example:

```json
{
  "type": "command",
  "name": "my-validator",
  "run": "node scripts/my-validator.js",
  "timeoutSeconds": 300
}
```

Use a non-interactive, deterministic command. Size `timeoutSeconds` from the
observed runtime rather than assuming the 300-second default. On Windows,
commands run through `cmd.exe`; use Windows-compatible chaining and escape
backslashes when the invocation is placed in JSON.

## Diagnostic contract

Diagnostics are repair instructions for the agent, not general application
logs. Prefer stable, line-oriented output:

```text
ERROR [missing-key] file=locales/fr.json key=dashboard.title
Expected the key defined by locales/en.json.
Fix: add the missing translation.
FAIL: 1 error across 1 file
```

Follow these rules:

- Write a short `PASS: <check>` summary to stdout on success.
- Write failure diagnostics and the final failure summary to stderr.
- Emit one actionable diagnostic per logical failure.
- Include a stable category plus the affected file/path and key, item, or rule
  identifier whenever applicable.
- Sort diagnostics deterministically, normally by path then identifier.
- State the expected value/rule and a concrete fix hint when predictable.
- End failures with a count, such as `FAIL: 3 errors across 2 files`.
- Exit nonzero whenever any validation diagnostic exists.
- Make usage errors show the expected invocation and exit with a documented
  nonzero code.
- Catch unexpected errors at the CLI boundary and report concise context;
  preserve the nonzero exit status.
- Avoid timestamps, decorative banners, noisy debug dumps, and machine-specific
  absolute paths unless an artifact path is required to continue debugging.
- Bound unusually large output and explicitly say when diagnostics were omitted.

Do not report only `Validation failed`, write all useful details to a log file
without a console summary, or return `0` for detected problems. The retry
agent must be able to identify what to change from the captured tail alone.

## Tests to require

Use isolated fixtures and the project's normal test style. Cover at least:

- a completely valid input and exit code `0`;
- each important validation failure, including its category, location, reason,
  and nonzero exit code;
- multiple failures and deterministic ordering;
- malformed or missing input;
- invalid command usage and its documented exit code;
- representative unexpected-error handling;
- the stdout success and stderr failure contract.

If the command can hang or invoke external processes, also test the project's
existing timeout/process conventions rather than inventing a new runner.

## README.md requirements

Write `README.md` beside the command. It must state:

- purpose and explicit non-goals;
- prerequisites and supported runtime/tooling;
- exact invocation and argument examples;
- input discovery and working-directory assumptions;
- exit-code meanings;
- stdout/stderr and diagnostic format;
- how to interpret and fix failures;
- how to run the command tests;
- an optional completion-gate assertion example, without adding it to gate
  configuration automatically.

Use project-relative paths and portable placeholders in the README. Do not
document the author's machine-specific absolute path.

## Scope guard

Do not modify `.opencode/completion-gate.json`, unrelated source files, project
manifests, CI, or global configuration. Adding a dependency is out of scope;
if the detected project lacks a required test dependency, ask the user before
changing package files.

## Reporting Issues

For inaccuracies or corrections to this skill, follow the standard workflow
defined in the `skill-feedback` skill. Delegate corrections to
`@skill-feedback` rather than editing this skill directly.
