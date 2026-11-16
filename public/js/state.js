// Application state: one store with named slices, and loaders that keep them fresh from the API.
import { createStore, Emitter } from './lib/store.js';
import * as api from './api.js';
import { debounce } from './lib/dom.js';
import { registerModelNames } from './lib/format.js';

export const store = createStore({
  connection: 'connecting', // connecting | online | offline
  system: null, // GET /api/system
  settings: null,
  defaults: null,
  presets: [],
  models: null, // ModelListItem[] (null = not loaded)
  defaultModel: null,
  chats: null, // ChatSummary[] (not archived)
  archived: null, // ChatSummary[] (loaded when the archive is shown)
  route: { view: 'chat', chatId: null },
  pulls: {}, // pullId → { model, providerId, status, percent, completed, total, error, done }
  imageJobs: {}, // jobId → ImageJob-ish live state
  recommended: null,
  memoryCount: null,
});

/** Bus for app-level events that are not state (e.g. "focus composer"). */
export const bus = new Emitter();

export const uiPrefs = () => store.get('settings')?.ui || {};

// ------------------------------------------------------------------------------------------------ loaders
export async function loadSettings() {
  const { settings, defaults } = await api.settings.get();
  store.set('defaults', defaults);
  store.set('settings', settings);
  return settings;
}

export async function loadPresets() {
  const { presets } = await api.presets.list();
  store.set('presets', presets);
  return presets;
}

export async function loadSystem({ refresh = false } = {}) {
  const sys = await api.system.info({ refresh });
  store.set('system', sys);
  return sys;
}

export async function loadModels({ refresh = false } = {}) {
  const r = await api.models.list({ refresh, details: true });
  store.set('defaultModel', r.defaultModel);
  store.set('models', r.models);
  return r;
}

export async function loadChats() {
  const r = await api.chats.list({ limit: 1000 });
  store.set('chats', r.chats);
  return r.chats;
}

export async function loadArchived() {
  const r = await api.chats.list({ archived: 'true', limit: 1000 });
  store.set('archived', r.chats);
  return r.chats;
}

export async function loadRecommended() {
  const r = await api.models.recommended();
  // Teach the formatter the catalog's friendly names for every known variant.
  registerModelNames(r.models.flatMap((m) => m.variants.map((v) => [v.model, { name: m.name, tag: (v.label || '').replace(/\s*\(.*\)$/, '').replace(/^Default quant$/i, '') }])));
  store.set('recommended', r);
  return r;
}

export const refreshSystemSoon = debounce(() => loadSystem().catch(() => {}), 400);
export const refreshModelsSoon = debounce(() => loadModels({ refresh: true }).catch(() => {}), 400);
export const refreshChatsSoon = debounce(() => loadChats().catch(() => {}), 250);

/** Patch settings on the server; resolves to the new settings. Optimistically updates the store. */
export async function patchSettings(partial) {
  const { settings } = await api.settings.patch(partial);
  store.set('settings', settings);
  return settings;
}

/** settings.ui is free-form; merge a few keys without clobbering the rest. Layout toggles are debounced;
 *  appearance changes are sent at once. Requests use keepalive so a reload or quit doesn't drop them. */
let pendingUi = {};
const IMMEDIATE_UI = new Set(['theme', 'textSize', 'proseFont', 'sendKey']);
function sendUi() {
  const patch = pendingUi;
  pendingUi = {};
  if (!Object.keys(patch).length) return;
  api.settings.patch({ ui: { ...(store.get('settings')?.ui || {}), ...patch } }, { keepalive: true }).then(({ settings }) => {
    // Keep any local changes made while the request was in flight.
    store.set('settings', { ...settings, ui: { ...settings.ui, ...pendingUi } });
  }).catch(() => {});
}
const flushUi = debounce(sendUi, 350);
export function setUiPref(key, value) {
  const s = store.get('settings');
  if (!s) return;
  pendingUi[key] = value;
  store.set('settings', { ...s, ui: { ...(s.ui || {}), [key]: value } });
  try { localStorage.setItem(`harness.ui.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  if (IMMEDIATE_UI.has(key)) { flushUi.cancel(); sendUi(); } else flushUi();
}
export function flushUiPrefs() { flushUi.cancel(); sendUi(); }

export function localPref(key, fallback) {
  try { const v = localStorage.getItem(`harness.ui.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}

// ------------------------------------------------------------------------------------------------ derived
export function chatModels() {
  return (store.get('models') || []).filter((m) => !m.embedding && !(m.capabilities || []).every((c) => c === 'embedding'));
}

export function findModel(ref) {
  if (!ref) return null;
  return (store.get('models') || []).find((m) => m.model === ref.model && (!ref.providerId || m.providerId === ref.providerId)) || null;
}

export function sameRef(a, b) {
  return !!a && !!b && a.model === b.model && (a.providerId || null) === (b.providerId || null);
}

export function ollamaStatus() {
  const sys = store.get('system');
  const p = sys?.providers?.find((x) => x.id === 'ollama');
  return { provider: p || null, process: sys?.ollama || null, running: p?.status === 'running' };
}

export function imageProviders() {
  return store.get('system')?.imageProviders || [];
}

/** Model info + plan cache (GET /api/models/info) keyed by providerId|model. */
const infoCache = new Map();
export async function modelInfo(ref, { refresh = false } = {}) {
  if (!ref?.model) return null;
  const key = `${ref.providerId || ''}|${ref.model}`;
  if (!refresh && infoCache.has(key)) return infoCache.get(key);
  const p = api.models.info(ref).then((r) => {
    if (r?.info?.displayName) registerModelNames([[ref.model, { name: r.info.displayName.replace(/^NVIDIA\s+/, ''), tag: undefined }]]);
    return r;
  }).catch((e) => { infoCache.delete(key); throw e; });
  infoCache.set(key, p);
  return p;
}
export function dropModelInfo() { infoCache.clear(); }
