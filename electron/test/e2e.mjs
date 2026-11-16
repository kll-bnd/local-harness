#!/usr/bin/env node
// End-to-end smoke test of the desktop shell: launches the real Electron app (under Xvfb on a
// headless Linux box) against a throw-away data dir and checks the window, preload contract, menu
// → page actions, navigation/permission/network lock-down, IPC validation, the App Nap guard and
// a clean shutdown. Needs `npm install` (Electron). Not part of `npm test`.
//
//   npm run test:e2e
//   HARNESS_E2E_DIR=/some/tmp npm run test:e2e      # where to create the throw-away data dirs
//   HARNESS_E2E_APP=dist/linux-unpacked/harness npm run test:e2e   # test a packaged build instead of `electron .`
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeOllama } from '../../test/fake-ollama.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const driver = path.join(root, 'electron', 'test', 'e2e-driver.cjs');
const base = process.env.HARNESS_E2E_DIR || os.tmpdir();
fs.mkdirSync(base, { recursive: true });

let electronPath;
try { electronPath = (await import('electron')).default; } catch {
  console.error('Electron is not installed — run `npm install` first.');
  process.exit(2);
}
if (!fs.existsSync(electronPath)) {
  console.error(`Electron binary missing at ${electronPath} (its download may have failed during npm install).`);
  process.exit(2);
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const portOpen = (port) => new Promise((resolve) => {
  const c = net.connect({ host: '127.0.0.1', port }, () => { c.destroy(); resolve(true); });
  c.on('error', () => resolve(false));
});
const health = async (port) => { try { return (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).ok === true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch({ dataDir, port, env = {}, timeoutMs = 90000 }) {
  const needsXvfb = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  // HARNESS_E2E_APP=/path/to/packaged/binary tests a packaged build (e.g. dist/linux-unpacked/harness).
  const packaged = process.env.HARNESS_E2E_APP;
  const appArgs = packaged ? [] : ['.'];
  if (process.platform === 'linux' && process.getuid?.() === 0) appArgs.unshift('--no-sandbox'); // Chromium refuses to run as root otherwise
  const bin = packaged || electronPath;
  const [cmd, args] = needsXvfb ? ['xvfb-run', ['-a', bin, ...appArgs]] : [bin, appArgs];
  const child = spawn(cmd, args, {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      ELECTRON_ENABLE_LOGGING: '',
      HARNESS_DATA_DIR: dataDir,
      HARNESS_PORT: String(port),
      HARNESS_E2E_SCRIPT: driver,
      HARNESS_NO_OLLAMA_AUTOSTART: '1',
      HARNESS_LOG_LEVEL: 'info',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  return new Promise((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(t);
      const line = stdout.split('\n').find((l) => l.startsWith('E2E_RESULT '));
      let result = null;
      try { result = line ? JSON.parse(line.slice(11)) : null; } catch { /* ignore */ }
      resolve({ code, signal, stdout, stderr, result });
    });
  });
}

const failures = [];
const report = (scenario, name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${scenario}: ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  if (!ok) failures.push(`${scenario}: ${name}`);
};
const mkData = (name) => fs.mkdtempSync(path.join(base, `e2e-${name}-`));

// ------------------------------------------------------------------------- A. normal run (in-process server)
{
  const dataDir = mkData('app');
  const port = await freePort();
  const ollama = await startFakeOllama({ port: 0, delayMs: 15 });
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    providers: { autodetect: false, builtin: { ollama: { enabled: true, baseUrl: ollama.url } } },
    ollama: { autoStart: false, stopOnExit: false },
    image: { autodetect: false },
  }));
  const r = await launch({ dataDir, port, env: { HARNESS_E2E_FAKE_OLLAMA: '1' } });
  await ollama.close();
  const S = 'app';
  report(S, 'driver produced a result', !!r.result && !r.result.error, r.result?.error || r.stderr.split('\n').filter((l) => !/dbus|NODE_OPTION/.test(l)).slice(-15).join('\n'));
  for (const [name, c] of Object.entries(r.result?.checks || {})) report(S, name, c.ok, c.detail);
  report(S, 'exit code 0 after app.quit()', r.code === 0, { code: r.code, signal: r.signal });
  report(S, 'server closed on quit', !(await portOpen(port)));
  const log = fs.existsSync(path.join(dataDir, 'logs', 'harness.log')) ? fs.readFileSync(path.join(dataDir, 'logs', 'harness.log'), 'utf8') : '';
  report(S, 'log file records listening + clean shutdown', log.includes(`listening on http://127.0.0.1:${port}`) && log.includes('[desktop] stopping the local server') && log.includes('[desktop] bye'));
  report(S, 'window state persisted', fs.existsSync(path.join(dataDir, 'Electron', 'window-state.json')));
  report(S, 'desktop.json created with defaults', fs.existsSync(path.join(dataDir, 'desktop.json')));
  report(S, 'Chromium storage kept under <data>/Electron', fs.existsSync(path.join(dataDir, 'Electron', 'Local Storage')) || fs.existsSync(path.join(dataDir, 'Electron', 'Preferences')));
  console.log(`info  ${S}: ${JSON.stringify(r.result?.info || {})}`);
}

