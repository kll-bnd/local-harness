'use strict';
// Detect a Harness server that is already running on this machine with the same data directory
// (e.g. started with `npm start` or Harness.command), so a second process never writes the same
// files concurrently. Uses only GET /api/health and GET /api/system on 127.0.0.1.
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

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {number[]} o.ports   ports to probe (the server uses its preferred port + the next 10)
 * @param {number} [o.timeoutMs=1500]
 * @returns {Promise<{ url: string, port: number, version: string, pid: number|null } | null>}
 */
async function findRunningHarness({ dataDir, ports, timeoutMs = 1500 }) {
  const want = real(dataDir);
  // 1) The server's data-dir lock names its URL — this also finds an instance that fell back to a random port.
  const locked = await fromLockFile(dataDir, want, timeoutMs);
  if (locked) return locked;
  // 2) Otherwise probe the usual ports.
  const healthy = await Promise.all(ports.map(async (port) => {
    const h = await getJson(port, '/api/health', timeoutMs);
    return h && h.ok && h.name === 'harness' ? port : null;
  }));
  for (const port of healthy) {
    if (port === null) continue;
    const sys = await getJson(port, '/api/system', Math.max(timeoutMs, 8000));
    const dir = sys?.app?.dataDir;
    if (dir && real(dir) === want) {
      return { url: `http://127.0.0.1:${port}`, port, version: sys.app.version, pid: sys.app.pid ?? null };
    }
  }
  return null;
}

/** Read `<dataDir>/harness.lock` (written by server/lib/instance-lock.mjs) and verify the instance it names. */
async function fromLockFile(dataDir, want, timeoutMs) {
  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(dataDir, 'harness.lock'), 'utf8')); } catch { return null; }
  const port = Number(info?.port);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  const h = await getJson(port, '/api/health', timeoutMs);
  if (!(h && h.ok && h.name === 'harness')) return null;
  const sys = await getJson(port, '/api/system', Math.max(timeoutMs, 8000));
  const dir = sys?.app?.dataDir;
  if (!dir || real(dir) !== want) return null;
  return { url: `http://127.0.0.1:${port}`, port, version: sys.app.version, pid: sys.app.pid ?? null };
}

const portRange = (preferred) => Array.from({ length: 11 }, (_, i) => preferred + i).filter((p) => p > 0 && p < 65536);

module.exports = { findRunningHarness, portRange };
