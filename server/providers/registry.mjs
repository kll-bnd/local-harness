// Chat/embedding provider registry: builds providers from settings, auto-detects local servers,
// aggregates model lists, caches model metadata and computes per-model context plans.
import { OllamaProvider } from './ollama.mjs';
import { OpenAICompatProvider } from './openai.mjs';
import { normalizeOllamaShow, normalizeOpenAIModel } from './model-info.mjs';
import { RECOMMENDED_MODELS, EMBEDDING_NAME_RE } from './catalog.mjs';
import { computeContextPlan } from '../context/sizing.mjs';
import { defaultOllamaUrl } from '../store/settings.mjs';
import { HttpError, ProviderError } from '../lib/errors.mjs';

const STATUS_TTL = 3000;
const MODELS_TTL = 4000;
const SERVER_INFO_TTL = 3000;

export class ProviderRegistry {
  constructor({ settings, bus, system, autodetect = true, ollamaProcess = null }) {
    this.settingsStore = settings;
    this.bus = bus;
    this.system = system;
    this.autodetectAllowed = autodetect;
    this.ollamaProcess = ollamaProcess;
    this._providers = new Map();
    this._statusCache = new Map();
    this._modelsCache = null;
    this._infoCache = new Map();
    this.toolsRejected = new Set(); // `${providerId}|${model}` that refused tool definitions
    this._configKey = null;
  }

  get settings() { return this.settingsStore.get(); }

  /** (Re)build provider instances when the relevant settings change. */
  sync() {
    const p = this.settings.providers;
    const key = JSON.stringify(p);
    if (key === this._configKey) return;
    this._configKey = key;
    const next = new Map();
    const reuse = (id, make) => {
      const old = this._providers.get(id);
      const fresh = make();
      if (old && old.baseUrl === fresh.baseUrl && old.kind === fresh.kind && old.apiKey === fresh.apiKey) next.set(id, old);
      else next.set(id, fresh);
    };
    if (p.builtin.ollama.enabled !== false) reuse('ollama', () => new OllamaProvider({ id: 'ollama', name: 'Ollama', baseUrl: p.builtin.ollama.baseUrl || defaultOllamaUrl() }));
    if (p.autodetect && this.autodetectAllowed) {
      if (p.builtin.llamacpp.enabled !== false) reuse('llamacpp', () => Object.assign(new OpenAICompatProvider({ id: 'llamacpp', name: 'llama.cpp / MLX (8080)', baseUrl: p.builtin.llamacpp.baseUrl, flavor: 'generic', builtin: true }), { autodetected: true }));
      if (p.builtin.lmstudio.enabled !== false) reuse('lmstudio', () => Object.assign(new OpenAICompatProvider({ id: 'lmstudio', name: 'LM Studio', baseUrl: p.builtin.lmstudio.baseUrl, flavor: 'lmstudio', builtin: true }), { autodetected: true }));
    }
    for (const c of p.custom || []) {
      if (c.enabled === false) continue;
      reuse(c.id, () => (c.kind === 'ollama'
        ? new OllamaProvider({ id: c.id, name: c.name, baseUrl: c.baseUrl, builtin: false })
        : new OpenAICompatProvider({ id: c.id, name: c.name, baseUrl: c.baseUrl, apiKey: c.apiKey || '', flavor: 'generic', builtin: false })));
    }
    this._providers = next;
    this._modelsCache = null;
  }

  all() { this.sync(); return [...this._providers.values()]; }

  get(id) {
    this.sync();
    return this._providers.get(id) || null;
  }

  ollama() { return this.get('ollama'); }

  require(id) {
    const p = this.get(id);
    if (!p) throw new HttpError(404, 'provider_not_found', `Provider "${id}" is not configured`);
    return p;
  }

  async status(provider, { refresh = false } = {}) {
    const c = this._statusCache.get(provider.id);
    if (!refresh && c && Date.now() - c.at < STATUS_TTL) return c.value;
    const value = await provider.status();
    const prev = c?.value?.ok;
    this._statusCache.set(provider.id, { at: Date.now(), value });
    if (prev !== undefined && prev !== value.ok) {
      this._modelsCache = null;
      this.bus?.publish('providers.status', { providerId: provider.id, ok: value.ok });
    }
    return value;
  }

  invalidate() {
    this._statusCache.clear();
    this._modelsCache = null;
  }

  async listStatus({ refresh = false } = {}) {
    const out = [];
    await Promise.all(this.all().map(async (p) => {
      const st = await this.status(p, { refresh });
      if (p.autodetected && !st.ok) return; // only show auto-detected servers that are actually running
      out.push({
        id: p.id, kind: p.kind, name: p.name, baseUrl: p.baseUrl, builtin: !!p.builtin, autodetected: !!p.autodetected,
        flavor: p.flavor || null, status: st.ok ? 'running' : 'unreachable', version: st.version || null, error: st.ok ? null : st.error,
        capabilities: p.capabilities,
        ...(p.id === 'ollama' && this.ollamaProcess ? { process: this.ollamaProcess.info() } : {}),
      });
    }));
    const order = (x) => (x.id === 'ollama' ? 0 : x.builtin ? 1 : 2);
    return out.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  }

  /** Aggregated model list across reachable providers. */
  async listModels({ refresh = false } = {}) {
    if (!refresh && this._modelsCache && Date.now() - this._modelsCache.at < MODELS_TTL) return this._modelsCache.value;
    const lists = await Promise.all(this.all().map(async (p) => {
      const st = await this.status(p, { refresh });
      if (!st.ok) return [];
      try {
        const models = await p.listModels();
        return models.map((m) => ({ providerId: p.id, providerName: p.name, ...m }));
      } catch {
        return [];
      }
    }));
    const value = lists.flat().map(({ _meta, _lm, ...m }) => ({ ...m, embedding: EMBEDDING_NAME_RE.test(m.model) || _lm?.type === 'embeddings' }));
    this._modelsCache = { at: Date.now(), value };
    return value;
  }

