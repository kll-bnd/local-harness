// Find and (optionally) spawn `ollama serve` with memory-friendly environment settings.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ramTier } from '../context/sizing.mjs';
import { log } from '../lib/log.mjs';
import { sleep } from '../lib/util.mjs';
import { ROOT_DIR } from '../version.mjs';
import { isLoopbackHost } from '../security/egress.mjs';
import { httpRequest } from '../lib/http-client.mjs';

/**
 * Starting `ollama serve` has two phases (measured on a Mac runner, sandboxed or not — the sandbox costs nothing):
 *   1. it listens on its port within 20–160 ms ("Listening on 127.0.0.1:<port>") — a child that exits or never gets
 *      there within OLLAMA_LISTEN_TIMEOUT_MS has really failed to start;
 *   2. it answers /api/version only after its GPU discovery, which blocks while another process loads a model onto
 *      the GPU (19 s measured; Draw Things loading an image model does the same) — while the child is alive Harness
 *      waits up to OLLAMA_READY_TIMEOUT_MS, and a timeout there is a start error, never evidence against the sandbox.
 */
export const OLLAMA_LISTEN_TIMEOUT_MS = 20000;
export const OLLAMA_READY_TIMEOUT_MS = 120000;
const listenTimeout = (callerMs) => Number(process.env.HARNESS_OLLAMA_LISTEN_MS) || callerMs || OLLAMA_LISTEN_TIMEOUT_MS;
const readyTimeout = () => Number(process.env.HARNESS_OLLAMA_READY_MS) || OLLAMA_READY_TIMEOUT_MS;
const LISTENING_LINE = /Listening on /i;
/** A fallback outside the sandbox is retried (inside it) at most this many times in total per process. */
export const MAX_SANDBOX_FAILURES = 3;
const PROBE_TIMEOUT_MS = 2500;
const BIND_FAILURE = /address already in use|bind: |listen tcp .*: bind|EADDRINUSE/i;

const addrKey = (baseUrl) => { const u = new URL(baseUrl); return `${u.hostname}:${u.port || 11434}`; };

/**
 * What answers at an Ollama address: 'free' (connection refused: nobody listens), 'ollama' (an Ollama answered
 * /api/version), 'port_in_use' (something else answers), 'not_responding' (accepts or hangs but gives no answer —
 * e.g. a busy Ollama). A timeout is never taken for "nobody there".
 */
export async function probeOllama(baseUrl, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const u = new URL(baseUrl);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port || 11434);
  const tcp = await new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve('timeout'); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve('open'); });
    s.once('error', (e) => { clearTimeout(t); resolve(e.code === 'ECONNREFUSED' ? 'refused' : `error ${e.code || e.message}`); });
  });
  if (tcp === 'refused') return { state: 'free' };
  if (tcp !== 'open') return { state: 'not_responding', detail: tcp };
  try {
    const r = await httpRequest(`${u.protocol}//${u.host}/api/version`, { signal: AbortSignal.timeout(timeoutMs), agent: false });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    if (r.ok && j && typeof j.version === 'string') return { state: 'ollama', version: j.version };
    return { state: 'port_in_use', detail: `HTTP ${r.status}` };
  } catch (e) {
    return { state: e?.name === 'TimeoutError' ? 'not_responding' : 'port_in_use', detail: e?.code || e?.name || 'error' };
  }
}

/** The offline-lock profile an Ollama that Harness starts runs under while internet access is blocked. */
export const SANDBOX_PROFILE = path.join(ROOT_DIR, 'server', 'security', 'offline-lock.sb');

const MAC_LOCATIONS = [
  '/opt/homebrew/bin/ollama',
  '/usr/local/bin/ollama',
  '/Applications/Ollama.app/Contents/Resources/ollama',
];

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

export function findOllamaBinary(explicit) {
  if (explicit) return isExecutable(explicit) ? explicit : null;
  if (process.env.HARNESS_OLLAMA_BIN && isExecutable(process.env.HARNESS_OLLAMA_BIN)) return process.env.HARNESS_OLLAMA_BIN;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'ollama');
    if (isExecutable(p)) return p;
  }
  for (const p of MAC_LOCATIONS) if (isExecutable(p)) return p;
  return null;
}

