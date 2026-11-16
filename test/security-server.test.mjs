// 0.2 end to end over HTTP: password setup, sessions, locking, encryption at rest, migration, modes, key-store
// damage, idle lock, UI state, backups. Every server here runs with the SHIPPED defaults (explicit options
// override the opt-outs test/helpers.mjs sets for the other suites), with cheap scrypt parameters.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tmpDir, parseSse, GiB, waitFor } from './helpers.mjs';
import { startFakeOllama } from './fake-ollama.mjs';
import { startFakeA1111 } from './fake-a1111.mjs';
import { createFakeMemoryProbe } from './fake-memory-probe.mjs';
import { startServer } from '../server/index.mjs';
import { fileKeychain } from '../server/security/keychain.mjs';
import { encryptHXC } from '../server/security/crypto.mjs';
import { Vault } from '../server/security/vault.mjs';
import { egressBlocked } from '../server/security/egress.mjs';

const FAST = { N: 1024, r: 8, p: 1 };
const PW = 'correct horse battery';

/** Fake Ollama + a Harness with the real defaults. `dataDir` reuse keeps the (encrypted) data. */
async function stack({ dataDir, mode, apiAuth, offlineLock, keychain, settings = {}, fake: fakeIn, a1111 = false, prepare } = {}) {
  const fake = fakeIn || await startFakeOllama({ port: 0 });
  const fresh = !dataDir;
  dataDir ||= await tmpDir('harness-sec-');
  const dt = a1111 ? await startFakeA1111({ port: 0, stepMs: 4 }) : null;
  if (fresh) {
    const base = { providers: { builtin: { ollama: { baseUrl: fake.url } } }, memory: { extractDelayMs: 0, enabled: false }, embeddings: { model: 'off' }, ollama: { autoStart: false }, titles: { auto: false }, ...(dt ? { image: { custom: [{ id: 'dt', name: 'DT', kind: 'a1111', baseUrl: dt.url, enabled: true }] } } : {}), ...settings };
    await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify(base));
    await prepare?.(dataDir);
  }
  const srv = await startServer({
    port: 0, dataDir, autodetect: false, logLevel: 'silent', processGuards: false,
    system: { totalMem: 16 * GiB, memoryProbe: createFakeMemoryProbe(fake) },
    // mode 'launch': no override at all — launch.json is the only hint, as for the shipped launchers
    security: { kdf: FAST, ...(mode === 'launch' ? { mode: null } : mode ? { mode } : { mode: 'password' }), ...(apiAuth === undefined ? { apiAuth: true } : { apiAuth }) },
    offlineLock: offlineLock === undefined ? true : offlineLock,
    keychain: keychain || 'file', // never the real macOS Keychain from a test
  });
  const s = { srv, fake, dt, dataDir, url: srv.url, token: null };
  s.call = async (method, p, body, { headers = {}, token = s.token, raw = false } = {}) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    let b;
    if (body !== undefined) { if (Buffer.isBuffer(body)) b = body; else { b = JSON.stringify(body); h['content-type'] ||= 'application/json'; } }
    const res = await fetch(srv.url + p, { method, headers: h, body: b });
    const ct = res.headers.get('content-type') || '';
    const data = raw ? Buffer.from(await res.arrayBuffer()) : ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
  s.setup = async (password = PW) => {
    const r = await s.call('POST', '/api/security/setup', { password, session: 'token' }, { token: null });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    s.token = r.data.sessionToken;
    await waitFor(async () => (await s.call('GET', '/api/security')).data.state === 'unlocked', { timeout: 15000 });
    return r.data;
  };
  s.unlock = async (body = { password: PW }) => {
    const r = await s.call('POST', '/api/security/unlock', { session: 'token', ...body }, { token: null });
    if (r.status === 200) { s.token = r.data.sessionToken; await waitFor(async () => (await s.call('GET', '/api/security')).data.state === 'unlocked', { timeout: 15000 }); }
    return r;
  };
  s.close = async ({ keep = false } = {}) => {
    await srv.close();
    if (!fakeIn) await fake.close();
    await dt?.close();
    if (!keep) await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  };
  return s;
}

function filesUnder(dir) {
  const out = [];
  const walk = (d) => { for (const e of fss.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(f); } };
  walk(dir);
  return out;
}
const grepDir = (dir, needle) => filesUnder(dir).filter((f) => fss.readFileSync(f).includes(Buffer.from(needle)));

async function chatTurn(s, content) {
  const c = await s.call('POST', '/api/chats', {});
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const res = await fetch(`${s.url}/api/chats/${c.data.chat.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.token}` }, body: JSON.stringify({ content }) });
  return { chatId: c.data.chat.id, events: parseSse(await res.text()) };
}

