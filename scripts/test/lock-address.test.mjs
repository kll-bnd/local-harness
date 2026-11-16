// Nothing a lock file says is connected to, opened in a browser or sent a credential as written: a discovered
// Harness is only ever http://127.0.0.1:<valid port>; a lock written on another computer is not contacted at all;
// the instance proof is bound to the literal address and port the tool connected to; no redirect is followed.
// (Review R3-5.) Runs against stand-ins in temporary folders: no real data folder, no Keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HarnessClient, reachHarness, safeFetch, loopbackBase } from '../lib/harness-client.mjs';
import { startFakeSecurity, writeTestVault } from './fake-security.mjs';

process.env.HARNESS_NO_OLLAMA_AUTOSTART = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const recorder = path.join(root, 'scripts', 'test', 'net-recorder.mjs');
const PW = 'owner password 1234';
const quiet = () => {};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-lockaddr-'));
const scripted = (answers) => { const list = [...answers]; return { kind: 'tty', read: async () => list.shift() ?? '' }; };
const writeLock = (dir, info) => fs.writeFileSync(path.join(dir, 'harness.lock'), JSON.stringify({ startedAt: new Date().toISOString(), hostname: os.hostname(), dataDir: fs.realpathSync.native(dir), ...info }));

/** A listener that counts every connection and records every request; answers /api/health as Harness. */
async function standIn({ host = '127.0.0.1', port = 0, onRequest } = {}) {
  const s = { connections: 0, requests: [] };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      s.requests.push({ method: req.method, url: req.url, raw, headers: { ...req.headers } });
      if (onRequest && onRequest(req, res, raw) !== false) return;
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/api/health' ? JSON.stringify({ ok: true, name: 'harness', version: '0.2.0', state: 'unlocked' }) : '{}');
    });
  });
  srv.on('connection', () => { s.connections++; });
  await new Promise((r, j) => { srv.once('error', j); srv.listen(port, host, r); });
  s.port = srv.address().port;
  s.url = `http://${host.includes(':') ? `[${host}]` : host}:${s.port}`;
  s.close = () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
  return s;
}

/** Record every outgoing socket of THIS process while fn runs. */
async function connectsDuring(fn) {
  const seen = [];
  const orig = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const o = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (o && typeof o === 'object') seen.push({ host: o.path ? null : (o.host ?? 'localhost'), port: o.port ?? null });
    else seen.push({ host: typeof args[1] === 'string' ? args[1] : 'localhost', port: o });
    return orig.apply(this, args);
  };
  try { return { result: await fn().then((v) => ({ v }), (e) => ({ e })), seen }; } finally { net.Socket.prototype.connect = orig; }
}

/** A live process that is not us (a lock naming our own pid is "our own leftover" to the backend). */
function holder() {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  return { pid: c.pid, kill: () => c.kill('SIGKILL') };
}

// Locks whose address must never be used. `bad(conn)` says whether a recorded socket went where it must not.
const FORGED = [
  { name: 'another computer (hostname), naming a live local stand-in', far: true,
    lock: (L, pid) => ({ hostname: `${os.hostname()}-elsewhere`, url: L.url, port: L.port, pid }), bad: (c, L) => c.port === L.port },
  { name: 'a non-loopback url', lock: (L, pid) => ({ url: 'http://203.0.113.7:4747', pid }), bad: (c) => c.host === '203.0.113.7' },
  { name: 'a host name in the url', lock: (L, pid) => ({ url: `http://evil.invalid:${L.port}`, pid }), bad: (c, L) => c.host === 'evil.invalid' || c.port === L.port },
  { name: 'an out-of-range port', lock: (L, pid) => ({ url: 'http://127.0.0.1:70000', port: 70000, pid }), bad: (c) => Number(c.port) === 70000 },
  { name: 'a port that is not an integer', lock: (L, pid) => ({ url: `http://203.0.113.7:${L.port}`, port: `${L.port}x`, pid }), bad: (c, L) => c.host === '203.0.113.7' || c.port === L.port || c.port === `${L.port}x` },
];

