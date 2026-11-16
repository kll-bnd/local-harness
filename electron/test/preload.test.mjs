// Desktop shell: the preload contract, exercised in a VM with fake Electron/DOM objects.
// (The real thing is exercised in a window by electron/test/e2e.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MENU_ACTIONS } = require('../lib/config.cjs');
const source = fs.readFileSync(fileURLToPath(new URL('../preload.cjs', import.meta.url)), 'utf8');

function load({ platform = 'darwin', withRoot = true, init = { appVersion: '0.1.0', actions: MENU_ACTIONS, fullscreen: false } } = {}) {
  const classes = new Set();
  const documentElement = { classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  const document = { documentElement: withRoot ? documentElement : null, addEventListener: () => {} };
  const observers = [];
  class MutationObserver { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() { this.off = true; } }
  const on = {};
  const invoked = [];
  const exposed = {};
  const electron = {
    contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } },
    ipcRenderer: { on: (ch, fn) => { on[ch] = fn; }, invoke: async (ch, ...a) => { invoked.push([ch, ...a]); return true; } },
  };
  const ctx = {
    require: (m) => { if (m !== 'electron') throw new Error(`sandboxed preload cannot require ${m}`); return electron; },
    process: { platform, argv: ['/x/Harness', `--harness-desktop=${encodeURIComponent(JSON.stringify(init))}`] },
    document, MutationObserver, setTimeout, console, Date,
  };
  vm.runInNewContext(source, ctx, { filename: 'preload.cjs' });
  return { api: exposed.harnessDesktop, classes, on, invoked, document, documentElement, observers };
}

test('exposes the agreed API and <html> classes on macOS', async () => {
  const { api, classes, invoked, on } = load();
  assert.deepEqual(Object.keys(api).sort(), ['appVersion', 'onMenuAction', 'openExternal', 'platform', 'setBadge', 'showInFolder']);
  assert.equal(api.platform, 'darwin');
  assert.equal(api.appVersion, '0.1.0');
  assert.ok(Object.isFrozen(api));
  assert.deepEqual([...classes].sort(), ['desktop', 'desktop-mac']);
  on['harness:fullscreen']({}, true);
  assert.ok(classes.has('desktop-fullscreen'));
  on['harness:fullscreen']({}, false);
  assert.ok(!classes.has('desktop-fullscreen'));
  await api.openExternal('https://example.com');
  await api.showInFolder({ evil: true });
  await api.setBadge(3);
  await api.setBadge({ toString() { return 'x'; } });
  assert.deepEqual(invoked, [['harness:open-external', 'https://example.com'], ['harness:show-in-folder', ''], ['harness:set-badge', 3], ['harness:set-badge', '']]);
});

test('no desktop-mac class elsewhere; classes applied once <html> exists', () => {
  const { classes, document, documentElement, observers } = load({ platform: 'linux', withRoot: false });
  assert.equal(classes.size, 0);
  document.documentElement = documentElement;
  observers[0].fn();
  assert.deepEqual([...classes], ['desktop']);
});

test('menu actions: only known actions, unsubscribe works, early actions are buffered', async () => {
  const { api, on } = load();
  on['harness:menu-action']({}, 'new-chat'); // before anyone subscribed
  on['harness:menu-action']({}, 'rm -rf');
  const got = [];
  const off = api.onMenuAction((a) => got.push(a));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(got, ['new-chat']);
  on['harness:menu-action']({}, 'open-settings');
  on['harness:menu-action']({}, 'not-an-action');
  assert.deepEqual(got, ['new-chat', 'open-settings']);
  off();
  on['harness:menu-action']({}, 'toggle-sidebar');
  assert.deepEqual(got, ['new-chat', 'open-settings']);
  assert.throws(() => api.onMenuAction('nope'), { name: 'TypeError' });
});
