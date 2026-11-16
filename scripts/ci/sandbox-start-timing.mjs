#!/usr/bin/env node
// CI-only (macOS runner), fact-finding: how long does `ollama serve` need until it answers, inside the offline-lock
// sandbox and without it, on an idle machine and while another Ollama is loading a model or generating?
//
// Harness waits a fixed time for the Ollama it starts; one run on the runner showed that start timing out inside the
// sandbox. This prints, per scenario, the time until the server answers /api/version and Ollama's own log lines with
// their offsets, so the wait can be sized from facts.
//
//   node scripts/ci/sandbox-start-timing.mjs [profile=server/security/offline-lock.sb]
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROFILE = path.resolve(process.argv[2] || path.join(ROOT, 'server/security/offline-lock.sb'));
const EXTERNAL = process.env.O || 'http://127.0.0.1:11434';
const SANDBOX_EXEC = process.env.HARNESS_SANDBOX_EXEC || '/usr/bin/sandbox-exec';
const BIN = process.env.HARNESS_OLLAMA_BIN || 'ollama';
const LIMIT_MS = Number(process.env.LIMIT_MS || 120000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n = 190) => (s.length > n ? `${s.slice(0, n)}…` : s);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function get(url, timeoutMs) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }); return { ok: r.ok, status: r.status, text: await r.text() }; } catch (e) { return { ok: false, status: 0, text: String(e.cause?.code || e.name) }; }
}

function generate(model, numPredict = 64) {
  const t0 = Date.now();
  return fetch(`${EXTERNAL}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, prompt: 'Count from 1 to 60.', stream: false, options: { num_predict: numPredict, num_ctx: 2048 } }), signal: AbortSignal.timeout(300000) })
    .then(async (r) => { const j = await r.json().catch(() => ({})); return { ok: r.ok, ms: Date.now() - t0, loadMs: Math.round((j.load_duration || 0) / 1e6), evalCount: j.eval_count ?? null }; })
    .catch((e) => ({ ok: false, ms: Date.now() - t0, error: String(e.cause?.code || e.name) }));
}

/** Start one server, wait until it answers, stop it. */
async function scenario(label, { sandboxed }) {
  const port = await freePort();
  const env = { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_NUM_PARALLEL: '1', OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_NO_CLOUD: '1', LLAMA_ARG_CACHE_RAM: '512' };
  const [cmd, args] = sandboxed ? [SANDBOX_EXEC, ['-f', PROFILE, BIN, 'serve']] : [BIN, ['serve']];
  const t0 = Date.now();
  const lines = [];
  let exited = null;
  const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (d) => { for (const l of String(d).split('\n')) if (l.trim()) lines.push({ at: Date.now() - t0, text: l.trim() }); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => { exited = `spawn error ${e.code || e.message}`; });
  child.on('exit', (code, signal) => { exited = `exit ${code ?? signal}`; });
  let readyMs = null;
  let firstConnectMs = null;
  while (Date.now() - t0 < LIMIT_MS && !exited) {
    const r = await get(`http://127.0.0.1:${port}/api/version`, 1500);
    if (firstConnectMs === null && r.text !== 'ECONNREFUSED') firstConnectMs = Date.now() - t0; // something is listening
    if (r.ok) { readyMs = Date.now() - t0; break; }
    await sleep(100);
  }
  if (!exited) {
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([gone, sleep(5000).then(() => child.kill('SIGKILL'))]);
  }
  const listen = lines.find((l) => /Listening on/i.test(l.text));
  console.log(`${label}: ${readyMs === null ? `NOT READY after ${Date.now() - t0} ms${exited ? ` (${exited})` : ''}` : `ready after ${readyMs} ms`}; port accepted connections after ${firstConnectMs ?? '-'} ms; "Listening on" logged at ${listen ? `${listen.at} ms` : '-'}; ${lines.length} log lines`);
  // The interesting lines: everything around GPU discovery, plus anything slow (a gap of more than a second).
  let prev = 0;
  let shown = 0;
  for (const l of lines) {
    const gap = l.at - prev;
    prev = l.at;
    const interesting = gap > 1000 || /discover|inference compute|gpu|metal|listening|error|denied|sandbox|operation not permitted|level=WARN/i.test(l.text);
    if (interesting && shown < 14) { console.log(`    +${String(l.at).padStart(6)} ms${gap > 1000 ? ` (after a ${gap} ms gap)` : ''}: ${clip(l.text.replace(/^time=\S+ /, ''))}`); shown++; }
  }
  return { readyMs, exited };
}

const ext = await get(`${EXTERNAL}/api/version`, 5000);
console.log(`external Ollama at ${EXTERNAL}: ${ext.ok ? ext.text.trim() : `not running (${ext.text})`}; profile ${path.relative(ROOT, PROFILE)}; wait limit ${LIMIT_MS} ms`);
if (process.platform !== 'darwin' && !process.env.HARNESS_SANDBOX_EXEC) { console.log('sandbox-exec exists only on macOS: nothing to measure here.'); process.exit(0); }

await scenario('1. sandboxed, machine idle (first sandboxed start on this machine)', { sandboxed: true });
await scenario('2. plain, machine idle', { sandboxed: false });
await scenario('3. sandboxed, machine idle (second time)', { sandboxed: true });
if (ext.ok) {
  // The condition of the failed round: the other Ollama loads a model for the first time while ours starts.
  const cold = generate('qwen3:0.6b');
  await sleep(300);
  await scenario('4. sandboxed, while the other Ollama loads its first model', { sandboxed: true });
  console.log(`    the other Ollama's first generation: ${JSON.stringify(await cold)}`);
  const swap1 = generate('gemma3:270m');
  await sleep(300);
  await scenario('5. plain, while the other Ollama swaps to another model', { sandboxed: false });
  console.log(`    the other Ollama's generation: ${JSON.stringify(await swap1)}`);
  const swap2 = generate('qwen3:0.6b');
  await sleep(300);
  await scenario('6. sandboxed, while the other Ollama swaps models again', { sandboxed: true });
  console.log(`    the other Ollama's generation: ${JSON.stringify(await swap2)}`);
  const long = generate('qwen3:0.6b', 400);
  await sleep(1500);
  await scenario('7. sandboxed, while the other Ollama generates (model already loaded)', { sandboxed: true });
  await scenario('8. plain, while the other Ollama generates', { sandboxed: false });
  console.log(`    the other Ollama's generation: ${JSON.stringify(await long)}`);
}
await scenario('9. sandboxed, machine idle again', { sandboxed: true });
