// Shared client for the command-line tools (get-model, doctor, launch, live-check helpers): find or start the
// Harness backend for a data directory and get an API session the way docs/API.md §10.5 prescribes.
//
// Password rules (never broken here):
//   * The password is read from the terminal WITHOUT echo, or — for automation — from stdin when the tool was
//     started with --password-stdin. Never from argv or the environment, never printed or logged.
//   * It is kept in this process's memory only while the tool runs (for the confirmation that allowing
//     internet access needs) and sent only to 127.0.0.1.
//   * The session token lives in memory only and is dropped with POST /api/auth/logout at the end. Nothing is
//     written to disk.
//   * First run (state `needs_setup`): the tools do NOT choose a password. The Harness window does that, because
//     it shows the recovery key once with a "save it now" step — a terminal would leave it in scrollback.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findRunningHarness } = require('../../electron/lib/instance.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HarnessError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/** `launch.json` (plain, non-sensitive; docs/BRIDGE.md) with its documented defaults. */
export function readLaunchJson(dataDir) {
  const defaults = { version: 1, offlineLock: true, offlineLockSuspendedUntil: null, encryption: 'password' };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'launch.json'), 'utf8'));
    return { ...defaults, ...(j && typeof j === 'object' ? j : {}), exists: true };
  } catch {
    return { ...defaults, exists: false };
  }
}

// --------------------------------------------------------------------------------------------- password input
async function readStdinLine(stdin) {
  const chunks = [];
  for await (const c of stdin) {
    chunks.push(c);
    if (Buffer.concat(chunks).includes(0x0a)) break;
  }
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
}

/** Read a secret from the terminal without echoing it. Ctrl+C aborts the tool. */
export function readSecretFromTty(prompt, { stdin = process.stdin, out = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) { reject(new HarnessError('no_terminal', 'No terminal to ask for the Harness password on. Pipe it in and add --password-stdin.')); return; }
    out.write(prompt);
    let value = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (err) => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      out.write('\n');
      if (err) reject(err); else resolve(value);
    };
    const onData = (s) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') { finish(new HarnessError('aborted', 'Cancelled.')); return; }
        if (ch === '\u0004') { if (!value) return finish(new HarnessError('aborted', 'Cancelled.')); continue; }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        if (ch === '\u0015') { value = ''; continue; } // Ctrl+U: clear
        if (ch >= ' ') value += ch;
      }
      return undefined;
    };
    stdin.on('data', onData);
  });
}

/**
 * Where the password comes from: { stdin: true } (--password-stdin) or the terminal.
 * Returns a function prompt(text) → Promise<string>.
 */
export function passwordSource({ fromStdin = false, stdin = process.stdin, out = process.stderr } = {}) {
  if (fromStdin) {
    // stdin can be read only once: keep the line until forget() (HarnessClient.close()).
    let cached = null;
    return { kind: 'stdin', read: async () => (cached ??= await readStdinLine(stdin)), forget: () => { cached = ''; } };
  }
  return { kind: 'tty', read: (prompt) => readSecretFromTty(prompt, { stdin, out }) };
}

// ------------------------------------------------------------------------------------------------- HTTP
async function call(base, method, p, { body, headers = {}, token, cookie, timeoutMs = 120000 } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  if (cookie) h.cookie = cookie;
  const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : null;
  return { status: res.status, ok: res.ok, data, res };
}

const errCode = (r) => r?.data?.error?.code || null;
const errMsg = (r) => r?.data?.error?.message || `HTTP ${r?.status}`;
const fmtWait = (ms) => (ms >= 60000 ? `${Math.ceil(ms / 60000)} min` : `${Math.ceil(ms / 1000)} s`);

/**
 * An API session for one tool run.
 *   const c = new HarnessClient({ base, dataDir, password: passwordSource({ fromStdin }) });
 *   await c.ensureSession();            // unlocks (password mode) or uses the api-token file (keychain/off)
 *   const r = await c.request('GET', '/api/models');
 *   await c.withPassword((pw) => c.request('POST', '/api/network/allow', { minutes: 15, password: pw }));
 *   await c.close();                    // logout; the token is forgotten
 */
export class HarnessClient {
  #token = null;
  #cookie = null;
  #password = null; // only what the user typed during this run
  #via = null;

  constructor({ base, dataDir, password = passwordSource(), log = (m) => process.stderr.write(`${m}\n`), maxAttempts = 3 }) {
    this.base = base;
    this.dataDir = dataDir;
    this.pw = password;
    this.log = log;
    this.maxAttempts = password.kind === 'stdin' ? 1 : maxAttempts;
  }

