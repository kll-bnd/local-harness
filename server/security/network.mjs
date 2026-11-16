// "Block all internet access": one switch (on by default) and an explicit, time-boxed allow window. The in-code
// blocker (egress.mjs) is the feature; the OS sandbox around an Ollama that Harness starts itself is a silent bonus
// reported as osEnforced/osScope.
//
// Where the setting comes from (docs/API.md §10.2) — `trust`:
//   'launch'  no key store (off mode, never a password): launch.json is the only place, and the API itself lets
//             anyone turn the blocker off then, so trusting the file lowers nothing.
//   'locked'  a key store exists but its security record has not been opened yet: blocked, no allow window —
//             whatever launch.json says (an unauthenticated file may only make Harness more protective).
//   'record'  the values Harness verified against the authenticated record (or the owner set in this process). They
//             live in memory; launch.json is only written as a hint for the launchers and never read again.
// Changes go through `persist(values, { lowering })` (the core writes the record): a change that lowers protection
// is written to the record BEFORE launch.json and fails if it cannot be; one that raises it is written to launch.json
// first, so a crash in between always leaves the more protective reading.
import { EventEmitter } from 'node:events';
import { registerGuard, unregisterGuard, closeBlockedConnections } from './egress.mjs';

export const MAX_ALLOW_MINUTES = 120;
const DOWNLOAD_GRACE_MS = 60 * 60 * 1000; // a download started inside the window may run on for up to an hour

export class NetworkGuard extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./launch.mjs').LaunchConfig} o.launch
   * @param {boolean} [o.sandboxed]       the launcher started this process inside the offline-lock sandbox
   * @param {boolean} [o.enabledOverride] force the setting (tests / development opt-out)
   * @param {'launch'|'locked'} [o.trust] see above
   */
  constructor({ launch, sandboxed = process.env.HARNESS_SANDBOXED === '1', enabledOverride, trust = 'launch' } = {}) {
    super();
    this.launch = launch;
    this.sandboxed = sandboxed;
    this.override = enabledOverride;
    this.trust = trust;
    this.rec = { enabled: true, allowedUntil: null, allowFrom: null };
    this.persist = null;
    this.downloads = new Set();
    this.timer = null;
    this.ollama = { managed: false, sandboxed: false, external: false };
    registerGuard(this);
    this._arm();
  }

  dispose() { unregisterGuard(this); clearTimeout(this.timer); }

  /** The setting as verified (or, with no key store, as launch.json has it). */
  get setting() {
    if (this.trust === 'launch') { const l = this.launch.get(); return { enabled: l.offlineLock !== false, allowedUntil: l.offlineLockSuspendedUntil || null, allowFrom: null }; }
    if (this.trust === 'locked') return { enabled: true, allowedUntil: null, allowFrom: null };
    return { ...this.rec };
  }

  get enabled() { return this.override !== undefined ? this.override : this.setting.enabled; }

  get allowedUntil() {
    const u = this.setting.allowedUntil;
    return u && Date.parse(u) > Date.now() ? u : null;
  }

  /** The verified values take over (after an unlock, or at setup); launch.json is no longer read. */
  setTrusted({ enabled, allowedUntil = null, allowFrom = null }) {
    this.trust = 'record';
    this.rec = { enabled: enabled !== false, allowedUntil: enabled !== false ? allowedUntil : null, allowFrom: enabled !== false && allowedUntil ? allowFrom : null };
    this._arm();
    this._changed('verified');
  }

  /** Waiting for a download that started inside an allow window that has ended. */
  get waitingFor() { return !this.allowedUntil && this.downloads.size && this._windowEndedAt && Date.now() - this._windowEndedAt < DOWNLOAD_GRACE_MS ? 'model_download' : null; }

  get blocked() { return this.enabled && !this.allowedUntil && !this.waitingFor; }

  status() {
    const blocked = this.blocked;
    const o = this.ollamaInfo ? this.ollamaInfo() : this.ollama;
    const osScope = !blocked || this.osBroken ? 'none' : this.sandboxed ? 'backend' : o.managed && o.sandboxed ? 'ollama' : 'none';
    return { enabled: this.enabled, blocked, allowedUntil: this.allowedUntil, waitingFor: this.waitingFor, osEnforced: osScope !== 'none', osScope, externalOllama: !!o.external, osPending: !!(blocked && o.osPending), osFallback: o.osFallback || null };
  }

  /** Apply a change: the record (via `persist`) and launch.json in the order that keeps a crash on the safe side. */
  _apply(next, { lowering }) {
    const hint = { offlineLock: next.enabled, offlineLockSuspendedUntil: next.allowedUntil };
    if (this.trust === 'locked' && lowering) throw Object.assign(new Error('Harness is locked.'), { code: 'locked' });
    if (this.trust !== 'record') { this.launch.set(hint); return; }
    if (lowering) {
      if (!this.persist) throw Object.assign(new Error('no record'), { code: 'locked' });
      this.persist(next, { lowering: true }); // throws when the record cannot be written: nothing changes
      this.rec = { ...next };
      this.launch.set(hint);
    } else {
      this.rec = { ...next };
      try { this.launch.set(hint); } catch { /* the in-memory value already blocks */ }
      try { this.persist?.(next, { lowering: false }); } catch { /* locked: the record keeps an older, self-expiring window */ }
    }
  }

  /** Allow internet access for `minutes` (the caller has checked the password). */
  allow(minutes = 15) {
    const m = Math.max(1, Math.min(MAX_ALLOW_MINUTES, Math.floor(Number(minutes) || 15)));
    const now = Date.now();
    this._apply({ enabled: this.setting.enabled, allowedUntil: new Date(now + m * 60000).toISOString(), allowFrom: new Date(now).toISOString() }, { lowering: true });
    this._windowEndedAt = null;
    this._arm();
    this._changed('allow');
    return this.status();
  }

  block() {
    this._apply({ enabled: this.setting.enabled, allowedUntil: null, allowFrom: null }, { lowering: false });
    this.downloads.clear();
    this._windowEndedAt = null;
    this._arm();
    this._changed('block');
    return this.status();
  }

  setEnabled(enabled) {
    this.override = undefined;
    const cur = this.setting;
    this._apply(enabled ? { ...cur, enabled: true } : { enabled: false, allowedUntil: null, allowFrom: null }, { lowering: !enabled });
    this._arm();
    this._changed(enabled ? 'enable' : 'disable');
    return this.status();
  }

  /** A model download that the allow window covers; blocking waits for it (bounded). */
  beginDownload() {
    const token = Symbol('download');
    this.downloads.add(token);
    return () => { if (this.downloads.delete(token) && !this.allowedUntil) this._changed('download_done'); };
  }

  _arm() {
    clearTimeout(this.timer);
    const until = this.allowedUntil;
    if (!until) return;
    this.timer = setTimeout(() => {
      // the window ended: clear it; a running download keeps it open until it finishes (status says so)
      this._windowEndedAt = Date.now();
      this._apply({ ...this.setting, allowedUntil: null, allowFrom: null }, { lowering: false });
      this._changed('window_ended');
    }, Math.max(0, Date.parse(until) - Date.now()) + 5);
    this.timer.unref?.();
  }

  _changed(reason) {
    if (this.blocked) closeBlockedConnections();
    this.emit('change', { reason, status: this.status() });
  }
}
