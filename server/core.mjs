// The part of Harness that outlives locking: protection mode, key store, sessions, the internet blocker and a
// managed Ollama. The `app` (stores, engines — everything that holds user data) exists only while unlocked: it is
// created when the data is opened and closed when Harness locks. docs/API.md §10.1–10.6.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { LaunchConfig } from './security/launch.mjs';
import { Vault } from './security/vault.mjs';
import { NetworkGuard, MAX_ALLOW_MINUTES } from './security/network.mjs';
import { Auth } from './security/auth.mjs';
import { chooseKeychain, KeychainError } from './security/keychain.mjs';
import { listDataFiles, migrateDir, hasPlainData, hasEncryptedData, keyIdsInUse, fixPermissions, repairForeignFiles } from './security/migrate.mjs';
import { seal, unseal, wipe, keyIdOf, setKdfDefaults } from './security/crypto.mjs';
import { instanceProof, parseNonce } from './security/instance-proof.mjs';
import { setDirCipher, ensureDir, flushWrites } from './lib/fsx.mjs';
import { HttpError } from './lib/errors.mjs';
import { httpRequest } from './lib/http-client.mjs';
import { log } from './lib/log.mjs';
import { createApp, detectSystem } from './app.mjs';
import { OllamaProcess } from './providers/ollama-process.mjs';
import { VERSION, ROOT_DIR } from './version.mjs';
import crypto from 'node:crypto';

const MODES = new Set(['password', 'keychain', 'off']);
const RANK = { off: 0, keychain: 1, password: 2 }; // how protective a mode is
const PASSWORD_RESET_MS = 10 * 60 * 1000;
const IDLE_CHECK_MS = Number(process.env.HARNESS_IDLE_CHECK_MS) || 30000;
const REKEY_AAD = 'harness-rekey-v1';

