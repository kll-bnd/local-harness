// Desktop shell: start the backend, or refuse when another process holds the data folder (probe + lock race).
// Another holder is never loaded and never sent a credential; the app explains and quits.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../../server/index.mjs';

process.env.HARNESS_NO_OLLAMA_AUTOSTART = '1';
const require = createRequire(import.meta.url);
const { startOrRefuse, alreadyOpenMessage } = require('../lib/backend.cjs');
const { findRunningHarness, findAppHarness, lockElsewhere } = require('../lib/instance.cjs');
const none = async () => null;
const noApp = () => null;

test('starts its own server when nothing holds the folder', async () => {
  const r = await startOrRefuse({ dataDir: '/d', port: 1, findApp: noApp, findRunning: none, startServer: async (o) => ({ url: 'http://127.0.0.1:9', opts: o }) });
  assert.equal(r.other, null);
  assert.equal(r.server.url, 'http://127.0.0.1:9');
  assert.deepEqual(r.server.opts, { port: 1, dataDir: '/d', openBrowser: false });
});

test('the probe finds a listener-mode Harness → refuse, nothing started', async () => {
  let started = false;
  const r = await startOrRefuse({ dataDir: '/d', port: 1, findApp: noApp, findRunning: async () => ({ url: 'http://127.0.0.1:5', pid: 42 }), startServer: async () => { started = true; } });
  assert.deepEqual(r, { server: null, other: { kind: 'listener', pid: 42, url: 'http://127.0.0.1:5' } });
  assert.equal(started, false);
});

test('the native app holds the folder → refuse (checked before any network probe)', async () => {
  let probed = false;
  let started = false;
  const r = await startOrRefuse({ dataDir: '/d', port: 1, findApp: () => ({ pid: 77, transport: 'bridge' }),
    findRunning: async () => { probed = true; return null; }, startServer: async () => { started = true; } });
  assert.deepEqual(r, { server: null, other: { kind: 'app', pid: 77, url: null } });
  assert.deepEqual([probed, started], [false, false]);
});

test('HARNESS_ALREADY_RUNNING from the backend (the race) → refuse, listener or app; other errors rethrown', async () => {
  const lockErr = (extra) => Object.assign(new Error('busy'), { code: 'HARNESS_ALREADY_RUNNING', ...extra });
  const run = (err, probeFirst = false) => startOrRefuse({ dataDir: '/d', port: 1, probeFirst, findApp: noApp, findRunning: none, startServer: async () => { throw err; } });
  assert.deepEqual((await run(lockErr({ url: 'http://127.0.0.1:7', pid: 7, transport: null }))).other, { kind: 'listener', pid: 7, url: 'http://127.0.0.1:7' });
  assert.deepEqual((await run(lockErr({ url: null, pid: 8, transport: null }), true)).other, { kind: 'listener', pid: 8, url: null }); // still starting
  assert.deepEqual((await run(lockErr({ url: null, pid: 9, transport: 'bridge' }))).other, { kind: 'app', pid: 9, url: null });
  await assert.rejects(run(Object.assign(new Error('EISDIR'), { code: 'EISDIR' })), /EISDIR/);
});

test('a lock written on another computer → refuse before any probe; the error path too', async () => {
  let probed = false;
  let started = false;
  const far = () => ({ hostname: 'other-mac', pid: 5 });
  const r = await startOrRefuse({ dataDir: '/d', port: 1, findElsewhere: far, findApp: () => { probed = true; }, findRunning: async () => { probed = true; }, startServer: async () => { started = true; } });
  assert.deepEqual(r.other, { kind: 'elsewhere', pid: 5, url: null, hostname: 'other-mac' });
  assert.deepEqual([probed, started], [false, false]);
  const err = Object.assign(new Error('busy'), { code: 'HARNESS_ALREADY_RUNNING', url: 'http://203.0.113.7:4747', pid: 9 });
  const r2 = await startOrRefuse({ dataDir: '/d', port: 1, probeFirst: false, findElsewhere: () => ({ hostname: 'other-mac', pid: null }), findApp: noApp, findRunning: none, startServer: async () => { throw err; } });
  assert.deepEqual(r2.other, { kind: 'elsewhere', pid: null, url: null, hostname: 'other-mac' }, 'the error\'s url is not used');
});

