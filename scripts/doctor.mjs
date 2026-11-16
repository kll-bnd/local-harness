#!/usr/bin/env node
// `npm run doctor` — check this machine for everything Harness needs and say how to fix what is missing.
// Zero dependencies; read-only except for a throw-away temp folder (deleted again) used to ask the
// backend which model fits this machine. Never installs anything.
//
//   npm run doctor                         human-readable report
//   npm run doctor -- --json               machine-readable report
//   npm run doctor -- --recommended-model  print only the model tag Harness recommends for this machine
//   npm run doctor -- --version            print the Harness version
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.HARNESS_NO_OLLAMA_AUTOSTART = '1'; // the temporary backend below must never start Ollama
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { resolveDataDir } = require('../electron/lib/paths.cjs');
const { findRunningHarness, portRange } = require('../electron/lib/instance.cjs');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const args = new Set(process.argv.slice(2));
if (args.has('--version') || args.has('-v')) { console.log(`Harness ${pkg.version}`); process.exit(0); }
const asJson = args.has('--json');
const onlyModel = args.has('--recommended-model');

const GB = 1024 ** 3;
const fmtGB = (b) => `${(b / GB).toFixed(1)} GB`;
const results = [];
const add = (status, title, detail = '', fix = '') => results.push({ status, title, detail, fix });

async function getJson(url, timeoutMs = 2500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false, error: e.cause?.code || e.name || e.message };
  }
}

function run(cmd, argv) {
  try { return execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { return null; }
}

/** Ask the real backend (in a temporary data dir, no Ollama auto-start) what it recommends here. */
async function recommendation() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-doctor-'));
  try {
    const { startServer } = await import('../server/index.mjs');
    const srv = await startServer({ port: 0, dataDir: tmp, openBrowser: false, autodetect: false, logLevel: 'silent' });
    try {
      const r = await getJson(`${srv.url}/api/models/recommended`, 15000);
      return r.ok ? r.data : null;
    } finally {
      await srv.close();
    }
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function pickRecommended(rec) {
  const m = rec?.models?.find((x) => x.tags?.includes('recommended')) || rec?.models?.[0];
  if (!m) return null;
  const v = m.variants?.find((x) => x.model === m.suggestedVariant) || m.variants?.[0];
  return { name: m.name, model: m.suggestedVariant || v?.model, installed: !!v?.installed, estimate: v?.estimate || null, sizeBytes: v?.approxSizeBytes || null };
}

if (onlyModel) {
  const r = pickRecommended(await recommendation());
  if (!r?.model) { console.error('Could not determine a recommended model.'); process.exit(1); }
  console.log(r.model);
  // Human-readable context on stderr, so `model=$(… --recommended-model)` captures only the tag.
  console.error([r.name, r.sizeBytes ? `download ~${fmtGB(r.sizeBytes)}` : '', r.estimate?.explanation || ''].filter(Boolean).join(' — '));
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------- checks
const isMac = process.platform === 'darwin';
const major = Number(process.versions.node.split('.')[0]);
add(major >= 20 ? 'ok' : 'fail', `Node.js ${process.versions.node}`, major >= 20 ? '' : 'Harness needs Node.js 20 or newer.', 'brew install node');

const totalMem = os.totalmem();
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
add(totalMem <= 8.5 * GB ? 'info' : 'ok', `Memory: ${fmtGB(totalMem)}`, totalMem <= 8.5 * GB ? 'Low-RAM mode: Harness picks a small quantization, caps the context window and unloads the chat model while generating images.' : '');

// Data directory
const dataDir = resolveDataDir();
let writable = false;
try {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.accessSync(dataDir, fs.constants.W_OK);
  writable = true;
} catch { /* reported below */ }
add(writable ? 'ok' : 'fail', `Data folder: ${dataDir}`, writable ? '' : 'Not writable.', `Check permissions: ls -ld "${dataDir}"`);

// Already running?
const running = writable ? await findRunningHarness({ dataDir, ports: portRange(Number(process.env.HARNESS_PORT) || 4747), timeoutMs: 800 }) : null;
if (running) add('info', `Harness ${running.version} is running at ${running.url}`, `pid ${running.pid}`);

// Ollama
const { findOllamaBinary } = await import('../server/providers/ollama-process.mjs');
const bin = findOllamaBinary();
const ollamaUrl = (() => {
  const h = process.env.OLLAMA_HOST;
  if (!h) return 'http://127.0.0.1:11434';
  const withScheme = /^https?:\/\//.test(h) ? h : `http://${h}`;
  try { const u = new URL(withScheme); return `${u.protocol}//${u.hostname === '0.0.0.0' ? '127.0.0.1' : u.hostname}:${u.port || 11434}`; } catch { return 'http://127.0.0.1:11434'; }
})();
const ver = await getJson(`${ollamaUrl}/api/version`);
const binVersion = bin ? run(bin, ['--version']) : null;
if (!bin && !ver.ok) {
  add('fail', 'Ollama is not installed', 'Harness runs chat models through Ollama (or another local server).', isMac ? 'brew install ollama   (or download it from https://ollama.com/download)' : 'https://ollama.com/download');
} else {
  add('ok', `Ollama ${ver.ok ? ver.data?.version : (binVersion || '').replace(/^.*version is\s*/i, '') || ''}`.trim(), bin ? bin : 'binary not found on PATH (server reachable)');
  if (!ver.ok) add('info', `Ollama is not running at ${ollamaUrl}`, 'Fine: Harness starts it automatically with memory-friendly settings when it launches.');
}

let tags = [];
if (ver.ok) {
  const t = await getJson(`${ollamaUrl}/api/tags`);
  tags = t.ok ? (t.data?.models || []).map((m) => ({ name: m.name, size: m.size })) : [];
  add(tags.length ? 'ok' : 'warn', `Installed models: ${tags.length ? tags.map((m) => `${m.name} (${fmtGB(m.size || 0)})`).join(', ') : 'none'}`);
  const ps = await getJson(`${ollamaUrl}/api/ps`);
  const loaded = ps.ok ? ps.data?.models || [] : [];
  if (loaded.length) add('info', `Loaded right now: ${loaded.map((m) => `${m.name} (${fmtGB(m.size || 0)}, context ${m.context_length ?? '?'})`).join(', ')}`);
}

// Recommended model for this machine (asks the real backend)
const rec = pickRecommended(await recommendation());
if (rec?.model) {
  const installed = rec.installed || tags.some((t) => t.name === rec.model || t.name === `${rec.model}:latest`);
  add(installed ? 'ok' : 'warn', `Recommended for this machine: ${rec.model}`,
    [rec.estimate?.explanation, rec.sizeBytes ? `download ~${fmtGB(rec.sizeBytes)}` : ''].filter(Boolean).join(' — '),
    installed ? '' : `ollama pull ${rec.model}   (or use Models → Download in the app)`);
} else {
  add('warn', 'Could not compute a model recommendation');
}

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

// ---------------------------------------------------------------------------------------------- output
if (asJson) {
  console.log(JSON.stringify({ version: pkg.version, dataDir, recommended: rec, results }, null, 2));
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
}
process.exitCode = results.some((r) => r.status === 'fail') ? 1 : 0;
