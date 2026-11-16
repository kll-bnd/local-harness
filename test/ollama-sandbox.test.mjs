// How Harness starts its own Ollama under the offline-lock sandbox (stand-ins for /usr/bin/sandbox-exec and for
// `ollama`): one start at a time per address, following an address change, probing before spawning, never losing
// its child, a slow sandboxed start is not a broken sandbox, a fallback only on evidence (and not for good), and
// putting Ollama back into the sandbox by itself when that costs the user nothing.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir, waitFor, parseSse } from './helpers.mjs';
import { OllamaProcess, probeOllama, SANDBOX_PROFILE, MAX_SANDBOX_FAILURES } from '../server/providers/ollama-process.mjs';
import { startServer } from '../server/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let dir;
let SBX;
let BIN;
let LOG;
const prev = {};
const ENV_KEYS = ['HARNESS_SANDBOX_EXEC', 'HARNESS_OLLAMA_LISTEN_MS', 'HARNESS_OLLAMA_READY_MS', 'FAKE_SB_MODE', 'FAKE_SB_DELAY_MS', 'FAKE_PLAIN_MODE', 'FAKE_PLAIN_DELAY_MS', 'FAKE_OLLAMA_DELAY_MS', 'HARNESS_RECONCILE_MS', 'HARNESS_NO_OLLAMA_AUTOSTART'];
before(async () => {
  for (const k of ENV_KEYS) prev[k] = process.env[k];
  dir = await tmpDir('harness-osbx-');
  LOG = path.join(dir, 'sandbox.log');
  SBX = path.join(dir, 'sandbox-exec');
  // stand-in for sandbox-exec: logs, marks the child as sandboxed, runs the command
  await fs.writeFile(SBX, `#!/bin/sh\necho "$@" >> "${LOG}"\nshift 2\nFAKE_SANDBOXED=1 exec "$@"\n`, { mode: 0o755 });
  BIN = path.join(dir, 'ollama');
  // stand-in for ollama: behaviour per FAKE_SB_* (under the sandbox) or FAKE_PLAIN_* (outside)
  await fs.writeFile(BIN, `#!${process.execPath}
const under = process.env.FAKE_SANDBOXED === '1';
const mode = (under ? process.env.FAKE_SB_MODE : process.env.FAKE_PLAIN_MODE) || 'ok';
const delay = Number(under ? process.env.FAKE_SB_DELAY_MS : process.env.FAKE_PLAIN_DELAY_MS) || 0;
if (mode === 'exit') { console.error('Error: could not initialise the GPU (stand-in)'); process.exit(1); }
if (mode === 'bind') { console.error('Error: listen tcp ' + process.env.OLLAMA_HOST + ': bind: address already in use'); process.exit(1); }
const real = () => import(${JSON.stringify(path.join(here, 'fake-ollama-bin.mjs'))});
if (mode === 'hang') { setInterval(() => {}, 1000); }
else if (mode === 'gpu') {
  // like a real Ollama during GPU discovery: listens at once, answers only after the delay
  import('node:http').then(({ createServer }) => {
    const [h, p] = process.env.OLLAMA_HOST.split(':');
    const held = [];
    const srv = createServer((req, res) => { held.push(res); });
    srv.listen(Number(p), h, () => console.log('level=INFO msg="Listening on ' + process.env.OLLAMA_HOST + ' (version stand-in)"'));
    setTimeout(() => { for (const r of held) r.destroy(); srv.closeAllConnections?.(); srv.close(() => real()); }, delay);
  });
}
else setTimeout(real, delay);
process.on('SIGTERM', () => process.exit(0));
`, { mode: 0o755 });
  process.env.HARNESS_SANDBOX_EXEC = SBX;
});
after(async () => {
  for (const k of ENV_KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  await fs.rm(dir, { recursive: true, force: true });
});
const sandboxLog = () => (fss.existsSync(LOG) ? fss.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) : []);
const resetFake = () => { for (const k of ['FAKE_SB_MODE', 'FAKE_SB_DELAY_MS', 'FAKE_PLAIN_MODE', 'FAKE_PLAIN_DELAY_MS', 'HARNESS_OLLAMA_LISTEN_MS', 'HARNESS_OLLAMA_READY_MS']) delete process.env[k]; fss.rmSync(LOG, { force: true }); };