/** Environment the app sets when it launches `ollama serve` itself. */
export function managedOllamaEnv(settings, { baseUrl, totalMem }) {
  const o = settings.ollama || {};
  const u = new URL(baseUrl);
  // Always bound to this Mac only: the offline-lock sandbox polices outbound connections, not connections accepted
  // on a listening socket, so an Ollama listening on 0.0.0.0 could be reached (and answer) from the network.
  const host = isLoopbackHost(u.hostname) && u.hostname !== 'localhost' ? u.hostname : '127.0.0.1';
  const env = {
    OLLAMA_HOST: `${host}:${u.port || 11434}`,
    OLLAMA_NUM_PARALLEL: String(o.numParallel ?? 1),
  };
  if (o.flashAttention !== false) env.OLLAMA_FLASH_ATTENTION = '1';
  if (o.kvCacheType && o.kvCacheType !== 'f16') env.OLLAMA_KV_CACHE_TYPE = o.kvCacheType;
  const maxLoaded = o.maxLoadedModels === 'auto' || o.maxLoadedModels == null ? (ramTier(totalMem) === 'low' ? 1 : null) : o.maxLoadedModels;
  if (maxLoaded) env.OLLAMA_MAX_LOADED_MODELS = String(maxLoaded);
  // Everything stays on this Mac: no Ollama cloud models / sign-in features in an app-spawned server.
  if (o.noCloud !== false) env.OLLAMA_NO_CLOUD = '1';
  // llama-server (Ollama's runner) keeps idle prompts in a host-RAM prompt cache of up to 8192 MiB by default;
  // every title / extraction / summary call can add a snapshot. Verified: LLAMA_ARG_CACHE_RAM on `ollama serve`
  // reaches the runner ("prompt cache is enabled, size limit: 256 MiB").
  const cacheMiB = promptCacheMiB(o.promptCacheMiB, totalMem);
  if (cacheMiB !== null) env[PROMPT_CACHE_ENV] = String(cacheMiB);
  for (const [k, v] of Object.entries(o.extraEnv || {})) if ((/^OLLAMA_[A-Z_]+$/.test(k) && k !== 'OLLAMA_HOST') || k === PROMPT_CACHE_ENV) env[k] = String(v);
  return env;
}

export const PROMPT_CACHE_ENV = 'LLAMA_ARG_CACHE_RAM';

/** 'auto' → 512 MiB on ≤ 8 GB, 2048 MiB on ≤ 16 GB, unset (runner default 8192) above; a number is used as is. */
export function promptCacheMiB(setting, totalMem) {
  if (setting === null || setting === undefined) return null;
  if (typeof setting === 'number') return Math.max(0, Math.floor(setting));
  const tier = ramTier(totalMem || 0);
  return tier === 'low' ? 512 : tier === 'medium' ? 2048 : null;
}

const PROTECTION_LABELS = {
  OLLAMA_MAX_LOADED_MODELS: (v) => `one model in memory at a time (OLLAMA_MAX_LOADED_MODELS=${v})`,
  OLLAMA_KV_CACHE_TYPE: (v) => `${v} KV cache (OLLAMA_KV_CACHE_TYPE=${v})`,
  OLLAMA_FLASH_ATTENTION: () => 'flash attention (OLLAMA_FLASH_ATTENTION=1)',
  OLLAMA_NO_CLOUD: () => 'no cloud features (OLLAMA_NO_CLOUD=1)',
  [PROMPT_CACHE_ENV]: (v) => `prompt cache capped at ${v} MiB (${PROMPT_CACHE_ENV}=${v})`,
};

export class OllamaProcess {
  /**
   * @param {object} o
   * @param {() => boolean} [o.sandbox] whether a newly started `ollama serve` should run under the offline-lock
   *        sandbox (internet access blocked). macOS only (`/usr/bin/sandbox-exec`); `HARNESS_SANDBOX_EXEC` points
   *        elsewhere for tests. If the sandbox is missing or Ollama misbehaves under it, Ollama runs without it.
   */
  constructor({ getSettings, getProvider, bus, totalMem, sandbox = () => false, sandboxExec = process.env.HARNESS_SANDBOX_EXEC || '/usr/bin/sandbox-exec', profile = SANDBOX_PROFILE, platform = process.platform }) {
    this.getSettings = getSettings;
    this.getProvider = getProvider;
    this.bus = bus;
    this.totalMem = totalMem;
    this.child = null;
    this.env = null;
    this.logTail = [];
    this.starting = null;
    this.lastError = null;
    this.sandboxWanted = sandbox;
    this.sandboxExec = sandboxExec;
    this.profile = profile;
    this.platform = platform;
    this.sandboxed = false; // the running managed Ollama is inside the sandbox
    this.sandboxFailures = 0; // starts where the sandbox (not something else) kept Ollama from starting
    this.osFallback = null; // { at, reason, detail, count }: Harness had to start Ollama outside the sandbox
    this.external = false; // an Ollama that Harness did not start answered
    this.childAddr = null; // host:port our child was started on
    this.startPhase = null; // while a start runs: 'starting' | 'waiting_for_gpu'
    this.phaseListeners = new Set();
  }

