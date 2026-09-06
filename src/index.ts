/**
 * opencode-completion-gate — programmatic utils entry (`./utils` subpath).
 * The plugin entry (`src/plugin.ts`) stays default-export-only for OpenCode.
 */

export * from './core.js';

export const VERSION = '1.0.0';

export const pluginMeta = {
  name: 'opencode-completion-gate',
  version: VERSION,
  description:
    'Per-session quality gate that blocks declaring done until configured assertions pass',
} as const;
