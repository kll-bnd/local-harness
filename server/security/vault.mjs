// The key store of an encrypted data directory: vault.json (plain, 0600) holds only WRAPPED copies of the random
// data key — under a key derived from the user's password (scrypt), under the recovery key (HKDF) and, in keychain
// mode, under a random key kept in the Keychain — plus the unlock throttle, migration progress and the SECURITY
// RECORD (`state`). The data key itself exists only in memory while Harness is unlocked.
//
// The security record (docs/API.md §10.2) is the authenticated truth about what lowers protection: the mode, the
// internet blocker and its allow window, and a conversion in progress. It is sealed (AES-256-GCM) under a key
// derived from the data key, so nobody without the key can write or change it; a counter (`seq`) is mirrored into
// vault-seq.json (sealed the same way), so an older copy of vault.json put back on its own is recognised as stale.
// Every other field of vault.json and all of launch.json are hints that may only ever make Harness MORE protective.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { seal, unseal, deriveKey, newKdf, hkdf, formatRecoveryKey, parseRecoveryKey, keyIdOf, wipe, kdfDefaultsNow, kdfWithinBounds } from './crypto.mjs';
import { HttpError } from '../lib/errors.mjs';

export const MIN_PASSWORD = 8;
const AAD = (name) => `harness-wrap-v1:${name}`;
const STATE_AAD = (keyId) => `harness-state-v1:${keyId}`;
const WRAPS = ['password', 'recovery', 'keychain', 'previous'];
const MIRROR_AAD = (keyId) => `harness-state-mirror-v1:${keyId}`;
export const STATE_MIRROR = 'vault-seq.json';
export const STATE_MODES = Object.freeze(['password', 'keychain', 'off']);
const MIGRATION_OPS = new Set(['encrypt', 'decrypt', 'reencrypt']);
const ISO = (v) => v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));

/** Shape check of an opened security record (it authenticated; this guards against our own older formats). */
export function validState(s) {
  if (!s || typeof s !== 'object' || s.v !== 1 || !Number.isInteger(s.seq) || s.seq < 1) return false;
  if (!STATE_MODES.includes(s.mode) || typeof s.encrypted !== 'boolean' || typeof s.offlineLock !== 'boolean') return false;
  if (!ISO(s.allowedUntil ?? null) || !ISO(s.allowFrom ?? null) || typeof s.keyId !== 'string') return false;
  const m = s.migration;
  if (m !== null && (typeof m !== 'object' || !MIGRATION_OPS.has(m.op) || typeof m.id !== 'string')) return false;
  if (m?.op === 'reencrypt' && !isSealed(m.oldKey)) return false;
  const t = s.tamper;
  if (t !== null && (typeof t !== 'object' || !Array.isArray(t.fields))) return false;
  return true;
}

/**
 * Unlock throttle: the wait before the next attempt after `failures` counted attempts — attempts 1–3 free, then
 * 1 s before the 4th, 2 s before the 5th, … up to 5 minutes. Every attempt is counted (and persisted) BEFORE the
 * key derivation starts, so concurrent guesses cannot share one window.
 */