  /** Follow the phase of a running start (`fn(phase)`); returns an unsubscribe function. */
  onPhase(fn) { this.phaseListeners.add(fn); return () => this.phaseListeners.delete(fn); }

  _setPhase(phase) {
    if (this.startPhase === phase) return;
    this.startPhase = phase;
    for (const fn of this.phaseListeners) { try { fn(phase); } catch { /* a listener's problem */ } }
    if (phase) this.bus?.publish('ollama.status', { managed: true, running: false, starting: true, phase });
  }

  get managed() { return this._childAlive(); }

  _childAlive() { return !!(this.child && this.child.exitCode === null && this.child.signalCode === null); }

  /** The sandbox stops being tried after MAX_SANDBOX_FAILURES evidenced failures (until Harness restarts). */
  get sandboxBroken() { return this.sandboxFailures >= MAX_SANDBOX_FAILURES; }

  _useSandbox() {
    if (this.sandboxBroken || !this.sandboxWanted()) return false;
    if (this.platform !== 'darwin' && !process.env.HARNESS_SANDBOX_EXEC) return false;
    return isExecutable(this.sandboxExec) && fs.existsSync(this.profile);
  }

  /**
   * After the user allowed or blocked internet access: restart a managed Ollama with / without the sandbox when
   * that changes anything (a running pull or chat on it is cut off — this happens only on that user action).
   */
  async applySandbox() {
    while (this.starting) await this.starting.catch(() => {});
    if (!this._childAlive()) return { restarted: false };
    if (this.sandboxed === this._useSandbox()) return { restarted: false };
    await this.stop();
    const r = await this.start();
    return { restarted: true, ...r };
  }

  /** The configured Ollama address changed: move the Ollama Harness started (it is ours) to the new one. */
  async followAddress() {
    while (this.starting) await this.starting.catch(() => {});
    if (!this._childAlive() || this.childAddr === addrKey(this.getProvider().baseUrl)) return { moved: false };
    log.info('The Ollama address changed: moving the Ollama Harness started');
    return { moved: true, ...(await this.start()) };
  }

  /**
   * Whether the memory protections Harness applies to an Ollama it starts itself are in effect.
   * @param {{ running: boolean }} o whether an Ollama server is reachable right now
   */
  protections({ running }) {
    const s = this.getSettings();
    const wanted = managedOllamaEnv(s, { baseUrl: this.getProvider().baseUrl, totalMem: this.totalMem });
    const list = Object.entries(wanted).filter(([k]) => PROTECTION_LABELS[k]).map(([k, v]) => PROTECTION_LABELS[k](v));
    if (this.managed) return { inEffect: true, env: this.env, wanted, message: `Harness started this Ollama with: ${list.join(', ')}.` };
    if (!running) return { inEffect: false, env: null, wanted, message: `Ollama is not running; when Harness starts it, it applies: ${list.join(', ')}.` };
    return {
      inEffect: false, env: null, wanted, external: true,
      message: `This Ollama was not started by Harness, so its memory protections are not in effect (${list.join(', ')}). To get them, quit the other Ollama (menu bar → Quit Ollama, or stop \`ollama serve\`) and restart Harness so it starts its own.`,
    };
  }

  info() {
    const s = this.getSettings();
    const binaryPath = findOllamaBinary(s.ollama?.binaryPath);
    return {
      installed: !!binaryPath,
      binaryPath,
      managed: this.managed,
      pid: this.child?.pid ?? null,
      env: this.env,
      address: this._childAlive() ? this.childAddr : null,
      sandboxed: this._childAlive() ? this.sandboxed : false,
      osFallback: this.osFallback,
      recommendedEnv: managedOllamaEnv(s, { baseUrl: this.getProvider().baseUrl, totalMem: this.totalMem }),
      lastError: this.lastError,
      logTail: this.logTail.slice(-20),
    };
  }

  /**
   * Start `ollama serve` for the provider's CURRENT address. One start at a time: a call that arrives while another
   * runs waits for it and then decides again (it never gets the result of a start for another address).
   */
  async start({ timeoutMs } = {}) {
    while (this.starting) await this.starting.catch(() => {});
    if (this.closed) return { started: false, error: 'Harness is shutting down.', code: 'closed' };
    const p = this._start(timeoutMs);
    this.starting = p;
    try { return await p; } finally { if (this.starting === p) { this.starting = null; this._setPhase(null); } }
  }

