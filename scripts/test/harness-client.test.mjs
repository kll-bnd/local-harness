// The command-line tools' session handling (scripts/lib/harness-client.mjs) against a stand-in of docs/API.md §10.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { HarnessClient, passwordSource, readSecretFromTty, readLaunchJson, describeOfflineLock, reachHarness, appHarness } from '../lib/harness-client.mjs';
import { startFakeSecurity } from './fake-security.mjs';

const quiet = () => {};
const stdinOf = (text) => Readable.from([Buffer.from(text)]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cli-'));
const scripted = (answers) => { const list = [...answers]; const prompts = []; return { kind: 'tty', prompts, read: async (p) => { prompts.push(p); return list.shift() ?? ''; } }; };

test('password from stdin: unlocks, uses the bearer token, logs out at the end', async () => {
  const f = await startFakeSecurity();
  try {
    const c = new HarnessClient({ base: f.url, dataDir: tmp(), password: passwordSource({ fromStdin: true, stdin: stdinOf('correct horse\nignored\n') }), log: quiet });
    const sec = await c.ensureSession({ reason: 'test' });
    assert.equal(sec.state, 'unlocked');
    assert.equal(c.via, 'password');
    assert.equal((await c.request('GET', '/api/data')).status, 200);
    await c.close();
    assert.equal(f.logouts, 1);
    assert.equal(f.sessions.size, 0);
    assert.equal((await c.request('GET', '/api/data').catch((e) => e)).code, 'no_password', 'the password was forgotten by close()');
  } finally { await f.close(); }
});

test('asks for a bearer token explicitly ("session": "token") and uses nothing else', async () => {
  const f = await startFakeSecurity();
  try {
    const c = new HarnessClient({ base: f.url, dataDir: tmp(), password: scripted(['correct horse']), log: quiet });
    await c.ensureSession();
    assert.equal(f.unlockBodies.at(-1).session, 'token');
    assert.equal(c.authHeaders().cookie, undefined);
    assert.match(c.authHeaders().authorization, /^Bearer /);
    const g = await startFakeSecurity({ honourTokenRequest: false });
    try {
      const d = new HarnessClient({ base: g.url, dataDir: tmp(), password: scripted(['correct horse']), log: quiet });
      await assert.rejects(d.ensureSession(), (e) => e.code === 'no_session');
    } finally { await g.close(); }
  } finally { await f.close(); }
});

test('state error (damaged key store): reported plainly, never a password prompt or setup', async () => {
  for (const code of ['vault_corrupt', 'vault_missing']) {
    const f = await startFakeSecurity({ state: 'error', error: { code, message: 'x' } });
    try {
      const pw = scripted(['should not be asked']);
      const c = new HarnessClient({ base: f.url, dataDir: tmp(), password: pw, log: quiet });
      await assert.rejects(c.ensureSession(), (e) => e.code === code && /Restore vault\.json from a backup/.test(e.message) && /Do not choose a new password/.test(e.message));
      assert.equal(pw.prompts.length, 0);
      assert.equal(f.unlockBodies.length, 0);
    } finally { await f.close(); }
  }
});

test('wrong password: asks again on a terminal, fails at once from stdin', async () => {
  const f = await startFakeSecurity();
  try {
    const pw = scripted(['nope', 'correct horse']);
    const c = new HarnessClient({ base: f.url, dataDir: tmp(), password: pw, log: quiet });
    await c.ensureSession({ reason: 'download a model' });
    assert.equal(pw.prompts.length, 2);
    assert.match(pw.prompts[0], /Harness password \(to download a model\)/);
    const s = new HarnessClient({ base: f.url, dataDir: tmp(), password: passwordSource({ fromStdin: true, stdin: stdinOf('nope\n') }), log: quiet });
    f.state = 'locked';
    await assert.rejects(s.ensureSession(), (e) => e.code === 'wrong_password');
  } finally { await f.close(); }
});

test('throttled unlock: waits for retryAfterMs, refuses waits over two minutes', async () => {
  const f = await startFakeSecurity();
  try {
    f.failed = 3; f.lastFailAt = Date.now(); // next try allowed after 1 s
    const logs = [];
    const c = new HarnessClient({ base: f.url, dataDir: tmp(), password: scripted(['correct horse']), log: (m) => logs.push(m) });
    const t0 = Date.now();
    await c.ensureSession();
    assert.ok(Date.now() - t0 >= 900, 'waited');
    assert.ok(logs.some((l) => /wait 1 s/.test(l)));
    f.state = 'locked'; f.failed = 12; f.lastFailAt = Date.now();
    const d = new HarnessClient({ base: f.url, dataDir: tmp(), password: scripted(['x']), log: quiet });
    await assert.rejects(d.ensureSession(), (e) => e.code === 'unlock_throttled' && /min/.test(e.message));
  } finally { await f.close(); }
});

test('needs_setup: the tool never chooses a password, it explains how to open Harness', async () => {
  const f = await startFakeSecurity({ state: 'needs_setup' });
  try {
    const pw = scripted(['should not be asked']);
    const c = new HarnessClient({ base: f.url, dataDir: tmp(), password: pw, log: quiet });
    await assert.rejects(c.ensureSession(), (e) => e.code === 'needs_setup' && /choose a password there/.test(e.message));
    assert.equal(pw.prompts.length, 0);
    assert.equal(f.unlockBodies.length, 0);
  } finally { await f.close(); }
});

test('keychain mode: uses the api-token file, no password asked', async () => {
  const f = await startFakeSecurity({ mode: 'keychain' });
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'api-token'), 'tok-123\n');
    f.sessions.add('tok-123');
    const pw = scripted([]);
    const c = new HarnessClient({ base: f.url, dataDir: dir, password: pw, log: quiet });
    await c.ensureSession();
    assert.equal(c.via, 'api-token');
    assert.equal(pw.prompts.length, 0);
    assert.deepEqual(f.unlockBodies, [{}], 'locked keychain mode is opened with {}');
    assert.equal((await c.request('GET', '/api/data')).status, 200);
    await c.close();
    assert.equal(f.logouts, 0, 'the per-install token is not a session to drop');
  } finally { await f.close(); }
});

