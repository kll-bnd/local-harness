// The command-line tools never send the owner's password to a Harness they did not start unless it PROVED it holds
// this data folder's key (scripts/lib/harness-client.mjs, scripts/lib/instance-proof.mjs). Everything here runs
// against stand-ins in temporary folders: no real data folder, no Keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { HarnessClient, passwordSource, reachHarness, bindingFor } from '../lib/harness-client.mjs';
import { openDataKeyWithPassword, instanceProof, proofBinding } from '../lib/instance-proof.mjs';
import { startFakeSecurity, writeTestVault } from './fake-security.mjs';
import { Readable } from 'node:stream';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { findRunningHarness, findAppHarness } = require('../../electron/lib/instance.cjs');

const PW = 'owner password 1234';
const quiet = () => {};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-proof-'));
const scripted = (answers) => { const list = [...answers]; const prompts = []; return { kind: 'tty', prompts, read: async (p) => { prompts.push(p); return list.shift() ?? ''; } }; };
const lockFor = (dir, port, extra = {}) => fs.writeFileSync(path.join(dir, 'harness.lock'), JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${port}`, port, startedAt: new Date().toISOString(), hostname: os.hostname(), dataDir: fs.realpathSync.native(dir), ...extra }));
const portOf = (f) => Number(new URL(f.url).port);

/** Nothing the fake received may contain the password or any encoding of the data key. */
function assertNoSecrets(f, dek) {
  const secrets = [PW, Buffer.from(PW).toString('base64'), ...(dek ? [dek.toString('hex'), dek.toString('base64'), dek.toString('base64url')] : [])];
  for (const r of f.received) {
    const all = `${r.path} ${r.raw} ${JSON.stringify(r.headers)}`;
    for (const s of secrets) assert.ok(!all.includes(s), `${r.method} ${r.path} carried a secret`);
  }
}

test('the helpers: the password opens the key locally; the proof depends on key and nonce', async () => {
  const dir = tmp();
  const dek = await writeTestVault(dir, PW);
  const vault = JSON.parse(fs.readFileSync(path.join(dir, 'vault.json'), 'utf8'));
  const k = await openDataKeyWithPassword(vault, PW);
  assert.ok(k && k.equals(dek));
  assert.equal(await openDataKeyWithPassword(vault, 'not it at all'), null);
  const n = Buffer.alloc(32, 7);
  const at = (a, p) => proofBinding({ address: a, port: p });
  assert.ok(instanceProof(dek, n, at('127.0.0.1', 4747)).equals(instanceProof(k, n, at('127.0.0.1', 4747))));
  assert.ok(!instanceProof(dek, n, at('127.0.0.1', 4747)).equals(instanceProof(dek, Buffer.alloc(32, 8), at('127.0.0.1', 4747))));
  assert.ok(!instanceProof(dek, n, at('127.0.0.1', 4747)).equals(instanceProof(Buffer.alloc(32, 1), n, at('127.0.0.1', 4747))));
  assert.ok(!instanceProof(dek, n, at('127.0.0.1', 4747)).equals(instanceProof(dek, n, at('127.0.0.1', 4748))), 'bound to the port');
  assert.ok(!instanceProof(dek, n, at('127.0.0.1', 4747)).equals(instanceProof(dek, n, at('127.0.0.2', 4747))), 'bound to the address');
  assert.ok(!instanceProof(dek, n, at('127.0.0.1', 4747)).equals(instanceProof(dek, n, at('::1', 4747))), 'bound to the address (IPv6)');
  assert.equal(bindingFor('http://127.0.0.1:4747'), 'addr:127.0.0.1:4747', 'the client binds to the literal address and port it connects to');
  assert.throws(() => proofBinding({ address: 'localhost', port: 4747 }), /IP literal/);
  assert.throws(() => instanceProof(dek, n, 'port:4747'), /binding/, 'the old port-only binding is gone');
});

test('a genuine unlocked instance found through the lock: proof verified first, then the password', async () => {
  const dir = tmp();
  const dek = await writeTestVault(dir, PW);
  const f = await startFakeSecurity({ state: 'unlocked', password: PW, prove: 'key', dataKey: dek });
  try {
    lockFor(dir, portOf(f));
    const h = await reachHarness({ dataDir: dir, start: false });
    assert.equal(h.base, f.url);
    assert.equal(h.srv, null);
    const c = new HarnessClient({ base: h.base, dataDir: dir, password: scripted([PW]), log: quiet });
    const sec = await c.ensureSession({ reason: 'download a model' });
    assert.equal(sec.state, 'unlocked');
    const paths = f.received.map((r) => `${r.method} ${r.path}`);
    const iProve = paths.indexOf('POST /api/security/prove');
    const iUnlock = paths.indexOf('POST /api/security/unlock');
    assert.ok(iProve >= 0 && iUnlock > iProve, `proof before the password: ${paths.join(', ')}`);
    assert.equal(f.unlockBodies[0].password, PW);
    assert.equal(Buffer.from(f.proveCalls[0].nonce, 'base64url').length, 32);
    // A confirmation (allow internet) is proved again before the password goes out.
    const before = f.proveCalls.length;
    const r = await c.withPassword((pw) => c.request('POST', '/api/network/allow', { minutes: 15, password: pw }));
    assert.equal(r.status, 200);
    assert.equal(f.proveCalls.length, before + 1);
    await c.close();
  } finally { await f.close(); }
});

for (const [label, prove] of [['answers 404 (no proof route)', 'none'], ['answers a wrong proof', 'wrong'], ['says it is locked', 'locked']]) {
  test(`an impostor that ${label}: the tool stops and receives no password and no key material`, async () => {
    const dir = tmp();
    const dek = await writeTestVault(dir, PW);
    const f = await startFakeSecurity({ state: 'unlocked', password: PW, prove });
    try {
      lockFor(dir, portOf(f));
      const h = await reachHarness({ dataDir: dir, start: false });
      const c = new HarnessClient({ base: h.base, dataDir: dir, password: passwordSource({ fromStdin: true, stdin: Readable.from([Buffer.from(`${PW}\n`)]) }), log: quiet });
      await assert.rejects(c.ensureSession(), (e) => e.code === 'instance_unverified' && /password was NOT sent/.test(e.message) && !e.message.includes(PW));
      assert.equal(f.unlockBodies.length, 0);
      assertNoSecrets(f, dek);
      await c.close();
    } finally { await f.close(); }
  });
}

test('an impostor that drops the connection on the proof request: unverified, nothing sent', async () => {
  const dir = tmp();
  await writeTestVault(dir, PW);
  const got = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      got.push(`${req.url} ${raw}`);
      if (req.url === '/api/security/prove') return req.socket.destroy();
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(req.url === '/api/security' ? { state: 'unlocked', mode: 'password', unlock: { retryAfterMs: 0 }, session: { authenticated: false } } : { ok: true, name: 'harness' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const c = new HarnessClient({ base: `http://127.0.0.1:${srv.address().port}`, dataDir: dir, password: scripted([PW]), log: quiet });
    await assert.rejects(c.ensureSession(), (e) => e.code === 'instance_unverified' && /did not answer/.test(e.message));
    assert.ok(!got.some((g) => g.includes(PW)));
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('a relay on another port that forwards to the genuine instance cannot reuse its proof', async () => {
  const dir = tmp();
  const dek = await writeTestVault(dir, PW);
  const genuine = await startFakeSecurity({ state: 'unlocked', password: PW, prove: 'key', dataKey: dek });
  const seen = [];
  const relay = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    seen.push(`${req.url} ${raw}`);
    const up = await fetch(genuine.url + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: raw || undefined });
    res.writeHead(up.status, { 'content-type': 'application/json' });
    res.end(await up.text());
  });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  try {
    lockFor(dir, relay.address().port);
    const h = await reachHarness({ dataDir: dir, start: false });
    const c = new HarnessClient({ base: h.base, dataDir: dir, password: scripted([PW]), log: quiet });
    await assert.rejects(c.ensureSession(), (e) => e.code === 'instance_unverified' && /proof does not match/.test(e.message));
    assert.ok(!seen.some((x) => x.includes(PW)), 'the relay saw no password');
    assert.equal(genuine.unlockBodies.length, 0);
  } finally { relay.closeAllConnections?.(); relay.close(); await genuine.close(); }
});

