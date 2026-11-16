// Harness web UI entry point: boots the data layer, the global event bus (with reconnect), the command
// registry (keyboard shortcuts, command palette and the Electron menu all share it) and the shell.
import { h, isTypingTarget, pickFiles, download, mount, add } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { truncate } from './lib/format.js';
import * as api from './api.js';
import { store, bus, loadSettings, loadPresets, loadSystem, loadModels, loadChats, loadArchived, refreshSystemSoon, refreshModelsSoon, refreshChatsSoon, setUiPref, uiPrefs, chatModels, dropModelInfo } from './state.js';
import { defineAction, runAction, chordOf, actionForChord, allActions } from './actions.js';
import { Shell } from './shell.js';
import { startRouter, navigate } from './router.js';
import { toast } from './ui/overlays.js';
import { showError } from './errors.js';
import { peekChatModel, forgetChatModel, mergeChatSummary, stopGeneration, compactNow, liveChats } from './chat/session.js';
import { openPalette } from './ui/palette.js';
import { openShortcuts } from './views/shortcuts.js';

const desktop = window.harnessDesktop || null;
const root = document.getElementById('app');
const shell = new Shell(root);
window.__harnessShell = shell; // handy for debugging in DevTools

// ------------------------------------------------------------------------------------------------ actions
const currentChat = () => shell.chatView.model;
const currentSummary = () => {
  const m = currentChat();
  return m ? (store.get('chats') || []).find((c) => c.id === m.id) || (store.get('archived') || []).find((c) => c.id === m.id) || m.chat : null;
};

