// Application wiring: stores, providers, engines. One `app` object is shared by all routes.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureDir, flushWrites } from './lib/fsx.mjs';
import { EventBus } from './lib/bus.mjs';
import { SettingsStore } from './store/settings.mjs';
import { PresetStore } from './store/presets.mjs';
import { ChatStore } from './store/chats.mjs';
import { AttachmentStore } from './store/attachments.mjs';
import { Calibrator } from './context/tokens.mjs';
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
import { log } from './lib/log.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..');

export const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
})();

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
export async function createApp({ dataDir, system: sysOverrides = {}, autodetect = true, publicDir } = {}) {
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
    url: null,
  };
  app.settings = await new SettingsStore(dataDir, bus).load();
  app.presets = await new PresetStore(dataDir, bus).load();
  app.calibrator = await new Calibrator(dataDir).load();
  app.ollamaProcess = new OllamaProcess({ getSettings: () => app.settings.get(), getProvider: () => app.registry.ollama() || { baseUrl: 'http://127.0.0.1:11434', status: async () => ({ ok: false }) }, bus, totalMem: app.system.totalMem });
  app.registry = new ProviderRegistry({ settings: app.settings, bus, system: app.system, autodetect, ollamaProcess: app.ollamaProcess });
  app.embedder = new Embedder({ registry: app.registry, settings: app.settings, system: app.system });
  app.chats = await new ChatStore(dataDir, bus).load();
  app.memories = await new MemoryStore({ dataDir, embedder: app.embedder, bus }).load();
  app.attachments = await new AttachmentStore({ dataDir, embedder: app.embedder, bus, settings: app.settings }).load();
  app.recall = await new RecallIndex({ dataDir, embedder: app.embedder, chats: app.chats }).load();
  app.gallery = await new Gallery({ dataDir, bus }).load();
  app.imageProviders = new ImageProviderRegistry({ settings: app.settings, bus, autodetect });
  app.modelState = new ModelState(app);
  app.engine = new ChatEngine(app);
  app.llm = new LLM(app);
  app.images = new ImageService(app);
  app.background = new BackgroundQueue(app);

  app.close = async () => {
    app.background.stop();
    for (const g of app.engine.active.values()) g.controller.abort();
    await app.chats.flush();
    await Promise.allSettled([app.calibrator.save(), app.memories.index.save(), app.recall.index.save(), app.attachments.docIndex.save()]);
    if (app.settings.get().ollama?.stopOnExit !== false) await app.ollamaProcess.stop().catch(() => {});
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