test('a locked instance found through the lock: the message, no prompt, nothing sent', async () => {
  const dir = tmp();
  const dek = await writeTestVault(dir, PW);
  const f = await startFakeSecurity({ state: 'locked', password: PW, prove: 'key', dataKey: dek });
  try {
    const pw = scripted([PW]);
    const c = new HarnessClient({ base: f.url, dataDir: dir, password: pw, log: quiet });
    await assert.rejects(c.ensureSession(), (e) => e.code === 'instance_locked' && /is locked/.test(e.message) && /Unlock it in its own window \(or quit it\)/.test(e.message));
    assert.equal(pw.prompts.length, 0);
    assert.deepEqual(f.received.map((r) => r.path).filter((p) => p !== '/api/security' && p !== '/api/health'), []);
  } finally { await f.close(); }
});

test('a wrong password is caught locally and asked again; the instance sees nothing of it', async () => {
  const dir = tmp();
  const dek = await writeTestVault(dir, PW);
  const f = await startFakeSecurity({ state: 'unlocked', password: PW, prove: 'key', dataKey: dek });
  try {
    const logs = [];
    const pw = scripted(['wrong guess 1', PW]);
    const c = new HarnessClient({ base: f.url, dataDir: dir, password: pw, log: (m) => logs.push(m) });
    await c.ensureSession();
    assert.equal(pw.prompts.length, 2);
    assert.ok(logs.includes('That is not the Harness password.'));
    assert.equal(f.proveCalls.length, 1, 'proved once, after the right password');
    assert.equal(f.unlockBodies.length, 1);
    assert.ok(!f.received.some((r) => r.raw.includes('wrong guess 1')));
    assert.equal(f.failed, 0, 'the instance\'s wrong-password counter was not touched');
    // From stdin there is no second chance.
    const s = new HarnessClient({ base: f.url, dataDir: dir, password: passwordSource({ fromStdin: true, stdin: Readable.from([Buffer.from('nope nope\n')]) }), log: quiet });
    await assert.rejects(s.ensureSession(), (e) => e.code === 'wrong_password');
  } finally { await f.close(); }
});