defineAction('new-chat', { title: 'New chat', keys: ['Mod+N', 'Mod+Shift+O'], group: 'Chats', icon: 'compose', run: () => { store.set('pendingChat', null); navigate('/chat'); requestAnimationFrame(() => shell.chatView.composer.focus()); } });
defineAction('new-incognito-chat', { title: 'New incognito chat', keys: ['Mod+Shift+N'], group: 'Chats', icon: 'incognito', run: () => { store.set('pendingChat', { incognito: true }); navigate('/chat'); shell.chatView.renderIntro(); shell.updateToolbar(); requestAnimationFrame(() => shell.chatView.composer.focus()); } });
defineAction('search-chats', { title: 'Search chats', keys: ['Mod+Shift+F'], group: 'Chats', icon: 'search', run: () => { shell.toggleSidebar(true); requestAnimationFrame(() => shell.sidebar.focusSearch()); } });
defineAction('command-palette', { title: 'Command palette', keys: ['Mod+K', 'Mod+Shift+P'], group: 'General', icon: 'command', palette: false, run: () => openPalette(shell) });
defineAction('open-settings', { title: 'Settings', keys: ['Mod+,'], group: 'Go to', icon: 'settings', run: (section) => navigate(`/settings${typeof section === 'string' ? `/${section}` : ''}`) });
defineAction('open-models', { title: 'Models', keys: ['Mod+Shift+M'], group: 'Go to', icon: 'cube', run: () => navigate('/models') });
defineAction('open-images', { title: 'Image studio', keys: ['Mod+Shift+G'], group: 'Go to', icon: 'image', run: () => navigate('/images') });
defineAction('open-memory', { title: 'Memory', keys: ['Mod+Shift+Y'], group: 'Go to', icon: 'memory', run: () => navigate('/memory') });
defineAction('open-setup', { title: 'Setup & health', group: 'Go to', icon: 'server', run: () => navigate('/setup') });
defineAction('toggle-sidebar', { title: 'Toggle sidebar', keys: ['Mod+Shift+S', 'Mod+Ctrl+S'], group: 'View', icon: 'sidebar', run: () => shell.toggleSidebar() });
defineAction('toggle-inspector', { title: 'Toggle inspector', keys: ['Mod+Shift+I', 'Mod+Alt+I'], group: 'View', icon: 'inspector', run: () => shell.toggleInspector() });
defineAction('focus-composer', { title: 'Focus message field', keys: ['/', 'Mod+L'], group: 'Chats', icon: 'pencil', run: () => shell.focusComposer() });
defineAction('stop-generation', { title: 'Stop generating', keys: ['Mod+.'], group: 'Chats', icon: 'stop', when: () => true, run: () => {
  const m = currentChat();
  if (m?.generating) stopGeneration(m);
  else { const any = liveChats()[0]; if (any) stopGeneration(any); else toast({ message: 'Nothing is generating', id: 'nothing' }); }
} });
defineAction('stop-generation-hint', { title: 'Wait or stop', palette: false, run: () => toast({ kind: 'warn', message: 'This chat is still replying', detail: 'Wait for it to finish, or stop it first.', action: { label: 'Stop', run: () => runAction('stop-generation') }, id: 'busy' }) });
defineAction('export-chat', { title: 'Export chat…', keys: ['Mod+Shift+E'], group: 'Chats', icon: 'share', run: () => shell.exportDialog(currentSummary()) });
defineAction('import-chat', { title: 'Import chats…', keys: ['Mod+O'], group: 'Chats', icon: 'importIcon', run: () => importChats() });
defineAction('show-shortcuts', { title: 'Keyboard shortcuts', keys: ['Mod+/'], group: 'Help', icon: 'keyboard', run: () => openShortcuts() });
defineAction('show-context', { title: 'Show context details', group: 'View', icon: 'layers', run: () => shell.showInspector('context') });
defineAction('show-summary', { title: 'Show chat summary', group: 'View', icon: 'summary', run: () => shell.showInspector('summary') });
defineAction('show-retrieval', { title: 'Show memories used', group: 'View', icon: 'memory', palette: false, run: (messageId) => shell.showInspector('memory', { retrieval: messageId }) });
defineAction('compact-chat', { title: 'Compact chat now', group: 'Chats', icon: 'summary', when: () => !!currentChat(), run: () => { const m = currentChat(); if (m) compactNow(m); else toast({ message: 'Open a chat first' }); } });
defineAction('rename-chat', { title: 'Rename chat', keys: ['F2'], group: 'Chats', icon: 'pencil', when: () => !!currentChat(), run: () => { const el = shell.tb.querySelector('[data-action="rename-chat"]'); if (el) shell.renameInline(el); } });
defineAction('pin-chat', { title: 'Pin / unpin chat', group: 'Chats', icon: 'pin', when: () => !!currentSummary(), run: () => { const c = currentSummary(); shell.updateChat(c.id, { pinned: !c.pinned }, c.pinned ? 'Unpinned' : 'Pinned'); } });
defineAction('archive-chat', { title: 'Archive chat', group: 'Chats', icon: 'archive', when: () => !!currentSummary(), run: () => { const c = currentSummary(); shell.updateChat(c.id, { archived: !c.archived }, c.archived ? 'Chat restored' : 'Chat archived'); } });
defineAction('fork-chat', { title: 'Fork chat', group: 'Chats', icon: 'fork', when: () => !!currentChat(), run: () => shell.forkChat(currentChat().id) });
defineAction('delete-chat', { title: 'Delete chat', keys: ['Mod+Shift+Backspace'], group: 'Chats', icon: 'trash', when: () => true, run: (id) => { const target = typeof id === 'string' ? id : currentChat()?.id; if (target) shell.deleteChat(target); } });
defineAction('toggle-incognito', { title: 'Toggle incognito for this chat', group: 'Chats', icon: 'incognito', run: () => { const c = currentSummary(); if (c) shell.updateChat(c.id, { incognito: !c.incognito }, c.incognito ? 'No longer incognito' : 'Chat is now incognito'); else runAction('new-incognito-chat'); } });
defineAction('prev-chat', { title: 'Previous chat', keys: ['Mod+Alt+ArrowUp'], group: 'Chats', icon: 'chevronUp', run: () => stepChat(-1) });
defineAction('next-chat', { title: 'Next chat', keys: ['Mod+Alt+ArrowDown'], group: 'Chats', icon: 'chevronDown', run: () => stepChat(1) });
defineAction('copy-last-reply', { title: 'Copy last reply', keys: ['Mod+Shift+C'], group: 'Chats', icon: 'copy', run: async () => {
  const m = currentChat();
  const last = m && [...m.pathMessages()].reverse().find((x) => x.role === 'assistant' && x.content);
  if (last) { const { copyText } = await import('./lib/dom.js'); if (await copyText(last.content)) toast({ kind: 'success', message: 'Copied the last reply', timeout: 1500 }); }
} });
defineAction('theme-system', { title: 'Theme: match system', group: 'Appearance', icon: 'monitor', run: () => setUiPref('theme', 'system') });
defineAction('theme-light', { title: 'Theme: light', group: 'Appearance', icon: 'sun', run: () => setUiPref('theme', 'light') });
defineAction('theme-dark', { title: 'Theme: dark', group: 'Appearance', icon: 'moon', run: () => setUiPref('theme', 'dark') });
defineAction('toggle-theme', { title: 'Toggle light / dark', keys: ['Mod+Shift+L'], group: 'Appearance', icon: 'moon', run: () => {
  const cur = uiPrefs().theme || 'system';
  const dark = cur === 'dark' || (cur === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  setUiPref('theme', dark ? 'light' : 'dark');
} });
defineAction('start-ollama', { title: 'Start Ollama', group: 'Models', icon: 'power', run: async () => {
  const t = toast({ message: 'Starting Ollama…', timeout: 0, id: 'ollama-start' });
  try {
    const r = await api.providers.startOllama();
    t.dismiss(true);
    toast({ kind: 'success', message: r.alreadyRunning ? 'Ollama is already running' : `Ollama started${r.version ? ` (${r.version})` : ''}`, id: 'ollama-start' });
    await Promise.allSettled([loadSystem({ refresh: true }), loadModels({ refresh: true })]);
  } catch (e) { t.dismiss(true); showError(e, 'start Ollama'); }
} });
defineAction('refresh-backends', { title: 'Re-check backends', group: 'Models', icon: 'reload', run: async () => {
  await Promise.allSettled([api.providers.refresh(), api.images.providers({ refresh: true })]);
  await Promise.allSettled([loadSystem({ refresh: true }), loadModels({ refresh: true })]);
  toast({ message: 'Backends re-checked', kind: 'success', id: 'recheck', timeout: 1800 });
} });
defineAction('studio-reuse', { title: 'Reuse image settings', palette: false, run: (img) => bus.emit('studio-reuse', img) });

function stepChat(d) {
  const list = store.get('chats') || [];
  if (!list.length) return;
  const cur = currentChat()?.id;
  const i = list.findIndex((c) => c.id === cur);
  const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + d))];
  if (next) navigate(`/chat/${next.id}`);
}

