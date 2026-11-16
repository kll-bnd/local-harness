// The window: sidebar | main (title bar + current view) | inspector. Owns view switching, the title bar,
// chat-level actions (rename, pin, fork, export, archive, delete with undo) and the reconnect banner.
import { h, mount, download, add } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { fmtTokens, fmtBytes, modelLabel, modelShort, fmtUntil, residentOf } from './lib/format.js';
import { store, uiPrefs, setUiPref, localPref, findModel, modelInfo, loadChats, loadArchived } from './state.js';
import * as api from './api.js';
import { Sidebar } from './views/sidebar.js';
import { Inspector } from './views/inspector.js';
import { ChatView } from './views/chat/chat-view.js';
import { navigate } from './router.js';
import { runAction, keyLabel, getAction } from './actions.js';
import { openMenu, toast, openDialog, confirmDialog } from './ui/overlays.js';
import { showError } from './errors.js';
import { peekChatModel, forgetChatModel, mergeChatSummary } from './chat/session.js';

const LAZY_VIEWS = {
  images: () => import('./views/images.js').then((m) => m.ImagesView),
  models: () => import('./views/models.js').then((m) => m.ModelsView),
  memory: () => import('./views/memory.js').then((m) => m.MemoryView),
  settings: () => import('./views/settings.js').then((m) => m.SettingsView),
  setup: () => import('./views/setup.js').then((m) => m.SetupView),
};

export class Shell {
  constructor(root) {
    this.root = root;
    this.views = new Map();
    this.current = null;
    this.narrow = window.matchMedia('(max-width: 860px)');
    this.overlaySidebar = false;
    this.pendingDeletes = new Map(); // chatId → timer

    this.sidebar = new Sidebar(this);
    this.inspector = new Inspector(this);
    this.chatView = new ChatView(this);
    this.views.set('chat', this.chatView);

    this.tb = h('header.titlebar.main-titlebar');
    this.viewHost = h('div.view-host');
    this.main = h('main.main', { attrs: { 'aria-label': 'Main' } }, this.tb, this.viewHost);
    this.live = h('div.sr-only', { role: 'status', 'aria-live': 'polite' });
    this.app = h('div.app', this.sidebar.el, this.main, this.inspector.el, this.live);
    mount(root, this.app);

    this.applyLayout();
    this.narrow.addEventListener('change', () => { this.overlaySidebar = false; this.applyLayout(); });
    store.on('settings', () => { this.applyLayout(); this.applyAppearance(); });
    store.on('route', (r) => this.route(r));
    store.watch(['system', 'models', 'defaultModel'], () => this.updateToolbar());
    this.tb.addEventListener('dblclick', (e) => {
      const t = e.target.closest('[data-action="rename-chat"]');
      if (t) { this.renameInline(t); return; }
      // macOS: double-clicking an empty title-bar area zooms the window (handled by the shell natively).
    });
  }

  // ------------------------------------------------------------------------------------------ layout
  sidebarOpen() { return this.narrow.matches ? this.overlaySidebar : (uiPrefs().sidebar ?? localPref('sidebar', true)) !== false; }
  inspectorOpen() { return !!(uiPrefs().inspector ?? localPref('inspector', false)); }

  applyLayout() {
    const sb = this.sidebarOpen();
    const ins = this.inspectorOpen();
    this.app.classList.toggle('sidebar-closed', !sb);
    this.app.classList.toggle('inspector-open', ins);
    this.backdrop?.remove();
    this.backdrop = null;
    if (this.narrow.matches && sb) {
      this.backdrop = h('div.backdrop', { on: { click: () => this.toggleSidebar(false) } });
      add(this.app, this.backdrop);
    }
    if (ins) this.inspector.renderNow();
    this.updateToolbar();
  }

  applyAppearance() {
    const ui = uiPrefs();
    const root = document.documentElement;
    const theme = ui.theme || 'system';
    if (theme === 'system') root.removeAttribute('data-theme'); else root.dataset.theme = theme;
    if (ui.proseFont === 'serif') root.dataset.prose = 'serif'; else root.removeAttribute('data-prose');
    if (ui.textSize && ui.textSize !== 'default') root.dataset.textSize = ui.textSize; else root.removeAttribute('data-text-size');
    try { localStorage.setItem('harness.ui.theme', JSON.stringify(theme)); } catch { /* ignore */ }
  }

  toggleSidebar(force) {
    const next = force ?? !this.sidebarOpen();
    if (this.narrow.matches) this.overlaySidebar = next;
    else setUiPref('sidebar', next);
    this.applyLayout();
  }