/** An OllamaProcess wired to a provider whose address can change. */
function proc({ sandbox = () => true } = {}) {
  const provider = { baseUrl: null, status: async () => ({ ok: (await probeOllama(provider.baseUrl)).state === 'ollama' }) };
  const p = new OllamaProcess({ getSettings: () => ({ ollama: { binaryPath: BIN } }), getProvider: () => provider, totalMem: 16 * 1024 ** 3, sandbox, sandboxExec: SBX, profile: SANDBOX_PROFILE });
  return { p, provider };
}

describe('starting Harness\'s own Ollama', () => {
  test('(a) a start that arrives while another runs waits, then starts for the CURRENT address — never the stale result', async () => {
    resetFake();
    process.env.FAKE_SB_DELAY_MS = '1200';
    const { p, provider } = proc();
    const [a, b] = [await freePort(), await freePort()];
    try {
      provider.baseUrl = `http://127.0.0.1:${a}`;
      const first = p.start();
      await new Promise((r) => setTimeout(r, 200));
      provider.baseUrl = `http://127.0.0.1:${b}`; // the setting changed meanwhile
      const second = await p.start();
      assert.equal((await first).started, true);
      assert.equal(second.started, true, JSON.stringify(second));
      assert.equal(second.sandboxed, true);
      assert.equal(p.childAddr, `127.0.0.1:${b}`);
      assert.equal((await probeOllama(`http://127.0.0.1:${b}`)).state, 'ollama', 'Ollama answers on the new address');
      assert.equal((await probeOllama(`http://127.0.0.1:${a}`)).state, 'free', 'and ours on the old one was stopped');
    } finally { await p.stop(); }
  });

  test('(b) the Ollama Harness started moves when the configured address changes; (e) it is never lost or doubled', async () => {
    resetFake();
    const { p, provider } = proc();
    const [a, b] = [await freePort(), await freePort()];
    try {
      provider.baseUrl = `http://127.0.0.1:${a}`;
      const r1 = await p.start();
      assert.equal(r1.started, true);
      const again = await p.start(); // same address, our child alive: no second spawn
      assert.equal(again.alreadyRunning, true);
      assert.equal(again.managed, true);
      assert.equal(again.pid, r1.pid);
      assert.equal(sandboxLog().length, 1, 'spawned once');
      provider.baseUrl = `http://127.0.0.1:${b}`;
      const moved = await p.followAddress();
      assert.equal(moved.moved, true);
      assert.equal(moved.started, true);
      assert.equal(p.childAddr, `127.0.0.1:${b}`);
      assert.equal((await probeOllama(`http://127.0.0.1:${a}`)).state, 'free');
      assert.equal(p.managed, true);
    } finally { await p.stop(); }
  });

  test('(d) probe before spawning: a timeout or a non-Ollama answer is "somebody is there" — no spawn; (c) that never poisons the sandbox', async () => {
    resetFake();
    const { p, provider } = proc();
    const silent = net.createServer((c) => { c.on('error', () => {}); /* accepts, never answers */ });
    await new Promise((r) => silent.listen(0, '127.0.0.1', r));
    const other = net.createServer((c) => c.on('error', () => {}).end('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 5\r\nconnection: close\r\n\r\nhello'));
    await new Promise((r) => other.listen(0, '127.0.0.1', r));
    try {
      provider.baseUrl = `http://127.0.0.1:${silent.address().port}`;
      const r1 = await p.start();
      assert.equal(r1.started, false);
      assert.equal(r1.code, 'not_responding');
      provider.baseUrl = `http://127.0.0.1:${other.address().port}`;
      const r2 = await p.start();
      assert.equal(r2.code, 'port_in_use');
      assert.equal(sandboxLog().length, 0, 'nothing was spawned onto an occupied port');
      // Ollama's own bind failure under the sandbox: reported as such, no fallback, the sandbox is not blamed
      process.env.FAKE_SB_MODE = 'bind';
      provider.baseUrl = `http://127.0.0.1:${await freePort()}`;
      const r3 = await p.start();
      assert.equal(r3.code, 'port_in_use', JSON.stringify(r3));
      assert.match(r3.error, /address already in use/);
      assert.equal(p.sandboxFailures, 0);
      assert.equal(p.osFallback, null);
      // the exact sequence of the bug: after those failures, a start on a free port is STILL sandboxed
      delete process.env.FAKE_SB_MODE;
      provider.baseUrl = `http://127.0.0.1:${await freePort()}`;
      const r4 = await p.start();
      assert.equal(r4.started, true);
      assert.equal(r4.sandboxed, true);
    } finally { await p.stop(); silent.close(); other.close(); }
  });

  test('listening at once but answering only after its GPU discovery (longer than the listen limit): stays sandboxed, phases reported', async () => {
    resetFake();
    // scaled down: the real limits are 20 s to listen and 120 s for GPU discovery; the real case was 19–25 s
    process.env.FAKE_SB_MODE = 'gpu';
    process.env.FAKE_SB_DELAY_MS = '2500';
    process.env.HARNESS_OLLAMA_LISTEN_MS = '600';
    process.env.HARNESS_OLLAMA_READY_MS = '10000';
    const { p, provider } = proc();
    const phases = [];
    const off = p.onPhase((ph) => phases.push(ph));
    try {
      provider.baseUrl = `http://127.0.0.1:${await freePort()}`;
      const r = await p.start(); // the old code gave up after 20 s in total and dropped the sandbox
      assert.equal(r.started, true, JSON.stringify(r));
      assert.equal(r.sandboxed, true);
      assert.ok(r.startMs >= 2400, `waited for the GPU discovery (${r.startMs} ms)`);
      assert.equal(p.osFallback, null);
      assert.equal(sandboxLog().length, 1, 'no second start, no fallback');
      assert.deepEqual(phases, ['starting', 'waiting_for_gpu', null]);
    } finally { off(); await p.stop(); }
  });

  test('GPU discovery that does not finish in time is a start error, never a reason to leave the sandbox', async () => {
    resetFake();
    process.env.FAKE_SB_MODE = 'gpu';
    process.env.FAKE_SB_DELAY_MS = '20000';
    process.env.HARNESS_OLLAMA_READY_MS = '1200';
    const { p, provider } = proc();
    try {
      provider.baseUrl = `http://127.0.0.1:${await freePort()}`;
      const r = await p.start();
      assert.equal(r.started, false);
      assert.equal(r.code, 'gpu_discovery_timeout');
      assert.match(r.error, /still looking for the GPU after 1 s — is another app using the GPU heavily\?/);
      assert.equal(p.osFallback, null);
      assert.equal(p.sandboxFailures, 0);
      assert.equal(p.managed, false, 'the stuck child was stopped');
    } finally { await p.stop(); }
  });

  test('fallback only on evidence: never answers under the sandbox but plain → osFallback; exits under the sandbox → osFallback; both failing → nothing blamed', async () => {
    resetFake();
    process.env.HARNESS_OLLAMA_LISTEN_MS = '1200';
    const { p, provider } = proc();
    try {
      process.env.FAKE_SB_MODE = 'hang'; // never even listens under the sandbox
      provider.baseUrl = `http://127.0.0.1:${await freePort()}`;
      const r = await p.start();
      assert.equal(r.started, true);
      assert.equal(r.sandboxed, false);
      assert.equal(p.osFallback.reason, 'sandboxed_not_listening');
      assert.equal(p.osFallback.count, 1);
      assert.ok(p.osFallback.at);
      assert.equal(p._useSandbox(), true, 'not sticky: the sandbox is tried again later');
      // a retry inside the sandbox (what the reconcile step does) works once Ollama behaves
      delete process.env.FAKE_SB_MODE;
      const back = await p.applySandbox();
      assert.equal(back.restarted, true);
      assert.equal(p.sandboxed, true);
      assert.equal(p.osFallback.count, 1, 'osFallback stays so the user can see it happened');
      await p.stop();
      // exits under the sandbox
      process.env.FAKE_SB_MODE = 'exit';
      provider.baseUrl = `http://127.0.0.1:${await freePort()}`;
      const e = await p.start();
      assert.equal(e.started, true);
      assert.equal(p.osFallback.reason, 'sandboxed_exit');
      assert.match(p.osFallback.detail, /could not initialise the GPU/);
      assert.equal(p.osFallback.count, 2);
      await p.stop();
      // both fail: the start error is reported, nothing is marked
      process.env.FAKE_PLAIN_MODE = 'exit';
      provider.baseUrl = `http://127.0.0.1:${await freePort()}`;
      const both = await p.start();
      assert.equal(both.started, false);
      assert.equal(p.sandboxFailures, 2);
      delete process.env.FAKE_PLAIN_MODE;
      // the third evidenced failure: no more tries until Harness restarts
      const third = await p.start();
      assert.equal(third.started, true);
      assert.equal(p.osFallback.count, MAX_SANDBOX_FAILURES);
      assert.equal(p.sandboxBroken, true);
      assert.equal(p._useSandbox(), false);
    } finally { await p.stop(); }
  });
});