export function throttleDelay(failures) {
  return failures < 3 ? 0 : Math.min(300000, 1000 * 2 ** (failures - 3));
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const isSealed = (w) => !!w && typeof w.nonce === 'string' && B64.test(w.nonce) && typeof w.data === 'string' && B64.test(w.data);

/** Schema check: a key store that cannot open anything must never be taken for one. */
export function validVault(m) {
  if (!m || typeof m !== 'object' || m.version !== 1 || typeof m.encrypted !== 'boolean') return false;
  if (typeof m.keyId !== 'string' || !/^[0-9a-f]{16}$/.test(m.keyId)) return false;
  const w = m.wraps;
  if (!w || typeof w !== 'object') return false;
  if (!isSealed(w.password) || !kdfWithinBounds(w.password.kdf)) return false;
  if (w.recovery !== undefined && w.recovery !== null && (!isSealed(w.recovery) || typeof w.recovery.kdf?.salt !== 'string')) return false;
  if (w.keychain !== undefined && !isSealed(w.keychain)) return false;
  const pv = w.previous;
  if (pv !== undefined && pv !== null && !(typeof pv.keyId === 'string' && /^[0-9a-f]{16}$/.test(pv.keyId) && isSealed(pv.password) && (pv.recovery === undefined || isSealed(pv.recovery)))) return false;
  if (m.state !== undefined && m.state !== null && !isSealed(m.state)) return false;
  return true;
}

/**
 * The data key from a parsed vault.json and a password — PURE: no throttle bookkeeping, no file written, nothing
 * logged (the vault's own unlock uses it, then counts the attempt itself). null for a wrong password, a key store
 * that is not valid (key-derivation parameters outside the accepted bounds included) or one without a password
 * wrap. The CALLER OWNS the returned key and must wipe it (`buf.fill(0)`) when done.
 * @returns {Promise<Buffer|null>}
 */
export async function openDataKeyWithPassword(vault, password) {
  const { dek, previous } = await openPasswordWraps(vault, password);
  wipe(previous);
  return dek;
}

/**
 * Like openDataKeyWithPassword, plus — while a re-key runs — the PREVIOUS data key, which the same password-derived
 * key also wraps (`wraps.previous`), so the old key never exists in one place only. PURE; the caller wipes both.
 * @returns {Promise<{ dek: Buffer|null, previous: Buffer|null }>}
 */
export async function openPasswordWraps(vault, password) {
  if (typeof password !== 'string' || !password || !validVault(vault)) return { dek: null, previous: null };
  const w = vault.wraps.password;
  const kek = await deriveKey(password, w.kdf);
  try {
    const dek = unseal(kek, w, AAD('password'));
    return { dek, previous: dek ? openPrevious(kek, vault.wraps.previous, 'password') : null };
  } finally { wipe(kek); }
}

/** The previous data key from its wrap under `kek` (the same key that opened the current one), checked by key id. */
function openPrevious(kek, pv, which) {
  if (!pv?.[which]) return null;
  const k = unseal(kek, pv[which], AAD(`previous-${which}`));
  if (k && keyIdOf(k).toString('hex') === pv.keyId) return k;
  wipe(k);
  return null;
}

/** Seal `key` under `kek` and check it opens again before anything is written (key material is never written unread). */
function sealChecked(kek, key, aad) {
  const w = seal(kek, key, aad);
  const back = unseal(kek, w, aad);
  const ok = !!back && back.equals(key);
  wipe(back);
  if (!ok) throw new HttpError(500, 'vault_write_failed', 'Could not write the Harness key store safely; nothing was changed.');
  return w;
}

function readVaultFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, missing: e.code === 'ENOENT' }; }
  try { const meta = JSON.parse(text); return validVault(meta) ? { ok: true, meta } : { ok: false, missing: false }; } catch { return { ok: false, missing: false }; }
}

