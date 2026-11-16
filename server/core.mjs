// The part of Harness that outlives locking: protection mode, key store, sessions, the internet blocker and a
// managed Ollama. The `app` (stores, engines — everything that holds user data) exists only while unlocked: it is
// created when the data is opened and closed when Harness locks. docs/API.md §10.1–10.6.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { LaunchConfig } from './security/launch.mjs';
import { Vault } from './security/vault.mjs';
import { NetworkGuard } from './security/network.mjs';
import { Auth } from './security/auth.mjs';
import { platformKeychain, KeychainError } from './security/keychain.mjs';
import { listDataFiles, migrateDir, hasPlainData, hasEncryptedData, fixPermissions, repairForeignFiles } from './security/migrate.mjs';
import { seal, unseal, wipe, keyIdOf, setKdfDefaults } from './security/crypto.mjs';
import { setDirCipher, ensureDir, flushWrites } from './lib/fsx.mjs';
import { HttpError } from './lib/errors.mjs';
import { httpRequest } from './lib/http-client.mjs';
import { log } from './lib/log.mjs';
import { createApp, detectSystem } from './app.mjs';
import { OllamaProcess } from './providers/ollama-process.mjs';
import { VERSION, ROOT_DIR } from './version.mjs';
import crypto from 'node:crypto';

const MODES = new Set(['password', 'keychain', 'off']);
const PASSWORD_RESET_MS = 10 * 60 * 1000;
const IDLE_CHECK_MS = Number(process.env.HARNESS_IDLE_CHECK_MS) || 30000;

function envMode() {
  const v = process.env.HARNESS_ENCRYPTION;
  return MODES.has(v) ? v : undefined;
}
function envFlag(name) {
  const v = process.env[name];
  return v === '0' || v === 'false' ? false : v === '1' || v === 'true' ? true : undefined;
}

