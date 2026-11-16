#!/usr/bin/env node
// Browser launcher used by Harness.command (no Electron needed):
//   - if Harness is already running for this data folder (desktop app, another Terminal), just open it;
//   - otherwise start the server, open the default browser, and stop cleanly on Ctrl+C, on SIGTERM,
//     or when the Terminal window is closed (SIGHUP) so no data is lost.
//
// 0.2: the launcher never handles the password. In password mode (the default) the browser shows Harness's
// own setup or lock screen; the password is typed there. In keychain/off mode it opens a one-time launch URL
// (`#launch=<code>`, docs/API.md §10.5) so the browser gets a session without a prompt.
//
//   node scripts/launch.mjs [--port 4747] [--no-open]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveDataDir } = require('../electron/lib/paths.cjs');
const { findRunningHarness } = require('../electron/lib/instance.cjs');

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const port = Number(opt('--port') || process.env.HARNESS_PORT || 4747);
const open = !argv.includes('--no-open');
const dataDir = resolveDataDir();

// `shown` is what may be printed: a launch URL carries a one-time code that should not end up in scrollback.
function openBrowser(url, shown = url.split('#')[0]) {
  if (!open) return;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => console.log(`Open ${shown} in your browser.`));
    child.unref();
  } catch {
    console.log(`Open ${shown} in your browser.`);
  }
}

/** keychain/off mode: a one-time launch URL from the per-install api-token; otherwise the plain URL. */
async function launchUrlFor(url) {
  let token = null;
  try { token = fs.readFileSync(path.join(dataDir, 'api-token'), 'utf8').trim(); } catch { return url; }
  try {
    const res = await fetch(`${url}/api/auth/launch-code`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
    const j = await res.json().catch(() => null);
    return res.ok && j?.url ? j.url : url;
  } catch { return url; }
}

function stateHint(state) {
  if (state === 'needs_setup') return 'First start: choose your Harness password in the browser window (and save the recovery key it shows once).';
  if (state === 'locked') return 'Harness is locked: type your Harness password in the browser window.';
  if (state === 'migrating') return 'Harness is encrypting or decrypting your data; the browser window shows the progress.';
  return '';
}

const existing = await findRunningHarness({ dataDir, timeoutMs: 1500 });
if (existing) {
  console.log(`Harness is already running at ${existing.url} — opening it.${existing.state ? `\n${stateHint(existing.state)}` : ''}`);
  openBrowser(await launchUrlFor(existing.url));
  process.exit(0);
}

const { startServer } = await import('../server/index.mjs');
let srv;
try {
  srv = await startServer({ port, dataDir, openBrowser: false });
} catch (e) {
  if (e?.code === 'HARNESS_ALREADY_RUNNING') {
    // Another process holds this data folder's lock (it started between our check and now): use it.
    console.log(e.url ? `Harness is already running at ${e.url} — opening it.`
      : e.transport === 'bridge' ? 'Harness is already open in the Harness app (it has no browser address): switch to the app, or quit it (⌘Q) to use Harness in the browser.'
        : 'Harness is already starting for this data folder.');
    if (e.url) openBrowser(await launchUrlFor(e.url));
    process.exit(0);
  }
  console.error(`\nHarness could not start: ${e.message}\nData folder: ${dataDir}\nRun "npm run doctor" for a full check.`);
  process.exit(1);
}

let state = null;
try { state = (await (await fetch(`${srv.url}/api/health`)).json()).state ?? null; } catch { /* 0.1 backend */ }
let url = srv.url;
try { if (srv.auth?.launchUrl) url = srv.auth.launchUrl(); } catch { /* locked in password mode: the browser shows the lock screen */ }
console.log(`
  Harness is running at ${srv.url}
  Data folder: ${dataDir}
${stateHint(state) ? `\n  ${stateHint(state)}\n` : ''}
  Keep this window open while you use Harness.
  To stop it: press Ctrl+C (or close this window).
`);
openBrowser(url);

let stopping = false;
const stop = async (sig) => {
  if (stopping) return;
  stopping = true;
  if (sig !== 'SIGHUP') console.log('\nStopping Harness…');
  const t = setTimeout(() => process.exit(0), 10000);
  t.unref();
  await srv.close().catch(() => {});
  process.exit(0);
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stop(sig));