describe('password setup and sessions', () => {
  test('first run: only the setup surface answers; setup gives a cookie (and a token only to a non-browser that asks)', async () => {
    const s = await stack();
    try {
      const sec = await s.call('GET', '/api/security');
      assert.equal(sec.data.state, 'needs_setup');
      assert.equal(sec.data.mode, 'password');
      assert.equal(sec.data.passwordSet, false);
      assert.equal(sec.data.session.authenticated, false);
      assert.equal(sec.data.offlineLock.blocked, true);
      assert.deepEqual((await s.call('GET', '/api/health')).data, { ok: true, name: 'harness', version: (await import('../server/version.mjs')).VERSION, state: 'needs_setup' });
      for (const p of ['/api/chats', '/api/settings', '/api/memories', '/api/ui-state', '/api/events', '/api/system', '/api/search?q=x']) {
        const r = await s.call('GET', p);
        assert.equal(r.status, 423, p);
        assert.equal(r.data.error.code, 'needs_setup', p);
      }
      assert.equal((await fetch(s.url + '/')).status, 200, 'the UI itself is served');
      assert.equal((await s.call('POST', '/api/security/setup', { password: 'short' })).data.error.code, 'weak_password');
      // a browser page can never get the token in a body
      const browser = await s.call('POST', '/api/security/setup', { password: PW, session: 'token' }, { headers: { origin: s.url } });
      assert.equal(browser.status, 403);
      assert.equal(browser.data.error.code, 'token_refused');
      const cookieOnly = await s.call('POST', '/api/security/setup', { password: PW });
      assert.equal(cookieOnly.status, 200, JSON.stringify(cookieOnly.data));
      assert.equal(cookieOnly.data.sessionToken, undefined, 'no token in the body for an ordinary (browser) setup');
      assert.match(cookieOnly.data.recoveryKey, /^HRK1(-[0-9A-HJKMNP-TV-Z]{4}){13}$/);
      const setCookie = cookieOnly.headers.get('set-cookie');
      assert.match(setCookie, /^harness_session=[\w-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200$/);
      const cookie = setCookie.split(';')[0];
      await waitFor(async () => (await s.call('GET', '/api/security')).data.state === 'unlocked', { timeout: 10000 });
      assert.equal((await s.call('GET', '/api/chats', undefined, { headers: { cookie } })).status, 200);
      assert.equal((await s.call('GET', '/api/security')).data.passwordSet, true);
      const again = await s.call('POST', '/api/security/setup', { password: PW });
      assert.equal(again.status, 409);
      // no session → 401 with the lock-screen hint; the cookie authorises GETs, SSE and files
      const no = await s.call('GET', '/api/chats');
      assert.equal(no.status, 401);
      assert.deepEqual(no.data.error.details, { reason: 'missing', unlock: true });
      assert.equal((await s.call('GET', '/api/chats', undefined, { headers: { cookie: 'harness_session=nope' } })).data.error.details.reason, 'invalid');
      assert.equal((await s.call('GET', '/api/security', undefined, { headers: { cookie } })).data.session.via, 'cookie');
      assert.ok(!fss.existsSync(path.join(s.dataDir, 'api-token')), 'no per-install secret in password mode');
      // a CLI session; logout invalidates the bearer token too
      const u = await s.call('POST', '/api/security/unlock', { password: PW, session: 'token' });
      assert.ok(u.data.sessionToken);
      assert.equal((await s.call('GET', '/api/chats', undefined, { token: u.data.sessionToken })).status, 200);
      assert.equal((await s.call('POST', '/api/auth/logout', {}, { token: u.data.sessionToken })).status, 200);
      assert.equal((await s.call('GET', '/api/chats', undefined, { token: u.data.sessionToken })).status, 401);
      assert.equal((await s.call('POST', '/api/auth/launch-code', {}, { headers: { cookie } })).data.error.code, 'password_mode');
      // every API answer is no-store
      assert.equal(sec.headers.get('cache-control'), 'no-store');
    } finally { await s.close(); }
  });

  test('wrong passwords: 3 free tries, then a growing wait that survives a restart; the recovery key resets the password', async () => {
    let s = await stack();
    const { recoveryKey } = await s.setup();
    try {
      assert.equal((await s.call('POST', '/api/security/lock', {})).data.state, 'locked');
      for (let i = 0; i < 2; i++) assert.equal((await s.unlock({ password: `wrong ${i}` })).data.error.code, 'wrong_password');
      const third = await s.unlock({ password: 'wrong 2' });
      assert.equal(third.status, 401);
      assert.equal(third.data.error.details.retryAfterMs, 1000, 'three free attempts, then 1 s before the 4th');
      const early = await s.unlock();
      assert.equal(early.status, 429);
      assert.equal(early.data.error.code, 'unlock_throttled');
      await s.close({ keep: true });
      s = await stack({ dataDir: s.dataDir });
      const st = await s.call('GET', '/api/security');
      assert.equal(st.data.state, 'locked');
      assert.equal(st.data.unlock.failedAttempts, 3);
      assert.ok(st.data.unlock.retryAfterMs > 0 || (await s.unlock()).status === 200);
      await new Promise((r) => setTimeout(r, st.data.unlock.retryAfterMs + 50));
      const rk = await s.unlock({ recoveryKey: recoveryKey.toLowerCase().replace(/-/g, ' ') });
      assert.equal(rk.status, 200, JSON.stringify(rk.data));
      assert.ok(rk.data.passwordReset?.until);
      assert.equal((await s.call('GET', '/api/security')).data.unlock.failedAttempts, 0);
      assert.equal((await s.call('POST', '/api/security/password', { newPassword: 'a brand new one' })).status, 200, 'inside the reset window no old password is needed');
      await s.call('POST', '/api/security/lock', {});
      assert.equal((await s.unlock()).data.error.code, 'wrong_password');
      assert.equal((await s.unlock({ password: 'a brand new one' })).status, 200);
    } finally { await s.close(); }
  });
});

describe('unlock throttle under concurrency (review 02)', () => {
  test('40 simultaneous guesses: only the 3 free ones reach the key derivation; after the wait, one more', async () => {
    const s = await stack();
    await s.setup();
    try {
      await s.call('POST', '/api/security/lock', {});
      const guess = (pw) => fetch(`${s.url}/api/security/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
      const r1 = await Promise.all(Array.from({ length: 40 }, (_, i) => guess(`wrong-${i}`)));
      assert.equal(r1.filter((r) => r.status === 401).length, 3, 'checked against the password');
      assert.equal(r1.filter((r) => r.status === 429).length, 37, 'refused without a key derivation');
      const st = (await s.call('GET', '/api/security')).data.unlock;
      assert.equal(st.failedAttempts, 3);
      await new Promise((r) => setTimeout(r, st.retryAfterMs + 100));
      const r2 = await Promise.all(Array.from({ length: 40 }, (_, i) => guess(`again-${i}`)));
      assert.equal(r2.filter((r) => r.status === 401).length, 1, 'one guess per window');
      assert.ok(r2.filter((r) => r.status === 429).every((r) => r.body.error.details.retryAfterMs > 0));
    } finally { await s.close(); }
  });
});

describe('encryption at rest and locking', () => {
  test('a chat is unreadable on disk; files 0600, folder 0700; changing the password re-encrypts nothing', async () => {
    const s = await stack();
    await s.setup();
    try {
      const marker = 'ZEBRA-MARKER-4711';
      const t = await chatTurn(s, `Please remember ${marker}.`);
      assert.ok(t.events.some((e) => e.type === 'done'), JSON.stringify(t.events.slice(-2)));
      assert.equal((await s.call('PUT', '/api/ui-state', { state: { [`draft:${t.chatId}`]: `${marker} draft` } })).status, 200);
      const up = await s.call('POST', `/api/attachments?name=${encodeURIComponent(`${marker}.txt`)}`, Buffer.from(`file body ${marker}`), { headers: { 'content-type': 'text/plain' } });
      assert.equal(up.status, 201, JSON.stringify(up.data));
      const c = await s.call('GET', `/api/attachments/${up.data.attachment.id}/content`, undefined, { raw: true });
      assert.equal(c.data.toString(), `file body ${marker}`);
      assert.equal(c.headers.get('cache-control'), 'no-store');
      await s.srv.app.chats.flush();
      const { flushWrites } = await import('../server/lib/fsx.mjs');
      await flushWrites();
      assert.deepEqual(grepDir(s.dataDir, marker), []);
      assert.deepEqual(grepDir(s.dataDir, 'remember'), []);
      assert.equal(fss.statSync(s.dataDir).mode & 0o777, 0o700);
      for (const f of filesUnder(s.dataDir)) assert.equal(fss.statSync(f).mode & 0o777, 0o600, f);
      const before = new Map(filesUnder(s.dataDir).filter((f) => !/vault|launch|harness\.lock|measurements/.test(f)).map((f) => [f, fss.readFileSync(f)]));
      assert.equal((await s.call('POST', '/api/security/password', { password: PW, newPassword: 'another password' })).status, 200);
      for (const [f, b] of before) assert.deepEqual(fss.readFileSync(f), b, `${path.basename(f)} unchanged by a password change`);
    } finally { await s.close(); }
  });

  test('locking: everything user-derived answers 423, the event stream ends, a streaming reply is stopped and kept, models are unloaded', async () => {
    const s = await stack();
    await s.setup();
    try {
      s.fake.setDelay(15);
      s.fake.chatScript = () => ({ thinking: '', content: 'word '.repeat(400), toolCalls: [] });
      const c = await s.call('POST', '/api/chats', {});
      const chatId = c.data.chat.id;
      const up = await s.call('POST', '/api/attachments?name=a.txt', Buffer.from('hello'), { headers: { 'content-type': 'text/plain' } });
      const events = fetch(`${s.url}/api/events`, { headers: { authorization: `Bearer ${s.token}` } }).then((r) => r.text());
      const gen = fetch(`${s.url}/api/chats/${chatId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.token}` }, body: JSON.stringify({ content: 'go' }) }).then((r) => r.text());
      await waitFor(() => s.srv.app?.engine.active.size > 0);
      await new Promise((r) => setTimeout(r, 150));
      const lockedEvents = [];
      s.srv.on('locked', (e) => lockedEvents.push(e));
      const lk = await s.call('POST', '/api/security/lock', {});
      assert.equal(lk.status, 200);
      assert.equal(lk.data.state, 'locked');
      assert.deepEqual(lockedEvents.map((e) => e.reason), ['user']);
      const turn = parseSse(await gen);
      assert.ok(turn.some((e) => e.type === 'done' || e.type === 'error'), 'the reply stream ended');
      const ev = parseSse(await events);
      assert.equal(ev.at(-1).type, 'locked', 'the global stream ends with a final locked event');
      assert.ok(s.fake.unloads.length >= 1, 'the model Harness loaded was unloaded');
      const token = s.token;
      for (const p of ['/api/chats', `/api/chats/${chatId}`, '/api/memories', '/api/ui-state', '/api/events', '/api/system', '/api/search?q=word', `/api/attachments/${up.data.attachment.id}/content`, '/api/images', '/api/settings', '/api/network']) {
        const r = await s.call('GET', p, undefined, { token });
        assert.equal(r.status, 423, p);
        assert.equal(r.data.error.code, 'locked', p);
      }
      assert.equal(s.srv.app, null, 'no app (no open stores) while locked');
      assert.equal((await s.call('GET', '/api/security')).data.offlineLock.externalOllama, true, 'a foreign Ollama is reported while locked too');
      assert.equal(s.srv.security.state, 'locked');
      assert.throws(() => s.srv.auth.createSession(), (e) => e.status === 423);
      assert.equal((await s.unlock()).status, 200);
      const back = await s.call('GET', `/api/chats/${chatId}`);
      const msgs = (Array.isArray(back.data.messages) ? back.data.messages : Object.values(back.data.messages)).filter((m) => m.role === 'assistant');
      assert.ok(msgs.length === 1 && msgs[0].content.length > 0 && msgs[0].content.length < 'word '.repeat(400).length, 'the partial reply was kept');
      assert.equal((await s.call('GET', '/api/chats', undefined, { token })).status, 401, 'sessions from before the lock are gone');
      const session = s.srv.auth.createSession();
      assert.equal((await s.call('GET', '/api/chats', undefined, { token: null, headers: { cookie: `${session.name}=${session.value}` } })).status, 200);
    } finally { await s.close(); }
  });

  test('idle lock: an open event stream does not hold it; a running reply defers it; the activity route reports idleLockAt', async () => {
    const s = await stack();
    await s.setup();
    try {
      const core = s.srv.core;
      const ac = new AbortController();
      const events = fetch(`${s.url}/api/events`, { headers: { authorization: `Bearer ${s.token}` }, signal: ac.signal }).then((r) => r.text()).catch(() => '');
      await new Promise((r) => setTimeout(r, 100));
      const a = await s.call('POST', '/api/security/activity', {});
      assert.equal(a.status, 200);
      const at = Date.parse(a.data.idleLockAt);
      assert.ok(at > Date.now() + 14 * 60000 && at <= Date.now() + 15 * 60000 + 1000, a.data.idleLockAt);
      assert.equal((await s.call('GET', '/api/security')).data.idleLockAt !== null, true);
      // a running generation defers the lock
      s.fake.setDelay(20);
      s.fake.chatScript = () => ({ thinking: '', content: 'word '.repeat(200), toolCalls: [] });
      const c = await s.call('POST', '/api/chats', {});
      const gen = fetch(`${s.url}/api/chats/${c.data.chat.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.token}` }, body: JSON.stringify({ content: 'go' }) }).then((r) => r.text());
      await waitFor(() => core.app?.engine.active.size > 0);
      core.lastActivity = Date.now() - 16 * 60000;
      core._checkIdle();
      assert.equal(core.state, 'unlocked', 'a running reply holds the lock open');
      assert.equal(core.idleLockAt(), null);
      await gen;
      // with only the event stream open, an idle core locks
      core.lastActivity = Date.now() - 16 * 60000;
      core._checkIdle();
      await waitFor(() => core.state === 'locked');
      const ev = parseSse(await events);
      assert.equal(ev.at(-1)?.type, 'locked');
      assert.equal((await s.call('POST', '/api/security/activity', {})).status, 423);
      ac.abort();
    } finally { await s.close(); }
  });
});

describe('upgrades, modes and key-store damage', () => {
  test('0.1 data: needs_setup with plainDataFound → setup encrypts it (migrating → unlocked, no locked moment) → readable', async () => {
    const legacy = await tmpDir('harness-legacy-');
    const fake = await startFakeOllama({ port: 0 });
    let s = await stack({ dataDir: legacy, mode: 'off', apiAuth: false, offlineLock: false, fake });
    await fs.writeFile(path.join(legacy, 'settings.json'), JSON.stringify({ providers: { builtin: { ollama: { baseUrl: fake.url } } }, ollama: { autoStart: false }, embeddings: { model: 'off' }, memory: { enabled: false }, titles: { auto: false } })).catch(() => {});
    const marker = 'LEGACY-MARKER-99';
    for (let i = 0; i < 5; i++) {
      const c = await s.call('POST', '/api/chats', { title: `${marker} ${i}` });
      assert.equal(c.status, 201);
    }
    await s.close({ keep: true });
    assert.ok(grepDir(legacy, marker).length >= 5, 'plain before');
    s = await stack({ dataDir: legacy, fake });
    try {
      const sec = await s.call('GET', '/api/security');
      assert.equal(sec.data.state, 'needs_setup');
      assert.equal(sec.data.plainDataFound, true);
      const states = [];
      s.srv.on('state', (e) => states.push(e.state));
      const r = await s.call('POST', '/api/security/setup', { password: PW, session: 'token' });
      assert.equal(r.status, 200);
      s.token = r.data.sessionToken;
      await waitFor(async () => (await s.call('GET', '/api/security')).data.state === 'unlocked', { timeout: 15000 });
      assert.ok(!states.includes('locked'), `direct transition: ${states.join(' → ')}`);
      assert.equal(states.at(-1), 'unlocked');
      const chats = await s.call('GET', '/api/chats');
      assert.equal(chats.data.chats.filter((c) => c.title?.startsWith(marker)).length, 5);
      assert.deepEqual(grepDir(legacy, marker), []);
      // a crash during a conversion: half the files plain again, migration recorded → resumed after unlocking
      await s.close({ keep: true });
      const vault = JSON.parse(fss.readFileSync(path.join(legacy, 'vault.json'), 'utf8'));
      vault.migration = { op: 'encrypt', done: 2, total: 9, startedAt: new Date().toISOString(), error: null };
      fss.writeFileSync(path.join(legacy, 'vault.json'), JSON.stringify(vault));
      fss.writeFileSync(path.join(legacy, 'vault.json.bak'), JSON.stringify(vault));
      fss.writeFileSync(path.join(legacy, 'chats', 'plain-left-over.json.tmp'), 'junk');
      s = await stack({ dataDir: legacy, fake });
      assert.equal((await s.call('GET', '/api/security')).data.state, 'locked');
      assert.equal((await s.unlock()).status, 200);
      assert.equal((await s.call('GET', '/api/security')).data.migration, null);
    } finally { await s.close(); await fake.close(); }
  });

  test('off and back: decrypting and re-encrypting are password-confirmed, update launch.json, keep the data', async () => {
    const s = await stack();
    await s.setup();
    try {
      await s.call('POST', '/api/chats', { title: 'MODE-MARKER' });
      const no = await s.call('POST', '/api/security/mode', { mode: 'off' });
      assert.equal(no.status, 403);
      assert.equal(no.data.error.code, 'confirmation_required');
      assert.equal((await s.call('POST', '/api/security/mode', { mode: 'off', password: 'wrong wrong' })).data.error.code, 'wrong_password');
      const off = await s.call('POST', '/api/security/mode', { mode: 'off', password: PW });
      assert.equal(off.status, 200, JSON.stringify(off.data));
      await waitFor(async () => (await s.call('GET', '/api/security')).data.state === 'unlocked', { timeout: 15000 });
      assert.equal(JSON.parse(fss.readFileSync(path.join(s.dataDir, 'launch.json'), 'utf8')).encryption, 'off');
      assert.ok(grepDir(s.dataDir, 'MODE-MARKER').length >= 1, 'plain now');
      assert.ok(fss.existsSync(path.join(s.dataDir, 'api-token')), 'off mode uses the per-install secret');
      assert.equal((await s.call('GET', '/api/security')).data.passwordSet, true, 'off mode with a password kept for confirmations');
      assert.equal((await s.call('POST', '/api/security/lock', {})).data.error.code, 'not_encrypted');
      // the password still guards lowering actions in off mode
      assert.equal((await s.call('POST', '/api/network/allow', {})).data.error.code, 'confirmation_required');
      const on = await s.call('POST', '/api/security/mode', { mode: 'password', password: PW });
      assert.equal(on.status, 200, JSON.stringify(on.data));
      await waitFor(async () => (await s.call('GET', '/api/security')).data.state === 'unlocked', { timeout: 15000 });
      assert.deepEqual(grepDir(s.dataDir, 'MODE-MARKER'), []);
      assert.equal((await s.call('GET', '/api/chats')).data.chats.some((c) => c.title === 'MODE-MARKER'), true);
    } finally { await s.close(); }
  });

  test('keychain mode: opens without a prompt; {} unlock needs access; a wrong key leaves it locked; re-keying re-encrypts everything', async () => {
    let s = await stack();
    const { recoveryKey } = await s.setup();
    const dataDir = s.dataDir;
    try {
      await s.call('POST', '/api/chats', { title: 'KC-MARKER' });
      const kc = await s.call('POST', '/api/security/mode', { mode: 'keychain', password: PW });
      assert.equal(kc.status, 200, JSON.stringify(kc.data));
      assert.equal(JSON.parse(fss.readFileSync(path.join(dataDir, 'launch.json'), 'utf8')).encryption, 'keychain');
      assert.ok(fss.existsSync(path.join(dataDir, '.dev-keychain')));
      await s.close({ keep: true });
      s = await stack({ dataDir, mode: 'keychain' });
      assert.equal((await s.call('GET', '/api/security')).data.state, 'unlocked', 'opened with the Keychain key, no prompt');
      const token = fss.readFileSync(path.join(dataDir, 'api-token'), 'utf8').trim();
      const lc = await s.call('POST', '/api/auth/launch-code', {}, { token });
      assert.match(lc.data.url, /\/#launch=[\w-]{43}$/);
      const sess = await s.call('POST', '/api/auth/session', { code: lc.data.code }, { token: null });
      assert.match(sess.headers.get('set-cookie'), /^harness_session=/);
      assert.equal((await s.call('POST', '/api/auth/session', { code: lc.data.code }, { token: null })).status, 401, 'one use');
      await s.call('POST', '/api/security/lock', {}, { token });
      assert.equal((await s.call('POST', '/api/security/unlock', {}, { token: null })).status, 401, 'keychain {} needs access');
      assert.equal((await s.call('POST', '/api/security/unlock', {}, { token })).status, 200);
      await s.close({ keep: true });
      // a different key in the Keychain: stays locked, says why, the password still works, nothing changed
      const before = new Map(filesUnder(dataDir).filter((f) => f.includes('chats')).map((f) => [f, fss.readFileSync(f)]));
      const wrong = fileKeychain(await tmpDir());
      await wrong.set(Buffer.alloc(32, 7));
      s = await stack({ dataDir, mode: 'keychain', keychain: wrong });
      const st = await s.call('GET', '/api/security');
      assert.equal(st.data.state, 'locked');
      assert.equal(st.data.unlock.keychainError.code, 'wrong_key');
      for (const [f, b] of before) assert.deepEqual(fss.readFileSync(f), b);
      assert.equal((await s.unlock()).status, 200);
      // leaving keychain mode recommends re-keying; re-keying gives a new recovery key and re-encrypts every file
      const leave = await s.call('POST', '/api/security/mode', { mode: 'password', password: PW });
      assert.equal(leave.data.rekeyRecommended, true);
      const rk = await s.call('POST', '/api/security/rekey', { password: PW });
      assert.equal(rk.status, 200, JSON.stringify(rk.data));
      assert.notEqual(rk.data.recoveryKey, recoveryKey);
      await waitFor(async () => (await s.call('GET', '/api/security')).data.state === 'unlocked', { timeout: 15000 });
      for (const [f, b] of before) if (fss.existsSync(f)) assert.notDeepEqual(fss.readFileSync(f), b, 're-encrypted under the new key');
      assert.ok((await s.call('GET', '/api/chats')).data.chats.some((c) => c.title === 'KC-MARKER'));
      await s.call('POST', '/api/security/lock', {});
      assert.equal((await s.unlock({ recoveryKey })).data.error.code, 'wrong_recovery_key', 'the old recovery key no longer opens anything');
      assert.equal((await s.unlock({ recoveryKey: rk.data.recoveryKey })).status, 200);
    } finally { await s.close(); }
  });

  test('a damaged key store is never mistaken for a fresh install', async () => {
    let s = await stack();
    await s.setup();
    const dataDir = s.dataDir;
    await s.call('POST', '/api/chats', { title: 'x' });
    await s.close({ keep: true });
    try {
      const good = fss.readFileSync(path.join(dataDir, 'vault.json'), 'utf8');
      fss.writeFileSync(path.join(dataDir, 'vault.json'), '{oops');
      s = await stack({ dataDir });
      assert.equal((await s.call('GET', '/api/security')).data.state, 'locked', 'restored from vault.json.bak');
      assert.equal((await s.unlock()).status, 200);
      await s.close({ keep: true });
      fss.writeFileSync(path.join(dataDir, 'vault.json'), '{oops');
      fss.writeFileSync(path.join(dataDir, 'vault.json.bak'), good.slice(0, 50));
      s = await stack({ dataDir });
      let st = await s.call('GET', '/api/security');
      assert.equal(st.data.state, 'error');
      assert.equal(st.data.error.code, 'vault_corrupt');
      assert.equal((await s.call('POST', '/api/security/setup', { password: PW })).data.error.code, 'vault_corrupt');
      assert.equal((await s.call('GET', '/api/chats')).status, 503);
      await s.close({ keep: true });
      fss.rmSync(path.join(dataDir, 'vault.json'));
      fss.rmSync(path.join(dataDir, 'vault.json.bak'));
      s = await stack({ dataDir });
      st = await s.call('GET', '/api/security');
      assert.equal(st.data.state, 'error');
      assert.equal(st.data.error.code, 'vault_missing');
      assert.equal((await s.call('POST', '/api/security/setup', { password: PW })).status, 409);
      assert.ok(!fss.existsSync(path.join(dataDir, 'vault.json')), 'nothing was created over the encrypted files');
    } finally { await s.close(); }
  });
});

describe('Keychain items that are not ours', () => {
  /** A recording stand-in store: `value` is what "the Keychain" holds; `fail` makes every read throw. */
  const recorder = (value = null, fail = null) => {
    const calls = [];
    return {
      kind: 'test', calls, value,
      async get() { calls.push('get'); if (fail) { const { KeychainError } = await import('../server/security/keychain.mjs'); throw new KeychainError(fail, `test: ${fail}`); } return this.value ? Buffer.from(this.value) : null; },
      async set(k) { calls.push('set'); this.value = Buffer.from(k); },
      async delete() { calls.push('delete'); this.value = null; },
    };
  };

  test('a foreign item is never overwritten without the password, never deleted on a failed read, and only ours is deleted', async () => {
    const foreign = Buffer.alloc(32, 5);
    const kc = recorder(foreign);
    let s = await stack({ mode: 'keychain', keychain: kc, prepare: (dir) => fss.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify({ version: 1, encryption: 'keychain' })) });
    const dataDir = s.dataDir;
    try {
      await s.setup();
      const st = (await s.call('GET', '/api/security')).data;
      assert.equal(st.mode, 'password', 'setup without a confirmation falls back to password mode');
      assert.equal(st.unlock.keychainError.code, 'keychain_item_exists');
      assert.ok(!kc.calls.includes('set') && !kc.calls.includes('delete'));
      assert.deepEqual(kc.value, foreign, 'the foreign item is untouched');
      // with the password typed for this action, replacing it is the user's explicit choice
      assert.equal((await s.call('POST', '/api/security/mode', { mode: 'keychain', password: PW })).status, 200);
      assert.ok(kc.calls.includes('set'));
      assert.notDeepEqual(kc.value, foreign);
      // leaving keychain mode (password-confirmed) deletes the item only because it holds THIS data's key
      assert.equal((await s.call('POST', '/api/security/mode', { mode: 'password', password: PW })).status, 200);
      assert.equal(kc.calls.filter((c) => c === 'delete').length, 1);
      // a foreign item at that moment would be left alone
      await s.call('POST', '/api/security/mode', { mode: 'keychain', password: PW });
      kc.value = Buffer.alloc(32, 6);
      const before = kc.calls.filter((c) => c === 'delete').length;
      await s.call('POST', '/api/security/mode', { mode: 'password', password: PW });
      assert.equal(kc.calls.filter((c) => c === 'delete').length, before, 'not ours: not deleted');
      await s.call('POST', '/api/security/mode', { mode: 'keychain', password: PW });
      await s.close({ keep: true });
      // a Keychain that cannot be read: locked, nothing deleted or written
      const broken = recorder(null, 'denied');
      s = await stack({ dataDir, mode: 'keychain', keychain: broken });
      const st2 = (await s.call('GET', '/api/security')).data;
      assert.equal(st2.state, 'locked');
      assert.equal(st2.unlock.keychainError.code, 'keychain_unavailable');
      assert.deepEqual(broken.calls, ['get']);
      assert.equal((await s.unlock()).status, 200, 'the password still opens it');
      assert.deepEqual(broken.calls, ['get']);
    } finally { await s.close(); }
  });
});

describe('files the backend does not own', () => {
  test('launcher files (desktop.json, native/, Electron/) are never encrypted, chmod-ed or counted; an earlier build\'s mistake is repaired', async () => {
    const fresh = await tmpDir('harness-own-');
    fss.writeFileSync(path.join(fresh, 'desktop.json'), '{"window":{"w":1200}}');
    const probe = await stack({ dataDir: fresh });
    try {
      const st = (await probe.call('GET', '/api/security')).data;
      assert.equal(st.state, 'needs_setup');
      assert.equal(st.plainDataFound, false, 'a launcher\'s desktop.json is not 0.1 data');
    } finally { await probe.close(); }
    const launcher = {
      'desktop.json': '{"window":{"w":1200}}',
      'native/window-state.json': '{"x":1}',
      'native/app.lock': '4242',
      'Electron/Local Storage/leveldb/000003.log': 'chromium bytes',
      'Electron/window-state.json': '{"y":2}',
    };
    const s = await stack({
      prepare: async (dir) => {
        for (const [rel, text] of Object.entries(launcher)) { fss.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fss.writeFileSync(path.join(dir, rel), text, { mode: 0o644 }); }
      },
    });
    try {
      await s.setup();
      await s.call('POST', '/api/chats', { title: 'owned' });
      await s.srv.app.chats.flush();
      for (const [rel, text] of Object.entries(launcher)) {
        assert.equal(fss.readFileSync(path.join(s.dataDir, rel), 'utf8'), text, `${rel} untouched`);
        assert.equal(fss.statSync(path.join(s.dataDir, rel)).mode & 0o777, 0o644, `${rel} permissions untouched`);
      }
      // what an earlier 0.2 build did: encrypt a launcher file → decrypted back in place at the next unlock
      fss.writeFileSync(path.join(s.dataDir, 'desktop.json'), encryptHXC(s.srv.core.vault.dek, Buffer.from(launcher['desktop.json'])));
      fss.writeFileSync(path.join(s.dataDir, 'native/window-state.json'), encryptHXC(s.srv.core.vault.dek, Buffer.from(launcher['native/window-state.json'])));
      await s.call('POST', '/api/security/lock', {});
      assert.equal((await s.unlock()).status, 200);
      assert.equal(fss.readFileSync(path.join(s.dataDir, 'desktop.json'), 'utf8'), launcher['desktop.json']);
      assert.equal(fss.readFileSync(path.join(s.dataDir, 'native/window-state.json'), 'utf8'), launcher['native/window-state.json']);
      // switching encryption off leaves them alone too
      assert.equal((await s.call('POST', '/api/security/mode', { mode: 'off', password: PW })).status, 200);
      await waitFor(async () => (await s.call('GET', '/api/security')).data.state === 'unlocked', { timeout: 15000 });
      for (const [rel, text] of Object.entries(launcher)) assert.equal(fss.readFileSync(path.join(s.dataDir, rel), 'utf8'), text);
    } finally { await s.close(); }
  });
});

describe('UI state and backups', () => {
  test('UI state: GET/PUT/PATCH, encrypted on disk, 1 MiB cap', async () => {
    const s = await stack();
    await s.setup();
    try {
      assert.deepEqual((await s.call('GET', '/api/ui-state')).data, { state: {}, updatedAt: null });
      assert.equal((await s.call('PUT', '/api/ui-state', { state: { a: 1, 'draft:c1': 'UI-MARKER' } })).status, 200);
      const p = await s.call('PATCH', '/api/ui-state', { set: { b: 2 }, remove: ['a'] });
      assert.ok(p.data.updatedAt);
      assert.deepEqual((await s.call('GET', '/api/ui-state')).data.state, { 'draft:c1': 'UI-MARKER', b: 2 });
      assert.deepEqual(grepDir(s.dataDir, 'UI-MARKER'), []);
      assert.equal((await s.call('PUT', '/api/ui-state', { state: { big: 'x'.repeat(1.2 * 1024 * 1024) } })).status, 413);
      assert.equal((await s.call('PUT', '/api/ui-state', { state: [1] })).status, 400);
    } finally { await s.close(); }
  });

  test('backups: GET needs a confirmation; POST gives plain or passphrase-encrypted; restore needs a confirmation; import opens either', async () => {
    const s = await stack();
    await s.setup();
    try {
      await s.call('POST', '/api/chats', { title: 'BACKUP-MARKER' });
      assert.equal((await s.call('GET', '/api/export')).data.error.code, 'confirmation_required');
      assert.equal((await s.call('POST', '/api/export', { passphrase: null })).data.error.code, 'confirmation_required');
      const plain = await s.call('POST', '/api/export', { password: PW, passphrase: null });
      assert.equal(plain.status, 200);
      assert.equal(plain.data.format, 'harness.backup');
      assert.match(plain.headers.get('content-disposition'), /harness-backup-.*\.json/);
      const enc = await s.call('POST', '/api/export', { password: PW, passphrase: 'backup passphrase' });
      assert.equal(enc.data.format, 'harness.backup.encrypted');
      assert.ok(!JSON.stringify(enc.data).includes('BACKUP-MARKER'));
      const conf = await s.call('POST', '/api/security/confirm', { password: PW });
      const viaGet = await s.call('GET', '/api/export', undefined, { headers: { 'x-harness-confirm': conf.data.confirmation } });
      assert.equal(viaGet.status, 200);
      assert.equal((await s.call('GET', '/api/export', undefined, { headers: { 'x-harness-confirm': conf.data.confirmation } })).data.error.code, 'wrong_password', 'single use');
      // import: encrypted needs the passphrase header
      assert.equal((await s.call('POST', '/api/chats/import', enc.data)).data.error.code, 'encrypted_backup');
      assert.equal((await s.call('POST', '/api/chats/import', enc.data, { headers: { 'x-harness-backup-passphrase': Buffer.from('nope nope').toString('base64url') } })).data.error.code, 'wrong_passphrase');
      const imp = await s.call('POST', '/api/chats/import', enc.data, { headers: { 'x-harness-backup-passphrase': Buffer.from('backup passphrase').toString('base64url') } });
      assert.equal(imp.status, 201, JSON.stringify(imp.data));
      // restore over existing data: confirmation required
      assert.equal((await s.call('POST', '/api/restore', plain.data)).data.error.code, 'confirmation_required');
      const c2 = await s.call('POST', '/api/security/confirm', { password: PW });
      const rest = await s.call('POST', '/api/restore', plain.data, { headers: { 'x-harness-confirm': c2.data.confirmation } });
      assert.equal(rest.status, 201, JSON.stringify(rest.data));
    } finally { await s.close(); }
  });

  test('images through a secure stack: the file URL needs a session and answers no-store', async () => {
    const s = await stack({ a1111: true });
    await s.setup();
    try {
      const r = await fetch(`${s.url}/api/images/generate`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.token}` }, body: JSON.stringify({ providerId: 'dt', prompt: 'IMG-MARKER lighthouse', seed: 1 }) });
      const ev = parseSse(await r.text());
      const done = ev.find((e) => e.type === 'done');
      assert.ok(done, JSON.stringify(ev.slice(-2)));
      const id = done.images?.[0]?.id || done.image?.id || (await s.call('GET', '/api/images')).data.images[0].id;
      const f = await s.call('GET', `/api/images/${id}/file`, undefined, { raw: true });
      assert.equal(f.status, 200);
      assert.equal(f.headers.get('cache-control'), 'no-store');
      assert.equal(f.data.subarray(1, 4).toString(), 'PNG');
      assert.equal((await s.call('GET', `/api/images/${id}/file`, undefined, { token: null })).status, 401);
      await s.srv.app.chats.flush();
      assert.deepEqual(grepDir(s.dataDir, 'IMG-MARKER'), []);
      assert.ok(!filesUnder(s.dataDir).some((f) => fss.readFileSync(f).subarray(1, 4).toString() === 'PNG'), 'no PNG lies on disk in the clear');
    } finally { await s.close(); }
  });

  test('a file from another key is reported, not moved aside or rewritten', async () => {
    const s = await stack();
    await s.setup();
    try {
      const c = await s.call('POST', '/api/chats', { title: 'k' });
      await s.srv.app.chats.flush();
      const other = encryptHXC(Buffer.alloc(32, 9), Buffer.from('{"x":1}'));
      const f = path.join(s.dataDir, 'presets.json');
      fss.writeFileSync(f, other);
      const { readJson } = await import('../server/lib/fsx.mjs');
      await assert.rejects(readJson(f), (e) => e.code === 'wrong_key');
      assert.deepEqual(fss.readFileSync(f), other);
      assert.ok(c.status === 201);
    } finally { await s.close(); }
  });
});

