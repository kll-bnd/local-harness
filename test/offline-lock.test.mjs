// "Block all internet access" (docs/API.md §10.6): default on, the in-code blocker, the allow window and its
// automatic end, the OS sandbox around a managed Ollama (with a stand-in for /usr/bin/sandbox-exec), its silent
// fallback, the self-test, remote providers and fetch_url.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir, parseSse, waitFor } from './helpers.mjs';
import { startFakeOllama } from './fake-ollama.mjs';
import { startServer } from '../server/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.HARNESS_SELFTEST_INTERVAL_MS = '0';

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

/** A data dir in off mode (no password) with the blocker ON, as shipped. */
async function blockedStack({ settings = {}, fake } = {}) {
  const dataDir = await tmpDir('harness-net-');
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ ollama: { autoStart: false }, embeddings: { model: 'off' }, memory: { enabled: false }, titles: { auto: false }, ...(fake ? { providers: { builtin: { ollama: { baseUrl: fake.url } } } } : {}), ...settings }));
  const srv = await startServer({ port: 0, dataDir, autodetect: false, logLevel: 'silent', processGuards: false, keychain: 'file', security: { mode: 'off', apiAuth: false }, offlineLock: true });
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(srv.url + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
  };
  return { srv, dataDir, call, close: async () => { await srv.close(); await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {}); } };
}

