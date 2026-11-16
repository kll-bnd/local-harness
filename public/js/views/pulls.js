// Model downloads: pulls started in this window stream their own progress (and can be cancelled by
// closing the stream); pulls started elsewhere show up through the global `model.pull` bus events.
import * as api from '../api.js';
import { store, loadModels, loadRecommended, dropModelInfo, loadSystem } from '../state.js';
import { toast } from '../ui/overlays.js';
import { showError } from '../errors.js';
import { modelLabel } from '../lib/format.js';

const local = new Map(); // model → { controller, key }

function setPull(key, patch) {
  const pulls = { ...(store.get('pulls') || {}) };
  pulls[key] = { ...(pulls[key] || {}), ...patch, at: Date.now() };
  store.set('pulls', pulls);
}

function dropPull(key) {
  const pulls = { ...(store.get('pulls') || {}) };
  delete pulls[key];
  store.set('pulls', pulls);
}

/** Latest pull state for a model, or null once it finished a moment ago. */
export function pullFor(model) {
  const list = Object.values(store.get('pulls') || {}).filter((p) => p.model === model).sort((a, b) => b.at - a.at);
  const p = list[0];
  if (!p) return null;
  if (p.done && Date.now() - p.at > 3000) return null;
  return { ...p, local: local.has(model) };
}

export function activePulls() {
  return Object.values(store.get('pulls') || {}).filter((p) => !p.done);
}

export async function pullModel({ model, providerId, quiet = false }) {
  if (local.has(model)) return false;
  const controller = new AbortController();
  let key = `local:${model}:${Date.now()}`;
  local.set(model, { controller, key });
  setPull(key, { model, providerId: providerId || 'ollama', status: 'Starting…', percent: null, done: false });
  let failed = null;
  try {
    const r = await api.models.pull({ model, providerId }, (ev) => {
      if (ev.type === 'start') {
        dropPull(key);
        key = ev.pullId;
        local.get(model).key = key;
        setPull(key, { pullId: ev.pullId, model, providerId: ev.providerId, status: 'Starting…', percent: null, done: false });
      } else if (ev.type === 'progress') {
        setPull(key, { status: ev.status, percent: ev.percent, total: ev.total, completed: ev.completed, done: false });
      } else if (ev.type === 'done') {
        setPull(key, { status: 'success', percent: 100, done: true });
      } else if (ev.type === 'error') {
        failed = ev;
        setPull(key, { status: ev.code === 'aborted' ? 'aborted' : 'error', error: ev.message, done: true });
      }
    }, { signal: controller.signal });
    if (r.aborted) {
      setPull(key, { status: 'aborted', done: true });
      toast({ message: `Download of ${modelLabel(model)} cancelled`, id: `pull-${model}` });
      return false;
    } else if (failed) {
      toast({ kind: 'error', message: `Couldn't download ${modelLabel(model)}`, detail: failed.message, id: `pull-${model}` });
      return false;
    }
    if (!quiet) toast({ kind: 'success', message: `${modelLabel(model)} is ready`, id: `pull-${model}` });
    dropModelInfo();
    await Promise.allSettled([loadModels({ refresh: true }), loadRecommended(), loadSystem()]);
    return true;
  } catch (e) {
    setPull(key, { status: 'error', error: e.message, done: true });
    showError(e, `download ${modelLabel(model)}`);
    return false;
  } finally {
    local.delete(model);
    store.set('pulls', { ...(store.get('pulls') || {}) });
  }
}

export function cancelPull(model) {
  local.get(model)?.controller.abort();
}
