// Exclusive data-directory lock: one Harness server per data dir (two processes would silently lose each
// other's writes). The lock file `<dataDir>/harness.lock` holds {pid, url, port, startedAt, hostname, dataDir}.
//
// A lock is stale (and taken over) when its process is gone, or when its process exists but its URL no longer
// answers GET /api/health as Harness (PID reuse after a crash), or when it was left half-written long ago.
// A second instance gets an AlreadyRunningError. The lock file is plain, so whatever it says is a claim: nothing in
// it is ever connected to as written — only a validated port, on 127.0.0.1 (the only address Harness listens on).
// A lock that names another computer gets its own error with no address at all.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

export const LOCK_FILE = 'harness.lock';

const isPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The port a lock claims, validated: its `port`, or the port of its `url` when that names this computer's loopback.
 * null otherwise. Callers build `http://127.0.0.1:<port>` from it — never the lock's URL itself.
 */
export function lockPort(info) {
  if (isPort(info?.port)) return info.port;
  try {
    const u = new URL(String(info?.url));
    const p = Number(u.port);
    return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname) && isPort(p) ? p : null;
  } catch { return null; }
}

/** The lock names another computer (a data folder on a shared or synced disk). */
const otherHost = (info) => !!(info?.hostname && info.hostname !== os.hostname());

export class AlreadyRunningError extends Error {
  constructor(info, dataDir) {
    const elsewhere = otherHost(info);
    const port = elsewhere ? null : lockPort(info);
    const url = port ? `http://127.0.0.1:${port}` : null;
    super(elsewhere ? 'This data folder is in use by Harness on another computer; quit Harness there first.'
      : url ? `Harness is already running for this data folder at ${url}`
        : info?.transport === 'bridge' ? `Harness is already open in the Harness app for this data folder (pid ${info?.pid})`
          : `Harness is already starting for this data folder (pid ${info?.pid})`);
    this.code = 'HARNESS_ALREADY_RUNNING';
    this.otherComputer = elsewhere; // true: no address of any kind is given
    this.transport = elsewhere ? null : info?.transport || null; // 'bridge': the native app's backend, which has no URL
    this.port = port; // validated; the instance (if it is one) listens on 127.0.0.1:<port>
    this.url = url; // built from the validated port — never the lock file's own text
    this.pid = elsewhere ? null : info?.pid ?? null;
    this.dataDir = dataDir;
  }
}

const held = new Map(); // real data dir → lock record (same-process instances)

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function healthOk(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
      res.on('end', () => { try { const j = JSON.parse(body); resolve(!!(j.ok && j.name === 'harness')); } catch { resolve(false); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function isLive(info, file) {
  let ageMs = Infinity;
  try { ageMs = Date.now() - fs.statSync(file).mtimeMs; } catch { /* gone */ }
  if (!info) return ageMs < 10_000; // being written right now
  if (otherHost(info)) return true; // shared folder used by another machine: never steal
  if (info.pid === process.pid) return false; // our own leftover (not in `held`): stale
  if (!pidAlive(info.pid)) return false;
  if (info.transport === 'bridge') return true; // a native app's backend: no URL to probe, alive while its pid is
  const port = lockPort(info);
  if (!port) return ageMs < 60_000; // still starting up (or no usable address)
  return healthOk(port);
}

/**
 * Acquire the lock or throw AlreadyRunningError. Returns `{ file, update({url, port}), release() }`.
 */
export async function acquireDataDirLock(dataDir) {
  const key = real(dataDir);
  if (held.has(key)) throw new AlreadyRunningError(held.get(key).info, dataDir);
  const file = path.join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    const info = { pid: process.pid, url: null, port: null, startedAt: new Date().toISOString(), hostname: os.hostname(), dataDir: key };
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeSync(fd, JSON.stringify(info)); } finally { fs.closeSync(fd); }
      const rec = { file, info };
      held.set(key, rec);
      return {
        file,
        update(patch) {
          Object.assign(rec.info, patch);
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(rec.info), { mode: 0o600 });
          fs.renameSync(tmp, file);
        },
        release() {
          if (held.get(key) !== rec) return;
          held.delete(key);
          const cur = readLock(file);
          if (!cur || cur.pid === process.pid) fs.rmSync(file, { force: true });
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const other = readLock(file);
      if (await isLive(other, file)) throw new AlreadyRunningError(other || { pid: null }, dataDir);
      fs.rmSync(file, { force: true });
    }
  }
  throw new AlreadyRunningError(readLock(file) || { pid: null }, dataDir);
}

/** Read the lock without taking it (used to find a running instance's URL). */
export function readDataDirLock(dataDir) {
  return readLock(path.join(dataDir, LOCK_FILE));
}

// Remove our lock files even on abrupt exits (process.exit, uncaught errors).
process.once('exit', () => {
  for (const { file } of held.values()) {
    try { const cur = readLock(file); if (!cur || cur.pid === process.pid) fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
});
