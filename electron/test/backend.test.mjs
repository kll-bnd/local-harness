// Desktop shell: start the backend or attach to the instance that owns the data dir (probe + lock race).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../../server/index.mjs';

process.env.HARNESS_NO_OLLAMA_AUTOSTART = '1';
const require = createRequire(import.meta.url);
const { startOrAttach } = require('../lib/backend.cjs');
const { findRunningHarness } = require('../lib/instance.cjs');
const noSleep = async () => {};

test('starts its own server when nothing is running', async () => {
  const r = await startOrAttach({ dataDir: '/d', port: 1, ports: [], findRunning: async () => null, startServer: async (o) => ({ url: 'http://127.0.0.1:9', opts: o }) });
  assert.equal(r.attached, false);
  assert.equal(r.url, 'http://127.0.0.1:9');
  assert.deepEqual(r.server.opts, { port: 1, dataDir: '/d', openBrowser: false });
});

test('attaches when the probe finds the instance', async () => {
  let started = false;
  const r = await startOrAttach({ dataDir: '/d', port: 1, ports: [], findRunning: async () => ({ url: 'http://127.0.0.1:5', pid: 42 }), startServer: async () => { started = true; } });
  assert.deepEqual([r.attached, r.url, r.pid, r.via, started], [true, 'http://127.0.0.1:5', 42, 'probe', false]);
});

test('HARNESS_ALREADY_RUNNING with a URL → attach to err.url', async () => {
  const err = Object.assign(new Error('busy'), { code: 'HARNESS_ALREADY_RUNNING', url: 'http://127.0.0.1:7', pid: 7 });
  const r = await startOrAttach({ dataDir: '/d', port: 1, ports: [], findRunning: async () => null, startServer: async () => { throw err; }, sleep: noSleep });
  assert.deepEqual([r.attached, r.url, r.pid, r.via], [true, 'http://127.0.0.1:7', 7, 'lock']);
});

test('HARNESS_ALREADY_RUNNING while the other instance is still starting → wait for it, else rethrow', async () => {
  const err = Object.assign(new Error('starting'), { code: 'HARNESS_ALREADY_RUNNING', url: null, pid: 8 });
  let calls = 0;
  const later = await startOrAttach({ dataDir: '/d', port: 1, ports: [], probeFirst: false, sleep: noSleep,
    findRunning: async () => (++calls >= 3 ? { url: 'http://127.0.0.1:8', pid: 8 } : null), startServer: async () => { throw err; } });
  assert.deepEqual([later.url, later.via, calls], ['http://127.0.0.1:8', 'lock', 3]);
  await assert.rejects(startOrAttach({ dataDir: '/d', port: 1, ports: [], probeFirst: false, sleep: noSleep, waitMs: 2000, findRunning: async () => null, startServer: async () => { throw err; } }), /starting/);
  const other = Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
  await assert.rejects(startOrAttach({ dataDir: '/d', port: 1, ports: [], findRunning: async () => null, startServer: async () => { throw other; } }), /EISDIR/);
});

test('real backend: a second start on the same data dir attaches via the lock', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-race-'));
  const first = await startServer({ port: 0, dataDir: dir, autodetect: false, logLevel: 'silent' });
  try {
    const r = await startOrAttach({ dataDir: dir, port: 0, ports: [], probeFirst: false, findRunning: findRunningHarness,
      startServer: (o) => startServer({ ...o, autodetect: false, logLevel: 'silent' }) });
    assert.equal(r.attached, true);
    assert.equal(r.via, 'lock');
    assert.equal(r.url, first.url);
  } finally {
    await first.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
