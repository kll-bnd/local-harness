#!/usr/bin/env node
// `npm run get-model` — download the chat model Harness recommends for this Mac and, on 8 GB machines, make
// the text-only copy of it, all through the Harness API (the same steps as the app's Models screen).
//
// It uses the Harness that is already running for your data folder, or starts one just for this (and stops it
// again). Ollama is therefore always started BY HARNESS, with its memory protections — never directly.
//
// Harness 0.2 keeps your data locked behind your Harness password and blocks internet access by default, so:
//   * it asks for your Harness password (on the terminal, not shown; or from stdin with --password-stdin);
//   * the download needs internet: it asks before allowing it for a limited window (your password confirms),
//     blocks it again as soon as the download is done, and prints the blocker's state at the end;
//   * on a fresh install (no password chosen yet) it stops and tells you to open Harness first.
//
//   npm run get-model                        ask before each step
//   npm run get-model -- --yes               accept the defaults (allow internet for the download, text-only copy)
//   npm run get-model -- --yes --delete-original
//   npm run get-model -- --model <tag>       a different file, e.g. the largest realistic one on 8 GB
//   npm run get-model -- --minutes 30        length of the internet window (default 15; a running download
//                                            keeps it open until it ends)
//   … --password-stdin < file                read the Harness password from stdin (automation; implies no questions
//                                            on stdin, so combine with --yes)
import readline from 'node:readline/promises';
import { createRequire } from 'node:module';
import { HarnessClient, passwordSource, reachHarness, describeOfflineLock } from './lib/harness-client.mjs';

const require = createRequire(import.meta.url);
const { resolveDataDir } = require('../electron/lib/paths.cjs');

const argv = process.argv.slice(2);
const yes = argv.includes('--yes') || argv.includes('-y');
const pwStdin = argv.includes('--password-stdin');
const deleteOriginal = argv.includes('--delete-original');
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const modelArg = opt('--model');
const minutes = Math.min(120, Math.max(1, Number(opt('--minutes')) || 15));
const GB = 1024 ** 3;
const fmtGB = (b) => `${(b / GB).toFixed(1)} GB`;
const interactive = process.stdin.isTTY && !yes && !pwStdin;

