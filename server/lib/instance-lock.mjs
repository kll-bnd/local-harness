// Exclusive data-directory lock: one Harness server per data dir (two processes would silently lose each
// other's writes). The lock file `<dataDir>/harness.lock` holds {pid, url, port, startedAt, hostname, dataDir}.
//
// A lock is stale (and taken over) when its process is gone, or when its process exists but its URL no longer
// answers GET /api/health as Harness (PID reuse after a crash), or when it was left half-written long ago.
// A second instance gets an AlreadyRunningError carrying the running instance's URL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

export const LOCK_FILE = 'harness.lock';

export class AlreadyRunningError extends Error {
  constructor(info, dataDir) {
    super(info?.url ? `Harness is already running for this data folder at ${info.url}` : `Harness is already starting for this data folder (pid ${info?.pid})`);
    this.code = 'HARNESS_ALREADY_RUNNING';
    this.url = info?.url || null;
    this.pid = info?.pid ?? null;
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

function healthOk(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('/api/health', url); } catch { resolve(false); return; }
    const req = http.get(u, { timeout: timeoutMs, headers: { host: `127.0.0.1:${u.port}` } }, (res) => {
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
  if (info.hostname && info.hostname !== os.hostname()) return true; // shared folder used by another machine: never steal
  if (info.pid === process.pid) return false; // our own leftover (not in `held`): stale
  if (!pidAlive(info.pid)) return false;
  if (!info.url) return ageMs < 60_000; // still starting up
  return healthOk(info.url);
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
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, JSON.stringify(info)); } finally { fs.closeSync(fd); }
      const rec = { file, info };
      held.set(key, rec);
      return {
        file,
        update(patch) {
          Object.assign(rec.info, patch);
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(rec.info));
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
