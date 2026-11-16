// Guided model setup for small Macs: download a recommended file → make a text-only copy (same weights without
// the vision/audio projector: ~1 GB less memory, can't read images, ~2 s, nothing to download) → optionally
// remove the original download to reclaim disk space. Shared by the setup page and Models.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { fmtBytes, modelShort, modelLabel } from '../lib/format.js';
import * as api from '../api.js';
import { store, findModel, loadModels, loadRecommended, loadSystem, patchSettings, dropModelInfo } from '../state.js';
import { pullModel, pullFor } from './pulls.js';
import { toast, confirmDialog } from '../ui/overlays.js';
import { showError } from '../errors.js';

const busy = new Map(); // source model → 'download' | 'copy' | 'remove'
const setBusy = (m, v) => { if (v) busy.set(m, v); else busy.delete(m); store.set('recommended', store.get('recommended') ? { ...store.get('recommended') } : null); };

async function refresh() {
  dropModelInfo();
  await Promise.allSettled([loadModels({ refresh: true }), loadRecommended(), loadSystem()]);
}

/** Make the text-only copy of an installed model; makes it the default if none was chosen yet. */
export async function makeTextOnlyCopy(sourceModel, { providerId = 'ollama', setDefault = 'if-unset' } = {}) {
  setBusy(sourceModel, 'copy');
  try {
    const r = await api.models.createTextOnly({ model: sourceModel, providerId });
    await refresh();
    const ref = { providerId: r.providerId, model: r.model };
    const s = store.get('settings');
    let madeDefault = false;
    if (setDefault === true || (setDefault === 'if-unset' && !s?.defaultModel)) { await patchSettings({ defaultModel: ref }); await loadModels(); madeDefault = true; }
    toast({
      kind: 'success',
      message: r.created === false ? 'The text-only copy already exists' : `Text-only copy ready: ${modelShort(r.model, 36)}`,
      detail: `${madeDefault ? 'It is now your default model. ' : ''}It can't read images. ${r.sourceSizeBytes ? `The original (${fmtBytes(r.sourceSizeBytes)}) can be removed to reclaim disk space.` : ''}`,
      action: findModel({ model: sourceModel }) ? { label: 'Remove original', run: () => removeOriginal(sourceModel, { providerId }) } : null,
      timeout: 12000,
      id: `copy-${sourceModel}`,
    });
    return r;
  } catch (e) { showError(e, 'make the text-only copy'); return null; } finally { setBusy(sourceModel, null); }
}

/** Download (if needed) then make the text-only copy — the one-click path recommended on 8 GB. */
export async function downloadThenCopy(sourceModel) {
  if (!findModel({ model: sourceModel })) {
    setBusy(sourceModel, 'download');
    const ok = await pullModel({ model: sourceModel, quiet: true });
    setBusy(sourceModel, null);
    if (!ok) return null;
  }
  return makeTextOnlyCopy(sourceModel);
}

export async function removeOriginal(sourceModel, { providerId = 'ollama' } = {}) {
  const m = findModel({ model: sourceModel });
  const ok = await confirmDialog({ title: 'Remove the original download?', message: `${modelLabel(sourceModel)}${m?.sizeBytes ? ` (${fmtBytes(m.sizeBytes)})` : ''} is no longer needed for chatting — the text-only copy has its own reference to the same weights. You lose image input with this file; you can download it again any time.`, confirmLabel: 'Remove', danger: true });
  if (!ok) return;
  setBusy(sourceModel, 'remove');
  try { await api.models.remove({ providerId, model: sourceModel }); await refresh(); toast({ kind: 'success', message: 'Original removed', detail: 'Disk space reclaimed.' }); } catch (e) { showError(e, 'remove the original'); } finally { setBusy(sourceModel, null); }
}

/**
 * The guided flow for one recommended variant whose text-only copy is recommended on this machine.
 * Renders the three steps with their state and the single next action.
 */
export function textOnlyFlow(v) {
  const t = v.textOnly;
  const originalInstalled = !!findModel({ model: v.model });
  const copyInstalled = !!t.installed || !!findModel({ model: t.model });
  const pull = pullFor(v.model);
  const state = busy.get(v.model);
  const def = store.get('defaultModel');
  const isDefault = def?.model === t.model;
  const step = (done, active, label, sub) => h('li', { class: { done, active } }, h('span.job-dot', done ? icon('check', { size: 11 }) : active ? h('span.spinner.small') : null), h('span', h('span', label), sub ? h('span.faint', ` — ${sub}`) : null));
  const downloading = state === 'download' || (pull && !pull.done);
  const steps = h('ol.job-steps.flow-steps',
    step(originalInstalled || copyInstalled, downloading, `Download ${fmtBytes(v.approxSizeBytes)}`, downloading && pull?.percent != null ? `${Math.round(pull.percent)}%` : null),
    step(copyInstalled, state === 'copy', 'Make a text-only copy', 'a few seconds, nothing to download'),
    step(copyInstalled && !originalInstalled, state === 'remove', 'Remove the original', 'optional, frees disk space'));
  let action = null;
  if (!copyInstalled && !state && !downloading) {
    action = h('button.btn.btn-small.btn-primary', { type: 'button', on: { click: () => (originalInstalled ? makeTextOnlyCopy(v.model) : downloadThenCopy(v.model)) } }, icon(originalInstalled ? 'file' : 'download', { size: 13 }), originalInstalled ? 'Make text-only copy' : 'Download & set up');
  } else if (copyInstalled && !state) {
    action = h('div.row',
      !isDefault ? h('button.btn.btn-small.btn-primary', { type: 'button', on: { click: async () => { try { await patchSettings({ defaultModel: { providerId: 'ollama', model: t.model } }); await loadModels(); toast({ kind: 'success', message: `Default model: ${modelShort(t.model, 40)}` }); } catch (e) { showError(e); } } } }, 'Make default') : h('span.badge.outline', 'default'),
      originalInstalled ? h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: () => removeOriginal(v.model) } }, 'Remove original') : null);
  }
  return h('div.flow',
    h('div.flow-head.small', icon('info', { size: 13 }), h('span', `Recommended here as a text-only copy: same model, about 1 GB less memory (${fmtBytes(t.approxSizeBytes)}), but it can't read images.`)),
    steps,
    downloading && pull ? h('div.progress', h('span', { style: { width: `${pull.percent || 0}%` } })) : null,
    action);
}
