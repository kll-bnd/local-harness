'use strict';
// Data-directory resolution for the desktop shell.
//
// This mirrors `defaultDataDir()` in server/app.mjs (kept in sync by electron/test/paths.test.mjs),
// so the Electron app, `npm start`, Harness.command and `npm run doctor` all use ONE directory:
//   macOS   ~/Library/Application Support/Harness
//   Windows %APPDATA%\Harness
//   Linux   $XDG_DATA_HOME/harness or ~/.local/share/harness
// HARNESS_DATA_DIR overrides it everywhere.
//
// It is duplicated (instead of imported) because Electron's main process must know the directory
// synchronously, before the `ready` event, to point Chromium's own storage at it.
const os = require('node:os');
const path = require('node:path');

function resolveDataDir({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  if (env.HARNESS_DATA_DIR) return path.resolve(env.HARNESS_DATA_DIR);
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Application Support', 'Harness');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(homedir, 'AppData', 'Roaming'), 'Harness');
  return path.join(env.XDG_DATA_HOME || path.join(homedir, '.local', 'share'), 'harness');
}

/** Files the desktop shell keeps next to the backend's data. */
function desktopPaths(dataDir) {
  return {
    dataDir,
    // Chromium's own storage (localStorage, caches, …) — kept in one sub-folder so the backend's files stay tidy.
    sessionData: path.join(dataDir, 'Electron'),
    desktopConfig: path.join(dataDir, 'desktop.json'),
    windowState: path.join(dataDir, 'Electron', 'window-state.json'),
    logsDir: path.join(dataDir, 'logs'),
    logFile: path.join(dataDir, 'logs', 'harness.log'),
  };
}

module.exports = { resolveDataDir, desktopPaths };