test('loopbackBase accepts only http://127.0.0.1:<1–65535>', () => {
  assert.equal(loopbackBase('http://127.0.0.1:4747'), 'http://127.0.0.1:4747');
  for (const b of ['http://127.0.0.2:4747', 'http://localhost:4747', 'http://[::1]:4747', 'http://127.0.0.1:4747/', 'http://127.0.0.1:4747/x',
    'https://127.0.0.1:4747', 'http://u@127.0.0.1:4747', 'http://127.0.0.1:70000', 'http://127.0.0.1:0', 'http://127.0.0.1', 'http://203.0.113.7:4747', null]) {
    assert.equal(loopbackBase(b), null, String(b));
    assert.throws(() => new HarnessClient({ base: b, dataDir: '/nonexistent', password: scripted([]) }), (e) => e.code === 'instance_address', String(b));
  }
});

for (const c of FORGED) {
  test(`reachHarness: a lock with ${c.name} → no socket to it${c.far ? ', HARNESS_ELSEWHERE' : ''}`, async () => {
    const dir = tmp();
    const L = await standIn();
    const h = holder();
    try {
      writeLock(dir, c.lock(L, h.pid));
      const { result, seen } = await connectsDuring(() => reachHarness({ dataDir: dir, port: 0, raceWaitMs: 300, startOptions: { autodetect: false, logLevel: 'silent' } }));
      assert.deepEqual(seen.filter((x) => c.bad(x, L)), [], 'no socket to what the lock names');
      if (c.far) {
        assert.equal(result.e?.code, 'HARNESS_ELSEWHERE');
        assert.match(result.e.message, /in use by Harness on another computer \(.+-elsewhere\)\. This tool does not connect to it\./);
        assert.equal(L.connections, 0, 'the stand-in was not contacted at all');
      } else {
        assert.ok(result.e, 'refused');
        assert.ok(['HARNESS_BUSY', 'HARNESS_ALREADY_RUNNING'].includes(result.e.code), result.e.code);
        assert.equal(result.v, undefined, 'no address returned');
      }
      assert.equal(L.requests.filter((r) => r.url !== '/api/health').length, 0);
    } finally { h.kill(); await L.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

/** Run a tool with the socket/browser recorder. */
function runTool(script, args, { dataDir, env = {}, timeoutMs = 60000 }) {
  const rec = path.join(dataDir, '..', `${path.basename(dataDir)}.net.jsonl`);
  fs.writeFileSync(rec, '');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', recorder, path.join(root, 'scripts', script), ...args], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HARNESS_DATA_DIR: dataDir, HARNESS_PORT: '0', HARNESS_TEST_NET_RECORD: rec, HARNESS_NO_OLLAMA_AUTOSTART: '1', HARNESS_KEYCHAIN: 'file', NODE_OPTIONS: '', ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(t);
      const lines = fs.readFileSync(rec, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      fs.rmSync(rec, { force: true });
      resolve({ code, out, connects: lines.filter((l) => l.kind === 'connect'), opens: lines.filter((l) => l.kind === 'open') });
    });
  });
}

const TOOLS = [
  { tool: 'doctor --state', script: 'doctor.mjs', args: ['--state'], far: (r) => assert.equal(r.out.trim(), 'elsewhere') },
  { tool: 'get-model', script: 'get-model.mjs', args: ['--yes'], far: (r) => { assert.equal(r.code, 1); assert.match(r.out, /in use by Harness on another computer/); } },
  { tool: 'launch.mjs', script: 'launch.mjs', args: [], far: (r) => { assert.equal(r.code, 1); assert.match(r.out, /in use by Harness on another computer/); } },
];

for (const t of TOOLS) {
  test(`${t.tool}: forged locks → no socket to what they name, no browser opened at it`, async () => {
    await Promise.all(FORGED.map(async (c) => {
      const dir = tmp();
      const L = await standIn();
      const h = holder();
      try {
        writeLock(dir, c.lock(L, h.pid));
        fs.writeFileSync(path.join(dir, 'api-token'), `${'t'.repeat(43)}\n`, { mode: 0o600 });
        const r = await runTool(t.script, t.args, { dataDir: dir });
        assert.deepEqual(r.connects.filter((x) => c.bad(x, L)), [], `${c.name}: no socket to what the lock names\n${r.out}`);
        assert.deepEqual(r.opens, [], `${c.name}: no browser opened\n${r.out}`);
        assert.ok(L.requests.every((q) => q.url === '/api/health' && !q.headers.authorization && !q.raw), `${c.name}: no credential sent`);
        if (c.far) { t.far(r); assert.equal(L.connections, 0, `${c.name}: not contacted at all`); }
      } finally { h.kill(); await L.close(); fs.rmSync(dir, { recursive: true, force: true }); }
    }));
  });
}

test('doctor: a lock naming another computer is reported, nothing there is contacted', async () => {
  const dir = tmp();
  const L = await standIn();
  try {
    writeLock(dir, FORGED[0].lock(L, 4242));
    const r = await runTool('doctor.mjs', ['--json'], { dataDir: dir, timeoutMs: 90000 });
    assert.match(r.out, /in use by Harness on another computer \(.+-elsewhere\)/);
    assert.equal(L.connections, 0);
    assert.deepEqual(r.connects.filter((x) => x.port === L.port), []);
  } finally { await L.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('launch.mjs opens only http://127.0.0.1:<port>: not a launch URL elsewhere, not a redirect target', async () => {
  for (const mode of ['foreign-launch-url', 'redirect']) {
    const dir = tmp();
    const target = await standIn();
    const L = await standIn({
      onRequest: (req, res) => {
        if (req.url !== '/api/auth/launch-code') return false;
        if (mode === 'redirect') { res.writeHead(307, { location: `${target.url}/api/auth/launch-code` }); return res.end(); }
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ url: 'http://203.0.113.7:4747/#launch=phish' }));
      },
    });
    try {
      writeLock(dir, { url: 'http://203.0.113.7:4747', port: L.port, pid: process.pid });
      fs.writeFileSync(path.join(dir, 'api-token'), `${'t'.repeat(43)}\n`, { mode: 0o600 });
      const r = await runTool('launch.mjs', [], { dataDir: dir });
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(r.opens.map((o) => o.args.at(-1)), [`http://127.0.0.1:${L.port}`], `${mode}: ${r.out}`);
      assert.deepEqual(r.connects.filter((x) => x.host === '203.0.113.7'), []);
      assert.equal(target.connections, 0, `${mode}: the redirect was not followed`);
    } finally { await L.close(); await target.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

/** A loopback address other than 127.0.0.1 this machine can listen on (Linux: 127.0.0.2; macOS: ::1), or null. */
async function otherLoopback() {
  for (const host of ['127.0.0.2', '::1']) {
    const ok = await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(0, host, () => s.close(() => r(true))); });
    if (ok) return host;
  }
  return null;
}

/** Forwards everything to `to` (Host rewritten), recording request bodies — what script 34 does. */
async function relayTo(to, { host, port }) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push(`${req.url} ${body}`);
      const h = { ...req.headers, host: new URL(to).host };
      const up = http.request(new URL(req.url, to), { method: req.method, headers: h }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
      up.on('error', () => { res.writeHead(502); res.end(); });
      up.end(body);
    });
  });
  await new Promise((r, j) => { srv.once('error', j); srv.listen(port, host, r); });
  return { seen, port: srv.address().port, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

test('script 34: a relay on the SAME port at another loopback address — the forged lock is refused, nothing reaches the relay', async (t) => {
  const alt = await otherLoopback();
  if (!alt) return t.skip('no second loopback address to listen on here');
  const dir = tmp();
  const dek = await writeTestVault(dir, PW);
  const genuine = await startFakeSecurity({ state: 'unlocked', password: PW, prove: 'key', dataKey: dek });
  const relay = await relayTo(genuine.url, { host: alt, port: genuine.port });
  try {
    writeLock(dir, { pid: process.pid, url: `http://${alt.includes(':') ? `[${alt}]` : alt}:${relay.port}`, port: 1, hostname: `${os.hostname()}-elsewhere` });
    await assert.rejects(reachHarness({ dataDir: dir, port: 0 }), (e) => e.code === 'HARNESS_ELSEWHERE');
    assert.deepEqual(relay.seen, []);
    assert.equal(genuine.unlockBodies.length, 0);
  } finally { await relay.close(); await genuine.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the proof is bound to the address: a relay on 127.0.0.1:P forwarding to the genuine Harness on another loopback address at P fails, and gets no password', async (t) => {
  const alt = await otherLoopback();
  if (!alt) return t.skip('no second loopback address to listen on here');
  const dir = tmp();
  const dek = await writeTestVault(dir, PW);
  const genuine = await startFakeSecurity({ state: 'unlocked', password: PW, prove: 'key', dataKey: dek, host: alt });
  let relay;
  try { relay = await relayTo(genuine.url, { host: '127.0.0.1', port: genuine.port }); } catch { await genuine.close(); return t.skip('port taken on 127.0.0.1'); }
  try {
    writeLock(dir, { pid: process.pid, url: `http://127.0.0.1:${relay.port}`, port: relay.port });
    const h = await reachHarness({ dataDir: dir, start: false });
    assert.equal(h.base, `http://127.0.0.1:${genuine.port}`, 'same port number as the genuine one');
    const c = new HarnessClient({ base: h.base, dataDir: dir, password: scripted([PW]), log: quiet });
    await assert.rejects(c.ensureSession(), (e) => e.code === 'instance_unverified' && /proof does not match/.test(e.message));
    assert.equal(genuine.proveCalls.length, 1, 'the relay did forward the nonce');
    assert.ok(!relay.seen.some((x) => x.includes(PW)), 'the relay saw no password');
    assert.equal(genuine.unlockBodies.length, 0);
  } finally { await relay.close(); await genuine.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no redirect is followed: not from the proof request, not from the unlock that carries the password', async () => {
  const dir = tmp();
  const dek = await writeTestVault(dir, PW);
  const sink = await standIn();
  const atProve = await startFakeSecurity({ state: 'unlocked', password: PW, prove: 'key', dataKey: dek, redirect: { 'POST /api/security/prove': `${sink.url}/api/security/prove` } });
  const atUnlock = await startFakeSecurity({ state: 'unlocked', password: PW, prove: 'key', dataKey: dek, redirect: { 'POST /api/security/unlock': `${sink.url}/api/security/unlock` } });
  try {
    const a = new HarnessClient({ base: atProve.url, dataDir: dir, password: scripted([PW]), log: quiet });
    await assert.rejects(a.ensureSession(), (e) => e.code === 'instance_unverified' && /redirect/.test(e.message));
    assert.equal(atProve.unlockBodies.length, 0);
    const b = new HarnessClient({ base: atUnlock.url, dataDir: dir, password: scripted([PW]), log: quiet });
    await assert.rejects(b.ensureSession(), (e) => e.code === 'redirect_refused' && /does not follow redirects/.test(e.message));
    assert.equal(sink.connections, 0, 'nothing reached the redirect target');
    // The raw fetch the tools use for streams (get-model's pull) too.
    const r = await standIn({ onRequest: (req, res) => { res.writeHead(302, { location: `${sink.url}/x` }); res.end(); } });
    await assert.rejects(safeFetch(`${r.url}/api/models/pull`, { method: 'POST', headers: { authorization: 'Bearer abc' }, body: '{}' }), (e) => e.code === 'redirect_refused');
    assert.equal(sink.connections, 0);
    await r.close();
  } finally { await atProve.close(); await atUnlock.close(); await sink.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
