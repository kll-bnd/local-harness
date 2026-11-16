// "Block all internet access": one switch (launch.json `offlineLock`, on by default) and an explicit, time-boxed
// allow window (`offlineLockSuspendedUntil`). The in-code blocker (egress.mjs) is the feature; the OS sandbox around
// an Ollama that Harness starts itself is a silent bonus reported as osEnforced/osScope.
import { EventEmitter } from 'node:events';
import { registerGuard, unregisterGuard } from './egress.mjs';

export const MAX_ALLOW_MINUTES = 120;
const DOWNLOAD_GRACE_MS = 60 * 60 * 1000; // a download started inside the window may run on for up to an hour

export class NetworkGuard extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./launch.mjs').LaunchConfig} o.launch
   * @param {boolean} [o.sandboxed]       the launcher started this process inside the offline-lock sandbox
   * @param {boolean} [o.enabledOverride] force the setting (tests / development opt-out)
   */
  constructor({ launch, sandboxed = process.env.HARNESS_SANDBOXED === '1', enabledOverride } = {}) {
    super();
    this.launch = launch;
    this.sandboxed = sandboxed;
    this.override = enabledOverride;
    this.downloads = new Set();
    this.timer = null;
    this.ollama = { managed: false, sandboxed: false, external: false };
    registerGuard(this);
    this._arm();
  }

  dispose() { unregisterGuard(this); clearTimeout(this.timer); }

  get enabled() { return this.override !== undefined ? this.override : this.launch.get().offlineLock !== false; }

  get allowedUntil() {
    const u = this.launch.get().offlineLockSuspendedUntil;
    return u && Date.parse(u) > Date.now() ? u : null;
  }

  /** Waiting for a download that started inside an allow window that has ended. */
  get waitingFor() { return !this.allowedUntil && this.downloads.size && this._windowEndedAt && Date.now() - this._windowEndedAt < DOWNLOAD_GRACE_MS ? 'model_download' : null; }

  get blocked() { return this.enabled && !this.allowedUntil && !this.waitingFor; }

  status() {
    const blocked = this.blocked;
    const o = this.ollamaInfo ? this.ollamaInfo() : this.ollama;
    const osScope = !blocked || this.osBroken ? 'none' : this.sandboxed ? 'backend' : o.managed && o.sandboxed ? 'ollama' : 'none';
    return { enabled: this.enabled, blocked, allowedUntil: this.allowedUntil, waitingFor: this.waitingFor, osEnforced: osScope !== 'none', osScope, externalOllama: !!o.external };
  }

  /** Allow internet access for `minutes` (the caller has checked the password). */
  allow(minutes = 15) {
    const m = Math.max(1, Math.min(MAX_ALLOW_MINUTES, Math.floor(Number(minutes) || 15)));
    this.launch.set({ offlineLockSuspendedUntil: new Date(Date.now() + m * 60000).toISOString() });
    this._windowEndedAt = null;
    this._arm();
    this._changed('allow');
    return this.status();
  }

  block() {
    this.launch.set({ offlineLockSuspendedUntil: null });
    this.downloads.clear();
    this._windowEndedAt = null;
    this._arm();
    this._changed('block');
    return this.status();
  }

  setEnabled(enabled) {
    this.override = undefined;
    this.launch.set({ offlineLock: !!enabled, ...(enabled ? {} : { offlineLockSuspendedUntil: null }) });
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
      this.launch.set({ offlineLockSuspendedUntil: null });
      this._changed('window_ended');
    }, Math.max(0, Date.parse(until) - Date.now()) + 5);
    this.timer.unref?.();
  }

  _changed(reason) { this.emit('change', { reason, status: this.status() }); }
}
