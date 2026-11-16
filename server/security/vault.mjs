// The key store of an encrypted data directory: vault.json (plain, 0600) holds only WRAPPED copies of the random
// data key — under a key derived from the user's password (scrypt), under the recovery key (HKDF) and, in keychain
// mode, under a random key kept in the Keychain — plus the unlock throttle and migration progress. The data key
// itself exists only in memory while Harness is unlocked.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { seal, unseal, deriveKey, newKdf, hkdf, formatRecoveryKey, parseRecoveryKey, keyIdOf, wipe, kdfDefaultsNow } from './crypto.mjs';
import { HttpError } from '../lib/errors.mjs';

export const MIN_PASSWORD = 8;
const AAD = (name) => `harness-wrap-v1:${name}`;

/** Unlock throttle: attempts 1–3 free, then 1 s, 2 s, 4 s … up to 5 minutes. */
export function throttleDelay(failures) {
  return failures <= 3 ? 0 : Math.min(300000, 1000 * 2 ** (failures - 4));
}

export class Vault {
  constructor(dataDir, { kdf } = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'vault.json');
    this.kdfParams = kdf || null;
    this.meta = null;
    this.dek = null;
  }

  load() {
    try { this.meta = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.meta = null; }
    if (this.meta && (this.meta.version !== 1 || !this.meta.wraps)) throw new HttpError(500, 'vault_corrupt', 'vault.json is not a Harness key store');
    return this;
  }

  get exists() { return !!this.meta; }
  get encrypted() { return !!this.meta?.encrypted; }
  get unlocked() { return !!this.dek; }
  get hasPassword() { return !!this.meta?.wraps?.password; }
  get keyId() { return this.meta?.keyId || null; }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.meta, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // ----------------------------------------------------------------------------------------- creation
  /** First setup: a new data key wrapped under the password and a new recovery key (returned once). */
  async create(password, { encrypted = true } = {}) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new HttpError(400, 'weak_password', `Choose a password of at least ${MIN_PASSWORD} characters.`);
    const dek = crypto.randomBytes(32);
    this.meta = { version: 1, encrypted, keyId: keyIdOf(dek).toString('hex'), wraps: {}, throttle: { failures: 0, lastFailureAt: null }, migration: null, createdAt: new Date().toISOString() };
    await this._wrapPassword(dek, password);
    const recoveryKey = this._wrapRecovery(dek);
    this.dek = dek;
    this.save();
    return recoveryKey;
  }

  async _wrapPassword(dek, password) {
    const kdf = newKdf(this.kdfParams || kdfDefaultsNow());
    const kek = await deriveKey(password, kdf);
    this.meta.wraps.password = { kdf, ...seal(kek, dek, AAD('password')) };
    wipe(kek);
  }

  _wrapRecovery(dek) {
    const rk = crypto.randomBytes(32);
    const salt = crypto.randomBytes(16);
    const kek = hkdf(rk, salt, 'harness recovery v1');
    this.meta.wraps.recovery = { kdf: { name: 'hkdf-sha256', salt: salt.toString('base64') }, ...seal(kek, dek, AAD('recovery')), createdAt: new Date().toISOString() };
    const text = formatRecoveryKey(rk);
    wipe(kek);
    wipe(rk);
    return text;
  }

  // ----------------------------------------------------------------------------------------- unlocking
  retryAfterMs() {
    const t = this.meta?.throttle;
    if (!t?.failures) return 0;
    const wait = throttleDelay(t.failures);
    return Math.max(0, Date.parse(t.lastFailureAt || 0) + wait - Date.now());
  }

  _throttleCheck() {
    const wait = this.retryAfterMs();
    if (wait > 0) throw new HttpError(429, 'unlock_throttled', `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.`, { retryAfterMs: wait });
  }

  _fail(code, message) {
    this.meta.throttle = { failures: (this.meta.throttle?.failures || 0) + 1, lastFailureAt: new Date().toISOString() };
    this.save();
    return new HttpError(401, code, message, { retryAfterMs: throttleDelay(this.meta.throttle.failures) });
  }

  _succeed(dek) {
    if (this.meta.throttle?.failures) { this.meta.throttle = { failures: 0, lastFailureAt: null }; this.save(); }
    if (this.dek && this.dek !== dek) wipe(this.dek);
    this.dek = dek;
    return dek;
  }

  async _openPassword(password) {
    const w = this.meta?.wraps?.password;
    if (!w) return null;
    const kek = await deriveKey(password, w.kdf);
    const dek = unseal(kek, w, AAD('password'));
    wipe(kek);
    return dek;
  }

  async unlockWithPassword(password) {
    this._throttleCheck();
    const dek = typeof password === 'string' && password ? await this._openPassword(password) : null;
    if (!dek) throw this._fail('wrong_password', 'That password is not right.');
    return this._succeed(dek);
  }

  async unlockWithRecoveryKey(text) {
    this._throttleCheck();
    const rk = parseRecoveryKey(text);
    const w = this.meta?.wraps?.recovery;
    let dek = null;
    if (rk && w) {
      const kek = hkdf(rk, Buffer.from(w.kdf.salt, 'base64'), 'harness recovery v1');
      dek = unseal(kek, w, AAD('recovery'));
      wipe(kek);
      wipe(rk);
    }
    if (!dek) throw this._fail('wrong_recovery_key', 'That recovery key does not open this data.');
    return this._succeed(dek);
  }

  /** Keychain mode: the key from the Keychain (or the app); null/false when it does not open the data. */
  unlockWithKeychainKey(kek) {
    const w = this.meta?.wraps?.keychain;
    const dek = w && kek ? unseal(Buffer.from(kek), w, AAD('keychain')) : null;
    if (!dek) return null;
    return this._succeed(dek);
  }

  /** Check the password for a confirmation while unlocked (same throttle). */
  async verifyPassword(password) {
    this._throttleCheck();
    const dek = typeof password === 'string' && password ? await this._openPassword(password) : null;
    if (!dek) throw this._fail('wrong_password', 'That password is not right.');
    wipe(dek);
    if (this.meta.throttle?.failures) { this.meta.throttle = { failures: 0, lastFailureAt: null }; this.save(); }
    return true;
  }

  // ----------------------------------------------------------------------------------------- changes (unlocked)
  _need() { if (!this.dek) throw new HttpError(423, 'locked', 'Harness is locked.'); }

  async changePassword(newPassword) {
    this._need();
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD) throw new HttpError(400, 'weak_password', `Choose a password of at least ${MIN_PASSWORD} characters.`);
    await this._wrapPassword(this.dek, newPassword);
    this.save();
  }

  newRecoveryKey() {
    this._need();
    const text = this._wrapRecovery(this.dek);
    this.save();
    return { recoveryKey: text, createdAt: this.meta.wraps.recovery.createdAt };
  }

  /** Add (a new random key, returned) or remove the keychain wrap. */
  setKeychainWrap(enabled) {
    this._need();
    if (!enabled) { delete this.meta.wraps.keychain; this.save(); return null; }
    const kek = crypto.randomBytes(32);
    this.meta.wraps.keychain = seal(kek, this.dek, AAD('keychain'));
    this.save();
    return kek;
  }

  setEncrypted(flag) { this.meta.encrypted = !!flag; this.save(); }
  setMigration(m) { this.meta.migration = m; this.save(); }

  /** The file cipher while unlocked. */
  get cipher() { return this.dek ? { key: this.dek } : null; }

  lock() { wipe(this.dek); this.dek = null; }
}
