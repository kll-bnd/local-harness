// Where the keychain-mode key lives (only in "keychain" mode; never in the default password mode).
//
// macOS: a generic-password item in the login Keychain — service `local.harness`, account `data-key`,
// label `Harness data key`, value base64 of 32 random bytes — the same item the native app reads with the
// Security framework. It is driven through `/usr/bin/security -i` with the commands (and the value) written to its
// stdin, never in argv or the environment, so the key does not show up in `ps`. What this protects: other user
// accounts, a copied disk or a stolen backup. What it does not: any program running as this user can run
// `security find-generic-password` too (macOS may ask the user first, depending on the item's access list).
//
// Prompts: an item created by the native app cannot be read by /usr/bin/security without a macOS prompt, and vice
// versa (and an app rebuilt with a new signature gets one prompt), so each side may ask the user once. A call that
// is denied, or that waits for a prompt nobody answers, ends with a KeychainError (`denied` / `timeout`) after at
// most KEYCHAIN_TIMEOUT_MS instead of hanging; Harness then stays locked and the password still opens it.
//
// Elsewhere (development, CI): a 0600 file `.dev-keychain` in the data directory — clearly NOT protection.
//
// Which store (chooseKeychain): the real Keychain only for the default data folder, and never in a test run, unless
// HARNESS_KEYCHAIN=mac opts in; HARNESS_KEYCHAIN=file forces the development stand-in. Items are scoped to their
// data folder: account `data-key` for the default folder (the name the native app uses), `data-key-<16 hex of
// SHA-256 of the folder's real path>` for any other, so two installations never clobber each other's key. A refused
// store answers every read with KeychainError('not_allowed') and never deletes anything.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const KEYCHAIN_SERVICE = 'local.harness';
export const KEYCHAIN_ACCOUNT = 'data-key';
const realpath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** The platform's default data folder (what defaultDataDir() gives without HARNESS_DATA_DIR). */
export function platformDataDir(platform = process.platform, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Harness');
  if (platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Harness');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'harness');
}

export function isDefaultDataDir(dataDir, { defaultDir = platformDataDir() } = {}) {
  return realpath(dataDir) === realpath(defaultDir);
}

/** The Keychain account for a data folder: `data-key` for the default one, a derived name for any other. */
export function keychainAccountFor(dataDir, opts) {
  if (isDefaultDataDir(dataDir, opts)) return KEYCHAIN_ACCOUNT;
  return `${KEYCHAIN_ACCOUNT}-${crypto.createHash('sha256').update(realpath(dataDir)).digest('hex').slice(0, 16)}`;
}
export const KEYCHAIN_LABEL = 'Harness data key';

const B64_32 = /^[A-Za-z0-9+/]{43}=$/;
export const KEYCHAIN_TIMEOUT_MS = Number(process.env.HARNESS_KEYCHAIN_TIMEOUT_MS) || 60000;

/** reason: 'denied' (the user or macOS refused), 'timeout' (no answer — a prompt may be waiting), 'failed'. */
export class KeychainError extends Error {
  constructor(reason, message) { super(message); this.reason = reason; this.code = `keychain_${reason}`; }
}

export function runSecurity(bin, commands, { timeoutMs = KEYCHAIN_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, ['-i'], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { resolve({ ok: false, out: '', err: e.message, failed: true }); return; }
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out, err: e.message, failed: true }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0 && !timedOut, code, out, err, timedOut }); });
    child.stdin.on('error', () => {});
    child.stdin.end(commands.join('\n') + '\n');
  });
}

// security(1) messages: -25300 errSecItemNotFound; -128 userCanceled; -25293 errSecAuthFailed;
// -25308 errSecInteractionNotAllowed (no UI possible, e.g. a locked login keychain over SSH).
const NOT_FOUND = /could not be found|-25300/i;
const DENIED = /user canceled|cancelled|-128\b|-25293|-25308|interaction is not allowed|not permitted|authorization/i;

function classify(r, action) {
  if (r.timedOut) return new KeychainError('timeout', `The Keychain did not answer in time while ${action} (a macOS prompt may be waiting for an answer). Harness stays locked; the password still opens it.`);
  if (r.failed) return new KeychainError('failed', `Could not run the Keychain tool while ${action}.`);
  if (DENIED.test(r.err)) return new KeychainError('denied', `The Keychain refused access while ${action} (the prompt was denied or cannot be shown). Harness stays locked; the password still opens it.`);
  return null;
}

/**
 * The macOS login Keychain via /usr/bin/security (the binary, service, account and label are injectable: tests,
 * and the per-folder account of keychainAccountFor()).
 */
