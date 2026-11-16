#!/usr/bin/env node
// `npm run doctor` — check this machine for everything Harness needs and say how to fix what is missing.
// Zero dependencies. Read-only: it never installs, starts Ollama or changes settings, and it never needs your
// data: by default it does not ask for your Harness password. Facts that involve no user data (models, Ollama,
// the internet blocker's self-test) come from a throw-away copy of the backend (temporary data folder, deleted
// again, Ollama auto-start off, carrying your blocker setting from launch.json). The security state, protection
// mode and blocker state of a running Harness come from its session-free GET /api/security.
//
//   npm run doctor                             human-readable report
//   npm run doctor -- --unlock                 also look inside the running Harness (asks for your password,
//                                              not shown; --password-stdin reads it from stdin): loaded models'
//                                              real memory use, Ollama protections, self-test in that process
//   npm run doctor -- --state                  print only the security state (setup script)
//   npm run doctor -- --json                   machine-readable report
//   npm run doctor -- --live                   also run the live conformance check (scripts/live-check.mjs)
//                                              against the real backends and summarise it
//   npm run doctor -- --recommended-model      print only the model tag to download for this machine
//   npm run doctor -- --recommended-text-only  print only the text-only copy to make from it ("" if none)
//   npm run doctor -- --version                print the Harness version
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.HARNESS_NO_OLLAMA_AUTOSTART = '1'; // the temporary backend below must never start Ollama
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { resolveDataDir } = require('../electron/lib/paths.cjs');
const { findRunningHarness } = require('../electron/lib/instance.cjs');
const { HarnessClient, passwordSource, readLaunchJson, describeOfflineLock } = await import('./lib/harness-client.mjs');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const args = new Set(process.argv.slice(2));
if (args.has('--version') || args.has('-v')) { console.log(`Harness ${pkg.version}`); process.exit(0); }
const asJson = args.has('--json');
const live = args.has('--live');
const onlyModel = args.has('--recommended-model');
const onlyTextOnly = args.has('--recommended-text-only');
const onlyState = args.has('--state');
const unlock = args.has('--unlock');
const pwStdin = args.has('--password-stdin');

const GB = 1024 ** 3;
const fmtGB = (b) => `${(b / GB).toFixed(1)} GB`;
const results = [];
const add = (status, title, detail = '', fix = '') => results.push({ status, title, detail, fix });
const isMac = process.platform === 'darwin';

async function getJson(url, timeoutMs = 2500, { method = 'GET', headers = {}, body } = {}) {
  try {
    const res = await fetch(url, { method, headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false, error: e.cause?.code || e.name || e.message };
  }
}

function run(cmd, argv) {
  try { return execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { return null; }
}

/**
 * A backend to ask data-free questions: a throw-away one (temporary folder, no password, Ollama auto-start off)
 * that carries this install's blocker setting, so its self-test answers for the same configuration.
 */
async function tempApi(launch) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-doctor-'));
  try {
    const { startServer } = await import('../server/index.mjs');
    const srv = await startServer({ port: 0, dataDir: tmp, openBrowser: false, autodetect: false, logLevel: 'silent', security: { mode: 'off', apiAuth: false }, offlineLock: launch.offlineLock !== false });
    return { url: srv.url, headers: {}, temp: true, close: async () => { await srv.close().catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true }); } };
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true });
    return null;
  }
}

/** The running Harness with a session (only with --unlock: asks for the password). */
async function runningApi(running) {
  const client = new HarnessClient({ base: running.url, dataDir, password: passwordSource({ fromStdin: pwStdin }) });
  try {
    await client.ensureSession({ reason: 'let doctor look inside the running Harness' });
    return { url: running.url, headers: client.authHeaders(), temp: false, close: () => client.close() };
  } catch (e) {
    await client.close().catch(() => {});
    return { error: e };
  }
}

/** The security state without a session: what the files on disk say. */
function inferStateFromDisk() {
  const launch = readLaunchJson(dataDir);
  if (launch.encryption === 'off') return 'ready';
  return fs.existsSync(path.join(dataDir, 'vault.json')) ? 'locked' : 'needs_setup';
}

