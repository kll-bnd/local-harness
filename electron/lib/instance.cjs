'use strict';
// Detect a Harness server that is already running on this machine with the same data directory
// (e.g. started with `npm start` or Harness.command), so a second process never writes the same
// files concurrently.
//
// Uses only things that need no session and contain no user data: the backend's data-dir lock file
// `<dataDir>/harness.lock` (written by server/lib/instance-lock.mjs: { pid, url, port, dataDir, … }) and
// `GET /api/health` on the port it names. Ports are not probed (another Harness on a nearby port may use another
// folder). NOTE: nothing here authenticates the instance — any program running as this user can write the lock
// and answer /api/health. Use it to avoid two writers and to find where to go; never send a secret to what it
// names without proof (scripts/lib/harness-client.mjs: POST /api/security/prove before a password is sent).
//
// The lock's `url` (and the `url` of the backend's HARNESS_ALREADY_RUNNING error, which comes from it) is NEVER
// used: a discovered instance is only ever reached at http://127.0.0.1:<port>, with the lock's port checked to be
// an integer 1–65535 (loopbackUrl). A lock written on another computer (`hostname`, a data folder on a shared
// volume) is never contacted at all (lockElsewhere).
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function getJson(port, p, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

/** A lock names this data folder only when it says so: a lock without `dataDir`, or for another folder, is ignored. */
const lockIsFor = (info, dataDir) => !!info && typeof info.dataDir === 'string' && info.dataDir !== '' && real(info.dataDir) === real(dataDir);

/** The lock file's contents, or null. */
function readLock(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'harness.lock'), 'utf8')); } catch { return null; }
}

/** The only address a discovered Harness is reached at: http://127.0.0.1:<port>, or null for anything but a port 1–65535. */
function loopbackUrl(port) {
  const p = typeof port === 'number' ? port : (typeof port === 'string' && /^[0-9]{1,5}$/.test(port) ? Number(port) : NaN);
  return Number.isInteger(p) && p >= 1 && p <= 65535 ? `http://127.0.0.1:${p}` : null;
}

/** A host name from a lock, safe to print: printable characters only, at most 64. */
const printableHost = (h) => String(h).replace(/[^\x21-\x7e]/g, '?').slice(0, 64);

/**
 * The lock was written on ANOTHER computer (its `hostname` is not this one's): the data folder is on a volume that
 * computer uses too. Nothing it names is contacted; the backend will not start on the folder either.
 * @returns {{ hostname: string, pid: number|null } | null}
 */
function lockElsewhere({ dataDir } = {}) {
  const info = readLock(dataDir);
  const h = info?.hostname;
  if (typeof h !== 'string' || h === '' || h === os.hostname()) return null;
  return { hostname: printableHost(h), pid: Number.isInteger(info.pid) ? info.pid : null };
}

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {number} [o.timeoutMs=1500]
 * @returns {Promise<{ url: string, port: number, version: string, pid: number|null, state: string|null } | null>}
 *   `state` is the security state from /api/health (0.2: needs_setup | locked | migrating | unlocked), else null.
 */
async function findRunningHarness({ dataDir, timeoutMs = 1500 } = {}) {
  const info = readLock(dataDir);
  const url = loopbackUrl(info?.port);
  if (!url || !lockIsFor(info, dataDir) || lockElsewhere({ dataDir })) return null;
  const port = Number(new URL(url).port);
  const h = await getJson(port, '/api/health', timeoutMs);
  if (!(h && h.ok && h.name === 'harness')) return null;
  return { url, port, version: h.version, pid: Number.isInteger(info.pid) ? info.pid : null, state: h.state ?? null };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * A Harness that holds this data folder WITHOUT a local address: the backend of the native app (bridge mode, no
 * listening socket; its lock says `transport: "bridge"`). Command-line tools cannot talk to it — they can only
 * say so instead of reporting "not running" or failing to start a second backend.
 * @returns {{ pid: number, transport: 'bridge', startedAt: string|null } | null}
 */
function findAppHarness({ dataDir } = {}) {
  const info = readLock(dataDir);
  if (!info || info.transport !== 'bridge' || !lockIsFor(info, dataDir) || lockElsewhere({ dataDir })) return null;
  if (!pidAlive(info.pid)) return null;
  return { pid: info.pid, transport: 'bridge', startedAt: typeof info.startedAt === 'string' ? info.startedAt : null };
}

const portRange = (preferred) => Array.from({ length: 11 }, (_, i) => preferred + i).filter((p) => p > 0 && p < 65536);

module.exports = { findRunningHarness, findAppHarness, lockElsewhere, loopbackUrl, portRange, readLock };
