/**
 * opencode-completion-gate — Minimal Entry Point
 *
 * This file exports ONLY the plugin function for OpenCode compatibility.
 * OpenCode iterates over all exports and calls them as plugin functions,
 * so we must not export anything else here.
 *
 * For utility functions and types, import from 'opencode-completion-gate/utils'.
 */

// opencode v1.x treats EVERY module-level export of a plugin file as a
// plugin factory and invokes it (getLegacyPlugins), so this entry file must
// default-export the plugin and nothing else. All implementation code and
// test-facing exports live in ./core (subdirectories are not scanned as
// plugin origins).
import gate from './core.js';

export default gate;
