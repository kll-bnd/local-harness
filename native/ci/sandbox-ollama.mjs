// Proves the offline-lock profile against a real Ollama (CI only; needs `ollama` on PATH, not running).
//   node native/ci/sandbox-ollama.mjs <profile.sb> [model]
// Without the sandbox: a pull works (so the network is alive). Under the sandbox: chat on loopback
// works, a pull fails, and the network probe (TCP to a public IP, DNS) fails. Prints `sandbox-ollama …` lines.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const profile = path.resolve(process.argv[2] || 'server/security/offline-lock.sb');
const MODEL = process.argv[3] || 'qwen3:0.6b';
const SMALL = 'all-minilm';
const O = 'http://127.0.0.1:11434';
const say = (k, v) => console.log(`sandbox-ollama ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_NO_CLOUD: '1' };

function start(sandboxed, logFile) {
  const out = fs.openSync(logFile, 'w');
  const cmd = sandboxed ? '/usr/bin/sandbox-exec' : 'ollama';
  const argv = sandboxed ? ['-f', profile, 'ollama', 'serve'] : ['serve'];
  const child = spawn(cmd, argv, { env: sandboxed ? { ...env, HARNESS_SANDBOXED: '1' } : env, stdio: ['ignore', out, out] });
  return child;
}

async function up(ms = 30000) {
  for (let t = 0; t < ms; t += 300) {
    try { const r = await fetch(`${O}/api/version`); if (r.ok) return (await r.json()).version; } catch { /* not yet */ }
    await sleep(300);
  }
  return null;
}

async function stop(child) {
  child.kill('SIGTERM');
  for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  try { execFileSync('pkill', ['-f', 'ollama runner']); } catch { /* none */ }
  await sleep(500);
}

async function pull(model, ms = 600000) {
  const t = Date.now();
  try {
    const r = await fetch(`${O}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false }), signal: AbortSignal.timeout(ms) });
    const j = await r.json().catch(() => ({}));
    return { http: r.status, status: j.status || null, error: j.error ? String(j.error).slice(0, 160) : null, s: Math.round((Date.now() - t) / 1000) };
  } catch (e) { return { error: `fetch:${e.name}`, s: Math.round((Date.now() - t) / 1000) }; }
}

async function chat() {
  const t = Date.now();
  try {
    const r = await fetch(`${O}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(240000),
      body: JSON.stringify({ model: MODEL, stream: false, think: false, options: { num_predict: 24, num_ctx: 2048 }, messages: [{ role: 'user', content: 'Say hello in five words.' }] }) });
    const j = await r.json();
    return { http: r.status, ok: !!j.message?.content, words: (j.message?.content || '').trim().split(/\s+/).length, evalCount: j.eval_count, tokPerSec: j.eval_duration ? Math.round(j.eval_count / (j.eval_duration / 1e9)) : null, loadMs: j.load_duration ? Math.round(j.load_duration / 1e6) : null, error: j.error || null, s: Math.round((Date.now() - t) / 1000) };
  } catch (e) { return { error: `fetch:${e.name}:${e.message}`.slice(0, 160) }; }
}

async function ps() {
  try {
    const j = await (await fetch(`${O}/api/ps`)).json();
    return (j.models || []).map((m) => ({ name: m.name, size: m.size, vram: m.size_vram, gpuShare: m.size ? Math.round((100 * m.size_vram) / m.size) : null }));
  } catch (e) { return `err:${e.message}`; }
}

function gpuLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const keep = text.split('\n').filter((l) => /offload|library=|Metal|GPU|sandbox|denied|deny/i.test(l)).map((l) => l.replace(/^time=\S+ /, '').slice(0, 170));
  return keep.slice(-6);
}

function netProbe(sandboxed) {
  const argv = sandboxed ? ['-f', profile, process.execPath, path.join(here, 'net-probe.mjs'), 'sandboxed'] : [path.join(here, 'net-probe.mjs'), 'plain'];
  try {
    return execFileSync(sandboxed ? '/usr/bin/sandbox-exec' : process.execPath, argv, { env: sandboxed ? { ...process.env, HARNESS_SANDBOXED: '1' } : process.env, encoding: 'utf8', timeout: 90000 }).trim();
  } catch (e) { return `net-probe failed: status=${e.status} ${String(e.stderr || '').slice(0, 300)}`; }
}

// ---- 1. without the sandbox
const logPlain = '/tmp/ollama-plain.log';
let child = start(false, logPlain);
say('plain.version', String(await up()));
say('plain.pullModel', await pull(MODEL));
say('plain.chat', await chat());
say('plain.ps', await ps());
say('plain.log', gpuLines(logPlain));
await stop(child);

// ---- 2. under the sandbox
const logBox = '/tmp/ollama-sandboxed.log';
child = start(true, logBox);
say('sandboxed.version', String(await up()));
say('sandboxed.chat', await chat());
say('sandboxed.ps', await ps());
say('sandboxed.pullSmall', await pull(SMALL, 90000));
say('sandboxed.pullExisting', await pull(MODEL, 90000));
say('sandboxed.log', gpuLines(logBox));
await stop(child);
console.log(netProbe(true));

// ---- 3. without the sandbox again: the same pull succeeds and the network probe passes
child = start(false, logPlain);
await up();
say('plain.pullSmall', await pull(SMALL));
try { await fetch(`${O}/api/delete`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: SMALL }) }); } catch { /* ignore */ }
await stop(child);
console.log(netProbe(false));
