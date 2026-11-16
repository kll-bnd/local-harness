// Health, system info, global event stream, settings and presets.
import os from 'node:os';
import { openSse, readJson } from '../http/http.mjs';
import { DEFAULT_SETTINGS } from '../store/settings.mjs';
import { memoryBudget, ramTier } from '../context/sizing.mjs';
import { created } from './common.mjs';

export function registerSystemRoutes(r, app) {
  r.get('/api/health', () => ({ ok: true, name: 'harness', version: app.version }));

  r.get('/api/system', async ({ query }) => {
    const refresh = query.get('refresh') === '1';
    const [providers, imageProviders, embeddings] = await Promise.all([
      app.registry.listStatus({ refresh }),
      app.imageProviders.listStatus({ refresh }),
      app.embedder.status(),
    ]);
    const loaded = [];
    for (const p of app.registry.all()) {
      const st = await app.registry.status(p);
      if (!st.ok) continue;
      for (const m of await p.ps().catch(() => [])) loaded.push({ providerId: p.id, ...m });
    }
    const sys = app.system;
    return {
      app: { name: 'harness', version: app.version, node: process.version, pid: process.pid, dataDir: app.dataDir, startedAt: app.startedAt, uptimeSec: Math.round((Date.now() - Date.parse(app.startedAt)) / 1000), url: app.url || null },
      machine: {
        platform: sys.platform, arch: sys.arch, release: os.release(), chip: sys.chip, cpus: sys.cpus, appleSilicon: sys.platform === 'darwin' && sys.arch === 'arm64',
        totalMemBytes: sys.totalMem, freeMemBytes: os.freemem(), ramTier: ramTier(sys.totalMem), memoryBudget: memoryBudget({ totalMem: sys.totalMem, platform: sys.platform, arch: sys.arch, memoryFraction: app.settings.get().context?.memoryFraction }),
      },
      providers,
      loadedModels: loaded,
      ollama: { ...app.ollamaProcess.info(), protections: app.ollamaProcess.protections({ running: !!providers.find((x) => x.id === 'ollama' && x.status === 'running') }) },
      imageProviders,
      embeddings,
      modelState: app.modelState.status(),
      background: app.background.status(),
      generations: [...app.engine.active.entries()].map(([chatId, g]) => ({ chatId, generationId: g.generationId, assistantMessageId: g.assistantMessageId, startedAt: g.startedAt })),
      imageJobs: { active: app.images.active, recent: app.images.listJobs().slice(0, 5) },
    };
  });

  r.get('/api/events', ({ req, res }) => {
    const sse = openSse(req, res);
    sse.send('hello', { version: app.version, time: new Date().toISOString() });
    const onEvent = (ev) => sse.send(ev.type, { ...ev.data, ts: ev.ts });
    app.bus.on('event', onEvent);
    sse.signal.addEventListener('abort', () => app.bus.off('event', onEvent));
  });

  // ---- settings
  r.get('/api/settings', () => ({ settings: app.settings.get(), defaults: DEFAULT_SETTINGS }));
  r.patch('/api/settings', async ({ req }) => {
    const body = await readJson(req);
    const settings = await app.settings.patch(body);
    app.registry.sync();
    app.imageProviders.sync();
    return { settings };
  });
  r.post('/api/settings/reset', async () => ({ settings: await app.settings.reset() }));

  // ---- presets
  r.get('/api/presets', () => ({ presets: app.presets.list() }));
  r.post('/api/presets', async ({ req }) => created({ preset: await app.presets.create(await readJson(req)) }));
  r.patch('/api/presets/:id', async ({ req, params }) => ({ preset: await app.presets.update(params.id, await readJson(req)) }));
  r.delete('/api/presets/:id', async ({ params }) => { await app.presets.delete(params.id); return { ok: true }; });
}
