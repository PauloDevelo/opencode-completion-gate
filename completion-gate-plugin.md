# Completion Gate Plugin

Per-session quality gate that blocks an agent from declaring a task "done" until configured assertions pass. Implemented in [`src/plugin.ts`](src/plugin.ts) (default-export-only entry re-exporting [`src/core.ts`](src/core.ts), built to `dist/plugin.js`); loaded via the `plugin` field in `opencode.json` (see `README.md`).

## Purpose

When the gate is enabled for a session, every turn end of the **primary** agent is checked against a per-project assertion list (build green, unit tests green, PR policies green, LLM self-review…). If an assertion fails, the plugin automatically sends the failure evidence back to the agent and lets it fix the problem — bounded by a retry cap. You no longer have to notice that the agent "finished" with a broken build.

Key properties:

- **Off by default** — gating applies only to sessions you explicitly enable with `/gate`.
- **Subagent sessions are never gated** (only top-level sessions).
- Projects without a config file (or with `"enabled": false`) are skipped silently.

## Quick start

Typical workflow:

1. Instruct the agent: *"Fix X until completion."*
2. Type `/gate` (enables the gate for this session).
3. The agent works; each time it goes idle the gate runs your assertions.
4. All pass → `✅ Completion gate passed (...)` appears once and the agent may report done.
5. Something fails → the agent is re-prompted with the failure evidence and keeps fixing until it passes or hits the retry cap.
6. `/gate off` when you're done.

```
/gate          # enable (same as /gate on)
/gate status   # e.g. "Completion gate: ENABLED · retries=1 · lastOutcome=fail · extraCommand=none · mode=combined"
/gate off      # disable for this session
/gate "python scripts/assert_task_done.py"  # run a custom command before configured assertions
/gate --only "python scripts/assert_task_done.py"  # run only this command; skip configured assertions
/gate --only "python scripts/assert_task_done.py" --retries 5  # same, but allow 5 auto-fix retries instead of the config's maxRetries
```

Orchestration launchers arm command-only mode out-of-band with the
`OPENCODE_GATE_BOOTSTRAP_COMMAND_B64` (preferred) or
`OPENCODE_GATE_BOOTSTRAP_COMMAND` env var plus `OPENCODE_GATE_BOOTSTRAP_MODE`
(`command-only` default, `combined` to also run project assertions) and the
optional `OPENCODE_GATE_BOOTSTRAP_MAX_RETRIES` (positive integer; honored only
in `command-only` mode as the session retry override, ignored otherwise).
The plugin consumes them one-shot on `session.created`, enables the gate, and
confirms with a toast carrying the command
(`Completion gate armed (<mode>): <command>`, with a `· maxRetries=N` suffix
when a session override applies) — nothing enters the chat transcript. The legacy
`[completion-gate-internal] --only <command>` first-line chat directive remains
supported as a fallback (stripped from the model payload before delivery;
only the `--only` variant is handled — a bare internal marker without `--only`
is ignored — and it accepts the same trailing/leading `--retries N` flag);
users should continue to use `/gate` or `/gate --only` interactively.

The state is **in-memory per session** — no gate state is persisted. After the OpenCode server restarts, a session starts disabled, so invoke `/gate` again to enable it. A custom command set with `/gate "command"` is also session-only and uses a default timeout of **300 seconds**.

When a custom command is configured, `/gate "command"` runs it **first** at every gate evaluation, before the project's configured assertions. `/gate --only "command"` switches to command-only mode: it runs the supplied command and skips the project's configured assertions. Both forms replace the previously stored custom command. As with all gate evaluations, a consecutive passing streak skips repeated evaluations until a genuine user message starts a new cycle.

Per-command retry cap: `/gate --only "command" --retries N` (alias `--max-retries N`; leading form `/gate --only --retries N "command"` also works) overrides the retry cap for that session only — the `(RETRY n/max)` counter, escalation toast, and `runGateTurnEnd` cap all use `N` instead of the config file's `maxRetries`. Without the flag the command-only run falls back to the config value (or the default 3 when there is no config). Re-arming `--only` without the flag clears the override; `/gate`, `/gate on`, `/gate off`, and genuine user messages preserve it (messages only reset the fix-cycle counters). `N` must be a positive integer; a missing or invalid value returns usage and leaves the stored command, mode, retry count, and outcome unchanged. The flag is only recognized as a leading or trailing token — a `--retries` sequence in the middle of the command stays part of the command, and combined mode (`/gate "command"`) never strips it. `/gate status` reports the effective cap as `maxRetries=<n> (session|config)`.

