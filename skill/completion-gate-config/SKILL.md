---
name: completion-gate-config
description: Create or maintain a project's .opencode/completion-gate.json — the per-project assertion config consumed by the completion-gate OpenCode plugin. Covers the config schema, the three assertion types (command, ado-pr, opencode-review), stack-specific recipes (.NET, Node/Angular, hybrid), and critical gotchas (whole-config invalidation, worktree junction permissions, human-review policies, Windows shell syntax). Use when setting up, editing, or troubleshooting a completion gate for a project.
license: MIT
compatibility: opencode
metadata:
  version: "1.0.1"
  author: "pto"
  tags: ["opencode", "plugin", "quality-gate", "completion-gate", "ci"]
  updated: "2026-08-24"
---

# Completion Gate Configuration

How to configure `.opencode/completion-gate.json` for a project so the **completion-gate plugin** blocks an agent from declaring a task "done" until your assertions pass (build green, tests green, PR policies green, LLM self-review…).

The gate is **off by default per session** — the user enables it with `/gate`. Your job when using this skill is only to make sure the *project config file* is correct, complete, and readable.

## File Location & Discovery

- Path: `<project-root>/.opencode/completion-gate.json`
- The plugin **walks up from the session's directory** looking for `.opencode/completion-gate.json`, so worktrees resolve their own copy (in the opencode-config setup, the worktree `.opencode/` is a junction back to the config repo — both paths hit the same file).
- The file is **re-read on every gated turn end** — edits apply immediately, no restart needed.

## Minimal Config

```json
{
  "enabled": true,
  "maxRetries": 3,
  "assertions": [
    { "type": "command", "name": "unit-tests", "run": "npm test", "timeoutSeconds": 300 }
  ]
}
```

## Schema Reference

