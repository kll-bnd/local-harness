'use strict';
// Desktop-shell constants and the small user-editable config file (<data dir>/desktop.json).
const fs = require('node:fs');
const path = require('node:path');

/** Actions the native menu sends to the page (window.harnessDesktop.onMenuAction). Agreed with the UI. */
const MENU_ACTIONS = Object.freeze([
  'new-chat', 'open-settings', 'toggle-sidebar', 'toggle-inspector', 'search-chats', 'command-palette',
  'open-models', 'open-images', 'open-memory', 'focus-composer', 'stop-generation', 'export-chat',
  'import-chat', 'show-shortcuts',
]);

const DEFAULT_PORT = 4747;

// ⌘⇧Space: not one of macOS's built-in shortcuts (Spotlight is ⌘Space, Finder search ⌥⌘Space,
// input sources ⌃Space / ⌃⌥Space, Character Viewer ⌃⌘Space) and it does not type a character
// (⌥Space types a non-breaking space; ⌃⌥ is VoiceOver's modifier). On Linux it is Ctrl+Shift+Space.
const DEFAULT_GLOBAL_SHORTCUT = 'CommandOrControl+Shift+Space';

const DEFAULT_DESKTOP_CONFIG = Object.freeze({
  // Shortcut that shows/hides the Harness window from any app. Electron accelerator syntax
  // (https://www.electronjs.org/docs/latest/api/accelerator). null or "" disables it.
  globalShortcut: DEFAULT_GLOBAL_SHORTCUT,
  // Preferred port for the built-in server (the next free one is used if it is busy).
  port: DEFAULT_PORT,
  // macOS: closing the window hides it (the app keeps running in the Dock; ⌘Q quits).
  hideOnClose: true,
});

const ACCELERATOR_RE = /^[A-Za-z0-9+\-=[\];',./\\`]+$/;

/** Validate a parsed desktop.json; unknown keys are ignored, bad values fall back to defaults. */
function normalizeDesktopConfig(raw) {
  const out = { ...DEFAULT_DESKTOP_CONFIG };
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) warnings.push('desktop.json is not a JSON object; using defaults');
    return { config: out, warnings };
  }
  if ('globalShortcut' in raw) {
    const v = raw.globalShortcut;
    if (v === null || v === false || v === '') out.globalShortcut = null;
    else if (typeof v === 'string' && v.length <= 64 && ACCELERATOR_RE.test(v) && v.includes('+')) out.globalShortcut = v;
    else warnings.push(`globalShortcut ${JSON.stringify(v)} is not a valid accelerator (e.g. "CommandOrControl+Shift+Space"); using the default`);
  }
  if ('port' in raw) {
    const v = raw.port;
    if (Number.isInteger(v) && v >= 1024 && v <= 65535) out.port = v;
    else warnings.push(`port ${JSON.stringify(v)} must be an integer 1024-65535; using ${DEFAULT_PORT}`);
  }
  if ('hideOnClose' in raw) {
    if (typeof raw.hideOnClose === 'boolean') out.hideOnClose = raw.hideOnClose;
    else warnings.push('hideOnClose must be true or false');
  }
  return { config: out, warnings };
}

/** Read <data dir>/desktop.json, creating it with the defaults on first run so it is discoverable. */
function loadDesktopConfig(file, { env = process.env } = {}) {
  let raw;
  const warnings = [];
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(DEFAULT_DESKTOP_CONFIG, null, 2) + '\n');
      } catch { /* read-only data dir: run with defaults */ }
    } else {
      warnings.push(`Could not read ${file}: ${e.message}; using defaults`);
    }
  }
  const res = normalizeDesktopConfig(raw);
  res.warnings.unshift(...warnings);
  // Environment overrides (handy for development and tests).
  if (env.HARNESS_PORT) {
    const p = Number(env.HARNESS_PORT);
    if (Number.isInteger(p) && p >= 0 && p <= 65535) res.config.port = p;
  }
  if (env.HARNESS_GLOBAL_SHORTCUT !== undefined) {
    const n = normalizeDesktopConfig({ globalShortcut: env.HARNESS_GLOBAL_SHORTCUT });
    if (!n.warnings.length) res.config.globalShortcut = n.config.globalShortcut;
  }
  return res;
}

module.exports = { MENU_ACTIONS, DEFAULT_PORT, DEFAULT_GLOBAL_SHORTCUT, DEFAULT_DESKTOP_CONFIG, normalizeDesktopConfig, loadDesktopConfig };
