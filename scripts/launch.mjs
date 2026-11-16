#!/usr/bin/env node
// Browser launcher used by Harness.command (no Electron needed):
//   - if Harness is already running for this data folder (desktop app, another Terminal), just open it;
//   - otherwise start the server, open the default browser, and stop cleanly on Ctrl+C, on SIGTERM,
//     or when the Terminal window is closed (SIGHUP) so no data is lost.
//
//   node scripts/launch.mjs [--port 4747] [--no-open]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveDataDir } = require('../electron/lib/paths.cjs');
const { findRunningHarness, portRange } = require('../electron/lib/instance.cjs');

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const port = Number(opt('--port') || process.env.HARNESS_PORT || 4747);
const open = !argv.includes('--no-open');
const dataDir = resolveDataDir();

function openBrowser(url) {
  if (!open) return;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => console.log(`Open ${url} in your browser.`));
    child.unref();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}

const existing = await findRunningHarness({ dataDir, ports: portRange(port), timeoutMs: 800 });
if (existing) {
  console.log(`Harness is already running at ${existing.url} — opening it.`);
  openBrowser(existing.url);
  process.exit(0);
}

const { startServer } = await import('../server/index.mjs');
let srv;
try {
  srv = await startServer({ port, dataDir, openBrowser: false });
} catch (e) {
  console.error(`\nHarness could not start: ${e.message}\nData folder: ${dataDir}\nRun "npm run doctor" for a full check.`);
  process.exit(1);
}

console.log(`
  Harness is running at ${srv.url}
  Data folder: ${dataDir}

  Keep this window open while you use Harness.
  To stop it: press Ctrl+C (or close this window).
`);
openBrowser(srv.url);

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