// Review 02, findings F1/F2: files that are not authenticated (launch.json, the plain fields of vault.json) may only
// make Harness MORE protective. What lowers protection comes from the password in this process or from the security
// record sealed under the data key (docs/API.md §10.2).
describe('plain files cannot lower protection (review 01, 05, 06)', () => {
  const readJ = (dir, f) => JSON.parse(fss.readFileSync(path.join(dir, f), 'utf8'));
  const writeVault = (dir, v) => { for (const f of ['vault.json', 'vault.json.bak']) fss.writeFileSync(path.join(dir, f), JSON.stringify(v, null, 2)); };
  const editLaunch = (dir, patch) => fss.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify({ ...readJ(dir, 'launch.json'), ...patch }));
  const sec = async (s) => (await s.call('GET', '/api/security')).data;
  const stopper = (dir) => { const f = path.join(dir, 'chats', 'zzzz-stopper.json'); fss.writeFileSync(f, encryptHXC(Buffer.alloc(32, 9), Buffer.from('{}'))); return f; };

  test('review 01: a decryption written into vault.json by hand is not run — the data stays encrypted and lockable; reported until dismissed', async () => {
    let s = await stack();
    await s.setup();
    const dataDir = s.dataDir;
    try {
      await s.call('POST', '/api/chats', { title: 'TAMPER-01-MARKER' });
      await s.call('POST', '/api/memories', { content: 'TAMPER-01-MEMORY' });
      await s.close({ keep: true });
      const v = readJ(dataDir, 'vault.json');
      v.migration = { op: 'decrypt', done: 0, total: 0, startedAt: new Date().toISOString(), error: null };
      v.encrypted = false;
      writeVault(dataDir, v);
      s = await stack({ dataDir, mode: 'launch' });
      assert.equal((await sec(s)).state, 'locked');
      assert.equal((await sec(s)).migration, null, 'the plain hint is not reported as a running conversion');
      assert.equal((await s.unlock()).status, 200);
      const st = await sec(s);
      assert.equal(st.mode, 'password');
      assert.equal(st.migration, null);
      assert.deepEqual([...st.tamper.fields].sort(), ['vault.json: encrypted', 'vault.json: migration']);
      assert.ok(Date.parse(st.tamper.at) > 0);
      await s.call('POST', '/api/memories', { content: 'TAMPER-01-AFTER' });
      const v2 = readJ(dataDir, 'vault.json');
      assert.equal(v2.migration, null, 'the hint is rewritten');
      assert.equal(v2.encrypted, true);
      assert.equal((await s.call('POST', '/api/security/lock', {})).status, 200, 'still lockable');
      assert.ok((await sec(s)).tamper, 'the notice outlives a lock');
      await s.close({ keep: true });
      assert.deepEqual(grepDir(dataDir, 'TAMPER-01'), [], 'nothing was decrypted, new data is encrypted too');
      // the notice is kept in the record until the owner dismisses it
      s = await stack({ dataDir, mode: 'launch' });
      assert.equal((await sec(s)).tamper, null, 'not known before the record is opened');
      await s.unlock();
      assert.ok((await sec(s)).tamper.fields.includes('vault.json: migration'));
      assert.equal((await s.call('POST', '/api/security/tamper/dismiss', {}, { token: null })).status, 401, 'dismissing needs a session');
      assert.deepEqual((await s.call('POST', '/api/security/tamper/dismiss', {})).data, { tamper: null });
      assert.equal((await sec(s)).tamper, null);
      await s.close({ keep: true });
      s = await stack({ dataDir, mode: 'launch' });
      await s.unlock();
      assert.equal((await sec(s)).tamper, null);
    } finally { await s.close(); }
  });

  test('review 05: launch.json "off" or "keychain" over an encrypted folder — still password mode, no api-token (a planted one is refused), idle lock on', async () => {
    let s = await stack();
    await s.setup();
    const dataDir = s.dataDir;
    try {
      await s.call('POST', '/api/memories', { content: 'TAMPER-05-MEMORY' });
      await s.close({ keep: true });
      const planted = 'A'.repeat(43);
      for (const encryption of ['off', 'keychain']) {
        editLaunch(dataDir, { encryption });
        fss.writeFileSync(path.join(dataDir, 'api-token'), planted + '\n');
        s = await stack({ dataDir, mode: 'launch' });
        const before = await sec(s);
        assert.equal(before.state, 'locked');
        assert.notEqual(before.mode, 'off');
        assert.ok(!fss.existsSync(path.join(dataDir, 'api-token')), `no api-token before the key (${encryption})`);
        assert.equal((await s.call('POST', '/api/auth/launch-code', {}, { token: planted })).status, 401);
        assert.equal((await s.unlock()).status, 200);
        const st = await sec(s);
        assert.equal(st.mode, 'password');
        assert.ok(st.idleLockAt, 'idle lock on');
        assert.ok(!fss.existsSync(path.join(dataDir, 'api-token')));
        assert.equal((await s.call('GET', '/api/memories', undefined, { token: planted })).status, 401);
        assert.ok(st.tamper.fields.includes('launch.json: encryption'), JSON.stringify(st.tamper));
        assert.equal(readJ(dataDir, 'launch.json').encryption, 'password', 'rewritten');
        await s.call('POST', '/api/security/tamper/dismiss', {});
        await s.close({ keep: true });
      }
      assert.deepEqual(grepDir(dataDir, 'TAMPER-05'), []);
    } finally { await s.close(); }
  });

  test('review 06: launch.json cannot switch the blocker off or open a window — before the key it is on whatever the file says', async () => {
    let s = await stack();
    await s.setup();
    const dataDir = s.dataDir;
    try {
      await s.close({ keep: true });
      for (const patch of [{ offlineLock: false }, { offlineLockSuspendedUntil: new Date(Date.now() + 30 * 86400000).toISOString() }]) {
        editLaunch(dataDir, patch);
        s = await stack({ dataDir, mode: 'launch' });
        let net = (await sec(s)).offlineLock;
        assert.deepEqual([net.enabled, net.blocked, net.allowedUntil], [true, true, null], 'locked: on');
        assert.equal(egressBlocked('https://huggingface.co'), true);
        await s.unlock();
        net = (await sec(s)).offlineLock;
        assert.deepEqual([net.enabled, net.blocked, net.allowedUntil], [true, true, null], 'unlocked: the record decides');
        assert.equal(egressBlocked('https://huggingface.co'), true);
        assert.ok((await sec(s)).tamper.fields.includes(`launch.json: ${Object.keys(patch)[0]}`));
        const lj = readJ(dataDir, 'launch.json');
        assert.deepEqual([lj.offlineLock, lj.offlineLockSuspendedUntil], [true, null], 'rewritten');
        await s.call('POST', '/api/security/tamper/dismiss', {});
        await s.close({ keep: true });
      }
    } finally { await s.close(); }
  });

  test('an allow window cannot be extended (or opened) by editing launch.json; the owner\'s own window survives a restart', async () => {
    let s = await stack();
    await s.setup();
    const dataDir = s.dataDir;
    try {
      const a = await s.call('POST', '/api/network/allow', { minutes: 5, password: PW });
      assert.equal(a.status, 200, JSON.stringify(a.data));
      const until = a.data.offlineLock.allowedUntil;
      const later = new Date(Date.now() + 2 * 3600000).toISOString();
      editLaunch(dataDir, { offlineLockSuspendedUntil: later });
      assert.equal((await sec(s)).offlineLock.allowedUntil, until, 'a running Harness does not read the file again');
      await s.close({ keep: true });
      editLaunch(dataDir, { offlineLockSuspendedUntil: later });
      s = await stack({ dataDir, mode: 'launch' });
      assert.equal((await sec(s)).offlineLock.blocked, true, 'no window before the key');
      await s.unlock();
      const st = await sec(s);
      assert.equal(st.offlineLock.allowedUntil, until, 'the recorded window, not the file\'s');
      assert.ok(st.tamper.fields.includes('launch.json: offlineLockSuspendedUntil'));
      assert.equal(readJ(dataDir, 'launch.json').offlineLockSuspendedUntil, until);
      await s.call('POST', '/api/security/tamper/dismiss', {});
      await s.close({ keep: true });
      s = await stack({ dataDir, mode: 'launch' });
      await s.unlock();
      const st2 = await sec(s);
      assert.equal(st2.offlineLock.allowedUntil, until, 'the owner\'s window, restored after the unlock');
      assert.equal(st2.tamper, null);
      // "block" while unlocked ends it for good (record and file)
      await s.call('POST', '/api/network/block', {});
      await s.close({ keep: true });
      s = await stack({ dataDir, mode: 'launch' });
      await s.unlock();
      assert.equal((await sec(s)).offlineLock.allowedUntil, null);
    } finally { await s.close(); }
  });

  test('launch.json asking for MORE protection is harmless: the blocker goes on; a "password" hint over keychain mode only costs one password prompt', async () => {
    let s = await stack();
    await s.setup();
    const dataDir = s.dataDir;
    try {
      assert.equal((await s.call('PUT', '/api/network', { enabled: false, password: PW })).status, 200);
      assert.equal((await s.call('POST', '/api/security/mode', { mode: 'keychain', password: PW })).status, 200);
      await s.close({ keep: true });
      editLaunch(dataDir, { offlineLock: true, encryption: 'password' });
      s = await stack({ dataDir, mode: 'launch' });
      assert.equal((await sec(s)).state, 'locked', 'the hint said password: the Keychain was not asked');
      await s.unlock();
      const st = await sec(s);
      assert.equal(st.offlineLock.enabled, true, 'the file may switch the blocker on');
      assert.equal(st.mode, 'keychain', 'the record decides the mode (the Keychain holds our key)');
      assert.equal(st.tamper, null, 'nothing was lowered: no notice');
      assert.equal(readJ(dataDir, 'launch.json').encryption, 'keychain');
      await s.close({ keep: true });
      s = await stack({ dataDir, mode: 'launch' });
      assert.equal((await sec(s)).state, 'unlocked', 'keychain mode opens without a prompt again');
      assert.equal((await sec(s)).offlineLock.enabled, true, 'the raise was written into the record');
    } finally { await s.close(); }
  });

  test('keychain mode (listener): the api-token is written only once the record confirmed keychain mode, and is new at every start', async () => {
    let s = await stack();
    await s.setup();
    const dataDir = s.dataDir;
    const tokenFile = path.join(dataDir, 'api-token');
    try {
      assert.equal((await s.call('POST', '/api/security/mode', { mode: 'keychain', password: PW })).status, 200);
      const t1 = fss.readFileSync(tokenFile, 'utf8').trim();
      await s.close({ keep: true });
      s = await stack({ dataDir, mode: 'launch' });
      assert.equal((await sec(s)).state, 'unlocked', 'opened with the Keychain key, no prompt');
      const t2 = fss.readFileSync(tokenFile, 'utf8').trim();
      assert.notEqual(t2, t1);
      assert.equal((await s.call('GET', '/api/chats', undefined, { token: t1 })).status, 401, 'the last start\'s secret is not accepted');
      assert.equal((await s.call('GET', '/api/chats', undefined, { token: t2 })).status, 200);
      await s.call('POST', '/api/security/lock', {}, { token: t2 });
      assert.equal((await s.call('POST', '/api/security/unlock', {}, { token: t2 })).status, 200, 'a lock in this process keeps the verified mode');
      assert.equal(fss.readFileSync(tokenFile, 'utf8').trim(), t2);
    } finally { await s.close(); }
  });

  test('an interrupted decryption the owner started resumes after the next unlock (from the record)', async () => {
    let s = await stack();
    await s.setup();
    const dataDir = s.dataDir;
    try {
      await s.call('POST', '/api/chats', { title: 'RESUME-DECRYPT-MARKER' });
      await s.srv.app.chats.flush();
      const stop = stopper(dataDir); // a file that cannot be decrypted stops the conversion half-way, as a crash would
      assert.equal((await s.call('POST', '/api/security/mode', { mode: 'off', password: PW })).status, 200);
      await waitFor(async () => (await sec(s)).migration?.error, { timeout: 15000 });
      await s.close({ keep: true });
      fss.rmSync(stop);
      s = await stack({ dataDir, mode: 'launch' });
      assert.equal((await sec(s)).state, 'locked', 'off mode with a key store still starts locked');
      assert.equal((await s.unlock()).status, 200);
      const st = await sec(s);
      assert.equal(st.mode, 'off');
      assert.equal(st.tamper, null);
      assert.ok(grepDir(dataDir, 'RESUME-DECRYPT-MARKER').length >= 1, 'decrypted');
      assert.equal(readJ(dataDir, 'vault.json').encrypted, false);
      assert.ok(fss.existsSync(path.join(dataDir, 'api-token')), 'off mode, verified: the api-token');
      // off mode keeps only the record key: the blocker can still be changed (password-confirmed)
      assert.equal((await s.call('PUT', '/api/network', { enabled: false, password: PW })).status, 200);
      await s.close({ keep: true });
      s = await stack({ dataDir, mode: 'launch' });
      await s.unlock();
      assert.equal((await sec(s)).offlineLock.enabled, false, 'the owner\'s choice, from the record');
    } finally { await s.close(); }
  });

  test('an interrupted first encryption (0.1 → 0.2) resumes after the next unlock — from the record, and from a 0.2.0 key store without one', async () => {
    const dataDir = await tmpDir('harness-enc-resume-');
    const fake = await startFakeOllama({ port: 0 });
    let s = await stack({ dataDir, mode: 'off', apiAuth: false, offlineLock: false, fake });
    try {
      await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ providers: { builtin: { ollama: { baseUrl: fake.url } } }, ollama: { autoStart: false }, embeddings: { model: 'off' }, memory: { enabled: false }, titles: { auto: false } }));
      const c = await s.call('POST', '/api/chats', { title: 'ENC-RESUME-MARKER' });
      await s.close({ keep: true });
      const chatFile = path.join(dataDir, 'chats', `${c.data.chat.id}.json`);
      const plainCopy = fss.readFileSync(chatFile);
      assert.ok(plainCopy.includes('ENC-RESUME-MARKER'));
      s = await stack({ dataDir, fake });
      await s.setup();
      await s.close({ keep: true });
      assert.deepEqual(grepDir(dataDir, 'ENC-RESUME-MARKER'), []);
      for (const legacy of [false, true]) {
        // the moment of a crash: this file not converted yet, the conversion recorded as running
        fss.writeFileSync(chatFile, plainCopy);
        const v = new Vault(dataDir, { kdf: FAST }).load();
        await v.unlockWithPassword(PW);
        const startedAt = new Date().toISOString();
        if (legacy) {
          // a 0.2.0 key store: no record in either copy, no counter file
          const meta = { ...v.meta, migration: { op: 'encrypt', done: 0, total: 9, startedAt, error: null } };
          delete meta.state;
          for (const f of ['vault.json', 'vault.json.bak']) fss.writeFileSync(path.join(dataDir, f), JSON.stringify(meta));
          fss.rmSync(path.join(dataDir, 'vault-seq.json'), { force: true });
        } else {
          assert.equal(v.readState().status, 'ok');
          v.commit({ migration: { op: 'encrypt', id: 'crash-test', startedAt } }, { mutate: (m) => { m.migration = { op: 'encrypt', id: 'crash-test', done: 3, total: 9, startedAt, error: null }; } });
        }
        v.lock();
        s = await stack({ dataDir, fake, mode: 'launch' });
        assert.equal((await s.unlock()).status, 200);
        const st = await sec(s);
        assert.deepEqual([st.migration, st.mode, st.tamper], [null, 'password', null]);
        assert.ok((await s.call('GET', '/api/chats')).data.chats.some((x) => x.title === 'ENC-RESUME-MARKER'));
        await s.close({ keep: true });
        assert.deepEqual(grepDir(dataDir, 'ENC-RESUME-MARKER'), [], `encrypted again (${legacy ? '0.2.0 key store' : 'record'})`);
        if (legacy) assert.ok(readJ(dataDir, 'vault.json').state, 'the record is written at the first unlock');
      }
    } finally { await s.close(); await fake.close(); }
  });

  test('a 0.2.0 key store (no record): its interrupted decryption is not resumed and the blocker comes back on — accepted once, then recorded', async () => {
    let s = await stack();
    await s.setup();
    const dataDir = s.dataDir;
    try {
      await s.call('POST', '/api/memories', { content: 'LEGACY-020-MARKER' });
      await s.close({ keep: true });
      const v = readJ(dataDir, 'vault.json');
      delete v.state;
      v.migration = { op: 'decrypt', done: 1, total: 9, startedAt: new Date().toISOString(), error: null };
      writeVault(dataDir, v);
      fss.rmSync(path.join(dataDir, 'vault-seq.json'));
      editLaunch(dataDir, { encryption: 'off', offlineLock: false });
      s = await stack({ dataDir, mode: 'launch' });
      assert.equal((await sec(s)).state, 'locked');
      assert.equal((await s.unlock()).status, 200);
      const st = await sec(s);
      assert.deepEqual([st.mode, st.offlineLock.enabled, st.migration, st.tamper], ['password', true, null, null]);
      assert.ok(readJ(dataDir, 'vault.json').state, 'recorded at the first unlock');
      assert.deepEqual([readJ(dataDir, 'launch.json').encryption, readJ(dataDir, 'launch.json').offlineLock], ['password', true]);
      assert.equal((await s.call('POST', '/api/security/lock', {})).status, 200);
      await s.close({ keep: true });
      assert.deepEqual(grepDir(dataDir, 'LEGACY-020-MARKER'), []);
    } finally { await s.close(); }
  });

  test('replays: an older vault.json alone is recognised; a decryption recorded under a key that was replaced cannot touch the data encrypted since', async () => {
    let s = await stack();
    await s.setup();
    const dataDir = s.dataDir;
    const snapshot = (names) => Object.fromEntries(names.map((f) => [f, fss.readFileSync(path.join(dataDir, f))]));
    const restore = (snap) => { for (const [f, b] of Object.entries(snap)) fss.writeFileSync(path.join(dataDir, f), b); };
    try {
      // (a) vault.json from before the owner switched the blocker back on, put back on its own
      assert.equal((await s.call('PUT', '/api/network', { enabled: false, password: PW })).status, 200);
      const older = snapshot(['vault.json', 'vault.json.bak']);
      assert.equal((await s.call('PUT', '/api/network', { enabled: true })).status, 200);
      await s.close({ keep: true });
      restore(older);
      editLaunch(dataDir, { offlineLock: false });
      s = await stack({ dataDir, mode: 'launch' });
      await s.unlock();
      let st = await sec(s);
      assert.equal(st.offlineLock.enabled, true, 'the older record does not switch the blocker off');
      assert.ok(st.tamper.fields.some((f) => f.startsWith('vault.json: security record')), JSON.stringify(st.tamper));
      await s.call('POST', '/api/security/tamper/dismiss', {});
      // (b) a decryption the owner started, snapshotted while it ran (all the files that describe it) …
      const stop = stopper(dataDir);
      assert.equal((await s.call('POST', '/api/security/mode', { mode: 'off', password: PW })).status, 200);
      await waitFor(async () => (await sec(s)).migration?.error, { timeout: 15000 });
      const during = snapshot(['vault.json', 'vault.json.bak', 'vault-seq.json', 'launch.json']);
      await s.close({ keep: true });
      fss.rmSync(stop);
      s = await stack({ dataDir, mode: 'launch' });
      await s.unlock();
      assert.equal((await sec(s)).mode, 'off');
      // … finished; then encryption back on: a NEW data key (and recovery key)
      const on = await s.call('POST', '/api/security/mode', { mode: 'password', password: PW });
      assert.equal(on.status, 200, JSON.stringify(on.data));
      assert.match(on.data.recoveryKey, /\w/);
      await waitFor(async () => (await sec(s)).state === 'unlocked', { timeout: 15000 });
      await s.call('POST', '/api/memories', { content: 'REPLAY-MARKER-AFTER' });
      await s.close({ keep: true });
      assert.deepEqual(grepDir(dataDir, 'REPLAY-MARKER'), []);
      const data = () => new Map(filesUnder(dataDir).filter((f) => /\/(chats|memories|settings)/.test(f)).map((f) => [f, fss.readFileSync(f)]));
      const current = snapshot(['vault.json', 'vault.json.bak', 'vault-seq.json', 'launch.json']);
      const before = data();
      for (const [label, files] of [['vault.json alone', { 'vault.json': during['vault.json'], 'vault.json.bak': during['vault.json.bak'] }], ['every file that describes it', during]]) {
        restore(files);
        s = await stack({ dataDir, mode: 'launch' });
        const r = await s.call('POST', '/api/security/unlock', { password: PW, session: 'token' });
        await new Promise((res) => setTimeout(res, 500)); // a resumed conversion would be running now
        await s.close({ keep: true });
        assert.deepEqual(grepDir(dataDir, 'REPLAY-MARKER'), [], `${label}: nothing decrypted (unlock ${r.status})`);
        for (const [f, b] of before) assert.deepEqual(fss.readFileSync(f), b, `${label}: ${path.relative(dataDir, f)} untouched`);
        restore(current);
      }
      s = await stack({ dataDir, mode: 'launch' });
      assert.equal((await s.unlock()).status, 200, 'the current key store still opens everything');
      assert.ok((await s.call('GET', '/api/memories')).data.memories.some((m) => m.content === 'REPLAY-MARKER-AFTER'));
    } finally { await s.close(); }
  });
});

