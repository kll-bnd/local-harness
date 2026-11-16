// Image generation jobs: parameter resolution, RAM coordination with the chat model (unload before
// generating, lazy/eager reload), progress events, abort, gallery storage.
import { newId } from '../lib/ids.mjs';
import { nowIso, withTimeout, formatBytes, sleep } from '../lib/util.mjs';
import { HttpError, ProviderError, isAbortError } from '../lib/errors.mjs';
import { ramTier } from '../context/sizing.mjs';
import { resolveImageParams, imageFamilyFor } from './defaults.mjs';
import { publicImage } from './gallery.mjs';
import { log } from '../lib/log.mjs';

export class ImageService {
  /** Bounded wait for Ollama to free memory after an unload request. */
  static unloadWaitMs = 20000;

  constructor(app) {
    this.app = app;
    this.jobs = new Map();
    this.tail = Promise.resolve();
    this.active = 0;
  }

  get settings() { return this.app.settings.get(); }

  /** Should the chat model be unloaded before generating? */
  decideUnload({ mode, loaded, familyBytes }) {
    const totalMem = this.app.system.totalMem;
    const loadedBytes = loaded.reduce((a, m) => a + (m.sizeBytes || 0), 0);
    const base = { loadedBytes, imageModelBytes: familyBytes, totalBytes: totalMem, mode };
    if (!loaded.length) return { unload: false, reason: 'nothing_loaded', ...base };
    if (mode === 'never') return { unload: false, reason: 'setting_never', ...base };
    if (mode === 'always') return { unload: true, reason: 'setting_always', ...base };
    if (ramTier(totalMem) === 'low') return { unload: true, reason: 'low_ram', ...base };
    if (loadedBytes + familyBytes > totalMem * 0.7) return { unload: true, reason: 'insufficient_ram', ...base };
    return { unload: false, reason: 'fits', ...base };
  }

