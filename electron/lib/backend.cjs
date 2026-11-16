'use strict';
// Start the in-process backend — or refuse, when another process already holds this data folder.
// Plain logic with injected dependencies (unit-tested in electron/test/backend.test.mjs).
//
// The Electron window is a trusted-looking place where the owner types the Harness password, so it only ever shows
// the backend THIS app started. Another holder — a listener-mode Harness named by <dataDir>/harness.lock, the native
// app's backend, or whatever makes startServer() answer HARNESS_ALREADY_RUNNING — is never loaded and never sent a
// credential: nothing proves it is the genuine Harness (any program running as the user can write the lock and
// answer /api/health). The app explains and quits instead (alreadyOpenMessage). A lock written on another computer
// is not contacted at all, and no URL from the lock (or from the backend's error, which carries the lock's) is used:
// the dialog shows only http://127.0.0.1:<port> rebuilt from a valid port.
const { loopbackUrl } = require('./instance.cjs');

/** `url` only when it is exactly http://127.0.0.1:<valid port>; anything else (another host, a path, …) → null. */
function shownUrl(url) {
  const m = typeof url === 'string' ? /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/.exec(url) : null;
  return m ? loopbackUrl(m[1]) : null;
}

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {number} o.port
 * @param {(o: {dataDir: string, timeoutMs?: number}) => Promise<{url: string, pid: number|null}|null>} o.findRunning
 *   listener-mode holder via the lock file + GET /api/health (unauthenticated discovery; nothing else is sent)
 * @param {(o: {dataDir: string}) => ({pid: number}|null)} o.findApp  the native app's backend (bridge, no address)
 * @param {(o: {dataDir: string}) => ({hostname: string, pid: number|null}|null)} [o.findElsewhere]  a lock written
 *   on another computer (instance.cjs lockElsewhere)
 * @param {(o: object) => Promise<{url: string}>} o.startServer
 * @param {boolean} [o.probeFirst=true]  look for a holder before starting (tests turn it off to force the race)
 * @returns {Promise<{ server: object, other: null } | { server: null, other: { kind: 'listener'|'app'|'elsewhere', pid: number|null, url: string|null, hostname?: string } }>}
 */
async function startOrRefuse({ dataDir, port, findRunning, findApp, findElsewhere = () => null, startServer, probeFirst = true }) {
  const elsewhere = () => {
    const e = findElsewhere({ dataDir });
    return e ? { kind: 'elsewhere', pid: e.pid ?? null, url: null, hostname: e.hostname } : null;
  };
  if (probeFirst) {
    const far = elsewhere();
    if (far) return { server: null, other: far };
    const app = findApp({ dataDir });
    if (app) return { server: null, other: { kind: 'app', pid: app.pid ?? null, url: null } };
    const existing = await findRunning({ dataDir, timeoutMs: 800 });
    if (existing) return { server: null, other: { kind: 'listener', pid: existing.pid ?? null, url: shownUrl(existing.url) } };
  }
  try {
    const server = await startServer({ port, dataDir, openBrowser: false });
    return { server, other: null };
  } catch (err) {
    // The backend's own data-dir lock: another process holds the folder (it may have started after the probe).
    if (err?.code !== 'HARNESS_ALREADY_RUNNING') throw err;
    const far = elsewhere() || (err.otherComputer ? { kind: 'elsewhere', pid: null, url: null, hostname: 'name unknown' } : null);
    if (far) return { server: null, other: far };
    return { server: null, other: { kind: err.transport === 'bridge' ? 'app' : 'listener', pid: err.pid ?? null, url: shownUrl(err.url) } };
  }
}

/** The dialog's text for another holder of the data folder. */
function alreadyOpenMessage(other) {
  const pid = other?.pid ? `process ${other.pid}` : 'another process';
  if (other?.kind === 'elsewhere') {
    return {
      title: 'Harness is already open',
      message: `Harness on another computer (${other.hostname}) is using this data folder. Quit Harness there, then open this app again. (If Harness is not running there, the file harness.lock in the data folder is left over from it: delete that file.)`,
    };
  }
  if (other?.kind === 'app') {
    return {
      title: 'Harness is already open',
      message: `Harness is open in the Harness app (${pid}), which is using your data folder. Use that one — or quit it (⌘Q) and open this app again.`,
    };
  }
  return {
    title: 'Harness is already open',
    message: `Another Harness is using your data folder (${pid}${other?.url ? `, at ${other.url}` : ''}). Use that one — or quit it and open this app again.`,
  };
}

module.exports = { startOrRefuse, alreadyOpenMessage };
