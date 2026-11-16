// Memory: browse / search / filter, add, edit inline, pin, delete (with undo), review unverified memories,
// the global switches, and a "what would be recalled?" tester.
import { h, debounce, mount, focusWhenReady } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { fmtRelative, plural, fmtFull, truncate } from '../lib/format.js';
import { store, bus, patchSettings } from '../state.js';
import * as api from '../api.js';
import { toast, confirmDialog } from '../ui/overlays.js';
import { showError } from '../errors.js';
import { navigate } from '../router.js';

const CATS = ['fact', 'preference', 'project', 'instruction', 'other'];
const CAT_LABEL = { fact: 'Fact', preference: 'Preference', project: 'Project', instruction: 'Instruction', other: 'Other' };
const ORIGIN_LABEL = { auto: 'learned', manual: 'added by you', tool: 'saved by the model' };

/** Memories that need a human look (field names per docs/API.md §3.6). */
export const needsReview = (m) => !!(m.needsReview || m.unverified || m.review === 'pending' || m.status === 'unverified');

export class MemoryView {
  constructor(shell) {
    this.shell = shell;
    this.q = '';
    this.category = '';
    this.pinnedOnly = false;
    this.list = [];
    this.total = 0;
    this.editing = null;
    this.pendingDelete = new Map();
    this.adding = false;
    this.page = h('div.page.memory-page');
    this.scroller = h('div.view-scroll', this.page);
    this.el = h('div.view', this.scroller);
    this.reload = debounce(() => this.load(), 200);
    bus.on('memories', () => { if (!this.editing) this.reload(); });
    store.watch(['settings'], () => this.render());
    this.scroller.addEventListener('scroll', () => this.shell.setScrolled(this.scroller.scrollTop > 4), { passive: true });
  }

  show() { this.load(); }

  toolbar() { return { title: h('div.tb-title.page-title', h('span.title-text', 'Memory')), actions: [] }; }

  async load() {
    try {
      const r = await api.memories.list({ q: this.q || undefined, category: this.category || undefined, pinned: this.pinnedOnly ? true : undefined, limit: 500 });
      this.list = r.memories;
      this.total = r.total;
    } catch (e) { showError(e, 'load memories'); }
    this.render();
  }

  render() {
    const s = store.get('settings');
    if (!s) return;
    const sw = (label, help, path, value) => h('div.setting-line',
      h('div.grow', h('div', label), h('div.faint.small', help)),
      h('button.switch', { type: 'button', role: 'switch', 'aria-checked': String(!!value), 'aria-label': label, on: { click: async () => { try { const parts = path.split('.'); await patchSettings({ [parts[0]]: { [parts[1]]: !value } }); } catch (e) { showError(e); } } } }));

    const search = h('input.input', { type: 'search', value: this.q, placeholder: 'Search memories', attrs: { 'aria-label': 'Search memories' } });
    search.addEventListener('input', debounce(() => { this.q = search.value.trim(); this.load(); }, 220));
    const chips = h('div.row-wrap.cat-chips', { role: 'group', attrs: { 'aria-label': 'Filter by category' } },
      h('button.chip', { type: 'button', 'aria-pressed': String(!this.category && !this.pinnedOnly), on: { click: () => { this.category = ''; this.pinnedOnly = false; this.load(); } } }, 'All'),
      h('button.chip', { type: 'button', 'aria-pressed': String(this.pinnedOnly), on: { click: () => { this.pinnedOnly = !this.pinnedOnly; this.load(); } } }, icon('pinFilled', { size: 11 }), 'Pinned'),
      ...CATS.map((c) => h('button.chip', { type: 'button', 'aria-pressed': String(this.category === c), on: { click: () => { this.category = this.category === c ? '' : c; this.load(); } } }, CAT_LABEL[c])));

    const visible = this.list.filter((m) => !this.pendingDelete.has(m.id));
    const review = visible.filter(needsReview);
    const rest = visible.filter((m) => !needsReview(m));
    const focused = document.activeElement === this.searchEl;
    this.searchEl = search;

    mount(this.page, 
      h('div.page-head', h('h1.h1', 'Memory'), h('span.muted', plural(this.total, 'memory', 'memories')), h('button.btn.btn-primary.btn-small', { type: 'button', on: { click: () => { this.adding = true; this.render(); } } }, icon('plus', { size: 13 }), 'Add memory')),
      h('p.lede', 'Harness remembers durable facts and preferences across chats. Pinned memories go into every chat; others are added when they are relevant. Incognito chats never read or write memory.'),
      h('section.panel-section.memory-switches',
        sw('Use memory', 'Add relevant memories to prompts.', 'memory.enabled', s.memory?.enabled !== false),
        sw('Learn from conversations', 'Save new facts a few seconds after each reply.', 'memory.autoExtract', s.memory?.autoExtract !== false),
        sw('Recall past chats', 'Let the model look up earlier conversations.', 'recall.enabled', s.recall?.enabled !== false)),
      this.adding ? this.addForm() : null,
      h('div.memory-tools', h('div.search-field.grow', icon('search', { size: 14 }), search), chips),
      review.length ? h('section.panel-section', h('h2.h2', 'Needs your review'), h('p.field-help', 'Saved while the chat involved content from outside (a web page, a file). Keep only what is true.'), h('div.mem-list', review.map((m) => this.row(m)))) : null,
      h('div.mem-list', rest.length ? rest.map((m) => this.row(m)) : h('div.empty', icon('memory', { size: 22 }), h('div.empty-title', this.q || this.category || this.pinnedOnly ? 'No matching memories' : 'Nothing remembered yet'), h('div', 'Tell Harness about yourself in a chat (“I prefer metric units”), use /remember, or add one here.'))),
      this.tester(),
    );
    if (focused) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }

