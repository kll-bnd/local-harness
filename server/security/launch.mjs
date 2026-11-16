// launch.json: the few non-sensitive decisions every launcher needs before the backend runs (docs/BRIDGE.md).
//   { "version": 1, "offlineLock": true, "offlineLockSuspendedUntil": null, "encryption": "password" }
import fs from 'node:fs';
import path from 'node:path';

export const LAUNCH_DEFAULTS = Object.freeze({ version: 1, offlineLock: true, offlineLockSuspendedUntil: null, encryption: 'password' });
const MODES = new Set(['password', 'keychain', 'off']);

export class LaunchConfig {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'launch.json');
    this.value = { ...LAUNCH_DEFAULTS };
  }

  load() {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* missing or unreadable: defaults */ }
    const v = { ...LAUNCH_DEFAULTS };
    if (raw && typeof raw === 'object') {
      if (typeof raw.offlineLock === 'boolean') v.offlineLock = raw.offlineLock;
      if (typeof raw.offlineLockSuspendedUntil === 'string' && !Number.isNaN(Date.parse(raw.offlineLockSuspendedUntil))) v.offlineLockSuspendedUntil = raw.offlineLockSuspendedUntil;
      if (MODES.has(raw.encryption)) v.encryption = raw.encryption;
    }
    this.value = v;
    return this;
  }

  get() { return { ...this.value }; }

  /** Merge and write atomically (0600). */
  set(patch) {
    this.value = { ...this.value, ...patch, version: 1 };
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return this.get();
  }
}