async function importChats() {
  const files = await pickFiles({ accept: '.json,application/json', multiple: true });
  let n = 0;
  let firstId = null;
  for (const f of files) {
    try {
      const payload = JSON.parse(await f.text());
      const r = await api.chats.import(payload);
      n += r.chats.length;
      firstId ||= r.chats[0]?.id;
    } catch (e) {
      if (e instanceof SyntaxError) toast({ kind: 'error', message: `${f.name} isn't valid JSON` });
      else showError(e, `import ${f.name}`);
    }
  }
  if (n) {
    await loadChats();
    toast({ kind: 'success', message: `Imported ${n} chat${n === 1 ? '' : 's'}` });
    if (firstId) navigate(`/chat/${firstId}`);
  }
}

// ------------------------------------------------------------------------------------------------ keyboard
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing) return;
  if (document.querySelector('dialog[open]') && !(e.metaKey || e.ctrlKey)) return;
  const chord = chordOf(e);
  if (chord === 'Escape') {
    const m = currentChat();
    if (m?.generating && !document.querySelector('.popover, dialog[open]')) { e.preventDefault(); stopGeneration(m); }
    return;
  }
  const a = actionForChord(chord);
  if (!a) return;
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
  if (plain && isTypingTarget(e.target)) return; // "/" etc. only outside text fields
  e.preventDefault();
  runAction(a.id);
});

// ------------------------------------------------------------------------------------------------ desktop bridge
if (desktop) {
  try {
    desktop.onMenuAction?.((name, ...args) => runAction(name, ...args));
  } catch (e) { console.warn('desktop bridge', e); }
}
let unread = 0;
bus.on('activity', (info) => {
  if (info?.finished && document.hidden) {
    unread++;
    try { desktop?.setBadge?.(String(unread)); } catch { /* ignore */ }
    shell.announce('Reply finished');
  } else if (info?.finished) shell.announce('Reply finished');
  shell.updateToolbar();
  shell.sidebar.renderList();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && unread) { unread = 0; try { desktop?.setBadge?.(''); } catch { /* ignore */ } }
});
window.addEventListener('pagehide', () => shell.flushPendingDeletes());

