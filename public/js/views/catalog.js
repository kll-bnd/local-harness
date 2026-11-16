// The model catalogue (docs/API.md 10.8): browse the Ollama library and GGUF repositories on Hugging Face
// without typing — sorted lists with filters (kind, fits this Mac, size, publisher; search is one more filter)
// and endless scrolling — and a page per model with its card, numbers and every file with its fit here.
// "Will this run on my Mac?" is answered on every row; what does not fit is dimmed, never hidden.
import { h, mount, add, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { fmtBytes, fmtTokens, fmtRelative, fmtFull, modelShort } from '../lib/format.js';
import { renderMarkdown } from '../lib/markdown.js';
import * as api from '../api.js';
import { store, loadModels, patchSettings } from '../state.js';
import { navigate } from '../router.js';
import { toast } from '../ui/overlays.js';
import { showError, explainError } from '../errors.js';
import { pullModel, pullFor, cancelPull } from './pulls.js';
import { pullProgress } from './setup.js';
import { allowPanel } from './network.js';
import { removeOriginal } from './model-flows.js';

export const SOURCES = {
  ollama: { label: 'Ollama library', site: 'ollama.com', sorts: [['trending', 'Popular'], ['updated', 'Newest']] },
  huggingface: { label: 'Hugging Face', site: 'huggingface.co', sorts: [['trending', 'Trending'], ['downloads', 'Most downloaded'], ['likes', 'Most liked'], ['updated', 'Recently updated']] },
};

const KINDS = [['', 'All'], ['chat', 'Chat'], ['vision', 'Vision'], ['embedding', 'Embedding']];
const SIZES = [['', 'Any size'], ['0-3', 'Up to 3B'], ['3-8', '3–8B'], ['8-15', '8–15B'], ['15-', 'Over 15B']];
const PUBLISHERS = ['unsloth', 'bartowski', 'lmstudio-community', 'ggml-org', 'Qwen', 'google', 'microsoft', 'mistralai', 'nvidia', 'meta-llama', 'ibm-granite', 'MaziyarPanahi', 'TheBloke'];

export const fmtParams = (n) => {
  if (!n) return null;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, '')}B`;
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
  return String(n);
};
const fmtCount = (n) => (n == null ? null : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '')}K` : String(n));

/** The at-a-glance fit chip for a list row. */
function fitChip(fit) {
  if (!fit) return h('span.fit-chip.unknown', { title: 'Size not known yet — open it to see every file' }, 'Size unknown');
  const size = fit.sizeBytes ? `≈ ${fmtBytes(fit.sizeBytes)}` : '';
  return fit.fits
    ? h('span.fit-chip.ok', { title: fit.note || 'Estimated to fit this Mac' }, icon('check', { size: 12 }), h('span', 'Fits this Mac'), size ? h('span.faint', ` · ${size}`) : null)
    : h('span.fit-chip.no', { title: fit.note || 'Estimated not to fit this Mac' }, h('span', 'Too big for this Mac'), size ? h('span.faint', ` · ${size}`) : null);
}