/** The recommended chat model, its download, and (on ≤ 8 GB) the text-only copy to make from it. */
function pickRecommended(rec) {
  const m = rec?.models?.find((x) => x.tags?.includes('recommended')) || rec?.models?.[0];
  if (!m) return null;
  const v = m.variants?.find((x) => x.model === m.suggestedVariant) || m.variants?.[0];
  const textOnly = m.suggestTextOnly && v?.textOnly?.model ? v.textOnly : null;
  // Already set up with any suitable file of this model (e.g. the largest realistic one instead of the suggested one)?
  const have = (m.variants || []).find((x) => (m.suggestTextOnly ? x.textOnly?.installed : x.installed) && !x.notForThisMachine);
  return {
    installedAs: have ? (m.suggestTextOnly ? have.textOnly.model : have.model) : null,
    name: m.name,
    model: m.suggestedVariant || v?.model,
    largestRealistic: m.largestRealisticVariant || null,
    sizeBytes: v?.approxSizeBytes || null,
    installed: !!v?.installed,
    textOnly: textOnly ? { model: textOnly.model, installed: !!textOnly.installed, sizeBytes: textOnly.approxSizeBytes || null } : null,
    note: m.lowRamNote || v?.note || null,
    explanation: (textOnly?.estimate || v?.estimate)?.explanation || null,
  };
}

const dataDir = resolveDataDir();
const launch = readLaunchJson(dataDir);

if (onlyState) {
  // One word for scripts: needs_setup | locked | migrating | unlocked (running) or not_running:<what the disk says>.
  const running = await findRunningHarness({ dataDir, timeoutMs: 1500 }).catch(() => null);
  console.log(running ? (running.state || 'unlocked') : `not_running:${inferStateFromDisk()}`);
  process.exit(0);
}