// Review round 2, finding F6: the command-line tools must not send the password to whatever wrote harness.lock.
describe('instance proof (review F6)', () => {
  test('POST /api/security/prove: no session; unlocked → a proof the helper verifies; bound to address and port; locked 423, off 409, bad nonce 400', async () => {
    const { openDataKeyWithPassword, instanceProof, proofBinding } = await import('../server/security/instance-proof.mjs');
    let s = await stack();
    await s.setup();
    const dataDir = s.dataDir;
    try {
      const vaultBefore = fss.readFileSync(path.join(dataDir, 'vault.json'), 'utf8');
      const key = await openDataKeyWithPassword(JSON.parse(vaultBefore), PW);
      assert.ok(key, 'the helper opens a key store made by the real setup');
      assert.equal(await openDataKeyWithPassword(JSON.parse(vaultBefore), 'wrong wrong'), null);
      assert.equal(fss.readFileSync(path.join(dataDir, 'vault.json'), 'utf8'), vaultBefore, 'the helper wrote nothing (no throttle count)');
      const port = Number(new URL(s.url).port);
      const prove = (nonce, o) => s.call('POST', '/api/security/prove', { nonce: nonce.toString('base64url') }, { token: null, ...o });
      const n1 = crypto.randomBytes(32);
      const n2 = crypto.randomBytes(16);
      const r1 = await prove(n1);
      assert.equal(r1.status, 200, JSON.stringify(r1.data));
      const p1 = Buffer.from(r1.data.proof, 'base64url');
      const here = proofBinding({ address: '127.0.0.1', port });
      assert.ok(crypto.timingSafeEqual(p1, instanceProof(key, n1, here)), 'verifies with the helper');
      assert.ok(!p1.equals(instanceProof(key, n1, proofBinding({ address: '127.0.0.1', port: port + 1 }))), 'a relay on another port gets a proof that does not match');
      assert.ok(!p1.equals(instanceProof(key, n1, proofBinding({ address: '127.0.0.2', port }))), 'a relay on the same port at another loopback address does not either (review R3-5)');
      assert.ok(!p1.equals(instanceProof(crypto.randomBytes(32), n1, here)), 'a wrong data key does not verify');
      const p2 = Buffer.from((await prove(n2)).data.proof, 'base64url');
      assert.ok(!p2.equals(p1) && p2.equals(instanceProof(key, n2, here)), 'two nonces, two proofs');
      for (const bad of [{}, { nonce: 'x' }, { nonce: crypto.randomBytes(8).toString('base64url') }, { nonce: crypto.randomBytes(80).toString('base64url') }, { nonce: n1.toString('base64') + '+' }]) {
        const r = await s.call('POST', '/api/security/prove', bad, { token: null });
        assert.equal(r.status, 400, JSON.stringify(bad));
      }
      assert.equal((await prove(n1, { headers: { origin: 'https://evil.example' } })).status, 403, 'the Origin checks stay in front');
      await s.call('POST', '/api/security/lock', {});
      const locked = await prove(n1);
      assert.deepEqual([locked.status, locked.data.error.code], [423, 'locked']);
      await s.unlock();
      assert.equal((await s.call('POST', '/api/security/mode', { mode: 'off', password: PW })).status, 200);
      await waitFor(async () => (await s.call('GET', '/api/security')).data.state === 'unlocked', { timeout: 15000 });
      const off = await prove(n1);
      assert.deepEqual([off.status, off.data.error.code], [409, 'not_encrypted']);
      key.fill(0);
    } finally { await s.close(); }
  });
});