// ------------------------------------------------------------------------------------------------ list
export class CatalogBrowser {
  constructor(source, { scroller }) {
    this.source = source;
    this.scroller = scroller;
    this.filters = { sort: 'trending', kind: '', fits: false, size: '', publisher: '', q: '' };
    this.items = [];
    this.nextCursor = null;
    this.loading = false;
    this.error = null;
    this.blocked = null; // offline_lock details while internet access is blocked
    this.sourceNote = null;
    this.loaded = false;
    this.seq = 0;
    this.filterBar = h('div.cat-filters');
    this.noteEl = h('div.cat-note');
    this.listEl = h('div.cat-list', { role: 'list' });
    this.footEl = h('div.cat-foot');
    this.sentinel = h('div.cat-sentinel', { attrs: { 'aria-hidden': 'true' } });
    this.el = h('div.cat-browser', { dataset: { source } }, this.filterBar, this.noteEl, this.listEl, this.footEl, this.sentinel);
    this.reloadSoon = debounce(() => this.reload(), 350);
    this.io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) this.more(); }, { root: scroller, rootMargin: '600px 0px' });
    this.io.observe(this.sentinel);
    // Allowed meanwhile (title bar, settings, another prompt): load what was waiting.
    store.on('network', (ol) => { if (this.blocked && ol && !ol.blocked) this.reload(); });
    this.renderFilters();
  }

  show() {
    if (!this.loaded) this.reload();
    else if (this.blocked && !store.get('network')?.blocked) this.reload();
  }

  params(cursor) {
    const f = this.filters;
    const [lo, hi] = (f.size || '-').split('-');
    const hf = this.source === 'huggingface';
    return {
      source: this.source, sort: f.sort, kind: f.kind || undefined, fits: f.fits || undefined, q: f.q.trim() || undefined, cursor: cursor || undefined, limit: 24,
      ...(hf ? { publisher: f.publisher.trim() || undefined, minParams: lo ? Number(lo) * 1e9 : undefined, maxParams: hi ? Number(hi) * 1e9 : undefined } : {}),
    };
  }

  async reload() {
    this.items = [];
    this.nextCursor = null;
    this.error = null;
    this.blocked = null;
    this.loaded = true;
    this.renderList(true);
    await this.fetchPage(null);
  }

  more() {
    if (this.loading || !this.nextCursor || this.error || this.blocked) return;
    this.fetchPage(this.nextCursor);
  }

  async fetchPage(cursor) {
    const seq = ++this.seq;
    this.loading = true;
    this.renderFoot();
    try {
      const r = await api.catalog.list(this.params(cursor));
      if (seq !== this.seq) return;
      const seen = new Set(this.items.map((x) => x.id));
      this.items.push(...(r.items || []).filter((x) => !seen.has(x.id)));
      this.nextCursor = r.nextCursor || null;
      this.sourceNote = r.sourceNote || null;
      this.blocked = null;
    } catch (e) {
      if (seq !== this.seq) return;
      if (e instanceof api.ApiError && e.code === 'offline_lock') this.blocked = e.details || {};
      else this.error = e;
    } finally {
      if (seq === this.seq) {
        this.loading = false;
        this.renderList();
        // A short first page may not fill the screen: keep going while the sentinel is visible.
        requestAnimationFrame(() => { if (this.nextCursor && this.sentinelVisible()) this.more(); });
      }
    }
  }

  sentinelVisible() {
    const r = this.sentinel.getBoundingClientRect();
    const sr = this.scroller.getBoundingClientRect();
    return r.top < sr.bottom + 600;
  }

  setFilter(k, v, { soon = false } = {}) {
    this.filters[k] = v;
    this.renderFilters();
    if (soon) this.reloadSoon(); else this.reload();
  }

  renderFilters() {
    const f = this.filters;
    const src = SOURCES[this.source];
    const hf = this.source === 'huggingface';
    if (!src.sorts.some(([v]) => v === f.sort)) f.sort = src.sorts[0][0];
    const seg = (items, key, label) => h('div.segmented.cat-seg', { role: 'radiogroup', attrs: { 'aria-label': label } }, items.map(([v, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(f[key] === v), dataset: { value: v }, on: { click: () => { if (f[key] !== v) this.setFilter(key, v); } } }, l)));
    if (!this.searchInput) {
      this.searchInput = h('input.input.cat-search', { type: 'search', placeholder: `Search ${src.label}`, attrs: { 'aria-label': `Search ${src.label}` }, on: { input: () => this.setFilter('q', this.searchInput.value, { soon: true }) } });
      this.pubInput = h('input.input.cat-pub', { type: 'text', placeholder: 'Any publisher', attrs: { list: `pubs-${this.source}`, 'aria-label': 'Publisher' }, on: { input: () => this.setFilter('publisher', this.pubInput.value, { soon: true }) } });
      this.pubList = h('datalist', { id: `pubs-${this.source}` }, PUBLISHERS.map((p) => h('option', { value: p })));
    }
    const sizeSel = hf ? h('select.select.cat-size', { attrs: { 'aria-label': 'Size' }, on: { change: (e) => this.setFilter('size', e.target.value) } }, SIZES.map(([v, l]) => h('option', { value: v, selected: f.size === v }, l))) : null;
    mount(this.filterBar,
      h('div.cat-row', seg(src.sorts, 'sort', 'Sort by'), h('span.spacer'), this.searchInput),
      h('div.cat-row.cat-row-2',
        seg(KINDS, 'kind', 'Kind'),
        h('button.chip.cat-fits', { type: 'button', 'aria-pressed': String(!!f.fits), on: { click: () => this.setFilter('fits', !f.fits) } }, icon('check', { size: 12 }), 'Fits this Mac'),
        sizeSel,
        hf ? h('label.cat-pub-wrap', h('span.sr-only', 'Publisher'), this.pubInput, this.pubList) : null));
  }

  renderList(clear = false) {
    if (clear) mount(this.listEl);
    mount(this.noteEl, this.sourceNote ? h('p.field-help', this.sourceNote) : null);
    if (this.blocked) {
      mount(this.listEl, allowPanel(this.blocked, { title: `Browsing ${SOURCES[this.source].label} needs the internet`, onAllowed: () => this.reload() }));
      mount(this.footEl);
      return;
    }
    if (!clear) mount(this.listEl, this.items.map((it) => this.row(it)));
    this.renderFoot();
  }

  renderFoot() {
    if (this.blocked) { mount(this.footEl); return; }
    if (this.error) {
      const x = explainError(this.error, 'load the catalogue');
      mount(this.footEl, h('div.callout.warn', icon('warning'), h('div.grow', h('b', x.title), x.detail ? h('div.small', x.detail) : null), h('button.btn.btn-small', { type: 'button', on: { click: () => { this.error = null; if (this.items.length) this.more(); else this.reload(); } } }, 'Try again')));
      return;
    }
    if (this.loading) { mount(this.footEl, h('div.cat-loading', h('span.spinner.small'), this.items.length ? 'Loading more…' : `Loading ${SOURCES[this.source].label}…`)); return; }
    if (!this.items.length && this.loaded) { mount(this.footEl, h('div.empty', icon('search', { size: 20 }), h('div.empty-title', 'Nothing matches'), h('div', 'Try fewer filters.'))); return; }
    mount(this.footEl, !this.nextCursor && this.items.length ? h('div.cat-end.faint', `That's all — ${this.items.length} models`) : null);
  }

  row(it) {
    const unfit = it.fit && !it.fit.fits;
    const meta = [
      fmtParams(it.parameters) ? `${fmtParams(it.parameters)} parameters` : null,
      it.contextLength ? `${fmtTokens(it.contextLength)} context` : null,
      it.downloads != null ? `${fmtCount(it.downloads)} downloads` : null,
      it.likes != null ? `${fmtCount(it.likes)} likes` : null,
      it.updatedAt ? `updated ${fmtRelative(it.updatedAt)}` : null,
    ].filter(Boolean);
    const href = `#/models/${this.source}/${it.id.split('/').map(encodeURIComponent).join('/')}`;
    return h(`a.cat-item${unfit ? '.unfit' : ''}`, { href, role: 'listitem', dataset: { id: it.id, fits: it.fit ? String(!!it.fit.fits) : 'unknown' } },
      h('div.cat-main',
        h('div.cat-title-row',
          h('span.cat-name', it.name || it.id),
          it.publisher ? h('span.cat-pub-name', it.publisher) : null,
          it.installed ? h('span.badge', 'installed') : null,
          it.recommended ? h('span.badge.accent', 'recommended') : null,
          it.gated ? h('span.badge.warn', { title: 'The publisher must approve each download on Hugging Face' }, icon('lock', { size: 11 }), 'gated') : null),
        it.description ? h('div.cat-desc', it.description) : null,
        h('div.cat-meta',
          it.kind ? h(`span.badge.outline.kind-${it.kind}`, it.kind) : null,
          ...(it.capabilities || []).filter((c) => c !== it.kind).slice(0, 3).map((c) => h('span.badge.outline', c)),
          h('span.faint', meta.join(' · ')))),
      h('div.cat-side', fitChip(it.fit)));
  }
}