const newId = () => crypto.randomBytes(8).toString('hex');
/** The plain progress hint in vault.json for a conversion the record holds (never the old key). */
const hintOf = (m) => (m ? { op: m.op, id: m.id, done: 0, total: 0, startedAt: m.startedAt, error: null } : null);
/** An allow window from the record that is still running and no longer than the API allows. */
function windowOf(rec) {
  if (!rec.offlineLock || !rec.allowedUntil || !rec.allowFrom) return null;
  const until = Date.parse(rec.allowedUntil);
  const from = Date.parse(rec.allowFrom);
  return until > Date.now() && until - from <= (MAX_ALLOW_MINUTES + 1) * 60000 ? rec.allowedUntil : null;
}

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
    // the api-token is written and accepted only for a mode Harness verified (never on launch.json's word alone)
    this.modeVerified = false;
    this.auth = new Auth({ dataDir: this.dataDir, enabled: apiAuth !== false && transport === 'listener', mode: () => (this.modeVerified ? this.mode : 'password') });
    // 'file' | 'mac' | a store object (tests, the bridge's appKeychain); default: chooseKeychain's guarded choice
    this.keychain = keychain && typeof keychain === 'object' ? keychain : chooseKeychain(this.dataDir, { kind: typeof keychain === 'string' ? keychain : undefined });
    this.app = null;
    this.state = 'locked';
    this.mode = 'password';
    this.plainDataFound = false;
    this.migration = null;
    this.keychainError = null;
    this.tamper = null; // { at, fields } — plain settings that disagreed with the security record (§10.2)
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
    // A key store means: locked in an encrypted mode until its security record is opened with the key (§10.2).
    // Until then launch.json and the plain fields of vault.json may only make Harness MORE protective: "off" is
    // ignored, no api-token exists, the blocker is on and no allow window counts.
    const keyStore = this.vault.exists;
    // The mode: with a key store, an encrypted one until the record is opened (launch.json may only ask Harness to
    // TRY the Keychain); without one, only this process's own start option / environment may say "off" or
    // "keychain" (development) — launch.json never lowers anything, also not before the first setup.
    let mode = keyStore ? (this.modeOverride === 'keychain' || this.launch.get().encryption === 'keychain' ? 'keychain' : 'password') : this.modeOverride || 'password';
    if (!MODES.has(mode)) mode = 'password';
    // The blocker: from launch.json only in off mode without a key store (no password exists to protect it);
    // otherwise on, with no window, until a record (or the owner's setup) says otherwise.
    this.network = new NetworkGuard({ launch: this.launch, enabledOverride: this._lockOverride, trust: !keyStore && mode === 'off' ? 'launch' : 'locked' });
    this.network.persist = (v, o) => this._persistNetwork(v, o);
    this.network.ollamaInfo = () => {
      const p = this.ollamaProcess;
      return { managed: p.managed, sandboxed: !!p.sandboxed, external: !!p.external, osFallback: p.osFallback, osPending: p.managed && !p.sandboxed && p._useSandbox() };
    };
    this.network.on('change', (ev) => this._onNetworkChange(ev));
    this.mode = mode;
    // no key store and off mode: there is nothing to verify (and nothing a password protects)
    this.modeVerified = !keyStore && mode === 'off';
    this.migration = null;
    this.auth.syncTokenFile({ adopt: this.modeVerified });
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
    // A hint for the lock screen's wording only (an off-mode folder is not "encrypted on this Mac"): nothing decides
    // anything from it. Cleared once the record has been settled at the first unlock.
    this.plainDataFound = await hasPlainData(this.dataDir).catch(() => false);
    this.state = 'locked';
    setDirCipher(this.dataDir, 'locked');
    if (mode === 'keychain') {
      // No prompt possible for the dev file / the native app's key: wait for it. The macOS Keychain may show a
      // prompt, so the server comes up locked and opens as soon as the Keychain answers. The Keychain's key counts
      // only if the security record says keychain (checked in _afterKey).
      const p = this._unlockWithKeychain().catch((e) => {
        this.keychainError = { code: e.code || 'keychain_failed', message: e.message };
        if (e.code === 'keychain_not_enabled') this.mode = 'password';
        if (e.fatal) throw e;
      });
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
      passwordSet: this.vault.hasPassword,
      // wording only (needs_setup: 0.1 data to encrypt; locked: plain owned files, e.g. off mode) — decides nothing
      plainDataFound: this.state === 'needs_setup' || this.state === 'locked' ? this.plainDataFound : false,
      migration: this.migration ? { op: this.migration.op, done: this.migration.done, total: this.migration.total, startedAt: this.migration.startedAt, error: this.migration.error || null } : null,
      unlock: { failedAttempts: this.vault.meta?.throttle?.failures || 0, retryAfterMs: this.vault.exists ? this.vault.retryAfterMs() : 0, ...(this.keychainError ? { keychainError: this.keychainError } : {}) },
      recoveryKey: rk ? { createdAt: rk.createdAt } : null,
      idleLockMinutes: this.idleLockMinutes(),
      idleLockAt: this.idleLockAt(),
      session: authInfo ? { authenticated: !!authInfo.authenticated, via: authInfo.via || null } : { authenticated: false, via: null },
      transport: this.transport,
      offlineLock: this.network.status(),
      tamper: this.tamper ? { at: this.tamper.at, fields: [...this.tamper.fields] } : null,
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
      const app = this.app;
      app.bus.on('event', (ev) => {
        if (ev.type === 'settings.updated') {
          this._cacheFromSettings();
          // the configured Ollama address changed: the Ollama Harness started moves with it
          setImmediate(() => { if (this.app === app) this.ollamaProcess.followAddress().catch((e) => log.warn(`Moving Ollama: ${e.message}`)); });
        }
        // work ended: a chance to put Harness's Ollama back into the sandbox (never under the user's work)
        if (ev.type === 'generation.finished' || ev.type === 'image.done' || ev.type === 'image.error' || (ev.type === 'model.pull' && ['success', 'error', 'aborted'].includes(ev.data?.status))) {
          setTimeout(() => this.reconcileSandbox(ev.type), 50).unref?.();
        }
      });
      this.state = 'unlocked';
      this.lastActivity = Date.now();
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
      this.vault.lock(); // the record key too: nothing is written to the record while locked
      if (this._oldKeys) { for (const k of this._oldKeys) wipe(k); this._oldKeys = null; }
      if (this.mode !== 'keychain') this.auth.dropAll(); else this.auth.dropConfirmations();
      this.passwordResetUntil = 0;
      this._emitState();
      this.emit('locked', { reason });
      this.emitEvent({ type: 'locked' });
    })().finally(() => {
      this._locking = null;
      // models were unloaded: the moment to put Harness's Ollama back into the sandbox if it is outside
      this.reconcileSandbox('lock').catch(() => {});
    });
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
    const wanted = this.mode;
    const plain = this.plainDataFound || (await listDataFiles(this.dataDir)).length > 0;
    const recoveryKey = await this._createKeyStore(password, { plain });
    setDirCipher(this.dataDir, { key: this.vault.cipher.key });
    if (plain) this._startMigration('encrypt', this.vault.cipher.key, { resume: true });
    else await this._open();
    if (wanted === 'keychain') {
      // no password confirmation here: an existing item that is not ours is left alone (then: password mode)
      await this._addKeychainWrap().catch((e) => { this.keychainError = { code: e.code || 'keychain_failed', message: e.message }; });
    }
    return { state: this.state, recoveryKey, migration: this.securityStatus().migration };
  }

  /**
   * A new key store with its first security record — always the most protective one: password mode, the blocker
   * on, no allow window (nothing from before the password, such as launch.json, is carried into it); `plain` data
   * is to be encrypted (recorded as the conversion in progress). The owner lowers anything later, with the password.
   */
  async _createKeyStore(password, { plain }) {
    const now = new Date().toISOString();
    const migration = plain ? { op: 'encrypt', id: newId(), startedAt: now } : null;
    const state = { mode: 'password', encrypted: true, offlineLock: true, allowedUntil: null, allowFrom: null, migration };
    const recoveryKey = await this.vault.create(password, { encrypted: true, migration: hintOf(migration), state });
    this.launch.set({ encryption: 'password', offlineLock: true, offlineLockSuspendedUntil: null });
    this.mode = 'password';
    this.modeVerified = true;
    this.tamper = null;
    this.auth.syncTokenFile();
    this.network.setTrusted({ enabled: true });
    return recoveryKey;
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
    let via = null;
    if (typeof password === 'string' && password) {
      if (already) await this.confirmPassword(password);
      else { await this.vault.unlockWithPassword(password); via = 'password'; }
    } else if (typeof recoveryKey === 'string' && recoveryKey) {
      await this.vault.unlockWithRecoveryKey(recoveryKey);
      if (already && !this.vault.encrypted) this._wipeIfPlain();
      this.passwordResetUntil = Date.now() + PASSWORD_RESET_MS;
      via = 'recovery';
    } else {
      if (this.mode !== 'keychain') throw new HttpError(400, 'bad_request', 'Send { "password": "…" } or { "recoveryKey": "…" }.');
      if (!ctx.authenticated) throw new HttpError(401, 'auth_required', 'Open Harness from its launcher (or send the password).', { reason: 'missing', unlock: false });
      if (!already) await this._unlockWithKeychain();
    }
    if (!already && via) await this._afterKey(via);
    return { state: this.state, passwordReset: this.passwordResetUntil > Date.now() ? { until: new Date(this.passwordResetUntil).toISOString() } : null };
  }

  /** The Keychain's key, if it opens this key store's keychain wrap (thrown errors say why not). */
  async _keychainKey() {
    let kek;
    try { kek = await this.keychain.get(); } catch (e) {
      this._keychainFailed = true;
      if (e instanceof KeychainError) throw new HttpError(503, 'keychain_unavailable', e.message, { reason: e.reason });
      throw e;
    }
    if (!kek) { this._keychainFailed = true; throw new HttpError(503, 'keychain_unavailable', 'The Keychain holds no Harness key. Enter the password instead.', { reason: 'not_found' }); }
    return kek;
  }

  async _unlockWithKeychain() {
    const kek = await this._keychainKey();
    const dek = this.vault.unlockWithKeychainKey(kek);
    wipe(kek);
    if (!dek) {
      this._keychainFailed = true;
      const e = new HttpError(401, 'wrong_key', 'The key from the Keychain does not open this data. Enter the password instead.');
      if (this.keychain.kind === 'app') e.fatal = true;
      throw e;
    }
    this.keychainError = null;
    this._keychainFailed = false;
    await this._afterKey('keychain');
  }

  /**
   * After a password or recovery-key unlock with a record that says keychain: keychain mode is in force only while
   * the Keychain holds the key of THIS data (otherwise Harness runs as in password mode: idle lock, no api-token).
   * A Keychain that already failed in this process is not asked again.
   */
  async _keychainHoldsOurKey() {
    if (this._keychainFailed) return false;
    try {
      const k = await this._keychainKey();
      const ours = this.vault.keychainKeyOpens(k);
      wipe(k);
      if (!ours) {
        this._keychainFailed = true;
        this.keychainError = { code: 'wrong_key', message: 'The key in the Keychain does not open this data; Harness asks for the password until you choose keychain mode again.' };
      }
      return ours;
    } catch (e) {
      this.keychainError = { code: e.code || 'keychain_failed', message: e.message };
      return false;
    }
  }

  /**
   * The data key is in memory: open the security record, settle what the plain files claim against it, then
   * finish a conversion the record holds, or open the data. Runs once at a time; a failure leaves Harness locked.
   */
  async _afterKey(via) {
    if (this.state === 'unlocked' || this.state === 'migrating') return;
    this._afterKeyP ||= (async () => {
      try {
        const rec = await this._settleRecord(via);
        const m = rec.migration;
        if (m?.op === 'reencrypt') {
          const old = unseal(this.vault.dek, m.oldKey, REKEY_AAD);
          if (old) this._oldKeys = [old];
        }
        setDirCipher(this.dataDir, { key: this.vault.dek, oldKeys: this._oldKeys || [] });
        // an earlier 0.2 build encrypted launcher files (desktop.json, native/, Electron/): give them back
        const repaired = await repairForeignFiles(this.dataDir).catch(() => 0);
        if (repaired) log.warn(`Decrypted ${repaired} launcher file(s) that an earlier version had encrypted by mistake.`);
        if (m) { this._startMigration(m.op, m.op === 'decrypt' ? null : this.vault.dek, { resume: true }); return; }
        await this._open();
        this._wipeIfPlain();
      } catch (e) {
        // still locked (the record refused, or the data did not open): no key stays in memory
        if (this.state === 'locked') {
          this.vault.lock();
          setDirCipher(this.dataDir, 'locked');
          if (this._oldKeys) { for (const k of this._oldKeys) wipe(k); this._oldKeys = null; }
        }
        throw e;
      }
    })().finally(() => { this._afterKeyP = null; });
    return this._afterKeyP;
  }

  /**
   * Decide from the security record (docs/API.md §10.2) and make everything else agree with it:
   *   - a current, authentic record decides the mode, the blocker, the allow window and any conversion;
   *   - none, or one that is not authentic or current: the most protective reading (never below password mode);
   *   - launch.json and the plain fields of vault.json only ever make it MORE protective; where they claim less,
   *     they are rewritten, logged once and reported as `tamper` until the owner dismisses it;
   *   - unlocking with the Keychain's key counts only when the record says keychain;
   *   - key material is never dropped: a re-key in progress keeps its previous key (from the record, its intact
   *     copy in vault.json.bak, or the previous-key wraps the password opens); when files are under a key this key
   *     store no longer holds and the record is not intact, Harness goes to state `error` and writes nothing.
   * Returns the record now in force (written when anything changed).
   */
  async _settleRecord(via) {
    const r = this.vault.readState();
    const launch = this.launch.get();
    const pm = this.vault.meta.migration || null;
    const pv = this.vault.meta.wraps.previous || null;
    const report = r.status !== 'missing';
    const fields = new Set(this._pendingTamper || []);
    const why = {
      stale: 'vault.json: security record (an older copy)',
      invalid: 'vault.json: security record (not sealed with this key)',
      removed: 'vault.json: security record (removed)',
      unverifiable: `vault-seq.json: ${r.mirror?.reason || 'unreadable'} — an older vault.json cannot be told from the current one, so the most protective settings apply until it is a readable file again`,
    };
    if (this.vault.restoredRecord) {
      fields.add('vault.json: security record (damaged; restored from vault.json.bak)');
      log.warn('The security record in vault.json was damaged; restored it from its verified copy vault.json.bak.');
    }
    if (this.vault.restoredWraps) {
      this.vault.restoredWraps = false;
      fields.add('vault.json: a key wrap (damaged; restored from vault.json.bak)');
      log.warn('A key wrap in vault.json did not open; the one in its verified copy vault.json.bak did and is used again.');
    }
    let rec;
    if (r.status === 'ok') rec = { ...r.record };
    else {
      if (why[r.status]) fields.add(why[r.status]);
      rec = await this._protectiveReading(r, via);
    }
    // No record anywhere and nothing that shows one existed, on a folder that already holds encrypted data: whatever
    // the owner had recorded is now the protective default — say so. (A key store written before records existed
    // looks the same, so it gets this notice once, at its first unlock; its reading is unchanged.)
    if (r.status === 'missing' && (await hasEncryptedData(this.dataDir))) fields.add('vault.json: security record (missing in vault.json, vault.json.bak and vault-seq.json, although the folder holds encrypted data)');
    if (via === 'keychain' && rec.mode !== 'keychain') {
      // the key store has a keychain wrap, but the authenticated record does not say keychain: the password decides
      if (launch.encryption === 'keychain' || this.modeOverride === 'keychain') fields.add('launch.json: encryption');
      this._pendingTamper = [...fields];
      log.warn('The Keychain opened the key store, but the security record does not allow opening without the password; Harness stays locked.');
      throw new HttpError(401, 'keychain_not_enabled', 'Keychain mode is not on for this data. Enter the password.');
    }
    // A re-key in progress: its previous key from the record — or, with the password, from the previous-key wraps.
    const dek = this.vault.dek;
    const scan = r.status !== 'ok' || pv || rec.migration?.op === 'reencrypt' ? await keyIdsInUse(this.dataDir) : null;
    let oldKeyId = null;
    if (rec.migration?.op === 'reencrypt') {
      const k = unseal(dek, rec.migration.oldKey, REKEY_AAD);
      if (k) { oldKeyId = keyIdOf(k).toString('hex'); wipe(k); } else rec.migration = null;
    }
    if (!oldKeyId && pv && this.vault.previousKey && scan.has(pv.keyId)) {
      oldKeyId = pv.keyId;
      rec.migration = { op: 'reencrypt', id: newId(), startedAt: new Date().toISOString(), oldKey: seal(dek, this.vault.previousKey, REKEY_AAD), oldKeyId };
    }
    // Without an intact record, every encrypted file must be readable with a key we hold — else nothing is written.
    if (r.status !== 'ok') {
      const unknown = [...scan.entries()].filter(([id]) => id !== this.vault.keyId && id !== oldKeyId);
      if (unknown.length) {
        if (via === 'keychain' && pv) throw new HttpError(401, 'password_needed', 'A re-key was interrupted: enter the password to finish it.');
        const n = unknown.reduce((a, [, c]) => a + c, 0);
        this._failClosed('vault_corrupt', `${n} encrypted file(s) in this folder are under a data key this key store no longer holds: a re-key was interrupted and the key store's copy of the previous key is damaged or missing (in vault.json and vault.json.bak). Nothing has been changed. Restore vault.json and vault.json.bak from a backup of this folder made before the re-key, then open Harness again.`);
      }
    }
    this._pendingTamper = null;
    // "not encrypted" must agree with the folder: encrypted files under such a record mean it is not this folder's truth
    if (!rec.encrypted && (await hasEncryptedData(this.dataDir))) {
      fields.add('vault.json: security record (says the data is not encrypted)');
      rec = { ...rec, mode: 'password', encrypted: true, migration: null };
    }
    // the plain hints: lower than the record → ignored and reported; higher → harmless
    if (RANK[launch.encryption] < RANK[rec.mode] && report) fields.add('launch.json: encryption');
    if (this.vault.meta.encrypted === false && rec.encrypted && report) fields.add('vault.json: encrypted');
    if (pm && pm.op !== 'encrypt' && pm.op !== rec.migration?.op && report) fields.add('vault.json: migration');
    // a conversion TO encryption may resume from the plain hint alone (it only raises protection)
    if (!rec.migration && rec.encrypted && pm?.op === 'encrypt') rec.migration = { op: 'encrypt', id: typeof pm.id === 'string' ? pm.id : newId(), startedAt: pm.startedAt || new Date().toISOString() };
    // the blocker: launch.json may turn it on or shorten the window, never more
    const lu = launch.offlineLockSuspendedUntil && Date.parse(launch.offlineLockSuspendedUntil) > Date.now() ? launch.offlineLockSuspendedUntil : null;
    if (launch.offlineLock === false && rec.offlineLock && report) fields.add('launch.json: offlineLock');
    if (launch.offlineLock !== false) rec.offlineLock = true;
    let until = windowOf(rec);
    if (lu && rec.offlineLock && (!until || Date.parse(lu) > Date.parse(until)) && report) fields.add('launch.json: offlineLockSuspendedUntil');
    if (until && (!lu || Date.parse(lu) < Date.parse(until))) until = lu;
    rec.allowedUntil = until;
    rec.allowFrom = until ? rec.allowFrom : null;
    if (fields.size) {
      rec.tamper = { at: new Date().toISOString(), fields: [...new Set([...(rec.tamper?.fields || []), ...fields])] };
      const fresh = [...fields].filter((f) => !this._warned?.has(f));
      if (fresh.length) log.warn(`Security settings were changed outside Harness and were ignored (the authenticated record decides): ${fresh.join('; ')}`);
      this._warned = new Set([...(this._warned || []), ...fields]);
    }
    // the previous-key wraps go only when no file is under that key any more (and no re-key holds it)
    const dropPrevious = !!pv && rec.migration?.op !== 'reencrypt' && !!scan && !scan.has(pv.keyId);
    // write what is now in force — the record (when it changed) and the plain files (when they disagree)
    const keys = ['mode', 'encrypted', 'offlineLock', 'allowedUntil', 'allowFrom', 'migration', 'tamper'];
    const changed = r.status !== 'ok' || keys.some((k) => JSON.stringify(rec[k] ?? null) !== JSON.stringify(r.record[k] ?? null));
    const plainOk = this.vault.meta.encrypted === rec.encrypted && (pm?.op || null) === (rec.migration?.op || null) && (!pm || !pm.oldKey) && !dropPrevious;
    if (changed || !plainOk) {
      const keep = pm && rec.migration && pm.op === rec.migration.op;
      rec = this.vault.commit(Object.fromEntries(keys.map((k) => [k, rec[k] ?? null])), { mutate: (m) => {
        m.encrypted = rec.encrypted;
        m.migration = keep ? { ...hintOf(rec.migration), done: pm.done || 0, total: pm.total || 0 } : hintOf(rec.migration);
        if (dropPrevious) this.vault.dropPrevious(m);
      } });
    }
    if (this.vault.mirrorError && !this._mirrorWarned) {
      this._mirrorWarned = true;
      log.warn(`Could not write vault-seq.json (${this.vault.mirrorError}): an older vault.json put back could not be recognised. Make it a writable file in the data folder again.`);
    }
    const hint = { encryption: rec.mode, offlineLock: rec.offlineLock, offlineLockSuspendedUntil: rec.allowedUntil };
    if (Object.entries(hint).some(([k, v]) => (launch[k] ?? null) !== v)) { try { this.launch.set(hint); } catch (e) { log.warn(`Could not rewrite launch.json: ${e.code || e.message}`); } }
    // in force from now on, in this process
    this.tamper = rec.tamper || null;
    this.network.setTrusted({ enabled: rec.offlineLock, allowedUntil: rec.allowedUntil, allowFrom: rec.allowFrom });
    let mode = rec.mode;
    if (mode === 'keychain' && via !== 'keychain' && !(await this._keychainHoldsOurKey())) mode = 'password';
    this.mode = mode;
    this.modeVerified = true;
    this.auth.syncTokenFile({ fresh: !this._tokenIssued });
    this._tokenIssued = true;
    this.migration = null;
    this.plainDataFound = false; // a lock later in this process only follows a finished conversion (or none is possible)
    // the blocker is off by the owner's choice: an Ollama started while locked (sandboxed) leaves the sandbox
    if (!this.network.blocked && this.ollamaProcess.sandboxed) this.ollamaProcess.applySandbox().catch((e) => log.warn(`Restarting Ollama outside the sandbox: ${e.message}`));
    return rec;
  }

  /** The key store cannot be used safely: state `error`, the key forgotten, nothing written. */
  _failClosed(code, message) {
    this.vault.lock();
    setDirCipher(this.dataDir, 'locked');
    this.state = 'error';
    this.error = { code, message };
    log.error(`Cannot open the data: ${code}`);
    this._emitState();
    throw new HttpError(503, code, message);
  }

  /**
   * No current, authentic record (a key store from 0.2.0, or one whose record was removed, replaced, damaged or
   * rolled back): the most protective reading — NEVER below password mode, whatever launch.json, vault.json or the
   * folder's contents say (keychain only for a 0.2.0 key store the Keychain itself opened); encrypted (plain files are
   * encrypted at this unlock); the blocker on, no allow window; a decryption is never resumed; a re-key is (it only
   * re-encrypts to the current key): from an authentic record that is not current, or 0.2.0's sealed old key — the
   * previous-key wraps are added by the caller.
   */
  async _protectiveReading(r, via) {
    const launch = this.launch.get();
    const pm = this.vault.meta.migration || null;
    const now = new Date().toISOString();
    const rec = { mode: 'password', encrypted: true, offlineLock: true, allowedUntil: null, allowFrom: null, migration: null, tamper: r.record?.tamper || null };
    if (r.status === 'missing' && via === 'keychain' && launch.encryption === 'keychain') rec.mode = 'keychain';
    const legacyOld = r.status === 'missing' && pm?.op === 'reencrypt' && pm.oldKey ? unseal(this.vault.dek, pm.oldKey, REKEY_AAD) : null;
    if (r.record?.migration?.op === 'reencrypt') rec.migration = r.record.migration;
    else if (legacyOld) rec.migration = { op: 'reencrypt', id: newId(), startedAt: pm.startedAt || now, oldKey: pm.oldKey, oldKeyId: keyIdOf(legacyOld).toString('hex') };
    else if (pm?.op === 'encrypt' || (await hasPlainData(this.dataDir))) rec.migration = { op: 'encrypt', id: newId(), startedAt: now };
    wipe(legacyOld);
    if (pm?.op === 'decrypt') log.warn('A decryption that had been started was not resumed (it has no authentic record): Harness keeps the data encrypted and encrypts any file it had already decrypted. To store the data without encryption, choose "off" again in Settings with your password.');
    if (this.vault.meta.encrypted === false || launch.encryption === 'off') log.warn('This folder was marked as stored without encryption, but that setting has no authentic record: Harness runs in password mode and encrypts any plain file now. To store the data without encryption, choose "off" again in Settings with your password.');
    if (r.status === 'missing') {
      if (launch.offlineLock === false || launch.offlineLockSuspendedUntil) log.warn('The internet blocker is on again after this update (its setting had no authenticated record yet); turn it off in Settings with your password if you want it off.');
      if (launch.encryption === 'keychain' && rec.mode !== 'keychain') log.warn('Keychain mode was not confirmed by the Keychain at this first start after the update; Harness asks for the password. Choose keychain mode again in Settings if you want it.');
      log.info('This key store had no security record yet (Harness 0.2.0): written now.');
    }
    return rec;
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
    // only the key that seals the security record stays (off mode has no lock; the blocker's changes need it)
    if (!this.vault.encrypted && !this.migration && this.state !== 'migrating') this.vault.lock({ keepStateKey: true });
  }

  /** The internet blocker changed (NetworkGuard.persist): into the security record. Lowering needs the key. */
  _persistNetwork(v, { lowering }) {
    if (!this.vault.stateKey) {
      if (lowering) throw new HttpError(423, 'locked', 'Harness is locked.');
      return;
    }
    this.vault.commit({ offlineLock: v.enabled, allowedUntil: v.allowedUntil, allowFrom: v.allowFrom });
  }

  /**
   * POST /api/security/prove: show that this process holds the data key, without a session and without revealing
   * anything (an HMAC under a subkey used for nothing else, bound to where the request arrived — instance-proof.mjs).
   * Never logged.
   */
  proveInstance(nonceText, binding) {
    const nonce = parseNonce(nonceText);
    if (!nonce) throw new HttpError(400, 'bad_request', 'nonce must be base64url of 16–64 random bytes');
    if (this.mode === 'off' && this.modeVerified) throw new HttpError(409, 'not_encrypted', 'Harness runs without encryption: there is no data key to prove.');
    if (!this.vault.dek) throw new HttpError(423, 'locked', 'Harness is locked: unlock it in its own window first.');
    return { proof: instanceProof(this.vault.dek, nonce, binding).toString('base64url') };
  }

  /** POST /api/security/tamper/dismiss: the owner has seen the notice. */
  dismissTamper() {
    this.requireApp();
    if (!this.tamper) return { tamper: null };
    if (!this.vault.stateKey) throw new HttpError(423, 'locked', 'Harness is locked.');
    this.vault.commit({ tamper: null });
    this.tamper = null;
    return { tamper: null };
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
      recoveryKey = await this._createKeyStore(newPassword, { plain: true });
      this.app && await this._closeForMigration();
      this._startMigration('encrypt', this.vault.dek, { resume: true });
      if (mode === 'keychain') await this._addKeychainWrap({ confirmed: true });
      return { mode, state: this.state, recoveryKey };
    }
    await this.requireConfirmation({ password, header, sessionHash, needKey: true });
    // the record's mode: in force, or keychain while the Keychain does not hold the key (then Harness runs as in
    // password mode until keychain mode is chosen again)
    const from = this.vault.record?.mode || this.mode;
    if (mode === from && mode === 'keychain' && this.mode !== 'keychain') { await this._addKeychainWrap({ confirmed: true }); return { mode: this.mode, state: this.state }; }
    if (mode === from && (mode !== 'off' || !this.vault.encrypted)) { this._wipeIfPlain(); return { mode, state: this.state }; }
    let rekeyRecommended = false;
    let ours = false;
    if (from === 'keychain' && mode !== 'keychain') {
      // password-confirmed; still, only an item that holds THIS data's key is deleted
      try { const k = await this.keychain.get(); ours = !!k && this.vault.keychainKeyOpens(k); if (k) wipe(k); } catch (e) { log.warn(`Could not read the Keychain item: ${e.reason || e.message}`); }
      rekeyRecommended = true;
    }
    const dropItem = async () => {
      if (from !== 'keychain' || mode === 'keychain') return;
      if (ours) await this.keychain.delete().catch((e) => log.warn(`Could not remove the Keychain item: ${e.reason || e.message}`));
      else log.info('Left the Keychain item alone: it does not hold the key of this data.');
    };
    if (mode === 'off') {
      // lowering: the record first (with the keychain wrap gone in the same save), then launch.json
      const mig = { op: 'decrypt', id: newId(), startedAt: new Date().toISOString() };
      this.vault.commit({ mode: 'off', migration: mig }, { mutate: (m) => { delete m.wraps.keychain; m.migration = hintOf(mig); } });
      await dropItem();
      this.launch.set({ encryption: 'off' });
      this.mode = 'off';
      this.auth.syncTokenFile();
      await this._closeForMigration();
      this._startMigration('decrypt', null, { resume: true });
      return { mode, state: this.state, rekeyRecommended: false };
    }
    if (from === 'off') {
      // Back to encryption: under a NEW data key (and a new recovery key, shown once), so that nothing recorded
      // under the old key — a decryption in progress, say — can ever apply to the data encrypted from now on.
      if (!(typeof password === 'string' && password) || !this.vault.dek) throw new HttpError(403, 'confirmation_required', 'Enter your Harness password: turning encryption on makes a new data key, which the password wraps.');
      const oldDek = Buffer.from(this.vault.dek);
      const newDek = crypto.randomBytes(32);
      const mig = { op: 'encrypt', id: newId(), startedAt: new Date().toISOString() };
      // a file still under the old key (normally none after a finished decryption) keeps that key wrapped too
      const keepPrevious = (await keyIdsInUse(this.dataDir)).has(this.vault.keyId);
      await this._closeForMigration();
      try {
        recoveryKey = await this.vault.replaceKey(newDek, password, { migration: hintOf(mig), mutate: (m) => { m.encrypted = true; }, state: { mode: 'password', encrypted: true, migration: mig }, keepPrevious });
      } catch (e) {
        wipe(oldDek);
        this.state = 'locked';
        await this._open();
        this._wipeIfPlain();
        throw e;
      }
      this._oldKeys = [oldDek]; // a file still under the old key stays readable while converting
      this.launch.set({ encryption: 'password' });
      this.mode = 'password';
      this.auth.syncTokenFile();
      this._startMigration('encrypt', newDek, { resume: true });
      if (mode === 'keychain') await this._addKeychainWrap({ confirmed: true });
      return { mode, state: this.state, recoveryKey };
    }
    if (mode === 'keychain') {
      await this._addKeychainWrap({ confirmed: true });
    } else {
      // keychain → password raises protection: launch.json first, then the record (and the wrap) in one save
      this.launch.set({ encryption: 'password' });
      this.mode = 'password';
      this.auth.syncTokenFile();
      this.vault.setKeychainWrap(false, { state: { mode: 'password' } });
      await dropItem();
    }
    return { mode: this.mode, state: this.state, ...(rekeyRecommended ? { rekeyRecommended } : {}) };
  }

  /**
   * Add the keychain wrap and store its key. An existing item that does not open this data is replaced only when
   * `confirmed` (the user typed the password for this action); a store that cannot be read is never written.
   */
  async _addKeychainWrap({ confirmed = false } = {}) {
    let existing = null;
    try { existing = await this.keychain.get(); } catch (e) {
      throw new HttpError(503, 'keychain_unavailable', e.message || 'The Keychain could not be read; nothing was changed.', { reason: e.reason || 'failed' });
    }
    if (existing) {
      const ours = this.vault.keychainKeyOpens(existing);
      wipe(existing);
      if (!ours && !confirmed) throw new HttpError(409, 'keychain_item_exists', 'The Keychain already holds a Harness key that does not open this data; it was left alone. Choose keychain mode in the settings (with your password) to replace it.');
    }
    // lowering: the record says keychain in the same save that adds the wrap, before launch.json does
    const kek = this.vault.setKeychainWrap(true, { state: { mode: 'keychain' } });
    this.launch.set({ encryption: 'keychain' });
    this.mode = 'keychain';
    this.auth.syncTokenFile();
    try {
      await this.keychain.set(kek);
      this.keychainError = null;
      this._keychainFailed = false;
    } catch (e) {
      this.launch.set({ encryption: 'password' });
      this.mode = 'password';
      this.auth.syncTokenFile();
      this.vault.setKeychainWrap(false, { state: { mode: 'password' } });
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
      // the old key travels sealed under the new one, inside the security record, until every file is converted
      // (crash → resumed at unlock, from the record only)
      const mig = { op: 'reencrypt', id: newId(), startedAt: new Date().toISOString(), oldKey: seal(newDek, oldDek, REKEY_AAD), oldKeyId: keyIdOf(oldDek).toString('hex') };
      recoveryKey = await this.vault.replaceKey(newDek, password, { migration: hintOf(mig), state: { migration: mig }, keepPrevious: true });
    } catch (e) {
      wipe(oldDek);
      this.state = 'locked';
      await this._open();
      throw e;
    }
    this._oldKeys = [oldDek];
    setDirCipher(this.dataDir, { key: newDek, oldKeys: this._oldKeys });
    if (this.mode === 'keychain') await this._addKeychainWrap({ confirmed: true }).catch((e) => { this.keychainError = { code: e.code, message: e.message }; });
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
    const recM = this.vault.record?.migration?.op === op ? this.vault.record.migration : null;
    // the plain hint carries progress only (never the old key: that lives in the security record)
    const m = { op, id: recM?.id || (resume && prev?.op === op && prev.id) || newId(), done: 0, total: 0, startedAt: recM?.startedAt || (resume && prev?.op === op && prev.startedAt) || new Date().toISOString(), error: null };
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
        // finished: the record and the plain hints in one save
        const plain = op === 'decrypt';
        // every file is verified under the target key now: the previous key's wraps can go, in the same save
        this.vault.commit({ migration: null, ...(plain ? { encrypted: false } : {}) }, { mutate: (meta) => { meta.migration = null; if (plain) meta.encrypted = false; else this.vault.dropPrevious(meta); } });
        if (!plain) { wipe(this.vault.previousKey); this.vault.previousKey = null; }
        this.migration = null;
        if (this._oldKeys) { for (const k of this._oldKeys) wipe(k); this._oldKeys = null; }
        // migrating → unlocked directly (no locked moment in between)
        if (plain) { setDirCipher(this.dataDir, null); this.vault.lock({ keepStateKey: true }); } else setDirCipher(this.dataDir, { key: this.vault.dek });
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
  _onNetworkChange({ reason, status }) {
    this.app?.bus.publish('network.status', { offlineLock: status });
    this.emit('network', status);
    if (reason === 'window_ended' || reason === 'download_done') this.reconcileSandbox(reason);
  }

  /**
   * Internet access is blocked again but Harness's own Ollama runs outside the sandbox (it was restarted without
   * it for an allow window): put it back at the first moment that costs the user nothing — Harness locked, or
   * nothing running (no generation, pull or image job) and no model loaded. Never under the user's work. While it
   * waits, offlineLock.osPending is true and an unref'd timer looks again about once a minute.
   */
  async reconcileSandbox(trigger = 'check') {
    if (this._closed) return false;
    const p = this.ollamaProcess;
    const pending = () => p.managed && !p.sandboxed && p._useSandbox();
    if (this._reconciling) return false;
    if (!pending()) { this._stopReconcileTimer(); return false; }
    this._reconciling = true;
    try {
      if (!(await this._ollamaIdle())) { this._startReconcileTimer(); return false; }
      if (!pending()) return false;
      log.info(`Putting the Ollama Harness started back into the offline-lock sandbox (${trigger})`);
      await p.applySandbox();
      return !pending();
    } catch (e) {
      log.warn(`Putting Ollama back into the sandbox: ${e.message}`);
      return false;
    } finally {
      this._reconciling = false;
      if (pending()) this._startReconcileTimer(); else this._stopReconcileTimer();
      this.app?.bus.publish('network.status', { offlineLock: this.network.status() });
    }
  }

  _startReconcileTimer() {
    if (this._reconcileTimer) return;
    this._reconcileTimer = setInterval(() => this.reconcileSandbox('timer'), Number(process.env.HARNESS_RECONCILE_MS) || 60000);
    this._reconcileTimer.unref?.();
  }

  _stopReconcileTimer() { clearInterval(this._reconcileTimer); this._reconcileTimer = null; }

  /** Nothing of the user's runs on Harness's Ollama: locked (models unloaded then), or idle with no model loaded. */
  async _ollamaIdle() {
    const app = this.app;
    if (!app || this.state !== 'unlocked') return !this._opening;
    if (app.engine.active.size || app.images.active || app.pulls?.size || app.background?.running) return false;
    const ollama = app.registry.ollama();
    if (!ollama) return true;
    const ps = await Promise.race([ollama.ps().catch(() => null), new Promise((r) => setTimeout(() => r(null), 3000))]);
    return Array.isArray(ps) && ps.length === 0;
  }

  /** Whether allowing internet access needs a restart of this process (the launcher sandboxed all of it). */
  get restartRequiredForAllow() { return !!this.network?.sandboxed; }

  // ------------------------------------------------------------------------------------------ shutdown
  async close() {
    this._closed = true;
    clearInterval(this.idleTimer);
    this._stopReconcileTimer();
    await this._migrating?.catch(() => {});
    const app = this.app;
    this.app = null;
    if (app) await app.close({ lock: false, stopOllama: false }).catch((e) => log.warn(`Closing the data: ${e.code || e.message}`));
    // no start after this (a late reconcile or auto-start must not leave an orphan Ollama behind)
    const stopOnExit = this._ollamaCache.settings.ollama?.stopOnExit !== false;
    await this.ollamaProcess.shutdown({ stop: stopOnExit }).catch(() => {});
    await flushWrites().catch(() => {});
    this.vault.lock();
    this.network?.dispose();
    setDirCipher(this.dataDir, null);
  }
}

export { VERSION };