`/gate`, `/gate on`, and `/gate off` preserve the stored custom command, the selected mode, and the session retry override while enabling or disabling the gate. `/gate "command"` selects combined mode; `/gate --only "command"` selects command-only mode. `/gate --only` without a command (or with a missing/invalid `--retries` value) is invalid: it returns usage (`Usage: /gate --only "command" [--retries N]`) and leaves the enabled state, stored command, mode, retry count, and outcome unchanged. `/gate status` reports whether a custom command is configured, which mode is selected, and the effective retry cap (`maxRetries=<n> (session|config)`), but never prints the command contents.

`off` also takes effect **immediately**: an in-flight gate evaluation stops at the next checkpoint (before each assertion, between `ado-pr` poll rounds) and stays silent — no further retry injection, success notice, or escalation toast. A child process that already started (e.g. a running build) finishes first; the abort lands right after it.

### How `/gate` works

The slash command is handled by the plugin's `command.execute.before` hook before its markdown template reaches the model. If an existing or resumed **top-level** session has no in-memory state, the hook lazily registers it from the session metadata, then applies `/gate`, `/gate on`, `/gate off`, `/gate status`, `/gate "command"`, or `/gate --only "command"`. The hook toggles, reports, or configures the per-session state, shows a toast confirmation (`Completion gate enabled/disabled`, status, or command registration), clears the command parts, and then **aborts the command flow so the model stays idle — no LLM turn is dispatched**.

Why the abort: OpenCode unconditionally runs an agent turn after every slash command. Empty parts do *not* suppress it, and an empty turn right after real work can make the model re-emit the previous turn's tool calls. There is no supported skip flag on the stable channel ([upstream issue](https://github.com/anomalyco/opencode/issues/28292); fix PR [anomalyco/opencode#46579](https://github.com/anomalyco/opencode/pull/46579) is open but unmerged), so the plugin throws a sentinel error carrying the confirmation text out of `command.execute.before` — the documented workaround — after arming the gate and showing the toast. The hook also sets `output.noReply = true` (forward-compatible: harmless no-op today, honored once the upstream PR lands). To fall back to parts-clearing only, set `ABORT_COMMAND_TURN = false` in `src/core.ts` (the turn will fire again — not recommended).

Because the aborted turn produces no fresh idle event, enabling via `/gate` **kicks an immediate evaluation** in the background — the gate validates right away instead of staying dormant until your next real turn (the `busy` flag serializes this with later idle evaluations). If the session directory resolves to no config and no session command is set, enabling also shows an error toast (`…nothing to run: no .opencode/completion-gate.json found from <dir>`) so a mis-scoped session is obvious instead of silently idle — check `gate-diag.log` for the exact lookup start directory.

Direct messages starting with `[completion-gate]` remain supported through the `chat.message` hook, but throwing there does *not* abort the turn (the host swallows it), so the hook swaps in a one-line anchor (`…acknowledge briefly, take no other action, call no tools`) instead of clearing — the model wakes but is constrained to a short ack with no tool calls. Prefer the `/gate` slash command for fully silent toggling. Injected retry/success messages are left untouched.

Deleted or unavailable sessions, sessions with malformed metadata, and subagent sessions are left unchanged. A restarted server still leaves the lazily registered session disabled; the user must invoke `/gate` again to enable gating.

> Note: because injected retry/success notes also carry the marker, direct messages matching `[completion-gate] on`, `[completion-gate] off`, `[completion-gate] status`, `[completion-gate] <command>`, or `[completion-gate] --only <command>` are handled as gate commands; generated retry/success/failure messages are left untouched. All `/gate` confirmations are toast-only and ephemeral — re-run `/gate status` if you miss one. In headless mode (no TUI) the toast is skipped safely; the toggle still applies and `gate-diag.log` records it.

## Configuration

Config lives per project at `<project-root>/.opencode/completion-gate.json`. The plugin walks up from the session's directory to the git root looking for it, so worktrees resolve their own copy. The config is **re-read on every gated turn end** — edits apply without restarting.

