# opencode-completion-gate

[![npm version](https://img.shields.io/npm/v/opencode-completion-gate.svg)](https://www.npmjs.com/package/opencode-completion-gate)
[![CI](https://github.com/PauloDevelo/opencode-completion-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/PauloDevelo/opencode-completion-gate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Per-session quality gate that blocks an agent from declaring a task "done" until configured assertions pass (build green, unit tests green, PR policies green, LLM self-review…).

## Installation

```bash
npm install opencode-completion-gate
```

Add the plugin to your OpenCode configuration:

**opencode.json:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-completion-gate"]
}
```

## Quick start

1. Instruct the agent: *"Fix X until completion."*
2. Type `/gate` (enables the gate for this session).
3. The agent works; each time it goes idle the gate runs your assertions.
4. All pass → `✅ Completion gate passed (...)` appears once and the agent may report done.
5. Something fails → the agent is re-prompted with the failure evidence and keeps fixing until it passes or hits the retry cap.
6. `/gate off` when you're done.

```
/gate          # enable (same as /gate on)
/gate status   # e.g. "Completion gate: ENABLED · retries=1 · lastOutcome=fail · extraCommand=none · mode=combined · maxRetries=3 (config)"
/gate off      # disable for this session
/gate --only "npm run test-ci" --retries 5  # run only this command with its own retry cap
```

## Configuration

Config lives per project at `<project-root>/.opencode/completion-gate.json` (re-read on every gated turn end):

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

Assertion types: `command`, `ado-pr`, `opencode-review`. See [completion-gate-plugin.md](completion-gate-plugin.md) for the full schema, ADO PR polling, review sessions, diagnostics (`gate-diag.log`), and troubleshooting.
