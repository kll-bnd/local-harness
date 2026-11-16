// Sidebar: new chat, search (instant title filter + full-text message search), navigation, the chat list
// grouped by recency (pinned first), per-chat actions, archive, and a live "machine" status block.
import { h, debounce, delegate, mount, add } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { recencyGroup, modelLabel, fmtBytes, fmtWhen, fmtTokens } from '../lib/format.js';
import { store, loadArchived, ollamaStatus } from '../state.js';
import * as api from '../api.js';
import { runAction, keyLabel, getAction } from '../actions.js';
import { navigate } from '../router.js';
import { openMenu, bindContextMenu } from '../ui/overlays.js';
import { peekChatModel } from '../chat/session.js';

export class Sidebar {
  constructor(shell) {
    this.shell = shell;
    this.query = '';
    this.results = null;
    this.showArchived = false;
    this.renaming = null;
    this.pendingDeletes = new Set();
    this.searchAbort = null;

    this.search = h('input.input', { type: 'search', placeholder: 'Search chats', attrs: { 'aria-label': 'Search chats', 'aria-controls': 'chat-list' } });
    this.listEl = h('nav.chat-list#chat-list', { attrs: { 'aria-label': 'Chats' } });
    this.resultsEl = h('div.search-results', { hidden: true, role: 'region', attrs: { 'aria-label': 'Search results' } });
    this.navEl = h('div.side-nav');
    this.footEl = h('div.side-foot');
    this.el = h('aside.sidebar', { attrs: { 'aria-label': 'Sidebar' } }, h('div.sidebar-inner',
      h('div.titlebar.side-titlebar',
        h('button.icon-btn', { type: 'button', title: `Hide sidebar (${keyLabel(getAction('toggle-sidebar')?.keys?.[0])})`, 'aria-label': 'Hide sidebar', on: { click: () => runAction('toggle-sidebar') } }, icon('sidebar')),
        h('button.icon-btn', { type: 'button', title: `New chat (${keyLabel(getAction('new-chat')?.keys?.[0])})`, 'aria-label': 'New chat', on: { click: () => runAction('new-chat') } }, icon('compose'))),
      h('div.side-search', h('div.search-field', icon('search', { size: 14 }), this.search)),
      this.navEl,
      this.listEl,
      this.resultsEl,
      this.footEl,
    ));

    this.search.addEventListener('input', () => this.onSearch());
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.search.value = ''; this.onSearch(); this.shell.focusComposer(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); (this.resultsEl.hidden ? this.listEl : this.resultsEl).querySelector('a')?.focus(); }
      if (e.key === 'Enter') { const a = (this.resultsEl.hidden ? this.listEl : this.resultsEl).querySelector('a'); if (a) { e.preventDefault(); a.click(); } }
    });
    this.fullText = debounce(() => this.runFullText(), 260);
    delegate(this.listEl, 'click', '[data-chat-more]', (e, el) => { e.preventDefault(); e.stopPropagation(); const c = this.findChat(el.dataset.chatMore); if (c) this.shell.chatMenu(el, c); });
    delegate(this.listEl, 'dblclick', '.chat-item', (e, el) => { this.startRename(el.dataset.chatId); });
    delegate(this.listEl, 'keydown', 'a.chat-link', (e, el) => {
      const items = [...this.listEl.querySelectorAll('a.chat-link')];
      const i = items.indexOf(el);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[i + 1]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); if (i === 0) this.search.focus(); else items[i - 1]?.focus(); }
      if (e.key === 'F2' || (e.key === 'Enter' && e.altKey)) { e.preventDefault(); this.startRename(el.closest('.chat-item').dataset.chatId); }
      if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runAction('delete-chat', el.closest('.chat-item').dataset.chatId); }
    });
    bindContextMenu(this.listEl, (e) => {
      const item = e.target.closest('.chat-item');
      const c = item && this.findChat(item.dataset.chatId);
      return c ? this.shell.chatMenuItems(c) : null;
    });

    this.offs = [
      store.watch(['chats', 'archived', 'route'], () => this.renderList()),
      store.watch(['system', 'route', 'imageJobs', 'pulls', 'memoryCount'], () => { this.renderNav(); this.renderFoot(); }),
    ];
    this.renderNav();
    this.renderList();
    this.renderFoot();
  }

  findChat(id) { return [...(store.get('chats') || []), ...(store.get('archived') || [])].find((c) => c.id === id); }

  focusSearch() { this.search.focus(); this.search.select(); }

  // ------------------------------------------------------------------------------------------ nav + footer
  renderNav() {
    const r = store.get('route');
    const item = (view, ic, label, path, count) => h('a.side-nav-item', { href: `#${path}`, attrs: { 'aria-current': r.view === view ? 'page' : null } }, icon(ic), h('span', label), count != null ? h('span.count', count) : null);
    const jobs = Object.values(store.get('imageJobs') || {}).filter((j) => !['done', 'error', 'aborted'].includes(j.status));
    const pulls = Object.values(store.get('pulls') || {}).filter((p) => !p.done);
    mount(this.navEl, 
      item('images', 'image', 'Image studio', '/images', jobs.length ? `${jobs.length} running` : null),
      item('models', 'cube', 'Models', '/models', pulls.length ? `${Math.round(pulls[0].percent || 0)}%` : null),
      item('memory', 'memory', 'Memory', '/memory', store.get('memoryCount') ?? null),
    );
  }

  renderFoot() {
    const sys = store.get('system');
    const r = store.get('route');
    const { provider, running } = ollamaStatus();
    const others = (sys?.providers || []).filter((p) => p.id !== 'ollama' && p.status === 'running');
    const loaded = sys?.loadedModels || [];
    const unloadedForImage = sys?.modelState?.unloadedForImage;
    const img = (sys?.imageProviders || []).find((p) => p.status === 'running');
    const ram = sys?.machine?.totalMemBytes;
    const lines = [];
    if (!sys) lines.push(h('span.m-line', h('span.dot'), h('span.m-label', 'Connecting…')));
    else {
      lines.push(h('span.m-line', h(`span.dot${running ? '.ok' : '.err'}`), h('span.m-label', h('b', 'Ollama'), running ? ` ${provider?.version || ''}`.trimEnd() : ' not running', others.length ? ` · +${others.length} server${others.length > 1 ? 's' : ''}` : '')));
      if (unloadedForImage) lines.push(h('span.m-line', h('span.dot.warn'), h('span.m-label', 'Chat model unloaded for images')));
      else if (loaded.length) lines.push(h('span.m-line', h('span.dot.ok'), h('span.m-label', { title: loaded.map((m) => `${m.model} — ${fmtBytes(m.sizeBytes)}${m.contextLength ? `, ${fmtTokens(m.contextLength)} context` : ''}`).join('\n') }, h('b', modelLabel(loaded[0].model)), ` · ${fmtBytes(loaded[0].vramBytes || loaded[0].sizeBytes)}`, loaded.length > 1 ? ` +${loaded.length - 1}` : '')));
      else if (running) lines.push(h('span.m-line', h('span.dot'), h('span.m-label', 'No model loaded')));
      lines.push(h('span.m-line', h(`span.dot${img ? '.ok' : ''}`), h('span.m-label', img ? h('span', h('b', img.name.replace(/\s*\(.*\)$/, '')), ' ready') : 'No image backend')));
      if (ram) lines.push(h('span.m-line', icon('chip', { size: 12 }), h('span.m-label.faint', `${Math.round(ram / 1024 ** 3)} GB RAM${sys.machine.appleSilicon ? ` · ${sys.machine.chip}` : ''}`)));
    }
    mount(this.footEl, 
      h('button.machine', { type: 'button', title: 'Setup & health', attrs: { 'aria-current': r.view === 'setup' ? 'page' : null }, on: { click: () => navigate('/setup') } }, lines),
      h('div.row.side-foot-row',
        h('button.btn.btn-ghost.btn-small', { type: 'button', 'aria-pressed': String(this.showArchived), on: { click: () => this.toggleArchived() } }, icon('archive', { size: 14 }), this.showArchived ? 'Hide archived' : 'Archived'),
        h('span.spacer'),
        h('a.icon-btn', { href: '#/settings', title: `Settings (${keyLabel('Mod+,')})`, 'aria-label': 'Settings', attrs: { 'aria-current': r.view === 'settings' ? 'page' : null } }, icon('settings'))),
    );
  }

  async toggleArchived() {
    this.showArchived = !this.showArchived;
    if (this.showArchived) await loadArchived().catch(() => {});
    this.renderList();
    this.renderFoot();
  }

  // ------------------------------------------------------------------------------------------ list
  renderList() {
    const chats = (store.get('chats') || []).filter((c) => !this.pendingDeletes.has(c.id));
    const r = store.get('route');
    const q = this.query.toLowerCase();
    const filtered = q ? chats.filter((c) => (c.title || '').toLowerCase().includes(q)) : chats;
    const groups = new Map();
    for (const c of filtered) {
      const g = c.pinned ? 'Pinned' : recencyGroup(c.updatedAt);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    const frag = [];
    for (const [g, list] of groups) {
      frag.push(h('div.chat-group-title', { role: 'heading', attrs: { 'aria-level': 3 } }, g));
      for (const c of list) frag.push(this.item(c, r.view === 'chat' && r.chatId === c.id));
    }
    if (this.showArchived) {
      const arch = (store.get('archived') || []).filter((c) => !this.pendingDeletes.has(c.id) && (!q || (c.title || '').toLowerCase().includes(q)));
      frag.push(h('div.chat-group-title', 'Archived'));
      if (!arch.length) frag.push(h('div.faint.small.side-empty', 'No archived chats'));
      for (const c of arch) frag.push(this.item(c, r.view === 'chat' && r.chatId === c.id));
    }
    if (store.get('chats') && !chats.length && !this.showArchived) {
      frag.push(h('div.side-empty', h('div', 'No chats yet.'), h('div.faint', `Start one with ${keyLabel('Mod+N')}.`)));
    } else if (q && !filtered.length) {
      frag.push(h('div.side-empty.faint', 'No chat titles match.'));
    }
    mount(this.listEl, ...frag);
    if (this.renaming) this.mountRename();
  }

  item(c, current) {
    const generating = c.generating || !!peekChatModel(c.id)?.live;
    return h('div.chat-item', {
      class: { incognito: c.incognito, archived: c.archived },
      dataset: { chatId: c.id },
      attrs: { 'aria-current': current ? 'page' : null },
    },
    h('a.chat-link', { href: `#/chat/${c.id}`, title: c.title || 'New chat', attrs: { 'aria-label': `${c.title || 'New chat'}${c.incognito ? ' (incognito)' : ''}${c.pinned ? ' (pinned)' : ''}`, 'aria-current': current ? 'page' : null } }),
    c.incognito ? h('span.chat-meta', { title: 'Incognito' }, icon('incognito', { size: 13 })) : null,
    h(`span.chat-title${c.title ? '' : '.untitled'}`, c.title || 'New chat'),
    h('span.chat-meta', generating ? h('span.dot.busy', { title: 'Generating' }) : c.pinned ? icon('pinFilled', { size: 11 }) : null),
    h('button.icon-btn.small.chat-more', { type: 'button', title: 'Chat actions', 'aria-label': `Actions for ${c.title || 'chat'}`, 'aria-haspopup': 'menu', dataset: { chatMore: c.id } }, icon('more', { size: 14 })));
  }

  startRename(id) {
    this.renaming = id;
    this.mountRename();
  }

  mountRename() {
    const el = this.listEl.querySelector(`.chat-item[data-chat-id="${CSS.escape(this.renaming)}"]`);
    if (!el || el.querySelector('.rename-input')) return;
    const c = this.findChat(this.renaming);
    const input = h('input.input.rename-input', { value: c?.title || '', attrs: { 'aria-label': 'Chat title' } });
    const titleEl = el.querySelector('.chat-title');
    titleEl.replaceWith(input);
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      this.renaming = null;
      const v = input.value.trim();
      if (save && v && v !== c?.title) await this.shell.renameChat(c.id, v);
      this.renderList();
      if (save !== null) this.listEl.querySelector(`.chat-item[data-chat-id="${CSS.escape(c.id)}"] a`)?.focus();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); finish(false); } e.stopPropagation(); });
    input.addEventListener('blur', () => finish(true));
    input.focus();
    input.select();
  }

  hideForDelete(id, on) {
    if (on) this.pendingDeletes.add(id); else this.pendingDeletes.delete(id);
    this.renderList();
  }

  // ------------------------------------------------------------------------------------------ search
  onSearch() {
    this.query = this.search.value.trim();
    this.renderList();
    if (this.query.length >= 2) this.fullText();
    else { this.fullText.cancel(); this.results = null; this.renderResults(); }
  }

  async runFullText() {
    const q = this.query;
    this.searchAbort?.abort();
    const ac = new AbortController();
    this.searchAbort = ac;
    try {
      const r = await api.search(q, { limit: 40 }, { signal: ac.signal });
      if (q !== this.query) return;
      this.results = r.results.filter((x) => x.messageId);
      this.renderResults();
    } catch (e) {
      if (e.name !== 'AbortError') { this.results = []; this.renderResults(); }
    }
  }

  renderResults() {
    const res = this.results;
    if (!res || !this.query) { this.resultsEl.hidden = true; this.listEl.classList.remove('with-results'); return; }
    this.resultsEl.hidden = false;
    this.listEl.classList.add('with-results');
    const hl = (snippet, ranges) => {
      const out = [];
      let at = 0;
      for (const [s, e] of ranges) { if (s < at) continue; out.push(snippet.slice(at, s), h('mark', snippet.slice(s, e))); at = e; }
      out.push(snippet.slice(at));
      return out;
    };
    mount(this.resultsEl, 
      h('div.chat-group-title', res.length ? `Messages · ${res.length}` : 'Messages'),
      ...(res.length ? res.map((x) => h('a.search-hit', {
        href: `#/chat/${x.chatId}?m=${x.messageId}`,
        on: { click: (e) => { e.preventDefault(); this.shell.openSearchHit(x); } },
      }, h('div.hit-title.ellipsis', x.chatTitle || 'Untitled'), h('div.hit-snippet', hl(x.snippet, x.highlights || [])), h('div.hit-meta', `${x.role === 'user' ? 'You' : 'Assistant'} · ${fmtWhen(x.createdAt)}${x.onActivePath ? '' : ' · other branch'}`)))
        : [h('div.side-empty.faint', 'No messages match.')]),
    );
  }
}