Example (`<project-root>/.opencode/completion-gate.json`):

```json
{
  "enabled": true,
  "maxRetries": 3,
  "assertions": [
    { "type": "command", "name": "build", "run": "dotnet build --nologo -v q", "timeoutSeconds": 300 },
    { "type": "command", "name": "unit-tests", "run": "dotnet test --no-build --nologo -v q", "timeoutSeconds": 600 }
  ]
}
```

### Schema

| Field | Applies to | Default | Description |
|---|---|---|---|
| `enabled` | project | `true` | `false` (or a missing/unparsable config) silently skips the gate; a missing `enabled` field still gates — always write it explicitly |
| `maxRetries` | project | `3` | Auto-fix injections allowed per fix cycle before escalation |
| `assertions` | project | *(required)* | At least one assertion; empty array disables the gate |
| `name` | all | see below | Label used in reports; falls back to first token of `run` (`command`), `ado-pr`, or `self-review` (`opencode-review`) |
| `run` | `command` | *(required)* | Shell command executed in the project root |
| `timeoutSeconds` | `command` | `300` | Kill the process tree after this many seconds (failure) |
| `pollTimeoutMinutes` | `ado-pr` | `15` | Give up polling for green policies after this long (failure) |
| `pollIntervalSeconds` | `ado-pr` | `30` | Delay between policy polls (floored at 5s) |
| `skipIfNoPr` | `ado-pr` | `false` | When `true`, "no active PR" passes instead of failing |
| `ignoreHumanPolicies` | `ado-pr` | `false` | When `true`, blocking human-review policies no longer hold the gate (see below) |
| `agent` | `opencode-review` | `"reviewer"` | Agent used for the headless review session |
| `prompt` | `opencode-review` | *"Review the changes on this branch against the task requirements."* | Custom review instruction |
| `timeoutSeconds` | `opencode-review` | `900` | Abort the reviewer session after this many seconds (failure) |

## Assertion catalog

Assertions run **sequentially**; the first failure short-circuits the rest so evidence stays focused on one problem.

### `command`

Spawns the shell command in the session's project root. Passes on exit code 0 within the timeout; on failure captures the last ~50 lines of stderr/stdout as evidence.

```json
{ "type": "command", "name": "build", "run": "dotnet build --nologo -v q", "timeoutSeconds": 300 }
```

```json
{ "type": "command", "name": "unit-tests", "run": "dotnet test --no-build --nologo -v q", "timeoutSeconds": 600 }
```

### `ado-pr`

Uses the `az` CLI to verify the current branch has exactly one active Azure DevOps PR whose required policies are all green (`approved`, `succeeded`, or `notapplicable`).

```json
{ "type": "ado-pr", "name": "pr-quality-gate", "pollTimeoutMinutes": 15, "pollIntervalSeconds": 30, "skipIfNoPr": false }
```

Flow: resolve current branch (`git branch --show-current`) → `az repos pr list --source-branch <branch> --status active` → fail if zero (unless `skipIfNoPr`) or multiple PRs → `az repos pr policy list --id <prId>` → poll while required automated policies are queued/running. A rejected or broken automated policy fails immediately with its policy detail; the timeout is only used while a policy is still in progress.

#### Ignoring human-review policies (`ignoreHumanPolicies`)

Some blocking policies can only be turned green by a **human** (approving, resolving comments) — an agent stuck in the auto-fix loop can never satisfy them. Set `"ignoreHumanPolicies": true` to make the gate wait only on automated policies:

| Classification | Policies |
|---|---|
| Human (skipped when flag is on) | *Minimum number of reviewers*, *Required reviewers*, *Comment requirements* |
| Automated (still enforced) | *Build*, *Require a merge strategy*, *Work item linking*, *Status*, anything else |

```json
{ "type": "ado-pr", "name": "azure-devops-pr-green", "pollTimeoutMinutes": 30,
  "pollIntervalSeconds": 60, "skipIfNoPr": false, "ignoreHumanPolicies": true }
```

With the flag on, a green result reports what was skipped, e.g. `4 required policy(ies) green, 2 human policy(ies) ignored (...)`. If *only* human policies remain on the PR, it counts as green. The flag is opt-in — without it every blocking policy must be green before the gate passes.