  toggleInspector(force) {
    const next = force ?? !this.inspectorOpen();
    setUiPref('inspector', next);
    this.applyLayout();
    if (next) this.inspector.tabsEl.querySelector('[aria-selected="true"]')?.focus();
  }

  showInspector(tab, opts) {
    if (!this.inspectorOpen()) { setUiPref('inspector', true); this.applyLayout(); }
    this.inspector.show(tab, opts);
  }

  setScrolled(on) { this.tb.classList.toggle('scrolled', on); }

  announce(text) { this.live.textContent = ''; requestAnimationFrame(() => { this.live.textContent = text; }); }

  focusComposer() {
    if (store.get('route').view !== 'chat') navigate(this.chatView.model ? `/chat/${this.chatView.model.id}` : '/chat');
    // The chat view is mounted synchronously by the router, so focus right away (rAF can be throttled).
    this.chatView.composer.focus();
  }

  // ------------------------------------------------------------------------------------------ routing
  async route(r) {
    // Every navigation gets a token; a slower, earlier one (e.g. a lazily imported page) must not win.
    const token = Symbol('route');
    this.routing = token;
    if (this.narrow.matches && this.overlaySidebar) { this.overlaySidebar = false; this.applyLayout(); }
    let view = this.views.get(r.view);
    if (!view && LAZY_VIEWS[r.view]) {
      try {
        const Cls = await LAZY_VIEWS[r.view]();
        if (this.routing !== token) return;
        view = this.views.get(r.view) || new Cls(this);
        this.views.set(r.view, view);
      } catch (e) { showError(e, 'open this page'); return; }
    }
    if (!view) return;
    if (this.current !== view) {
      this.current?.hide?.();
      mount(this.viewHost, view.el);
      this.current = view;
      this.setScrolled(false);
    }
    await view.show?.(r);
    if (this.routing !== token) return;
    this.inspector.bind(r.view === 'chat' ? this.chatView.model : null);
    this.updateToolbar();
    document.title = this.titleFor(r);
  }

  titleFor(r) {
    if (r.view === 'chat') return this.chatView.model ? `${this.chatView.model.title} — Harness` : 'Harness';
    return `${{ images: 'Image studio', models: 'Models', memory: 'Memory', settings: 'Settings', setup: 'Setup' }[r.view] || ''} — Harness`;
  }

  // ------------------------------------------------------------------------------------------ title bar
  updateToolbar() {
    if (!this.tb) return;
    const view = this.current;
    const tb = view?.toolbar?.() || { title: null, status: null, actions: [] };
    const sbClosed = !this.sidebarOpen();
    mount(this.tb, 
      sbClosed ? h('button.icon-btn', { type: 'button', title: `Show sidebar (${keyLabel(getAction('toggle-sidebar')?.keys?.[0])})`, 'aria-label': 'Show sidebar', on: { click: () => runAction('toggle-sidebar') } }, icon('sidebar')) : null,
      sbClosed ? h('button.icon-btn', { type: 'button', title: 'New chat', 'aria-label': 'New chat', on: { click: () => runAction('new-chat') } }, icon('compose')) : null,
      tb.title,
      tb.status ? h('div.tb-status', tb.status) : null,
      h('div.tb-actions',
        ...(tb.actions || []),
        h('button.icon-btn', { type: 'button', title: `Inspector (${keyLabel(getAction('toggle-inspector')?.keys?.[0])})`, 'aria-label': 'Toggle inspector', 'aria-pressed': String(this.inspectorOpen()), on: { click: () => runAction('toggle-inspector') } }, icon('inspector'))),
    );
    if (store.get('route').view === 'chat') document.title = this.titleFor(store.get('route'));
  }