// ------------------------------------------------------------------------------------------------ model page
export class ModelPage {
  constructor() {
    this.el = h('div.model-page');
    this.detail = null;
    this.key = null;
    this.blocked = null;
    store.on('network', (ol) => { if (this.blocked && ol && !ol.blocked && this.key) this.load(this.key.source, this.key.id); });
    store.watch(['pulls', 'models'], () => { if (this.detail && this.el.isConnected) this.renderFiles(); });
  }

  async load(source, id) {
    const key = `${source}|${id}`;
    this.key = { source, id };
    this.keyStr = key;
    this.blocked = null;
    if (this.detail && this.detailKey === key) { this.render(); return; }
    this.detail = null;
    mount(this.el, this.back(source), h('div.cat-loading', h('span.spinner.small'), 'Loading…'));
    try {
      const d = await api.catalog.model({ source, id });
      if (this.keyStr !== key) return;
      this.detail = d;
      this.detailKey = key;
      this.render();
    } catch (e) {
      if (this.keyStr !== key) return;
      if (e instanceof api.ApiError && e.code === 'offline_lock') {
        this.blocked = e.details || {};
        mount(this.el, this.back(source), allowPanel(this.blocked, { title: `This page comes from ${SOURCES[source]?.site || 'the internet'}`, onAllowed: () => this.load(source, id) }));
        return;
      }
      const x = explainError(e, 'open this model');
      mount(this.el, this.back(source), h('div.callout.warn', icon('warning'), h('div.grow', h('b', x.title), x.detail ? h('div.small', x.detail) : null), h('button.btn.btn-small', { type: 'button', on: { click: () => this.load(source, id) } }, 'Try again')));
    }
  }