async function ask(q, def = true) {
  if (yes) { console.log(`${q} → ${def ? 'yes' : 'no'} (--yes)`); return def; }
  if (!interactive) { console.log(`${q} → skipped (not interactive; use --yes)`); return false; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} [${def ? 'Y/n' : 'y/N'}] `)).trim().toLowerCase();
  rl.close();
  return a ? a.startsWith('y') : def;
}

// ------------------------------------------------------------------------------------- reach Harness
const dataDir = resolveDataDir();
const port = Number(process.env.HARNESS_PORT) || 4747;
let h;
try {
  h = await reachHarness({ dataDir, port, log: (m) => console.log(m) });
} catch (e) {
  console.error(`Harness could not start: ${e.message}\nRun: npm run doctor`);
  process.exit(1);
}
if (h.running) console.log(`Using the Harness that is running at ${h.base}.`);
const client = new HarnessClient({ base: h.base, dataDir, password: passwordSource({ fromStdin: pwStdin }) });
let allowedByUs = false;
let closing = false;

async function done(code) {
  if (closing) return;
  closing = true;
  try {
    if (allowedByUs) {
      const r = await client.request('POST', '/api/network/block', {}).catch(() => null);
      if (!r?.ok) console.error('! Could not block internet access again — it blocks itself when the window ends. Check with: npm run doctor');
    }
    await printBlockerState();
  } finally {
    await client.close().catch(() => {});
    await h.close();
    process.exit(code);
  }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => done(130));

async function printBlockerState() {
  if (!client.authenticated && client.via !== 'legacy') return;
  const sec = await client.security().catch(() => null);
  if (sec?.offlineLock) console.log(`\nInternet access in Harness now: ${describeOfflineLock(sec.offlineLock)}`);
}

const api = (method, p, body) => client.request(method, p, body).then((r) => ({ status: r.status, ok: r.ok, data: r.data }));

try {
  await client.ensureSession({ reason: 'download a model' });
} catch (e) {
  console.error(`\n${e.message}`);
  await client.close().catch(() => {});
  await h.close();
  process.exit(e.code === 'needs_setup' ? 3 : 2);
}
// Harness started here and just unlocked: give it a moment to start Ollama itself (with its protections).
if (h.srv?.app?.startup) await h.srv.app.startup.catch(() => {});

// ------------------------------------------------------------------------------------------- Ollama
let sys = (await api('GET', '/api/system')).data;
let ollama = sys?.providers?.find((p) => p.id === 'ollama');
if (ollama?.status !== 'running' && sys?.ollama?.installed) {
  const r = await api('POST', '/api/providers/ollama/start');
  if (!r.ok) { console.error(`Could not start Ollama: ${r.data?.error?.message || r.status}`); await done(1); }
  sys = (await api('GET', '/api/system?refresh=1')).data;
  ollama = sys?.providers?.find((p) => p.id === 'ollama');
}
if (ollama?.status !== 'running') {
  console.error(sys?.ollama?.installed ? 'Ollama is installed but not answering. Run: npm run doctor' : 'Ollama is not installed. Install it first: brew install ollama   (or https://ollama.com/download)');
  await done(1);
}
if (sys.ollama?.protections?.message) console.log(`\n${sys.ollama.protections.inEffect ? '✓' : '!'} ${sys.ollama.protections.message}`);

// ------------------------------------------------------------------------------------ what to get
const rec = (await api('GET', '/api/models/recommended')).data;
const m = rec?.models?.find((x) => x.tags?.includes('recommended')) || rec?.models?.[0];
if (!m) { console.error('Harness returned no recommendation.'); await done(1); }
// Already set up with another file of this model (e.g. the largest realistic one)? Then there is nothing to do.
if (!modelArg) {
  const have = m.variants.find((x) => (m.suggestTextOnly ? x.textOnly?.installed : x.installed) && !x.notForThisMachine);
  if (have) {
    console.log(`\n✓ ${m.name} is already installed: ${m.suggestTextOnly ? have.textOnly.model : have.model}. Nothing to do.`);
    console.log('  (To get a different file anyway: npm run get-model -- --model <tag>)');
    await done(0);
  }
}
const tag = modelArg || m.suggestedVariant;
const v = m.variants.find((x) => x.model === tag);
if (!v && !modelArg) { console.error(`Unknown variant ${tag}.`); await done(1); }
const avoid = (m.avoid || []).find((a) => a.model === tag);
if (avoid) { console.error(`Not downloading ${tag}: ${avoid.reason}`); await done(1); }
const textOnly = m.suggestTextOnly && v?.textOnly?.model ? v.textOnly : null;

console.log(`\n${m.name}: ${tag}${v?.approxSizeBytes ? ` (download ~${fmtGB(v.approxSizeBytes)})` : ''}`);
if (m.lowRamNote) console.log(`  ${m.lowRamNote}`);
else if (v?.estimate?.explanation) console.log(`  ${v.estimate.explanation}`);
if (!modelArg && m.largestRealisticVariant && m.largestRealisticVariant !== tag) console.log(`  For the largest realistic file instead: npm run get-model -- --model ${m.largestRealisticVariant}`);

// ------------------------------------------------------------------------------------------ download
const installedNames = new Set(((await api('GET', '/api/models?refresh=1')).data?.models || []).map((x) => x.model));
const fileInstalled = installedNames.has(tag);
const copyInstalled = textOnly && (installedNames.has(textOnly.model) || textOnly.installed);

if (copyInstalled) {
  console.log(`\n✓ The text-only copy ${textOnly.model} is already installed — nothing to do.`);
  await done(0);
}
if (fileInstalled) {
  console.log(`\n✓ ${tag} is already downloaded.`);
} else {
  if (!(await ask(`\nDownload ${tag} now?`, true))) await done(0);
  if (!(await allowInternet())) await done(0);
  const ok = await pull(tag);
  if (allowedByUs) {
    const r = await api('POST', '/api/network/block', {});
    if (r.ok) { allowedByUs = false; console.log('✓ Internet access is blocked again.'); }
  }
  if (!ok) await done(1);
}

// ------------------------------------------------------------------------------------- text-only copy
if (textOnly) {
  console.log(`\nOn this Mac Harness recommends a text-only copy: same weights, without the ~1 GB image/audio part
(no download, a few seconds). The copy cannot read images you attach, but it can still ask Draw Things to make them.`);
  if (await ask(`Make the text-only copy ${textOnly.model}?`, true)) {
    const r = await api('POST', '/api/models/text-only', { model: tag });
    if (!r.ok) { console.error(`Could not make the copy: ${r.data?.error?.message || r.status}`); await done(1); }
    console.log(`✓ ${r.data.created ? 'Created' : 'Already there:'} ${r.data.model}${r.data.sizeBytes ? ` (${fmtGB(r.data.sizeBytes)})` : ''}${r.data.note ? `\n  ${r.data.note}` : ''}`);
    if (await ask(`Delete the original ${tag}? (frees ~${fmtGB(v?.projectorBytes || GB)} of disk; the copy keeps the weights. Keep it if you want to attach images on a bigger Mac.)`, deleteOriginal)) {
      const d = await api('DELETE', `/api/models?model=${encodeURIComponent(tag)}&providerId=ollama`);
      console.log(d.ok ? `✓ Deleted ${tag}` : `Could not delete ${tag}: ${d.data?.error?.message || d.status}`);
    }
  }
}
console.log('\nDone. Pick the model in Harness (it is chosen automatically when it is the best installed fit).');
await done(0);

// ------------------------------------------------------------------------------------ internet window
/** Make sure the download may reach the internet: ask, then allow for `minutes` with the password. */
async function allowInternet() {
  const net = await api('GET', '/api/network');
  const o = net.data?.offlineLock;
  if (!net.ok || !o) return true; // a Harness without the blocker
  if (!o.blocked) { console.log(`Internet access in Harness: ${describeOfflineLock(o)}`); return true; }
  console.log(`\nInternet access is blocked in Harness (the default: chat never needs it). The download needs it, so
Harness can allow it for ${minutes} minutes — it blocks again by itself when that time is up (a download still
running keeps it open until it ends), and this tool blocks it again as soon as the download is done.`);
  if (!(await ask(`Allow internet access for this download (needs your Harness password)?`, true))) {
    console.log('Not downloading. You can also download from the app\'s Models screen ("Allow internet for 15 minutes").');
    return false;
  }
  const r = await client.withPassword((pw) => client.request('POST', '/api/network/allow', { minutes, password: pw }), 'Harness password (to allow internet for the download): ');
  if (!r.ok) {
    console.error(`Harness did not allow internet access: ${r.data?.error?.message || r.status}`);
    return false;
  }
  allowedByUs = true;
  if (r.data?.restartRequired) {
    console.error('Harness needs a restart to allow internet access (its whole backend runs in the macOS sandbox). Allow it from the app instead.');
    return false;
  }
  console.log(`✓ Internet access allowed: ${describeOfflineLock(r.data?.offlineLock)}`);
  return true;
}

// ---------------------------------------------------------------------------------------------- pull
async function pull(model) {
  const res = await fetch(`${h.base}/api/models/pull`, { method: 'POST', headers: { 'content-type': 'application/json', ...client.authHeaders() }, body: JSON.stringify({ model, providerId: 'ollama' }) });
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
    const j = await res.json().catch(() => null);
    const code = j?.error?.code;
    console.error(`Download failed: ${j?.error?.message || res.status}${code === 'offline_lock' ? '\n(Internet access is blocked in Harness. Allow it in the app or run this again and answer yes.)' : ''}`);
    return false;
  }
  const dec = new TextDecoder();
  let buf = '';
  let lastLine = '';
  let result = null;
  const tty = process.stdout.isTTY;
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (!data) continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === 'start' && ev.warning) console.log(`! ${ev.warning.message}`);
      if (ev.type === 'progress') {
        const line = `  ${ev.status}${ev.percent != null ? ` ${Math.floor(ev.percent)}%` : ''}${ev.total ? ` of ${fmtGB(ev.total)}` : ''}`;
        if (line !== lastLine) { if (tty) process.stdout.write(`\r${line.padEnd(70)}`); else if (ev.percent == null || ev.percent % 25 < 1) console.log(line); lastLine = line; }
      }
      if (ev.type === 'done') result = true;
      if (ev.type === 'error') { if (tty) process.stdout.write('\n'); console.error(`Download failed: ${ev.message}`); result = false; }
    }
  }
  if (tty) process.stdout.write('\n');
  if (result) console.log(`✓ Downloaded ${model}`);
  return result === true;
}