### Top-level fields

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Only `false` disables the gate. **A missing `enabled` still gates** — but always write it explicitly for clarity. |
| `maxRetries` | `3` | Auto-fix injections per fix cycle before the gate escalates (error toast, no more retries until the user's next message). |
| `assertions` | *(required)* | Non-empty array. **Empty array or missing = gate silently off.** |

### Assertion fields by type

| Field | Type | Default | Description |
|---|---|---|---|
| `type` | all | *(required)* | `command`, `ado-pr`, or `opencode-review`. **Any other value invalidates the whole config.** |
| `name` | all | first token of `run` / `ado-pr` / `self-review` | Label used in failure/success reports. Always set it — it's what the agent sees in retry prompts. |
| `run` | `command` | *(required)* | Shell command executed in the project root. Missing/empty `run` invalidates the whole config. |
| `timeoutSeconds` | `command` | `300` | Kills the process tree on expiry (counts as failure). |
| `pollTimeoutMinutes` | `ado-pr` | `15` | Give up polling for green PR policies after this long (failure). |
| `pollIntervalSeconds` | `ado-pr` | `30` | Delay between policy polls (floored at 5s). |
| `skipIfNoPr` | `ado-pr` | `false` | When `true`, "no active PR on this branch" passes instead of failing. |
| `ignoreHumanPolicies` | `ado-pr` | `false` | When `true`, blocking human-review policies (reviewer approvals, comment requirements) don't hold the gate. |
| `agent` | `opencode-review` | `"reviewer"` | Agent used for the headless review session. |
| `prompt` | `opencode-review` | *"Review the changes on this branch against the task requirements."* | Custom review instruction. |
| `timeoutSeconds` | `opencode-review` | `900` | Abort the reviewer session after this long (failure). |

Non-positive or non-numeric values for the numeric fields silently fall back to the defaults.

> Session note: `/gate --only "<command>" --retries N` overrides the file's `maxRetries` for that session's command-only run (falls back to the config value when omitted). This skill covers the file schema only — the override lives in the plugin session state, not in this JSON.

## Assertion Types

Assertions run **sequentially**; the first failure short-circuits the rest so the evidence stays focused.

### `command`

Runs a shell command in the project root. Passes on exit code 0 within the timeout; on failure the last ~50 lines of output are injected into the session as fix evidence.

```json
{ "type": "command", "name": "build", "run": "dotnet build --nologo -v q", "timeoutSeconds": 300 }
```

### `ado-pr`

Uses the `az` CLI to verify the current branch has **exactly one active Azure DevOps PR** whose required policies are all green (`approved`, `succeeded`, or `notapplicable`). Polls while required policies are retryable: automated policies only in `queued`/`running`, and human-review policies whenever `ignoreHumanPolicies` is `false`; terminal automated failures are returned immediately with their policy detail.

```json
{ "type": "ado-pr", "name": "azure-devops-pr-green",
  "pollTimeoutMinutes": 30, "pollIntervalSeconds": 60,
  "skipIfNoPr": false, "ignoreHumanPolicies": true }
```

Requirements:
- `az` installed **and logged in** (`az login`), with access to the org resolved from the git remote.
- Zero active PRs fails (unless `skipIfNoPr: true`); **multiple active PRs always fails**.

`ignoreHumanPolicies` classification (when `true`, the "human" ones are skipped):

| Classification | Policies |
|---|---|
| Human (skipped) | *Minimum number of reviewers*, *Required reviewers*, *Comment requirements* |
| Automated (enforced) | *Build*, *Require a merge strategy*, *Work item linking*, *Status*, anything else |

If only human policies remain, the assertion counts as green.

Automated `queued` and `running` statuses are polled. Automated `rejected`, `broken`, and unknown statuses fail immediately rather than waiting for `pollTimeoutMinutes`. Human-review policies remain retryable when `ignoreHumanPolicies` is `false`, because a human action can change their state.

### `opencode-review`

Spawns an isolated reviewer session (same opencode server, gating disabled so it can't recurse) and parses the reply for a final `VERDICT: PASS` / `VERDICT: FAIL` line. A missing verdict counts as failure.

```json
{ "type": "opencode-review", "name": "self-review",
  "agent": "reviewer",
  "prompt": "Review the changes on this branch against the task requirements.",
  "timeoutSeconds": 900 }
```

## Recipes

### .NET solution

```json
{
  "enabled": true,
  "maxRetries": 3,
  "assertions": [
    { "type": "command", "name": "build", "run": "dotnet build MySolution.sln --nologo", "timeoutSeconds": 900 },
    { "type": "command", "name": "tests", "run": "dotnet test MySolution.sln --no-build --nologo", "timeoutSeconds": 3600 }
  ]
}
```

### Node / Angular frontend

```json
{
  "enabled": true,
  "maxRetries": 3,
  "assertions": [
    { "type": "command", "name": "frontend-build", "run": "npm run build", "timeoutSeconds": 1800 },
    { "type": "command", "name": "frontend-tests", "run": "npm run test-ci", "timeoutSeconds": 1800 }
  ]
}
```

### Hybrid .NET + Angular with ADO PR gate (real-world example)

Adapted from AquadvancedEnergy — note the `cd` + `&&` chaining and generous timeouts:

```json
{
  "enabled": true,
  "maxRetries": 3,
  "assertions": [
    { "type": "command", "name": "backend-build", "run": "dotnet build AquadvancedEnergyHost.sln --nologo", "timeoutSeconds": 900 },
    { "type": "command", "name": "backend-tests", "run": "dotnet test AquadvancedEnergyHost.sln --nologo", "timeoutSeconds": 3600 },
    { "type": "command", "name": "frontend-build", "run": "cd Sources\\AquadvancedEnergy.Web && npm run build-prod", "timeoutSeconds": 1800 },
    { "type": "command", "name": "frontend-tests", "run": "cd Sources\\AquadvancedEnergy.Web && npm run test-ci", "timeoutSeconds": 1800 },
    { "type": "ado-pr", "name": "azure-devops-pr-green", "pollTimeoutMinutes": 30, "pollIntervalSeconds": 60, "skipIfNoPr": false, "ignoreHumanPolicies": true }
  ]
}
```

## Critical Gotchas

### 1. One bad assertion kills the whole config (silently)

Validation is all-or-nothing: an unknown `type`, a `command` without `run`, a malformed assertion entry, an empty `assertions` array, or invalid JSON → **the entire config is discarded and the gate is silently skipped**. There is no partial mode. After editing, always validate (see below) and check `gate-diag.log` if the gate doesn't fire.

### 2. Worktree junction permission (opencode-config setups)

When the project's `.opencode/` is a junction into the config repo, opencode resolves the junction **before** permission checks — the read is evaluated against the canonical path. The project's `opencode.json` must allow it:

```json
"permission": {
  "external_directory": {
    "D:/workspaces/perso/opencode-config/workspaces/<org>/<Project>/.opencode/**": "allow"
  }
}
```

Without this the agent can't read its own gate config. Regression tests: `agent-tests/tests/build/gate-config-read-*.yaml`.

### 3. Order assertions cheapest-first

Sequential execution + first-failure short-circuit means a slow assertion early in the list delays all feedback. Put fast checks (lint, build) before slow ones (full test suites, PR policy polling).

### 4. Human-review policies deadlock the auto-fix loop

An agent in the retry loop can never get a human to approve a PR or resolve comments. Without `ignoreHumanPolicies: true`, the gate retries until the cap and escalates every time. Almost always set it on `ado-pr`.

### 5. Windows shell syntax in `run`

Commands go through the shell, so `&&` chaining and `cmd` builtins work — but JSON-escape backslashes (`cd Sources\\Web && npm run build`) and remember this is `cmd`-style syntax on Windows (`if exist node_modules rmdir /s /q node_modules`), not bash.

### 6. Default timeouts are too small for real solutions

`command` defaults to 300s — a full .NET solution build or Angular prod build will blow past it. Size timeouts from observed CI durations (builds 900–1800s, full test suites 3600s).

### 7. `ado-pr` needs exactly one active PR

Zero PRs fails (use `skipIfNoPr: true` for pre-PR work); **two or more** active PRs on the branch always fails. Keep one PR per branch.

## Validation & Testing

1. **JSON sanity** (from the project root):

```powershell
node -e "JSON.parse(require('fs').readFileSync('.opencode/completion-gate.json','utf8')); console.log('valid')"
```

2. **End-to-end**: start an opencode session in the project, type `/gate`, send a trivial instruction, and watch the gate evaluate at turn end.

3. **Diagnostics**: every gate activity is traced in `~/.config/opencode/gate-diag.log` (config path resolved, assertion count, per-assertion results, retries, aborts). This is the first place to look when the gate doesn't fire or behaves oddly.

4. **Status**: `/gate status` shows `ENABLED/DISABLED · retries=n · lastOutcome=...` for the session. Remember the session toggle is separate from the config — the config can be perfect and the gate still off until `/gate`.

## Reporting Issues

For any inaccuracies or corrections needed in this skill, follow the standard workflow defined in the `skill-feedback` skill. All corrections must be delegated to the `@skill-feedback` agent.

Full plugin documentation: `completion-gate-plugin.md` at the repository root.
