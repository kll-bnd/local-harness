// Application state: one store with named slices, and loaders that keep them fresh from the API.
import { createStore, Emitter } from './lib/store.js';
import * as api from './api.js';
import { debounce } from './lib/dom.js';
import { registerModelNames } from './lib/format.js';
import { getUi, setUi, flushUiState } from './ui-state.js';

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
  uiPrefs: getUi('prefs', {}) || {}, // UI preferences (theme, layout, …), kept in the UI-state store
  security: null, // GET /api/security (state, mode, recoveryKey, idleLockMinutes, session, offlineLock)
  network: null, // offlineLock status (GET /api/network, network.status events)
  ollamaStart: null, // { phase: 'starting' | 'waiting_for_gpu', since } while Harness starts its Ollama (ollama.status events)
});

/** Bus for app-level events that are not state (e.g. "focus composer"). */
export const bus = new Emitter();

export const uiPrefs = () => store.get('uiPrefs') || {};

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
  const tagOf = (v) => (v.label || '').replace(/\s*\(.*\)$/, '').replace(/^Default quant$/i, '');
  registerModelNames(r.models.flatMap((m) => m.variants.flatMap((v) => [
    [v.model, { name: m.name, tag: tagOf(v) }],
    ...(v.textOnly?.model ? [[v.textOnly.model, { name: m.name, tag: `${tagOf(v) ? `${tagOf(v)} ` : ''}text-only` }]] : []),
  ])));
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

/**
 * UI preferences live in the UI-state store (docs/API.md 10.4), never in browser storage. Layout toggles are
 * batched; appearance changes are sent at once. Only the theme is mirrored in localStorage, to paint the first
 * frame in the right colours.
 */
const IMMEDIATE_UI = new Set(['theme', 'textSize', 'proseFont', 'sendKey']);
export function setUiPref(key, value) {
  const prefs = { ...uiPrefs(), [key]: value };
  store.set('uiPrefs', prefs);
  setUi('prefs', prefs, { immediate: IMMEDIATE_UI.has(key) });
}
export function flushUiPrefs({ keepalive = true } = {}) { return flushUiState({ keepalive }); }

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

/** A plain sentence for Harness's Ollama while it starts, or null. */
export function ollamaStartText(long = false) {
  const st = store.get('ollamaStart');
  if (!st) return null;
  if (st.phase === 'waiting_for_gpu') {
    return long
      ? 'Ollama is starting and waiting for the GPU — another app (for example Draw Things) is probably loading a model. Harness carries on as soon as Ollama is ready.'
      : 'Ollama is waiting for the GPU…';
  }
  return long ? 'Harness is starting Ollama…' : 'Starting Ollama…';
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
    if (r?.info?.displayName) registerModelNames([[ref.model, { name: r.info.displayName, tag: undefined }]], { overwrite: false });
    return r;
  }).catch((e) => { infoCache.delete(key); throw e; });
  infoCache.set(key, p);
  return p;
}
export function dropModelInfo() { infoCache.clear(); }