  get authenticated() { return !!(this.#token || this.#cookie); }
  get via() { return this.#via; }

  async health() { return (await call(this.base, 'GET', '/api/health', { timeoutMs: 5000 })).data; }
  /** GET /api/security (no session needed). null on a 0.1 backend. */
  async security() {
    const r = await call(this.base, 'GET', '/api/security', { token: this.#token, cookie: this.#cookie, timeoutMs: 10000 });
    return r.ok ? r.data : null;
  }

  async #askPassword(prompt) {
    const pw = await this.pw.read(prompt);
    if (!pw) throw new HarnessError('no_password', 'No password given.');
    return pw;
  }

  /** The password typed during this run, asking for it once if needed (for confirmations, §10.3). */
  async password(prompt = 'Harness password: ') {
    if (this.#password === null) this.#password = await this.#askPassword(prompt);
    return this.#password;
  }

  /** Run fn(password); if Harness says the password is wrong, forget it and ask again (terminal only). */
  async withPassword(fn, prompt) {
    for (let attempt = 1; ; attempt++) {
      const pw = await this.password(prompt);
      const r = await fn(pw);
      if (errCode(r) === 'wrong_password' && attempt < this.maxAttempts) {
        this.#password = null;
        const wait = r.data?.error?.details?.retryAfterMs || 0;
        this.log(`That is not the Harness password.${wait ? ` Wait ${fmtWait(wait)} before trying again.` : ''}`);
        if (wait) await sleep(wait);
        continue;
      }
      if (errCode(r) === 'wrong_password') this.#password = null;
      return r;
    }
  }

  async #waitWhileMigrating(sec) {
    let last = -1;
    while (sec?.state === 'migrating') {
      const m = sec.migration;
      if (m && m.done !== last) { this.log(`Harness is ${m.op === 'decrypt' ? 'decrypting' : 'encrypting'} your data: ${m.done}/${m.total} files…`); last = m.done; }
      if (m?.error) throw new HarnessError('migration_failed', `Harness could not finish ${m.op}ing the data: ${m.error}`);
      await sleep(1000);
      sec = await this.security();
    }
    return sec;
  }

  #apiToken() {
    try { return fs.readFileSync(path.join(this.dataDir, 'api-token'), 'utf8').trim() || null; } catch { return null; }
  }

  #takeSession(r) {
    const t = r.data?.sessionToken;
    if (t) { this.#token = t; return true; }
    // Fallback: the session cookie (same session, §10.5) if the body carries no token.
    const set = r.res.headers.getSetCookie?.() || [];
    const c = set.map((s) => s.split(';')[0]).find((s) => s.startsWith('harness_session='));
    if (c) { this.#cookie = c; return true; }
    return false;
  }

  /**
   * Make sure this client can call the data routes. Throws HarnessError:
   *   needs_setup — no password chosen yet (open Harness to choose it); wrong_password / unlock_throttled;
   *   no_terminal — password needed but no terminal and no --password-stdin; legacy — a 0.1 backend.
   */
  async ensureSession({ reason = 'continue' } = {}) {
    let sec = await this.security();
    if (!sec) { this.#via = 'legacy'; return { state: 'unlocked', mode: 'none', legacy: true }; }
    sec = await this.#waitWhileMigrating(sec);
    if (sec.state === 'needs_setup') {
      throw new HarnessError('needs_setup', sec.plainDataFound
        ? 'Harness 0.2 encrypts your existing chats, but no password has been chosen yet. Open Harness (the app, Harness.command or `npm start -- --open`), choose a password there and save the recovery key it shows once; then run this again.'
        : 'Harness has no password yet. Open Harness first (the app, Harness.command or `npm start -- --open`), choose a password there and save the recovery key it shows once; then run this again.', { security: sec });
    }
    if (sec.session?.authenticated && this.authenticated) return sec;
    if (sec.mode === 'keychain' || sec.mode === 'off') {
      const token = this.#apiToken();
      if (token) {
        this.#token = token; this.#via = 'api-token';
        if (sec.state === 'locked' && sec.mode === 'keychain') {
          const r = await call(this.base, 'POST', '/api/security/unlock', { body: {}, token, timeoutMs: 60000 });
          if (!r.ok) throw new HarnessError(errCode(r) || 'unlock_failed', `Could not open Harness with the Keychain: ${errMsg(r)}`);
        }
        return this.security();
      }
      // No token file (e.g. another user's install): fall through to the password.
    }
    for (let attempt = 1; ; attempt++) {
      const retry = sec.unlock?.retryAfterMs || 0;
      if (retry > 0) {
        if (retry > 120000) throw new HarnessError('unlock_throttled', `Too many wrong passwords: Harness accepts the next try in ${fmtWait(retry)}.`);
        this.log(`Harness asks to wait ${fmtWait(retry)} before the next password attempt…`);
        await sleep(retry);
      }
      const pw = this.#password ?? await this.#askPassword(`Harness password (to ${reason}): `);
      const r = await call(this.base, 'POST', '/api/security/unlock', { body: { password: pw }, timeoutMs: 120000 });
      if (r.ok && this.#takeSession(r)) {
        this.#password = pw; this.#via = 'password';
        return this.#waitWhileMigrating(await this.security());
      }
      if (r.ok) throw new HarnessError('no_session', 'Harness accepted the password but returned no session (contract: sessionToken in the unlock response).');
      const code = errCode(r);
      this.#password = null;
      if (code === 'wrong_password' || code === 'unlock_throttled') {
        const wait = r.data?.error?.details?.retryAfterMs || 0;
        if (attempt >= this.maxAttempts) throw new HarnessError(code, code === 'wrong_password' ? 'Wrong Harness password.' : `Too many attempts; try again in ${fmtWait(wait)}.`, { retryAfterMs: wait });
        this.log(code === 'wrong_password' ? 'That is not the Harness password.' : 'Too many attempts.');
        sec = { ...sec, unlock: { retryAfterMs: wait } };
        continue;
      }
      throw new HarnessError(code || 'unlock_failed', `Could not unlock Harness: ${errMsg(r)}`);
    }
  }

  /** An authenticated request; if Harness locked meanwhile (423 / 401), unlock once more and repeat. */
  async request(method, p, body, { headers, timeoutMs } = {}) {
    let r = await call(this.base, method, p, { body, headers, token: this.#token, cookie: this.#cookie, timeoutMs });
    if (r.status === 423 || (r.status === 401 && errCode(r) === 'auth_required')) {
      this.#token = null; this.#cookie = null;
      await this.ensureSession({ reason: 'continue' });
      r = await call(this.base, method, p, { body, headers, token: this.#token, cookie: this.#cookie, timeoutMs });
    }
    return r;
  }

  /** Headers for a raw fetch (e.g. an SSE stream). */
  authHeaders() {
    const h = {};
    if (this.#token) h.authorization = `Bearer ${this.#token}`;
    if (this.#cookie) h.cookie = this.#cookie;
    return h;
  }

  /** Forget the password and drop the session (best effort). */
  async close() {
    const had = this.#via === 'password';
    this.#password = null;
    this.pw.forget?.();
    if (had && this.authenticated) await call(this.base, 'POST', '/api/auth/logout', { body: {}, token: this.#token, cookie: this.#cookie, timeoutMs: 5000 }).catch(() => {});
    this.#token = null; this.#cookie = null;
  }
}

/**
 * The Harness that serves `dataDir`: the running one, or one started in this process (stopped by close()).
 * @returns {Promise<{ base: string, srv: object|null, running: object|null, close(): Promise<void> }>}
 */
export async function reachHarness({ dataDir, port = 4747, start = true, startOptions = {}, log = () => {} }) {
  const running = await findRunningHarness({ dataDir, timeoutMs: 1500 });
  if (running) return { base: running.url, srv: null, running, close: async () => {} };
  if (!start) return null;
  const { startServer } = await import('../../server/index.mjs');
  try {
    const srv = await startServer({ port, dataDir, openBrowser: false, logLevel: 'warn', ...startOptions });
    log(`Started Harness for this step at ${srv.url} (stopped again at the end).`);
    return { base: srv.url, srv, running: null, close: async () => { await srv.close().catch(() => {}); } };
  } catch (e) {
    if (e?.code === 'HARNESS_ALREADY_RUNNING' && e.url) return { base: e.url, srv: null, running: { url: e.url, pid: e.pid ?? null }, close: async () => {} };
    throw e;
  }
}

/** One-line description of the internet blocker state (§10.6 offlineLock). */
export function describeOfflineLock(o) {
  if (!o) return 'unknown (this Harness predates the blocker)';
  if (!o.enabled) return 'OFF — Harness and the Ollama it starts can reach the internet';
  const os = o.osEnforced ? (o.osScope === 'backend' ? 'macOS sandbox around Harness and everything it starts' : o.osScope === 'ollama' ? 'macOS sandbox around the Ollama Harness started' : 'macOS sandbox') : 'no OS sandbox';
  const ext = o.externalOllama ? '; the Ollama in use was NOT started by Harness and is not confined' : '';
  if (!o.blocked) return `ALLOWED${o.allowedUntil ? ` until ${new Date(o.allowedUntil).toLocaleTimeString()}` : ''}${o.waitingFor ? ` (still waiting for: ${o.waitingFor})` : ''}${ext}`;
  return `ON — blocked in Harness's code + ${os}${ext}`;
}
