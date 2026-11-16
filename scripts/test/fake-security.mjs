// A minimal stand-in for the 0.2 security/session/network routes of docs/API.md §10, used to test the CLI
// client (scripts/lib/harness-client.mjs) before and independently of the real backend.
import http from 'node:http';
import crypto from 'node:crypto';

export async function startFakeSecurity({ state = 'locked', mode = 'password', password = 'correct horse', sessionInBody = true } = {}) {
  const f = {
    state, mode, password, failed: 0, sessions: new Set(), logouts: 0, unlockBodies: [], allowCalls: [], blockCalls: 0,
    offlineLock: { enabled: true, blocked: true, allowedUntil: null, waitingFor: null, osEnforced: true, osScope: 'ollama', externalOllama: false },
    migration: null,
  };
  const retryAfter = () => (f.failed < 3 ? 0 : Math.min(300000, 1000 * 2 ** (f.failed - 3)));
  const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const err = (res, status, code, details) => json(res, status, { error: { code, message: code, details } });
  const sessionOf = (req) => {
    const a = req.headers.authorization?.replace(/^Bearer /, '');
    const c = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('harness_session='))?.slice(16);
    return [a, c].find((t) => t && f.sessions.has(t)) || null;
  };
  const security = (req) => ({ state: f.state, mode: f.mode, plainDataFound: false, migration: f.migration, unlock: { failedAttempts: f.failed, retryAfterMs: f.lastFailAt ? Math.max(0, f.lastFailAt + retryAfter() - Date.now()) : 0 }, recoveryKey: null, idleLockMinutes: 15, session: { authenticated: !!sessionOf(req), via: sessionOf(req) ? 'token' : null }, transport: 'listener', offlineLock: f.offlineLock });
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const u = new URL(req.url, 'http://x');
    const p = `${req.method} ${u.pathname}`;
    if (p === 'GET /api/health') return json(res, 200, { ok: true, name: 'harness', version: '0.2.0', state: f.state });
    if (p === 'GET /api/security') { if (f.migration) { f.migration.done++; if (f.migration.done >= f.migration.total) { f.migration = null; f.state = 'unlocked'; } } return json(res, 200, security(req)); }
    if (p === 'POST /api/security/unlock') {
      f.unlockBodies.push(body);
      if (f.state === 'needs_setup') return err(res, 423, 'needs_setup');
      const wait = f.lastFailAt ? f.lastFailAt + retryAfter() - Date.now() : 0;
      if (wait > 0) return err(res, 429, 'unlock_throttled', { retryAfterMs: wait });
      const ok = f.mode === 'keychain' && body.password === undefined ? true : body.password === f.password;
      if (!ok) { f.failed++; f.lastFailAt = Date.now(); return err(res, 401, 'wrong_password', { retryAfterMs: retryAfter() }); }
      f.failed = 0; f.lastFailAt = 0;
      if (f.state === 'locked') f.state = 'unlocked';
      const t = crypto.randomBytes(16).toString('hex');
      f.sessions.add(t);
      return json(res, 200, { state: f.state, passwordReset: null, ...(sessionInBody ? { sessionToken: t } : {}) }, { 'set-cookie': `harness_session=${t}; HttpOnly; SameSite=Strict; Path=/` });
    }
    if (p === 'POST /api/auth/logout') { const s = sessionOf(req); if (s) { f.sessions.delete(s); f.logouts++; } return json(res, 200, { ok: true }); }
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