  /** "● Model · 2K" — what is loaded and how big the window is. */
  modelStatusPill(ref) {
    const sys = store.get('system');
    if (!ref) {
      return h('button.status-pill.warn', { type: 'button', on: { click: () => runAction('open-setup') } }, icon('warning', { size: 13 }), h('span.label', 'No model — set one up'));
    }
    const info = findModel(ref);
    const loaded = (sys?.loadedModels || []).find((m) => m.model === ref.model);
    const unloadedForImage = sys?.modelState?.unloadedForImage && (sys.modelState.models || []).includes(ref.model);
    const ollamaDown = (ref.providerId || 'ollama') === 'ollama' && sys && sys.providers?.find((p) => p.id === 'ollama')?.status !== 'running';
    const pill = h('button.status-pill', { type: 'button', on: { click: () => (store.get('route').view === 'chat' ? runAction('show-context') : runAction('open-models')) } });
    const ctxSpan = h('span.faint');
    let dot = 'dot';
    let stateText = '';
    if (ollamaDown) { dot = 'dot.err'; stateText = 'Ollama not running'; pill.classList.add('warn'); }
    else if (unloadedForImage) { dot = 'dot.warn'; stateText = 'unloaded for image'; }
    else if (loaded) { dot = 'dot.ok'; stateText = ''; }
    else stateText = 'not loaded';
    pill.title = ollamaDown ? 'Ollama is not running — click for setup' : loaded ? `Loaded in memory (${fmtBytes(residentOf(loaded))})${loaded.expiresAt ? ` ${fmtUntil(loaded.expiresAt)}` : ''}${loaded.contextLength ? ` with a ${fmtTokens(loaded.contextLength)} window` : ''}` : unloadedForImage ? 'Unloaded to free memory for image generation; reloads on the next message' : 'Loads on the next message (the first reply takes longer)';
    if (ollamaDown) pill.addEventListener('click', (e) => { e.stopImmediatePropagation(); runAction('open-setup'); }, { capture: true });
    pill.title = `${ref.model}\n${pill.title}`;
    add(pill, h(`span.${dot}`), h('span.label', modelShort(info?.name || ref.model, 34)), stateText ? h('span.faint.hide-narrow', stateText) : null, ctxSpan);
    const m = this.chatView.model;
    const plan = m?.plan;
    if (plan?.numCtx) ctxSpan.textContent = `· ${fmtTokens(plan.numCtx)}`;
    else modelInfo(ref).then((r) => { if (r?.contextPlan?.numCtx) ctxSpan.textContent = `· ${fmtTokens(r.contextPlan.numCtx)}`; }).catch(() => {});
    if (plan?.warnings?.length || plan?.limitedBy === 'memory') pill.classList.add('warn');
    return pill;
  }

  renameInline(el) {
    const m = this.chatView.model;
    if (!m) return;
    el.contentEditable = 'true';
    el.focus();
    document.getSelection().selectAllChildren(el);
    const finish = async (save) => {
      el.contentEditable = 'false';
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('blur', onBlur);
      const v = el.textContent.trim();
      if (save && v && v !== m.title) await this.renameChat(m.id, v);
      else el.textContent = m.title;
    };
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    const onBlur = () => finish(true);
    el.addEventListener('keydown', onKey);
    el.addEventListener('blur', onBlur);
  }

  // ------------------------------------------------------------------------------------------ chat actions
  async renameChat(id, title) {
    try {
      const d = await api.chats.update(id, { title });
      mergeChatSummary(d.chat);
      peekChatModel(id)?.setChatMeta(d.chat);
      this.updateToolbar();
    } catch (e) { showError(e, 'rename the chat'); }
  }

  async updateChat(id, body, msg) {
    try {
      const d = await api.chats.update(id, body);
      mergeChatSummary(d.chat);
      peekChatModel(id)?.setChatMeta(d.chat);
      if (body.archived !== undefined) { await loadChats(); if (store.get('archived')) await loadArchived(); }
      if (msg) toast({ kind: 'success', message: msg, id: `chat-${id}` });
      this.updateToolbar();
      return d;
    } catch (e) { showError(e, 'update the chat'); return null; }
  }

  chatMenuItems(c) {
    return [
      { label: 'Rename…', icon: 'pencil', run: () => { if (this.sidebarOpen()) this.sidebar.startRename(c.id); else runAction('rename-chat'); } },
      { label: c.pinned ? 'Unpin' : 'Pin', icon: 'pin', run: () => this.updateChat(c.id, { pinned: !c.pinned }) },
      { label: 'Fork into new chat', icon: 'fork', run: () => this.forkChat(c.id) },
      { label: c.incognito ? 'Turn off incognito' : 'Make incognito', icon: 'incognito', run: () => this.updateChat(c.id, { incognito: !c.incognito }, c.incognito ? 'No longer incognito' : 'Chat is now incognito') },
      { separator: true },
      { label: 'Export…', icon: 'share', run: () => this.exportDialog(c) },
      { label: c.archived ? 'Unarchive' : 'Archive', icon: 'archive', run: () => this.updateChat(c.id, { archived: !c.archived }, c.archived ? 'Chat restored' : 'Chat archived') },
      { separator: true },
      { label: 'Delete', icon: 'trash', danger: true, shortcut: keyLabel('Mod+Shift+Backspace'), run: () => this.deleteChat(c.id) },
      !c.incognito ? { label: 'Delete with its memories…', icon: 'trash', danger: true, run: () => this.deleteChatAndMemories(c) } : null,
    ];
  }