export class Vault {
  constructor(dataDir, { kdf } = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'vault.json');
    this.kdfParams = kdf || null;
    this.meta = null;
    this.dek = null;
    this.stateKey = null; // seals the security record; derived from the data key (kept alone in off mode)
    this.stateSeq = 0; // the highest record counter seen or written in this process
    this.record = null; // the last security record opened (current) or written in this process
    this.previousKey = null; // during a re-key: the previous data key, opened from wraps.previous with the password
    this.mirrorFile = path.join(dataDir, STATE_MIRROR);
    // key material in memory that this process opened or wrote itself (wraps by name, and 'state'): only that may
    // replace the copy in vault.json.bak — anything else there is kept, so an edited vault.json cannot overwrite it
    this.verified = new Set();
  }

  /**
   * Read vault.json; if it is unreadable, truncated or not a valid key store, fall back to the verified copy
   * vault.json.bak (restoring it). Both bad → throws 503 vault_corrupt. Missing (and no copy) → meta null.
   */
  load() {
    this.restoredFromBackup = false;
    const main = readVaultFile(this.file);
    if (main.ok) { this.meta = main.meta; return this; }
    const bak = readVaultFile(this.file + '.bak');
    if (bak.ok) {
      this.meta = bak.meta;
      this.restoredFromBackup = true;
      this.save();
      return this;
    }
    if (main.missing && bak.missing) { this.meta = null; return this; }
    throw new HttpError(503, 'vault_corrupt', 'The Harness key store (vault.json) is damaged and its backup copy cannot be used. Nothing has been changed; restore vault.json from a backup of this folder.');
  }

  get exists() { return !!this.meta; }
  get encrypted() { return !!this.meta?.encrypted; }
  get unlocked() { return !!this.dek; }
  get hasPassword() { return !!this.meta?.wraps?.password; }
  get keyId() { return this.meta?.keyId || null; }

  /**
   * Atomic and verified: write a temporary file, fsync, read it back and compare, rename; then the same for the
   * copy vault.json.bak — so at every moment at least one of the two is a complete, valid key store.
   */
  save() {
    for (const [target, meta] of [[this.file, this.meta], [this.file + '.bak', this._bakMetaFor(this.meta)]]) {
      const text = JSON.stringify(meta, null, 2) + '\n';
      const tmp = `${target}.${process.pid}.tmp`;
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (fs.readFileSync(tmp, 'utf8') !== text || !validVault(JSON.parse(text))) {
        fs.rmSync(tmp, { force: true });
        throw new HttpError(500, 'vault_write_failed', 'Could not write the Harness key store safely; nothing was changed.');
      }
      fs.renameSync(tmp, target);
    }
    try { const dfd = fs.openSync(path.dirname(this.file), 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch { /* not supported everywhere */ }
  }

  /**
   * What goes into vault.json.bak: `meta`, except key material this process has not opened or written itself —
   * for that, the copy already in vault.json.bak stays (so a throttle count saved before the password is even
   * checked, say, never carries a damaged or replaced wrap or record over the intact copy).
   */
  _bakMetaFor(meta) {
    const cur = readVaultFile(this.file + '.bak');
    if (!cur.ok || cur.meta.keyId !== meta.keyId) return meta;
    const out = structuredClone(meta);
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    for (const w of WRAPS) {
      if (this.verified.has(w) || same(cur.meta.wraps[w], meta.wraps[w])) continue;
      if (cur.meta.wraps[w] === undefined) delete out.wraps[w]; else out.wraps[w] = cur.meta.wraps[w];
    }
    if (!this.verified.has('state') && !same(cur.meta.state, meta.state)) { if (cur.meta.state === undefined) delete out.state; else out.state = cur.meta.state; }
    return validVault(out) ? out : meta;
  }

  /** A wrap that did not open from vault.json: the one in vault.json.bak, if it differs (null otherwise). */
  _bakWraps() {
    const cur = readVaultFile(this.file + '.bak');
    return cur.ok && cur.meta.keyId === this.meta?.keyId ? cur.meta : null;
  }

  // ----------------------------------------------------------------------------------------- creation
  /** First setup: a new data key wrapped under the password and a new recovery key (returned once). */
  async create(password, { encrypted = true, state, migration = null } = {}) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new HttpError(400, 'weak_password', `Choose a password of at least ${MIN_PASSWORD} characters.`);
    const dek = crypto.randomBytes(32);
    this.meta = { version: 1, encrypted, keyId: keyIdOf(dek).toString('hex'), wraps: {}, throttle: { failures: 0, lastFailureAt: null }, migration, createdAt: new Date().toISOString() };
    await this._wrapPassword(dek, password);
    const recoveryKey = this._wrapRecovery(dek);
    this.dek = dek;
    this._deriveStateKey();
    this.record = null;
    this.verified = new Set([...WRAPS, 'state']);
    const rec = state ? this._sealState({ prevKeyId: null, tamper: null, ...state }) : null;
    this.save();
    if (rec) { this.record = rec; this.stateSeq = rec.seq; this._writeMirror(rec.seq); }
    return recoveryKey;
  }

  /** The password wrap of `dek` — and with `previous`, that key too, under the same password-derived key. */
  async _wrapPassword(dek, password, meta = this.meta, { previous = null } = {}) {
    const kdf = newKdf(this.kdfParams || kdfDefaultsNow());
    const kek = await deriveKey(password, kdf);
    try {
      meta.wraps.password = { kdf, ...sealChecked(kek, dek, AAD('password')) };
      if (previous) meta.wraps.previous = { ...(meta.wraps.previous || {}), keyId: keyIdOf(previous).toString('hex'), password: sealChecked(kek, previous, AAD('previous-password')) };
      if (meta === this.meta) { this.verified.add('password'); if (previous) this.verified.add('previous'); }
    } finally { wipe(kek); }
  }

  _wrapRecovery(dek, meta = this.meta, { previous = null } = {}) {
    const rk = crypto.randomBytes(32);
    const salt = crypto.randomBytes(16);
    const kek = hkdf(rk, salt, 'harness recovery v1');
    try {
      meta.wraps.recovery = { kdf: { name: 'hkdf-sha256', salt: salt.toString('base64') }, ...sealChecked(kek, dek, AAD('recovery')), createdAt: new Date().toISOString() };
      if (previous) meta.wraps.previous = { ...(meta.wraps.previous || {}), keyId: keyIdOf(previous).toString('hex'), recovery: sealChecked(kek, previous, AAD('previous-recovery')) };
      if (meta === this.meta) { this.verified.add('recovery'); if (previous) this.verified.add('previous'); }
      return formatRecoveryKey(rk);
    } finally { wipe(kek); wipe(rk); }
  }

  // ----------------------------------------------------------------------------------------- unlocking
  retryAfterMs() {
    const t = this.meta?.throttle;
    if (!t?.failures) return 0;
    const wait = throttleDelay(t.failures);
    return Math.max(0, Date.parse(t.lastFailureAt || 0) + wait - Date.now());
  }

  /**
   * One guess: refused with 429 (and no key derivation) while the wait is running; otherwise counted and persisted
   * NOW, before the slow KDF — synchronously, so overlapping requests each see the previous one's count. A
   * success resets the count.
   */
  _beginAttempt() {
    const wait = this.retryAfterMs();
    if (wait > 0) throw new HttpError(429, 'unlock_throttled', `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.`, { retryAfterMs: wait });
    this.meta.throttle = { failures: (this.meta.throttle?.failures || 0) + 1, lastFailureAt: new Date().toISOString() };
    this.save();
  }

  _fail(code, message) {
    return new HttpError(401, code, message, { retryAfterMs: throttleDelay(this.meta.throttle?.failures || 0) });
  }

  _resetThrottle() {
    if (this.meta.throttle?.failures) { this.meta.throttle = { failures: 0, lastFailureAt: null }; this.save(); }
  }

  _succeed(dek) {
    this._resetThrottle();
    // Already open: keep the buffer the file ciphers hold (same key) and drop the new copy.
    if (this.dek) {
      if (this.dek.equals(dek)) { if (dek !== this.dek) wipe(dek); return this.dek; }
      wipe(this.dek);
    }
    this.dek = dek;
    this._deriveStateKey();
    return dek;
  }

  async _openPassword(password) {
    if (!this.meta) return null;
    let { dek, previous } = await openPasswordWraps(this.meta, password);
    if (!dek) {
      // a damaged or replaced password wrap in vault.json: the copy in vault.json.bak (only when it differs)
      const bak = this._bakWraps();
      if (bak && JSON.stringify(bak.wraps.password) !== JSON.stringify(this.meta.wraps.password)) {
        ({ dek, previous } = await openPasswordWraps(bak, password));
        if (dek) {
          this.meta = { ...this.meta, wraps: { ...this.meta.wraps, password: bak.wraps.password, ...(bak.wraps.previous ? { previous: bak.wraps.previous } : {}) } };
          this.restoredWraps = true;
        }
      }
    }
    if (dek && !previous && this.meta.wraps.previous) {
      // the previous-key wrap did not open from vault.json: its copy in vault.json.bak (only when it differs)
      const bak = this._bakWraps();
      if (bak?.wraps.previous && JSON.stringify(bak.wraps.previous) !== JSON.stringify(this.meta.wraps.previous)) {
        const o = await openPasswordWraps(bak, password);
        wipe(o.dek);
        if (o.previous) { previous = o.previous; this.meta = { ...this.meta, wraps: { ...this.meta.wraps, previous: bak.wraps.previous } }; this.restoredWraps = true; }
      }
    }
    if (dek) { this.verified.add('password'); if (previous) this.verified.add('previous'); this._setPrevious(previous); } else wipe(previous);
    return dek;
  }

  _setPrevious(k) {
    if (this.previousKey && k && this.previousKey.equals(k)) { wipe(k); return; }
    wipe(this.previousKey);
    this.previousKey = k || null;
  }

  // Key ownership: unlockWith*() return the vault's OWN data-key buffer (the one the file ciphers hold) — callers
  // must not wipe it (lock() does); setKeychainWrap(true) returns a fresh key the caller owns and wipes.
  async unlockWithPassword(password) {
    this._beginAttempt();
    const dek = typeof password === 'string' && password ? await this._openPassword(password) : null;
    if (!dek) throw this._fail('wrong_password', 'That password is not right.');
    return this._succeed(dek);
  }

  async unlockWithRecoveryKey(text) {
    this._beginAttempt();
    const rk = parseRecoveryKey(text);
    const w = this.meta?.wraps?.recovery;
    let dek = null;
    const tryWrap = (wrap, meta) => {
      const kek = hkdf(rk, Buffer.from(wrap.kdf.salt, 'base64'), 'harness recovery v1');
      try {
        const d = unseal(kek, wrap, AAD('recovery'));
        if (d) { this.verified.add('recovery'); const p = openPrevious(kek, meta.wraps.previous, 'recovery'); if (p) this.verified.add('previous'); this._setPrevious(p); }
        return d;
      } finally { wipe(kek); }
    };
    if (rk && w) {
      dek = tryWrap(w, this.meta);
      const bak = dek ? null : this._bakWraps();
      if (!dek && bak?.wraps.recovery && JSON.stringify(bak.wraps.recovery) !== JSON.stringify(w)) {
        dek = tryWrap(bak.wraps.recovery, bak);
        if (dek) { this.meta = { ...this.meta, wraps: { ...this.meta.wraps, recovery: bak.wraps.recovery, ...(bak.wraps.previous ? { previous: bak.wraps.previous } : {}) } }; this.restoredWraps = true; }
      }
    }
    wipe(rk);
    if (!dek) throw this._fail('wrong_recovery_key', 'That recovery key does not open this data.');
    return this._succeed(dek);
  }

  /** Keychain mode: the key from the Keychain (or the app); null/false when it does not open the data. Not a guess. */
  unlockWithKeychainKey(kek) {
    const w = this.meta?.wraps?.keychain;
    const dek = w && kek ? unseal(Buffer.from(kek), w, AAD('keychain')) : null;
    if (!dek) return null;
    this.verified.add('keychain');
    if (this.dek) { if (this.dek.equals(dek)) { wipe(dek); return this.dek; } wipe(this.dek); }
    this.dek = dek;
    this._deriveStateKey();
    return dek;
  }

  /** Does `kek` (a key read from the Keychain) open this key store's keychain wrap? No side effects. */
  keychainKeyOpens(kek) {
    const w = this.meta?.wraps?.keychain;
    if (!w || !kek) return false;
    const dek = unseal(Buffer.from(kek), w, AAD('keychain'));
    if (!dek) return false;
    wipe(dek);
    return true;
  }

  /** Check the password for a confirmation while unlocked (same throttle). */
  async verifyPassword(password) {
    this._beginAttempt();
    const dek = typeof password === 'string' && password ? await this._openPassword(password) : null;
    if (!dek) throw this._fail('wrong_password', 'That password is not right.');
    wipe(dek);
    this._resetThrottle();
    return true;
  }

  // ----------------------------------------------------------------------------------------- changes (unlocked)
  _need() { if (!this.dek) throw new HttpError(423, 'locked', 'Harness is locked.'); }

  async changePassword(newPassword) {
    this._need();
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD) throw new HttpError(400, 'weak_password', `Choose a password of at least ${MIN_PASSWORD} characters.`);
    await this._wrapPassword(this.dek, newPassword, this.meta, { previous: this.previousKey });
    this.save();
  }

  newRecoveryKey() {
    this._need();
    const text = this._wrapRecovery(this.dek, this.meta, { previous: this.previousKey });
    this.save();
    return { recoveryKey: text, createdAt: this.meta.wraps.recovery.createdAt };
  }

  /**
   * Add (a new random key, returned) or remove the keychain wrap — with `state`, the security record changes in
   * the same save (so the wrap and the record's mode never disagree on disk).
   */
  setKeychainWrap(enabled, { state } = {}) {
    this._need();
    if (!enabled) { this._saveWith((m) => { delete m.wraps.keychain; }, state); return null; }
    const kek = crypto.randomBytes(32);
    const wrap = sealChecked(kek, this.dek, AAD('keychain'));
    this._saveWith((m) => { m.wraps.keychain = wrap; }, state);
    return kek;
  }

  _saveWith(mutate, state) {
    this.verified.add('keychain'); // written by this process
    if (state) { this.commit(state, { mutate }); return; }
    mutate(this.meta);
    this.save();
  }

  /**
   * Re-keying: wrap `newDek` under the password and a NEW recovery key (returned once), drop the keychain wrap
   * (the caller adds a new one), write the plain `migration` hint and the security record (under the new key,
   * carrying `state` — for a re-key the old key sealed under the new one) — all in one save, so a crash leaves
   * either the old or the new key store, never a mix.
   */
  async replaceKey(newDek, password, { migration = null, state = {}, mutate, keepPrevious = false } = {}) {
    this._need();
    const meta = structuredClone(this.meta);
    const oldKeyId = meta.keyId;
    // keepPrevious (re-keying): the old key stays wrapped under the password and the new recovery key until every
    // file is converted — besides inside the record — so one damaged copy can never cost the data under it
    const previous = keepPrevious ? this.dek : null;
    delete meta.wraps.previous;
    let newStateKey = null;
    try {
      await this._wrapPassword(newDek, password, meta, { previous });
      const recoveryKey = this._wrapRecovery(newDek, meta, { previous });
      delete meta.wraps.keychain;
      meta.keyId = keyIdOf(newDek).toString('hex');
      meta.migration = migration;
      meta.throttle = this.meta.throttle; // counted while the key derivation ran
      mutate?.(meta);
      newStateKey = stateKeyOf(newDek, meta.keyId);
      const rec = this._sealState({ ...state, prevKeyId: oldKeyId }, { meta, key: newStateKey });
      // the counter for BOTH keys first: whichever vault.json a crash leaves, its own counter entry is current
      this._writeMirror([{ keyId: oldKeyId, seq: this.stateSeq, key: this.stateKey }, { keyId: meta.keyId, seq: rec.seq, key: newStateKey }]);
      const saved = this.meta;
      const savedVerified = this.verified;
      this.meta = meta;
      this.verified = new Set([...WRAPS, 'state']); // every wrap and the record were written just now
      try { this.save(); } catch (e) { this.meta = saved; this.verified = savedVerified; throw e; }
      if (previous) this.previousKey = Buffer.from(previous); else { wipe(this.previousKey); this.previousKey = null; }
      wipe(this.dek);
      wipe(this.stateKey);
      this.dek = newDek;
      this.stateKey = newStateKey;
      newStateKey = null;
      this.record = rec;
      this.stateSeq = rec.seq;
      this._writeMirror(rec.seq); // now only the new key's entry: an older vault.json under the old key is stale
      return recoveryKey;
    } finally { wipe(newStateKey); }
  }

  /** The re-key finished (every file is under the current key): the previous key's wraps go, with the record change. */
  dropPrevious(meta) { delete meta.wraps.previous; }

  setEncrypted(flag) { this.meta.encrypted = !!flag; this.save(); }
  setMigration(m) { this.meta.migration = m; this.save(); }

  // ----------------------------------------------------------------------------------------- security record
  _deriveStateKey() {
    wipe(this.stateKey);
    this.stateKey = this.dek && this.meta ? stateKeyOf(this.dek, this.meta.keyId) : null;
  }

  /** The next record (patch over the last one), sealed into `meta.state`; nothing is saved here. */
  _sealState(patch, { meta = this.meta, key = this.stateKey } = {}) {
    if (!key) throw new HttpError(423, 'locked', 'Harness is locked.');
    const seq = this.stateSeq + 1;
    const rec = {
      v: 1, mode: 'password', encrypted: true, offlineLock: true, allowedUntil: null, allowFrom: null, migration: null, tamper: null, prevKeyId: null,
      ...(this.record || {}), ...patch, seq, at: new Date().toISOString(), keyId: meta.keyId,
    };
    if (!validState(rec)) throw new HttpError(500, 'state_invalid', 'Could not write the Harness security record; nothing was changed.');
    meta.state = { seq, ...sealChecked(key, Buffer.from(JSON.stringify(rec)), STATE_AAD(meta.keyId)) };
    return rec;
  }

  /**
   * Write the security record (`patch` over the current one) — and, in the same save, any other change of
   * vault.json (`mutate(meta)`) — then its counter into vault-seq.json. Needs the data key (or, in off mode, the
   * record key kept from the unlock).
   */
  commit(patch = {}, { mutate } = {}) {
    if (!this.stateKey) throw new HttpError(423, 'locked', 'Harness is locked.');
    const meta = structuredClone(this.meta);
    mutate?.(meta);
    for (const w of WRAPS) if (JSON.stringify(meta.wraps[w] ?? null) !== JSON.stringify(this.meta.wraps[w] ?? null)) this.verified.add(w);
    const rec = this._sealState(patch, { meta });
    const saved = this.meta;
    this.meta = meta;
    this.verified.add('state');
    try { this.save(); } catch (e) { this.meta = saved; throw e; }
    this.record = rec;
    this.stateSeq = rec.seq;
    this._writeMirror(rec.seq);
    return rec;
  }

  /** The record sealed in `sealed` (of a key store with this key id), or null. */
  _openRecord(sealed, keyId) {
    if (!isSealed(sealed)) return null;
    const buf = unseal(this.stateKey, sealed, STATE_AAD(keyId));
    if (!buf) return null;
    try { const r = JSON.parse(buf.toString('utf8')); return validState(r) && r.keyId === keyId ? r : null; } catch { return null; }
  }

  /**
   * Open the security record with the key now in memory → { status, record, mirror }:
   *   ok           authentic and current — it decides
   *   missing      no record anywhere and nothing shows one ever existed (a key store from Harness 0.2.0)
   *   removed      no record, but vault-seq.json, vault.json.bak or the plain hints show that one existed
   *   invalid      present, but not sealed under this key (written by someone who does not have it)
   *   stale        authentic, but older than its counter in vault-seq.json, or that counter is for another key
   *                (an older vault.json was put back)
   *   unverifiable authentic, but vault-seq.json cannot be read (not a file, no permission): current or not cannot
   *                be told, so it is not treated as current
   * A record in vault.json that is missing or does not open is first looked for in vault.json.bak (the verified
   * copy written with it); an intact one there is used and restored (`restoredRecord`).
   */
  readState() {
    if (!this.stateKey) throw new HttpError(423, 'locked', 'Harness is locked.');
    this.restoredRecord = false;
    const mirror = this._readMirror();
    if (mirror.status === 'ok') this.stateSeq = Math.max(this.stateSeq, mirror.seq);
    const keyId = this.meta.keyId;
    let rec = this._openRecord(this.meta.state, keyId);
    if (rec) this.verified.add('state');
    const present = !!this.meta.state;
    let bakHadRecord = false;
    if (!rec) {
      const bak = readVaultFile(this.file + '.bak');
      bakHadRecord = !!(bak.ok && bak.meta.state);
      const fromBak = bak.ok && bak.meta.keyId === keyId ? this._openRecord(bak.meta.state, keyId) : null;
      if (fromBak) {
        // the verified copy holds the intact record: use it and put it back (nothing in it is dropped)
        this.meta = { ...this.meta, state: bak.meta.state };
        this.verified.add('state');
        this.save();
        this.restoredRecord = true;
        rec = fromBak;
      }
    }
    if (!rec) {
      if (present) return { status: 'invalid', record: null, mirror };
      const existed = mirror.status !== 'missing' || bakHadRecord || typeof this.meta.migration?.id === 'string';
      return { status: existed ? 'removed' : 'missing', record: null, mirror };
    }
    this.stateSeq = Math.max(this.stateSeq, rec.seq);
    let status;
    if (mirror.status === 'ok') status = mirror.seq <= rec.seq ? 'ok' : 'stale'; // written after the record: it may lag, never lead
    else if (mirror.status === 'missing') status = rec.seq === 1 ? 'ok' : 'stale'; // the very first record, the counter not yet written
    else if (mirror.status === 'unusable') status = 'unverifiable';
    else status = 'stale'; // a counter for another key only (an older vault.json), or one that does not open
    this.record = status === 'ok' ? rec : null;
    return { status, record: rec, mirror };
  }

  /**
   * vault-seq.json: { version: 2, entries: [{ keyId, seq, nonce, data }] } — the sealed counter per key id (two
   * entries only around a key change). Version 1 (one entry at the top level) is read too.
   */
  _readMirror() {
    let st;
    try { st = fs.lstatSync(this.mirrorFile); } catch (e) { return { status: e.code === 'ENOENT' ? 'missing' : 'unusable', reason: e.code || 'unreadable', seq: 0 }; }
    if (!st.isFile()) return { status: 'unusable', reason: st.isDirectory() ? 'a folder' : 'not a file', seq: 0 };
    let raw;
    try { raw = JSON.parse(fs.readFileSync(this.mirrorFile, 'utf8')); } catch (e) { return e.code ? { status: 'unusable', reason: e.code, seq: 0 } : { status: 'invalid', seq: 0 }; }
    const entries = Array.isArray(raw?.entries) ? raw.entries : raw && typeof raw === 'object' ? [raw] : [];
    const mine = entries.find((e) => e && e.keyId === this.meta?.keyId && isSealed(e));
    if (!mine) return { status: entries.length ? 'other_key' : 'invalid', seq: 0 };
    let seq = 0;
    try { const j = JSON.parse(unseal(this.stateKey, mine, MIRROR_AAD(mine.keyId))?.toString('utf8') || 'null'); if (Number.isInteger(j?.seq) && j.seq > 0) seq = j.seq; } catch { /* invalid */ }
    return seq ? { status: 'ok', seq, keyId: mine.keyId } : { status: 'invalid', seq: 0 };
  }

  /**
   * Best effort: a failed write only weakens the detection of an older vault.json put back (and is reported:
   * `mirrorError`). `entries`: a seq for the current key, or [{ keyId, seq, key }] around a key change.
   */
  _writeMirror(entries) {
    const list = Array.isArray(entries) ? entries : [{ keyId: this.meta.keyId, seq: entries, key: this.stateKey }];
    try {
      const body = { version: 2, entries: list.filter((e) => e.key).map((e) => ({ keyId: e.keyId, seq: e.seq, ...seal(e.key, Buffer.from(JSON.stringify({ seq: e.seq })), MIRROR_AAD(e.keyId)) })) };
      const tmp = `${this.mirrorFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.mirrorFile);
      this.mirrorError = null;
      return true;
    } catch (e) {
      this.mirrorError = e.code || 'write_failed';
      try { fs.rmSync(`${this.mirrorFile}.${process.pid}.tmp`, { force: true }); } catch { /* ignore */ }
      return false;
    }
  }

  /** The file cipher while unlocked. */
  get cipher() { return this.dek ? { key: this.dek } : null; }

  /** Forget the data key; `keepStateKey` (off mode) keeps only the key that seals the security record. */
  lock({ keepStateKey = false } = {}) {
    wipe(this.dek);
    this.dek = null;
    wipe(this.previousKey);
    this.previousKey = null;
    if (!keepStateKey) { wipe(this.stateKey); this.stateKey = null; }
  }
}

/** The key that seals the security record: HKDF of the data key, salted with its id (never the data key itself). */
function stateKeyOf(dek, keyId) {
  return hkdf(dek, Buffer.from(keyId, 'hex'), 'harness security state v1');
}
