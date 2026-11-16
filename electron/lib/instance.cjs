'use strict';
// Detect a Harness server that is already running on this machine with the same data directory
// (e.g. started with `npm start` or Harness.command), so a second process never writes the same
// files concurrently.
//
// Uses only things that need no session and contain no user data: the backend's data-dir lock file
// `<dataDir>/harness.lock` (written by server/lib/instance-lock.mjs: { pid, url, port, dataDir, … }) and
// `GET /api/health` on the port it names. The lock lives inside the data dir, so an instance it names
// serves that data dir; ports are not probed (another Harness on a nearby port may use another folder).
const http = require('node:http');
const fs = require('node:fs');
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

/** The lock file's contents, or null. */
function readLock(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'harness.lock'), 'utf8')); } catch { return null; }
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
  const port = Number(info?.port);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  if (info.dataDir && real(info.dataDir) !== real(dataDir)) return null;
  const h = await getJson(port, '/api/health', timeoutMs);
  if (!(h && h.ok && h.name === 'harness')) return null;
  return { url: `http://127.0.0.1:${port}`, port, version: h.version, pid: Number.isInteger(info.pid) ? info.pid : null, state: h.state ?? null };
}

const portRange = (preferred) => Array.from({ length: 11 }, (_, i) => preferred + i).filter((p) => p > 0 && p < 65536);

module.exports = { findRunningHarness, portRange, readLock };
