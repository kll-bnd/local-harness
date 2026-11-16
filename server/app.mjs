// Application wiring: stores, providers, engines. One `app` object is shared by all routes.
import os from 'node:os';
import path from 'node:path';
import { ensureDir, flushWrites } from './lib/fsx.mjs';
import { EventBus } from './lib/bus.mjs';
import { SettingsStore } from './store/settings.mjs';
import { PresetStore } from './store/presets.mjs';
import { ChatStore } from './store/chats.mjs';
import { AttachmentStore } from './store/attachments.mjs';
import { Calibrator } from './context/tokens.mjs';
import { MeasurementStore } from './context/measurements.mjs';
import { LoadFailures } from './providers/load-failure.mjs';
import { createMemoryProbe } from './system/memory-probe.mjs';
import { ModelCopies } from './providers/text-only.mjs';
import { ProviderRegistry } from './providers/registry.mjs';
import { OllamaProcess } from './providers/ollama-process.mjs';
import { Embedder } from './memory/embedder.mjs';
import { MemoryStore } from './memory/memories.mjs';
import { RecallIndex } from './memory/recall.mjs';
import { ChatEngine } from './chat/engine.mjs';
import { LLM } from './chat/llm.mjs';
import { BackgroundQueue, ModelState } from './chat/background.mjs';
import { ImageProviderRegistry } from './image/registry.mjs';
import { ImageService } from './image/service.mjs';
import { Gallery } from './image/gallery.mjs';
import { RamLease } from './image/ram-lease.mjs';
import { log } from './lib/log.mjs';
import { UiStateStore } from './store/ui-state.mjs';

export { ROOT_DIR, VERSION } from './version.mjs';
import { ROOT_DIR, VERSION } from './version.mjs';

export function defaultDataDir() {
  if (process.env.HARNESS_DATA_DIR) return path.resolve(process.env.HARNESS_DATA_DIR);
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Harness');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Harness');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'harness');
}

export function detectSystem(overrides = {}) {
  const cpus = os.cpus();
  const envMem = Number(process.env.HARNESS_TOTALMEM_BYTES) || null;
  return {
    platform: overrides.platform || process.platform,
    arch: overrides.arch || process.arch,
    totalMem: overrides.totalMem || envMem || os.totalmem(),
    cpus: cpus.length,
    chip: overrides.chip || cpus[0]?.model?.trim() || 'unknown',
  };
}

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {object} [o.system] overrides for platform/arch/totalMem (tests)
 * @param {boolean} [o.autodetect] probe default ports for llama.cpp/LM Studio/Draw Things/ComfyUI
 */
