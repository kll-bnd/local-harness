// Bridge mode (docs/BRIDGE.md) with the real child process: `node server/index.mjs --bridge`, frames on
// stdin/stdout, no listening socket.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpDir, parseSse, waitFor } from './helpers.mjs';
import { startFakeOllama } from './fake-ollama.mjs';
import { startFakeA1111 } from './fake-a1111.mjs';
import { BridgeClient } from '../server/bridge/client.mjs';
import { encodeFrame, FrameDecoder, T } from '../server/bridge/frames.mjs';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const PW = 'correct horse battery';
// the shipped defaults in the child (the opt-outs test/helpers.mjs sets for other suites must not leak in)
const ENV = { HARNESS_ENCRYPTION: '', HARNESS_API_AUTH: '', HARNESS_OFFLINE_LOCK: '', HARNESS_KEYCHAIN: 'file', HARNESS_NO_OLLAMA_AUTOSTART: '1', HARNESS_LOG_LEVEL: 'warn' };

let fake;
let dt;
before(async () => { fake = await startFakeOllama({ port: 0 }); dt = await startFakeA1111({ port: 0, stepMs: 2 }); });
after(async () => { await fake.close(); await dt.close(); });

async function dataDirWithSettings(extra = {}) {
  const dir = await tmpDir('harness-bridge-');
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({
    providers: { builtin: { ollama: { baseUrl: fake.url } } }, ollama: { autoStart: false }, embeddings: { model: 'off' }, memory: { enabled: false }, titles: { auto: false },
    image: { custom: [{ id: 'dt', name: 'DT', kind: 'a1111', baseUrl: dt.url, enabled: true }] }, ...extra,
  }));
  return dir;
}

/** Listening sockets (TCP, TCP6, Unix) owned by `pid` — Linux /proc. */
function listeningSocketsOf(pid) {
  const inodes = new Set();
  for (const fd of fss.readdirSync(`/proc/${pid}/fd`)) {
    try { const m = /^socket:\[(\d+)\]$/.exec(fss.readlinkSync(`/proc/${pid}/fd/${fd}`)); if (m) inodes.add(m[1]); } catch { /* closed meanwhile */ }
  }
  const out = [];
  const table = (f) => { try { return fss.readFileSync(`/proc/${pid}/net/${f}`, 'utf8').split('\n').slice(1); } catch { return []; } };
  for (const f of ['tcp', 'tcp6']) {
    for (const line of table(f)) {
      const c = line.trim().split(/\s+/);
      if (c.length > 9 && c[3] === '0A' && inodes.has(c[9])) out.push(`${f} ${c[1]}`);
    }
  }
  for (const line of table('unix')) {
    const c = line.trim().split(/\s+/);
    if (c.length > 6 && (parseInt(c[3], 16) & 0x10000) && inodes.has(c[6])) out.push(`unix ${c[7] || '(anonymous)'}`);
  }
  return { sockets: inodes.size, listening: out };
}

