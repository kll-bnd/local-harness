// 0.2 end to end over HTTP: password setup, sessions, locking, encryption at rest, migration, modes, key-store
// damage, idle lock, UI state, backups. Every server here runs with the SHIPPED defaults (explicit options
// override the opt-outs test/helpers.mjs sets for the other suites), with cheap scrypt parameters.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { tmpDir, parseSse, GiB, waitFor } from './helpers.mjs';
import { startFakeOllama } from './fake-ollama.mjs';
import { startFakeA1111 } from './fake-a1111.mjs';
import { createFakeMemoryProbe } from './fake-memory-probe.mjs';
import { startServer } from '../server/index.mjs';
import { fileKeychain } from '../server/security/keychain.mjs';
import { encryptHXC } from '../server/security/crypto.mjs';

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
    security: { kdf: FAST, ...(mode ? { mode } : { mode: 'password' }), ...(apiAuth === undefined ? { apiAuth: true } : { apiAuth }) },
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
      for (let i = 0; i < 3; i++) assert.equal((await s.unlock({ password: `wrong ${i}` })).data.error.code, 'wrong_password');
      const fourth = await s.unlock({ password: 'wrong 3' });
      assert.equal(fourth.status, 401);
      assert.equal(fourth.data.error.details.retryAfterMs, 1000);
      const early = await s.unlock();
      assert.equal(early.status, 429);
      assert.equal(early.data.error.code, 'unlock_throttled');
      await s.close({ keep: true });
      s = await stack({ dataDir: s.dataDir });
      const st = await s.call('GET', '/api/security');
      assert.equal(st.data.state, 'locked');
      assert.equal(st.data.unlock.failedAttempts, 4);
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
