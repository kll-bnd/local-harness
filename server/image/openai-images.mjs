// OpenAI-compatible image generation (POST /v1/images/generations, b64_json) — LocalAI, mflux-style servers, etc.
import { imageJson, imageRequest, sniffImageMime } from './http.mjs';
import { ProviderError } from '../lib/errors.mjs';

export class OpenAIImagesProvider {
  constructor({ id, name, baseUrl, apiKey = '', builtin = false }) {
    this.id = id;
    this.kind = 'openai';
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    this.apiKey = apiKey;
    this.builtin = builtin;
    this.capabilities = { img2img: false, progress: false, models: true, negativePrompt: true, seed: true, steps: true, cfg: true, sampler: false };
  }

  async status() {
    try {
      await imageJson(this, '/v1/models', { timeoutMs: 1500 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async listModels() {
    const j = await imageJson(this, '/v1/models', { timeoutMs: 5000 });
    return (j?.data || []).map((m) => ({ id: m.id, name: m.id, current: false }));
  }

  async interrupt() { /* not supported by the API; the HTTP request is aborted instead */ }

  async generate(p, { signal } = {}) {
    const body = { prompt: p.prompt, n: p.count, size: `${p.width}x${p.height}`, response_format: 'b64_json' };
    if (p.model) body.model = p.model;
    // Common non-standard extensions understood by local servers (ignored by others).
    if (p.negativePrompt) body.negative_prompt = p.negativePrompt;
    if (Number.isFinite(p.seed)) body.seed = p.seed;
    if (p.steps) body.steps = p.steps;
    if (p.cfg != null) body.guidance_scale = p.cfg;
    const j = await imageJson(this, '/v1/images/generations', { method: 'POST', body, signal, timeoutMs: 0 });
    const images = [];
    for (const d of j?.data || []) {
      if (d.b64_json) {
        const buffer = Buffer.from(d.b64_json, 'base64');
        images.push({ buffer, mime: sniffImageMime(buffer) });
      } else if (d.url) {
        const url = new URL(d.url, this.baseUrl);
        const res = url.origin === new URL(this.baseUrl).origin
          ? await imageRequest(this, url.pathname + url.search, { signal, timeoutMs: 60000 })
          : await fetch(url, { signal });
        const buffer = Buffer.from(await res.arrayBuffer());
        images.push({ buffer, mime: sniffImageMime(buffer) });
      }
    }
    if (!images.length) throw new ProviderError(`${this.name} returned no images`, { providerId: this.id });
    return { images, seeds: images.map((_, i) => p.seed + i) };
  }
}
