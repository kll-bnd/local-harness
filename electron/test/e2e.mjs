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
import http from 'node:http';
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

// ------------------------------------- B. another process holds the data folder: dialog, nothing loaded, no credential
// The window only ever shows the backend this app started. Whatever the lock names — here a stand-in that answers
// /api/health like Harness and records every request — gets no more than that unauthenticated discovery.
const standIn = async () => {
  const got = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, raw, headers: { ...req.headers } });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, name: 'harness', version: '0.2.0', state: 'unlocked' }));
      res.statusCode = 404;
      return res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { got, port: srv.address().port, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
};
const writeLock = (dataDir, info) => fs.writeFileSync(path.join(dataDir, 'harness.lock'), JSON.stringify({ startedAt: new Date().toISOString(), hostname: os.hostname(), dataDir: fs.realpathSync.native(dataDir), ...info }));
const refused = (S, r, dataDir, text) => {
  const out = r.stdout + r.stderr;
  report(S, 'the dialog text names the other holder', out.includes(text), out.split('\n').filter((l) => /already open/.test(l)).join(' | ') || out.slice(-400));
  report(S, 'no window was loaded (the e2e driver never ran) and no backend was started here', !r.result && !/listening on http/.test(out), { result: !!r.result });
  report(S, 'clean quit (exit code 0)', r.code === 0, { code: r.code, signal: r.signal });
};

{
  const S = 'other-listener';
  const dataDir = mkData('other-listener');
  const fake = await standIn();
  writeLock(dataDir, { pid: process.pid, port: fake.port, url: `http://127.0.0.1:${fake.port}` });
  fs.writeFileSync(path.join(dataDir, 'api-token'), 'a'.repeat(43) + '\n', { mode: 0o600 }); // must never be sent
  const r = await launch({ dataDir, port: await freePort() });
  refused(S, r, dataDir, `Another Harness is using your data folder (process ${process.pid}, at http://127.0.0.1:${fake.port}). Use that one — or quit it and open this app again.`);
  const other = fake.got.filter((g) => !(g.method === 'GET' && g.url === '/api/health'));
  const creds = fake.got.filter((g) => g.headers.authorization || g.headers.cookie || g.raw || /launch|auth|unlock/.test(g.url));
  report(S, 'the stand-in received only GET /api/health: no credential, no launch code, no api-token', other.length === 0 && creds.length === 0, fake.got.map((g) => `${g.method} ${g.url}`));
  await fake.close();
}

// ---------------------------------------------- B2. the probe is skipped: the backend's own HARNESS_ALREADY_RUNNING decides
{
  const S = 'other-listener-race';
  const dataDir = mkData('other-race');
  const port = await freePort();
  const cli = spawn(process.execPath, [path.join(root, 'server', 'index.mjs'), '--port', String(port), '--data-dir', dataDir], {
    env: { ...process.env, HARNESS_NO_OLLAMA_AUTOSTART: '1', HARNESS_LOG_LEVEL: 'warn' }, stdio: 'ignore',
  });
  for (let i = 0; i < 100 && !(await health(port)); i++) await sleep(100);
  const r = await launch({ dataDir, port: await freePort(), env: { HARNESS_E2E_SKIP_PROBE: '1' } });
  refused(S, r, dataDir, `Another Harness is using your data folder (process ${cli.pid}, at http://127.0.0.1:${port}). Use that one — or quit it and open this app again.`);
  report(S, 'the other Harness keeps running', await health(port));
  cli.kill('SIGTERM');
  await new Promise((res) => cli.once('exit', res));
}

// ------------------------------------------------------- B3. the native app's backend holds the folder (no address)
{
  const S = 'other-native-app';
  const dataDir = mkData('other-app');
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  writeLock(dataDir, { pid: holder.pid, transport: 'bridge' });
  const r = await launch({ dataDir, port: await freePort() });
  refused(S, r, dataDir, `Harness is open in the Harness app (process ${holder.pid}), which is using your data folder. Use that one — or quit it (⌘Q) and open this app again.`);
  holder.kill('SIGTERM');
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

// ------------------------------------------------- D. damaged key store (0.2): Harness starts in state "error"
{
  const S = 'vault-error';
  const dataDir = mkData('vault-error');
  // Encrypted data exists (a chats folder) but both copies of the key store are unusable.
  fs.mkdirSync(path.join(dataDir, 'chats'));
  fs.writeFileSync(path.join(dataDir, 'chats', 'chat_x.json'), Buffer.from('HXC1 not really'));
  fs.writeFileSync(path.join(dataDir, 'vault.json'), JSON.stringify({ version: 99 }));
  fs.writeFileSync(path.join(dataDir, 'vault.json.bak'), JSON.stringify({ version: 99 }));
  const port = await freePort();
  const r = await launch({ dataDir, port, timeoutMs: 60000 });
  const sec = r.result?.info?.security;
  report(S, 'the app starts and shows the window (the UI explains the damaged key store)', r.result?.checks?.window_loads_server_url?.ok, r.result?.checks?.window_loads_server_url);
  report(S, 'state "error" (vault_corrupt), never needs_setup', sec?.state === 'error', sec);
  report(S, 'exit code 0 and no server left listening', r.code === 0 && !(await portOpen(port)), { code: r.code, signal: r.signal });
  const log = fs.existsSync(path.join(dataDir, 'logs', 'harness.log')) ? fs.readFileSync(path.join(dataDir, 'logs', 'harness.log'), 'utf8') : '';
  report(S, 'the log names the problem', /vault_corrupt/.test(log), log.slice(-300));
  report(S, 'the damaged key store was left untouched', fs.readFileSync(path.join(dataDir, 'vault.json'), 'utf8') === JSON.stringify({ version: 99 }));
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nall desktop E2E checks passed');
process.exit(failures.length ? 1 : 0);