  async _start(timeoutMs) {
    // the address is decided once, here: a settings change during this start is handled by the next start()
    const provider = this.getProvider();
    const baseUrl = provider.baseUrl;
    const addr = addrKey(baseUrl);
    if (!isLoopbackHost(new URL(baseUrl).hostname)) {
      this.lastError = 'Harness starts Ollama only on this Mac (loopback); the configured Ollama address is another computer.';
      return { started: false, error: this.lastError, code: 'not_loopback' };
    }
    // Our own Ollama is running: never spawn a second one onto its port.
    if (this._childAlive()) {
      if (this.childAddr === addr) {
        for (let i = 0; i < 10; i++) {
          const p = await probeOllama(baseUrl);
          if (p.state === 'ollama') return { started: false, alreadyRunning: true, managed: true, pid: this.child.pid, version: p.version, sandboxed: this.sandboxed };
          await sleep(500);
          if (!this._childAlive()) break;
        }
        if (this._childAlive()) {
          this.lastError = 'The Ollama that Harness started does not answer.';
          return { started: false, error: this.lastError, code: 'not_responding', managed: true };
        }
      } else {
        log.info(`Moving the Ollama Harness started from ${this.childAddr} to ${addr}`);
        await this.stop();
      }
    }
    // Probe before spawning: refused = nobody there (start ours); a timeout or a non-Ollama answer = somebody is.
    let probe = null;
    for (let i = 0; i < 3; i++) {
      probe = await probeOllama(baseUrl);
      if (probe.state === 'free' || probe.state === 'ollama') break;
      await sleep(700);
    }
    if (probe.state === 'ollama') { this.external = true; return { started: false, alreadyRunning: true, managed: false, version: probe.version }; }
    if (probe.state !== 'free') {
      this.lastError = probe.state === 'port_in_use'
        ? `Something that is not Ollama uses ${addr}; Harness does not start Ollama there.`
        : `Something listens on ${addr} but does not answer (a busy Ollama?); Harness does not start another one there.`;
      return { started: false, error: this.lastError, code: probe.state, detail: probe.detail || null };
    }
    this.external = false;
    const s = this.getSettings();
    const bin = findOllamaBinary(s.ollama?.binaryPath);
    if (!bin) {
      this.lastError = 'Ollama is not installed (binary not found).';
      return { started: false, error: this.lastError, code: 'not_installed' };
    }
    this.env = managedOllamaEnv(s, { baseUrl, totalMem: this.totalMem });
    const sandboxed = this._useSandbox();
    const r = await this._spawn(bin, baseUrl, timeoutMs, sandboxed);
    if (r.started || !sandboxed) return r;
    // Not the sandbox's fault: Ollama could not bind (address in use), or it listened but its GPU discovery did not
    // finish (another app busy on the GPU) — report the error, no fallback.
    if (r.code === 'port_in_use' || r.code === 'gpu_discovery_timeout') return r;
    // Evidence candidates: the sandboxed child exited (not a bind error), it never got to listening, or sandbox-exec
    // could not run: try once without. Only if THAT works does it count against the sandbox.
    const r2 = await this._spawn(bin, baseUrl, timeoutMs, false);
    if (!r2.started) return r2;
    const reason = r.code === 'spawn_failed' ? 'sandbox_unavailable' : r.code === 'not_listening' ? 'sandboxed_not_listening' : 'sandboxed_exit';
    this.sandboxFailures += 1;
    const detail = [r.error, ...(r.logTail || []).slice(-3)].filter(Boolean).join(' | ').slice(0, 600);
    this.osFallback = { at: new Date().toISOString(), reason, detail, count: this.sandboxFailures };
    log.warn(`Started Ollama OUTSIDE the offline-lock sandbox (${reason}; failure ${this.sandboxFailures} of ${MAX_SANDBOX_FAILURES}): ${detail || 'no output'}. The in-app blocker still applies; ${this.sandboxBroken ? 'the sandbox is not tried again until Harness restarts' : 'Harness tries the sandbox again when nothing is running'}.`);
    return { ...r2, osFallback: this.osFallback };
  }

