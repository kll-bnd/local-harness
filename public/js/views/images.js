// Image studio (direct generation with progress + cancel, img2img) and the gallery (metadata, reuse,
// delete, open the originating chat). Live updates come from the global bus.
import { h, debounce, pickFiles } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { fmtBytes, fmtRelative, plural, truncate } from '../lib/format.js';
import { store, bus, loadSystem, patchSettings } from '../state.js';
import * as api from '../api.js';
import { openLightbox } from '../ui/lightbox.js';
import { confirmDialog, toast } from '../ui/overlays.js';
import { showError, explainError } from '../errors.js';
import { navigate } from '../router.js';
import { imageJobStatus } from './chat/turn.js';
import { runAction } from '../actions.js';

const ASPECT_LABEL = { square: 'Square', portrait: 'Portrait', landscape: 'Landscape', wide: 'Wide', tall: 'Tall' };
const ASPECT_ICON = { square: [1, 1], portrait: [3, 4], landscape: [4, 3], wide: [16, 9], tall: [9, 16] };

export class ImagesView {
  constructor(shell) {
    this.shell = shell;
    this.form = { prompt: '', negativePrompt: '', aspect: 'square', width: null, height: null, steps: null, cfg: null, seed: null, count: 1, model: null, providerId: null, initImage: null, denoise: 0.6, customSize: false };
    this.defaults = null;
    this.models = [];
    this.job = null; // live job state for a studio generation
    this.controller = null;
    this.images = [];
    this.total = 0;
    this.filter = { q: '', source: '' };
    this.formEl = h('form.studio', { attrs: { 'aria-label': 'Image studio' }, on: { submit: (e) => { e.preventDefault(); this.generate(); } } });
    this.galleryEl = h('section.gallery', { attrs: { 'aria-label': 'Gallery' } });
    this.scroller = h('div.view-scroll', h('div.images-page', this.formEl, this.galleryEl));
    this.el = h('div.view.images-view', this.scroller);
    this.refreshGallery = debounce(() => this.loadGallery(), 300);
    bus.on('gallery', () => this.refreshGallery());
    bus.on('studio-reuse', (img) => this.reuse(img));
    bus.on('image-job', (job) => { if (!this.job || job.id !== this.job.jobId) this.renderActivity(); });
    store.watch(['system'], () => {
      // Only rebuild the form when the set of backends changed — never while someone is typing.
      const sig = JSON.stringify(this.providers().map((p) => [p.id, p.currentModel]));
      if (sig !== this.provSig) { this.provSig = sig; this.renderForm(); }
    });
    this.scroller.addEventListener('scroll', () => this.shell.setScrolled(this.scroller.scrollTop > 4), { passive: true });
    this.loadedOnce = false;
  }

  async show() {
    if (!this.loadedOnce) {
      this.loadedOnce = true;
      const s = store.get('settings');
      this.form.providerId = s?.image?.providerId || null;
      this.form.model = s?.image?.model || null;
      this.form.negativePrompt = s?.image?.defaults?.negativePrompt || '';
      this.form.count = s?.image?.defaults?.count || 1;
    }
    this.renderForm();
    this.loadGallery();
    await this.loadModels();
    this.loadDefaults();
  }

  toolbar() {
    return { title: h('div.tb-title', h('span.title-text', 'Image studio')), actions: [] };
  }

  providers() { return (store.get('system')?.imageProviders || []).filter((p) => p.status === 'running'); }
  provider() { const ps = this.providers(); return ps.find((p) => p.id === this.form.providerId) || ps[0] || null; }

  async loadModels() {
    const p = this.provider();
    if (!p) { this.models = []; this.renderForm(); return; }
    try { const r = await api.images.models({ providerId: p.id }); this.models = r.models; } catch { this.models = []; }
    this.renderForm();
  }

  async loadDefaults() {
    const model = this.form.model || this.models.find((m) => m.current)?.id || this.provider()?.currentModel || undefined;
    try { this.defaults = await api.images.defaults({ model, aspect: this.form.aspect }); } catch { this.defaults = null; }
    this.renderForm();
  }