test('an in-process instance (started by this tool) is unchanged: no proof needed', async () => {
  const dir = tmp();
  const f = await startFakeSecurity({ state: 'locked', password: PW, prove: 'none' });
  try {
    const c = new HarnessClient({ base: f.url, dataDir: dir, password: scripted([PW]), log: quiet, inProcess: true });
    await c.ensureSession();
    assert.equal(f.proveCalls.length, 0);
    assert.equal(f.unlockBodies[0].password, PW);
  } finally { await f.close(); }
});

test('a lock without dataDir (or for another folder) is ignored', async () => {
  const dir = tmp();
  const f = await startFakeSecurity({ state: 'unlocked' });
  try {
    lockFor(dir, portOf(f), { dataDir: undefined });
    assert.equal(await findRunningHarness({ dataDir: dir }), null);
    assert.equal(await reachHarness({ dataDir: dir, start: false }), null);
    lockFor(dir, portOf(f), { dataDir: '/somewhere/else' });
    assert.equal(await findRunningHarness({ dataDir: dir }), null);
    lockFor(dir, portOf(f), { dataDir: undefined, transport: 'bridge' });
    assert.equal(findAppHarness({ dataDir: dir }), null);
    lockFor(dir, portOf(f));
    assert.equal((await findRunningHarness({ dataDir: dir }))?.url, f.url);
  } finally { await f.close(); }
});

test('a key store outside the accepted scrypt bounds is reported as uncheckable, not as a wrong password', async () => {
  const dir = tmp();
  await writeTestVault(dir, PW);
  const file = path.join(dir, 'vault.json');
  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  v.wraps.password.kdf.N = 2 ** 30;
  fs.writeFileSync(file, JSON.stringify(v));
  const f = await startFakeSecurity({ state: 'unlocked', password: PW, prove: 'key', dataKey: Buffer.alloc(32) });
  try {
    const pw = scripted([PW]);
    const c = new HarnessClient({ base: f.url, dataDir: dir, password: pw, log: quiet });
    await assert.rejects(c.ensureSession(), (e) => e.code === 'instance_unverified' && /cannot be checked here/.test(e.message));
    assert.equal(pw.prompts.length, 0, 'not asked at all');
    assert.equal(f.unlockBodies.length, 0);
  } finally { await f.close(); }
});

test('without a readable key store the password is not sent to a discovered instance', async () => {
  const dir = tmp();
  const f = await startFakeSecurity({ state: 'unlocked', password: PW, prove: 'key', dataKey: Buffer.alloc(32) });
  try {
    const c = new HarnessClient({ base: f.url, dataDir: dir, password: scripted([PW]), log: quiet });
    await assert.rejects(c.ensureSession(), (e) => e.code === 'instance_unverified' && /no readable key store/.test(e.message));
    assert.equal(f.unlockBodies.length, 0);
  } finally { await f.close(); }
});