test('no address from the lock or the error is shown unless it is exactly http://127.0.0.1:<valid port>', async () => {
  const lockErr = (url) => Object.assign(new Error('busy'), { code: 'HARNESS_ALREADY_RUNNING', url, pid: 7 });
  const run = (url) => startOrRefuse({ dataDir: '/d', port: 1, probeFirst: false, findApp: noApp, findRunning: none, startServer: async () => { throw lockErr(url); } });
  assert.equal((await run('http://127.0.0.1:4747')).other.url, 'http://127.0.0.1:4747');
  for (const bad of ['http://203.0.113.7:4747', 'http://evil.invalid:4747', 'http://127.0.0.1:70000', 'http://127.0.0.1:4747/x', 'http://127.0.0.2:4747', 'javascript:alert(1)']) {
    assert.equal((await run(bad)).other.url, null, bad);
  }
});

test('dialog text for each holder', () => {
  assert.deepEqual(alreadyOpenMessage({ kind: 'listener', pid: 4242, url: 'http://127.0.0.1:8765' }), {
    title: 'Harness is already open',
    message: 'Another Harness is using your data folder (process 4242, at http://127.0.0.1:8765). Use that one — or quit it and open this app again.',
  });
  assert.equal(alreadyOpenMessage({ kind: 'listener', pid: 4242, url: null }).message,
    'Another Harness is using your data folder (process 4242). Use that one — or quit it and open this app again.');
  assert.equal(alreadyOpenMessage({ kind: 'listener', pid: null, url: null }).message,
    'Another Harness is using your data folder (another process). Use that one — or quit it and open this app again.');
  assert.deepEqual(alreadyOpenMessage({ kind: 'elsewhere', pid: null, url: null, hostname: 'other-mac' }), {
    title: 'Harness is already open',
    message: 'Harness on another computer (other-mac) is using this data folder. Quit Harness there, then open this app again. (If Harness is not running there, the file harness.lock in the data folder is left over from it: delete that file.)',
  });
  assert.deepEqual(alreadyOpenMessage({ kind: 'app', pid: 77, url: null }), {
    title: 'Harness is already open',
    message: 'Harness is open in the Harness app (process 77), which is using your data folder. Use that one — or quit it (⌘Q) and open this app again.',
  });
});

test('a stand-in named by the lock gets only GET /api/health — no token, no launch code, no cookie', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-standin-'));
  const got = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, raw, auth: req.headers.authorization, cookie: req.headers.cookie });
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/api/health' ? JSON.stringify({ ok: true, name: 'harness', version: '0.2.0', state: 'unlocked' }) : '{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    await fs.writeFile(path.join(dir, 'harness.lock'), JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}`, dataDir: await fs.realpath(dir) }));
    await fs.writeFile(path.join(dir, 'api-token'), 'secret-token-value\n', { mode: 0o600 });
    let started = false;
    const r = await startOrRefuse({ dataDir: dir, port: 0, findApp: findAppHarness, findRunning: findRunningHarness, startServer: async () => { started = true; } });
    assert.deepEqual(r.other, { kind: 'listener', pid: process.pid, url: `http://127.0.0.1:${port}` });
    assert.equal(started, false);
    assert.deepEqual(got.map((g) => `${g.method} ${g.url}`), ['GET /api/health']);
    assert.ok(got.every((g) => !g.auth && !g.cookie && !g.raw), 'no credential, cookie or body was sent');
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a lock from another computer: never contacted (not even /api/health), whatever it names', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-far-'));
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.end('{}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    await fs.writeFile(path.join(dir, 'harness.lock'), JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}`, hostname: `${os.hostname()}-elsewhere`, dataDir: await fs.realpath(dir) }));
    assert.deepEqual(lockElsewhere({ dataDir: dir }), { hostname: `${os.hostname()}-elsewhere`, pid: process.pid });
    assert.equal(await findRunningHarness({ dataDir: dir }), null);
    const r = await startOrRefuse({ dataDir: dir, port: 0, findElsewhere: lockElsewhere, findApp: findAppHarness, findRunning: findRunningHarness, startServer: async () => { throw new Error('not reached'); } });
    assert.equal(r.other.kind, 'elsewhere');
    assert.equal(hits, 0);
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('real backend: a second start on the same data dir refuses via the lock', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-race-'));
  const first = await startServer({ port: 0, dataDir: dir, autodetect: false, logLevel: 'silent' });
  try {
    const r = await startOrRefuse({ dataDir: dir, port: 0, probeFirst: false, findApp: findAppHarness, findRunning: findRunningHarness,
      startServer: (o) => startServer({ ...o, autodetect: false, logLevel: 'silent' }) });
    assert.equal(r.server, null);
    assert.deepEqual(r.other, { kind: 'listener', pid: process.pid, url: first.url });
  } finally {
    await first.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
