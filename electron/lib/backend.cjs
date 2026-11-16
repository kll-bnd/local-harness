'use strict';
// Start the in-process backend, or attach to a Harness that already serves the same data dir.
// Plain logic with injected dependencies (unit-tested in electron/test/backend.test.mjs).

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {number} o.port
 * @param {(o: {dataDir: string, ports: number[], timeoutMs: number}) => Promise<{url: string, pid: number|null}|null>} o.findRunning
 * @param {(o: object) => Promise<{url: string}>} o.startServer
 * @param {number[]} o.ports           ports findRunning probes
 * @param {boolean} [o.probeFirst=true] look for a running instance before starting (tests turn it off to force the race)
 * @param {number} [o.waitMs=10000]    how long to wait for a racing instance that has not published its URL yet
 * @returns {Promise<{ url: string, server: object|null, attached: boolean, pid: number|null, via: 'probe'|'lock'|null }>}
 */
async function startOrAttach({ dataDir, port, ports, findRunning, startServer, probeFirst = true, waitMs = 10000, sleep = delay }) {
  if (probeFirst) {
    const existing = await findRunning({ dataDir, ports, timeoutMs: 800 });
    if (existing) return { url: existing.url, server: null, attached: true, pid: existing.pid ?? null, via: 'probe' };
  }
  try {
    const server = await startServer({ port, dataDir, openBrowser: false });
    return { url: server.url, server, attached: false, pid: null, via: null };
  } catch (err) {
    // The backend's data-dir lock: another process started between the probe and now (rare race).
    if (err?.code !== 'HARNESS_ALREADY_RUNNING') throw err;
    let url = err.url || null;
    let pid = err.pid ?? null;
    // It may still be starting (lock taken, URL not written yet): wait for it to answer.
    for (let waited = 0; !url && waited < waitMs; waited += 500) {
      await sleep(500);
      const found = await findRunning({ dataDir, ports, timeoutMs: 800 });
      if (found) { url = found.url; pid = found.pid ?? pid; }
    }
    if (!url) throw err;
    return { url, server: null, attached: true, pid, via: 'lock' };
  }
}

module.exports = { startOrAttach };
