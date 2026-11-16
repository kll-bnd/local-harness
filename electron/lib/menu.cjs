'use strict';
// Menu templates as plain data (no Electron import) so they can be unit-tested; main.cjs feeds them
// to Menu.buildFromTemplate().
const { MENU_ACTIONS } = require('./config.cjs');

/**
 * The page-level commands, their menu labels and accelerators. `mac`/`other` override the default
 * accelerator per platform. Every MENU_ACTIONS entry appears exactly once in the menu.
 */
const COMMANDS = Object.freeze({
  'new-chat': { label: 'New Chat', accelerator: 'CommandOrControl+N' },
  'open-settings': { label: 'Settings…', accelerator: 'CommandOrControl+,' },
  'toggle-sidebar': { label: 'Toggle Sidebar', mac: 'Control+Command+S', other: 'Control+Shift+S' },
  'toggle-inspector': { label: 'Toggle Inspector', accelerator: 'Alt+CommandOrControl+I' },
  'search-chats': { label: 'Search Chats…', accelerator: 'CommandOrControl+F' },
  'command-palette': { label: 'Command Palette…', accelerator: 'CommandOrControl+K' },
  'open-models': { label: 'Models', accelerator: 'CommandOrControl+1' },
  'open-images': { label: 'Images', accelerator: 'CommandOrControl+2' },
  'open-memory': { label: 'Memory', accelerator: 'CommandOrControl+3' },
  'focus-composer': { label: 'Focus Message Box', accelerator: 'CommandOrControl+L' },
  'stop-generation': { label: 'Stop Generating', accelerator: 'CommandOrControl+.' },
  'export-chat': { label: 'Export Chat…', accelerator: 'CommandOrControl+Shift+E' },
  'import-chat': { label: 'Import Chat…', accelerator: 'CommandOrControl+O' },
  'show-shortcuts': { label: 'Keyboard Shortcuts', accelerator: 'CommandOrControl+/' },
});

function acceleratorFor(action, isMac) {
  const c = COMMANDS[action];
  return (isMac ? c.mac : c.other) || c.accelerator;
}

/**
 * @param {object} o
 * @param {boolean} o.isMac
 * @param {string} o.appName
 * @param {(action: string) => void} o.send            deliver a MENU_ACTIONS entry to the page
 * @param {() => void} o.showDataFolder
 * @param {() => void} o.showLogFile
 * @returns {object[]} Electron MenuItemConstructorOptions[]
 */
function buildAppMenuTemplate({ isMac, appName = 'Harness', send, showDataFolder, showLogFile }) {
  const cmd = (action, extra = {}) => ({
    id: `action:${action}`,
    label: COMMANDS[action].label,
    accelerator: acceleratorFor(action, isMac),
    click: () => send(action),
    ...extra,
  });
  const sep = { type: 'separator' };
  const fileFolderLabel = isMac ? 'Show Data Folder in Finder' : 'Show Data Folder';

  const template = [];
  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about' },
        sep,
        cmd('open-settings'),
        sep,
        { role: 'services' },
        sep,
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        sep,
        { role: 'quit' },
      ],
    });
  }
  template.push({
    label: 'File',
    submenu: [
      cmd('new-chat'),
      sep,
      cmd('import-chat'),
      cmd('export-chat'),
      sep,
      { id: 'show-data-folder', label: fileFolderLabel, click: () => showDataFolder() },
      ...(isMac ? [sep, { role: 'close' }] : [sep, cmd('open-settings'), sep, { role: 'quit' }]),
    ],
  });
  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      sep,
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac ? [{ role: 'pasteAndMatchStyle' }] : []),
      { role: 'delete' },
      { role: 'selectAll' },
      sep,
      cmd('search-chats'),
      ...(isMac ? [sep, { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }] : []),
    ],
  });
  template.push({
    label: 'View',
    submenu: [
      cmd('command-palette'),
      sep,
      cmd('toggle-sidebar'),
      cmd('toggle-inspector'),
      sep,
      cmd('open-models'),
      cmd('open-images'),
      cmd('open-memory'),
      sep,
      { role: 'reload' },
      { role: 'forceReload' },
      // ⌥⌘I is the Inspector (macOS convention), so the developer tools move to ⌥⌘J.
      { role: 'toggleDevTools', accelerator: 'Alt+CommandOrControl+J' },
      sep,
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      // The zoomIn role's default accelerator (⌘+) needs Shift on US keyboards; accept ⌘= too.
      { role: 'zoomIn', accelerator: 'CommandOrControl+=', visible: false, acceleratorWorksWhenHidden: true },
      { role: 'zoomOut' },
      sep,
      { role: 'togglefullscreen' },
    ],
  });
  template.push({
    label: 'Chat',
    submenu: [cmd('focus-composer'), cmd('stop-generation')],
  });
  template.push({
    role: 'windowMenu',
  });
  template.push({
    role: 'help',
    submenu: [
      cmd('show-shortcuts'),
      sep,
      { id: 'show-log-file', label: 'Show Log File', click: () => showLogFile() },
      { id: 'show-data-folder-help', label: fileFolderLabel, click: () => showDataFolder() },
      ...(isMac ? [] : [sep, { role: 'about' }]),
    ],
  });
  return template;
}

