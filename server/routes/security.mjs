// Password, sessions, the internet blocker and the UI-state store (docs/API.md §10).
import { readJson } from '../http/http.mjs';
import { HttpError } from '../lib/errors.mjs';
import { Reply } from './common.mjs';
import { runEgressSelfTest } from '../security/selftest.mjs';
import { MAX_ALLOW_MINUTES } from '../security/network.mjs';

const selftestIntervalMs = () => Number(process.env.HARNESS_SELFTEST_INTERVAL_MS ?? 10000);
const confirmHeader = (req) => (typeof req.headers['x-harness-confirm'] === 'string' ? req.headers['x-harness-confirm'] : null);

/**
 * `"session": "token"` asks for the session as a bearer token in the body (CLI tools). Only a caller that is not a
 * browser page may: a request with an Origin header, or with Sec-Fetch-Site other than "none", is refused — page
 * JavaScript must never see a session (browsers get the HttpOnly cookie only). Checked before anything happens.
 */
function wantsToken(req, body, bridge) {
  if (body?.session === undefined || body.session === 'cookie') return false;
  if (body.session !== 'token') throw new HttpError(400, 'bad_request', 'session must be "cookie" or "token"');
  if (bridge) return false;
  const site = req.headers['sec-fetch-site'];
  if (req.headers.origin !== undefined || (site !== undefined && site !== 'none')) throw new HttpError(403, 'token_refused', 'A browser page gets its session as a cookie only.');
  return true;
}

/** A session for the caller: the cookie, plus the same token in the body when `wantToken` (§10.5). */
function withSession(core, bridge, body, wantToken, status = 200) {
  if (bridge || !core.auth.enabled) return new Reply(status, body);
  const s = core.auth.createSession();
  return new Reply(status, { ...body, ...(wantToken ? { sessionToken: s.token, sessionExpiresAt: s.expiresAt } : {}) }, { 'set-cookie': s.cookie });
}

function authInfo(core, req, auth, bridge) {
  if (bridge) return { authenticated: true, via: 'bridge' };
  if (!core.auth.enabled) return { authenticated: true, via: null };
  const st = core.auth.status(req);
  return { authenticated: st.authenticated, via: st.via };
}

