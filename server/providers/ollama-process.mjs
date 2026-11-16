// Find and (optionally) spawn `ollama serve` with memory-friendly environment settings.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ramTier } from '../context/sizing.mjs';
import { log } from '../lib/log.mjs';
import { sleep } from '../lib/util.mjs';

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
  const env = {
    OLLAMA_HOST: `${u.hostname}:${u.port || 11434}`,
    OLLAMA_NUM_PARALLEL: String(o.numParallel ?? 1),
  };
  if (o.flashAttention !== false) env.OLLAMA_FLASH_ATTENTION = '1';
  if (o.kvCacheType && o.kvCacheType !== 'f16') env.OLLAMA_KV_CACHE_TYPE = o.kvCacheType;
  const maxLoaded = o.maxLoadedModels === 'auto' || o.maxLoadedModels == null ? (ramTier(totalMem) === 'low' ? 1 : null) : o.maxLoadedModels;
  if (maxLoaded) env.OLLAMA_MAX_LOADED_MODELS = String(maxLoaded);
  for (const [k, v] of Object.entries(o.extraEnv || {})) if (/^OLLAMA_[A-Z_]+$/.test(k)) env[k] = String(v);
  return env;
}

export class OllamaProcess {
  constructor({ getSettings, getProvider, bus, totalMem }) {
    this.getSettings = getSettings;
    this.getProvider = getProvider;
    this.bus = bus;
    this.totalMem = totalMem;
    this.child = null;
    this.env = null;
    this.logTail = [];
    this.starting = null;
    this.lastError = null;
  }

  get managed() { return !!this.child; }

  info() {
    const s = this.getSettings();
    const binaryPath = findOllamaBinary(s.ollama?.binaryPath);
    return {
      installed: !!binaryPath,
      binaryPath,
      managed: this.managed,
      pid: this.child?.pid ?? null,
      env: this.env,
      recommendedEnv: managedOllamaEnv(s, { baseUrl: this.getProvider().baseUrl, totalMem: this.totalMem }),
      lastError: this.lastError,
      logTail: this.logTail.slice(-20),
    };
  }

  async start({ timeoutMs = 20000 } = {}) {
    if (this.starting) return this.starting;
    this.starting = this._start(timeoutMs).finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start(timeoutMs) {
    const provider = this.getProvider();
    const st = await provider.status();
    if (st.ok) return { started: false, alreadyRunning: true, managed: this.managed, version: st.version };
    const s = this.getSettings();
    const bin = findOllamaBinary(s.ollama?.binaryPath);
    if (!bin) {
      this.lastError = 'Ollama is not installed (binary not found).';
      return { started: false, error: this.lastError, code: 'not_installed' };
    }
    this.env = managedOllamaEnv(s, { baseUrl: provider.baseUrl, totalMem: this.totalMem });
    log.info(`Starting ${bin} serve`, this.env);
    let child;
    try {
      child = spawn(bin, ['serve'], { env: { ...process.env, ...this.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    } catch (e) {
      this.lastError = `Could not start ${bin}: ${e.message}`;
      return { started: false, error: this.lastError, code: 'spawn_failed' };
    }
    // Attach the error listener before anything else: a spawn ENOENT/EACCES must never become an uncaught error.
    let spawnError = null;
    child.on('error', (e) => { spawnError = `Could not start ${bin}: ${e.code || e.message}`; this.lastError = spawnError; if (this.child === child) this.child = null; });
    this.child = child;
    const onData = (d) => {
      for (const line of String(d).split('\n')) if (line.trim()) this.logTail.push(line.slice(0, 500));
      if (this.logTail.length > 200) this.logTail.splice(0, this.logTail.length - 200);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.bus?.publish('ollama.status', { managed: false, running: false, exitCode: code, signal });
      }
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(200);
      if (!this.child) break;
      const s2 = await provider.status();
      if (s2.ok) {
        this.lastError = null;
        this.bus?.publish('ollama.status', { managed: true, running: true, version: s2.version, pid: child.pid });
        return { started: true, managed: true, pid: child.pid, version: s2.version, env: this.env };
      }
    }
    if (spawnError) return { started: false, error: spawnError, code: 'spawn_failed' };
    this.lastError = this.child ? 'Ollama did not become ready in time.' : `Ollama exited during start-up.${this.logTail.length ? ` Last log line: ${this.logTail.at(-1)}` : ''}`;
    await this.stop();
    return { started: false, error: this.lastError, code: 'start_timeout', logTail: this.logTail.slice(-20) };
  }

  async stop() {
    const child = this.child;
    if (!child) return { stopped: false, managed: false };
    this.child = null;
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
