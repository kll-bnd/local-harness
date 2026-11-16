// Desktop shell: data-dir resolution (must match the backend) and desktop.json handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { defaultDataDir } from '../../server/app.mjs';

const require = createRequire(import.meta.url);
const { resolveDataDir, desktopPaths } = require('../lib/paths.cjs');
const { normalizeDesktopConfig, loadDesktopConfig, DEFAULT_DESKTOP_CONFIG, MENU_ACTIONS } = require('../lib/config.cjs');

function withPlatform(platform, env, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  Object.defineProperty(process, 'platform', { ...desc, value: platform });
  try { return fn(); } finally {
    Object.defineProperty(process, 'platform', desc);
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('resolveDataDir matches the backend defaultDataDir on every platform', () => {
  const cases = [
    ['darwin', { HARNESS_DATA_DIR: undefined }],
    ['linux', { HARNESS_DATA_DIR: undefined, XDG_DATA_HOME: undefined }],
    ['linux', { HARNESS_DATA_DIR: undefined, XDG_DATA_HOME: '/tmp/xdg-data' }],
    ['win32', { HARNESS_DATA_DIR: undefined, APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }],
    ['darwin', { HARNESS_DATA_DIR: '/tmp/some/where' }],
  ];
  for (const [platform, env] of cases) {
    withPlatform(platform, env, () => {
      assert.equal(resolveDataDir({ platform, env: process.env, homedir: os.homedir() }), defaultDataDir(), `${platform} ${JSON.stringify(env)}`);
    });
  }
});

test('macOS data dir is ~/Library/Application Support/Harness', () => {
  assert.equal(resolveDataDir({ platform: 'darwin', env: {}, homedir: '/Users/ada' }), '/Users/ada/Library/Application Support/Harness');
  const p = desktopPaths('/Users/ada/Library/Application Support/Harness');
  assert.equal(p.sessionData, '/Users/ada/Library/Application Support/Harness/Electron');
  assert.equal(p.desktopConfig, '/Users/ada/Library/Application Support/Harness/desktop.json');
  assert.equal(p.logFile, '/Users/ada/Library/Application Support/Harness/logs/harness.log');
});

test('normalizeDesktopConfig validates values and falls back to defaults', () => {
  assert.deepEqual(normalizeDesktopConfig(undefined).config, DEFAULT_DESKTOP_CONFIG);
  assert.equal(normalizeDesktopConfig({ globalShortcut: null }).config.globalShortcut, null);
  assert.equal(normalizeDesktopConfig({ globalShortcut: '' }).config.globalShortcut, null);
  assert.equal(normalizeDesktopConfig({ globalShortcut: 'Alt+Command+H' }).config.globalShortcut, 'Alt+Command+H');
  const bad = normalizeDesktopConfig({ globalShortcut: 'rm -rf; x', port: 80, hideOnClose: 'yes' });
  assert.equal(bad.config.globalShortcut, DEFAULT_DESKTOP_CONFIG.globalShortcut);
  assert.equal(bad.config.port, 4747);
  assert.equal(bad.config.hideOnClose, true);
  assert.equal(bad.warnings.length, 3);
  assert.equal(normalizeDesktopConfig([1]).warnings.length, 1);
});

test('loadDesktopConfig writes defaults on first run and honours env overrides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-desktop-'));
  const file = path.join(dir, 'desktop.json');
  const a = loadDesktopConfig(file, { env: {} });
  assert.deepEqual(a.config, DEFAULT_DESKTOP_CONFIG);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), DEFAULT_DESKTOP_CONFIG);
  fs.writeFileSync(file, JSON.stringify({ port: 5000, globalShortcut: null }));
  const b = loadDesktopConfig(file, { env: { HARNESS_PORT: '4810' } });
  assert.equal(b.config.port, 4810);
  assert.equal(b.config.globalShortcut, null);
  fs.writeFileSync(file, '{ not json');
  const c = loadDesktopConfig(file, { env: { HARNESS_GLOBAL_SHORTCUT: '' } });
  assert.equal(c.config.globalShortcut, null);
  assert.match(c.warnings[0], /Could not read/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('menu action list is the agreed contract (14 in 0.1 + lock in 0.2)', () => {
  assert.deepEqual([...MENU_ACTIONS].sort(), [
    'command-palette', 'export-chat', 'focus-composer', 'import-chat', 'lock', 'new-chat', 'open-images', 'open-memory', 'open-models',
    'open-settings', 'search-chats', 'show-shortcuts', 'stop-generation', 'toggle-inspector', 'toggle-sidebar',
  ]);
});
