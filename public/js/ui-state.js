// The UI-state store (docs/API.md 10.4): drafts, collapsed panels, the last open page and UI preferences live
// on the server, encrypted with everything else — never in browser storage, which sits on disk in plain text.
// Only the theme is mirrored in localStorage (it must apply before the first paint, and is not user content).
//
// Keys are top-level: "prefs" (an object of UI preferences), "draft:<chatId|new>", "lastRoute".
import * as api from './api.js';
import { Emitter } from './lib/store.js';

let state = {};
let loaded = false;
const pendingSet = new Map();
const pendingRemove = new Set();
let timer = null;
let inflight = Promise.resolve();
export const uiStateEvents = new Emitter();

/** Called once after unlocking, before the app is built. */
export function initUiState(s) {
  state = s && typeof s === 'object' && !Array.isArray(s) ? { ...s } : {};
  loaded = true;
}

export const uiStateLoaded = () => loaded;

export function getUi(key, fallback = undefined) {
  return Object.prototype.hasOwnProperty.call(state, key) ? state[key] : fallback;
}

export function uiKeys(prefix = '') { return Object.keys(state).filter((k) => k.startsWith(prefix)); }

/** Set (or, with null/undefined/'' , remove) a key. Writes are batched; `immediate` sends at once. */
export function setUi(key, value, { immediate = false, delay = 400 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!(key in state) && !pendingSet.has(key)) return;
    delete state[key];
    pendingSet.delete(key);
    pendingRemove.add(key);
  } else {
    state[key] = value;
    pendingSet.set(key, value);
    pendingRemove.delete(key);
  }
  uiStateEvents.emit('change', key, value);
  if (!loaded) return; // nothing is sent before the store was read (it would replace newer values)
  clearTimeout(timer);
  if (immediate) flushUiState();
  else timer = setTimeout(() => flushUiState(), delay);
}

/** Send pending writes now. keepalive: the page is going away (small bodies only). */
export function flushUiState({ keepalive = false } = {}) {
  clearTimeout(timer);
  timer = null;
  if (!pendingSet.size && !pendingRemove.size) return inflight;
  const set = Object.fromEntries(pendingSet);
  const remove = [...pendingRemove];
  pendingSet.clear();
  pendingRemove.clear();
  // keepalive requests are limited to 64 KiB by browsers; a larger one is sent normally.
  const small = JSON.stringify(set).length < 48_000;
  const req = api.uiState.patch({ set, remove }, { keepalive: keepalive && small }).catch((e) => {
    // Put the writes back (unless something newer replaced them) so the next flush retries them.
    for (const [k, v] of Object.entries(set)) if (!pendingSet.has(k) && !pendingRemove.has(k)) pendingSet.set(k, v);
    for (const k of remove) if (!pendingSet.has(k)) pendingRemove.add(k);
    if (e?.status !== 423 && e?.status !== 401) {
      clearTimeout(timer);
      timer = setTimeout(() => flushUiState(), 3000);
    }
  });
  inflight = inflight.then(() => req, () => req);
  return inflight;
}

export const hasPendingUiState = () => pendingSet.size > 0 || pendingRemove.size > 0;

/** Forget everything held in memory (called when Harness locks). */
export function clearUiState() {
  clearTimeout(timer);
  state = {};
  pendingSet.clear();
  pendingRemove.clear();
  loaded = false;
}

// ------------------------------------------------------------------------------------------------ migration
/**
 * Harness 0.1 kept drafts and UI preferences in localStorage. Move them to the UI-state store (when it has no
 * newer value) and delete them from the browser, leaving only the theme.
 */
export function migrateBrowserStorage({ settingsUi } = {}) {
  let ls;
  try { ls = window.localStorage; } catch { return; }
  if (!ls) return;
  const keys = [];
  try { for (let i = 0; i < ls.length; i++) keys.push(ls.key(i)); } catch { return; }
  const prefs = { ...(getUi('prefs') || {}) };
  let prefsChanged = false;
  if (!getUi('prefs') && settingsUi && typeof settingsUi === 'object' && Object.keys(settingsUi).length) {
    Object.assign(prefs, settingsUi);
    prefsChanged = true;
  }
  for (const k of keys) {
    if (!k || !k.startsWith('harness.')) continue;
    if (k === 'harness.ui.theme' || k === 'harness.debug') continue;
    let raw = null;
    try { raw = ls.getItem(k); } catch { /* ignore */ }
    if (k.startsWith('harness.draft.')) {
      const id = k.slice('harness.draft.'.length);
      if (raw && !getUi(`draft:${id}`)) setUi(`draft:${id}`, raw);
    } else if (k.startsWith('harness.ui.')) {
      const name = k.slice('harness.ui.'.length);
      try { if (!(name in prefs) && raw != null) { prefs[name] = JSON.parse(raw); prefsChanged = true; } } catch { /* ignore */ }
    }
    try { ls.removeItem(k); } catch { /* ignore */ }
  }
  if (prefsChanged) setUi('prefs', prefs);
  try { sessionStorage.clear(); } catch { /* ignore */ }
}