export async function createApp({ dataDir, system: sysOverrides = {}, autodetect = true, publicDir, ollamaProcess = null, network = null, core = null } = {}) {
  dataDir = path.resolve(dataDir || defaultDataDir());
  await ensureDir(dataDir);
  await ensureDir(path.join(dataDir, 'index'));
  const bus = new EventBus();
  const app = {
    version: VERSION,
    dataDir,
    publicDir: publicDir || path.join(ROOT_DIR, 'public'),
    startedAt: new Date().toISOString(),
    system: detectSystem(sysOverrides),
    bus,
    foreground: 0,
    url: core?.url || null,
    port: core?.port ?? null,
    core,
    network,
    transport: core?.transport || 'listener',
  };
  app.settings = await new SettingsStore(dataDir, bus).load();
  app.presets = await new PresetStore(dataDir, bus).load();
  app.calibrator = await new Calibrator(dataDir).load();
  app.measurements = await new MeasurementStore(dataDir, bus).load();
  // What the machine really experiences (runner RSS, swap/compressor growth) — macOS only; tests inject a fake.
  app.memoryProbe = sysOverrides && 'memoryProbe' in sysOverrides ? sysOverrides.memoryProbe : createMemoryProbe({ platform: app.system.platform });
  // Shared with the core when given (it outlives lock/unlock); otherwise this app owns it.
  app.ollamaProcess = ollamaProcess || new OllamaProcess({ getSettings: () => app.settings.get(), getProvider: () => app.registry.ollama() || { baseUrl: 'http://127.0.0.1:11434', status: async () => ({ ok: false }) }, bus, totalMem: app.system.totalMem });
  app.registry = new ProviderRegistry({ settings: app.settings, bus, system: app.system, autodetect, ollamaProcess: app.ollamaProcess });
  app.registry.measurements = app.measurements;
  app.embedder = new Embedder({ registry: app.registry, settings: app.settings, system: app.system });
  app.chats = await new ChatStore(dataDir, bus).load();
  app.memories = await new MemoryStore({ dataDir, embedder: app.embedder, bus }).load();
  app.attachments = await new AttachmentStore({ dataDir, embedder: app.embedder, bus, settings: app.settings }).load();
  app.recall = await new RecallIndex({ dataDir, embedder: app.embedder, chats: app.chats }).load();
  app.gallery = await new Gallery({ dataDir, bus }).load();
  app.imageProviders = new ImageProviderRegistry({ settings: app.settings, bus, autodetect });
  app.modelState = new ModelState(app);
  app.loadFailures = new LoadFailures();
  app.modelCopies = await new ModelCopies(dataDir).load();
  app.engine = new ChatEngine(app);
  app.registry.loadedCtxFor = (providerId, model) => app.engine.loadedCtxFor(providerId, model);
  app.llm = new LLM(app);
  app.images = new ImageService(app);
  app.background = new BackgroundQueue(app);
  app.ram = new RamLease(app);
  app.uiState = await new UiStateStore(dataDir).load();
  app.pulls = new Set();

  /**
   * Close the stores. `lock: true` (Harness is locking): abort what runs (partial replies kept), unload the models
   * Harness loaded into Ollama, end event streams — but leave a managed Ollama running. Otherwise (shutdown) a
   * managed Ollama is stopped when settings say so.
   */
  app.close = async ({ lock = false, stopOllama = !lock } = {}) => {
    app.closing = true;
    app.background.stop();
    for (const p of app.pulls) p.abort();
    for (const g of app.engine.active.values()) g.controller.abort();
    for (const j of app.images.jobs?.values?.() || []) if (!['done', 'error', 'aborted'].includes(j.status)) j._controller?.abort();
    // give aborted turns a moment to store their partial replies
    const t0 = Date.now();
    while ((app.engine.active.size || app.images.active) && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 25));
    if (lock) {
      // Unload what Harness loaded: everything in an Ollama Harness started; in another Ollama, the models Harness used.
      const ollama = app.registry.ollama();
      if (ollama) {
        const used = new Set([...(ollama.usedModels || []), ...[...app.engine.loadedCtx.keys()].filter((k) => k.startsWith(`${ollama.id}/`)).map((k) => k.slice(ollama.id.length + 1))]);
        const ps = await Promise.race([ollama.ps().catch(() => []), new Promise((r) => setTimeout(() => r([]), 3000))]);
        const loaded = ps.map((m) => m.model || m.name).filter((m) => app.ollamaProcess.managed || used.has(m));
        await Promise.allSettled(loaded.map((m) => Promise.race([ollama.unload(m), new Promise((r) => setTimeout(r, 5000))])));
        ollama.usedModels?.clear();
      }
    }
    app.bus.publish('server.closing', { reason: lock ? 'locked' : 'shutdown' });
    await app.chats.flush();
    await Promise.allSettled([app.calibrator.save(), app.measurements.save(), app.memories.index.save(), app.recall.index.save(), app.attachments.docIndex.save()]);
    if (stopOllama && !ollamaProcess && app.settings.get().ollama?.stopOnExit !== false) await app.ollamaProcess.stop().catch(() => {});
    await flushWrites();
  };

  // Auto-start Ollama if installed but not running (non-blocking).
  app.startup = (async () => {
    const s = app.settings.get();
    const ollama = app.registry.ollama();
    if (!ollama || s.ollama?.autoStart === false || process.env.HARNESS_NO_OLLAMA_AUTOSTART === '1') return;
    const st = await ollama.status();
    if (st.ok) return;
    const info = app.ollamaProcess.info();
    if (!info.installed) return;
    const r = await app.ollamaProcess.start().catch((e) => ({ error: e.message }));
    if (r.error) log.warn(`Could not auto-start Ollama: ${r.error}`);
    app.registry.invalidate();
  })();
  return app;
}