  back(source) {
    return h('a.back-link', { href: `#/models/${source === 'local' ? '' : source}` }, icon('chevronLeft', { size: 13 }), source === 'local' ? 'On this Mac' : SOURCES[source]?.label || 'Models');
  }

  /** The one sentence that answers "will this run on my Mac?" */
  glance(d) {
    const rec = d.files.find((f) => f.tag === d.recommendedTag) || d.files.find((f) => f.recommended);
    const ram = store.get('system')?.machine?.totalMemBytes;
    const ramText = ram ? `${Math.round(ram / 1024 ** 3)} GB` : 'this Mac’s';
    if (!d.files.length) return h('div.glance.unknown', icon('info', { size: 16 }), h('div', h('b', 'No downloadable files listed.'), d.notes?.length ? h('div.small', d.notes[0]) : null));
    if (rec?.fit?.fits) {
      const copy = rec.fit.basis === 'text_only_copy' || rec.textOnly?.recommended;
      return h('div.glance.ok', icon('check', { size: 16 }),
        h('div.grow',
          h('b', `Runs on this Mac: ${rec.tag}${copy ? ' as a text-only copy' : ''}`),
          h('div.small', `${fmtBytes(rec.downloadBytes || rec.sizeBytes)} download · ${fmtTokens(rec.fit.numCtx)} context here${copy ? ' · cannot read images, about 1 GB less memory' : ''}`),
          rec.fit.explanation ? h('div.small.faint', rec.fit.explanation) : null),
        this.downloadButton(d, rec, { primary: true }));
    }
    const smallest = [...d.files].filter((f) => f.fit).sort((a, b) => (a.fit.estimatedTotalBytes || a.sizeBytes || 0) - (b.fit.estimatedTotalBytes || b.sizeBytes || 0))[0];
    return h('div.glance.no', icon('warning', { size: 16 }),
      h('div.grow',
        h('b', 'Too big for this Mac'),
        h('div.small', smallest ? `Even the smallest version (${smallest.tag}) needs about ${fmtBytes(smallest.fit.estimatedTotalBytes || smallest.sizeBytes)}; this Mac has ${ramText} of memory.` : `None of its files fit ${ramText} of memory.`)));
  }

  downloadButton(d, f, { primary = false } = {}) {
    const p = pullFor(f.model);
    if (p && !p.done) return pullProgress(p, { onCancel: () => cancelPull(f.model) });
    if (f.installed || (f.textOnly && f.textOnly.installed)) return h('span.badge', 'installed');
    if (!d.downloadable) return null;
    if (f.pullable === false) return h('span.faint.small.nowrap', { title: 'Ollama’s registry does not offer this exact file' }, 'Not downloadable');
    const copy = !!f.textOnly?.recommended;
    return h(`button.btn.btn-small${primary ? '.btn-primary' : ''}`, { type: 'button', dataset: { model: f.model }, on: { click: () => downloadFromCatalog(f) } },
      icon('download', { size: 13 }), copy ? 'Download and set up' : 'Download');
  }