// ------------------------------------------------------------- B. a CLI server already owns the data dir
{
  const S = 'attach';
  const dataDir = mkData('attach');
  const port = await freePort();
  const cli = spawn(process.execPath, [path.join(root, 'server', 'index.mjs'), '--port', String(port), '--data-dir', dataDir], {
    env: { ...process.env, HARNESS_NO_OLLAMA_AUTOSTART: '1', HARNESS_LOG_LEVEL: 'warn' }, stdio: 'ignore',
  });
  for (let i = 0; i < 100 && !(await health(port)); i++) await sleep(100);
  const r = await launch({ dataDir, port });
  report(S, 'driver produced a result', !!r.result && !r.result.error, r.result?.error);
  report(S, 'reuses the running server instead of starting a second one', r.result?.info?.attachedUrl === `http://127.0.0.1:${port}` && r.result?.info?.inProcessServer === false, r.result?.info);
  for (const name of ['window_loads_server_url', 'preload_api_present', 'menu_action_reaches_page', 'external_navigation_blocked']) report(S, name, r.result?.checks?.[name]?.ok, r.result?.checks?.[name]);
  report(S, 'exit code 0', r.code === 0, { code: r.code, signal: r.signal });
  report(S, 'the CLI server keeps running after the app quits', await health(port));
  cli.kill('SIGTERM');
  await new Promise((res) => cli.once('exit', res));
}

// ------------------------------------------- B2. same, but the probe is skipped: the backend's data-dir lock decides
{
  const S = 'attach-via-lock';
  const dataDir = mkData('attach-lock');
  const port = await freePort();
  const cli = spawn(process.execPath, [path.join(root, 'server', 'index.mjs'), '--port', String(port), '--data-dir', dataDir], {
    env: { ...process.env, HARNESS_NO_OLLAMA_AUTOSTART: '1', HARNESS_LOG_LEVEL: 'warn' }, stdio: 'ignore',
  });
  for (let i = 0; i < 100 && !(await health(port)); i++) await sleep(100);
  const r = await launch({ dataDir, port: await freePort(), env: { HARNESS_E2E_SKIP_PROBE: '1' } });
  report(S, 'driver produced a result', !!r.result && !r.result.error, r.result?.error);
  report(S, 'HARNESS_ALREADY_RUNNING from startServer → attaches to err.url', r.result?.info?.attachedUrl === `http://127.0.0.1:${port}` && r.result?.info?.attachedVia === 'lock' && r.result?.info?.inProcessServer === false, r.result?.info);
  report(S, 'window_loads_server_url', r.result?.checks?.window_loads_server_url?.ok, r.result?.checks?.window_loads_server_url);
  report(S, 'exit code 0', r.code === 0, { code: r.code, signal: r.signal });
  report(S, 'the CLI server keeps running after the app quits', await health(port));
  cli.kill('SIGTERM');
  await new Promise((res) => cli.once('exit', res));
}

// ------------------------------------------------------------------------------ C. server cannot start
{
  const S = 'startup-error';
  const notADir = path.join(mkData('broken'), 'data-is-a-file');
  fs.writeFileSync(notADir, 'not a directory');
  const port = await freePort();
  const r = await launch({ dataDir: notADir, port, timeoutMs: 30000 });
  report(S, 'exits with code 1 instead of hanging', r.code === 1, { code: r.code, signal: r.signal });
  report(S, 'reports the server start failure', /server failed to start/.test(r.stdout + r.stderr), (r.stdout + r.stderr).slice(-600));
}

// ------------------------------------------------------------- D. the backend itself throws while starting
{
  const S = 'server-error';
  const dataDir = mkData('server-error');
  fs.mkdirSync(path.join(dataDir, 'memories.json')); // 0.1: a directory where the backend expects a file → EISDIR
  fs.writeFileSync(path.join(dataDir, 'vault.json'), JSON.stringify({ version: 99 })); // 0.2: not a key store → vault_corrupt
  const port = await freePort();
  const r = await launch({ dataDir, port, timeoutMs: 30000 });
  report(S, 'exits with code 1', r.code === 1, { code: r.code, signal: r.signal });
  const log = fs.existsSync(path.join(dataDir, 'logs', 'harness.log')) ? fs.readFileSync(path.join(dataDir, 'logs', 'harness.log'), 'utf8') : '';
  report(S, 'error is written to the log file', /server failed to start[\s\S]*(EISDIR|vault)/.test(log), log.slice(-400));
  report(S, 'no server left listening', !(await portOpen(port)));
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nall desktop E2E checks passed');
process.exit(failures.length ? 1 : 0);
