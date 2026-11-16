// Provider management, Ollama process control, model management (list/pull/delete/load/unload), embeddings.
import { HttpError, badRequest, notFound } from '../lib/errors.mjs';
import { openSse, readJson } from '../http/http.mjs';
import { newId } from '../lib/ids.mjs';
import { RECOMMENDED_MODELS, RECOMMENDED_EMBEDDING, profileFor } from '../providers/catalog.mjs';
import { computeContextPlan, budgetsFor, memoryBudget, ramTier } from '../context/sizing.mjs';
import { qBool, created, requireString } from './common.mjs';

function modelParams(query) {
  const model = query.get('model');
  if (!model) throw badRequest('model query parameter is required');
  return { model, providerId: query.get('providerId') || null };
}

export function registerModelRoutes(r, app) {
  // ---- providers ------------------------------------------------------------------------------
  r.get('/api/providers', async ({ query }) => ({ providers: await app.registry.listStatus({ refresh: qBool(query.get('refresh')) }) }));

  r.post('/api/providers/refresh', async () => {
    app.registry.invalidate();
    return { providers: await app.registry.listStatus({ refresh: true }) };
  });

  r.post('/api/providers', async ({ req }) => {
    const body = await readJson(req);
    const name = requireString(body.name, 'name', { max: 100 });
    const kind = body.kind === 'ollama' ? 'ollama' : body.kind === 'openai' ? 'openai' : null;
    if (!kind) throw badRequest("kind must be 'ollama' or 'openai'");
    const baseUrl = requireString(body.baseUrl, 'baseUrl', { max: 500 });
    const s = app.settings.get();
    const entry = { id: newId('prov'), name, kind, baseUrl, apiKey: typeof body.apiKey === 'string' ? body.apiKey : '', enabled: body.enabled !== false };
    await app.settings.patch({ providers: { custom: [...(s.providers.custom || []), entry] } });
    app.registry.sync();
    const list = await app.registry.listStatus({ refresh: true });
    return created({ provider: list.find((p) => p.id === entry.id) || { ...entry, status: 'disabled' } });
  });

  r.patch('/api/providers/:id', async ({ req, params }) => {
    const body = await readJson(req);
    const s = app.settings.get();
    if (['ollama', 'llamacpp', 'lmstudio'].includes(params.id)) {
      const patch = {};
      if (body.baseUrl !== undefined) patch.baseUrl = body.baseUrl;
      if (body.enabled !== undefined) patch.enabled = !!body.enabled;
      await app.settings.patch({ providers: { builtin: { [params.id]: patch } } });
    } else {
      const list = s.providers.custom || [];
      const i = list.findIndex((p) => p.id === params.id);
      if (i < 0) throw notFound('Provider');
      const next = list.map((p, j) => (j === i ? { ...p, ...Object.fromEntries(Object.entries(body).filter(([k]) => ['name', 'baseUrl', 'apiKey', 'enabled', 'kind'].includes(k))) } : p));
      await app.settings.patch({ providers: { custom: next } });
    }
    app.registry.sync();
    app.registry.invalidate();
    return { providers: await app.registry.listStatus({ refresh: true }) };
  });

  r.delete('/api/providers/:id', async ({ params }) => {
    const s = app.settings.get();
    const list = s.providers.custom || [];
    if (!list.some((p) => p.id === params.id)) throw new HttpError(400, 'bad_request', 'Only custom providers can be deleted (disable built-ins with PATCH {enabled:false})');
    await app.settings.patch({ providers: { custom: list.filter((p) => p.id !== params.id) } });
    app.registry.sync();
    return { ok: true };
  });

  r.post('/api/providers/ollama/start', async () => {
    const res = await app.ollamaProcess.start();
    app.registry.invalidate();
    if (res.error) throw new HttpError(res.code === 'not_installed' ? 404 : 500, res.code, res.error, { logTail: res.logTail });
    return res;
  });

  r.post('/api/providers/ollama/stop', async () => {
    const res = await app.ollamaProcess.stop();
    app.registry.invalidate();
    return res;
  });

  // ---- models ----------------------------------------------------------------------------------
  r.get('/api/models', async ({ query }) => {
    const models = await app.registry.listModels({ refresh: qBool(query.get('refresh')) });
    const loaded = new Set();
    for (const p of app.registry.all()) {
      const st = await app.registry.status(p);
      if (!st.ok) continue;
      for (const m of await p.ps().catch(() => [])) loaded.add(`${p.id}|${m.model}`);
    }
    const details = qBool(query.get('details'));
    const out = [];
    for (const m of models) {
      const entry = { ...m, loaded: loaded.has(`${m.providerId}|${m.model}`) };
      if (details) {
        try {
          const info = await app.registry.modelInfo(app.registry.get(m.providerId), m.model);
          entry.capabilities = info.capabilities;
          entry.contextLength = info.contextLength;
        } catch { entry.capabilities = null; }
      }
      out.push(entry);
    }
    return { models: out, defaultModel: await app.registry.defaultChatModel().catch(() => null) };
  });

  r.get('/api/models/loaded', async () => {
    const out = [];
    for (const p of app.registry.all()) {
      const st = await app.registry.status(p);
      if (!st.ok) continue;
      for (const m of await p.ps().catch(() => [])) out.push({ providerId: p.id, ...m });
    }
    return { models: out, modelState: app.modelState.status() };
  });

  r.get('/api/models/info', async ({ query }) => {
    const ref = modelParams(query);
    const { provider, model } = await app.registry.resolve(ref);
    const info = await app.registry.modelInfo(provider, model, { refresh: qBool(query.get('refresh')) });
    const s = app.engine.globalEffectiveSettings();
    const plan = await app.registry.contextPlan(provider, model, s, { info });
    const { arch, ...rest } = info;
    const effective = {};
    for (const [k, v] of Object.entries(info.profile?.sampling || {})) if (info.modelfileParameters?.[k] === undefined) effective[k] = v;
    return { info: { ...rest, arch }, contextPlan: plan, budgets: budgetsFor(plan.numCtx, s), suggestedParams: effective };
  });

  r.get('/api/models/context', async ({ query }) => {
    const ref = modelParams(query);
    const { provider, model } = await app.registry.resolve(ref);
    const s = app.engine.globalEffectiveSettings();
    const modeQ = query.get('mode');
    const mode = modeQ ? (/^\d+$/.test(modeQ) ? Number(modeQ) : modeQ) : undefined;
    if (mode !== undefined && !['auto', 'max'].includes(mode) && typeof mode !== 'number') throw badRequest("mode must be 'auto', 'max' or a number");
    const plan = await app.registry.contextPlan(provider, model, s, { modeOverride: mode });
    return { contextPlan: plan, budgets: budgetsFor(plan.numCtx, s) };
  });

  r.get('/api/models/recommended', async () => {
    const sys = app.system;
    const installed = await app.registry.listModels().catch(() => []);
    const kv = app.registry.kvCacheType(app.settings.get());
    const budget = memoryBudget({ totalMem: sys.totalMem, platform: sys.platform, arch: sys.arch, memoryFraction: app.settings.get().context?.memoryFraction });
    const models = RECOMMENDED_MODELS.map((rec) => {
      const profile = profileFor(rec.variants[0].model, rec.family);
      const variants = rec.variants.map((v) => {
        const plan = computeContextPlan({ providerKind: 'ollama', modelMax: rec.contextLength, modelMaxSource: 'catalog', modelBytes: v.approxSizeBytes, arch: rec.archHint || {}, profile, mode: 'auto', system: sys, kvCacheType: kv, lowRamCap: app.settings.get().context?.lowRamCap ?? null, memoryFraction: app.settings.get().context?.memoryFraction ?? null });
        const hit = installed.find((m) => m.model === v.model || (v.model.includes(':') ? false : m.model.startsWith(`${v.model}:`)));
        return { ...v, installed: !!hit, providerId: hit?.providerId || null, estimate: { numCtx: plan.numCtx, estimatedTotalBytes: plan.memory.estimatedTotalBytes, fits: plan.fits && !plan.warnings.some((w) => w.code === 'model_exceeds_budget'), limitedBy: plan.limitedBy, explanation: plan.explanation } };
      });
      // Suggest the largest variant that fits with a useful window (≥ 8K, else ≥ 4K, else smallest).
      const pick = variants.find((v) => v.estimate.fits && v.estimate.numCtx >= 8192) || variants.find((v) => v.estimate.fits && v.estimate.numCtx >= 4096) || variants[variants.length - 1];
      const { archHint, ...pub } = rec;
      return { ...pub, variants, suggestedVariant: pick.model, installed: variants.some((v) => v.installed), fitsThisMachine: !!pick.estimate.fits };
    });
    return {
      machine: { totalMemBytes: sys.totalMem, ramTier: ramTier(sys.totalMem), budgetBytes: budget.budgetBytes, kvCacheType: kv },
      models,
      embedding: RECOMMENDED_EMBEDDING.map((e) => ({ ...e, installed: installed.some((m) => m.model.split(':')[0] === e.model) })),
      note: 'Sizes are approximate and the fit estimate uses architecture hints until the model is installed.',
    };
  });

  r.post('/api/models/pull', async ({ req, res }) => {
    const body = await readJson(req);
    const model = requireString(body.model, 'model', { max: 300 });
    const provider = app.registry.require(body.providerId || 'ollama');
    if (!provider.capabilities.pull) throw new HttpError(400, 'unsupported', `${provider.name} does not support pulling models`);
    const st = await app.registry.status(provider, { refresh: true });
    if (!st.ok) throw new HttpError(503, 'connection_failed', `${provider.name} is not running`);
    const sse = openSse(req, res);
    const pullId = newId('pull');
    sse.send('start', { pullId, providerId: provider.id, model });
    app.bus.publish('model.pull', { pullId, providerId: provider.id, model, status: 'started' });
    let last = 0;
    try {
      for await (const p of provider.pull({ model, signal: sse.signal })) {
        const percent = p.total ? Math.round((p.completed / p.total) * 1000) / 10 : null;
        sse.send('progress', { pullId, ...p, percent });
        if (Date.now() - last > 500) { last = Date.now(); app.bus.publish('model.pull', { pullId, providerId: provider.id, model, ...p, percent }); }
      }
      app.registry.dropInfo(provider.id, model);
      app.registry.invalidate();
      app.bus.publish('model.pull', { pullId, providerId: provider.id, model, status: 'success' });
      sse.send('done', { pullId, providerId: provider.id, model, status: 'success' });
    } catch (e) {
      const aborted = sse.signal.aborted;
      app.bus.publish('model.pull', { pullId, providerId: provider.id, model, status: aborted ? 'aborted' : 'error', error: e.message });
      sse.send('error', { pullId, code: aborted ? 'aborted' : e.code || 'pull_failed', message: e.message });
    } finally {
      sse.end();
    }
  });

  r.delete('/api/models', async ({ query }) => {
    const ref = modelParams(query);
    const provider = app.registry.require(ref.providerId || 'ollama');
    if (!provider.capabilities.delete) throw new HttpError(400, 'unsupported', `${provider.name} does not support deleting models`);
    await provider.deleteModel(ref.model);
    app.registry.dropInfo(provider.id, ref.model);
    app.registry.invalidate();
    app.bus.publish('model.deleted', { providerId: provider.id, model: ref.model });
    return { ok: true };
  });

  r.post('/api/models/unload', async ({ req }) => {
    const body = await readJson(req);
    const provider = app.registry.require(body.providerId || 'ollama');
    if (!provider.capabilities.unload) throw new HttpError(400, 'unsupported', `${provider.name} cannot unload models through its API`);
    await provider.unload(requireString(body.model, 'model'));
    return { ok: true };
  });

  r.post('/api/models/load', async ({ req }) => {
    const body = await readJson(req);
    const { provider, model } = await app.registry.resolve({ providerId: body.providerId, model: requireString(body.model, 'model') });
    if (provider.kind !== 'ollama') throw new HttpError(400, 'unsupported', 'Preloading is only supported for Ollama');
    const s = app.engine.globalEffectiveSettings();
    const plan = await app.registry.contextPlan(provider, model, s);
    await provider.load(model, { keepAlive: s.keepAlive, options: { num_ctx: plan.numCtx } });
    app.engine.loadedCtx.set(`${provider.id}/${model}`, plan.numCtx);
    app.modelState.markReloaded();
    return { ok: true, numCtx: plan.numCtx };
  });

  r.get('/api/models/measurements', async ({ query }) => {
    const ref = modelParams(query);
    const { provider, model } = await app.registry.resolve(ref);
    const info = await app.registry.modelInfo(provider, model).catch(() => null);
    const entry = app.measurements.get(provider.id, model);
    const s = app.engine.globalEffectiveSettings();
    const kvCacheType = app.registry.kvCacheType(s);
    const valid = app.measurements.samplesFor(provider.id, model, { digest: info?.digest, sizeBytes: info?.sizeBytes, kvCacheType });
    const plan = info ? await app.registry.contextPlan(provider, model, s, { info }) : null;
    return {
      providerId: provider.id, model, kvCacheType,
      stale: !!entry && !!info && !app.measurements.matches(entry, { digest: info.digest, sizeBytes: info.sizeBytes }),
      samples: entry?.samples || [], validSamples: valid.length,
      loadedNumCtx: app.engine.loadedCtxFor(provider.id, model),
      measurement: plan?.memory?.measurement || null, basis: plan?.memory?.basis || 'estimate',
    };
  });

  r.delete('/api/models/measurements', async ({ query }) => {
    const ref = modelParams(query);
    const { provider, model } = await app.registry.resolve(ref);
    return { ok: true, removed: app.measurements.reset(provider.id, model) };
  });

  r.get('/api/embeddings/status', async () => app.embedder.status());
}
