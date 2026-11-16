// Image provider registry (same detect/configure pattern as chat providers).
import { A1111Provider } from './a1111.mjs';
import { ComfyUIProvider } from './comfyui.mjs';
import { OpenAIImagesProvider } from './openai-images.mjs';
import { HttpError } from '../lib/errors.mjs';

const STATUS_TTL = 5000;

export class ImageProviderRegistry {
  constructor({ settings, bus, autodetect = true }) {
    this.settingsStore = settings;
    this.bus = bus;
    this.autodetectAllowed = autodetect;
    this._providers = new Map();
    this._status = new Map();
    this._key = null;
  }

  get settings() { return this.settingsStore.get().image; }

  sync() {
    const s = this.settings;
    const key = JSON.stringify({ b: s.builtin, c: s.custom, a: s.autodetect });
    if (key === this._key) return;
    this._key = key;
    const next = new Map();
    const getWorkflow = () => this.settings.comfyWorkflow || null;
    if (s.autodetect && this.autodetectAllowed) {
      if (s.builtin.a1111.enabled !== false) next.set('a1111', Object.assign(new A1111Provider({ id: 'a1111', name: 'Draw Things / A1111 (7860)', baseUrl: s.builtin.a1111.baseUrl, builtin: true }), { autodetected: true }));
      if (s.builtin.comfyui.enabled !== false) next.set('comfyui', Object.assign(new ComfyUIProvider({ id: 'comfyui', name: 'ComfyUI (8188)', baseUrl: s.builtin.comfyui.baseUrl, builtin: true, getWorkflow }), { autodetected: true }));
    }
    for (const c of s.custom || []) {
      if (c.enabled === false) continue;
      if (!c || typeof c.id !== 'string' || typeof c.baseUrl !== 'string') continue; // never let one bad entry break the app
      const o = { id: c.id, name: c.name || c.id, baseUrl: c.baseUrl, apiKey: c.apiKey || '' };
      if (c.kind === 'a1111') next.set(c.id, new A1111Provider(o));
      else if (c.kind === 'comfyui') next.set(c.id, new ComfyUIProvider({ ...o, workflow: c.workflow || null, getWorkflow: c.workflow ? null : getWorkflow }));
      else next.set(c.id, new OpenAIImagesProvider(o));
    }
    this._providers = next;
    this._status.clear();
  }

  all() { this.sync(); return [...this._providers.values()]; }

  get(id) { this.sync(); return this._providers.get(id) || null; }

  async status(p, { refresh = false } = {}) {
    const c = this._status.get(p.id);
    if (!refresh && c && Date.now() - c.at < STATUS_TTL) return c.value;
    const value = await p.status();
    const prev = c?.value?.ok;
    this._status.set(p.id, { at: Date.now(), value });
    if (prev !== undefined && prev !== value.ok) this.bus?.publish('image.providers.status', { providerId: p.id, ok: value.ok });
    return value;
  }

  /** Cached reachability without waiting (used to decide whether to offer the generate_image tool). */
  cachedOk(id) {
    return this._status.get(id)?.value?.ok ?? null;
  }

  async listStatus({ refresh = false } = {}) {
    const out = [];
    await Promise.all(this.all().map(async (p) => {
      const st = await this.status(p, { refresh });
      if (p.autodetected && !st.ok) return;
      out.push({ id: p.id, kind: p.kind, name: p.name, baseUrl: p.baseUrl, builtin: !!p.builtin, autodetected: !!p.autodetected, status: st.ok ? 'running' : 'unreachable', version: st.version || null, currentModel: st.currentModel || null, error: st.ok ? null : st.error, capabilities: p.capabilities });
    }));
    return out.sort((a, b) => (a.builtin === b.builtin ? a.name.localeCompare(b.name) : a.builtin ? -1 : 1));
  }

  /** The provider to use: explicit id, else settings.image.providerId, else first reachable. */
  async resolve(id, { refresh = false } = {}) {
    const want = id || this.settings.providerId;
    if (want) {
      const p = this.get(want);
      if (!p) throw new HttpError(404, 'image_provider_not_found', `Image provider "${want}" is not configured`);
      const st = await this.status(p, { refresh });
      if (!st.ok) throw new HttpError(503, 'image_provider_unreachable', `${p.name} is not reachable at ${p.baseUrl}`);
      return p;
    }
    for (const p of this.all()) {
      const st = await this.status(p, { refresh });
      if (st.ok) return p;
    }
    throw new HttpError(503, 'no_image_provider', 'No image generator is running. Start Draw Things (enable its HTTP API server on port 7860), AUTOMATIC1111/Forge (--api), or ComfyUI (port 8188), or add a custom endpoint.');
  }

  /** True when some image provider is configured and reachable (checks with a short cache). */
  async available() {
    if (this.settingsStore.get().image?.enabled === false) return false;
    try { await this.resolve(null); return true; } catch { return false; }
  }
}