// Review round 3: key material is never lost (R3-2), no record never means less than password mode (R3-1), nothing
// from before the first password reaches the first record (R3-3), a counter for another key is not current (R3-4).
describe('key material is never lost; without an intact record only the most protective reading (review round 3)', () => {
  const readJ = (dir, f) => JSON.parse(fss.readFileSync(path.join(dir, f), 'utf8'));
  const writeJ = (dir, f, v) => fss.writeFileSync(path.join(dir, f), JSON.stringify(v, null, 2));
  const editLaunch = (dir, patch) => writeJ(dir, 'launch.json', { ...readJ(dir, 'launch.json'), ...patch });
  const sec = async (s) => (await s.call('GET', '/api/security')).data;
  const hasMemory = async (s, text) => (await s.call('GET', '/api/memories')).data.memories.some((m) => m.content === text);
  /** Flip one byte of the sealed record in the given copies (the schema stays valid). */
  const damageRecord = (dir, files) => {
    for (const f of files) {
      const v = readJ(dir, f);
      const b = Buffer.from(v.state.data, 'base64');
      b[5] ^= 0xff;
      writeJ(dir, f, { ...v, state: { ...v.state, data: b.toString('base64') } });
    }
  };
  /** A re-key stopped half-way by a file it cannot read (as a crash would): memories.json is still under the old key. */
  async function interruptedRekey({ keychain = false } = {}) {
    const s = await stack();
    await s.setup();
    await s.call('POST', '/api/memories', { content: 'REKEY-SURVIVES' });
    if (keychain) assert.equal((await s.call('POST', '/api/security/mode', { mode: 'keychain', password: PW })).status, 200);
    const stop = path.join(s.dataDir, 'index', 'zz-broken.items.jsonl');
    fss.mkdirSync(path.dirname(stop), { recursive: true });
    fss.writeFileSync(stop, Buffer.concat([Buffer.from('HXL1'), Buffer.alloc(4), Buffer.alloc(8, 7), Buffer.from([0, 0, 0, 40]), Buffer.alloc(40, 1)]));
    const rk = await s.call('POST', '/api/security/rekey', { password: PW });
    assert.equal(rk.status, 200, JSON.stringify(rk.data));
    await waitFor(async () => (await sec(s)).migration?.error, { timeout: 15000 });
    await s.close({ keep: true });
    fss.rmSync(stop);
    assert.ok(readJ(s.dataDir, 'vault.json').wraps.previous, 'while the re-key runs, the previous key is wrapped too');
    return { dataDir: s.dataDir, recoveryKey: rk.data.recoveryKey };
  }

  test('review 31: a damaged record during an interrupted re-key is taken from vault.json.bak — an unlock attempt never overwrites it', async () => {
    const { dataDir } = await interruptedRekey();
    damageRecord(dataDir, ['vault.json']);
    const s = await stack({ dataDir, mode: 'launch' });
    try {
      assert.equal((await s.call('POST', '/api/security/unlock', { password: 'wrong wrong' }, { token: null })).status, 401);
      assert.equal((await s.unlock()).status, 200);
      assert.ok(await hasMemory(s, 'REKEY-SURVIVES'), 'the data under the old key was converted, not lost');
      const st = await sec(s);
      assert.equal(st.migration, null);
      assert.ok(st.tamper.fields.includes('vault.json: security record (damaged; restored from vault.json.bak)'), JSON.stringify(st.tamper));
      assert.equal(readJ(dataDir, 'vault.json').wraps.previous, undefined, 'the previous key goes once every file is under the new one');
    } finally { await s.close(); }
  });

  test('review 31: with the record damaged in both copies, the previous-key wraps finish the re-key (password or recovery key); the Keychain alone asks for the password', async () => {
    for (const how of ['password', 'recoveryKey', 'keychain']) {
      const { dataDir, recoveryKey } = await interruptedRekey({ keychain: how === 'keychain' });
      damageRecord(dataDir, ['vault.json', 'vault.json.bak']);
      const s = await stack({ dataDir, mode: how === 'keychain' ? 'keychain' : 'launch' });
      try {
        if (how === 'keychain') assert.equal((await sec(s)).state, 'locked', 'the Keychain does not open the previous key');
        assert.equal((await s.unlock(how === 'recoveryKey' ? { recoveryKey } : { password: PW })).status, 200, how);
        assert.ok(await hasMemory(s, 'REKEY-SURVIVES'), `${how}: nothing lost`);
        const st = await sec(s);
        assert.equal(st.mode, 'password', 'no authentic record: the most protective reading');
        assert.ok(st.tamper.fields.includes('vault.json: security record (not sealed with this key)'));
        assert.equal(readJ(dataDir, 'vault.json').wraps.previous, undefined);
      } finally { await s.close(); }
    }
  });

  test('review 31: when no intact copy of the previous key is left anywhere, Harness goes to state error and changes nothing', async () => {
    const { dataDir } = await interruptedRekey();
    damageRecord(dataDir, ['vault.json', 'vault.json.bak']);
    for (const f of ['vault.json', 'vault.json.bak']) { const v = readJ(dataDir, f); delete v.wraps.previous; v.migration = null; writeJ(dataDir, f, v); }
    const strip = (buf, f) => (/vault\.json/.test(f) ? JSON.stringify({ ...JSON.parse(buf), throttle: null }) : buf.toString('base64'));
    const files = () => new Map(filesUnder(dataDir).filter((f) => !/harness\.lock|\.log$/.test(f)).map((f) => [f, strip(fss.readFileSync(f), f)]));
    const before = files();
    const s = await stack({ dataDir, mode: 'launch' });
    try {
      const u = await s.call('POST', '/api/security/unlock', { password: PW, session: 'token' }, { token: null });
      assert.deepEqual([u.status, u.data.error?.code], [503, 'vault_corrupt'], JSON.stringify(u.data));
      assert.match(u.data.error.message, /re-key was interrupted.*Nothing has been changed/s);
      const st = await sec(s);
      assert.deepEqual([st.state, st.error.code], ['error', 'vault_corrupt']);
      assert.equal((await s.call('GET', '/api/memories')).status, 503);
    } finally { await s.close({ keep: true }); }
    const after = files();
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
    for (const [f, b] of before) assert.equal(after.get(f), b, `${path.relative(dataDir, f)} unchanged (apart from the attempt counter)`);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test('review 30: a removed record never means off mode — whatever both hints and the folder say; reported, new data encrypted', async () => {
    let s = await stack();
    await s.setup();
    const dataDir = s.dataDir;
    await s.close({ keep: true });
    try {
      for (const f of ['vault.json', 'vault.json.bak']) { const v = readJ(dataDir, f); delete v.state; v.encrypted = false; writeJ(dataDir, f, v); }
      editLaunch(dataDir, { encryption: 'off' });
      for (const f of filesUnder(dataDir)) { const h = fss.readFileSync(f).subarray(0, 4).toString(); if (h === 'HXC1' || h === 'HXL1') fss.rmSync(f); }
      s = await stack({ dataDir, mode: 'launch' });
      assert.deepEqual([(await sec(s)).state, (await sec(s)).mode], ['locked', 'password']);
      assert.equal((await s.unlock()).status, 200);
      const st = await sec(s);
      assert.equal(st.mode, 'password');
      assert.ok(st.idleLockAt, 'idle lock on');
      assert.ok(st.tamper.fields.includes('vault.json: security record (removed)'), JSON.stringify(st.tamper));
      assert.ok(!fss.existsSync(path.join(dataDir, 'api-token')));
      await s.call('POST', '/api/memories', { content: 'STRIPPED-RECORD-NEW' });
      await s.close({ keep: true });
      assert.deepEqual(grepDir(dataDir, 'STRIPPED-RECORD-NEW'), []);
      assert.ok(readJ(dataDir, 'vault.json').state, 'the record is written again');
    } finally { await s.close(); }
  });

  test('a genuine 0.2.0 folder stored without encryption (no record, no counter) is encrypted at its first unlock — off only by choosing it again', async () => {
    let s = await stack();
    await s.setup();
    const dataDir = s.dataDir;
    try {
      await s.call('POST', '/api/chats', { title: 'OFF-020-MARKER' });
      assert.equal((await s.call('POST', '/api/security/mode', { mode: 'off', password: PW })).status, 200);
      await waitFor(async () => (await sec(s)).state === 'unlocked' && (await sec(s)).mode === 'off', { timeout: 15000 });
      await s.close({ keep: true });
      assert.ok(grepDir(dataDir, 'OFF-020-MARKER').length >= 1);
      for (const f of ['vault.json', 'vault.json.bak']) { const v = readJ(dataDir, f); delete v.state; writeJ(dataDir, f, v); }
      fss.rmSync(path.join(dataDir, 'vault-seq.json'));
      s = await stack({ dataDir, mode: 'launch' });
      assert.equal((await s.unlock()).status, 200);
      const st = await sec(s);
      assert.deepEqual([st.mode, st.tamper], ['password', null], 'a 0.2.0 key store is not reported as tampered');
      await s.close({ keep: true });
      assert.deepEqual(grepDir(dataDir, 'OFF-020-MARKER'), [], 'encrypted at that unlock');
    } finally { await s.close(); }
  });

  test('review 32: nothing from before the first password reaches the first record — the blocker is on before and after setup, whatever launch.json says', async () => {
    for (const variant of ['fresh', '0.1 data']) {
      for (const lj of [{ offlineLock: false }, { offlineLockSuspendedUntil: new Date(Date.now() + 3600000).toISOString() }, { encryption: 'off' }, { encryption: 'keychain' }]) {
        let s = await stack({ mode: 'launch', prepare: (dir) => {
          writeJ(dir, 'launch.json', { version: 1, offlineLock: true, offlineLockSuspendedUntil: null, encryption: 'password', ...lj });
          if (variant !== 'fresh') { fss.mkdirSync(path.join(dir, 'chats')); writeJ(dir, 'chats/chat_0mabcdefgh00aa11bb22.json', { version: 1, id: 'chat_0mabcdefgh00aa11bb22', title: 'old', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messages: {}, settings: {}, summaries: [] }); }
        } });
        const dataDir = s.dataDir;
        const label = `${variant} ${JSON.stringify(lj)}`;
        try {
          const st0 = await sec(s);
          assert.equal(st0.state, 'needs_setup', label);
          assert.deepEqual([st0.offlineLock.enabled, st0.offlineLock.blocked, st0.offlineLock.allowedUntil], [true, true, null], `${label}: before setup`);
          await s.setup();
          const st1 = await sec(s);
          assert.deepEqual([st1.mode, st1.offlineLock.enabled, st1.offlineLock.allowedUntil, st1.tamper], ['password', true, null, null], `${label}: after setup`);
          await s.close({ keep: true });
          s = await stack({ dataDir, mode: 'launch' });
          await s.unlock();
          const st2 = await sec(s);
          assert.deepEqual([st2.mode, st2.offlineLock.enabled, st2.offlineLock.allowedUntil], ['password', true, null], `${label}: after a restart`);
        } finally { await s.close(); }
      }
    }
  });

  test('review 33: an older vault.json with a forged counter naming the previous key id is not current', async () => {
    let s = await stack();
    await s.setup();
    const dataDir = s.dataDir;
    try {
      const k1 = readJ(dataDir, 'vault.json').keyId;
      await s.call('POST', '/api/security/rekey', { password: PW });
      await waitFor(async () => (await sec(s)).state === 'unlocked', { timeout: 15000 });
      assert.equal((await s.call('PUT', '/api/network', { enabled: false, password: PW })).status, 200);
      const older = fss.readFileSync(path.join(dataDir, 'vault.json'));
      assert.equal((await s.call('PUT', '/api/network', { enabled: true })).status, 200);
      await s.close({ keep: true });
      for (const f of ['vault.json', 'vault.json.bak']) fss.writeFileSync(path.join(dataDir, f), older);
      writeJ(dataDir, 'vault-seq.json', { version: 1, keyId: k1, seq: 1, nonce: 'AAAAAAAAAAAAAAAA', data: 'AAAA' });
      editLaunch(dataDir, { offlineLock: false });
      s = await stack({ dataDir, mode: 'launch' });
      await s.unlock();
      const st = await sec(s);
      assert.equal(st.offlineLock.enabled, true, 'the older record does not switch the blocker off');
      assert.ok(st.tamper.fields.includes('vault.json: security record (an older copy)'), JSON.stringify(st.tamper));
    } finally { await s.close(); }
  });

  test('a counter file that is not a file is reported as what it is (not as "an older copy"); the most protective settings apply', async () => {
    let s = await stack();
    await s.setup();
    const dataDir = s.dataDir;
    try {
      assert.equal((await s.call('PUT', '/api/network', { enabled: false, password: PW })).status, 200);
      await s.close({ keep: true });
      fss.rmSync(path.join(dataDir, 'vault-seq.json'));
      fss.mkdirSync(path.join(dataDir, 'vault-seq.json'));
      for (let i = 0; i < 2; i++) {
        s = await stack({ dataDir, mode: 'launch' });
        await s.unlock();
        const st = await sec(s);
        assert.equal(st.offlineLock.enabled, true);
        const about = st.tamper.fields.filter((f) => f.startsWith('vault-seq.json'));
        assert.equal(about.length, 1, JSON.stringify(st.tamper));
        assert.match(about[0], /a folder — an older vault\.json cannot be told from the current one/);
        assert.ok(!st.tamper.fields.some((f) => /an older copy/.test(f)), 'not misreported');
        await s.close({ keep: true });
      }
    } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });
});