  chatMenu(anchor, c) { openMenu(anchor, this.chatMenuItems(c), { placement: 'bottom-end', label: 'Chat actions' }); }

  async forkChat(id, messageId) {
    try {
      const d = await api.chats.fork(id, messageId);
      mergeChatSummary(d.chat);
      navigate(`/chat/${d.chat.id}`);
      toast({ kind: 'success', message: 'Forked into a new chat' });
    } catch (e) { showError(e, 'fork the chat'); }
  }

  /** Delete with undo: hide immediately, delete for real after a few seconds. */
  deleteChat(id) {
    const c = this.sidebar.findChat(id);
    if (!c) return;
    const m = peekChatModel(id);
    if (m?.live) m.live.controller.abort();
    this.sidebar.hideForDelete(id, true);
    const r = store.get('route');
    if (r.view === 'chat' && r.chatId === id) navigate('/chat');
    const commit = async () => {
      this.pendingDeletes.delete(id);
      try {
        await api.chats.remove(id);
        forgetChatModel(id);
        store.set('chats', (store.get('chats') || []).filter((x) => x.id !== id));
        if (store.get('archived')) store.set('archived', store.get('archived').filter((x) => x.id !== id));
      } catch (e) { this.sidebar.hideForDelete(id, false); showError(e, 'delete the chat'); }
      this.sidebar.hideForDelete(id, false);
    };
    const timer = setTimeout(commit, 6000);
    this.pendingDeletes.set(id, timer);
    toast({ kind: 'info', message: 'Chat deleted', detail: c.title || 'Untitled', timeout: 6000, id: `del-${id}`, action: { label: 'Undo', run: () => { clearTimeout(timer); this.pendingDeletes.delete(id); this.sidebar.hideForDelete(id, false); } } });
  }

  async deleteChatAndMemories(c) {
    if (!await confirmDialog({ title: `Delete “${c.title || 'Untitled'}” and what Harness learned from it?`, message: 'The chat, its attachments and images, and the memories extracted from it are deleted. This cannot be undone.', confirmLabel: 'Delete', danger: true })) return;
    try {
      const r = await api.chats.remove(c.id, { deleteMemories: true });
      forgetChatModel(c.id);
      store.set('chats', (store.get('chats') || []).filter((x) => x.id !== c.id));
      if (store.get('route').chatId === c.id) navigate('/chat');
      const rm = r.removed || {};
      toast({ kind: 'success', message: 'Chat deleted', detail: rm.memories ? `${rm.memories} memor${rm.memories === 1 ? 'y' : 'ies'} removed too.` : 'No memories came from this chat.' });
    } catch (e) { showError(e, 'delete the chat'); }
  }

  flushPendingDeletes() {
    for (const [id, timer] of this.pendingDeletes) { clearTimeout(timer); api.beacon('DELETE', api.chats.removeUrl(id)); }
    this.pendingDeletes.clear();
  }

  exportDialog(c) {
    if (!c) { toast({ message: 'Open a chat to export it' }); return; }
    const embed = h('input', { type: 'checkbox', id: 'exp-embed' });
    const opt = (ic, title, desc, run) => h('button.export-opt', { type: 'button', on: { click: () => { run(); d.close(); } } }, h('span.intro-card-icon', icon(ic)), h('span.intro-card-text', h('b', title), h('span', desc)));
    const d = openDialog({
      title: `Export “${c.title || 'Untitled'}”`,
      size: 'small',
      body: h('div.stack',
        opt('text', 'Markdown', 'The current branch as a readable document', () => download(api.chats.exportUrl(c.id, 'markdown'), `${c.title || 'chat'}.md`)),
        opt('file', 'Harness JSON', 'Every branch and summary — can be imported again', () => download(api.chats.exportUrl(c.id, 'json', { embedImages: embed.checked }), `${c.title || 'chat'}.json`)),
        h('label.row.small', embed, h('span', 'Include generated images in the JSON file')),
        h('p.faint.small', 'For a backup of everything (chats, memories, presets, settings) use Settings → Data.')),
    });
  }

  async openSearchHit(hit) {
    if (!hit.onActivePath) {
      // The hit is on another branch: make it the active one first, then open the chat there.
      try {
        await api.chats.branch(hit.chatId, hit.messageId);
        const m = peekChatModel(hit.chatId);
        if (m && !m.live) await m.load({ force: true });
      } catch (e) { showError(e, 'open that branch'); }
    }
    navigate(`/chat/${hit.chatId}?m=${encodeURIComponent(hit.messageId)}`);
  }
}