  render() {
    const d = this.detail;
    if (!d) return;
    const lic = d.license;
    const ext = (url, text) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', dataset: { external: '' } }, text, icon('external', { size: 11 }));
    const numbers = [
      ['Publisher', d.publisher || '—'],
      ['Parameters', fmtParams(d.parameters) || '—'],
      ['Architecture', d.architecture || '—'],
      ['Context length', d.contextLength ? fmtTokens(d.contextLength) : '—'],
      ['Downloads', d.downloads != null ? d.downloads.toLocaleString() : '—'],
      ['Likes', d.likes != null ? d.likes.toLocaleString() : '—'],
      ['Updated', d.updatedAt ? `${fmtRelative(d.updatedAt)} (${fmtFull(d.updatedAt)})` : '—'],
      ['License', lic ? (lic.link && /^https?:/i.test(lic.link) ? ext(lic.link, lic.name || lic.id) : (lic.name || lic.id || '—')) : '—'],
      d.baseModels?.length ? ['Based on', d.baseModels.join(', ')] : null,
    ].filter(Boolean);
    this.filesEl = h('div.files-wrap');
    const card = d.card?.text ? h('div.prose.model-card', renderMarkdown(d.card.text, { quietImages: true })) : null;
    mount(this.el,
      this.back(d.source),
      h('header.model-head',
        h('div.grow',
          h('h1.h1.model-title', d.name || d.id),
          h('div.model-sub', d.publisher ? h('span', d.publisher) : null, h('span.faint', SOURCES[d.source]?.label || d.source),
            /^https?:/i.test(d.url || '') ? ext(d.url, `View on ${SOURCES[d.source]?.site || 'the web'}`) : null)),
        h('div.row-wrap.model-badges',
          d.kind ? h('span.badge.outline', d.kind) : null,
          ...(d.capabilities || []).filter((c) => c !== d.kind).map((c) => h('span.badge.outline', c)),
          d.gated ? h('span.badge.warn', icon('lock', { size: 11 }), 'gated') : null)),
      d.gated ? h('div.callout.warn', icon('lock'), h('div', h('b', 'The publisher approves each download. '), 'Accept their terms on Hugging Face first; Harness cannot download gated models in one click.')) : null,
      this.glance(d),
      d.description ? h('p.model-desc', d.description) : null,
      h('dl.kv.model-kv', numbers.flatMap(([k, v]) => [h('dt', k), h('dd', v)])),
      h('section.panel-section', h('h2.h2', 'Files'), d.hasProjector ? h('p.field-help', `This model reads images through an extra part (${fmtBytes((d.projectors || []).reduce((n, p) => n + (p.size || 0), 0))}). On a Mac with little memory Harness makes a text-only copy without it.`) : null, this.filesEl),
      (d.notes || []).length ? h('ul.model-notes.faint.small', d.notes.map((n) => h('li', n))) : null,
      d.sourceNote ? h('p.field-help', d.sourceNote) : null,
      card ? h('section.panel-section', h('h2.h2', 'Model card'), d.card.truncated ? h('p.field-help', 'Shortened — the full card is on the website.') : null, card) : null,
    );
    this.renderFiles();
  }

  renderFiles() {
    const d = this.detail;
    if (!d || !this.filesEl) return;
    const rows = d.files.map((f) => {
      const fit = f.fit;
      const copy = fit?.basis === 'text_only_copy';
      return h(`tr${f.recommended || f.tag === d.recommendedTag ? '.recommended' : ''}${fit && !fit.fits ? '.unfit' : ''}`, { dataset: { tag: f.tag } },
        h('td', h('div.row-wrap', h('b.mono', f.tag), f.tag === d.recommendedTag ? h('span.badge.accent', 'best fit') : null, f.installed ? h('span.badge', 'installed') : null),
          h('div.faint.small.mono.ellipsis', { title: f.model }, f.model)),
        h('td.num', fmtBytes(f.downloadBytes || f.sizeBytes), f.projectorBytes ? h('div.faint.small', `incl. ${fmtBytes(f.projectorBytes)} image part`) : null),
        h('td', fit ? h(`span.fit-chip.${fit.fits ? 'ok' : 'no'}`, fit.fits ? icon('check', { size: 12 }) : null, fit.fits ? `${fmtTokens(fit.numCtx)} context${copy ? ' · text-only' : ''}` : 'Too big') : h('span.faint', '—'),
          fit?.explanation ? h('div.small.faint.fit-expl', fit.explanation) : null),
        h('td.actions', this.downloadButton(d, f, { primary: f.tag === d.recommendedTag })));
    });
    mount(this.filesEl, d.files.length
      ? h('div.table-wrap', h('table.table.files-table', h('thead', h('tr', h('th', 'Version'), h('th', 'Download'), h('th', 'On this Mac'), h('th', h('span.sr-only', 'Actions')))), h('tbody', rows)))
      : h('p.muted', 'No files.'));
  }
}

/** Download a file from the catalogue; on a small Mac also make its text-only copy (one click). */
export async function downloadFromCatalog(f) {
  const textOnlyCopy = !!f.textOnly?.recommended;
  const r = await pullModel({ model: f.model, textOnlyCopy, quiet: true });
  if (!r) return false;
  const made = r?.textOnlyCopy?.model;
  const target = made || f.model;
  const s = store.get('settings');
  let madeDefault = false;
  if (!s?.defaultModel) {
    try { await patchSettings({ defaultModel: { providerId: 'ollama', model: target } }); await loadModels(); madeDefault = true; } catch (e) { showError(e, 'set the default model'); }
  }
  toast({
    kind: 'success',
    message: `${modelShort(target, 40)} is ready`,
    detail: `${made ? 'Downloaded and set up as a text-only copy, which needs about 1 GB less memory here and cannot read images. ' : ''}${madeDefault ? 'It is now your default model.' : ''}`.trim() || null,
    action: made ? { label: 'Remove original', run: () => removeOriginal(f.model) } : { label: 'Chat', run: () => navigate('/chat') },
    timeout: 9000,
    id: `pull-${f.model}`,
  });
  return true;
}

export { add };