/** Dock menu (macOS): right-click the Dock icon. */
function buildDockMenuTemplate({ send }) {
  return [{ label: 'New Chat', click: () => send('new-chat') }];
}

/**
 * Right-click menu for the page (Electron shows none by default). If the page handles `contextmenu`
 * itself and calls preventDefault(), Electron does not emit `context-menu` and this is not shown.
 * @param {object} params  Electron ContextMenuParams
 * @param {object} h       handlers: replaceMisspelling(word), copyText(text), openExternal(url), copyImageAt(x, y), lookUp()
 * @returns {object[]} template (empty → show nothing)
 */
function buildContextMenuTemplate(params, h, { isMac = false } = {}) {
  const items = [];
  const sep = { type: 'separator' };
  const push = (...xs) => { if (items.length && items[items.length - 1].type !== 'separator' && xs.length) items.push(sep); items.push(...xs); };
  const f = params.editFlags || {};
  if (params.isEditable && params.misspelledWord) {
    const sugg = (params.dictionarySuggestions || []).slice(0, 5);
    push(...(sugg.length
      ? sugg.map((w) => ({ label: w, click: () => h.replaceMisspelling(w) }))
      : [{ label: 'No Guesses Found', enabled: false }]));
  }
  if (params.linkURL && /^https?:/i.test(params.linkURL)) {
    push(
      { label: 'Open Link in Browser', click: () => h.openExternal(params.linkURL) },
      { label: 'Copy Link', click: () => h.copyText(params.linkURL) },
    );
  }
  if (params.mediaType === 'image' && params.hasImageContents !== false) {
    push({ label: 'Copy Image', click: () => h.copyImageAt(params.x, params.y) });
  }
  const sel = (params.selectionText || '').trim();
  if (isMac && sel && sel.length < 200) {
    push({ label: `Look Up “${sel.length > 24 ? sel.slice(0, 24) + '…' : sel}”`, click: () => h.lookUp() });
  }
  if (params.isEditable) {
    push(
      { role: 'cut', enabled: f.canCut !== false },
      { role: 'copy', enabled: f.canCopy !== false },
      { role: 'paste', enabled: f.canPaste !== false },
      { role: 'selectAll', enabled: f.canSelectAll !== false },
    );
  } else if (sel) {
    push({ role: 'copy' });
  }
  return items;
}

/** Every page action referenced by a template (used by tests to check coverage). */
function collectActions(template) {
  const out = [];
  const walk = (items) => {
    for (const it of items) {
      if (it.id && it.id.startsWith('action:')) out.push(it.id.slice(7));
      if (Array.isArray(it.submenu)) walk(it.submenu);
    }
  };
  walk(template);
  return out;
}

module.exports = { COMMANDS, MENU_ACTIONS, acceleratorFor, buildAppMenuTemplate, buildDockMenuTemplate, buildContextMenuTemplate, collectActions };