Policy polling distinguishes pending from terminal states. `queued` and `running` are retried; `approved`, `succeeded`, and `notApplicable` pass; `rejected` and `broken` fail immediately. Unknown statuses on automated policies also fail immediately so the gate does not hide an API-shape or policy-state change behind a polling timeout. Human-review policies remain retryable when they are not ignored, because their state can change after manual action.

**Field shapes** were calibrated against live `az repos pr list` / `az repos pr policy list` payloads (sanitized fixtures in `tests/fixtures/`). If a real PR trips an unparsable-shape failure, check `gate-diag.log` and report the mismatch.

#### Failed Build log artifacts

When a required blocking `Build` policy reaches a terminal failure (`rejected`, `broken`, or any other non-pending automated state), the gate downloads that build's complete log bundle from Azure DevOps and extracts it under the temporary OpenCode workspace. The retry evidence reports the extracted directory first, then the raw ZIP, for example:

```text
Build logs extracted directory: C:\Users\<you>\AppData\Local\Temp\opencode\completion-gate-logs-383110-abc123\extracted
Build logs ZIP: C:\Users\<you>\AppData\Local\Temp\opencode\completion-gate-logs-383110-abc123\build-383110-logs.zip
```

The `completion-gate-logs-<buildId>-<suffix>` directory name is unique per download. Open the extracted directory and inspect the per-job/per-task `.txt` files (e.g. `backend_build/17_Build solution AquadvancedEnergy.txt`); the archive also contains an `azure-pipelines-expanded.yaml`. The policy's `buildOutputPreview` remains in the evidence as a compact summary of the likely failing job, task, and compiler errors.

Log download and extraction are best-effort:

- The original CI failure always stands on its own; artifact problems never mask or replace it.
- A terminal Build policy without a usable `buildId`, or a PR payload without a repository project name, adds an explicit "Build logs unavailable" line instead of attempting a download.
- If download fails, evidence carries a `Build log artifact error:` line plus the preview.
- If extraction fails after a successful download, the ZIP path is retained so it can be opened manually; the error is reported alongside it.
- Multiple distinct failed build IDs are downloaded once each; duplicate policy entries for one build are collapsed.

Artifacts live in the OS temporary workspace for the active fix cycle and are not cleaned up by the plugin — normal temporary-file lifecycle applies. Nothing is written into the repository.

Requires `az` installed **and logged in** (`az login`) with access to the organization resolved from the git remote.

### `opencode-review`

