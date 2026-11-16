// Models: what is loaded right now (and unload), installed models with details, downloads with
// progress/cancel, pull by name, the recommended list for this machine, and embedding models.
import { h, mount, add, copyText } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { fmtBytes, fmtTokens, modelLabel, modelShort, fmtUntil, fmtWhen, plural } from '../lib/format.js';
import { store, loadModels, loadSystem, loadRecommended, patchSettings, sameRef, dropModelInfo } from '../state.js';
import * as api from '../api.js';
import { pullModel, pullFor, activePulls, cancelPull } from './pulls.js';
import { recCard, pullProgress } from './setup.js';
import { makeTextOnlyCopy } from './model-flows.js';
import { openDialog, confirmDialog, toast, openMenu } from '../ui/overlays.js';
import { showError } from '../errors.js';
import { runAction } from '../actions.js';

export class ModelsView {
  constructor(shell) {
    this.shell = shell;
    this.page = h('div.page.models-page');
    this.scroller = h('div.view-scroll', this.page);
    this.el = h('div.view', this.scroller);
    this.busy = new Set();
    store.watch(['models', 'system', 'recommended', 'pulls', 'defaultModel', 'settings'], () => this.render());
    this.scroller.addEventListener('scroll', () => this.shell.setScrolled(this.scroller.scrollTop > 4), { passive: true });
  }

  show() {
    api.models.textOnlyCopies().then((r) => { this.copies = r.copies || []; this.render(); }).catch(() => {});
    this.render();
    loadModels({ refresh: true }).catch(() => {});
    loadSystem().catch(() => {});
    loadRecommended().catch(() => {});
  }