  listJobs() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50).map(publicJob);
  }

  cancel(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) throw new HttpError(404, 'not_found', 'Image job not found');
    j._controller?.abort();
    return publicJob(j);
  }

  async _loadInitImage(ref) {
    if (!ref) return null;
    if (ref.attachmentId) {
      const a = this.app.attachments.get(ref.attachmentId);
      if (a.kind !== 'image') throw new HttpError(400, 'bad_request', 'initImage attachment is not an image');
      return { buffer: await this.app.attachments.readOriginal(a.id), mime: a.mime, id: a.id, kind: 'attachment' };
    }
    if (ref.imageId) {
      const r = this.app.gallery.get(ref.imageId);
      return { buffer: await this.app.gallery.read(r.id), mime: r.mime, id: r.id, kind: 'image' };
    }
    throw new HttpError(400, 'bad_request', 'initImage must be {attachmentId} or {imageId}');
  }

  /**
   * Run one generation. `emit(type, data)` receives image_* events. Jobs run one at a time.
   * @returns {Promise<{ job, images }>}
   */
  async generate(req, { signal, emit = () => {}, chatId = null, messageId = null, source = 'user', toolCallId = null, leaseOwner = null } = {}) {
    if (!req?.prompt || !String(req.prompt).trim()) throw new HttpError(400, 'bad_request', 'prompt is required');
    if (this.settings.image?.enabled === false) throw new HttpError(409, 'image_disabled', 'Image generation is disabled in settings');
    const provider = await this.app.imageProviders.resolve(req.providerId);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const job = { id: newId('imgjob'), status: 'queued', createdAt: nowIso(), providerId: provider.id, providerKind: provider.kind, chatId, messageId, toolCallId, source, prompt: String(req.prompt), progress: 0, images: [], warnings: [], error: null, memory: null, _controller: controller };
    this.jobs.set(job.id, job);
    if (this.jobs.size > 200) this.jobs.delete(this.jobs.keys().next().value);
    const publish = (type, data) => {
      emit(type, data);
      if (type !== 'image') this.app.bus.publish(type.replace('_', '.'), data); // gallery publishes image.added
    };
    const run = async () => {
      this.active++;
      this.app.background?.preempt();
      let lease = null;
      try {
        // RAM lease: on low-RAM machines wait (visibly, abortably) until no chat turn / background model work runs.
        lease = await this.app.ram.acquire('image', {
          owner: leaseOwner,
          signal: controller.signal,
          onWait: (w) => { job.status = 'queued'; publish('image_status', { jobId: job.id, phase: 'queued', reason: w.reason, message: w.message }); },
        }).catch((e) => {
          job.status = 'aborted';
          job.error = 'Aborted';
          job.finishedAt = nowIso();
          publish('image_error', { jobId: job.id, code: 'aborted', message: 'Aborted', job: publicJob(job) });
          throw Object.assign(new Error('Image generation aborted'), { name: 'AbortError', cause: e });
        });
        return await this._run(job, provider, req, controller.signal, publish);
      } finally {
        lease?.release();
        this.active--;
        signal?.removeEventListener('abort', onAbort);
        this.app.background?.kick();
      }
    };
    const p = this.tail.then(run, run);
    this.tail = p.catch(() => {});
    publish('image_job', { job: publicJob(job) });
    return p;
  }

  async _run(job, provider, req, signal, publish) {
    const s = this.settings;
    const status = (phase, extra = {}) => { job.status = phase; publish('image_status', { jobId: job.id, phase, ...extra }); };
    try {
      if (signal.aborted) throw signal.reason ?? new Error('Aborted');
      let model = req.model || s.image.model || null;
      let familyName = model;
      if (!familyName) {
        // A1111/Draw Things: the server's current checkpoint; ComfyUI: the default template needs an explicit
        // checkpoint, so pick the first one (unless a custom workflow hard-codes its own).
        const st = await this.app.imageProviders.status(provider);
        familyName = st.currentModel || '';
        if (!familyName && provider.kind === 'comfyui') {
          const first = (await provider.listModels().catch(() => []))[0]?.id || '';
          familyName = first;
          if (first && !(provider.getWorkflow?.() || provider.workflow)) model = first;
        }
      }
      const { params, family, warnings } = resolveImageParams(req, { settings: s, totalMem: this.app.system.totalMem, model: familyName, providerKind: provider.kind });
      params.model = model;
      job.params = { ...params };
      job.family = family;
      job.warnings = warnings;
      let initImage = null;
      if (req.initImage) {
        if (provider.capabilities.img2img) initImage = await this._loadInitImage(req.initImage);
      }
      status('starting', { params: job.params, family, warnings, providerId: provider.id });

      // --- memory coordination -------------------------------------------------------------
      const ollama = this.app.registry.ollama();
      let loaded = [];
      if (ollama && (await this.app.registry.status(ollama)).ok) loaded = await ollama.ps().catch(() => []);
      const decision = this.decideUnload({ mode: s.image.unloadChatModel, loaded, familyBytes: imageFamilyFor(familyName).approxBytes });
      job.memory = { ...decision, unloaded: [] };
      if (decision.unload) {
        status('unloading', { models: loaded.map((m) => m.model), reason: decision.reason, message: `Unloading ${loaded.map((m) => m.model).join(', ')} to free ${formatBytes(decision.loadedBytes)} for image generation…` });
        for (const m of loaded) {
          try { await ollama.unload(m.model); job.memory.unloaded.push(m.model); } catch (e) { log.warn('unload failed', m.model, e.message); }
        }
        if (job.memory.unloaded.length) this.app.modelState.markUnloaded(job.memory.unloaded);
        // keep_alive: 0 returns before Ollama has actually freed the memory: wait until /api/ps no longer lists them.
        const freed = await this._waitUnloaded(ollama, job.memory.unloaded, signal);
        job.memory.confirmed = freed;
        status('unloaded', { models: job.memory.unloaded, confirmed: freed, ...(freed ? {} : { message: 'Ollama did not report the models as unloaded in time; generating anyway.' }) });
      }

      // --- generate --------------------------------------------------------------------------
      status('generating', { message: `Generating ${params.count} image${params.count > 1 ? 's' : ''} (${params.width}×${params.height}, ${params.steps} steps)…` });
      const timeoutSignal = withTimeout(signal, (s.image.timeoutSec || 600) * 1000);
      const result = await provider.generate({ ...params, initImage, comfy: family.comfy }, {
        signal: timeoutSignal,
        onProgress: (pr) => { job.progress = pr.progress; publish('image_progress', { jobId: job.id, ...pr }); },
      });
      if (signal.aborted) throw signal.reason ?? new Error('Aborted');

      // --- save ------------------------------------------------------------------------------
      status('saving');
      const saved = [];
      for (let i = 0; i < result.images.length; i++) {
        const img = result.images[i];
        const rec = await this.app.gallery.add({
          buffer: img.buffer,
          mime: img.mime,
          meta: {
            prompt: params.prompt, negativePrompt: params.negativePrompt, seed: result.seeds?.[i] ?? params.seed + i,
            params: { width: params.width, height: params.height, steps: params.steps, cfg: params.cfg, sampler: params.sampler, count: params.count, denoise: initImage ? params.denoise : null },
            model: result.model || model || familyName || null, providerId: provider.id, providerKind: provider.kind, family: family.id,
            chatId: job.chatId, messageId: job.messageId, toolCallId: job.toolCallId, source: job.source, jobId: job.id,
            initImage: initImage ? { kind: initImage.kind, id: initImage.id } : null,
          },
        });
        saved.push(rec);
        job.images.push(rec.id);
        publish('image', { jobId: job.id, image: publicImage(rec), index: i, toolCallId: job.toolCallId, messageId: job.messageId });
      }
      job.progress = 1;
      job.status = 'done';
      job.finishedAt = nowIso();
      publish('image_done', { jobId: job.id, job: publicJob(job), images: saved.map(publicImage), chatModelUnloaded: job.memory.unloaded.length > 0, reload: job.memory.unloaded.length ? s.image.reloadAfter : null });
      if (job.memory.unloaded.length && s.image.reloadAfter === 'eager' && ramTier(this.app.system.totalMem) !== 'low') this._eagerReload(job.memory.unloaded);
      return { job: publicJob(job), images: saved };
    } catch (e) {
      const aborted = signal.aborted || isAbortError(e);
      const timedOut = !aborted && (e.code === 'timeout' || e.name === 'TimeoutError');
      job.status = aborted ? 'aborted' : 'error';
      job.error = aborted ? 'Aborted' : timedOut ? `Timed out after ${s.image.timeoutSec || 600} s waiting for ${provider.name} to finish the image (image.timeoutSec)` : e.message;
      if (timedOut) e = Object.assign(new ProviderError(job.error, { status: 504, code: 'timeout', providerId: provider.id }), { cause: e });
      job.finishedAt = nowIso();
      publish('image_error', { jobId: job.id, code: aborted ? 'aborted' : e.code || 'image_error', message: job.error, job: publicJob(job) });
      if (aborted) {
        const err = new Error('Image generation aborted');
        err.name = 'AbortError';
        throw err;
      }
      throw e;
    }
  }

  /** Poll /api/ps until none of `models` is resident (bounded). */
  async _waitUnloaded(ollama, models, signal, { timeoutMs = ImageService.unloadWaitMs, intervalMs = 200 } = {}) {
    if (!models.length) return true;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ps = await ollama.ps().catch(() => null);
      if (ps && !ps.some((m) => models.includes(m.model) || models.includes(m.name))) return true;
      if (Date.now() >= deadline) return false;
      await sleep(intervalMs, signal);
    }
  }

  _eagerReload(models) {
    const ollama = this.app.registry.ollama();
    const keepAlive = this.settings.keepAlive;
    (async () => {
      for (const m of models) {
        this.app.bus.publish('model.status', { phase: 'loading', model: m, reason: 'reload_after_image' });
        const numCtx = this.app.engine.loadedCtxFor(ollama.id, m);
        await ollama.load(m, { keepAlive, ...(numCtx ? { options: { num_ctx: numCtx } } : {}) }).catch(() => {});
      }
      this.app.modelState.markReloaded();
      this.app.bus.publish('model.status', { phase: 'ready', models });
    })();
  }
}

export function publicJob(j) {
  const { _controller, ...rest } = j;
  return rest;
}
