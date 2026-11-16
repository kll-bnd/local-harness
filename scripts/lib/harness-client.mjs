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
//   * A Harness this process did NOT start (found through <dataDir>/harness.lock, which any program running as the
//     user can write) gets the password only after it PROVED it holds this folder's data key: the password is first
//     checked locally against <dataDir>/vault.json (no request, no throttle counter), then the instance must answer
//     a fresh random nonce with HMAC(subkey of the data key, nonce, <the address and port we connected to>) — POST
//     /api/security/prove; the binding defeats a program that relays the nonce to the real Harness. A locked instance
//     cannot prove anything and never gets the password. The data key never leaves this process and is wiped
//     right after the comparison.
//   * Only http://127.0.0.1:<port> is ever contacted. The lock file's `url` (and the backend's HARNESS_ALREADY_RUNNING
//     error, which carries it) is never used; a lock written on another computer is never contacted; redirects are
//     never followed (a 3xx answer is an error).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { openDataKeyWithPassword, instanceProof, proofBinding, validVault } from './instance-proof.mjs';

const require = createRequire(import.meta.url);
const { findRunningHarness, findAppHarness, lockElsewhere, loopbackUrl } = require('../../electron/lib/instance.cjs');

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
/**
 * `base` when it is exactly http://127.0.0.1:<port 1–65535> (no user, path, query or other host), else null. The only
 * kind of address this client talks to.
 */
export function loopbackBase(base) {
  const m = typeof base === 'string' ? /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/.exec(base) : null;
  return m ? loopbackUrl(m[1]) : null;
}

/** A redirect is never followed: the password, a token or a proof must not travel on to wherever it points. */
export function redirectError(base, status) {
  return new HarnessError('redirect_refused', `The program at ${base} answered with a redirect (HTTP ${status}). This tool does not follow redirects; nothing was sent on.`);
}

