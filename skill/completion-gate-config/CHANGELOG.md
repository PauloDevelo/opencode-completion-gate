# completion-gate-config - version history

> The SKILL.md body is injected into context on every load; keep the history
> here. Maintained via the @skill-feedback / session-retro workflow.
> NOTE: this skill directory is a junction to the `oc-completion-gate-plugin`
> repository (`skill/completion-gate-config/`), so entries land in that repo.

### 2.2.0 (2026-11-17)

- `ado-pr` no longer reports a terminal policy failure while the CI build is
  still running. Any required policy in `queued`/`running` now keeps the whole
  policy set retryable, so a `rejected` automated policy that is only a stale
  evaluation from the previous run (typically the blocking SonarQube `Status`
  policy with `invalidateOnSourceUpdate: false`) is re-evaluated instead of
  failing the gate. Terminality is judged only once nothing is in progress.
- Updated the `ado-pr` polling semantics in the assertion reference and added
  the troubleshooting row for `Status: rejected` while the build is running.
- Evidence: PAEM PR !64335 failed the gate with `PR !64335 has terminal policy
  failure` and the policy list `Status: rejected; Build: running`, while
  `az repos pr policy list` showed the SonarQube `Status` policy rejected from
  the previous run and `Aquadvanced.PAEM-CI` #421463 running. The same PR
  minutes later showed `Status: approved`.

### 2.1.0 (2026-11-06)

- Added the "Review loop (`opencode-review`)" section: one isolated reviewer
  session per round (new sessions start gate-disabled, so it cannot recurse),
  tail-only evidence (last 50 non-empty lines) injected as the fix request,
  bounded retries through `maxRetries`, placement after the fast `command`
  assertions and before `ado-pr`, and the two prompt constraints (condensed
  blocking list last, "PASS with minor findings" expressed in the prompt text
  rather than as a third verdict state). Live in `AquadvancedEnergy` and
  `EM2S` as `self-review`.
- Added gotcha 8: `command` failure evidence is a tail slice, so give the
  assertion a durable artifact (`dotnet test --logger "trx;LogFileName=gate.trx"`)
  or split one assertion per test project. `gate-diag.log` is shared by every
  concurrent session and records verdicts only, never the command output.
- Validation & Testing step 3 now points at gotcha 8.

### 2.0.1 (2026-10-23)

- Added gotcha 8: `command` failure evidence injected into the session is a
  tail slice (~last 50 lines), so a multi-project `dotnet test` can lose the
  failing-test summary to the head truncation (`[... 140 earlier lines
  omitted]`). Remedy documented: `--logger "trx;LogFileName=gate.trx"` on
  `dotnet test`, or one assertion per test project.
- Added the same entry's second half: `gate-diag.log` is shared by every
  concurrent session and records verdicts only (`assertion "<name>" FAILED -
  exit code N`, config path, retries), never the assertion's command output —
  filter by your own `ses_...` id and do not expect stdout there.
- Amended "Validation & Testing" step 3 to point at gotcha 8.
- Evidence: ses_e9da8c5b8ffeu2Fi2eFrEvmb3F (gate message head-truncated;
  `gate-diag.log` tail showed only the verdict plus interleaved lines from
  ses_ea015960dffe1NuMPO1M71avVl). Batch retro 2026-10-23 via @skill-feedback.

### 2.0.0

- Previous state (pre-changelog): schema reference, three assertion types,
  stack recipes and gotchas 1-7. No version history was kept before 2.0.1.