describe('the server around it', () => {
  async function stack({ autoStart, port, secure = false, settings = {} }) {
    const dataDir = await tmpDir('harness-osbx-srv-');
    await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ providers: { builtin: { ollama: { baseUrl: `http://127.0.0.1:${port}` } } }, ollama: { autoStart, binaryPath: BIN, stopOnExit: true }, embeddings: { model: 'off' }, memory: { enabled: false }, titles: { auto: false }, ...settings }));
    if (autoStart) delete process.env.HARNESS_NO_OLLAMA_AUTOSTART; else process.env.HARNESS_NO_OLLAMA_AUTOSTART = '1';
    const srv = await startServer({ port: 0, dataDir, autodetect: false, logLevel: 'silent', processGuards: false, keychain: 'file', security: secure ? { mode: 'password', apiAuth: false, kdf: { N: 1024, r: 8, p: 1 } } : { mode: 'off', apiAuth: false }, offlineLock: true });
    const call = async (method, p, body) => { const r = await fetch(srv.url + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }); const ct = r.headers.get('content-type') || ''; return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() }; };
    return { srv, call, dataDir, close: async () => { await srv.close(); process.env.HARNESS_NO_OLLAMA_AUTOSTART = '1'; await fs.rm(dataDir, { recursive: true, force: true }); } };
  }

  test('the stand-in reproduction: start at one address, change it, start again — both rounds confined', async () => {
    for (const autoStart of [true, false]) {
      resetFake();
      const s = await stack({ autoStart, port: await freePort() });
      try {
        if (autoStart) await waitFor(() => s.srv.core.ollamaProcess.managed, { timeout: 10000 });
        const spare = await freePort();
        assert.equal((await s.call('PATCH', '/api/settings', { providers: { builtin: { ollama: { baseUrl: `http://127.0.0.1:${spare}` } } } })).status, 200);
        const st = await s.call('POST', '/api/providers/ollama/start', {});
        assert.equal(st.status, 200, JSON.stringify(st.data));
        assert.equal(st.data.sandboxed, true, `round with auto-start ${autoStart}: ${JSON.stringify(st.data)}`);
        assert.equal((await probeOllama(`http://127.0.0.1:${spare}`)).state, 'ollama', 'answers on the new address');
        const lock = (await s.call('GET', '/api/network')).data.offlineLock;
        assert.equal(lock.osScope, 'ollama');
        assert.equal(lock.osFallback, null);
        assert.equal(s.srv.core.ollamaProcess.childAddr, `127.0.0.1:${spare}`);
      } finally { await s.close(); }
    }
  });

  test('back into the sandbox by itself: not under a running reply; after it, once no model is loaded; and at lock', async () => {
    resetFake();
    process.env.HARNESS_RECONCILE_MS = '150';
    process.env.FAKE_OLLAMA_DELAY_MS = '15';
    const port = await freePort();
    const s = await stack({ autoStart: false, port, secure: true, settings: { defaultModel: { providerId: 'ollama', model: 'qwen3:4b' } } });
    try {
      const su = await s.call('POST', '/api/security/setup', { password: 'correct horse battery' });
      assert.equal(su.status, 200);
      await waitFor(async () => (await s.call('GET', '/api/security')).data.state === 'unlocked', { timeout: 15000 });
      const core = s.srv.core;
      assert.equal((await s.call('POST', '/api/providers/ollama/start', {})).data.sandboxed, true);
      // allow → restarted outside the sandbox (the user's action)
      await s.call('POST', '/api/network/allow', { minutes: 5, password: 'correct horse battery' });
      assert.equal(core.ollamaProcess.sandboxed, false);
      // a reply is streaming when the window ends: Ollama is NOT restarted under it
      const c = await s.call('POST', '/api/chats', {});
      const gen = fetch(`${s.srv.url}/api/chats/${c.data.chat.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'long answer 300' }) }).then((r) => r.text());
      await waitFor(() => core.app.engine.active.size > 0);
      const pidDuring = core.ollamaProcess.child.pid;
      core.network.launch.set({ offlineLockSuspendedUntil: new Date(Date.now() + 30).toISOString() });
      core.network._arm();
      await waitFor(() => core.network.blocked);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(core.ollamaProcess.child.pid, pidDuring, 'not restarted under a running reply');
      assert.equal((await s.call('GET', '/api/network')).data.offlineLock.osPending, true);
      const events = parseSse(await gen);
      assert.ok(events.some((e) => e.type === 'done'), 'the reply finished undisturbed');
      // the reply left its model loaded: still waiting
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(core.ollamaProcess.child.pid, pidDuring, 'not restarted while a model is loaded');
      // once the model is unloaded (keep_alive ran out / unloaded), the timer puts Ollama back
      const ps = await (await fetch(`http://127.0.0.1:${port}/api/ps`)).json();
      for (const m of ps.models || []) await fetch(`http://127.0.0.1:${port}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.name, keep_alive: 0 }) });
      await waitFor(() => core.ollamaProcess.sandboxed, { timeout: 10000 });
      assert.notEqual(core.ollamaProcess.child.pid, pidDuring);
      const after = (await s.call('GET', '/api/network')).data.offlineLock;
      assert.equal(after.osPending, false);
      assert.equal(after.osScope, 'ollama');
      // at lock: allow again, let a reply leave its model loaded, end the window, then lock
      await s.call('POST', '/api/network/allow', { minutes: 5, password: 'correct horse battery' });
      const c2 = await s.call('POST', '/api/chats', {});
      await (await fetch(`${s.srv.url}/api/chats/${c2.data.chat.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hi' }) })).text();
      process.env.HARNESS_RECONCILE_MS = '600000'; // no timer help this time
      core._stopReconcileTimer();
      const pid2 = core.ollamaProcess.child.pid;
      core.network.launch.set({ offlineLockSuspendedUntil: new Date(Date.now() + 30).toISOString() });
      core.network._arm();
      await waitFor(() => core.network.blocked);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(core.ollamaProcess.child.pid, pid2, 'a model is loaded: waiting');
      assert.equal((await s.call('POST', '/api/security/lock', {})).status, 200);
      await waitFor(() => core.ollamaProcess.sandboxed, { timeout: 10000 });
      assert.notEqual(core.ollamaProcess.child.pid, pid2, 'restarted inside the sandbox at lock');
    } finally { delete process.env.FAKE_OLLAMA_DELAY_MS; await s.close(); }
  });

  test('a chat sent while Harness\'s Ollama is still discovering the GPU waits visibly (starting_ollama, waiting_for_gpu) and then answers', async () => {
    resetFake();
    process.env.FAKE_SB_MODE = 'gpu';
    process.env.FAKE_SB_DELAY_MS = '1500';
    const s = await stack({ autoStart: true, port: await freePort(), settings: { defaultModel: { providerId: 'ollama', model: 'qwen3:4b' } } });
    try {
      const c = await s.call('POST', '/api/chats', {});
      const r = await fetch(`${s.srv.url}/api/chats/${c.data.chat.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hello' }) });
      const ev = parseSse(await r.text());
      const reasons = ev.filter((e) => e.type === 'model_status').map((e) => e.reason);
      assert.equal(reasons[0], 'starting_ollama', JSON.stringify(ev.slice(0, 4)));
      assert.ok(reasons.includes('waiting_for_gpu'), reasons.join(','));
      assert.ok(ev.some((e) => e.type === 'done'), ev.map((e) => e.type).join(','));
      assert.equal(s.srv.core.ollamaProcess.sandboxed, true);
    } finally { await s.close(); }
  });

  test('osFallback and osPending are reported in GET /api/security and /api/system', async () => {
    resetFake();
    process.env.FAKE_SB_MODE = 'exit';
    const s = await stack({ autoStart: false, port: await freePort() });
    try {
      const st = await s.call('POST', '/api/providers/ollama/start', {});
      assert.equal(st.data.started, true);
      assert.equal(st.data.sandboxed, false);
      const sec = (await s.call('GET', '/api/security')).data.offlineLock;
      assert.equal(sec.osFallback.reason, 'sandboxed_exit');
      assert.equal(sec.osFallback.count, 1);
      assert.equal(sec.osPending, true, 'a retry inside the sandbox is still due');
      assert.equal(sec.osEnforced, false);
      const sys = (await s.call('GET', '/api/system')).data.ollama;
      assert.equal(sys.osFallback.reason, 'sandboxed_exit');
      assert.equal(sys.sandboxed, false);
    } finally { delete process.env.FAKE_SB_MODE; await s.close(); }
  });
});