  async _spawn(bin, baseUrl, timeoutMs, sandboxed) {
    if (this.closed) return { started: false, error: 'Harness is shutting down.', code: 'closed' };
    if (this._childAlive()) return { started: false, error: 'Harness already runs an Ollama.', code: 'already_managed' };
    log.info(`Starting ${bin} serve${sandboxed ? ' (offline-lock sandbox)' : ''}`, this.env);
    const own = []; // this child's output (bind failures are recognised from it)
    let child;
    try {
      const [cmd, args] = sandboxed ? [this.sandboxExec, ['-f', this.profile, bin, 'serve']] : [bin, ['serve']];
      child = spawn(cmd, args, { env: { ...process.env, ...this.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    } catch (e) {
      this.lastError = `Could not start ${bin}: ${e.message}`;
      return { started: false, error: this.lastError, code: 'spawn_failed' };
    }
    // Attach the error listener before anything else: a spawn ENOENT/EACCES must never become an uncaught error.
    let spawnError = null;
    child.on('error', (e) => { spawnError = `Could not start ${sandboxed ? this.sandboxExec : bin}: ${e.code || e.message}`; this.lastError = spawnError; });
    this.child = child;
    this.childAddr = addrKey(baseUrl);
    this.sandboxed = sandboxed;
    const onData = (d) => {
      for (const line of String(d).split('\n')) {
        if (!line.trim()) continue;
        this.logTail.push(line.slice(0, 500));
        if (own.length < 200) own.push(line.slice(0, 500));
      }
      if (this.logTail.length > 200) this.logTail.splice(0, this.logTail.length - 200);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.childAddr = null;
        this.sandboxed = false;
        this.bus?.publish('ollama.status', { managed: false, running: false, exitCode: code, signal });
      }
    });
    const t0 = Date.now();
    const listenBy = t0 + listenTimeout(timeoutMs);
    let readyBy = null; // set once it listens
    let listening = false;
    this._setPhase('starting');
    const alive = () => !spawnError && this.child === child && child.exitCode === null && child.signalCode === null;
    for (;;) {
      await sleep(200);
      if (!alive()) break;
      const p = await probeOllama(baseUrl, { timeoutMs: 1500 });
      if (p.state === 'ollama') {
        this.lastError = null;
        this.bus?.publish('ollama.status', { managed: true, running: true, version: p.version, pid: child.pid, sandboxed });
        return { started: true, managed: true, pid: child.pid, version: p.version, env: this.env, sandboxed, startMs: Date.now() - t0 };
      }
      if (!listening && (p.state !== 'free' || own.some((l) => LISTENING_LINE.test(l)))) {
        listening = true;
        readyBy = Date.now() + readyTimeout();
        this._setPhase('waiting_for_gpu');
      }
      if (!listening && Date.now() > listenBy) break;
      if (listening && Date.now() > readyBy) break;
    }
    await sleep(50); // the last output of an exited child
    const lines = own;
    const exited = !alive();
    if (this.child === child) await this.stop();
    if (spawnError) return { started: false, error: spawnError, code: 'spawn_failed' };
    if (exited && lines.some((l) => BIND_FAILURE.test(l))) {
      this.lastError = `Ollama could not use ${addrKey(baseUrl)}: ${lines.find((l) => BIND_FAILURE.test(l)).slice(0, 200)}`;
      return { started: false, error: this.lastError, code: 'port_in_use', logTail: lines.slice(-20) };
    }
    if (exited) {
      this.lastError = `Ollama exited during start-up.${lines.length ? ` Last log line: ${lines.at(-1)}` : ''}`;
      return { started: false, error: this.lastError, code: 'exited', logTail: lines.slice(-20) };
    }
    if (!listening) {
      this.lastError = `Ollama did not start: it was not listening on ${addrKey(baseUrl)} after ${Math.round(listenTimeout(timeoutMs) / 1000)} s.`;
      return { started: false, error: this.lastError, code: 'not_listening', logTail: lines.slice(-20) };
    }
    this.lastError = `Ollama did not finish starting: it was still looking for the GPU after ${Math.round(readyTimeout() / 1000)} s — is another app using the GPU heavily?`;
    return { started: false, error: this.lastError, code: 'gpu_discovery_timeout', logTail: lines.slice(-20) };
  }

  /** Harness is quitting: no start after this one; stop ours if `stop`. */
  async shutdown({ stop = true } = {}) {
    this.closed = true;
    while (this.starting) await this.starting.catch(() => {});
    if (stop) await this.stop();
  }

  async stop() {
    const child = this.child;
    if (!child) return { stopped: false, managed: false };
    this.child = null;
    this.childAddr = null;
    this.sandboxed = false;
    if (child.exitCode === null && child.signalCode === null) {
      const exitedP = new Promise((r) => child.once('exit', () => r(true)));
      child.kill('SIGTERM');
      const exited = await Promise.race([exitedP, sleep(5000).then(() => false)]);
      if (!exited) child.kill('SIGKILL');
    }
    this.bus?.publish('ollama.status', { managed: false, running: false });
    return { stopped: true };
  }
}
