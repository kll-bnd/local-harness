#!/usr/bin/env node
// `npm run get-model` — download the chat model Harness recommends for this Mac and, on 8 GB machines, make
// the text-only copy of it, all through the Harness API (the same steps as the app's Models screen).
//
// It uses the Harness that is already running for your data folder, or starts one just for this (and stops it
// again). Ollama is therefore always started BY HARNESS, with its memory protections — never directly.
//
//   npm run get-model                       ask before each step
//   npm run get-model -- --yes              accept the defaults (download, text-only copy; keep the original)
//   npm run get-model -- --yes --delete-original
//   npm run get-model -- --model <tag>      a different file, e.g. the largest realistic one on 8 GB
import readline from 'node:readline/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveDataDir } = require('../electron/lib/paths.cjs');
const { findRunningHarness, portRange } = require('../electron/lib/instance.cjs');

const argv = process.argv.slice(2);
const yes = argv.includes('--yes') || argv.includes('-y');
const deleteOriginal = argv.includes('--delete-original');
const modelArg = (() => { const i = argv.indexOf('--model'); return i >= 0 ? argv[i + 1] : null; })();
const GB = 1024 ** 3;
const fmtGB = (b) => `${(b / GB).toFixed(1)} GB`;
const interactive = process.stdin.isTTY && !yes;

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
let base;
let srv = null;
const running = await findRunningHarness({ dataDir, ports: portRange(port), timeoutMs: 800 });
if (running) {
  base = running.url;
  console.log(`Using the Harness that is running at ${base}.`);
} else {
  const { startServer } = await import('../server/index.mjs');
  try {
    srv = await startServer({ port, dataDir, openBrowser: false, logLevel: 'warn' });
    base = srv.url;
    console.log(`Started Harness for this step at ${base} (stopped again at the end).`);
    await srv.app.startup; // lets Harness start Ollama itself, with its protections
  } catch (e) {
    if (e?.code === 'HARNESS_ALREADY_RUNNING' && e.url) { base = e.url; console.log(`Using the Harness that is running at ${base}.`); } else throw e;
  }
}
const done = async (code) => { if (srv) await srv.close().catch(() => {}); process.exit(code); };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => done(130));

async function api(method, p, body) {
  const res = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

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
} else if (await ask(`\nDownload ${tag} now?`, true)) {
  const ok = await pull(tag);
  if (!ok) await done(1);
} else {
  await done(0);
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

// ---------------------------------------------------------------------------------------------- pull
async function pull(model) {
  const res = await fetch(`${base}/api/models/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, providerId: 'ollama' }) });
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
    const j = await res.json().catch(() => null);
    console.error(`Download failed: ${j?.error?.message || res.status}`);
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