Runs the reviewer through an **isolated reviewer session** on the same opencode server (created via the plugin SDK client inside the gated repo's directory) and prompts it with `agent: <agent>`. The reply is parsed for a final `VERDICT: PASS` / `VERDICT: FAIL` line; a missing verdict counts as failure (captured review text included as evidence).

```json
{
  "type": "opencode-review",
  "name": "self-review",
  "agent": "reviewer",
  "prompt": "Review the changes on this branch against the task requirements.",
  "timeoutSeconds": 900
}
```

Notes:

- On timeout the reviewer session is aborted and the assertion fails.
- The reviewer session is top-level but registered with gating disabled — review prompts can never recursively trigger the gate.

## Behavior on failure

1. Gate runs at every idle of an enabled primary session.
2. Failure → the agent is re-prompted with: *✖ Completion gate failed — "\<name\>". Fix these issues, then finish again.* followed by the evidence in a code block and a `(RETRY n/maxRetries)` counter.
3. The agent wakes, fixes, goes idle → the gate re-runs automatically.
4. Retry cap reached → no more injections; an error toast is shown (*still failing after N retries — manual attention needed*) and the event is logged to diagnostics.
5. Counters reset when you send your next genuine message (or when you re-enable via `/gate`) — start a fresh fix cycle by simply talking to the agent again.

A passing gate posts its success note **once** per consecutive-passing streak, and subsequent idles **skip evaluation entirely** (logged as `gate turn-end skipped ... already green this streak`) — no wasted build/test re-runs while you keep working past a green gate. Your next genuine message resets `lastOutcome`, so the next idle starts a fresh full validation.

## Kill switch

Set `OPENCODE_GATE_DISABLED=1` to suspend all gate evaluations. Like `/gate off`, this also **aborts an in-flight evaluation** at the next checkpoint; unset the variable to resume gating (the per-session toggle flag itself is unaffected).

## Diagnostics log

Every gate activity is appended to `~/.config/opencode/gate-diag.log`. The log traces the full turn-end flow, so you can see exactly where a run is at any moment:

```
session <id> went idle — gate turn-end starting
gate turn-end on <id>: config ...completion-gate.json (6 assertion(s), maxRetries=3, retries so far=0)
evaluating assertion "backend-build" (command)
command "backend-build": running "dotnet build ..." (cwd=..., timeout=900s)
command "backend-build": exit code 0
assertion "backend-build" passed
evaluating assertion "azure-devops-pr-green" (ado-pr)
ado-pr "azure-devops-pr-green": branch="users/pto/3.13.6-...", polling every 60s up to 30 min
ado-pr "azure-devops-pr-green": round 1 — active PR !61032, checking policies
ado-pr "azure-devops-pr-green": PR !61032 not green yet — Build: running (2 human policy(ies) ignored)
gate FAILED on <id>: "azure-devops-pr-green" — retry 1/3, injecting fix request
...
gate PASSED on <id>: all 6 assertion(s) green
```

For a completed failed build, the diagnostic instead records `PR !<id> has terminal policy failure — ... Build: rejected ...; stopping polling`, and the same detail is returned to the agent as assertion evidence.

Also logged: session registrations, successful lazy registration, skipped subagents, rejected metadata, session lookup failures, `/gate` toggles, review session creation and verdicts, timeouts, short-circuit stops (`remaining assertions skipped`), escalations after the retry cap, and mid-run aborts (`gate turn-end ABORTED on <id>`). For resumed sessions, use these entries in `gate-diag.log` to distinguish successful registration from a skipped subagent, rejected metadata, or a lookup failure.

## Troubleshooting

| Symptom | Check |
|---|---|
| Gate never fires | `/gate status` — is it enabled? If enabling showed a `…nothing to run` error toast, the session directory resolves to no config: check `gate-diag.log` for the lookup start directory. For an existing/resumed session, `/gate status` or `/gate on` also triggers lazy registration when in-memory state is missing. Then check `gate-diag.log` for successful registration, a skipped subagent, rejected metadata, or a lookup failure. Does `<project-root>/.opencode/completion-gate.json` exist with `"enabled": true` and ≥1 assertion? Are you in the main session (not a subagent)? |
| Agent cannot read `.opencode/completion-gate.json` | If the project's `.opencode/` is a symlink/junction (e.g. worktree setups), opencode resolves it before permission checks — the read is evaluated against `permission.external_directory` using the canonical path, so the project's `opencode.json` must allow that canonical path. |
| Toggle does nothing / odd behavior | For a resumed session, run `/gate status` first to trigger or confirm lazy registration, then inspect `~/.config/opencode/gate-diag.log` (see [Diagnostics log](#diagnostics-log)) for successful registration, a skipped subagent, rejected metadata, or a lookup failure. |
| Gate keeps re-running while waiting for reviewers/comments on a PR | Those are human-review policies; set `"ignoreHumanPolicies": true` on the `ado-pr` assertion (see [ado-pr](#ado-pr)) or resolve them manually. |
| `/gate off` didn't stop the current run instantly | An already-started command/poll round finishes first; the abort lands at the next checkpoint and logs `gate turn-end ABORTED`. |
| `ado-pr` always fails | `az` must be installed and logged in (`az login`), and the org/project is derived from the git remote. Zero/multiple active PRs on the branch also fail (see `skipIfNoPr`). |
| Build log artifacts missing | Check the reported ZIP path and the `Build log artifact error:` line in the evidence, then `gate-diag.log`. No logs are downloaded while the build policy is still `queued` or `running` — only after a terminal failure; a retry cycle re-downloads for a newly failed build. |
| Review assertion fails with "no VERDICT line" | The reviewer agent didn't end with `VERDICT: PASS/FAIL`; inspect the captured output tail in the failure message or raise `timeoutSeconds`. |
| Commands hang or time out | Tune `timeoutSeconds` (default 300s); timeouts kill the whole process tree and count as failure. |
| Config changes not picked up | The file is re-read each turn end — verify the resolved path in `gate-diag.log` is the file you edited (when `.opencode/` is a symlink/junction, editing through either side hits the same file). |