  // ------------------------------------------------------------------------------------------ form
  renderForm() {
    const f = this.form;
    const provs = this.providers();
    const p = this.provider();
    const d = this.defaults?.params;
    const enabled = store.get('settings')?.image?.enabled !== false;
    const running = !!this.job && !['done', 'error', 'aborted'].includes(this.job.phase);
    const focused = document.activeElement;
    const refocus = focused && this.formEl.contains(focused) ? { name: focused.name, s: focused.selectionStart, e: focused.selectionEnd } : null;

    if (!enabled || !provs.length) {
      this.formEl.replaceChildren(h('div.studio-empty.stack',
        h('h1.h1', 'Image studio'),
        !enabled
          ? h('div.callout', icon('info'), h('div.grow', 'Image generation is turned off.'), h('button.btn.btn-small', { type: 'button', on: { click: async () => { try { await patchSettings({ image: { enabled: true } }); } catch (e) { showError(e); } } } }, 'Turn on'))
          : h('div.callout', icon('image'), h('div.grow', h('div', h('b', 'No image backend is running.')), h('div.small', 'In Draw Things, open Settings → API Server and enable the HTTP server on port 7860. ComfyUI and A1111/Forge are detected too.'))),
        h('div.row', h('button.btn', { type: 'button', on: { click: () => runAction('refresh-backends') } }, icon('reload', { size: 14 }), 'Check again'), h('button.btn.btn-ghost', { type: 'button', on: { click: () => navigate('/settings/images') } }, 'Image settings'))));
      return;
    }

    const prompt = h('textarea.textarea.studio-prompt', { name: 'prompt', rows: 4, value: f.prompt, placeholder: 'Describe the image…', attrs: { 'aria-label': 'Prompt', required: true } });
    prompt.addEventListener('input', () => { f.prompt = prompt.value; genBtn.disabled = running || !f.prompt.trim(); });
    prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.generate(); } });
    const neg = h('textarea.textarea', { name: 'negativePrompt', rows: 2, value: f.negativePrompt, placeholder: 'Things to avoid (optional)', attrs: { 'aria-label': 'Negative prompt' } });
    neg.addEventListener('input', () => { f.negativePrompt = neg.value; });

    const provSel = provs.length > 1 ? h('select.select', { name: 'provider', attrs: { 'aria-label': 'Backend' }, on: { change: async (e) => { f.providerId = e.target.value; f.model = null; await this.loadModels(); this.loadDefaults(); } } }, provs.map((x) => h('option', { value: x.id, selected: x.id === p?.id }, x.name))) : h('div.static-field', p?.name);
    const modelSel = h('select.select', { name: 'model', attrs: { 'aria-label': 'Model' }, on: { change: (e) => { f.model = e.target.value || null; this.loadDefaults(); } } },
      h('option', { value: '' }, `Current${p?.currentModel ? `: ${truncate(p.currentModel.replace(/\s*\[[^\]]+\]$/, ''), 40)}` : ''}`),
      ...this.models.map((m) => h('option', { value: m.id, selected: f.model === m.id }, m.name)));

    const aspects = h('div.aspect-picker', { role: 'radiogroup', attrs: { 'aria-label': 'Aspect ratio' } },
      ...Object.keys(ASPECT_LABEL).map((a) => {
        const [w, hh] = ASPECT_ICON[a];
        const sc = 16 / Math.max(w, hh);
        return h('button.aspect', { type: 'button', role: 'radio', 'aria-checked': String(!f.customSize && f.aspect === a), title: ASPECT_LABEL[a], on: { click: () => { f.aspect = a; f.customSize = false; f.width = f.height = null; this.loadDefaults(); } } },
          h('span.aspect-box', { style: { width: `${w * sc}px`, height: `${hh * sc}px` } }), h('span', ASPECT_LABEL[a]));
      }),
      h('button.aspect', { type: 'button', role: 'radio', 'aria-checked': String(f.customSize), title: 'Custom size', on: { click: () => { f.customSize = true; f.width ||= d?.width || 512; f.height ||= d?.height || 512; this.renderForm(); } } }, h('span.aspect-box.custom'), h('span', 'Custom')));

    const num = (name, label, val, placeholder, attrs = {}) => {
      const input = h('input.input.input-small.num', { name, type: 'number', value: val ?? '', placeholder: placeholder ?? '', ...attrs, attrs: { 'aria-label': label } });
      input.addEventListener('change', () => { f[name] = input.value === '' ? null : Number(input.value); if (name === 'width' || name === 'height') this.renderWarnings(); });
      return h('label.studio-num', h('span.small.muted', label), input);
    };
    const seedInput = h('input.input.input-small.num', { name: 'seed', type: 'number', value: f.seed ?? '', placeholder: 'random', attrs: { 'aria-label': 'Seed' } });
    seedInput.addEventListener('change', () => { f.seed = seedInput.value === '' ? null : Number(seedInput.value); });

    const caps = p?.capabilities || {};
    const init = f.initImage;
    const initBlock = caps.img2img ? h('div.studio-init',
      h('div.row', h('span.small.muted.grow', 'Start from an image'), init ? h('button.btn-link.small', { type: 'button', on: { click: () => { f.initImage = null; this.renderForm(); } } }, 'Clear') : null),
      init ? h('div.row', h('img.init-thumb', { src: init.url, alt: 'Init image' }), h('label.grow', h('span.small.muted', `Change strength ${Math.round(f.denoise * 100)} %`), h('input', { type: 'range', min: 0.05, max: 1, step: 0.05, value: f.denoise, attrs: { 'aria-label': 'Denoise strength' }, on: { input: (e) => { f.denoise = Number(e.target.value); e.target.previousSibling.textContent = `Change strength ${Math.round(f.denoise * 100)} %`; } } })))
        : h('div.row', h('button.btn.btn-small', { type: 'button', on: { click: () => this.uploadInit() } }, icon('upload', { size: 13 }), 'Upload…'), h('span.faint.small', 'or choose “Use as starting image” on a gallery image'))) : null;

    const genBtn = h('button.btn.btn-primary.btn-large.gen-btn', { type: 'submit', disabled: running || !f.prompt.trim() }, icon('image', { size: 15 }), f.count > 1 ? `Generate ${f.count}` : 'Generate');
    this.warningsEl = h('div.studio-warnings');
    this.progressEl = h('div.studio-progress');
    this.activityEl = h('div.studio-activity');

    this.formEl.replaceChildren(
      h('div.studio-head', h('h1.h1', 'Image studio'), this.defaults?.family ? h('span.badge', { title: 'Detected model family' }, this.defaults.family.label) : null),
      prompt,
      h('details.neg', { open: !!f.negativePrompt }, h('summary.small.muted', 'Negative prompt'), neg),
      h('div.studio-grid',
        h('label.studio-field', h('span.small.muted', 'Backend'), provSel),
        h('label.studio-field', h('span.small.muted', 'Model'), modelSel)),
      aspects,
      f.customSize ? h('div.studio-grid', num('width', 'Width', f.width, d?.width, { min: 64, max: 4096, step: 64 }), num('height', 'Height', f.height, d?.height, { min: 64, max: 4096, step: 64 })) : h('div.faint.small.num', d ? `${d.width}×${d.height} px` : ''),
      h('div.studio-grid.four',
        num('steps', 'Steps', f.steps, d?.steps, { min: 1, max: 200 }),
        num('cfg', 'Guidance', f.cfg, d?.cfg, { min: 0, max: 50, step: 0.5 }),
        h('label.studio-num', h('span.small.muted', 'Seed'), h('div.seed-row', seedInput, h('button.icon-btn.small', { type: 'button', title: 'Random seed', 'aria-label': 'Random seed', on: { click: () => { f.seed = null; seedInput.value = ''; } } }, icon('dice', { size: 14 })))),
        num('count', 'Count', f.count, 1, { min: 1, max: 8 })),
      initBlock,
      this.warningsEl,
      h('div.row.studio-actions', genBtn, running ? h('button.btn', { type: 'button', on: { click: () => this.cancel() } }, icon('stop', { size: 12 }), 'Cancel') : null, h('span.faint.small.hide-narrow', `${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}↩`)),
      this.progressEl,
      this.activityEl,
    );
    this.renderWarnings();
    this.renderProgress();
    this.renderActivity();
    if (refocus?.name) {
      const el = this.formEl.querySelector(`[name="${refocus.name}"]`);
      el?.focus();
      try { if (el && refocus.s != null) el.setSelectionRange(refocus.s, refocus.e); } catch { /* number inputs */ }
    }
  }

  renderWarnings() {
    if (!this.warningsEl) return;
    const w = this.defaults?.warnings || [];
    const sys = store.get('system');
    const low = sys?.machine?.ramTier === 'low';
    const msgs = w.map((x) => x.message);
    if (low && this.form.customSize && (this.form.width || 0) * (this.form.height || 0) > 768 * 768) msgs.push('Large sizes are slow and may swap on 8 GB.');
    this.warningsEl.replaceChildren(...(msgs.length ? [h('div.callout.warn.small', icon('warning'), h('div', msgs.join(' ')))] : []),
      low ? h('p.faint.small', 'On 8 GB Harness unloads the chat model while generating; it reloads with your next message.') : null);
  }

  renderProgress() {
    if (!this.progressEl) return;
    const j = this.job;
    if (!j) { this.progressEl.replaceChildren(); return; }
    const parts = [];
    if (j.phase === 'error') {
      const x = explainError({ code: j.code, message: j.error });
      parts.push(h('div.callout.danger', icon('error'), h('div.grow', h('b', j.code === 'aborted' ? 'Cancelled' : x.title), x.detail && j.code !== 'aborted' ? h('div.small', x.detail) : null), x.action && j.code !== 'aborted' ? h('button.btn.btn-small', { type: 'button', on: { click: x.action.run } }, x.action.label) : null));
    } else if (j.phase === 'done') {
      parts.push(h('div.row.small.muted', icon('check', { size: 13 }), `Done in ${((Date.now() - j.startedAt) / 1000).toFixed(1)} s${j.chatModelUnloaded ? ' · the chat model reloads with your next message' : ''}`));
    } else {
      parts.push(imageJobStatus(j, null, { cancellable: false }));
      if (j.eta) parts.push(h('div.faint.small.num', `About ${Math.ceil(j.eta)} s left`));
    }
    if (j.images?.length) {
      const grid = h(`div.image-grid.n${Math.min(j.images.length, 4)}`, j.images.map((img, i) => h('button.gen-img', { type: 'button', on: { click: () => this.open(j.images, i) }, style: { aspectRatio: `${img.width} / ${img.height}` } }, h('img', { src: img.url, alt: img.prompt }))));
      parts.push(grid);
    }
    this.progressEl.replaceChildren(...parts);
  }

  renderActivity() {
    if (!this.activityEl) return;
    const jobs = Object.values(store.get('imageJobs') || {}).filter((j) => !['done', 'error', 'aborted'].includes(j.status) && j.id !== this.job?.jobId);
    this.activityEl.replaceChildren(...jobs.map((j) => h('div.callout.small', h('span.spinner.small'), h('div.grow', `${j.source === 'tool' ? 'A chat is generating' : 'Generating'} “${truncate(j.prompt || '', 60)}”${j.status ? ` — ${j.status}` : ''}`),
      j.chatId ? h('a.btn.btn-small', { href: `#/chat/${j.chatId}` }, 'Open chat') : null,
      h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: () => api.images.cancel(j.id).catch((e) => showError(e)) } }, 'Cancel'))));
  }

  async uploadInit() {
    const [file] = await pickFiles({ accept: 'image/*', multiple: false });
    if (!file) return;
    try {
      const { attachment } = await api.attachments.upload(file);
      this.form.initImage = { attachmentId: attachment.id, url: attachment.url };
      this.renderForm();
    } catch (e) { showError(e, 'upload the image'); }
  }

  // ------------------------------------------------------------------------------------------ generate
  async generate() {
    const f = this.form;
    if (!f.prompt.trim() || (this.job && !['done', 'error', 'aborted'].includes(this.job.phase))) return;
    const body = {
      prompt: f.prompt.trim(),
      negativePrompt: f.negativePrompt || undefined,
      providerId: this.provider()?.id || undefined,
      model: f.model || undefined,
      count: f.count || 1,
      steps: f.steps ?? undefined,
      cfg: f.cfg ?? undefined,
      seed: f.seed ?? undefined,
    };
    if (f.customSize) { body.width = f.width; body.height = f.height; } else body.aspect = f.aspect;
    if (f.initImage) { body.initImage = f.initImage.imageId ? { imageId: f.initImage.imageId } : { attachmentId: f.initImage.attachmentId }; body.denoise = f.denoise; }
    this.controller = new AbortController();
    this.job = { phase: 'queued', phases: [], images: [], startedAt: Date.now(), params: { width: f.width || this.defaults?.params?.width || 512, height: f.height || this.defaults?.params?.height || 512, count: f.count } };
    this.renderForm();
    try {
      const r = await api.images.generate(body, (ev) => this.onEvent(ev), { signal: this.controller.signal });
      if (r.aborted) Object.assign(this.job, { phase: 'error', code: 'aborted', error: 'Cancelled' });
    } catch (e) {
      Object.assign(this.job, { phase: 'error', code: e.code, error: e.message });
    }
    this.controller = null;
    this.renderForm();
    this.loadGallery();
    loadSystem().catch(() => {});
  }

  onEvent(ev) {
    const j = this.job;
    if (!j) return;
    switch (ev.type) {
      case 'image_job': j.jobId = ev.job.id; break;
      case 'image_status':
        j.phase = ev.phase;
        if (!j.phases.includes(ev.phase)) j.phases.push(ev.phase);
        if (ev.message) j.message = ev.message;
        if (ev.phase === 'unloading') j.unload = { models: ev.models, reason: ev.reason };
        if (ev.phase === 'starting') { j.params = { ...j.params, ...ev.params }; j.warnings = ev.warnings; }
        break;
      case 'image_progress': Object.assign(j, { progress: ev.progress, step: ev.step, steps: ev.steps, eta: ev.etaSeconds }); break;
      case 'image': j.images = [...j.images, ev.image]; break;
      case 'image_done': Object.assign(j, { phase: 'done', chatModelUnloaded: ev.chatModelUnloaded, progress: 1 }); break;
      case 'image_error': Object.assign(j, { phase: 'error', code: ev.code, error: ev.message }); break;
      case 'error': Object.assign(j, { phase: 'error', code: ev.code, error: ev.message }); break;
      case 'done': j.phase = 'done'; if (ev.images?.length) j.images = ev.images; break;
      default: break;
    }
    if (ev.type === 'image_status' && ev.phase === 'starting') this.renderForm(); else this.renderProgress();
  }

  async cancel() {
    const id = this.job?.jobId;
    try { if (id) await api.images.cancel(id); else this.controller?.abort(); } catch { this.controller?.abort(); }
  }

  reuse(img, { asInit = false } = {}) {
    if (!img) return;
    const f = this.form;
    if (asInit) {
      f.initImage = { imageId: img.id, url: img.url };
    } else {
      f.prompt = img.prompt || f.prompt;
      f.negativePrompt = img.negativePrompt || '';
      f.seed = img.seed ?? null;
      const pr = img.params || {};
      f.steps = pr.steps ?? null;
      f.cfg = pr.cfg ?? null;
      f.count = pr.count || 1;
      if (pr.width && pr.height) { f.customSize = true; f.width = pr.width; f.height = pr.height; }
      if (img.providerId && this.providers().some((p) => p.id === img.providerId)) f.providerId = img.providerId;
      f.model = img.model || null;
    }
    this.renderForm();
    this.scroller.scrollTop = 0;
    requestAnimationFrame(() => this.formEl.querySelector('textarea')?.focus());
    toast({ message: asInit ? 'Set as starting image' : 'Settings loaded into the studio', timeout: 1800, id: 'reuse' });
  }

  // ------------------------------------------------------------------------------------------ gallery
  async loadGallery({ append = false } = {}) {
    try {
      const r = await api.images.list({ q: this.filter.q || undefined, source: this.filter.source || undefined, limit: 60, offset: append ? this.images.length : 0 });
      this.images = append ? [...this.images, ...r.images] : r.images;
      this.total = r.total;
    } catch (e) { if (!append) this.images = []; }
    this.renderGallery();
  }

  renderGallery() {
    const q = h('input.input.input-small', { type: 'search', value: this.filter.q, placeholder: 'Search prompts', attrs: { 'aria-label': 'Search images' } });
    q.addEventListener('input', debounce(() => { this.filter.q = q.value.trim(); this.loadGallery(); }, 250));
    const src = h('div.segmented', { role: 'radiogroup', attrs: { 'aria-label': 'Source' } },
      ...[['', 'All'], ['user', 'Studio'], ['tool', 'From chats']].map(([v, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(this.filter.source === v), on: { click: () => { this.filter.source = v; this.loadGallery(); } } }, l)));
    const had = document.activeElement?.closest?.('.gallery-head') ? 'q' : null;
    const grid = this.images.length
      ? h('div.gallery-grid', this.images.map((img, i) => h('figure.g-item', { dataset: { imageId: img.id } },
        h('button.g-thumb', { type: 'button', title: img.prompt, on: { click: () => this.open(this.images, i) }, style: { aspectRatio: `${img.width} / ${img.height}` } }, h('img', { src: img.url, alt: img.prompt || 'Image', loading: 'lazy', width: img.width, height: img.height })),
        h('figcaption', h('span.g-prompt', img.prompt || 'Untitled'), h('span.g-meta.faint.num', [`${img.width}×${img.height}`, img.source === 'tool' ? 'chat' : null, fmtRelative(img.createdAt)].filter(Boolean).join(' · '))))))
      : h('div.empty', icon('image', { size: 22 }), h('div.empty-title', this.filter.q || this.filter.source ? 'No matching images' : 'No images yet'), h('div', 'Generated images from the studio and from chats appear here.'));
    this.galleryEl.replaceChildren(
      h('div.gallery-head', h('h2.h2.grow', 'Gallery', h('span.muted.small.num', this.total ? ` ${plural(this.total, 'image')}` : '')), q, src),
      grid,
      this.images.length < this.total ? h('div.row', h('span.spacer'), h('button.btn.btn-small', { type: 'button', on: { click: () => this.loadGallery({ append: true }) } }, 'Load more'), h('span.spacer')) : null);
    if (had) { const el = this.galleryEl.querySelector('input[type="search"]'); el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }
  }

  open(list, i) {
    openLightbox(list, i, {
      actions: (img, close) => [
        { label: 'Reuse settings', icon: 'regenerate', run: () => { close(); this.reuse(img); } },
        this.provider()?.capabilities?.img2img ? { label: 'Use as starting image', icon: 'image', run: () => { close(); this.reuse(img, { asInit: true }); } } : null,
        img.chatId ? { label: 'Open chat', icon: 'compose', run: () => { close(); navigate(`/chat/${img.chatId}${img.messageId ? `?m=${img.messageId}` : ''}`); } } : null,
        img.id ? { label: 'Delete', icon: 'trash', run: async () => {
          if (!await confirmDialog({ title: 'Delete this image?', message: `${img.width}×${img.height} · ${fmtBytes(img.bytes)}. Chats that show it will show a missing image.`, confirmLabel: 'Delete', danger: true })) return;
          try { await api.images.remove(img.id); close(); this.loadGallery(); toast({ kind: 'success', message: 'Image deleted' }); } catch (e) { showError(e, 'delete the image'); }
        } } : null,
      ].filter(Boolean),
    });
  }
}