  toolbar() { return { title: h('div.tb-title.page-title', h('span.title-text', 'Models')), actions: [h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: () => runAction('refresh-backends') } }, icon('reload', { size: 13 }), 'Refresh')] }; }

  render() {
    const models = store.get('models');
    const sys = store.get('system');
    const loaded = sys?.loadedModels || [];
    const def = store.get('defaultModel');
    const explicitDefault = store.get('settings')?.defaultModel;
    const pulls = activePulls();
    const rec = store.get('recommended');
    const providers = sys?.providers || [];
    const canPull = providers.some((p) => p.capabilities?.pull && p.status === 'running');

    const loadedSec = h('section.panel-section',
      h('div.section-head', h('h2.h2', 'In memory now'), sys?.machine ? h('span.muted.small.num', `${fmtBytes(loaded.reduce((n, m) => n + (m.vramBytes || m.sizeBytes || 0), 0))} of ${fmtBytes(sys.machine.memoryBudget.budgetBytes)} model budget`) : null),
      sys?.modelState?.unloadedForImage ? h('div.callout.warn', icon('info'), h('div', h('b', 'The chat model was unloaded to generate an image. '), 'It reloads automatically with your next message.')) : null,
      loaded.length ? h('div.list', loaded.map((m) => h('div.list-row',
        h('span.dot.ok'),
        h('div.grow', h('div', h('b', modelLabel(m.model)), h('span.faint', ` · ${m.providerId}`)), h('div.small.muted.num', [fmtBytes(m.vramBytes || m.sizeBytes), m.contextLength ? `${fmtTokens(m.contextLength)} context` : null, m.expiresAt ? `loaded ${fmtUntil(m.expiresAt)}` : null].filter(Boolean).join(' · '))),
        h('button.btn.btn-small', { type: 'button', disabled: this.busy.has(`unload:${m.model}`), on: { click: () => this.unload(m) } }, icon('eject', { size: 13 }), 'Unload'))))
        : h('p.muted', 'No model is loaded. The chat model loads with your next message (the first reply takes a little longer).'));

    const downloads = pulls.length ? h('section.panel-section', h('h2.h2', 'Downloading'), h('div.list', pulls.map((p) => h('div.list-row', h('div.grow', h('b', modelLabel(p.model)), pullProgress({ ...p, local: !!pullFor(p.model)?.local })))))) : null;

    let installed;
    if (!models) installed = h('p.muted', h('span.spinner.small'), ' Loading…');
    else if (!models.length) installed = h('div.empty', icon('cube', { size: 22 }), h('div.empty-title', 'No models installed'), h('div', 'Download one of the recommended models below.'));
    else {
      const byProv = new Map();
      for (const m of models) { if (!byProv.has(m.providerName)) byProv.set(m.providerName, []); byProv.get(m.providerName).push(m); }
      installed = h('div.stack-lg', [...byProv].map(([prov, ms]) => h('div',
        byProv.size > 1 ? h('h3.section-title', prov) : null,
        h('div.table-wrap', h('table.table.models-table',
          h('thead', h('tr', h('th', 'Model'), h('th.hide-narrow', 'Size'), h('th', 'Context'), h('th.hide-narrow', 'Abilities'), h('th', h('span.sr-only', 'Actions')))),
          h('tbody', ms.map((m) => {
            const isDef = sameRef(def, m) || (def && !def.providerId && def.model === m.model);
            const caps = m.capabilities || [];
            const prov = providers.find((p) => p.id === m.providerId);
            const isCopy = (this.copies || []).some((c) => c.model === m.model) || /-text:/.test(m.model);
            const multimodal = (caps.includes('vision') || caps.includes('audio')) && m.providerId === 'ollama' && !isCopy;
            return h('tr', { dataset: { model: m.model } },
              h('td', h('div.row', m.loaded ? h('span.dot.ok', { title: 'Loaded' }) : h('span.dot', { title: 'Not loaded' }), h('div.grow', h('div.model-name', { title: m.model }, modelLabel(m.name)), m.model.length > 28 ? h('div.faint.small.mono.ellipsis.model-id', { title: m.model }, m.model) : null, h('div.faint.small', [m.parameterSize, m.quantization, m.family].filter(Boolean).join(' · '))),
                isCopy ? h('span.badge', { title: 'Same weights without the image/audio part: about 1 GB less memory, cannot read images' }, 'text-only') : null,
                isDef ? h('span.badge.accent', { title: explicitDefault ? 'Default model' : 'Chosen automatically' }, explicitDefault ? 'default' : 'default (auto)') : null)),
              h('td.hide-narrow.num', fmtBytes(m.sizeBytes)),
              h('td.num', m.contextLength ? fmtTokens(m.contextLength) : '—'),
              h('td.hide-narrow', h('div.row-wrap.caps', m.embedding || caps.includes('embedding') ? h('span.badge', 'embedding') : null, caps.includes('tools') ? h('span.badge', 'tools') : null, caps.includes('thinking') ? h('span.badge', 'thinking') : null, caps.includes('vision') ? h('span.badge', 'vision') : null)),
              h('td.actions', h('div.row',
                h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: () => this.details(m) } }, 'Details'),
                h('button.icon-btn.small', { type: 'button', title: 'More', 'aria-label': `More actions for ${m.model}`, 'aria-haspopup': 'menu', on: { click: (e) => openMenu(e.currentTarget, [
                  !m.embedding && !isDef ? { label: 'Make default', icon: 'check', run: () => this.makeDefault(m) } : null,
                  multimodal ? { label: 'Make a text-only copy', hint: '−1 GB RAM, no images', icon: 'file', run: () => makeTextOnlyCopy(m.model, { providerId: m.providerId, setDefault: false }) } : null,
                  m.providerId === 'ollama' ? { label: m.loaded ? 'Unload from memory' : 'Load now', icon: m.loaded ? 'eject' : 'play', run: () => (m.loaded ? this.unload(m) : this.load(m)) } : null,
                  { label: 'Copy model id', icon: 'copy', run: () => copyText(m.model) },
                  prov?.capabilities?.delete ? { separator: true } : null,
                  prov?.capabilities?.delete ? { label: 'Delete…', icon: 'trash', danger: true, run: () => this.remove(m) } : null,
                ].filter(Boolean), { placement: 'bottom-end', label: 'Model actions' }) } }, icon('more', { size: 14 })))));
          })))))));
    }

    const name = h('input.input', { placeholder: 'e.g. qwen3:4b or hf.co/user/repo:Q4_K_M', attrs: { 'aria-label': 'Model to download' } });
    const pullBtn = h('button.btn', { type: 'button', disabled: !canPull, on: { click: () => { const v = name.value.trim(); if (v) { pullModel({ model: v }); name.value = ''; } } } }, icon('download', { size: 14 }), 'Download');
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') pullBtn.click(); });

    mount(this.page, 
      h('div.page-head', h('h1.h1', 'Models'), models ? h('span.muted', plural(models.length, 'model')) : null),
      loadedSec,
      downloads,
      h('section.panel-section', h('div.section-head', h('h2.h2', 'Installed')), installed),
      h('section.panel-section',
        h('h2.h2', 'Download by name'),
        h('p.field-help', 'Any model from the Ollama library or a GGUF on Hugging Face (hf.co/…).'),
        h('div.row.pull-row', name, pullBtn),
        !canPull ? h('p.field-help', 'Ollama is not running, so models cannot be downloaded right now.') : null),
      h('section.panel-section',
        h('div.section-head', h('h2.h2', 'Recommended for this machine'), rec?.machine ? h('span.muted.small', `${Math.round(rec.machine.totalMemBytes / 1024 ** 3)} GB RAM · ${fmtBytes(rec.machine.budgetBytes)} for models`) : null),
        rec ? h('div.rec-list', rec.models.map((r) => recCard(r, rec.machine))) : h('p.muted', 'Loading…'),
        rec?.embedding?.length ? h('div.stack', h('h3.section-title', 'Embedding models (better memory search)'),
          rec.machine?.ramTier === 'low' ? h('p.field-help', 'On 8 GB machines a second model can push the chat model out of memory, so embeddings are off by default. Keyword search works well.') : null,
          h('div.list', rec.embedding.map((e) => {
            const p = pullFor(e.model);
            return h('div.list-row', h('div.grow', h('b', e.name), h('div.small.muted', `${fmtBytes(e.approxSizeBytes)} · ${e.description}`)),
              p && !p.done ? pullProgress(p) : e.installed ? h('span.badge', 'installed') : h('button.btn.btn-small', { type: 'button', disabled: !canPull, on: { click: () => pullModel({ model: e.model }) } }, icon('download', { size: 13 }), 'Download'));
          }))) : null,
        rec?.note ? h('p.faint.small', rec.note) : null),
    );
  }

  async unload(m) {
    this.busy.add(`unload:${m.model}`);
    this.render();
    try { await api.models.unload({ providerId: m.providerId, model: m.model }); toast({ kind: 'success', message: `Unloaded ${modelLabel(m.model)}`, id: 'unload' }); await loadSystem(); await loadModels(); } catch (e) { showError(e, 'unload the model'); }
    this.busy.delete(`unload:${m.model}`);
    this.render();
  }

  async load(m) {
    const t = toast({ message: `Loading ${modelShort(m.model, 36)}…`, detail: 'This can take 20–60 s on a small Mac.', timeout: 0, id: 'load' });
    try { const r = await api.models.load({ providerId: m.providerId, model: m.model }); t.dismiss(true); toast({ kind: 'success', message: `Loaded with a ${fmtTokens(r.numCtx)} window`, id: 'load' }); await loadSystem(); await loadModels(); } catch (e) { t.dismiss(true); showError(e, 'load the model'); }
  }

  async makeDefault(m) {
    try { await patchSettings({ defaultModel: { providerId: m.providerId, model: m.model } }); await loadModels(); toast({ kind: 'success', message: `Default model: ${modelLabel(m.name)}` }); } catch (e) { showError(e, 'set the default model'); }
  }

  async remove(m) {
    if (!await confirmDialog({ title: `Delete ${modelLabel(m.name)}?`, message: `This frees ${fmtBytes(m.sizeBytes)} of disk space. Chats that used it keep their messages; you can download it again later.`, confirmLabel: 'Delete', danger: true })) return;
    try { await api.models.remove({ providerId: m.providerId, model: m.model }); dropModelInfo(); await loadModels({ refresh: true }); await loadRecommended().catch(() => {}); toast({ kind: 'success', message: `Deleted ${modelLabel(m.name)}` }); } catch (e) { showError(e, 'delete the model'); }
  }

  async details(m) {
    const body = h('div.stack', h('span.spinner'));
    openDialog({ title: modelLabel(m.name), body, size: 'large', actions: [{ label: 'Close', kind: 'primary' }] });
    try {
      const r = await api.models.info({ providerId: m.providerId, model: m.model }, { refresh: true });
      const info = r.info;
      const plan = r.contextPlan;
      const caps = info.capabilities || [];
      const params = { ...(info.modelfileParameters || {}) };
      mount(body, 
        h('dl.kv',
          h('dt', 'Name'), h('dd', info.displayName || info.model),
          h('dt', 'Model id'), h('dd.mono.small', info.model),
          h('dt', 'Provider'), h('dd', m.providerName),
          h('dt', 'Family'), h('dd', [info.family, info.parameterSize, info.quantization].filter(Boolean).join(' · ') || '—'),
          h('dt', 'Size'), h('dd', fmtBytes(info.sizeBytes)),
          h('dt', 'Abilities'), h('dd', caps.join(', ') || '—'),
          h('dt', 'Context length'), h('dd', `${fmtTokens(info.contextLength)}${info.contextLengthSource ? ` (${info.contextLengthSource})` : ''}${info.advertisedContextLength && info.advertisedContextLength !== info.contextLength ? ` — metadata says ${fmtTokens(info.advertisedContextLength)}` : ''}`),
          info.serverContext ? h('dt', 'Server context') : null, info.serverContext ? h('dd', fmtTokens(info.serverContext)) : null,
          m.modifiedAt ? h('dt', 'Installed') : null, m.modifiedAt ? h('dd', fmtWhen(m.modifiedAt)) : null),
        info.contextNote ? h('p.small.muted', info.contextNote) : null,
        plan ? h('section.stack', h('h3.section-title', 'On this machine'), h(`div.callout${plan.warnings?.length ? '.warn' : ''}`, h('span', plan.explanation)),
          plan.memory?.basis === 'measured' ? h('div.row.small', h('span.muted.grow', 'Memory use was measured after loading this model.'), h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: async (e) => { try { await api.models.resetMeasurements({ providerId: m.providerId, model: m.model }); dropModelInfo(); e.target.closest('button').replaceWith(h('span.faint', 'Calibration reset')); } catch (err) { showError(err, 'reset the calibration'); } } } }, 'Reset memory calibration')) : null) : null,
        r.budgets ? h('section.stack', h('h3.section-title', 'Token budgets at this window'), h('dl.kv',
          h('dt', 'Prompt'), h('dd.num', fmtTokens(r.budgets.input)), h('dt', 'Reply reserve'), h('dd.num', fmtTokens(r.budgets.replyReserve)), h('dt', 'Summarize at'), h('dd.num', fmtTokens(r.budgets.compactAt)),
          h('dt', 'Memories'), h('dd.num', fmtTokens(r.budgets.memories)), h('dt', 'Documents'), h('dd.num', fmtTokens(r.budgets.documents)), h('dt', 'Send files whole up to'), h('dd.num', fmtTokens(r.budgets.inlineFileMax)))) : null,
        Object.keys(params).length || Object.keys(r.suggestedParams || {}).length ? h('section.stack', h('h3.section-title', 'Sampling'), h('dl.kv',
          ...Object.entries(params).flatMap(([k, v]) => [h('dt', k), h('dd.mono.small', `${JSON.stringify(v)} (Modelfile)`)]),
          ...Object.entries(r.suggestedParams || {}).flatMap(([k, v]) => [h('dt', k), h('dd.mono.small', `${JSON.stringify(v)} (Harness suggestion)`)]))) : null,
        info.profile?.notes ? h('p.small.muted', info.profile.notes) : null,
      );
    } catch (e) { mount(body, h('div.callout.danger', icon('error'), h('span', e.message))); }
  }
}

export { cancelPull };
