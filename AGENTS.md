# AGENTS.md — opencode-completion-gate

npm plugin (ESM, Node >=18) implementing the `/gate` per-session quality gate.

## Layout (real entrypoints)

- `src/plugin.ts` — default-export-only OpenCode entry. The V2 loader reads the default export's `id`/`setup`; keep this file default-export-only.
- `src/gate.ts` — the `Plugin.define({ id: 'opencode.completion-gate', setup })` definition and all hook/event/command logic (session registry, toggles, turn-end gate flow).
- `src/core.ts` — programmatic facade re-exporting `./gate` plus the runner/config/ado-pr/review/process helpers for the `./utils` subpath and tests.
- `src/process.ts`, `src/config.ts`, `src/ado-pr.ts`, `src/review.ts`, `src/types.ts` — shell, config validation, ADO PR polling, reviewer assertion, shared types.
- `src/index.ts` — `./utils` subpath only (`export * from './core.js'` + `VERSION`).
- `tests/` — vitest suite; `tests/helpers.ts:startPlugin` builds a V2 `ctx` (event/command/session domains) backed by a V1-shaped mock client so tests drive `hooks.event` / `hooks['command.execute.before']` / `hooks['chat.message']` and assert on `session.promptAsync`/`tui.showToast`. `makeTempProject` builds tmp projects under `<tmpdir>/opencode/` with a `.git` file so `findGateConfigPath` stops there; `tests/fixtures/` holds sanitized `az` payloads.
- Docs trio (keep in sync on behavior change): `README.md` (install/quickstart), `completion-gate-plugin.md` (full spec), `skill/completion-gate-config/SKILL.md` (user-facing config guide).

## Commands

- `npm run build` — esbuild bundle (`dist/plugin.js`, `dist/index.js`) + `tsc` declarations. `dist/` is the published artifact.
- `npm test` — `vitest run` (dir `tests/`, 80% coverage thresholds). Single file: `npx vitest run tests/<name>.test.ts`.
- `npm run lint` / `npm run format:check` — eslint + prettier (2-space, single-quote, 100 col). CI order: `lint → build → test` on Node 18/20/22.
- `prepublishOnly` runs `clean + lint + build + test`; don't bypass it.

## Gotchas agents miss

- **V2-only.** Targets `@opencode/plugin` ≥ 2.0 (`Plugin.define({ id, setup })`). There is no V1 `@opencode-ai/plugin` usage; don't reintroduce it.
- Config validation is all-or-nothing: unknown `type`, `command` without `run`, empty/missing `assertions`, malformed JSON → `loadGateConfig` returns null and the gate silently skips. Non-positive numbers fall back to defaults instead of erroring.
- Shell: `buildShellInvocation` routes through `cmd.exe /d /s /c` on win32 with `windowsVerbatimArguments`; `execShell` args must be operator-controlled tokens only. `runCommand` tree-kills via `taskkill`; `execFileOut` timeout kills only the direct child.
- V2 server plugins have **no toast surface** (`ui.toast` exists only for TUI plugins). Gate feedback (status/armed/off/escalation) goes through `ctx.session.synthetic(...)`; the retry/success injection uses `ctx.session.prompt(...)` (the direct successor of V1 `promptAsync`, which guarantees an agent turn). Both are logged via `logDiag` to `gate-diag.log`.
- `/gate` is a plugin-owned command registered with `ctx.command.transform`; there is no `command.execute.before` global hook in V2, so non-`gate` commands are simply not ours. Turn end is `ctx.event.subscribe()` → **`session.execution.succeeded`** (verified live: this core version does not emit `session.idle`, which is still handled defensively); lifecycle is `session.created`/`session.deleted`. The fix-cycle reset + legacy `[completion-gate-internal]` directive live in `ctx.session.hook("prompt", …)`.
- **One plugin instance per location.** OpenCode V2 evaluates the plugin module once per location, so one process runs several instances (each receives the whole server event stream). The gate keeps its session registry/retry budget/bootstrap on `globalThis` (a `Symbol.for('opencode.completion-gate.runtime.v2')` runtime) so all instances share one state, and dedupes events by event id so each event is handled once. Registration + bootstrap-arming are lazy on first turn end, since a session's `session.created` can be missed.
- Status message format is `Completion gate: ENABLED · retries=n · lastOutcome=... · extraCommand=... · mode=...` — never print the command contents.
- Only `[completion-gate-internal] --only <command>` is handled as a legacy directive; a bare internal marker is ignored.
- `tests/shell.test.ts` "real Windows cmd shim" test can time out (5s) on Windows — rerun the single file before assuming a regression.
- Release: release-please on push to `main` (Conventional Commits; `docs:`/`chore:` release nothing). The V2 port is a `feat!:` so release-please proposes 2.0.0. Merge the auto-generated `chore(main): release` PR to tag + publish to npm with provenance. Never hand-bump `package.json` version.
