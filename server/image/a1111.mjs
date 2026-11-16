// AUTOMATIC1111-compatible image API (Draw Things HTTP API server, AUTOMATIC1111, Forge, SD.Next).
import { imageJson, imageRequest, sniffImageMime } from './http.mjs';
import { ProviderError } from '../lib/errors.mjs';
import { backendFetch } from '../lib/backend-http.mjs';

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

  /**
   * Detect an A1111-compatible API. Only JSON answers count, so an unrelated web service on the same port is
   * never mistaken for Draw Things: /sdapi/v1/options (A1111, Forge), then /sd-models or /samplers (arrays),
   * then GET on the POST-only txt2img route (FastAPI answers 405/422 with a JSON `detail`), then GET / (Draw Things
   * is assumed to answer with its current configuration JSON).
   */
  async status() {
    const probe = async (path) => {
      try {
        const res = await backendFetch(this, path, { timeoutMs: 1500, egress: 'remote_image_provider' });
        const text = (await res.text()).slice(0, 500000);
        let json = null;
        if (/^\s*[{[]/.test(text)) { try { json = JSON.parse(text); } catch { /* not JSON */ } }
        return { status: res.status, json };
      } catch (e) {
        return { error: e };
      }
    };
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const opts = await probe('/sdapi/v1/options');
    if (opts.error) return { ok: false, error: opts.error.message };
    if (opts.status === 200 && isObj(opts.json)) return { ok: true, currentModel: opts.json.sd_model_checkpoint || opts.json.model || null };
    // A list endpoint counts only when it lists what A1111 lists (an API that answers [] everywhere is not A1111).
    for (const [path, keys] of [['/sdapi/v1/sd-models', ['title', 'model_name']], ['/sdapi/v1/samplers', ['name']]]) {
      const r = await probe(path);
      if (r.status === 200 && Array.isArray(r.json) && r.json.length && r.json.every((x) => isObj(x) && keys.some((k) => typeof x[k] === 'string'))) return { ok: true, currentModel: null };
    }
    const t2i = await probe('/sdapi/v1/txt2img');
    if ([405, 422].includes(t2i.status) && isObj(t2i.json) && ('detail' in t2i.json || 'error' in t2i.json)) return { ok: true, currentModel: null };
    const root = await probe('/');
    if (root.status === 200 && isObj(root.json) && 'steps' in root.json && ('model' in root.json || 'guidance_scale' in root.json || 'sampler' in root.json)) {
      return { ok: true, currentModel: typeof root.json.model === 'string' ? root.json.model : null };
    }
    return { ok: false, error: `No A1111-compatible API at ${this.baseUrl}` };
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
      // One image per batch, `count` batches in sequence: running a batch in parallel multiplies peak
      // memory, which an 8 GB Mac cannot afford. A1111/Forge call the batch count `n_iter`, Draw Things `batch_count`.
      batch_size: 1,
      n_iter: p.count,
      batch_count: p.count,
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
      const count = Math.max(p.count, 1);
      let info = null;
      try { info = typeof j.info === 'string' ? JSON.parse(j.info) : j.info; } catch { /* no usable info */ }
      // With several images A1111 puts a contact-sheet grid FIRST and reports where the real images start.
      const first = Number.isInteger(info?.index_of_first_image) ? info.index_of_first_image : Math.max(0, images.length - count);
      const out = images.slice(first, first + count);
      let seeds = out.map((_, i) => p.seed + i);
      if (Array.isArray(info?.all_seeds) && info.all_seeds.length) seeds = info.all_seeds.slice(0, out.length);
      else if (Number.isFinite(info?.seed)) seeds = out.map((_, i) => info.seed + i);
      return { images: out, seeds };
    } catch (e) {
      // Whatever went wrong (timeout, dropped connection, bad answer), never leave the backend generating.
      if (!signal?.aborted) this.interrupt();
      throw e;
    } finally {
      polling = false;
      signal?.removeEventListener('abort', onAbort);
      await poll.catch(() => {});
    }
  }
}
