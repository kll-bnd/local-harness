// AUTOMATIC1111-compatible image API (Draw Things HTTP API server, AUTOMATIC1111, Forge, SD.Next).
import { imageJson, imageRequest, sniffImageMime } from './http.mjs';
import { ProviderError } from '../lib/errors.mjs';

export class A1111Provider {
  /** Progress polling interval (ms). */
  static pollMs = 600;

  constructor({ id, name, baseUrl, apiKey = '', builtin = false }) {
    this.id = id;
    this.kind = 'a1111';
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.builtin = builtin;
    this.capabilities = { img2img: true, progress: true, models: true, negativePrompt: true, seed: true, steps: true, cfg: true, sampler: true };
  }

  async status() {
    try {
      const opts = await imageJson(this, '/sdapi/v1/options', { timeoutMs: 1500, accept404: true });
      if (opts) return { ok: true, currentModel: opts.sd_model_checkpoint || opts.model || null };
      // Some servers only implement txt2img/img2img; a 405/422 on txt2img GET proves the API exists.
      const r = await fetch(this.baseUrl + '/sdapi/v1/txt2img', { method: 'GET', signal: AbortSignal.timeout(1500) });
      if ([405, 422, 200].includes(r.status)) return { ok: true, currentModel: null };
      return { ok: false, error: `No A1111-compatible API at ${this.baseUrl}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async listModels() {
    const list = await imageJson(this, '/sdapi/v1/sd-models', { timeoutMs: 5000, accept404: true }).catch(() => null);
    const opts = await imageJson(this, '/sdapi/v1/options', { timeoutMs: 3000, accept404: true }).catch(() => null);
    const current = opts?.sd_model_checkpoint || opts?.model || null;
    if (Array.isArray(list) && list.length) {
      return list.map((m) => ({ id: m.title || m.model_name || m.filename, name: m.model_name || m.title, current: !!current && (m.title === current || m.model_name === current) }));
    }
    return current ? [{ id: current, name: current, current: true }] : [];
  }

  async interrupt() {
    await imageRequest(this, '/sdapi/v1/interrupt', { method: 'POST', timeoutMs: 3000 }).catch(() => {});
  }

  /**
   * @param {object} p resolved params (see defaults.mjs) + optional `initImage: {buffer, mime}`
   * @returns {{ images: Array<{buffer, mime}>, seeds: number[] }}
   */
  async generate(p, { signal, onProgress } = {}) {
    const body = {
      prompt: p.prompt,
      negative_prompt: p.negativePrompt || '',
      width: p.width,
      height: p.height,
      steps: p.steps,
      cfg_scale: p.cfg,
      guidance_scale: p.cfg, // Draw Things naming
      seed: p.seed,
      batch_size: p.count,
      batch_count: p.count, // Draw Things naming
      n_iter: 1,
    };
    if (p.sampler) { body.sampler_name = p.sampler; body.sampler = p.sampler; }
    if (p.model) {
      body.override_settings = { sd_model_checkpoint: p.model };
      body.override_settings_restore_afterwards = false;
      body.model = p.model; // Draw Things naming
    }
    let path = '/sdapi/v1/txt2img';
    if (p.initImage) {
      path = '/sdapi/v1/img2img';
      body.init_images = [p.initImage.buffer.toString('base64')];
      body.denoising_strength = p.denoise ?? 0.6;
      body.strength = p.denoise ?? 0.6; // Draw Things naming
    }
    let polling = true;
    const poll = (async () => {
      let misses = 0;
      while (polling && !signal?.aborted) {
        await new Promise((r) => setTimeout(r, A1111Provider.pollMs));
        if (!polling) break;
        try {
          const pr = await imageJson(this, '/sdapi/v1/progress?skip_current_image=true', { timeoutMs: 2000, accept404: true });
          if (!pr) { if (++misses > 2) break; continue; }
          const st = pr.state || {};
          if (typeof pr.progress === 'number' && pr.progress > 0) {
            onProgress?.({ progress: Math.min(0.99, pr.progress), step: st.sampling_step ?? null, steps: st.sampling_steps ?? p.steps, etaSeconds: pr.eta_relative != null ? Math.round(pr.eta_relative) : null });
          }
        } catch { if (++misses > 2) break; }
      }
    })();
    const onAbort = () => { this.interrupt(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const j = await imageJson(this, path, { method: 'POST', body, signal, timeoutMs: 0 });
      const images = (j.images || []).map((b64) => {
        const buffer = Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
        return { buffer, mime: sniffImageMime(buffer) };
      });
      if (!images.length) throw new ProviderError(`${this.name} returned no images`, { providerId: this.id });
      let seeds = images.map((_, i) => p.seed + i);
      try {
        const info = typeof j.info === 'string' ? JSON.parse(j.info) : j.info;
        if (Array.isArray(info?.all_seeds) && info.all_seeds.length) seeds = info.all_seeds.slice(0, images.length);
        else if (Number.isFinite(info?.seed)) seeds = images.map((_, i) => info.seed + i);
      } catch { /* keep requested seeds */ }
      // A1111 can append a grid image when batch_size > 1; drop extras.
      return { images: images.slice(0, Math.max(p.count, 1)), seeds };
    } finally {
      polling = false;
      signal?.removeEventListener('abort', onAbort);
      await poll.catch(() => {});
    }
  }
}
