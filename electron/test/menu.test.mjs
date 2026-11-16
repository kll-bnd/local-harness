// Desktop shell: native menu template, context menu, Dock menu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const m = require('../lib/menu.cjs');
const { MENU_ACTIONS } = require('../lib/config.cjs');

function build(isMac) {
  const sent = [];
  const calls = [];
  const t = m.buildAppMenuTemplate({ isMac, appName: 'Harness', send: (a) => sent.push(a), showDataFolder: () => calls.push('data'), showLogFile: () => calls.push('log') });
  return { t, sent, calls };
}
const flat = (items) => items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flat(i.submenu) : [])]);

for (const isMac of [true, false]) {
  test(`every menu action appears exactly once and reaches send() (${isMac ? 'mac' : 'other'})`, () => {
    const { t, sent } = build(isMac);
    const actions = m.collectActions(t);
    assert.deepEqual([...actions].sort(), [...MENU_ACTIONS].sort());
    for (const item of flat(t).filter((i) => i.id?.startsWith('action:'))) item.click();
    assert.deepEqual(sent.sort(), [...MENU_ACTIONS].sort());
  });

  test(`no duplicate accelerators (${isMac ? 'mac' : 'other'})`, () => {
    const { t } = build(isMac);
    const accels = flat(t).filter((i) => i.accelerator && !(i.role === 'zoomIn' && i.visible === false)).map((i) => i.accelerator.replace('CommandOrControl', isMac ? 'Command' : 'Control'));
    const dupes = accels.filter((a, i) => accels.indexOf(a) !== i);
    assert.deepEqual(dupes, []);
    // Must not shadow the standard Edit / Window accelerators that roles provide.
    const reserved = isMac ? ['Command+C', 'Command+V', 'Command+X', 'Command+Z', 'Command+A', 'Command+Q', 'Command+W', 'Command+M', 'Command+H'] : ['Control+C', 'Control+V', 'Control+X', 'Control+Z', 'Control+A'];
    for (const r of reserved) assert.ok(!accels.includes(r), r);
  });
}

test('macOS menu has the standard App/File/Edit/View/Window/Help structure with roles', () => {
  const { t, calls } = build(true);
  assert.deepEqual(t.map((x) => x.label || x.role), ['Harness', 'File', 'Edit', 'View', 'Chat', 'windowMenu', 'help']);
  const roles = new Set(flat(t).map((i) => i.role).filter(Boolean));
  for (const r of ['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit', 'close', 'undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll', 'reload', 'toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen', 'windowMenu', 'help', 'startSpeaking']) {
    assert.ok(roles.has(r), r);
  }
  const settings = flat(t[0].submenu).find((i) => i.id === 'action:open-settings');
  assert.equal(settings.accelerator, 'CommandOrControl+,');
  assert.equal(flat(t).find((i) => i.id === 'action:toggle-sidebar').accelerator, 'Control+Command+S');
  assert.equal(flat(t).find((i) => i.id === 'action:stop-generation').accelerator, 'CommandOrControl+.');
  assert.equal(flat(t).find((i) => i.role === 'toggleDevTools').accelerator, 'Alt+CommandOrControl+J');
  flat(t).find((i) => i.id === 'show-data-folder').click();
  flat(t).find((i) => i.id === 'show-log-file').click();
  assert.deepEqual(calls, ['data', 'log']);
});

test('non-mac menu has no app menu; Settings and Quit live in File', () => {
  const { t } = build(false);
  assert.equal(t[0].label, 'File');
  const file = t[0].submenu;
  assert.ok(file.some((i) => i.id === 'action:open-settings'));
  assert.ok(file.some((i) => i.role === 'quit'));
});

test('dock menu offers New Chat and Lock Harness', () => {
  const sent = [];
  const t = m.buildDockMenuTemplate({ send: (a) => sent.push(a) });
  t.forEach((i) => i.click());
  assert.deepEqual(sent, ['new-chat', 'lock']);
});

test('Lock Harness is ⌃⌘L in the app menu on macOS, Ctrl+Shift+L in File elsewhere', () => {
  const mac = build(true).t;
  const lock = mac[0].submenu.find((i) => i.id === 'action:lock');
  assert.equal(lock.accelerator, 'Control+Command+L');
  assert.equal(lock.label, 'Lock Harness');
  const other = build(false).t;
  assert.equal(other[0].submenu.find((i) => i.id === 'action:lock').accelerator, 'Control+Shift+L');
});

test('context menu: spelling, links, images, editable fields, selection', () => {
  const log = [];
  const h = { replaceMisspelling: (w) => log.push(['fix', w]), copyText: (t) => log.push(['copy', t]), openExternal: (u) => log.push(['open', u]), copyImageAt: (x, y) => log.push(['img', x, y]), lookUp: () => log.push(['lookup']) };
  assert.deepEqual(m.buildContextMenuTemplate({ editFlags: {} }, h), []);
  const spell = m.buildContextMenuTemplate({ isEditable: true, misspelledWord: 'helo', dictionarySuggestions: ['hello', 'help'], editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } }, h);
  assert.deepEqual(spell.map((i) => i.label || i.role || i.type), ['hello', 'help', 'separator', 'cut', 'copy', 'paste', 'selectAll']);
  spell[0].click();
  assert.equal(spell.find((i) => i.role === 'cut').enabled, false);
  const link = m.buildContextMenuTemplate({ linkURL: 'https://example.com/x', selectionText: '', editFlags: {} }, h);
  link[0].click(); link[1].click();
  const js = m.buildContextMenuTemplate({ linkURL: 'javascript:alert(1)', editFlags: {} }, h);
  assert.deepEqual(js, []);
  const img = m.buildContextMenuTemplate({ mediaType: 'image', hasImageContents: true, x: 3, y: 4, editFlags: {} }, h);
  img[0].click();
  const sel = m.buildContextMenuTemplate({ selectionText: 'nemotron', editFlags: { canCopy: true } }, h, { isMac: true });
  assert.deepEqual(sel.map((i) => i.label || i.role || i.type), ['Look Up “nemotron”', 'separator', 'copy']);
  sel[0].click();
  assert.deepEqual(log, [['fix', 'hello'], ['open', 'https://example.com/x'], ['copy', 'https://example.com/x'], ['img', 3, 4], ['lookup']]);
});