  async findModel(model, providerId) {
    const list = await this.listModels();
    return list.find((m) => (!providerId || m.providerId === providerId) && (m.model === model || m.name === model || m.model === `${model}:latest`)) || null;
  }

  /** Resolve `{providerId?, model}` → `{ provider, model }`. Falls back to defaults when ref is null. */
  async resolve(ref) {
    if (!ref || !ref.model) {
      const def = await this.defaultChatModel();
      if (!def) throw new HttpError(409, 'no_model', 'No chat model is available. Start Ollama (or another local server) and pull a model, e.g. nemotron-3.5-bolt:e4b.');
      ref = def;
    }
    let providerId = ref.providerId;
    if (!providerId) {
      const found = await this.findModel(ref.model);
      providerId = found?.providerId || 'ollama';
    }
    const provider = this.get(providerId);
    if (!provider) throw new HttpError(404, 'provider_not_found', `Provider "${providerId}" is not configured`);
    return { provider, model: ref.model, providerId };
  }

  async defaultChatModel() {
    const s = this.settings;
    if (s.defaultModel?.model) return s.defaultModel;
    const list = (await this.listModels()).filter((m) => !m.embedding);
    if (!list.length) return null;
    for (const rec of RECOMMENDED_MODELS) {
      for (const v of rec.variants) {
        const hit = list.find((m) => m.model === v.model || m.model.startsWith(v.model.split(':')[0] + ':'));
        if (hit) return { providerId: hit.providerId, model: hit.model };
      }
    }
    const sorted = [...list].sort((a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')));
    return { providerId: sorted[0].providerId, model: sorted[0].model };
  }

  /** Normalized ModelInfo (cached by provider/model/digest). */
  async modelInfo(provider, model, { refresh = false } = {}) {
    const tag = await this.findModel(model, provider.id).catch(() => null);
    const key = `${provider.id}|${model}|${tag?.digest || ''}`;
    // Ollama metadata is tied to the model digest. OpenAI-compatible servers have no digest and their context is
    // set at launch (llama-server -c, LM Studio JIT loading), so their info is only reused for a few seconds.
    const hit = this._infoCache.get(key);
    if (!refresh && hit && (provider.kind === 'ollama' || Date.now() - hit.at < SERVER_INFO_TTL)) return hit.info;
    let info;
    if (provider.kind === 'ollama') {
      const show = await provider.show(model);
      info = normalizeOllamaShow(model, show, tag);
      if (!info.sizeBytes && tag?.sizeBytes) info.sizeBytes = tag.sizeBytes;
    } else {
      const si = await provider.serverInfo({ refresh: true }).catch(() => ({}));
      info = normalizeOpenAIModel(provider, tag || { model }, si);
    }
    info.providerId = provider.id;
    this._infoCache.set(key, { at: Date.now(), info });
    if (this._infoCache.size > 500) this._infoCache.delete(this._infoCache.keys().next().value);
    return info;
  }

  dropInfo(providerId, model) {
    for (const k of this._infoCache.keys()) if (k.startsWith(`${providerId}|${model}|`)) this._infoCache.delete(k);
    this.toolsRejected.delete(`${providerId}|${model}`);
    this._modelsCache = null;
  }

  /** Which KV cache precision the Ollama server is (probably) using. */
  kvCacheType(settings) {
    const t = settings.context?.kvCacheType;
    if (t && t !== 'auto') return t;
    if (this.ollamaProcess?.managed) return settings.ollama?.flashAttention !== false ? (settings.ollama?.kvCacheType || 'f16') : 'f16';
    const envT = process.env.OLLAMA_KV_CACHE_TYPE;
    return envT && ['q8_0', 'q4_0', 'f16'].includes(envT) ? envT : 'f16';
  }

  /**
   * Context plan for a model under effective settings `s`.
   * `opts.otherModelsBytes` lets callers account for another resident model (embeddings).
   */
  async contextPlan(provider, model, s, { info, otherModelsBytes = 0, modeOverride } = {}) {
    info ||= await this.modelInfo(provider, model);
    const mode = modeOverride ?? s.context?.mode ?? 'auto';
    const kvCacheType = this.kvCacheType(s);
    // Real /api/ps measurements of this exact model build (digest + size) at this KV precision.
    const measurements = provider.kind === 'ollama' && this.measurements && s.context?.useMeasurements !== false
      ? this.measurements.samplesFor(provider.id, model, { digest: info.digest, sizeBytes: info.sizeBytes, kvCacheType })
      : null;
    const plan = computeContextPlan({
      providerKind: provider.kind,
      serverCtx: info.serverContext,
      modelMax: info.contextLength,
      modelMaxSource: info.contextLengthSource,
      advertisedMax: info.advertisedContextLength,
      modelBytes: info.sizeBytes || 0,
      arch: info.arch,
      profile: info.profile,
      mode,
      maxAuto: s.context?.maxAuto ?? null,
      lowRamCap: s.context?.lowRamCap ?? null,
      system: this.system,
      memoryFraction: s.context?.memoryFraction ?? null,
      kvCacheType,
      otherModelsBytes,
      measurements,
    });
    plan.providerId = provider.id;
    plan.model = model;
    if (info.contextNote) plan.contextNote = info.contextNote;
    return plan;
  }

  requireOllama() {
    const p = this.ollama();
    if (!p) throw new ProviderError('Ollama provider is disabled', { status: 400, code: 'unsupported' });
    return p;
  }
}