describe('the blocker', () => {
  test('on by default; allow opens a time-boxed window that ends by itself; block ends it at once', async () => {
    const fake = await startFakeOllama({ port: 0, pullStepMs: 40 });
    const s = await blockedStack({ fake });
    try {
      const n = await s.call('GET', '/api/network');
      assert.deepEqual(n.data.offlineLock, { enabled: true, blocked: true, allowedUntil: null, waitingFor: null, osEnforced: false, osScope: 'none', externalOllama: true, osPending: false, osFallback: null });
      assert.equal(JSON.parse(fss.readFileSync(path.join(s.dataDir, 'launch.json'), 'utf8')).offlineLock, true);
      assert.equal((await s.call('POST', '/api/network/allow', { minutes: 0 })).status, 400);
      assert.equal((await s.call('POST', '/api/network/allow', { minutes: 121 })).status, 400);
      const a = await s.call('POST', '/api/network/allow', {});
      assert.equal(a.status, 200);
      const until = Date.parse(a.data.offlineLock.allowedUntil);
      assert.ok(until > Date.now() + 14 * 60000 && until < Date.now() + 15 * 60000 + 2000, 'default 15 minutes');
      assert.equal(a.data.restartRequired, false);
      assert.equal(JSON.parse(fss.readFileSync(path.join(s.dataDir, 'launch.json'), 'utf8')).offlineLockSuspendedUntil, a.data.offlineLock.allowedUntil);
      // the window ends by itself
      const net = s.srv.core.network;
      net.launch.set({ offlineLockSuspendedUntil: new Date(Date.now() + 80).toISOString() });
      net._arm();
      await waitFor(() => net.blocked && JSON.parse(fss.readFileSync(path.join(s.dataDir, 'launch.json'), 'utf8')).offlineLockSuspendedUntil === null, { timeout: 3000 });
      // a download started inside the window keeps it open until it ends (waitingFor), then blocking resumes
      await s.call('POST', '/api/network/allow', { minutes: 5 });
      const pullP = fetch(`${s.srv.url}/api/models/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama3.2:3b' }) }).then((r) => r.text());
      await waitFor(() => net.downloads.size > 0);
      net.launch.set({ offlineLockSuspendedUntil: new Date(Date.now() + 30).toISOString() });
      net._arm();
      await new Promise((r) => setTimeout(r, 80));
      const mid = (await s.call('GET', '/api/network')).data.offlineLock;
      if (net.downloads.size) { assert.equal(mid.waitingFor, 'model_download'); assert.equal(mid.blocked, false); }
      await pullP;
      assert.equal((await s.call('GET', '/api/network')).data.offlineLock.blocked, true);
      // turning the setting off needs the password when one exists (none here) and survives in launch.json
      const off = await s.call('PUT', '/api/network', { enabled: false });
      assert.equal(off.data.offlineLock.enabled, false);
      assert.equal(JSON.parse(fss.readFileSync(path.join(s.dataDir, 'launch.json'), 'utf8')).offlineLock, false);
      assert.equal((await s.call('PUT', '/api/network', { enabled: true })).data.offlineLock.blocked, true);
    } finally { await s.close(); await fake.close(); }
  });

  test('chat stays untouched; remote providers and fetch_url are refused with the allow hint; fetch_url is not even offered', async () => {
    const fake = await startFakeOllama({ port: 0 });
    const s = await blockedStack({
      fake,
      settings: { tools: { enabled: true, builtin: { fetch_url: true, calculate: true } }, providers: { builtin: { ollama: { baseUrl: fake.url } }, custom: [{ id: 'remote', name: 'Remote', kind: 'openai', baseUrl: 'https://api.remote.example/v1', apiKey: 'k', enabled: true }] } },
    });
    try {
      const c = await s.call('POST', '/api/chats', {});
      const res = await fetch(`${s.srv.url}/api/chats/${c.data.chat.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hello, see https://example.com' }) });
      const ev = parseSse(await res.text());
      assert.ok(ev.some((e) => e.type === 'done'), 'a local chat works while blocked');
      assert.ok(!ev.some((e) => e.type === 'notice' && /internet|offline/i.test(e.message || '')), 'no warnings in the chat');
      const tools = fake.chatRequests().at(-1).tools || [];
      assert.ok(tools.length > 0 && !tools.some((t) => t.function?.name === 'fetch_url'), 'fetch_url is not offered while blocked');
      const providers = (await s.call('GET', '/api/providers?refresh=1')).data.providers;
      const remote = providers.find((p) => p.id === 'remote');
      assert.equal(remote.status, 'unreachable');
      const c2 = await s.call('POST', '/api/chats', { settings: { model: { providerId: 'remote', model: 'gpt-x' } } });
      const r2 = await fetch(`${s.srv.url}/api/chats/${c2.data.chat.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hi' }) });
      const body = r2.headers.get('content-type')?.includes('json') ? await r2.json() : parseSse(await r2.text());
      const err = Array.isArray(body) ? body.find((e) => e.type === 'error') : body.error;
      assert.equal(err.code, 'offline_lock', JSON.stringify(body));
      assert.equal((err.details || {}).what, 'remote_provider');
      assert.equal(err.details.allow.label, 'Allow internet for 15 minutes');
      // a direct fetch_url call gets an error result, not a request
      const { BUILTIN_TOOLS } = await import('../server/tools/builtin.mjs');
      const fu = BUILTIN_TOOLS.find((t) => t.name === 'fetch_url');
      const out = await fu.run({ url: 'https://example.com/' }, { settings: {}, allowedUrls: new Set(['https://example.com/', 'https://example.com']) });
      assert.equal(out.isError, true);
      assert.equal(out.data.blocked, 'offline_lock');
    } finally { await s.close(); await fake.close(); }
  });
});

describe('offline_lock inside a stream', () => {
  test('a chat turn refused mid-stream carries the same details (what, host, allow) as the HTTP error, also on the stored message', async () => {
    const { setup } = await import('./helpers.mjs');
    const { OfflineLockError } = await import('../server/security/egress.mjs');
    const h = await setup();
    try {
      const sec = (await h.c.get('/api/security')).data;
      assert.equal(sec.passwordSet, false, 'off mode, never a password');
      const ollama = h.app.registry.ollama();
      const orig = ollama.chat;
      ollama.chat = async function* () { throw new OfflineLockError('remote_provider', 'api.remote.example'); };
      try {
        const c = await h.c.post('/api/chats', {});
        const r = await h.c.sse(`/api/chats/${c.data.chat.id}/messages`, { content: 'hi' });
        const err = r.events.find((e) => e.type === 'error');
        assert.ok(err, JSON.stringify(r.events.slice(-2)));
        assert.equal(err.code, 'offline_lock');
        assert.deepEqual(err.details, { what: 'remote_provider', host: 'api.remote.example', allow: { method: 'POST', path: '/api/network/allow', body: { minutes: 15 }, needsPassword: true, label: 'Allow internet for 15 minutes' } });
        const d = (await h.c.get(`/api/chats/${c.data.chat.id}`)).data;
        const asst = (Array.isArray(d.messages) ? d.messages : Object.values(d.messages)).find((m) => m.role === 'assistant');
        assert.equal(asst.errorCode, 'offline_lock');
        assert.deepEqual(asst.errorDetails, err.details);
      } finally { ollama.chat = orig; }
    } finally { await h.close(); }
  });
});

describe('the OS layer around a managed Ollama', () => {
  async function withSandbox(mode, fn) {
    const dir = await tmpDir('harness-sbx-');
    const log = path.join(dir, 'sandbox.log');
    const sbx = path.join(dir, 'sandbox-exec');
    // Stand-in for /usr/bin/sandbox-exec: logs its argv; "ok" runs the command unconfined (so the probe REACHES a
    // listener — like the draft profile that did not block TCP), "deny" answers the probe like a working sandbox,
    // "broken" fails to start anything.
    await fs.writeFile(sbx, `#!/bin/sh
echo "$@" >> "${log}"
[ "${mode}" = "broken" ] && exit 71
if [ "${mode}" = "deny" ] && [ "$4" = "-e" ]; then echo '{"tcp":{"ok":false,"code":"EPERM"},"tcp6":{"ok":false,"code":"EPERM"},"udp":{"ok":false,"code":"ECONNREFUSED"},"dns":{"ok":false,"code":"ENOTFOUND"}}'; exit 0; fi
shift 2
exec "$@"
`, { mode: 0o755 });
    const bin = path.join(dir, 'ollama');
    await fs.writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, 'fake-ollama-bin.mjs')}" "$@"\n`, { mode: 0o755 });
    const port = await freePort();
    const prev = process.env.HARNESS_SANDBOX_EXEC;
    process.env.HARNESS_SANDBOX_EXEC = sbx;
    let s;
    try {
      s = await blockedStack({ settings: { ollama: { autoStart: false, binaryPath: bin, stopOnExit: true }, providers: { builtin: { ollama: { baseUrl: `http://127.0.0.1:${port}` } } } } });
      await fn({ s, log: () => (fss.existsSync(log) ? fss.readFileSync(log, 'utf8').trim().split('\n') : []) });
    } finally {
      if (prev === undefined) delete process.env.HARNESS_SANDBOX_EXEC; else process.env.HARNESS_SANDBOX_EXEC = prev;
      await s?.close();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  test('blocked → ollama serve runs under sandbox-exec with the profile; allow / block restart it without / with it', async () => {
    await withSandbox('ok', async ({ s, log }) => {
      const st = await s.call('POST', '/api/providers/ollama/start');
      assert.equal(st.data.started, true, JSON.stringify(st.data));
      assert.equal(st.data.sandboxed, true);
      assert.match(log()[0], /^-f \S+server\/security\/offline-lock\.sb \S+ollama serve$/);
      let n = (await s.call('GET', '/api/network')).data.offlineLock;
      assert.equal(n.osScope, 'ollama');
      assert.equal(n.osEnforced, true);
      const pid1 = s.srv.core.ollamaProcess.child.pid;
      const a = await s.call('POST', '/api/network/allow', { minutes: 5 });
      assert.equal(a.data.offlineLock.osScope, 'none');
      assert.equal(s.srv.core.ollamaProcess.sandboxed, false);
      assert.notEqual(s.srv.core.ollamaProcess.child.pid, pid1, 'restarted for the allow action');
      assert.equal(log().length, 1, 'started without the sandbox this time');
      const b = await s.call('POST', '/api/network/block', {});
      assert.equal(b.data.offlineLock.osScope, 'ollama');
      assert.equal(log().length, 2);
      // a window that ends on its own while nothing runs: Ollama goes back into the sandbox by itself
      await s.call('POST', '/api/network/allow', { minutes: 5 });
      const pid2 = s.srv.core.ollamaProcess.child.pid;
      const netg = s.srv.core.network;
      netg.launch.set({ offlineLockSuspendedUntil: new Date(Date.now() + 50).toISOString() });
      netg._arm();
      await waitFor(() => netg.blocked);
      // (the restart is done once its start has finished, not when the child was spawned)
      await waitFor(() => s.srv.core.ollamaProcess.sandboxed && s.srv.core.ollamaProcess.child?.pid !== pid2 && !s.srv.core.ollamaProcess.starting && log().length === 3, { timeout: 15000 });
      n = (await s.call('GET', '/api/network')).data.offlineLock;
      assert.equal(n.osScope, 'ollama');
      assert.equal(n.osPending, false);
      // the self-test: a direct TCP connection from inside the sandbox reaches a listener → the OS layer does not hold
      const listener = net.createServer((c) => c.destroy());
      await new Promise((r) => listener.listen(0, '127.0.0.2', r).on('error', () => listener.listen(0, '127.0.0.1', r)));
      process.env.HARNESS_EGRESS_PROBE_TARGET = `${listener.address().address}:${listener.address().port}`;
      try {
        const t = await s.call('POST', '/api/network/test', {});
        assert.equal(t.status, 200, JSON.stringify(t.data));
        assert.ok(t.data.results.filter((r) => r.layer === 'code').every((r) => r.result === 'blocked'));
        const tcp = t.data.results.find((r) => r.layer === 'os' && r.target === `tcp ${process.env.HARNESS_EGRESS_PROBE_TARGET}`);
        assert.equal(tcp.result, 'reachable');
        assert.equal(t.data.osEnforced, false);
        assert.equal((await s.call('GET', '/api/network')).data.offlineLock.osEnforced, false, 'never claimed again after a failed probe');
      } finally { delete process.env.HARNESS_EGRESS_PROBE_TARGET; listener.close(); }
    });
  });

  test('a sandbox that blocks passes the self-test; a broken sandbox is skipped silently (osEnforced: false, chat works)', async () => {
    await withSandbox('deny', async ({ s }) => {
      await s.call('POST', '/api/providers/ollama/start');
      const t = await s.call('POST', '/api/network/test', {});
      const os = t.data.results.filter((r) => r.layer === 'os');
      assert.deepEqual(os.map((r) => r.result), ['blocked', 'blocked', 'blocked', 'blocked'], 'EPERM, EPERM, ECONNREFUSED (UDP), ENOTFOUND are what the proven profile answers');
      const listen = t.data.results.find((r) => r.layer === 'listen');
      if (process.platform === 'linux') assert.equal(listen.result, 'loopback', JSON.stringify(listen));
      assert.equal(t.data.osEnforced, true);
    });
    await withSandbox('broken', async ({ s, log }) => {
      const st = await s.call('POST', '/api/providers/ollama/start');
      assert.equal(st.data.started, true, JSON.stringify(st.data));
      assert.equal(st.data.sandboxed, false);
      assert.equal(log().length, 1, 'tried once');
      const n = (await s.call('GET', '/api/network')).data.offlineLock;
      assert.equal(n.osEnforced, false);
      assert.equal(n.blocked, true);
      const t = await s.call('POST', '/api/network/test', {});
      assert.equal(t.data.results.find((r) => r.layer === 'os').result, 'skipped');
    });
  });

  test('the self-test needs no session (it carries no user data) but keeps the Host check and a rate limit', async () => {
    process.env.HARNESS_SELFTEST_INTERVAL_MS = '60000';
    const dataDir = await tmpDir();
    const srv = await startServer({ port: 0, dataDir, autodetect: false, logLevel: 'silent', processGuards: false, keychain: 'file', security: { mode: 'password', apiAuth: true, kdf: { N: 1024, r: 8, p: 1 } }, offlineLock: true });
    try {
      const r = await fetch(`${srv.url}/api/network/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 200, 'works while Harness is still in needs_setup / locked');
      assert.equal((await r.json()).blocked, true);
      const again = await fetch(`${srv.url}/api/network/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(again.status, 429);
      const evil = await new Promise((resolve) => {
        const req = (http) => http.request({ host: '127.0.0.1', port: srv.port, path: '/api/network/test', method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }, (res) => resolve(res.statusCode));
        import('node:http').then(({ default: http }) => req(http).end('{}'));
      });
      assert.equal(evil, 403);
    } finally { process.env.HARNESS_SELFTEST_INTERVAL_MS = '0'; await srv.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
  });
});