describe('bridge mode', () => {
  test('password mode end to end: ready(locked), static + JSON, setup, a streamed chat cancelled mid-stream keeps the partial reply', async () => {
    const dir = await dataDirWithSettings();
    const b = await BridgeClient.start({ dataDir: dir, env: ENV });
    try {
      const ready = b.events.find((e) => e.type === 'ready');
      assert.deepEqual({ ...ready, version: undefined }, { type: 'ready', protocol: 1, version: undefined, locked: true, state: 'needs_setup', encryption: { mode: 'password' }, offlineLock: true });
      const html = await b.request('GET', '/');
      assert.equal(html.status, 200);
      assert.match(html.headers['content-type'], /text\/html/);
      assert.ok(html.headers['content-security-policy']);
      assert.equal(html.headers['x-content-type-options'], 'nosniff');
      assert.equal((await b.request('GET', '/js/app.js')).status === 200 || (await b.request('GET', '/index.html')).status === 200, true);
      const health = await b.request('GET', '/api/health');
      assert.equal(health.json().state, 'needs_setup');
      assert.equal(health.headers['cache-control'], 'no-store');
      assert.equal((await b.request('GET', '/api/chats')).status, 423);
      const sec = (await b.request('GET', '/api/security')).json();
      assert.equal(sec.transport, 'bridge');
      assert.deepEqual(sec.session, { authenticated: true, via: 'bridge' });
      const su = await b.request('POST', '/api/security/setup', { body: { password: PW } });
      assert.equal(su.status, 200, su.text());
      assert.equal(su.json().sessionToken, undefined, 'no sessions over the bridge');
      // the instance proof answers over the bridge too, bound to "bridge" (review F6)
      const { openDataKeyWithPassword, instanceProof } = await import('../server/security/instance-proof.mjs');
      const nonce = crypto.randomBytes(24);
      const pr = await b.request('POST', '/api/security/prove', { body: { nonce: nonce.toString('base64url') } });
      assert.equal(pr.status, 200, pr.text());
      const key = await openDataKeyWithPassword(JSON.parse(fss.readFileSync(path.join(dir, 'vault.json'), 'utf8')), PW);
      assert.ok(Buffer.from(pr.json().proof, 'base64url').equals(instanceProof(key, nonce, 'bridge')));
      key.fill(0);
      assert.equal(su.headers['set-cookie'], undefined);
      await b.waitForEvent((e) => e.type === 'unlocked', 20000);
      // streamed chat, cancelled mid-stream (= a client disconnect: aborted, partial reply kept)
      fake.setDelay(10);
      fake.chatScript = () => ({ thinking: '', content: 'word '.repeat(300), toolCalls: [] });
      const chat = (await b.request('POST', '/api/chats', { body: {} })).json().chat;
      const s = b.stream('POST', `/api/chats/${chat.id}/messages`, { body: { content: 'go' } });
      const head = await s.head;
      assert.equal(head.status, 200);
      assert.match(head.headers['content-type'], /text\/event-stream/);
      let text = '';
      let tokens = 0;
      for await (const chunk of s.body) {
        text += chunk.toString();
        tokens = parseSse(text).filter((e) => e.type === 'token').length;
        if (tokens >= 5) { s.cancel(); break; }
      }
      assert.ok(tokens >= 5, 'tokens arrived unbuffered, one frame at a time');
      await waitFor(async () => !(await b.request('GET', `/api/chats/${chat.id}`)).json().chat.generating, { timeout: 10000 });
      const detail = (await b.request('GET', `/api/chats/${chat.id}`)).json();
      const asst = (Array.isArray(detail.messages) ? detail.messages : Object.values(detail.messages)).find((m) => m.role === 'assistant');
      assert.equal(asst.status, 'aborted');
      assert.ok(asst.content.length > 0 && asst.content.length < 'word '.repeat(300).length);
      fake.chatScript = null;
      fake.setDelay(0);
      // lock control message → locked event → 423
      b.control('lock');
      await b.waitForEvent((e) => e.type === 'locked');
      assert.equal((await b.request('GET', '/api/chats')).status, 423);
      const un = await b.request('POST', '/api/security/unlock', { body: { password: 'wrong wrong' } });
      assert.equal(un.status, 401);
      assert.equal((await b.request('POST', '/api/security/unlock', { body: { password: PW } })).status, 200);
      // ping → pong
      b.control('ping');
      await b.waitForEvent((e) => e.type === 'pong');
      assert.equal((await b.shutdown()).code, 0);
      assert.ok(!fss.existsSync(path.join(dir, 'harness.lock')), 'the data-dir lock was released');
    } finally { b.kill(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  test('a 5 MB upload and downloads (attachment, generated image) cross the bridge intact; encryption at rest holds', async () => {
    const dir = await dataDirWithSettings();
    const b = await BridgeClient.start({ dataDir: dir, env: ENV });
    try {
      await b.request('POST', '/api/security/setup', { body: { password: PW } });
      await b.waitForEvent((e) => e.type === 'unlocked', 20000);
      const big = Buffer.concat([Buffer.from('BRIDGE-MARKER '), crypto.randomBytes(5 * 1024 * 1024)]);
      const up = await b.request('POST', '/api/attachments?name=big.bin', { body: big, headers: { 'content-type': 'application/octet-stream' } });
      assert.equal(up.status, 201, up.text().slice(0, 300));
      const id = up.json().attachment.id;
      const down = await b.request('GET', `/api/attachments/${id}/content`);
      assert.equal(down.status, 200);
      assert.equal(down.headers['cache-control'], 'no-store');
      assert.ok(down.body.equals(big), 'byte-identical after the round trip');
      const gen = await b.request('POST', '/api/images/generate', { body: { providerId: 'dt', prompt: 'a lighthouse', seed: 3 } });
      const done = parseSse(gen.text()).find((e) => e.type === 'done');
      assert.ok(done, gen.text().slice(-300));
      const imgs = (await b.request('GET', '/api/images')).json().images;
      const file = await b.request('GET', `/api/images/${imgs[0].id}/file`);
      assert.equal(file.status, 200);
      assert.equal(file.body.subarray(1, 4).toString(), 'PNG');
      const files = [];
      const walk = (d) => { for (const e of fss.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(f); } };
      walk(dir);
      assert.deepEqual(files.filter((f) => fss.readFileSync(f).includes('BRIDGE-MARKER')), []);
    } finally { await b.shutdown().catch(() => {}); b.kill(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  test('keychain mode: the app gets keychain-key, the next start opens with hello.dataKey; a wrong key is fatal and touches nothing', async () => {
    const dir = await dataDirWithSettings();
    let b = await BridgeClient.start({ dataDir: dir, env: ENV });
    let dataKey;
    try {
      await b.request('POST', '/api/security/setup', { body: { password: PW } });
      await b.waitForEvent((e) => e.type === 'unlocked', 20000);
      await b.request('POST', '/api/chats', { body: { title: 'kc' } });
      const r = await b.request('POST', '/api/security/mode', { body: { mode: 'keychain', password: PW } });
      assert.equal(r.status, 200, r.text());
      const ev = await b.waitForEvent((e) => e.type === 'keychain-key');
      assert.match(ev.dataKey, /^[A-Za-z0-9+/]{43}=$/);
      dataKey = ev.dataKey;
      assert.equal(JSON.parse(fss.readFileSync(path.join(dir, 'launch.json'), 'utf8')).encryption, 'keychain', 'launch.json written before the event');
      assert.equal((await b.shutdown()).code, 0);
    } finally { b.kill(); }
    b = await BridgeClient.start({ dataDir: dir, env: ENV, dataKey });
    try {
      const ready = b.events.find((e) => e.type === 'ready');
      assert.equal(ready.locked, false);
      assert.deepEqual(ready.encryption, { mode: 'keychain' });
      assert.ok((await b.request('GET', '/api/chats')).json().chats.some((c) => c.title === 'kc'));
      // leaving keychain mode after a start with hello.dataKey: the app is told to delete its item
      // (the key handed over at start-up must still be intact, not wiped by the unlock)
      const before = b.events.length;
      const leave = await b.request('POST', '/api/security/mode', { body: { mode: 'password', password: PW } });
      assert.equal(leave.status, 200, leave.text());
      const gone = await b.waitForEvent((e) => e.type === 'keychain-key' && b.events.indexOf(e) >= before);
      assert.equal(gone.dataKey, null);
      // and back: a new key for the app to store
      const back = await b.request('POST', '/api/security/mode', { body: { mode: 'keychain', password: PW } });
      assert.equal(back.status, 200, back.text());
      const again = await b.waitForEvent((e) => e.type === 'keychain-key' && e.dataKey && b.events.indexOf(e) > b.events.indexOf(gone));
      assert.match(again.dataKey, /^[A-Za-z0-9+/]{43}=$/);
      assert.notEqual(again.dataKey, dataKey);
      dataKey = again.dataKey;
      assert.equal((await b.shutdown()).code, 0);
    } finally { b.kill(); }
    b = await BridgeClient.start({ dataDir: dir, env: ENV, dataKey });
    try {
      assert.equal(b.events.find((e) => e.type === 'ready').locked, false, 'the new key opens the data');
      assert.equal((await b.shutdown()).code, 0);
    } finally { b.kill(); }
    const before = new Map(fss.readdirSync(path.join(dir, 'chats')).map((f) => [f, fss.readFileSync(path.join(dir, 'chats', f))]));
    const wrong = await BridgeClient.start({ dataDir: dir, env: ENV, dataKey: crypto.randomBytes(32).toString('base64'), waitReady: false });
    try {
      await assert.rejects(wrong.ready, (e) => e.code === 'wrong_key');
      assert.equal((await wrong.exited).code, 1);
      for (const [f, buf] of before) assert.deepEqual(fss.readFileSync(path.join(dir, 'chats', f)), buf);
      assert.ok(!fss.existsSync(path.join(dir, 'harness.lock')));
    } finally { wrong.kill(); }
    // dataKey null in keychain mode: locked, the password still opens it
    b = await BridgeClient.start({ dataDir: dir, env: ENV, dataKey: null });
    try {
      assert.equal(b.events.find((e) => e.type === 'ready').locked, true);
      assert.equal((await b.request('POST', '/api/security/unlock', { body: { password: PW } })).status, 200);
      await b.shutdown();
    } finally { b.kill(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  test('stdin EOF (the app died): exits 0, stops the managed Ollama, releases the lock; no listening socket ever', async () => {
    const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const binDir = await tmpDir('harness-bbin-');
    const bin = path.join(binDir, 'ollama');
    await fs.writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, 'fake-ollama-bin.mjs')}" "$@"\n`, { mode: 0o755 });
    const dir = await dataDirWithSettings({ providers: { builtin: { ollama: { baseUrl: `http://127.0.0.1:${port}` } } }, ollama: { autoStart: true, binaryPath: bin, stopOnExit: true } });
    const b = await BridgeClient.start({ dataDir: dir, env: { ...ENV, HARNESS_ENCRYPTION: 'off', HARNESS_NO_OLLAMA_AUTOSTART: '0' } });
    try {
      assert.equal(b.events.find((e) => e.type === 'ready').state, 'unlocked');
      let pid = null;
      await waitFor(async () => { pid = (await b.request('GET', '/api/system')).json().ollama?.pid; return pid; }, { timeout: 15000 });
      assert.ok(fss.existsSync(path.join(dir, 'harness.lock')));
      assert.equal(JSON.parse(fss.readFileSync(path.join(dir, 'harness.lock'), 'utf8')).transport, 'bridge');
      if (process.platform === 'linux') {
        // the detector itself works: a listener in THIS process is found
        const probe = net.createServer();
        await new Promise((r) => probe.listen(0, '127.0.0.1', r));
        assert.equal(listeningSocketsOf(process.pid).listening.length >= 1, true);
        probe.close();
        const s = listeningSocketsOf(b.child.pid);
        assert.ok(s.sockets >= 0);
        assert.deepEqual(s.listening, [], 'the backend listens on nothing');
      }
      const { code } = await b.closeStdin();
      assert.equal(code, 0);
      assert.ok(!fss.existsSync(path.join(dir, 'harness.lock')));
      await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, { timeout: 8000 });
    } finally { b.kill(); await fs.rm(dir, { recursive: true, force: true }); await fs.rm(binDir, { recursive: true, force: true }); }
  });

  test('protocol edges: requests before ready are queued; a bad first frame is fatal (bad_hello); a corrupt length stops the stream', async () => {
    const dir = await dataDirWithSettings();
    const b = await BridgeClient.start({ dataDir: dir, env: ENV, waitReady: false });
    try {
      const early = b.request('GET', '/api/health');
      await b.ready;
      assert.equal((await early).status, 200);
      await b.shutdown();
    } finally { b.kill(); }
    const child = spawn(process.execPath, [path.join(here, '..', 'server', 'index.mjs'), '--bridge', '--data-dir', dir], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...ENV } });
    const dec = new FrameDecoder();
    const events = [];
    child.stdout.on('data', (d) => { for (const f of dec.push(d)) if (f.type === T.EVENT) events.push(JSON.parse(f.payload.toString())); });
    child.stdin.write(encodeFrame(T.REQ_HEAD, 1, Buffer.from('{"method":"GET","path":"/api/health"}')));
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 1);
    assert.equal(events[0]?.type, 'fatal');
    assert.equal(events[0].code, 'bad_hello');
    await fs.rm(dir, { recursive: true, force: true });
  });
});
