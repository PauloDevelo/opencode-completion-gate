# Changelog

## [1.3.0](https://github.com/PauloDevelo/opencode-completion-gate/compare/v1.2.0...v1.3.0) (2026-09-09)


### Features

* preserve active agent after feedback in completion gate ([#8](https://github.com/PauloDevelo/opencode-completion-gate/issues/8)) ([77814c9](https://github.com/PauloDevelo/opencode-completion-gate/commit/77814c98685e9babc8a30d413b81ebac8781a8a9))

## [1.2.0](https://github.com/PauloDevelo/opencode-completion-gate/compare/v1.1.1...v1.2.0) (2026-09-06)


### Features

* add completion-gate command creator skill ([#6](https://github.com/PauloDevelo/opencode-completion-gate/issues/6)) ([843c9ec](https://github.com/PauloDevelo/opencode-completion-gate/commit/843c9ec80498bb233631ea241bee976e5573d7d9))

## [1.1.1](https://github.com/PauloDevelo/opencode-completion-gate/compare/v1.1.0...v1.1.1) (2026-09-06)


### Bug Fixes

* parse equals-form retry overrides ([7473ee7](https://github.com/PauloDevelo/opencode-completion-gate/commit/7473ee770af1e8cf21a00e54fd3fe7d7251dd66e))

## [1.1.0](https://github.com/PauloDevelo/opencode-completion-gate/compare/v1.0.0...v1.1.0) (2026-09-06)


### Features

* per-command max retries for /gate --only ([addc6ad](https://github.com/PauloDevelo/opencode-completion-gate/commit/addc6ad97f2ed154d448119ff63049683dd89b5c))


### Bug Fixes

* add AGENTS.md + /gate command ([0bfe0b7](https://github.com/PauloDevelo/opencode-completion-gate/commit/0bfe0b7bd1aadcc492524ee82940ff0cb4395e0f))
* normalize repository URL per npm pkg fix ([b3bef58](https://github.com/PauloDevelo/opencode-completion-gate/commit/b3bef58bf69672ff2070d1c07c447b7914a73b48))

## 1.0.0 (2026-09-06)


### Features

* standard npm layout for opencode-completion-gate ([221f69c](https://github.com/PauloDevelo/opencode-completion-gate/commit/221f69c41a680fe6143a383252396e69ba27518e))


### Bug Fixes

* create tmp opencode dir in test helper for fresh CI runners ([36be834](https://github.com/PauloDevelo/opencode-completion-gate/commit/36be834ed69becee4b2fa4690f695d32827ae877))

## 1.0.0

- Initial public release of `opencode-completion-gate`.
- Per-session quality gate (`/gate`) with `command`, `ado-pr`, and `opencode-review` assertions.
