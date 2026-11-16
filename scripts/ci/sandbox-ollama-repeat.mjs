#!/usr/bin/env node
// CI-only (macOS runner): prove, several times in a row and on a busy machine, that an Ollama which Harness starts
// while internet access is blocked runs inside the offline-lock sandbox.
//
// Each round starts a throw-away Harness in this process (fresh temporary data folder, a random password set through
// the API, Ollama pointed at a spare port), asks Harness to start Ollama, and then sends a model pull STRAIGHT to
// that Ollama. The pull must fail and Harness must report the start as sandboxed. Meanwhile an external Ollama on
// 127.0.0.1:11434 is kept busy swapping two small models, as it is during the live check.
//
//   node scripts/ci/sandbox-ollama-repeat.mjs [rounds=10] [pull-model=all-minilm:22m]
//
// Odd rounds leave Harness's automatic Ollama start on (the server then also probes the external Ollama when the
// data is unlocked); even rounds switch it off. One line per round; exit 1 when any round was not confined.
// It never touches the real Harness data folder or the login Keychain.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUNDS = Math.max(1, Number(process.argv[2]) || 10);
const PULL = process.argv[3] || 'all-minilm:22m';
const EXTERNAL = process.env.O || 'http://127.0.0.1:11434';
const BUSY_MODELS = (process.env.BUSY_MODELS ?? 'qwen3:0.6b,gemma3:270m').split(',').filter(Boolean);

// (HARNESS_SANDBOX_EXEC points the backend at a stand-in for sandbox-exec: that is how this script is tried on Linux.)
if (process.platform !== 'darwin' && !process.env.HARNESS_SANDBOX_EXEC) { console.log('sandbox-exec exists only on macOS: nothing to prove here.'); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n = 200) => { const t = typeof s === 'string' ? s : JSON.stringify(s); return t && t.length > n ? `${t.slice(0, n)}…` : t; };

async function call(base, p, { method = 'GET', body, token, timeoutMs = 30000 } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: r.ok, status: r.status, text, json };
  } catch (e) {
    return { ok: false, status: 0, text: String(e.cause?.code || e.name || e.message), json: null };
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Keep the external Ollama (and this machine) busy, the way the live check does while this scenario runs.
let stopBusy = false;
let busyCalls = 0;
async function busy() {
  for (let i = 0; !stopBusy && BUSY_MODELS.length; i++) {
    const r = await call(EXTERNAL, '/api/generate', { method: 'POST', body: { model: BUSY_MODELS[i % BUSY_MODELS.length], prompt: 'Count from 1 to 40.', stream: false, options: { num_predict: 48, num_ctx: 2048 } }, timeoutMs: 180000 });
    if (r.ok) busyCalls++; else await sleep(500);
  }
}

// Harness logs through console.*: keep the lines of one round that say how Ollama was started.
function captureLogs() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const keep = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); if (/^\[harness /.test(s)) { if (/ollama|sandbox/i.test(s)) lines.push(s.replace(/^\[harness [^\]]*\] /, '')); } else orig.log(...a); };
  console.log = keep; console.warn = keep; console.error = keep;
  return { lines, restore() { Object.assign(console, orig); } };
}