export function macKeychain({ securityBin = process.env.HARNESS_SECURITY_BIN || '/usr/bin/security', timeoutMs = KEYCHAIN_TIMEOUT_MS, service = KEYCHAIN_SERVICE, account = KEYCHAIN_ACCOUNT, label = KEYCHAIN_LABEL } = {}) {
  const q = (s) => `"${String(s).replace(/["\\]/g, '\\$&')}"`;
  const KEYCHAIN_SERVICE = service;
  const KEYCHAIN_ACCOUNT = account;
  const KEYCHAIN_LABEL = label;
  return {
    kind: 'keychain',
    service,
    account,
    /** The stored key, or null when there is no item. Throws KeychainError when access is denied or times out. */
    async get() {
      const r = await runSecurity(securityBin, [`find-generic-password -s ${q(KEYCHAIN_SERVICE)} -a ${q(KEYCHAIN_ACCOUNT)} -w`], { timeoutMs });
      const line = r.out.split(/\r?\n/).map((l) => l.trim().replace(/^security>\s*/, '')).find((l) => B64_32.test(l));
      if (line) return Buffer.from(line, 'base64');
      const e = classify(r, 'reading the Harness key');
      if (e) throw e;
      return null; // not found (or an unexpected answer): no key
    },
    async set(key) {
      const v = Buffer.from(key).toString('base64');
      const r = await runSecurity(securityBin, [`add-generic-password -U -s ${q(KEYCHAIN_SERVICE)} -a ${q(KEYCHAIN_ACCOUNT)} -l ${q(KEYCHAIN_LABEL)} -w ${v}`], { timeoutMs });
      const e = classify(r, 'storing the Harness key');
      if (e) throw e;
      const back = await this.get();
      if (!back || !back.equals(Buffer.from(key))) throw new KeychainError('failed', 'The Keychain did not give back the stored key.');
    },
    async delete() {
      const r = await runSecurity(securityBin, [`delete-generic-password -s ${q(KEYCHAIN_SERVICE)} -a ${q(KEYCHAIN_ACCOUNT)}`], { timeoutMs });
      if (NOT_FOUND.test(r.err)) return;
      const e = classify(r, 'removing the Harness key');
      if (e) throw e;
    },
  };
}

/** Development / non-macOS stand-in: a 0600 file next to the data. Not a protection. */
export function fileKeychain(dataDir) {
  const file = path.join(dataDir, '.dev-keychain');
  return {
    kind: 'file',
    async get() { try { const v = fs.readFileSync(file, 'utf8').trim(); return B64_32.test(v) ? Buffer.from(v, 'base64') : null; } catch { return null; } },
    async set(key) { fs.writeFileSync(file, Buffer.from(key).toString('base64') + '\n', { mode: 0o600 }); },
    async delete() { fs.rmSync(file, { force: true }); },
  };
}

/** Bridge mode: the native app keeps the item; the backend only hands it over (`keychain-key` event). */
export function appKeychain({ initialKey = null, emit }) {
  let key = initialKey ? Buffer.from(initialKey) : null;
  return {
    kind: 'app',
    async get() { return key; },
    async set(k) { key = Buffer.from(k); emit({ type: 'keychain-key', dataKey: key.toString('base64') }); },
    async delete() { key = null; emit({ type: 'keychain-key', dataKey: null }); },
  };
}

/** A store that refuses: the real Keychain is not allowed for this folder / run. Never deletes anything. */
export function refusedKeychain(message) {
  return {
    kind: 'refused',
    async get() { throw new KeychainError('not_allowed', message); },
    async set() { throw new KeychainError('not_allowed', message); },
    async delete() { /* never */ },
  };
}

/**
 * Where keychain mode keeps its key for `dataDir` (listener mode; the bridge uses appKeychain).
 * @param {object} [o]
 * @param {'mac'|'file'|null} [o.kind]  explicit choice (startServer option or HARNESS_KEYCHAIN); null = none
 */
export function chooseKeychain(dataDir, { kind = process.env.HARNESS_KEYCHAIN || null, platform = process.platform, testRun = !!process.env.NODE_TEST_CONTEXT, defaultDir } = {}) {
  if (kind === 'file' || kind === 'dev') return fileKeychain(dataDir);
  if (platform !== 'darwin') return fileKeychain(dataDir); // no Keychain outside macOS (development only)
  const opts = defaultDir ? { defaultDir } : undefined;
  if (kind !== 'mac') {
    if (testRun) return refusedKeychain('The macOS Keychain is never used by a test run (set HARNESS_KEYCHAIN=file for the development stand-in).');
    if (!isDefaultDataDir(dataDir, opts)) return refusedKeychain('The macOS Keychain is used only for the default Harness data folder; set HARNESS_KEYCHAIN=mac to use it for this folder too. The password still opens Harness.');
  }
  return macKeychain({ account: keychainAccountFor(dataDir, opts) });
}

/** @deprecated use chooseKeychain (kept for callers of 0.2 previews). */
export function platformKeychain(dataDir, platform = process.platform) {
  return chooseKeychain(dataDir, { platform });
}
