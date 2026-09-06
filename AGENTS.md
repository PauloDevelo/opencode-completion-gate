# AGENTS.md — opencode-completion-gate

npm plugin (ESM, Node >=18) implementing the `/gate` per-session quality gate.

## Layout (real entrypoints)

- `src/plugin.ts` — default-export-only OpenCode entry. OpenCode's legacy loader invokes **every** module-level export as a plugin factory, so never add named exports here.
- `src/core.ts` — all logic + test-facing exports (config validation, runners, `ado-pr`, `opencode-review`, hooks).
- `src/index.ts` — `./utils` subpath only (`export * from './core.js'` + `VERSION`).
- `tests/` — vitest suite; `tests/helpers.ts:makeTempProject` builds tmp projects under `<tmpdir>/opencode/` with a `.git` file so `findGateConfigPath` stops there; `tests/fixtures/` holds sanitized `az` payloads.
- Docs trio (keep in sync on behavior change): `README.md` (install/quickstart), `completion-gate-plugin.md` (full spec), `skill/completion-gate-config/SKILL.md` (user-facing config guide).

## Commands

- `npm run build` — esbuild bundle (`dist/plugin.js`, `dist/index.js`) + `tsc` declarations. `dist/` is the published artifact.
- `npm test` — `vitest run` (dir `tests/`, 80% coverage thresholds). Single file: `npx vitest run tests/<name>.test.ts`.
- `npm run lint` / `npm run format:check` — eslint + prettier (2-space, single-quote, 100 col). CI order: `lint → build → test` on Node 18/20/22.
- `prepublishOnly` runs `clean + lint + build + test`; don't bypass it.

## Gotchas agents miss

- Config validation is all-or-nothing: unknown `type`, `command` without `run`, empty/missing `assertions`, malformed JSON → `loadGateConfig` returns null and the gate silently skips. Non-positive numbers fall back to defaults instead of erroring.
- Shell: `buildShellInvocation` routes through `cmd.exe /d /s /c` on win32 with `windowsVerbatimArguments`; `execShell` args must be operator-controlled tokens only. `runCommand` tree-kills via `taskkill`; `execFileOut` timeout kills only the direct child.
- Status toast format is `Completion gate: ENABLED · retries=n · lastOutcome=... · extraCommand=... · mode=...` — never print the command contents.
- Only `[completion-gate-internal] --only <command>` is handled as a legacy directive; a bare internal marker is ignored.
- `tests/shell.test.ts` "real Windows cmd shim" test can time out (5s) on Windows — rerun the single file before assuming a regression.
- Release: release-please on push to `main` (Conventional Commits; `docs:`/`chore:` release nothing). Merge the auto-generated `chore(main): release` PR to tag + publish to npm with provenance. Never hand-bump `package.json` version.