async function round(n) {
  const autoStart = n % 2 === 1;
  if (autoStart) delete process.env.HARNESS_NO_OLLAMA_AUTOSTART; else process.env.HARNESS_NO_OLLAMA_AUTOSTART = '1';
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harness-sbx-repeat-'));
  const port = await freePort();
  const out = { n, autoStart, port, confined: false };
  const logs = captureLogs();
  let srv = null;
  try {
    const { startServer } = await import(pathToFileURL(path.join(ROOT, 'server/index.mjs')).href);
    srv = await startServer({ port: 0, dataDir: dir, autodetect: false, logLevel: 'info', keychain: 'file' });
    const password = crypto.randomBytes(18).toString('base64url'); // never printed
    const setup = await call(srv.url, '/api/security/setup', { method: 'POST', body: { password, session: 'token' }, timeoutMs: 180000 });
    const token = setup.json?.sessionToken;
    if (!setup.ok || !token) { out.error = `setup → ${setup.status} ${clip(setup.json?.error?.code || setup.text, 80)}`; return out; }
    const api = (method, p, body, timeoutMs = 60000) => call(srv.url, p, { method, body, token, timeoutMs });
    for (let i = 0; i < 240; i++) { if ((await api('GET', '/api/security')).json?.state === 'unlocked') break; await sleep(250); }
    const patch = await api('PATCH', '/api/settings', { providers: { autodetect: false, builtin: { ollama: { enabled: true, baseUrl: `http://127.0.0.1:${port}` } } }, ollama: { autoStart: true, stopOnExit: true } });
    if (!patch.ok) { out.error = `PATCH /api/settings → ${patch.status}`; return out; }
    const t0 = Date.now();
    const st = await api('POST', '/api/providers/ollama/start', {}, 180000);
    out.startMs = Date.now() - t0;
    out.start = `${st.status}${st.json?.error ? ` ${st.json.error.code}: ${clip(st.json.error.message, 120)}` : ''}`;
    out.sandboxed = st.json?.sandboxed ?? null;
    out.alreadyRunning = st.json?.alreadyRunning ?? false;
    const lock = (await api('GET', '/api/security')).json?.offlineLock || {};
    out.offlineLock = `blocked ${lock.blocked}, osEnforced ${lock.osEnforced}, osScope ${lock.osScope}`;
    const sys = (await api('GET', '/api/system')).json?.ollama || {};
    out.managed = sys.managed ?? null;
    out.lastError = sys.lastError || null;
    const direct = await call(`http://127.0.0.1:${port}`, '/api/pull', { method: 'POST', body: { model: PULL, stream: false }, timeoutMs: 120000 });
    out.pull = `${direct.status} ${clip(direct.json?.error || direct.json?.status || direct.text, 150)}`;
    out.pulled = direct.ok && !direct.json?.error && /success/i.test(direct.json?.status || '');
    if (out.pulled) await call(`http://127.0.0.1:${port}`, '/api/delete', { method: 'DELETE', body: { model: PULL }, timeoutMs: 30000 });
    out.confined = st.ok && out.sandboxed === true && lock.osScope === 'ollama' && !out.pulled && direct.status !== 0;
    return out;
  } catch (e) {
    out.error = String(e?.message || e);
    return out;
  } finally {
    if (srv) await srv.close().catch(() => {});
    logs.restore();
    out.log = logs.lines;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const ext = await call(EXTERNAL, '/api/version', { timeoutMs: 5000 });
console.log(`external Ollama at ${EXTERNAL}: ${ext.ok ? ext.json?.version : `not running (${ext.text})`}; busy models: ${BUSY_MODELS.join(', ') || 'none'}; pull model ${PULL}; ${ROUNDS} rounds`);
const prevEnv = process.env.HARNESS_NO_OLLAMA_AUTOSTART;
const busyDone = ext.ok ? busy() : Promise.resolve();
const results = [];
for (let n = 1; n <= ROUNDS; n++) {
  const r = await round(n);
  results.push(r);
  console.log(`round ${n} (auto-start ${r.autoStart ? 'on' : 'off'}): ${r.confined ? 'CONFINED' : 'NOT CONFINED'} — start ${r.start ?? '-'} in ${r.startMs ?? '?'} ms, sandboxed ${r.sandboxed}${r.alreadyRunning ? ' (already running!)' : ''}; ${r.offlineLock ?? ''}; direct pull → ${r.pull ?? '-'}${r.lastError ? `; lastError ${clip(r.lastError, 160)}` : ''}${r.error ? `; ERROR ${r.error}` : ''}`);
  for (const l of r.log || []) console.log(`    log: ${clip(l, 300)}`);
}
stopBusy = true;
await Promise.race([busyDone, sleep(5000)]);
if (prevEnv === undefined) delete process.env.HARNESS_NO_OLLAMA_AUTOSTART; else process.env.HARNESS_NO_OLLAMA_AUTOSTART = prevEnv;
const bad = results.filter((r) => !r.confined);
console.log(`${results.length - bad.length} of ${results.length} rounds confined (${busyCalls} background generations on the external Ollama meanwhile)${bad.length ? `; NOT confined: rounds ${bad.map((r) => r.n).join(', ')}` : ''}`);
process.exit(bad.length ? 1 : 0);