if (onlyModel || onlyTextOnly) {
  const api = await tempApi(launch);
  const rec = api ? pickRecommended((await getJson(`${api.url}/api/models/recommended`, 15000)).data) : null;
  await api?.close();
  if (!rec?.model) { console.error('Could not determine a recommended model.'); process.exit(1); }
  if (onlyModel) {
    console.log(rec.model);
    // Human-readable context on stderr, so `model=$(… --recommended-model)` captures only the tag.
    console.error([rec.name, rec.sizeBytes ? `download ~${fmtGB(rec.sizeBytes)}` : '', rec.textOnly ? `then a text-only copy: ${rec.textOnly.model}` : ''].filter(Boolean).join(' — '));
  } else {
    console.log(rec.textOnly?.model || '');
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------- checks
const major = Number(process.versions.node.split('.')[0]);
add(major >= 20 ? 'ok' : 'fail', `Node.js ${process.versions.node}`, major >= 20 ? '' : 'Harness needs Node.js 20 or newer.', 'brew install node');

let totalMem = os.totalmem();
let lowRam = totalMem <= 8.5 * GB;
const cpu = os.cpus()[0]?.model?.trim() || 'unknown CPU';
if (isMac) {
  const ver = run('sw_vers', ['-productVersion']) || '?';
  const macMajor = Number(ver.split('.')[0]);
  const appleSilicon = process.arch === 'arm64' || run('sysctl', ['-in', 'hw.optional.arm64']) === '1';
  add(appleSilicon ? 'ok' : 'warn', `macOS ${ver} on ${cpu}`, appleSilicon ? '' : 'Not Apple Silicon: local models will be slow.');
  if (macMajor && macMajor < 12) add('fail', 'macOS too old for the desktop app', 'The Harness desktop app needs macOS 12 or newer (the browser version may still work).');
  if (process.arch === 'x64' && appleSilicon) add('warn', 'Node.js is running under Rosetta (x64)', 'Install the arm64 Node.js (Homebrew in /opt/homebrew) for best performance.', 'brew install node');
} else {
  add('info', `${process.platform} ${os.release()} (${process.arch}) on ${cpu}`, 'Harness is built for macOS; other systems work for development.');
}
add(lowRam ? 'info' : 'ok', `Memory: ${fmtGB(totalMem)}`, lowRam ? 'Low-RAM mode: use a text-only copy of a small model file (below); Harness unloads the chat model while it generates an image.' : '');

// Data directory
let writable = false;
try {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.accessSync(dataDir, fs.constants.W_OK);
  writable = true;
} catch { /* reported below */ }
add(writable ? 'ok' : 'fail', `Data folder: ${dataDir}`, writable ? '' : 'Not writable.', `Check permissions: ls -ld "${dataDir}"`);

// ----------------------------------------------------------------------------- security and the blocker
const running = writable ? await findRunningHarness({ dataDir, timeoutMs: 1500 }) : null;
const runningSec = running ? (await getJson(`${running.url}/api/security`, 5000)).data : null;
const modeNames = { password: 'password (you type it to open Harness)', keychain: 'Keychain (opens without asking — weaker)', off: 'OFF — your data is stored unencrypted' };
if (running) {
  const st = runningSec?.state || running.state || 'unknown';
  const stText = { needs_setup: 'waiting for you to choose a password', locked: 'locked (your data is closed)', migrating: `encrypting/decrypting your data${runningSec?.migration ? ` (${runningSec.migration.done}/${runningSec.migration.total})` : ''}`, unlocked: 'unlocked' }[st] || st;
  add('info', `Harness ${running.version} is running at ${running.url} — ${stText}`, `pid ${running.pid ?? '?'}${runningSec?.transport ? `, ${runningSec.transport}` : ''}`);
  if (runningSec?.unlock?.retryAfterMs > 0) add('warn', `Too many wrong passwords: the next attempt is accepted in ${Math.ceil(runningSec.unlock.retryAfterMs / 1000)} s`);
} else {
  const st = inferStateFromDisk();
  add('info', `Harness is not running${st === 'needs_setup' ? ' — no password chosen yet (Harness asks for one when you open it)' : ''}`);
}
const mode = runningSec?.mode || launch.encryption;
add(mode === 'off' ? 'warn' : mode === 'keychain' ? 'info' : 'ok', `Data protection: ${modeNames[mode] || mode}`,
  mode === 'password' ? 'Only your typed password (or the recovery key) opens the data; while Harness is locked other programs cannot read it.' : mode === 'keychain' ? 'Any program running as you can ask the Keychain for the key.' : 'Anyone who can read your files can read your chats.',
  mode === 'off' ? 'Settings → Security → protection: password' : '');
if (runningSec?.plainDataFound) add('warn', 'Unencrypted data from Harness 0.1 is waiting to be encrypted', 'Open Harness and choose a password; it encrypts the existing chats first.');
try {
  const m = fs.statSync(dataDir).mode & 0o777;
  if (m & 0o077) add('warn', `The data folder is readable by other accounts (mode ${m.toString(8)})`, 'Harness 0.2 sets it to 700 when it starts.', `chmod 700 "${dataDir}"`);
} catch { /* reported above */ }

const offline = runningSec?.offlineLock || null;
let session = null;
if (unlock && running) {
  session = await runningApi(running);
  if (session.error) { add('warn', `Could not look inside the running Harness: ${session.error.message}`); session = null; }
} else if (unlock) add('info', '--unlock: Harness is not running, so there is nothing to unlock');
const tmpApi = await tempApi(launch);
const api = session || tmpApi;
const call = (p, o = {}) => (api ? getJson(`${api.url}${p}`, o.timeoutMs || 15000, { ...o, headers: { ...(api.headers || {}), ...(o.headers || {}) } }) : Promise.resolve({ ok: false }));

// The blocker: its setting, how it is enforced, and the backend's own self-test — in one line.
const selfTest = await call('/api/network/test', { method: 'POST', body: {}, timeoutMs: 30000 });
const where = session ? 'inside the running Harness' : 'in a temporary backend with your setting';
if (!offline && !selfTest.ok) {
  add('info', `Internet blocker: ${launch.offlineLock === false ? 'off' : 'on'} (launch.json); this backend has no self-test`);
} else {
  const o = offline || selfTest.data?.offlineLock || { enabled: launch.offlineLock !== false, blocked: launch.offlineLock !== false, osEnforced: false, osScope: 'none', externalOllama: false };
  const results = selfTest.data?.results || [];
  const reachable = results.filter((r) => r.result === 'reachable');
  const verdict = !o.enabled ? 'OFF — Harness and the Ollama it starts can reach the internet'
    : !o.blocked ? `ALLOWED${o.allowedUntil ? ` until ${new Date(o.allowedUntil).toLocaleTimeString()}` : ''} (for a download) — it blocks again by itself`
      : reachable.length ? `ON, but the self-test reached ${reachable.map((r) => r.target).join(', ')} — something CAN leave this Mac`
        : `nothing Harness sends can leave this Mac${o.externalOllama ? ' — but the Ollama in use was not started by Harness and is not confined' : ''}`;
  add(!o.enabled || reachable.length || o.externalOllama ? 'warn' : 'ok', `Internet blocker: ${verdict}`,
    [`${describeOfflineLock(o)}${offline ? '' : ' (setting from launch.json; Harness is not running)'}`,
      selfTest.ok ? `self-test ${where}: ${results.map((r) => `${r.layer} ${r.target} → ${r.result}`).join('; ') || 'no probes'}` : 'self-test: not available',
      o.enabled && offline && !o.osEnforced ? 'Only Harness\'s own code blocks; no macOS sandbox is in force.' : ''].filter(Boolean).join('\n      '),
    o.externalOllama ? 'Quit the other Ollama (menu bar → Quit Ollama; brew services stop ollama) so Harness starts its own inside the sandbox.' : '');
}

const sys = (await call('/api/system')).data;
const recRaw = (await call('/api/models/recommended')).data;
if (sys?.machine?.totalMemBytes && sys.machine.totalMemBytes !== totalMem) {
  // HARNESS_TOTALMEM_BYTES (simulated RAM): follow what the backend plans with.
  totalMem = sys.machine.totalMemBytes;
  lowRam = sys.machine.ramTier === 'low';
  add('info', `Planning as if this machine had ${fmtGB(totalMem)} (HARNESS_TOTALMEM_BYTES)`);
}

// Ollama
const ollama = sys?.ollama || {};
const ollamaProvider = (sys?.providers || []).find((p) => p.id === 'ollama');
const ollamaUp = ollamaProvider?.status === 'running';
if (!ollama.installed && !ollamaUp) {
  add('fail', 'Ollama is not installed', 'Harness runs chat models through Ollama (or another local server).', isMac ? 'brew install ollama   (or download it from https://ollama.com/download)' : 'https://ollama.com/download');
} else {
  add('ok', `Ollama${ollamaProvider?.version ? ` ${ollamaProvider.version}` : ''}`, ollama.binaryPath || (ollamaUp ? `running at ${ollamaProvider.baseUrl}` : ''));
  if (!ollamaUp) add('info', 'Ollama is not running', 'Fine: Harness starts it itself, with its memory protections, when it launches.');
}

// Memory protections only apply to an Ollama that Harness started. Without a session to the running Harness
// the temporary backend cannot know who started Ollama: the running Harness's externalOllama flag answers it.
let prot = ollama.protections;
if (running && !session) {
  const unlockedNow = (runningSec?.state || running.state) === 'unlocked';
  if (!offline) prot = null;
  else if (offline.externalOllama) prot = { inEffect: false, external: true, message: 'The Ollama in use was not started by Harness, so its memory protections and the macOS sandbox do not apply.' };
  else if (!ollamaUp) prot = { inEffect: false, external: false, message: 'The running Harness starts Ollama itself when needed.' };
  // A locked Harness may not have looked at Ollama yet (seen on the 0.2 backend: externalOllama false while locked).
  else if (!unlockedNow) prot = { inEffect: false, external: false, unknown: true, message: 'Whether the running Harness started this Ollama is known only while Harness is unlocked: run `npm run doctor -- --unlock`.' };
  else prot = { inEffect: true, external: false, message: 'Ollama was started by the running Harness, with its memory protections.' };
}
const menuBarApp = isMac && run('pgrep', ['-x', 'Ollama']) !== null;
const brewService = isMac && run('launchctl', ['list', 'homebrew.mxcl.ollama']) !== null;
if (prot) {
  if (prot.unknown) add('info', 'Ollama memory protections: unknown while Harness is locked', prot.message);
  else if (prot.inEffect) add('ok', 'Ollama memory protections are in effect', prot.message || '');
  else if (prot.external || (ollamaUp && !ollama.managed)) {
    add(lowRam ? 'warn' : 'info', 'Ollama is running without Harness\'s memory protections', prot.message || 'This Ollama was not started by Harness.',
      'Quit the other Ollama (menu bar → Quit Ollama' + (brewService ? '; brew services stop ollama' : '') + '), then start Harness: it starts its own Ollama with flash attention, a q8_0 KV cache, one model at a time, no cloud features and a capped prompt cache.');
  } else add('info', 'Ollama memory protections', prot.message || '');
}
if (menuBarApp) add('warn', 'The Ollama menu-bar app is running', 'Harness then uses that Ollama as it is, without its memory protections.', 'Quit it (menu bar → Quit Ollama) and turn off its "launch at login"; Harness starts Ollama when needed.');
if (brewService) add('warn', 'Ollama runs as a Homebrew service (brew services)', 'Harness then uses that Ollama as it is, without its memory protections.', 'brew services stop ollama');

// Installed and loaded models
let tags = [];
if (ollamaUp && ollamaProvider?.baseUrl) {
  const t = await getJson(`${ollamaProvider.baseUrl.replace(/\/+$/, '')}/api/tags`);
  tags = t.ok ? (t.data?.models || []).map((m) => ({ name: m.name, size: m.size })) : [];
  add(tags.length ? 'ok' : 'warn', `Installed models: ${tags.length ? tags.map((m) => `${m.name} (${fmtGB(m.size || 0)})`).join(', ') : 'none'}`);
}
if (running && !session && ollamaUp) add('info', 'Loaded models\' real memory use: run `npm run doctor -- --unlock` to see it (needs your password)');
for (const m of session ? sys?.loadedModels || [] : []) {
  const bytes = m.residentBytes ?? null;
  const basis = m.residentBasis === 'measured' ? 'measured' : m.residentBasis ? `estimated (${m.residentBasis})` : 'unknown';
  add('info', `Loaded now: ${m.model} — ${bytes ? fmtGB(bytes) : '?'} in memory (${basis}), context ${m.contextLength ?? '?'}`);
}

// Recommended model for this machine (from the real backend)
const rec = pickRecommended(recRaw);
const has = (name) => tags.some((t) => t.name === name || t.name === `${name}:latest`);
if (!rec?.model) {
  add('warn', 'Could not compute a model recommendation');
} else if (rec.installedAs) {
  add('ok', `${rec.name} is installed as ${rec.installedAs}`, rec.textOnly ? 'A text-only copy, as recommended on this Mac.' : '');
} else if (rec.textOnly) {
  const copyThere = rec.textOnly.installed || has(rec.textOnly.model);
  const fileThere = rec.installed || has(rec.model);
  add(copyThere ? 'ok' : 'warn', `Recommended for this Mac: ${rec.textOnly.model}`,
    `a text-only copy of ${rec.model} (download ~${fmtGB(rec.sizeBytes || 0)}; the copy drops the ~1 GB image/audio part, so it cannot read images but can still ask Draw Things to make them). ${rec.note || ''}`.trim(),
    copyThere ? '' : fileThere ? 'Make the copy: npm run get-model (or Models → "Make text-only copy" in the app)' : 'npm run get-model   (downloads it and makes the text-only copy; or use the app\'s Models screen)');
} else {
  const installed = rec.installed || has(rec.model);
  add(installed ? 'ok' : 'warn', `Recommended for this machine: ${rec.model}`,
    [rec.explanation, rec.sizeBytes ? `download ~${fmtGB(rec.sizeBytes)}` : ''].filter(Boolean).join(' — '),
    installed ? '' : 'npm run get-model   (or use the app\'s Models screen)');
}

await tmpApi?.close();
await session?.close?.();

// Image generation & other local servers (all optional)
const probes = [
  ['Draw Things / A1111 image server', 'http://127.0.0.1:7860/sdapi/v1/options', 'Optional. In Draw Things: Settings → enable "API Server" (HTTP, port 7860).'],
  ['ComfyUI', 'http://127.0.0.1:8188/system_stats', 'Optional.'],
  ['llama.cpp / MLX server', 'http://127.0.0.1:8080/v1/models', 'Optional.'],
  ['LM Studio server', 'http://127.0.0.1:1234/v1/models', 'Optional.'],
];
for (const [name, url, hint] of probes) {
  const r = await getJson(url, 1500);
  add(r.ok ? 'ok' : 'info', `${name}: ${r.ok ? 'running' : 'not running'} (${new URL(url).host})`, r.ok ? '' : hint);
}

// Desktop app
const electronInstalled = fs.existsSync(path.join(root, 'node_modules', 'electron', 'path.txt'));
const builtApp = ['dist/mac-arm64/Harness.app', '/Applications/Harness.app'].map((p) => path.resolve(root, p)).find((p) => fs.existsSync(p));
add(electronInstalled ? 'ok' : 'info', `Desktop app tooling: ${electronInstalled ? 'installed (npm run app / npm run dist)' : 'not installed'}`, electronInstalled ? '' : 'Only needed for the desktop app; the browser version works without it.', electronInstalled ? '' : 'npm install');
if (builtApp) add('ok', `Built app: ${builtApp}`);

// Live conformance check (optional, slow-ish: loads models and sends tiny chats)
let liveSummary = null;
if (live) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-live-'));
  const jsonFile = path.join(out, 'live-check.json');
  const mdFile = path.join(os.homedir(), 'Desktop', 'harness-live-check.md');
  const md = fs.existsSync(path.dirname(mdFile)) ? mdFile : path.join(out, 'live-check.md');
  if (!asJson) console.log('Running the live check against the real backends (a few minutes; it loads models and sends tiny chats)…');
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'live-check.mjs'), '--timeout-scale', lowRam ? '3' : '1', '--json', jsonFile, '--markdown', md], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('exit', (c) => resolve(c));
    child.on('error', () => resolve(null));
  });
  let report = null;
  try { report = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch { /* reported below */ }
  if (!report) {
    add('warn', 'Live check did not produce a report', `exit code ${code}`, 'Run it directly to see why: npm run live-check');
  } else {
    const s = report.summary;
    const bad = report.checks.filter((c) => c.status === 'FAIL' || c.status === 'WARN');
    liveSummary = { exitCode: code, summary: s, markdown: md, problems: bad.map((c) => ({ id: c.id, status: c.status, detail: c.detail })) };
    add(s.FAIL ? 'fail' : s.WARN ? 'warn' : code === 2 ? 'warn' : 'ok', `Live check: ${s.PASS} pass, ${s.FAIL} fail, ${s.WARN} warn, ${s.SKIP} skip${code === 2 ? ' (no backend reachable)' : ''}`,
      bad.slice(0, 8).map((c) => `${c.status} ${c.id}${c.detail ? `: ${String(c.detail).slice(0, 140)}` : ''}`).join('\n      '),
      `Full report (Markdown, paste it into a bug report): ${md}`);
  }
  fs.rmSync(jsonFile, { force: true });
}

// ---------------------------------------------------------------------------------------------- output
if (asJson) {
  console.log(JSON.stringify({ version: pkg.version, dataDir, recommended: rec, protections: prot || null, live: liveSummary, results }, null, 2));
} else {
  const icon = { ok: '✓', warn: '!', fail: '✗', info: '·' };
  console.log(`Harness ${pkg.version} — environment check\n`);
  for (const r of results) {
    console.log(`  ${icon[r.status]} ${r.title}`);
    if (r.detail) console.log(`      ${r.detail}`);
    if (r.fix && r.status !== 'ok') console.log(`      → ${r.fix}`);
  }
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  console.log(`\n${fails ? `${fails} problem(s) to fix` : 'No blocking problems'}${warns ? `, ${warns} suggestion(s)` : ''}.`);
  if (!live) console.log('To test Harness against your real Ollama / Draw Things as well: npm run doctor -- --live');
}
process.exitCode = results.some((r) => r.status === 'fail') ? 1 : 0;
