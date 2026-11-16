// The transcript: keyed turn reconciliation, lazy rendering of old turns, auto-scroll that respects the
// user scrolling up, the compaction divider with an inline summary editor, and delegated message actions.
import { h, copyText, delegate, mount, add, focusWhenReady } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { fmtInt, plural, fmtRelative, modelLabel } from '../../lib/format.js';
import { TurnView, groupTurns, turnText } from './turn.js';
import { openMenu, toast, confirmDialog } from '../../ui/overlays.js';
import { openLightbox } from '../../ui/lightbox.js';
import { switchBranch, regenerate, editAndResend, editAssistant, deleteMessage, generateImageInChat } from '../../chat/session.js';
import { showError } from '../../errors.js';
import { runAction } from '../../actions.js';
import { chatModels, store } from '../../state.js';
import * as api from '../../api.js';
import { navigate } from '../../router.js';

const EAGER_TURNS = 24;

export class ConversationView {
  constructor(model, { onEmpty } = {}) {
    this.model = model;
    this.ctx = { model, view: this };
    this.onEmpty = onEmpty;
    this.turns = new Map(); // key → TurnView
    this.order = [];
    this.msgTurn = new Map(); // message id → turn key
    this.expanded = new Set(); // disclosure state that survives re-renders
    this.editing = null;
    this.dirty = new Set();
    this.frame = 0;
    this.pinned = true;
    this.summaryOpen = false;
    this.summaryEditing = false;

    this.inner = h('div.transcript', { role: 'feed', 'aria-label': 'Conversation', 'aria-busy': 'false' });
    this.jump = h('button.jump-latest', { type: 'button', hidden: true, 'aria-label': 'Jump to latest', on: { click: () => this.scrollToBottom(true) } }, icon('arrowDown', { size: 14 }), 'Latest');
    this.scroller = h('div.view-scroll.transcript-scroll', { tabIndex: -1 }, this.inner);
    this.el = h('div.conversation', this.scroller, this.jump);
    this.divider = null;

    // Safari/WebKit has no CSS scroll anchoring: when a placeholder above the viewport turns into a real
    // turn of a different height, keep what the reader is looking at in place by hand.
    const anchoring = typeof CSS !== 'undefined' && CSS.supports?.('overflow-anchor', 'auto');
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const tv = this.turns.get(e.target.dataset.turn);
        if (!tv || tv.materialized) continue;
        const above = !anchoring && e.boundingClientRect.bottom <= (e.rootBounds?.top ?? 0);
        const before = above ? tv.el.offsetHeight : 0;
        tv.materialize();
        this.io.unobserve(e.target);
        if (above) this.scroller.scrollTop += tv.el.offsetHeight - before;
      }
    }, { root: this.scroller, rootMargin: '1600px 0px' });

    this.ro = new ResizeObserver(() => { if (this.pinned) this.stickBottom(); });
    this.ro.observe(this.inner);

    this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.scroller.addEventListener('wheel', (e) => { if (e.deltaY < 0) this.unpin(); }, { passive: true });
    this.scroller.addEventListener('touchmove', () => this.unpin(), { passive: true });
    this.scroller.addEventListener('keydown', (e) => { if (['PageUp', 'ArrowUp', 'Home'].includes(e.key)) this.unpin(); });
    this.scroller.addEventListener('pointerdown', (e) => { if (e.target === this.scroller && e.offsetX > this.scroller.clientWidth - 16) this.unpin(); });
    this.bindActions();

    this.offs = [
      model.on('reset', () => this.reconcile()),
      model.on('change', (ids) => this.markChanged(ids)),
      model.on('live', () => { this.markLast(); this.syncTicker(); }),
      model.on('summary', () => this.renderDivider()),
    ];
    this.reconcile(true);
  }

  /** While the model produces nothing visible (loading / reading), re-render once a second so the elapsed time moves. */
  syncTicker() {
    if (this.model.live && !this.ticker) this.ticker = setInterval(() => { if (!this.model.live) { this.syncTicker(); return; } this.markLast(); this.el.dispatchEvent(new CustomEvent('live-tick', { bubbles: true })); }, 1000);
    else if (!this.model.live && this.ticker) { clearInterval(this.ticker); this.ticker = null; }
  }

  destroy() {
    clearInterval(this.ticker);
    this.offs.forEach((o) => o());
    this.io.disconnect();
    this.ro.disconnect();
    cancelAnimationFrame(this.frame);
  }

  isLastTurn(key) { return this.order[this.order.length - 1] === key; }

  toggleExpanded(key, on) { if (on) this.expanded.add(key); else this.expanded.delete(key); }

  setEditing(id) {
    this.editing = id;
    for (const tv of this.turns.values()) tv.update(tv.turn, true);
  }

  // ------------------------------------------------------------------------------------------ render
  reconcile(initial = false) {
    const turns = groupTurns(this.model);
    this.msgTurn.clear();
    const keys = [];
    for (const t of turns) {
      keys.push(t.key);
      if (t.user) this.msgTurn.set(t.user.id, t.key);
      for (const m of t.chain) this.msgTurn.set(m.id, t.key);
    }
    const keep = new Set(keys);
    for (const [k, tv] of this.turns) if (!keep.has(k)) { tv.el.remove(); this.io.unobserve(tv.el); this.turns.delete(k); }
    this.order = keys;
    let prevEl = null;
    turns.forEach((t, i) => {
      let tv = this.turns.get(t.key);
      if (!tv) {
        const eager = !initial || i >= turns.length - EAGER_TURNS;
        tv = new TurnView(this.ctx, t, { materialize: eager });
        this.turns.set(t.key, tv);
        if (!tv.materialized) this.io.observe(tv.el);
      } else tv.update(t);
      const want = prevEl ? prevEl.nextSibling : this.inner.firstChild;
      if (want !== tv.el) this.inner.insertBefore(tv.el, want);
      prevEl = tv.el;
    });
    // re-render the previously-last turn too (its footer depends on "is last")
    for (const tv of this.turns.values()) tv.update(tv.turn);
    this.renderDivider();
    this.onEmpty?.(!turns.length);
    this.inner.setAttribute('aria-busy', String(!!this.model.live));
    if (initial || this.pinned) this.scrollToBottom();
  }

  markChanged(ids) {
    for (const id of ids || []) {
      const k = this.msgTurn.get(id);
      if (k) this.dirty.add(k);
      else this.dirty.add(this.order[this.order.length - 1]);
    }
    this.schedule();
  }

  markLast() {
    const k = this.order[this.order.length - 1];
    if (k) this.dirty.add(k);
    this.inner.setAttribute('aria-busy', String(!!this.model.live));
    this.schedule();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const turns = groupTurns(this.model);
      const byKey = new Map(turns.map((t) => [t.key, t]));
      if (turns.length !== this.order.length || turns.some((t, i) => t.key !== this.order[i])) { this.dirty.clear(); this.reconcile(); return; }
      for (const k of this.dirty) {
        const tv = this.turns.get(k);
        const t = byKey.get(k);
        if (tv && t) { if (!tv.materialized) tv.materialize(); tv.update(t); }
      }
      this.dirty.clear();
      if (this.pinned) this.stickBottom();
    });
  }

  renderDivider() {
    const s = this.model.chat?.summary;
    const anchorKey = s ? this.msgTurn.get(s.upToMessageId) : null;
    if (!s || !anchorKey) { this.divider?.remove(); this.divider = null; return; }
    const idx = this.model.path.indexOf(s.upToMessageId);
    const count = idx + 1;
    if (!this.divider) this.divider = h('div.compaction');
    const tv = this.turns.get(anchorKey);
    if (tv && tv.el.nextSibling !== this.divider) tv.el.after(this.divider);
    const info = this.model.summaryInfo;
    const head = h('div.compaction-rule',
      h('span.rule'),
      h('button.compaction-label', { type: 'button', 'aria-expanded': String(this.summaryOpen), on: { click: () => { this.summaryOpen = !this.summaryOpen; if (this.summaryOpen && !info) this.model.loadSummary().catch(() => {}); this.renderDivider(); } } },
        icon('summary', { size: 13 }),
        `${plural(count, 'earlier message')} summarized`,
        h('span.faint', ` · ${fmtInt(s.tokens)} tokens${s.editedByUser ? ' · edited' : ''}`),
        icon(this.summaryOpen ? 'chevronUp' : 'chevronDown', { size: 12 })),
      h('span.rule'));
    let body = null;
    if (this.summaryOpen) {
      if (this.summaryEditing) {
        const ta = h('textarea.textarea.mono.summary-edit', { value: s.content, rows: 14, attrs: { 'aria-label': 'Summary text' } });
        body = h('div.compaction-body', h('p.faint.small', 'The model sees this summary instead of the messages above it. Edit it to correct or remove anything.'), ta,
          h('div.row', h('span.spacer'),
            h('button.btn.btn-small', { type: 'button', on: { click: () => { this.summaryEditing = false; this.renderDivider(); } } }, 'Cancel'),
            h('button.btn.btn-small.btn-primary', { type: 'button', on: { click: async () => {
              try { await api.chats.putSummary(this.model.id, ta.value); this.summaryEditing = false; await this.model.loadSummary(); this.model.refreshContext(); toast({ kind: 'success', message: 'Summary saved' }); } catch (e) { showError(e, 'save the summary'); }
            } } }, 'Save summary')));
        focusWhenReady(ta);
      } else {
        body = h('div.compaction-body',
          h('div.prose.summary-prose', renderMarkdown(s.content, { cacheKey: `s:${s.id}:${s.updatedAt}` })),
          h('div.row.small',
            h('span.faint', `${s.method === 'manual' ? 'Compacted manually' : 'Auto-summarized'} ${fmtRelative(s.updatedAt || s.createdAt)}${s.model ? ` by ${modelLabel(s.model)}` : ''}${info?.history?.length > 1 ? ` · ${info.history.length} summaries on this branch` : ''}`),
            h('span.spacer'),
            h('button.btn.btn-small', { type: 'button', on: { click: () => { this.summaryEditing = true; this.renderDivider(); } } }, icon('pencil', { size: 13 }), 'Edit'),
            h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: async () => {
              if (!await confirmDialog({ title: 'Remove this summary?', message: 'The earlier messages will be sent in full again (or truncated if they no longer fit). A new summary is created automatically when needed.', confirmLabel: 'Remove', danger: true })) return;
              try { await api.chats.deleteSummary(this.model.id); await this.model.load({ force: true }); this.model.refreshContext(); } catch (e) { showError(e, 'remove the summary'); }
            } } }, 'Remove')));
      }
    }
    mount(this.divider, head, body);
  }

  // ------------------------------------------------------------------------------------------ scrolling
  onScroll() {
    const d = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight;
    if (d < 40) this.pinned = true;
    this.jump.hidden = d < 240;
    this.el.dispatchEvent(new CustomEvent('transcript-scroll', { bubbles: true, detail: { top: this.scroller.scrollTop } }));
  }

  unpin() {
    const d = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight;
    if (d > 4 || this.model.live) this.pinned = false;
  }

  stickBottom() { this.scroller.scrollTop = this.scroller.scrollHeight; }

  scrollToBottom(smooth = false) {
    this.pinned = true;
    if (smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: 'smooth' });
    else requestAnimationFrame(() => this.stickBottom());
  }

  scrollToMessage(id) {
    const key = this.msgTurn.get(id);
    const tv = key && this.turns.get(key);
    if (!tv) return false;
    const idx = this.order.indexOf(key);
    for (let i = Math.max(0, idx - 2); i <= Math.min(this.order.length - 1, idx + 2); i++) this.turns.get(this.order[i])?.materialize();
    this.pinned = false;
    const target = tv.el.querySelector(`[data-message-id="${CSS.escape(id)}"]`) || tv.el;
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'center' });
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 1600);
    });
    return true;
  }

  // ------------------------------------------------------------------------------------------ actions
  turnFor(key) { return groupTurns(this.model).find((t) => t.key === key); }

  async submitEdit(u, text) {
    this.setEditing(null);
    this.pinned = true;
    await editAndResend(this.model, u.id, { content: text });
  }

  async submitAssistantEdit(m, text) {
    this.setEditing(null);
    await editAssistant(this.model, m.id, text);
  }

  bindActions() {
    delegate(this.el, 'click', '[data-action]', async (e, el) => {
      const a = el.dataset.action;
      const model = this.model;
      if (a === 'copy-code') {
        const code = el.closest('.code-block')?.querySelector('code')?.textContent || '';
        if (await copyText(code)) { el.classList.add('copied'); el.querySelector('span').textContent = 'Copied'; setTimeout(() => { el.classList.remove('copied'); el.querySelector('span').textContent = 'Copy'; }, 1400); }
      } else if (a === 'copy-msg') {
        if (await copyText(model.msg(el.dataset.id)?.content || '')) toast({ message: 'Copied', kind: 'success', timeout: 1500, id: 'copied' });
      } else if (a === 'copy-turn') {
        const t = this.turnFor(el.dataset.id);
        if (t && await copyText(turnText(t))) toast({ message: 'Copied', kind: 'success', timeout: 1500, id: 'copied' });
      } else if (a === 'edit') {
        this.setEditing(el.dataset.id);
      } else if (a === 'branch') {
        await switchBranch(model, el.dataset.target);
      } else if (a === 'regenerate') {
        this.pinned = true;
        await regenerate(model, el.dataset.id);
      } else if (a === 'allow-retry') {
        // A reply refused by the internet blocker: ask with its own details, then answer the message again.
        const { requestInternet } = await import('../network.js');
        if (await requestInternet(model.msg(el.dataset.id)?.errorDetails || {})) { this.pinned = true; await regenerate(model, el.dataset.id); }
      } else if (a === 'image-again') {
        const t = this.turnFor(el.dataset.id);
        const req = t?.user?.imageRequest;
        if (req) { this.pinned = true; await generateImageInChat(model, { ...req, seed: undefined, parentId: t.user.parentId ?? null }); }
      } else if (a === 'turn-menu') {
        this.openTurnMenu(el, el.dataset.id, el.dataset.turn);
      } else if (a === 'open-image') {
        const grid = el.closest('.image-grid');
        const imgs = grid?._images || [];
        openLightbox(imgs, Number(el.dataset.index) || 0, { actions: imageActions });
      } else if (a === 'open-attachment-image') {
        openLightbox([{ url: el.dataset.url, prompt: el.dataset.name }], 0);
      } else if (a === 'cancel-image') {
        try { await api.images.cancel(el.dataset.job); } catch (err) { showError(err, 'cancel the image'); }
      } else if (a === 'show-retrieval') {
        runAction('show-retrieval', el.dataset.id);
      }
    });
    delegate(this.el, 'click', 'a[data-external]', (e, a) => {
      if (window.harnessDesktop?.openExternal) { e.preventDefault(); window.harnessDesktop.openExternal(a.href); }
    });
  }

  openTurnMenu(anchor, lastId, turnKey) {
    const model = this.model;
    const m = model.msg(lastId);
    const t = this.turnFor(turnKey);
    const models = chatModels();
    const isImage = m?.kind === 'image_result';
    const items = [
      !isImage ? { label: 'Regenerate with…', heading: true } : null,
      ...(!isImage ? models.slice(0, 8).map((x) => ({ label: modelLabel(x.name), hint: x.providerId !== 'ollama' ? x.providerName : null, run: () => { this.pinned = true; regenerate(model, lastId, { modelRef: { providerId: x.providerId, model: x.model } }); } })) : []),
      !isImage ? { separator: true } : null,
      !isImage && m?.role === 'assistant' ? { label: 'Edit answer', icon: 'pencil', disabled: model.generating, run: () => this.setEditing(lastId) } : null,
      { label: 'Copy as Markdown', icon: 'copy', run: async () => { if (await copyText(t ? turnText(t) : m?.content || '')) toast({ message: 'Copied', kind: 'success', timeout: 1500, id: 'copied' }); } },
      { label: 'Fork into new chat', icon: 'fork', run: async () => {
        try { const d = await api.chats.fork(model.id, lastId); navigate(`/chat/${d.chat.id}`); toast({ kind: 'success', message: 'Forked into a new chat', detail: d.chat.title }); } catch (e) { showError(e, 'fork the chat'); }
      } },
      { separator: true },
      { label: 'Delete this turn…', icon: 'trash', danger: true, disabled: model.generating, run: async () => {
        const target = t?.user?.id || t?.chain[0]?.id;
        if (!target) return;
        if (await confirmDialog({ title: 'Delete this turn?', message: 'This deletes the message, its replies and everything after it on this branch. Other branches are kept.', confirmLabel: 'Delete', danger: true })) await deleteMessage(model, target);
      } },
    ];
    openMenu(anchor, items, { placement: 'bottom-end', label: 'Message actions' });
  }
}

function imageActions(img, close) {
  return [
    { label: 'Open in studio', icon: 'image', run: () => { close(); navigate('/images'); requestAnimationFrame(() => runAction('studio-reuse', img)); } },
  ];
}

export { store };