  addForm() {
    const ta = h('textarea.textarea', { rows: 2, placeholder: 'e.g. I prefer concise answers with code examples in Python.', attrs: { 'aria-label': 'New memory' } });
    const cat = h('select.select.input-small', { attrs: { 'aria-label': 'Category' } }, CATS.map((c) => h('option', { value: c, selected: c === 'fact' }, CAT_LABEL[c])));
    const pin = h('input', { type: 'checkbox', id: 'mem-pin' });
    const save = async () => {
      const content = ta.value.trim();
      if (!content) return;
      const ok = await this.create({ content, category: cat.value, pinned: pin.checked });
      if (ok) { this.adding = false; this.load(); }
    };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); save(); } if (e.key === 'Escape') { this.adding = false; this.render(); } });
    focusWhenReady(ta);
    return h('section.mem-add.card', ta, h('div.row', cat, h('label.row.small', pin, 'Pin (always include)'), h('span.spacer'),
      h('button.btn.btn-small', { type: 'button', on: { click: () => { this.adding = false; this.render(); } } }, 'Cancel'),
      h('button.btn.btn-small.btn-primary', { type: 'button', on: { click: save } }, 'Save')));
  }

  /** POST a memory; if the server flags it as a likely secret, ask before overriding. */
  async create(body) {
    try {
      const r = await api.memories.create(body);
      toast({ kind: 'success', message: r.action === 'unchanged' ? 'Already remembered' : r.action === 'updated' ? 'Updated a similar memory' : 'Remembered', detail: truncate(r.memory.content, 120) });
      return true;
    } catch (e) {
      if (/secret|sensitive|credential/i.test(e.code || '')) {
        const go = await confirmDialog({ title: 'This looks like a password or API key', message: `${e.message}\n\nMemories are added to prompts in future chats. Save it anyway?`, confirmLabel: 'Save anyway', danger: true });
        if (!go) return false;
        try { await api.memories.create({ ...body, ...secretOverride(e) }); toast({ kind: 'success', message: 'Remembered' }); return true; } catch (e2) { showError(e2, 'save the memory'); return false; }
      }
      showError(e, 'save the memory');
      return false;
    }
  }

  row(m) {
    const editing = this.editing === m.id;
    const review = needsReview(m);
    const src = m.source?.chatId ? h('a.small', { href: `#/chat/${m.source.chatId}${m.source.messageId ? `?m=${m.source.messageId}` : ''}` }, 'source chat') : null;
    const meta = h('div.mem-meta.faint.small',
      h('span', ORIGIN_LABEL[m.origin] || m.origin),
      h('span', { title: fmtFull(m.updatedAt) }, fmtRelative(m.updatedAt)),
      m.useCount ? h('span', `used ${plural(m.useCount, 'time')}${m.lastUsedAt ? `, last ${fmtRelative(m.lastUsedAt)}` : ''}`) : h('span', 'not used yet'),
      src);
    if (editing) {
      const ta = h('textarea.textarea', { value: m.content, rows: Math.max(2, Math.ceil(m.content.length / 80)), attrs: { 'aria-label': 'Memory' } });
      const cat = h('select.select.input-small', { attrs: { 'aria-label': 'Category' } }, CATS.map((c) => h('option', { value: c, selected: c === m.category }, CAT_LABEL[c])));
      const save = async () => {
        const body = { content: ta.value.trim(), category: cat.value };
        try { await api.memories.update(m.id, body); this.editing = null; this.load(); } catch (e) {
          if (e.code === 'secret_detected' && await confirmDialog({ title: 'This looks like a password or API key', message: `${e.message}\n\nMemories are added to prompts in future chats and included in backups. Save it anyway?`, confirmLabel: 'Save anyway', danger: true })) {
            try { await api.memories.update(m.id, { ...body, ...secretOverride(e) }); this.editing = null; this.load(); } catch (e2) { showError(e2, 'save the memory'); }
          } else if (e.code !== 'secret_detected') showError(e, 'save the memory');
        }
      };
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === 'Escape') { this.editing = null; this.render(); } });
      focusWhenReady(ta);
      return h('div.mem-row.editing', { dataset: { memoryId: m.id } }, h('div.grow.stack', ta, h('div.row', cat, h('span.spacer'), h('button.btn.btn-small', { type: 'button', on: { click: () => { this.editing = null; this.render(); } } }, 'Cancel'), h('button.btn.btn-small.btn-primary', { type: 'button', on: { click: save } }, 'Save'))));
    }
    return h(`div.mem-row${review ? '.review' : ''}`, { dataset: { memoryId: m.id } },
      h('button.icon-btn.small.pin-btn', { type: 'button', 'aria-pressed': String(!!m.pinned), title: m.pinned ? 'Unpin' : 'Pin — include in every chat', 'aria-label': m.pinned ? 'Unpin memory' : 'Pin memory', on: { click: () => this.update(m, { pinned: !m.pinned }) } }, icon(m.pinned ? 'pinFilled' : 'pin', { size: 14 })),
      h('div.grow',
        h('div.mem-content', { tabIndex: 0, title: 'Click to edit', on: { click: () => { this.editing = m.id; this.render(); }, keydown: (e) => { if (e.key === 'Enter') { this.editing = m.id; this.render(); } } } }, m.content),
        h('div.row-wrap', h(`span.badge.cat-${m.category}`, CAT_LABEL[m.category] || m.category), review ? h('span.badge.warn', 'unverified') : null, meta)),
      review ? h('button.btn.btn-small', { type: 'button', on: { click: () => this.update(m, reviewedPatch(m)) } }, icon('check', { size: 13 }), 'Keep') : null,
      h('button.icon-btn.small', { type: 'button', title: 'Edit', 'aria-label': 'Edit memory', on: { click: () => { this.editing = m.id; this.render(); } } }, icon('pencil', { size: 14 })),
      h('button.icon-btn.small', { type: 'button', title: 'Delete', 'aria-label': 'Delete memory', on: { click: () => this.remove(m) } }, icon('trash', { size: 14 })));
  }

  async update(m, patch) {
    try { await api.memories.update(m.id, patch); this.load(); } catch (e) { showError(e, 'update the memory'); }
  }

  remove(m) {
    const timer = setTimeout(async () => {
      this.pendingDelete.delete(m.id);
      try { await api.memories.remove(m.id); } catch (e) { showError(e, 'delete the memory'); }
      this.load();
    }, 5000);
    this.pendingDelete.set(m.id, timer);
    this.render();
    toast({ message: 'Memory deleted', detail: truncate(m.content, 100), timeout: 5000, id: `memdel-${m.id}`, action: { label: 'Undo', run: () => { clearTimeout(timer); this.pendingDelete.delete(m.id); this.render(); } } });
  }

  tester() {
    const input = h('input.input', { type: 'search', placeholder: 'Type a message to see which memories it would pull in', attrs: { 'aria-label': 'Test recall' } });
    const out = h('div.stack');
    const run = debounce(async () => {
      const q = input.value.trim();
      if (!q) { mount(out); return; }
      try {
        const r = await api.memories.search(q, { k: 8 });
        mount(out, h('div.faint.small', `${r.retrieval === 'hybrid' ? 'Semantic + keyword' : 'Keyword'} search${r.embeddingModel ? ` (${r.embeddingModel})` : ''}`),
          ...(r.results.length ? r.results.map((x) => h('div.row.mem-test-row', h('span.badge.num', x.score.toFixed(2)), h('span.grow', truncate(x.memory.content, 160)))) : [h('div.muted.small', 'Nothing would be recalled.')]));
      } catch (e) { mount(out, h('div.field-error', e.message)); }
    }, 300);
    input.addEventListener('input', run);
    return h('section.panel-section', h('h2.h2', 'What would be recalled?'), input, out,
      h('p.faint.small', 'Everything here stays on this computer. ', h('a', { href: '#/settings/memory', on: { click: (e) => { e.preventDefault(); navigate('/settings/memory'); } } }, 'Memory settings'), ' · ', h('a', { href: '#/settings/data' }, 'Delete all memories')));
  }
}

/** Body flag that overrides the secret check (reconciled with docs/API.md §5.9). */
export function secretOverride(err) {
  const flag = err?.details?.override || err?.details?.flag || 'allowSecret';
  return { [flag]: true };
}

/** Patch that marks a memory as reviewed (reconciled with docs/API.md §3.6). */
export function reviewedPatch(m) {
  if ('needsReview' in m) return { needsReview: false };
  if ('unverified' in m) return { unverified: false };
  if ('review' in m) return { review: 'approved' };
  return { status: 'active' };
}