/** fetch for the tools: never follows a redirect (3xx → HarnessError redirect_refused). */
export async function safeFetch(url, init = {}) {
  const res = await fetch(url, { ...init, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    res.body?.cancel?.().catch?.(() => {});
    throw redirectError(new URL(url).origin, res.status);
  }
  return res;
}

async function call(base, method, p, { body, headers = {}, token, cookie, timeoutMs = 120000 } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  if (cookie) h.cookie = cookie;
  const res = await safeFetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : null;
  return { status: res.status, ok: res.ok, data, res };
}

const errCode = (r) => r?.data?.error?.code || null;

/** State `error` (§10.1): the key store is unusable. Never suggest setting up again — that cannot help. */
export function vaultError(sec) {
  const code = sec?.error?.code || 'vault_error';
  const what = code === 'vault_missing'
    ? 'Harness found encrypted data but no key store (vault.json) next to it.'
    : 'Harness\'s key store (vault.json, and its copy vault.json.bak) is damaged.';
  return new HarnessError(code, `${what} Your data is still encrypted and nothing was changed. Restore vault.json from a backup of the Harness data folder (Time Machine, or a copy you made), then open Harness again. Do not choose a new password: that cannot open the existing data.${sec?.error?.message ? `\n(Harness says: ${sec.error.message})` : ''}`, { security: sec });
}
const errMsg = (r) => r?.data?.error?.message || `HTTP ${r?.status}`;

/** A discovered Harness that is locked: it cannot prove anything, so it does not get the password. */
export function lockedInstanceError(base) {
  return new HarnessError('instance_locked', `Harness is running at ${base} but it is locked. This tool does not send your password to a Harness it did not start while that Harness is locked. Unlock it in its own window (or quit it), then run this again.`);
}

/** A discovered program that could not prove it holds this data folder's key. The password was not sent. */
export function unverifiedInstanceError(base, why) {
  return new HarnessError('instance_unverified', `The program answering at ${base} could not prove that it has this Harness data folder open (${why}), so your password was NOT sent to it. Quit whatever is running there — or restart your Mac if you don't know what it is — then run \`npm run doctor\` and try again.`);
}
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

  /**
   * @param {object} o
   * @param {boolean} [o.inProcess=false]  true only for a backend THIS process started (reachHarness().srv): the
   *   password then goes to our own process. Anything else must prove it holds the data key first.
   */
  constructor({ base, dataDir, password = passwordSource(), log = (m) => process.stderr.write(`${m}\n`), maxAttempts = 3, inProcess = false }) {
    if (!loopbackBase(base)) throw new HarnessError('instance_address', `Not a local Harness address: ${String(base).slice(0, 200)}. This tool only talks to http://127.0.0.1:<port>.`);
    this.base = loopbackBase(base);
    this.inProcess = inProcess === true;
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
    if (!this.inProcess) return this.#verifiedPassword(prompt);
    if (this.#password === null) this.#password = await this.#askPassword(prompt);
    return this.#password;
  }

  /**
   * For a Harness we did not start: the password, checked LOCALLY against vault.json (asked again on a terminal
   * when wrong — the instance sees nothing), and only returned once the instance proved it holds the data key.
   */
  async #verifiedPassword(prompt) {
    let vault;
    try { vault = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'vault.json'), 'utf8')); } catch { vault = null; }
    if (!vault?.wraps?.password) {
      this.#password = null;
      throw unverifiedInstanceError(this.base, 'this folder has no readable key store to check your password against');
    }
    // Not a wrong password: a key store this tool cannot check (damaged, or key-derivation parameters outside the
    // accepted bounds). Say so instead of asking again.
    if (!validVault(vault)) {
      this.#password = null;
      throw unverifiedInstanceError(this.base, 'this folder\'s key store (vault.json) cannot be checked here: it is not a valid Harness key store — run `npm run doctor`');
    }
    for (let attempt = 1; ; attempt++) {
      const pw = this.#password ?? await this.#askPassword(prompt);
      const key = await openDataKeyWithPassword(vault, pw).catch(() => null);
      if (!key) {
        this.#password = null;
        if (attempt >= this.maxAttempts) throw new HarnessError('wrong_password', 'Wrong Harness password.');
        this.log('That is not the Harness password.');
        continue;
      }
      try {
        await this.#proveInstance(key);
      } catch (e) {
        this.#password = null;
        throw e;
      } finally {
        key.fill(0);
      }
      this.#password = pw;
      return pw;
    }
  }

  /** Fresh nonce → POST /api/security/prove → constant-time comparison. Throws instance_unverified. */
  async #proveInstance(key) {
    const nonce = crypto.randomBytes(32);
    let r;
    try {
      r = await call(this.base, 'POST', '/api/security/prove', { body: { nonce: nonce.toString('base64url') }, timeoutMs: 15000 });
    } catch (e) {
      throw unverifiedInstanceError(this.base, e?.code === 'redirect_refused' ? 'it answered the proof request with a redirect' : 'it did not answer the proof request');
    }
    if (r.status === 423) throw unverifiedInstanceError(this.base, 'it says it is locked');
    if (!r.ok) throw unverifiedInstanceError(this.base, `it answered the proof request with HTTP ${r.status}`);
    let expected;
    try {
      expected = instanceProof(key, nonce, bindingFor(this.base));
    } catch {
      throw unverifiedInstanceError(this.base, 'its address has no port to bind the proof to');
    }
    let got = null;
    try { got = typeof r.data?.proof === 'string' ? Buffer.from(r.data.proof, 'base64url') : null; } catch { got = null; }
    const ok = !!got && got.length === expected.length && crypto.timingSafeEqual(got, expected);
    expected.fill(0);
    if (!ok) throw unverifiedInstanceError(this.base, 'its proof does not match this folder\'s key');
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

  /** The bearer token Harness returns when asked for one (`"session": "token"`, §10.3); nothing else is used. */
  #takeSession(r) {
    const t = r.data?.sessionToken;
    if (!t) return false;
    this.#token = t;
    return true;
  }

  /**
   * Make sure this client can call the data routes. Throws HarnessError:
   *   needs_setup — no password chosen yet (open Harness to choose it); wrong_password / unlock_throttled;
   *   no_terminal — password needed but no terminal and no --password-stdin; legacy — a 0.1 backend.
   */
  async ensureSession({ reason = 'continue' } = {}) {
    let sec = await this.security();
    if (!sec) { this.#via = 'legacy'; return { state: 'unlocked', mode: 'none', legacy: true }; }
    if (sec.state === 'error') throw vaultError(sec);
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
        if (sec.state !== 'locked' || sec.mode !== 'keychain') return this.security();
        // Keychain items can need a macOS prompt; Harness gives up after 60 s and the password still works.
        const r = await call(this.base, 'POST', '/api/security/unlock', { body: {}, token, timeoutMs: 75000 });
        if (r.ok) return this.security();
        if (/^vault_/.test(errCode(r) || '')) throw vaultError({ error: r.data.error });
        this.log(`The Keychain did not open Harness (${errMsg(r)}); your password still does.`);
        this.#token = null;
        this.#via = null;
      }
      // No token file, or the Keychain refused: fall through to the password.
    }
    if (!this.inProcess && sec.state !== 'unlocked' && sec.state !== 'migrating') throw lockedInstanceError(this.base);
    for (let attempt = 1; ; attempt++) {
      const retry = sec.unlock?.retryAfterMs || 0;
      if (retry > 0) {
        if (retry > 120000) throw new HarnessError('unlock_throttled', `Too many wrong passwords: Harness accepts the next try in ${fmtWait(retry)}.`);
        this.log(`Harness asks to wait ${fmtWait(retry)} before the next password attempt…`);
        await sleep(retry);
      }
      // A Harness we did not start gets the password only after proving it holds the data key (see above).
      const pw = this.inProcess
        ? this.#password ?? await this.#askPassword(`Harness password (to ${reason}): `)
        : await this.#verifiedPassword(`Harness password (to ${reason}): `);
      // Ask explicitly for a bearer token: browsers only ever get the HttpOnly cookie (§10.3).
      const r = await call(this.base, 'POST', '/api/security/unlock', { body: { password: pw, session: 'token' }, timeoutMs: 120000 });
      if (r.ok && this.#takeSession(r)) {
        this.#password = pw; this.#via = 'password';
        return this.#waitWhileMigrating(await this.security());
      }
      if (r.ok) throw new HarnessError('no_session', 'Harness accepted the password but returned no session token.');
      const code = errCode(r);
      if (/^vault_/.test(code || '')) throw vaultError({ error: r.data.error });
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
    if ((r.status === 409 || r.status === 503) && /^vault_/.test(errCode(r) || '')) throw vaultError({ error: r.data.error });
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
 * The proof binding for the literal address and port this client connects to (always 127.0.0.1 here — see
 * loopbackBase): a program on the same port at another loopback address (127.0.0.2, ::1) that relays the nonce gets
 * a proof bound to where the genuine Harness received it, which does not match.
 */
export function bindingFor(base) {
  const u = new URL(loopbackBase(base));
  return proofBinding({ address: u.hostname, port: Number(u.port) });
}

/** The lock was written on another computer: nothing there is contacted. */
export function elsewhereError(other) {
  const e = new HarnessError('HARNESS_ELSEWHERE', `This Harness data folder is in use by Harness on another computer (${other.hostname}). This tool does not connect to it. Quit Harness there and run this again. (If Harness is not running there, the file harness.lock in the data folder is left over from it: delete that file.)`);
  e.hostname = other.hostname;
  e.pid = other.pid ?? null;
  return e;
}

/** Another process holds the lock but no Harness answers at the 127.0.0.1 port it names (still starting, or not Harness). */
export function busyError(pid) {
  const e = new HarnessError('HARNESS_BUSY', `Another program (pid ${pid ?? '?'}) holds this Harness data folder, but no Harness answers at the local address its lock names. Wait until it has started, or quit it, then run this again.`);
  e.pid = pid ?? null;
  return e;
}

/**
 * The native app holds the data folder. Its backend has no local address (no listening socket, by design), so a
 * command-line tool can neither use it nor start a second backend on the same folder.
 */
export function inAppError(pid) {
  const e = new Error(`Harness is open in the Harness app (pid ${pid ?? '?'}). The app has no local address this tool could talk to — that is by design. Do this step in the app, or quit the app (⌘Q) and run this again.`);
  e.code = 'HARNESS_IN_APP';
  e.pid = pid ?? null;
  return e;
}

/** The native app's backend when it holds `dataDir` (see findAppHarness), else null. */
export function appHarness(dataDir) {
  return findAppHarness({ dataDir });
}

/**
 * The Harness that serves `dataDir`: the running one, or one started in this process (stopped by close()).
 * Throws an error with code HARNESS_IN_APP when the native app holds the folder.
 * @returns {Promise<{ base: string, srv: object|null, running: object|null, close(): Promise<void> }>}
 */
export async function reachHarness({ dataDir, port = 4747, start = true, startOptions = {}, log = () => {}, raceWaitMs = 5000 }) {
  const far = lockElsewhere({ dataDir });
  if (far) throw elsewhereError(far);
  // `running` / no `srv`: an instance found through the lock file — NOT authenticated (HarnessClient proves it).
  // Its URL is always http://127.0.0.1:<the lock's port> (instance.cjs), never the lock's `url`.
  const running = await findRunningHarness({ dataDir, timeoutMs: 1500 });
  if (running) return { base: running.url, srv: null, running, close: async () => {} };
  const app = findAppHarness({ dataDir });
  if (app) throw inAppError(app.pid);
  if (!start) return null;
  const { startServer } = await import('../../server/index.mjs');
  try {
    const srv = await startServer({ port, dataDir, openBrowser: false, logLevel: 'warn', ...startOptions });
    log(`Started Harness for this step at ${srv.url} (stopped again at the end).`);
    return { base: srv.url, srv, running: null, close: async () => { await srv.close().catch(() => {}); } };
  } catch (e) {
    if (e?.code !== 'HARNESS_ALREADY_RUNNING') throw e;
    // Another process holds the folder (it started after the check above, or its lock names another computer). The
    // error's `url` comes from the lock file and is never used: look again the same way as above.
    const other = lockElsewhere({ dataDir }) || (e.otherComputer ? { hostname: 'name unknown', pid: null } : null);
    if (other) throw elsewhereError(other);
    if (e.transport === 'bridge') throw inAppError(e.pid);
    for (const until = Date.now() + raceWaitMs; ;) {
      const found = await findRunningHarness({ dataDir, timeoutMs: 1000 });
      if (found) return { base: found.url, srv: null, running: found, close: async () => {} };
      const inApp = findAppHarness({ dataDir });
      if (inApp) throw inAppError(inApp.pid);
      if (Date.now() >= until) throw busyError(e.pid);
      await sleep(250);
    }
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