export function registerSecurityRoutes(r, core) {
  const open = { open: true };
  const whileLocked = { whileLocked: true };

  r.get('/api/health', () => ({ ok: true, name: 'harness', version: core.version, state: core.state }), open);

  r.get('/api/security', async ({ req, auth, bridge }) => {
    await core.refreshOllamaPresence();
    return core.securityStatus(authInfo(core, req, auth, bridge));
  }, open);

  r.post('/api/security/setup', async ({ req, bridge }) => {
    const body = await readJson(req);
    const token = wantsToken(req, body, bridge);
    const out = await core.setup(body.password);
    return withSession(core, bridge, out, token);
  }, open);

  r.post('/api/security/unlock', async ({ req, auth, bridge }) => {
    const body = await readJson(req, { optional: true });
    const token = wantsToken(req, body, bridge);
    const out = await core.unlock({ password: body.password, recoveryKey: body.recoveryKey }, { authenticated: bridge || auth.ok });
    if (core.state === 'migrating') core.retryMigration();
    return withSession(core, bridge, out, token);
  }, open);

  r.post('/api/security/lock', async () => {
    await core.lock('user');
    const headers = core.mode === 'password' && core.auth.enabled ? { 'set-cookie': core.auth.clearCookie() } : {};
    return new Reply(200, { state: core.state }, headers);
  }, whileLocked);

  r.post('/api/security/password', async ({ req }) => {
    const body = await readJson(req);
    return core.changePassword({ password: body.password, newPassword: body.newPassword });
  });

  r.post('/api/security/recovery-key', async ({ req, auth }) => {
    const body = await readJson(req, { optional: true });
    return core.newRecoveryKey({ password: body.password, header: confirmHeader(req), sessionHash: auth.sessionHash });
  });

  r.post('/api/security/mode', async ({ req, auth }) => {
    const body = await readJson(req);
    return core.setMode({ mode: body.mode, password: body.password, newPassword: body.newPassword, header: confirmHeader(req), sessionHash: auth.sessionHash });
  });

  r.post('/api/security/rekey', async ({ req, auth }) => {
    const body = await readJson(req);
    return core.rekey({ password: body.password, header: confirmHeader(req), sessionHash: auth.sessionHash });
  });

  // The explicit "the user is here" signal (at most once a minute while the user interacts; data-free).
  r.post('/api/security/activity', () => core.touch());

  r.post('/api/security/confirm', async ({ req, auth }) => {
    const body = await readJson(req);
    if (!core.vault.hasPassword) throw new HttpError(409, 'no_password', 'Harness has no password; nothing needs confirming.');
    await core.confirmPassword(body.password);
    return core.auth.mintConfirmation(auth.sessionHash);
  });

  // ---------------------------------------------------------------------------------------------- sessions
  r.post('/api/auth/session', async ({ req, bridge }) => {
    const body = await readJson(req, { optional: true });
    if (bridge || !core.auth.enabled) return { authenticated: true };
    if (core.mode === 'password') throw new HttpError(401, 'auth_required', 'Enter your Harness password to continue.', { reason: 'invalid', unlock: true });
    const token = wantsToken(req, body, bridge);
    if (!core.auth.redeemLaunchCode(body.code)) throw new HttpError(401, 'auth_required', 'This launch link has expired or was already used. Open Harness from its launcher again.', { reason: 'invalid', unlock: false });
    return withSession(core, bridge, { authenticated: true }, token);
  }, open);

  r.get('/api/auth/status', ({ req, bridge }) => {
    if (bridge) return { authenticated: true, via: 'bridge', expiresAt: null };
    if (!core.auth.enabled) return { authenticated: true, via: null, expiresAt: null };
    return core.auth.status(req);
  }, open);

  r.post('/api/auth/logout', ({ req, bridge }) => {
    if (!bridge && core.auth.enabled) core.auth.revoke(req);
    return new Reply(200, { ok: true }, bridge || !core.auth.enabled ? {} : { 'set-cookie': core.auth.clearCookie() });
  }, whileLocked);

  r.post('/api/auth/launch-code', () => {
    if (core.mode === 'password') throw new HttpError(409, 'password_mode', 'In password mode a browser gets its session by unlocking in that browser.');
    const c = core.auth.mintLaunchCode();
    return { code: c.code, url: `${core.url || ''}/#launch=${c.code}`, expiresAt: c.expiresAt };
  }, whileLocked);

  // ---------------------------------------------------------------------------------------------- internet
  const netReply = async (reason) => {
    // A managed Ollama follows the user's allow/block (with / without the sandbox) as part of this request only.
    if (reason) await core.ollamaProcess.applySandbox().catch(() => {});
    await core.refreshOllamaPresence();
    const restartRequired = reason === 'allow' && core.restartRequiredForAllow;
    if (restartRequired) core.emitEvent({ type: 'restart-required', reason: 'offline_lock' });
    core.app?.bus.publish('network.status', { offlineLock: core.network.status() });
    return { offlineLock: core.network.status(), restartRequired };
  };

  r.get('/api/network', async () => { await core.refreshOllamaPresence(); return { offlineLock: core.network.status() }; });

  r.post('/api/network/allow', async ({ req, auth }) => {
    const body = await readJson(req, { optional: true });
    const minutes = body.minutes === undefined ? 15 : Number(body.minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_ALLOW_MINUTES) throw new HttpError(400, 'bad_request', `minutes must be 1–${MAX_ALLOW_MINUTES}`);
    await core.requireConfirmation({ password: body.password, header: confirmHeader(req), sessionHash: auth.sessionHash });
    core.network.allow(minutes);
    return netReply('allow');
  });

  r.post('/api/network/block', async () => {
    core.network.block();
    return netReply('block');
  });

  r.put('/api/network', async ({ req, auth }) => {
    const body = await readJson(req);
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'bad_request', 'enabled must be true or false');
    if (!body.enabled) await core.requireConfirmation({ password: body.password, header: confirmHeader(req), sessionHash: auth.sessionHash });
    core.network.setEnabled(body.enabled);
    const out = await netReply(body.enabled ? 'block' : 'allow');
    return { offlineLock: out.offlineLock, restartRequired: out.restartRequired };
  });

  // No session needed (no user data; the doctor tests a locked Harness), but one run at a time and at most one
  // every 10 s, because by design it makes one outbound attempt when an OS sandbox claims to block it.
  let lastTest = 0;
  let running = null;
  r.post('/api/network/test', async () => {
    const wait = lastTest + selftestIntervalMs() - Date.now();
    if (running || wait > 0) throw new HttpError(429, 'rate_limited', 'The self-test ran a moment ago; try again shortly.', { retryAfterMs: Math.max(wait, 1000) });
    lastTest = Date.now();
    running = runEgressSelfTest({ network: core.network, ollama: { sandboxExec: core.ollamaProcess.sandboxExec, profile: core.ollamaProcess.profile } });
    try { return await running; } finally { running = null; lastTest = Date.now(); }
  }, open);
}

/** Routes over the unlocked data that belong to §10 (UI state). */
export function registerAppSecurityRoutes(r, app) {
  r.get('/api/ui-state', () => app.uiState.get());
  r.put('/api/ui-state', async ({ req }) => {
    const body = await readJson(req, { limit: 1.5 * 1024 * 1024 });
    return app.uiState.replace(body.state);
  });
  r.patch('/api/ui-state', async ({ req }) => {
    const body = await readJson(req, { limit: 1.5 * 1024 * 1024 });
    return app.uiState.patch(body);
  });
}