export class Core extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {'listener'|'bridge'} [o.transport]
   * @param {{ mode?: 'password'|'keychain'|'off', apiAuth?: boolean, kdf?: object }} [o.security]
   *        test/development opt-outs (env HARNESS_ENCRYPTION, HARNESS_API_AUTH=0); `kdf` = scrypt parameters for new wraps
   * @param {boolean} [o.offlineLock] false = do not block internet access in this process (env HARNESS_OFFLINE_LOCK=0)
   * @param {object} [o.keychain] where keychain mode keeps its key (default: macOS Keychain / dev file / the app)
   * @param {(ev: object) => void} [o.emit] bridge events (ready/locked/unlocked/progress/keychain-key/restart-required)
   */
  constructor({ dataDir, system, autodetect = true, publicDir, transport = 'listener', security = {}, offlineLock, keychain, emit } = {}) {
    super();
    this.setMaxListeners(1000);
    this.dataDir = path.resolve(dataDir);
    this.systemOverrides = system || {};
    this.autodetect = autodetect;
    this.publicDir = publicDir || path.join(ROOT_DIR, 'public');
    this.transport = transport;
    this.version = VERSION;
    this.url = null;
    this.port = null;
    this.emitEvent = emit || (() => {});
    this.modeOverride = security.mode !== undefined ? security.mode : envMode();
    const apiAuth = security.apiAuth !== undefined ? security.apiAuth : envFlag('HARNESS_API_AUTH');
    const lockOverride = offlineLock !== undefined ? offlineLock : envFlag('HARNESS_OFFLINE_LOCK');
    this.launch = new LaunchConfig(this.dataDir);
    this.vault = new Vault(this.dataDir, { kdf: security.kdf });
    if (security.kdf) setKdfDefaults(security.kdf); // tests: cheap scrypt for every new wrap and backup
    this.network = null;
    this._lockOverride = lockOverride === false ? false : undefined;
    this.auth = new Auth({ dataDir: this.dataDir, enabled: apiAuth !== false && transport === 'listener', mode: () => this.mode });
    this.keychain = keychain || platformKeychain(this.dataDir);
    this.app = null;
    this.state = 'locked';
    this.mode = 'password';
    this.plainDataFound = false;
    this.migration = null;
    this.keychainError = null;
    this.passwordResetUntil = 0;
    this.inflight = 0;
    this.lastActivity = Date.now();
    this.idleTimer = null;
    this._locking = null;
    this._opening = null;
    this._migrating = null;
    this._ollamaCache = { settings: { ollama: {} }, baseUrl: 'http://127.0.0.1:11434', idleLockMinutes: 15 };
    this.system = detectSystem(this.systemOverrides);
    // A managed Ollama outlives lock/unlock (unloading models is enough to drop what they held).
    this.ollamaProcess = new OllamaProcess({
      getSettings: () => this.app?.settings.get() || this._ollamaCache.settings,
      getProvider: () => this.app?.registry.ollama() || this._lockedOllamaProvider(),
      bus: { publish: (t, d) => this.app?.bus.publish(t, d) },
      totalMem: this.system.totalMem,
      sandbox: () => this._ollamaSandboxWanted(),
    });
  }

  // ------------------------------------------------------------------------------------------ start-up
  async init() {
    await ensureDir(this.dataDir);
    await fixPermissions(this.dataDir).catch(() => {});
    this.launch.load();
    // launchers read launch.json before starting the backend: make the defaults visible on a fresh install
    if (!(await import('node:fs')).existsSync(this.launch.file)) { try { this.launch.set({}); } catch { /* read-only: defaults */ } }
    let vaultError = null;
    try { this.vault.load(); } catch (e) { vaultError = e; }
    if (this.vault.restoredFromBackup) log.warn('vault.json was damaged; restored it from its verified copy vault.json.bak.');
    this.network = new NetworkGuard({ launch: this.launch, enabledOverride: this._lockOverride });
    this.network.ollamaInfo = () => ({ managed: this.ollamaProcess.managed, sandboxed: !!this.ollamaProcess.sandboxed, external: !!this.ollamaProcess.external });
    this.network.on('change', (ev) => this._onNetworkChange(ev));
    const launchMode = this.launch.get().encryption;
    let mode = this.modeOverride || launchMode;
    if (!MODES.has(mode)) mode = 'password';
    if (mode === 'off' && this.vault.encrypted && this.modeOverride === 'off') {
      log.warn('The data in this folder is encrypted; ignoring the request to run without encryption.');
      mode = launchMode === 'off' ? 'password' : launchMode;
    }
    this.mode = mode;
    this.migration = this.vault.meta?.migration || null;
    this.auth.syncTokenFile();
    this._startIdleTimer();
    // A damaged key store, or encrypted files without one, is a hard error: never offer a fresh setup over them
    // (a new key store would orphan every encrypted file).
    if (vaultError || (!this.vault.exists && (await hasEncryptedData(this.dataDir)))) {
      this.state = 'error';
      this.error = vaultError
        ? { code: 'vault_corrupt', message: vaultError.message }
        : { code: 'vault_missing', message: 'This data folder holds encrypted files but no key store (vault.json). Nothing has been changed; restore vault.json from a backup of this folder.' };
      log.error(`Cannot open the data: ${this.error.code}`);
      setDirCipher(this.dataDir, 'locked');
      return this;
    }
    if (!this.vault.exists) {
      if (mode === 'off') { await this._open(); return this; }
      this.plainDataFound = await hasPlainData(this.dataDir);
      this.state = 'needs_setup';
      setDirCipher(this.dataDir, 'locked');
      return this;
    }
    if (!this.vault.encrypted && mode === 'off' && !this.migration) { await this._open(); return this; }
    this.state = 'locked';
    setDirCipher(this.dataDir, 'locked');
    if (mode === 'keychain') {
      // No prompt possible for the dev file / the native app's key: wait for it. The macOS Keychain may show a
      // prompt, so the server comes up locked and opens as soon as the Keychain answers.
      const p = this._unlockWithKeychain().catch((e) => { this.keychainError = { code: e.code || 'keychain_failed', message: e.message }; if (e.fatal) throw e; });
      if (this.keychain.kind === 'keychain') this._autoUnlock = p; else await p;
    }
    return this;
  }

  // ------------------------------------------------------------------------------------------ status
  get unlocked() { return this.state === 'unlocked' && !!this.app; }

  /** For routes that need the data: the app, or 423. */
  requireApp() {
    if (this.state === 'unlocked' && this.app) return this.app;
    if (this.state === 'error') throw new HttpError(503, this.error.code, this.error.message);
    if (this.state === 'needs_setup') throw new HttpError(423, 'needs_setup', 'Choose a Harness password first.');
    throw new HttpError(423, 'locked', this.state === 'migrating' ? 'Harness is converting its data; this takes a moment.' : 'Harness is locked. Enter your password to open it.');
  }

  securityStatus(authInfo = null) {
    const rk = this.vault.meta?.wraps?.recovery;
    return {
      state: this.state,
      ...(this.state === 'error' ? { error: this.error } : {}),
      mode: this.mode,
      plainDataFound: this.state === 'needs_setup' ? this.plainDataFound : false,
      migration: this.migration ? { op: this.migration.op, done: this.migration.done, total: this.migration.total, startedAt: this.migration.startedAt, error: this.migration.error || null } : null,
      unlock: { failedAttempts: this.vault.meta?.throttle?.failures || 0, retryAfterMs: this.vault.exists ? this.vault.retryAfterMs() : 0, ...(this.keychainError ? { keychainError: this.keychainError } : {}) },
      recoveryKey: rk ? { createdAt: rk.createdAt } : null,
      idleLockMinutes: this.idleLockMinutes(),
      idleLockAt: this.idleLockAt(),
      session: authInfo ? { authenticated: !!authInfo.authenticated, via: authInfo.via || null } : { authenticated: false, via: null },
      transport: this.transport,
      offlineLock: this.network.status(),
    };
  }

  idleLockMinutes() {
    const v = this.app?.settings.get().security?.idleLockMinutes;
    return Number.isFinite(v) ? v : this._ollamaCache.idleLockMinutes;
  }

  _emitState() {
    this.emit('state', { state: this.state, mode: this.mode });
    this.app?.bus.publish('security.status', { state: this.state, mode: this.mode });
  }

  // ------------------------------------------------------------------------------------------ open / close
  async _open() {
    if (this.app) return this.app;
    this._opening ||= (async () => {
      const cipher = this.vault.encrypted ? this.vault.cipher : null;
      setDirCipher(this.dataDir, cipher ? { key: cipher.key, oldKeys: this._oldKeys || [] } : null);
      try {
        this.app = await createApp({ dataDir: this.dataDir, system: this.systemOverrides, autodetect: this.autodetect, publicDir: this.publicDir, ollamaProcess: this.ollamaProcess, network: this.network, core: this });
      } catch (e) {
        setDirCipher(this.dataDir, this.vault.encrypted ? 'locked' : null);
        throw e;
      }
      this.app.url = this.url;
      this.app.port = this.port;
      this._cacheFromSettings();
      this.app.bus.on('event', (ev) => { if (ev.type === 'settings.updated') this._cacheFromSettings(); });
      this.state = 'unlocked';
      this.lastActivity = Date.now();
      this.keychainError = null;
      this._emitState();
      this.emit('unlocked', {});
      this.emitEvent({ type: 'unlocked' });
      this.app.bus.publish('network.status', { offlineLock: this.network.status() });
      return this.app;
    })().finally(() => { this._opening = null; });
    return this._opening;
  }

  _cacheFromSettings() {
    const s = this.app?.settings.get();
    if (!s) return;
    this._ollamaCache = {
      settings: { ollama: { ...(s.ollama || {}) } },
      baseUrl: s.providers?.builtin?.ollama?.baseUrl || 'http://127.0.0.1:11434',
      idleLockMinutes: Number.isFinite(s.security?.idleLockMinutes) ? s.security.idleLockMinutes : 15,
      allowedOrigins: [...(s.security?.allowedOrigins || [])],
    };
  }

  /** Extra browser origins (settings.security.allowedOrigins; the last known value while locked). */
  allowedOrigins() {
    return this.app?.settings.get().security?.allowedOrigins || this._ollamaCache.allowedOrigins || [];
  }

  /**
   * Whether an Ollama that Harness did not start is answering (offlineLock.externalOllama) — in every state; it
   * needs no user data. Probed at most every 5 s.
   */
  async refreshOllamaPresence() {
    const p = this.ollamaProcess;
    if (p.managed) { p.external = false; return; }
    const provider = this.app?.registry.ollama() || this._lockedOllamaProvider();
    if (this._presence && this._presence.url === provider.baseUrl && Date.now() - this._presence.at < 5000) return this._presence.promise;
    const promise = Promise.resolve(provider.status()).then((st) => { if (!p.managed) p.external = !!st?.ok; }, () => {});
    this._presence = { at: Date.now(), promise, url: provider.baseUrl };
    return promise;
  }

  /** While locked there is no registry: a minimal Ollama provider for start/stop/restart of a managed Ollama. */
  _lockedOllamaProvider() {
    const baseUrl = this._ollamaCache.baseUrl;
    return {
      baseUrl,
      async status() {
        try {
          const r = await httpRequest(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(1500) });
          const j = r.ok ? await r.json() : null;
          return { ok: r.ok, version: j?.version || null };
        } catch { return { ok: false }; }
      },
    };
  }

  /**
   * Lock now. reason: 'user' | 'idle' | 'bridge' | 'shutdown'. Aborts what runs (partial replies kept), unloads
   * models Harness loaded, closes the stores, forgets the key and drops every session.
   */
  async lock(reason = 'user') {
    if (this._locking) return this._locking;
    if (this.state === 'needs_setup' || this.state === 'locked' || this.state === 'error') return;
    if (!this.vault.encrypted || !this.vault.exists) throw new HttpError(409, 'not_encrypted', 'Harness runs without encryption, so there is nothing to lock.');
    if (this.state === 'migrating') throw new HttpError(409, 'migrating', 'Harness is converting its data; lock it once that has finished.');
    this._locking = (async () => {
      const app = this.app;
      this.state = 'locked';
      log.info(`Locking Harness (${reason})`);
      this.emit('locking', { reason });
      try { await app?.close({ lock: true }); } catch (e) { log.warn(`Closing the data while locking: ${e.code || e.message}`); }
      await flushWrites().catch(() => {});
      this.app = null;
      setDirCipher(this.dataDir, 'locked');
      this.vault.lock();
      if (this._oldKeys) { for (const k of this._oldKeys) wipe(k); this._oldKeys = null; }
      if (this.mode !== 'keychain') this.auth.dropAll(); else this.auth.dropConfirmations();
      this.passwordResetUntil = 0;
      this._emitState();
      this.emit('locked', { reason });
      this.emitEvent({ type: 'locked' });
    })().finally(() => { this._locking = null; });
    return this._locking;
  }

  // ------------------------------------------------------------------------------------------ setup / unlock
  async setup(password) {
    await this._locking;
    if (this.state === 'error') throw new HttpError(409, this.error.code, this.error.message);
    if (this.state !== 'needs_setup') throw new HttpError(409, 'already_set_up', 'Harness already has a password.');
    // Re-check right before creating keys: encrypted files or a key store must never be overwritten.
    this.vault.load();
    if (this.vault.exists || (await hasEncryptedData(this.dataDir))) throw new HttpError(409, 'already_set_up', 'This data folder already has a key store or encrypted files; setup was refused.');
    const recoveryKey = await this.vault.create(password, { encrypted: true });
    const mode = this.mode === 'off' ? 'password' : this.mode;
    this.launch.set({ encryption: mode });
    this.mode = mode;
    this.auth.syncTokenFile();
    setDirCipher(this.dataDir, { key: this.vault.cipher.key });
    if (this.plainDataFound || (await listDataFiles(this.dataDir)).length) {
      this._startMigration('encrypt', this.vault.cipher.key);
    } else {
      await this._open();
    }
    if (mode === 'keychain') await this._addKeychainWrap().catch((e) => { this.keychainError = { code: e.code || 'keychain_failed', message: e.message }; });
    return { state: this.state, recoveryKey, migration: this.securityStatus().migration };
  }

  /**
   * Unlock (or, already unlocked, prove the password for a new session).
   * @param {{ password?: string, recoveryKey?: string }} body
   * @param {{ authenticated: boolean }} ctx  keychain-mode `{}` needs a caller that already has access
   */
  async unlock(body = {}, ctx = {}) {
    await this._locking;
    if (this.state === 'error') throw new HttpError(409, this.error.code, this.error.message);
    if (this.state === 'needs_setup') throw new HttpError(423, 'needs_setup', 'Choose a Harness password first.');
    const { password, recoveryKey } = body;
    const already = this.state === 'unlocked' || this.state === 'migrating';
    if (typeof password === 'string' && password) {
      if (already || !this.vault.encrypted) await this.confirmPassword(password);
      else await this.vault.unlockWithPassword(password);
    } else if (typeof recoveryKey === 'string' && recoveryKey) {
      await this.vault.unlockWithRecoveryKey(recoveryKey);
      if (already && !this.vault.encrypted) this._wipeIfPlain();
      this.passwordResetUntil = Date.now() + PASSWORD_RESET_MS;
    } else {
      if (this.mode !== 'keychain') throw new HttpError(400, 'bad_request', 'Send { "password": "…" } or { "recoveryKey": "…" }.');
      if (!ctx.authenticated) throw new HttpError(401, 'auth_required', 'Open Harness from its launcher (or send the password).', { reason: 'missing', unlock: false });
      if (!already) await this._unlockWithKeychain();
    }
    if (!already) await this._afterKey();
    return { state: this.state, passwordReset: this.passwordResetUntil > Date.now() ? { until: new Date(this.passwordResetUntil).toISOString() } : null };
  }

  async _unlockWithKeychain() {
    let kek;
    try { kek = await this.keychain.get(); } catch (e) {
      if (e instanceof KeychainError) throw new HttpError(503, 'keychain_unavailable', e.message, { reason: e.reason });
      throw e;
    }
    if (!kek) throw new HttpError(503, 'keychain_unavailable', 'The Keychain holds no Harness key. Enter the password instead.', { reason: 'not_found' });
    const dek = this.vault.unlockWithKeychainKey(kek);
    wipe(kek);
    if (!dek) {
      const e = new HttpError(401, 'wrong_key', 'The key from the Keychain does not open this data. Enter the password instead.');
      if (this.keychain.kind === 'app') e.fatal = true;
      throw e;
    }
    await this._afterKey();
  }

  /** The data key is in memory: finish an interrupted conversion, or open the data. */
  async _afterKey() {
    if (this.state === 'unlocked' || this.state === 'migrating') return;
    const m = this.vault.meta.migration;
    if (m?.op === 'reencrypt' && m.oldKey) {
      const old = unseal(this.vault.dek, m.oldKey, 'harness-rekey-v1');
      if (old) this._oldKeys = [old];
    }
    setDirCipher(this.dataDir, { key: this.vault.dek, oldKeys: this._oldKeys || [] });
    // an earlier 0.2 build encrypted launcher files (desktop.json, native/, Electron/): give them back
    const repaired = await repairForeignFiles(this.dataDir).catch(() => 0);
    if (repaired) log.warn(`Decrypted ${repaired} launcher file(s) that an earlier version had encrypted by mistake.`);
    if (m) { this._startMigration(m.op, m.op === 'decrypt' ? null : this.vault.dek, { resume: true }); return; }
    if (!this.vault.encrypted && this.mode !== 'off') { this.vault.setEncrypted(true); this._startMigration('encrypt', this.vault.dek); return; }
    await this._open();
  }

  /**
   * Check the password (throttled like unlocking). In off mode the data key is not in memory; `needKey` keeps the
   * key the password unwrapped for the caller's operation (call _wipeIfPlain() after it).
   */
  async confirmPassword(password, { needKey = false } = {}) {
    if (!this.vault.hasPassword) return true;
    if (this.vault.dek) return this.vault.verifyPassword(password);
    await this.vault.unlockWithPassword(password);
    if (!needKey) this._wipeIfPlain();
    return true;
  }

  /** Off mode keeps no key in memory between operations. */
  _wipeIfPlain() {
    if (!this.vault.encrypted && !this.migration && this.state !== 'migrating') this.vault.lock();
  }

  /**
   * Password confirmation for an action that lowers protection (docs/API.md §10.3): `password` in the body, or a
   * single-use `X-Harness-Confirm` token for this session. No password ever set (off mode, development): none asked.
   */
  async requireConfirmation({ password, header, sessionHash, needKey = false }) {
    if (!this.vault.hasPassword) return;
    if (typeof password === 'string' && password) { await this.confirmPassword(password, { needKey }); return; }
    if (needKey && !this.vault.dek) throw new HttpError(403, 'confirmation_required', 'Enter your Harness password to confirm this.');
    if (header) {
      if (this.auth.consumeConfirmation(header, sessionHash)) return;
      throw new HttpError(401, 'wrong_password', 'That confirmation has expired or was already used; enter the password again.');
    }
    throw new HttpError(403, 'confirmation_required', 'Enter your Harness password to confirm this.');
  }

  // ------------------------------------------------------------------------------------------ changes
  async changePassword({ password, newPassword }) {
    this.requireApp();
    const inReset = this.passwordResetUntil > Date.now();
    if (!inReset || password) await this.requireConfirmation({ password, needKey: true });
    if (!this.vault.dek) throw new HttpError(403, 'confirmation_required', 'Enter your current Harness password.');
    try { await this.vault.changePassword(newPassword); } finally { this._wipeIfPlain(); }
    this.passwordResetUntil = 0;
    return { ok: true };
  }

  async newRecoveryKey({ password, header, sessionHash }) {
    this.requireApp();
    if (!this.vault.exists) throw new HttpError(409, 'no_password', 'Harness has no password, so there is no recovery key.');
    await this.requireConfirmation({ password, header, sessionHash, needKey: true });
    try { return this.vault.newRecoveryKey(); } finally { this._wipeIfPlain(); }
  }

  async setMode({ mode, password, newPassword, header, sessionHash }) {
    this.requireApp();
    if (!MODES.has(mode)) throw new HttpError(400, 'bad_request', 'mode must be "password", "keychain" or "off"');
    if (this.state === 'migrating') throw new HttpError(409, 'migrating', 'Harness is converting its data; try again when it has finished.');
    let recoveryKey;
    if (!this.vault.exists) {
      // off mode, never had a password: turning encryption on needs a new one
      if (mode === 'off') return { mode: this.mode, state: this.state };
      recoveryKey = await this.vault.create(newPassword, { encrypted: true });
      this.app && await this._closeForMigration();
      this.launch.set({ encryption: mode });
      this.mode = mode;
      this.auth.syncTokenFile();
      this._startMigration('encrypt', this.vault.dek);
      if (mode === 'keychain') await this._addKeychainWrap();
      return { mode, state: this.state, recoveryKey };
    }
    await this.requireConfirmation({ password, header, sessionHash, needKey: true });
    const from = this.mode;
    if (mode === from && (mode !== 'off' || !this.vault.encrypted)) { this._wipeIfPlain(); return { mode, state: this.state }; }
    let rekeyRecommended = false;
    if (from === 'keychain' && mode !== 'keychain') {
      this.vault.setKeychainWrap(false);
      await this.keychain.delete().catch((e) => log.warn(`Could not remove the Keychain item: ${e.message}`));
      rekeyRecommended = true;
    }
    if (mode === 'off') {
      this.launch.set({ encryption: 'off' });
      this.mode = 'off';
      this.auth.syncTokenFile();
      await this._closeForMigration();
      this._startMigration('decrypt', null);
      return { mode, state: this.state, rekeyRecommended: false };
    }
    if (from === 'off') {
      this.vault.setEncrypted(true);
      this.launch.set({ encryption: mode });
      this.mode = mode;
      this.auth.syncTokenFile();
      await this._closeForMigration();
      this._startMigration('encrypt', this.vault.dek);
      if (mode === 'keychain') await this._addKeychainWrap();
      return { mode, state: this.state };
    }
    if (mode === 'keychain') {
      await this._addKeychainWrap();
    } else {
      this.launch.set({ encryption: mode });
      this.mode = mode;
      this.auth.syncTokenFile();
    }
    return { mode: this.mode, state: this.state, ...(rekeyRecommended ? { rekeyRecommended } : {}) };
  }

  async _addKeychainWrap() {
    const kek = this.vault.setKeychainWrap(true);
    const prevMode = this.mode;
    this.launch.set({ encryption: 'keychain' });
    this.mode = 'keychain';
    this.auth.syncTokenFile();
    try {
      await this.keychain.set(kek);
    } catch (e) {
      this.vault.setKeychainWrap(false);
      this.launch.set({ encryption: prevMode === 'keychain' ? 'password' : prevMode });
      this.mode = prevMode === 'keychain' ? 'password' : prevMode;
      this.auth.syncTokenFile();
      throw new HttpError(503, 'keychain_unavailable', e.message || 'Could not store the key in the Keychain.', { reason: e.reason || 'failed' });
    } finally { wipe(kek); }
  }

  /** Re-key: a new data key; every file is re-encrypted under it; a new recovery key replaces the old one. */
  async rekey({ password, header, sessionHash }) {
    this.requireApp();
    if (!this.vault.encrypted) throw new HttpError(409, 'not_encrypted', 'Harness runs without encryption.');
    if (!(typeof password === 'string' && password)) throw new HttpError(403, 'confirmation_required', 'Enter your Harness password to re-key the data (it is needed to wrap the new key).');
    if (this.state === 'migrating') throw new HttpError(409, 'migrating', 'Harness is converting its data; try again when it has finished.');
    await this.requireConfirmation({ password, header, sessionHash });
    const oldDek = Buffer.from(this.vault.dek);
    const newDek = crypto.randomBytes(32);
    await this._closeForMigration();
    let recoveryKey;
    try {
      // the old key travels sealed under the new one until every file is converted (crash → resumed at unlock)
      recoveryKey = await this.vault.replaceKey(newDek, password, { migration: { op: 'reencrypt', done: 0, total: 0, startedAt: new Date().toISOString(), error: null, oldKey: seal(newDek, oldDek, 'harness-rekey-v1'), oldKeyId: keyIdOf(oldDek).toString('hex') } });
    } catch (e) {
      wipe(oldDek);
      this.state = 'locked';
      await this._open();
      throw e;
    }
    this._oldKeys = [oldDek];
    setDirCipher(this.dataDir, { key: newDek, oldKeys: this._oldKeys });
    if (this.mode === 'keychain') await this._addKeychainWrap().catch((e) => { this.keychainError = { code: e.code, message: e.message }; });
    this._startMigration('reencrypt', newDek, { resume: true });
    return { state: this.state, recoveryKey, migration: this.securityStatus().migration };
  }

  async _closeForMigration() {
    const app = this.app;
    if (!app) return;
    this.state = 'migrating';
    this.emit('locking', { reason: 'migrating' });
    await app.close({ lock: false, stopOllama: false }).catch((e) => log.warn(`Closing the data for conversion: ${e.code || e.message}`));
    await flushWrites().catch(() => {});
    this.app = null;
  }

  _startMigration(op, toKey, { resume = false } = {}) {
    this.state = 'migrating';
    const prev = this.vault.meta.migration;
    const m = { ...(resume && prev?.op === op ? prev : {}), op, done: 0, total: 0, startedAt: (resume && prev?.startedAt) || new Date().toISOString(), error: null };
    this.migration = m;
    this.vault.setMigration(m);
    if (op === 'decrypt') setDirCipher(this.dataDir, { key: null, oldKeys: [this.vault.dek, ...(this._oldKeys || [])].filter(Boolean) });
    else setDirCipher(this.dataDir, { key: toKey, oldKeys: this._oldKeys || [] });
    this._emitState();
    const what = { encrypt: 'encrypting', decrypt: 'decrypting', reencrypt: 'reencrypting' }[op];
    let lastSave = 0;
    this._migrating = (async () => {
      try {
        await migrateDir(this.dataDir, {
          op,
          toKey,
          onProgress: ({ done, total }) => {
            Object.assign(m, { done, total });
            this.emitEvent({ type: 'progress', what, done, total });
            this.emit('progress', { op, done, total });
            if (Date.now() - lastSave > 1000 || done === total) { lastSave = Date.now(); this.vault.setMigration({ ...m }); }
          },
        });
        if (op === 'decrypt') this.vault.setEncrypted(false);
        this.vault.setMigration(null);
        this.migration = null;
        if (this._oldKeys) { for (const k of this._oldKeys) wipe(k); this._oldKeys = null; }
        // migrating → unlocked directly (no locked moment in between)
        if (op === 'decrypt') { setDirCipher(this.dataDir, null); this.vault.lock(); } else setDirCipher(this.dataDir, { key: this.vault.dek });
        await this._open();
      } catch (e) {
        m.error = e.code === 'migration_verify_failed' ? 'A converted file did not read back correctly; nothing was replaced. Try again.' : `Could not convert a file (${e.code || 'error'}).`;
        this.vault.setMigration({ ...m });
        log.error(`Data conversion (${op}) stopped: ${e.code || e.message}`);
        this._emitState();
      }
    })();
  }

  /** Retry a conversion that stopped with an error (POST /api/security/unlock while migrating with an error). */
  retryMigration() {
    if (this.state !== 'migrating' || !this.migration?.error) return false;
    const op = this.migration.op;
    this._startMigration(op, op === 'decrypt' ? null : this.vault.dek, { resume: true });
    return true;
  }

  // ------------------------------------------------------------------------------------------ activity / idle
  /** A user-initiated request (passive ones are not counted at all): activity, and open until it ends. */
  requestStarted() {
    this.inflight++;
    this.lastActivity = Date.now();
    let done = false;
    return () => { if (!done) { done = true; this.inflight--; this.lastActivity = Date.now(); } };
  }

  /** POST /api/security/activity: "the user is here". */
  touch() { this.lastActivity = Date.now(); return { ok: true, idleLockAt: this.idleLockAt({ ownRequests: 1 }) }; }

  /** When Harness would lock if nothing else happens (null: idle lock off, not applicable, or work is running). */
  idleLockAt({ ownRequests = 0 } = {}) {
    if (this.state !== 'unlocked' || this.mode !== 'password' || !this.vault.encrypted) return null;
    const min = this.idleLockMinutes();
    if (!min || this.inflight > ownRequests || this._busy()) return null;
    return new Date(this.lastActivity + min * 60000).toISOString();
  }

  _startIdleTimer() {
    clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => this._checkIdle(), IDLE_CHECK_MS);
    this.idleTimer.unref?.();
  }

  _busy() {
    const a = this.app;
    return !!(a && (a.engine.active.size || a.images.active || a.pulls?.size));
  }

  _checkIdle() {
    if (this.state !== 'unlocked' || this.mode !== 'password' || !this.vault.encrypted) return;
    const min = this.idleLockMinutes();
    if (!min) return;
    if (this.inflight > 0 || this._busy()) { this.lastActivity = Date.now(); return; }
    if (Date.now() - this.lastActivity >= min * 60000) this.lock('idle').catch((e) => log.warn(`Idle lock: ${e.code || e.message}`));
  }

  // ------------------------------------------------------------------------------------------ internet blocker
  _ollamaSandboxWanted() {
    return this.network?.blocked && !this.network.sandboxed;
  }

  // A managed Ollama follows only the user's allow/block action (the routes restart it); when the window ends on its
  // own the in-app blocker applies at once and Ollama is left alone (never restarted under a chat).
  _onNetworkChange({ status }) {
    this.app?.bus.publish('network.status', { offlineLock: status });
    this.emit('network', status);
  }

  /** Whether allowing internet access needs a restart of this process (the launcher sandboxed all of it). */
  get restartRequiredForAllow() { return !!this.network?.sandboxed; }

  // ------------------------------------------------------------------------------------------ shutdown
  async close() {
    clearInterval(this.idleTimer);
    await this._migrating?.catch(() => {});
    const app = this.app;
    this.app = null;
    if (app) await app.close({ lock: false, stopOllama: false }).catch((e) => log.warn(`Closing the data: ${e.code || e.message}`));
    const stopOnExit = this._ollamaCache.settings.ollama?.stopOnExit !== false;
    if (stopOnExit) await this.ollamaProcess.stop().catch(() => {});
    await flushWrites().catch(() => {});
    this.vault.lock();
    this.network?.dispose();
    setDirCipher(this.dataDir, null);
  }
}

export { VERSION };