// ------------------------------------------------------------------------------------------------ event bus
let es = null;
let everConnected = false;
let offlineTimer = null;
let banner = null;

function setConnection(state) {
  if (store.get('connection') === state) return;
  store.set('connection', state);
  banner?.remove();
  banner = null;
  if (state === 'offline') {
    banner = h('div.conn-banner', { role: 'status' }, h('span.spinner.small'), 'Reconnecting to Harness…');
    add(document.body, banner);
  }
}

function connectEvents() {
  es?.close();
  es = new EventSource('/api/events');
  es.addEventListener('hello', () => {
    clearTimeout(offlineTimer);
    const wasOffline = store.get('connection') === 'offline' || everConnected;
    setConnection('online');
    if (wasOffline && everConnected) resync();
    everConnected = true;
  });
  es.onerror = () => {
    clearTimeout(offlineTimer);
    offlineTimer = setTimeout(() => setConnection('offline'), 1200);
    if (es.readyState === EventSource.CLOSED) setTimeout(connectEvents, 2000);
  };
  const on = (type, fn) => es.addEventListener(type, (ev) => { let d; try { d = JSON.parse(ev.data); } catch { return; } try { fn(d); } catch (err) { console.error(`[bus] ${type}`, err); } });

  on('chat.created', (d) => mergeChatSummary(d.chat));
  on('chat.updated', (d) => {
    if (d.chat.archived) {
      store.set('chats', (store.get('chats') || []).filter((c) => c.id !== d.chat.id));
      if (store.get('archived')) loadArchived().catch(() => {});
      peekChatModel(d.chat.id)?.setChatMeta(d.chat);
    } else {
      if (store.get('archived')?.some((c) => c.id === d.chat.id)) loadArchived().catch(() => {});
      mergeChatSummary(d.chat);
    }
    shell.updateToolbar();
  });
  on('chat.deleted', (d) => {
    store.set('chats', (store.get('chats') || []).filter((c) => c.id !== d.chatId));
    if (store.get('archived')) store.set('archived', store.get('archived').filter((c) => c.id !== d.chatId));
    forgetChatModel(d.chatId);
    const r = store.get('route');
    if (r.view === 'chat' && r.chatId === d.chatId && !shell.pendingDeletes.has(d.chatId)) { navigate('/chat'); toast({ message: 'This chat was deleted' }); }
  });
  on('chat.compacted', (d) => {
    const m = peekChatModel(d.chatId);
    if (m && !m.live) { m.load({ force: true }).catch(() => {}); m.loadSummary().catch(() => {}); }
  });
  on('generation.started', (d) => { store.set('chats', (store.get('chats') || []).map((c) => (c.id === d.chatId ? { ...c, generating: true } : c))); });
  on('generation.finished', (d) => {
    store.set('chats', (store.get('chats') || []).map((c) => (c.id === d.chatId ? { ...c, generating: false } : c)));
    const m = peekChatModel(d.chatId);
    if (m && !m.live) m.load({ force: true }).then(() => m.refreshContext()).catch(() => {});
    refreshSystemSoon();
  });
  const memChanged = () => { bus.emit('memories'); refreshMemoryCount(); };
  on('memory.added', memChanged);
  on('memory.updated', memChanged);
  on('memory.deleted', memChanged);
  on('memory.cleared', memChanged);
  on('memory.extracted', (d) => {
    memChanged();
    const items = [...(d.added || []), ...(d.updated || [])];
    if (items.length) toast({ kind: 'success', message: items.length === 1 ? 'Remembered' : `Remembered ${items.length} things`, detail: items.slice(0, 3).map((x) => `• ${truncate(x.content, 100)}`).join('\n'), action: { label: 'Review', run: () => runAction('open-memory') }, id: `extract-${d.chatId}` });
  });
  on('settings.updated', (d) => {
    const cur = store.get('settings');
    // Keep local UI prefs that may not have been flushed yet.
    store.set('settings', { ...d.settings, ui: { ...(d.settings.ui || {}), ...(cur?.ui || {}) } });
    dropModelInfo();
  });
  on('presets.updated', () => loadPresets().catch(() => {}));
  on('providers.status', () => { refreshSystemSoon(); refreshModelsSoon(); });
  on('ollama.status', () => { refreshSystemSoon(); refreshModelsSoon(); });
  on('model.pull', (d) => {
    const pulls = { ...(store.get('pulls') || {}) };
    const prev = pulls[d.pullId] || {};
    const done = ['success', 'error', 'aborted'].includes(d.status);
    pulls[d.pullId] = { ...prev, ...d, done, at: Date.now() };
    store.set('pulls', pulls);
    if (d.status === 'success') { refreshModelsSoon(); dropModelInfo(); }
  });
  on('model.deleted', () => { refreshModelsSoon(); dropModelInfo(); });
  on('model.status', () => refreshSystemSoon());
  on('attachment.indexed', (d) => bus.emit('attachment.indexed', d));
  const jobEvent = (d) => {
    const jobs = { ...(store.get('imageJobs') || {}) };
    const id = d.jobId || d.job?.id;
    if (!id) return;
    const prev = jobs[id] || { id, status: 'queued', images: [] };
    const next = { ...prev, ...(d.job || {}) };
    if (d.type === 'image.status') next.status = d.phase === 'done' ? 'done' : d.phase;
    if (d.type === 'image.progress') Object.assign(next, { progress: d.progress, step: d.step, steps: d.steps });
    if (d.type === 'image.done') next.status = 'done';
    if (d.type === 'image.error') { next.status = d.code === 'aborted' ? 'aborted' : 'error'; next.error = d.message; }
    jobs[id] = next;
    store.set('imageJobs', jobs);
    bus.emit('image-job', next, d);
    if (d.type === 'image.done' || d.type === 'image.error') refreshSystemSoon();
  };
  for (const t of ['image.job', 'image.status', 'image.progress', 'image.done', 'image.error']) es.addEventListener(t, (ev) => { try { const d = JSON.parse(ev.data); d.type = t; jobEvent(d); } catch { /* ignore */ } });
  on('image.added', (d) => bus.emit('gallery', { added: d.image }));
  on('image.deleted', (d) => bus.emit('gallery', { deleted: d.imageId }));
  on('image.providers.status', () => refreshSystemSoon());
}