test('Harness locks during the run: the next request unlocks again once', async () => {
  const f = await startFakeSecurity();
  try {
    const c = new HarnessClient({ base: f.url, dataDir: tmp(), password: scripted(['correct horse', 'correct horse']), log: quiet });
    await c.ensureSession();
    await c.request('POST', '/api/security/lock', {});
    assert.equal(f.state, 'locked');
    const r = await c.request('GET', '/api/data');
    assert.equal(r.status, 200);
  } finally { await f.close(); }
});

test('confirmations reuse the typed password; a wrong one is asked again', async () => {
  const f = await startFakeSecurity({ state: 'unlocked', mode: 'keychain' });
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'api-token'), 't');
    f.sessions.add('t');
    const pw = scripted(['wrong', 'correct horse']);
    const c = new HarnessClient({ base: f.url, dataDir: dir, password: pw, log: quiet });
    await c.ensureSession();
    const r = await c.withPassword((p) => c.request('POST', '/api/network/allow', { minutes: 15, password: p }));
    assert.equal(r.status, 200);
    assert.equal(pw.prompts.length, 2);
    assert.equal(f.offlineLock.blocked, false);
    assert.match(describeOfflineLock(f.offlineLock), /^ALLOWED until/);
    await c.request('POST', '/api/network/block', {});
    assert.match(describeOfflineLock(f.offlineLock), /^ON — blocked in Harness's code \+ macOS sandbox around the Ollama/);
  } finally { await f.close(); }
});

test('migration progress is waited for after unlocking', async () => {
  const f = await startFakeSecurity();
  try {
    f.password = 'pw-12345';
    const logs = [];
    const c = new HarnessClient({ base: f.url, dataDir: tmp(), password: scripted(['pw-12345']), log: (m) => logs.push(m) });
    f.state = 'locked';
    const orig = f.state;
    f.migration = null;
    await c.ensureSession();
    f.state = 'migrating'; f.migration = { op: 'encrypt', done: 0, total: 2 };
    const sec = await c.ensureSession();
    assert.equal(sec.state, 'unlocked');
    assert.ok(logs.some((l) => /encrypting your data: \d\/2/.test(l)));
    assert.ok(orig);
  } finally { await f.close(); }
});

test('the terminal prompt does not echo and handles backspace / Ctrl+C', async () => {
  const mk = () => { const s = new PassThrough(); s.isTTY = true; s.isRaw = false; s.setRawMode = (v) => { s.isRaw = v; }; return s; };
  const out = new PassThrough();
  let echoed = '';
  out.on('data', (d) => { echoed += d; });
  const a = mk();
  const p = readSecretFromTty('Password: ', { stdin: a, out });
  a.write('secrex\u007ft\r');
  assert.equal(await p, 'secret');
  assert.equal(echoed, 'Password: \n', 'nothing but the prompt and a newline is written');
  assert.equal(a.isRaw, false, 'raw mode restored');
  const b = mk();
  const q = readSecretFromTty('Password: ', { stdin: b, out });
  b.write('\u0003');
  await assert.rejects(q, (e) => e.code === 'aborted');
  await assert.rejects(readSecretFromTty('x', { stdin: new PassThrough(), out }), (e) => e.code === 'no_terminal');
});

test('launch.json defaults and a legacy (0.1) backend', async () => {
  const dir = tmp();
  assert.deepEqual(readLaunchJson(dir), { version: 1, offlineLock: true, offlineLockSuspendedUntil: null, encryption: 'password', exists: false });
  fs.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify({ version: 1, offlineLock: false, encryption: 'keychain' }));
  assert.equal(readLaunchJson(dir).offlineLock, false);
  assert.equal(readLaunchJson(dir).encryption, 'keychain');
  assert.match(describeOfflineLock({ enabled: false }), /^OFF/);
  assert.match(describeOfflineLock({ enabled: true, blocked: true, osEnforced: false, externalOllama: true }), /no OS sandbox; the Ollama in use was NOT started by Harness/);
});

test('Harness open in the native app: the tools say so instead of starting a second backend', async () => {
  const dir = tmp();
  try {
    // What the app's backend writes while it holds the folder (bridge mode: no URL, no port).
    fs.writeFileSync(path.join(dir, 'harness.lock'), JSON.stringify({ pid: process.pid, url: null, port: null, startedAt: new Date().toISOString(), dataDir: dir, transport: 'bridge' }));
    assert.equal(appHarness(dir)?.pid, process.pid);
    await assert.rejects(reachHarness({ dataDir: dir, port: 0 }), (e) => e.code === 'HARNESS_IN_APP' && e.pid === process.pid && /open in the Harness app/.test(e.message) && /quit the app/.test(e.message));
    assert.deepEqual(fs.readdirSync(dir), ['harness.lock'], 'nothing was started or written in the folder');
    // Once the app has quit (a stale lock), there is no app to report.
    fs.writeFileSync(path.join(dir, 'harness.lock'), JSON.stringify({ pid: 2 ** 22 + 4321, url: null, port: null, dataDir: dir, transport: 'bridge' }));
    assert.equal(appHarness(dir), null);
    assert.equal(await reachHarness({ dataDir: dir, port: 0, start: false }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
