'use strict';
// Start the in-process backend — or refuse, when another process already holds this data folder.
// Plain logic with injected dependencies (unit-tested in electron/test/backend.test.mjs).
//
// The Electron window is a trusted-looking place where the owner types the Harness password, so it only ever shows
// the backend THIS app started. Another holder — a listener-mode Harness named by <dataDir>/harness.lock, the native
// app's backend, or whatever makes startServer() answer HARNESS_ALREADY_RUNNING — is never loaded and never sent a
// credential: nothing proves it is the genuine Harness (any program running as the user can write the lock and
// answer /api/health). The app explains and quits instead (alreadyOpenMessage).

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {number} o.port
 * @param {(o: {dataDir: string, timeoutMs?: number}) => Promise<{url: string, pid: number|null}|null>} o.findRunning
 *   listener-mode holder via the lock file + GET /api/health (unauthenticated discovery; nothing else is sent)
 * @param {(o: {dataDir: string}) => ({pid: number}|null)} o.findApp  the native app's backend (bridge, no address)
 * @param {(o: object) => Promise<{url: string}>} o.startServer
 * @param {boolean} [o.probeFirst=true]  look for a holder before starting (tests turn it off to force the race)
 * @returns {Promise<{ server: object, other: null } | { server: null, other: { kind: 'listener'|'app', pid: number|null, url: string|null } }>}
 */
async function startOrRefuse({ dataDir, port, findRunning, findApp, startServer, probeFirst = true }) {
  if (probeFirst) {
    const app = findApp({ dataDir });
    if (app) return { server: null, other: { kind: 'app', pid: app.pid ?? null, url: null } };
    const existing = await findRunning({ dataDir, timeoutMs: 800 });
    if (existing) return { server: null, other: { kind: 'listener', pid: existing.pid ?? null, url: existing.url || null } };
  }
  try {
    const server = await startServer({ port, dataDir, openBrowser: false });
    return { server, other: null };
  } catch (err) {
    // The backend's own data-dir lock: another process holds the folder (it may have started after the probe).
    if (err?.code !== 'HARNESS_ALREADY_RUNNING') throw err;
    return { server: null, other: { kind: err.transport === 'bridge' ? 'app' : 'listener', pid: err.pid ?? null, url: typeof err.url === 'string' ? err.url : null } };
  }
}

/** The dialog's text for another holder of the data folder. */
function alreadyOpenMessage(other) {
  const pid = other?.pid ? `process ${other.pid}` : 'another process';
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
