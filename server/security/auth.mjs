// Who may use the HTTP listener (docs/API.md §10.5). Bridge requests never come through here.
//
// Password mode: a session (HttpOnly SameSite=Strict cookie, or the same token as a Bearer header for CLI tools)
// exists only after a successful setup/unlock in that client; locking drops all of them. There is no api-token file.
// Keychain/off modes: additionally a secret in <dataDir>/api-token (0600) authorises Bearer requests, and one-time
// launch codes (in the URL fragment) let a browser obtain a session cookie. With a key store the secret exists only
// for a mode the security record confirmed, and is new at every start (docs/API.md §10.2, §10.5).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const COOKIE = 'harness_session';
export const SESSION_TTL_SEC = 12 * 3600;
const CODE_TTL_MS = 2 * 60 * 1000;
const CONFIRM_TTL_MS = 2 * 60 * 1000;

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const eq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export class Auth {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {boolean} o.enabled        false = no checks at all (tests / development opt-out)
   * @param {() => string} o.mode      current protection mode ('password' | 'keychain' | 'off')
   */
  constructor({ dataDir, enabled = true, mode }) {
    this.enabled = enabled;
    this.mode = mode;
    this.tokenFile = path.join(dataDir, 'api-token');
    this.sessions = new Map(); // hash → { createdAt, expiresAt }
    this.codes = new Map(); // hash → expiresAt
    this.confirmations = new Map(); // hash → { session, expiresAt }
    this.apiToken = null;
  }

  /**
   * Keychain/off modes keep the secret file; password mode — and any mode Harness has not verified
   * yet (the core reports 'password' then) — must not have one. `fresh`: a new secret (the first verified mode of
   * a key store in this process: a file left from before is never accepted). Otherwise the secret in memory is kept
   * (and written back if the file went missing); `adopt` (off mode without a key store, where nothing is protected
   * by a password) keeps the file's secret across restarts.
   */
  syncTokenFile({ fresh = false, adopt = false } = {}) {
    if (this.mode() === 'password') {
      fs.rmSync(this.tokenFile, { force: true });
      this.apiToken = null;
      return null;
    }
    if (adopt && !fresh && !this.apiToken) {
      try { const t = fs.readFileSync(this.tokenFile, 'utf8').trim(); if (/^[A-Za-z0-9_-]{43}$/.test(t)) this.apiToken = t; } catch { /* create below */ }
    }
    if (fresh || !this.apiToken) this.apiToken = token();
    let onDisk = null;
    try { onDisk = fs.readFileSync(this.tokenFile, 'utf8').trim(); } catch { /* missing */ }
    if (onDisk !== this.apiToken) {
      const tmp = `${this.tokenFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, this.apiToken + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.tokenFile);
    }
    return this.apiToken;
  }

  createSession() {
    const t = token();
    const expiresAt = Date.now() + SESSION_TTL_SEC * 1000;
    this.sessions.set(hash(t), { createdAt: Date.now(), expiresAt });
    return { token: t, expiresAt: new Date(expiresAt).toISOString(), cookie: `${COOKIE}=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SEC}` };
  }

  clearCookie() { return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`; }

  /** Inspect a request: { ok, via, reason, sessionHash }. */
  check(req) {
    if (!this.enabled) return { ok: true, via: 'disabled', reason: null, sessionHash: 'disabled' };
    const now = Date.now();
    const cookie = parseCookies(req.headers.cookie)[COOKIE];
    const auth = String(req.headers.authorization || '');
    const bearer = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
    for (const [t, via] of [[cookie, 'cookie'], [bearer, 'token']]) {
      if (!t) continue;
      const h = hash(t);
      const s = this.sessions.get(h);
      if (s) {
        if (s.expiresAt < now) { this.sessions.delete(h); return { ok: false, via: null, reason: 'expired' }; }
        return { ok: true, via, reason: null, sessionHash: h };
      }
      if (via === 'token' && this.apiToken && this.mode() !== 'password' && eq(t, this.apiToken)) return { ok: true, via: 'token', reason: null, sessionHash: 'api-token' };
    }
    return { ok: false, via: null, reason: cookie || bearer ? 'invalid' : 'missing' };
  }

  status(req) {
    const c = this.check(req);
    const s = c.sessionHash && this.sessions.get(c.sessionHash);
    return { authenticated: c.ok, via: c.ok ? c.via : null, expiresAt: s ? new Date(s.expiresAt).toISOString() : null };
  }

  revoke(req) {
    const c = this.check(req);
    if (c.sessionHash) this.sessions.delete(c.sessionHash);
  }

  /** Locking drops every session (and pending codes and confirmations). */
  dropAll() { this.sessions.clear(); this.codes.clear(); this.confirmations.clear(); }
  dropConfirmations() { this.confirmations.clear(); }

  // ---------------------------------------------------------------------------------------- launch codes
  mintLaunchCode() {
    const c = token();
    this.codes.set(hash(c), Date.now() + CODE_TTL_MS);
    return { code: c, expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString() };
  }

  redeemLaunchCode(code) {
    const h = hash(code || '');
    const exp = this.codes.get(h);
    this.codes.delete(h);
    return !!exp && exp > Date.now();
  }

  // ---------------------------------------------------------------------------------------- confirmations
  mintConfirmation(sessionHash) {
    const c = token();
    this.confirmations.set(hash(c), { session: sessionHash, expiresAt: Date.now() + CONFIRM_TTL_MS });
    return { confirmation: c, expiresAt: new Date(Date.now() + CONFIRM_TTL_MS).toISOString() };
  }

  consumeConfirmation(c, sessionHash) {
    const h = hash(c || '');
    const rec = this.confirmations.get(h);
    this.confirmations.delete(h);
    return !!rec && rec.expiresAt > Date.now() && rec.session === sessionHash;
  }
}