async function refreshMemoryCount() {
  try { const r = await api.memories.list({ limit: 1 }); store.set('memoryCount', r.total); } catch { /* ignore */ }
}

async function resync() {
  await Promise.allSettled([loadSettings(), loadPresets(), loadSystem(), loadModels(), loadChats(), refreshMemoryCount()]);
  const m = currentChat();
  if (m && !m.live) m.load({ force: true }).catch(() => {});
}

// Keep the machine status fresh (loaded models expire, Ollama can stop) without hammering the server.
setInterval(() => { if (!document.hidden && store.get('connection') === 'online') loadSystem().catch(() => {}); }, 20000);

// ------------------------------------------------------------------------------------------------ boot
async function boot() {
  connectEvents();
  const results = await Promise.allSettled([loadSettings(), loadPresets(), loadSystem(), loadModels(), loadChats(), refreshMemoryCount()]);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length === results.length) {
    setConnection('offline');
    mount(root, h('div.boot-error', icon('warning', { size: 24 }), h('h1.h2', "Can't reach Harness"), h('p.muted', failed[0].reason?.message || ''), h('button.btn', { type: 'button', on: { click: () => location.reload() } }, 'Try again')));
    return;
  }
  for (const f of failed) console.warn('[harness] initial load failed', f.reason);
  shell.applyAppearance();
  shell.applyLayout();
  startRouter();
  // First run: nothing to chat with yet → the setup page (unless a specific page was requested).
  const r = store.get('route');
  const ollamaDown = store.get('system')?.providers?.every((p) => p.status !== 'running');
  if (r.view === 'chat' && !r.chatId && (!chatModels().length || ollamaDown)) navigate('/setup', { replace: true });
  document.documentElement.classList.add('ready');
  if (!desktop) document.documentElement.classList.add('browser');
}

boot();

export { allActions, download };
