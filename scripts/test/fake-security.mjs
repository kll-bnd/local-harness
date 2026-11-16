// A minimal stand-in for the 0.2 security/session/network routes of docs/API.md §10, used to test the CLI
// client (scripts/lib/harness-client.mjs) before and independently of the real backend.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { newKdf, deriveKey, seal } from '../../server/security/crypto.mjs';
import { instanceProof, proofBinding } from '../lib/instance-proof.mjs';

/**
 * Write a real key store (vault.json with the password wrap, as server/security/vault.mjs makes it, cheap scrypt)
 * into `dataDir`; returns the data key so a genuine fake instance can answer POST /api/security/prove.
 */
export async function writeTestVault(dataDir, password) {
  const dek = crypto.randomBytes(32);
  const kdf = newKdf({ N: 1024, r: 8, p: 1 });
  const kek = await deriveKey(password, kdf);
  const meta = { version: 1, encrypted: true, keyId: crypto.createHash('sha256').update(dek).digest('hex').slice(0, 16), wraps: { password: { kdf, ...seal(kek, dek, 'harness-wrap-v1:password') } } };
  kek.fill(0);
  fs.writeFileSync(path.join(dataDir, 'vault.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
  return dek;
}

/**
 * @param {object} o
 * @param {'key'|'wrong'|'none'|'locked'} [o.prove='none']  how POST /api/security/prove answers: with the right proof
 *   (needs `dataKey`), a wrong one, 404 (no such route — an impostor or an old backend), or 423
 */
export async function startFakeSecurity({ state = 'locked', mode = 'password', password = 'correct horse', honourTokenRequest = true, error = null, prove = 'none', dataKey = null } = {}) {
  const f = {
    state, mode, password, failed: 0, sessions: new Set(), logouts: 0, unlockBodies: [], allowCalls: [], blockCalls: 0,
    received: [], // every request: { method, path, body } — to assert what an impostor got
    proveCalls: [],
    offlineLock: { enabled: true, blocked: true, allowedUntil: null, waitingFor: null, osEnforced: true, osScope: 'ollama', externalOllama: false },
    migration: null,
    error,
  };
  const retryAfter = () => (f.failed < 3 ? 0 : Math.min(300000, 1000 * 2 ** (f.failed - 3)));
  const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const err = (res, status, code, details) => json(res, status, { error: { code, message: code, details } });
  const sessionOf = (req) => {
    const a = req.headers.authorization?.replace(/^Bearer /, '');
    const c = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('harness_session='))?.slice(16);
    return [a, c].find((t) => t && f.sessions.has(t)) || null;
  };
  const security = (req) => ({ ...(f.state === 'error' ? { error: f.error } : {}), state: f.state, mode: f.mode, plainDataFound: false, migration: f.migration, unlock: { failedAttempts: f.failed, retryAfterMs: f.lastFailAt ? Math.max(0, f.lastFailAt + retryAfter() - Date.now()) : 0 }, recoveryKey: null, idleLockMinutes: 15, session: { authenticated: !!sessionOf(req), via: sessionOf(req) ? 'token' : null }, transport: 'listener', offlineLock: f.offlineLock });
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const u = new URL(req.url, 'http://x');
    const p = `${req.method} ${u.pathname}`;
    f.received.push({ method: req.method, path: u.pathname, raw, headers: { ...req.headers } });
    if (p === 'POST /api/security/prove') {
      f.proveCalls.push(body);
      if (prove === 'none') return err(res, 404, 'not_found');
      if (prove === 'locked' || f.state === 'locked') return err(res, 423, 'locked');
      if (prove === 'wrong') return json(res, 200, { proof: crypto.randomBytes(32).toString('base64url') });
      // Bound to the port the request arrived on, like the real route (a relay on another port cannot reuse it).
      return json(res, 200, { proof: instanceProof(dataKey, Buffer.from(body.nonce, 'base64url'), proofBinding({ port: req.socket.localPort })).toString('base64url') });
    }
    if (p === 'GET /api/health') return json(res, 200, { ok: true, name: 'harness', version: '0.2.0', state: f.state });
    if (p === 'GET /api/security') { if (f.migration) { f.migration.done++; if (f.migration.done >= f.migration.total) { f.migration = null; f.state = 'unlocked'; } } return json(res, 200, security(req)); }
    if (p === 'POST /api/security/unlock') {
      f.unlockBodies.push(body);
      if (f.state === 'error') return err(res, 409, f.error.code);
      if (body.session === 'token' && req.headers.origin) return err(res, 403, 'token_refused');
      if (f.state === 'needs_setup') return err(res, 423, 'needs_setup');
      const wait = f.lastFailAt ? f.lastFailAt + retryAfter() - Date.now() : 0;
      if (wait > 0) return err(res, 429, 'unlock_throttled', { retryAfterMs: wait });
      const ok = f.mode === 'keychain' && body.password === undefined ? true : body.password === f.password;
      if (!ok) { f.failed++; f.lastFailAt = Date.now(); return err(res, 401, 'wrong_password', { retryAfterMs: retryAfter() }); }
      f.failed = 0; f.lastFailAt = 0;
      if (f.state === 'locked') f.state = 'unlocked';
      const t = crypto.randomBytes(16).toString('hex');
      f.sessions.add(t);
      // Like §10.3: the token is in the body only when asked for with "session": "token".
      return json(res, 200, { state: f.state, passwordReset: null, ...(honourTokenRequest && body.session === 'token' ? { sessionToken: t } : {}) }, { 'set-cookie': `harness_session=${t}; HttpOnly; SameSite=Strict; Path=/` });
    }
    if (p === 'POST /api/auth/logout') { const s = sessionOf(req); if (s) { f.sessions.delete(s); f.logouts++; } return json(res, 200, { ok: true }); }
    if (f.state === 'error') return err(res, 503, f.error.code);
    if (f.state === 'needs_setup' || f.state === 'locked' || f.state === 'migrating') return err(res, 423, f.state === 'migrating' ? 'locked' : f.state);
    if (!sessionOf(req)) return err(res, 401, 'auth_required', { reason: 'missing', unlock: f.mode === 'password' });
    if (p === 'POST /api/security/lock') { f.state = 'locked'; f.sessions.clear(); return json(res, 200, { state: 'locked' }); }
    if (p === 'GET /api/network') return json(res, 200, { offlineLock: f.offlineLock });
    if (p === 'POST /api/network/allow') {
      f.allowCalls.push({ minutes: body.minutes, hasPassword: 'password' in body });
      if (!('password' in body)) return err(res, 403, 'confirmation_required');
      if (body.password !== f.password) return err(res, 401, 'wrong_password', { retryAfterMs: 0 });
      f.offlineLock = { ...f.offlineLock, blocked: false, allowedUntil: new Date(Date.now() + body.minutes * 60000).toISOString() };
      return json(res, 200, { offlineLock: f.offlineLock, restartRequired: false });
    }
    if (p === 'POST /api/network/block') { f.blockCalls++; f.offlineLock = { ...f.offlineLock, blocked: true, allowedUntil: null }; return json(res, 200, { offlineLock: f.offlineLock, restartRequired: false }); }
    if (p === 'POST /api/network/test') return json(res, 200, { blocked: f.offlineLock.blocked, results: [{ layer: 'code', target: 'huggingface.co:443', result: f.offlineLock.blocked ? 'blocked' : 'reachable' }] });
    if (p === 'GET /api/data') return json(res, 200, { secret: 'only with a session' });
    return err(res, 404, 'not_found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  f.url = `http://127.0.0.1:${server.address().port}`;
  f.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return f;
}
