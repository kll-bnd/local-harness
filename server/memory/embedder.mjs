// Embedding service: resolves the embedding model from settings, embeds with task prefixes, caches.
import { EMBEDDING_MODELS, embeddingProfileFor, RECOMMENDED_EMBEDDING } from '../providers/catalog.mjs';
import { ramTier } from '../context/sizing.mjs';
import { normalize } from './vectors.mjs';
import { sha1 } from '../lib/ids.mjs';
import { log } from '../lib/log.mjs';

export class Embedder {
  constructor({ registry, settings, system }) {
    this.registry = registry;
    this.settingsStore = settings;
    this.system = system;
    this.cache = new Map();
    this.failedUntil = 0;
    this.lastError = null;
  }

  /** Resolve the embedding model. Returns `{providerId, model, provider}` or null with a reason. */
  async resolve() {
    const cfg = this.settingsStore.get().embeddings?.model ?? 'auto';
    if (cfg === 'off' || cfg === null) return { ref: null, reason: 'disabled' };
    if (typeof cfg === 'object') {
      const provider = this.registry.get(cfg.providerId || 'ollama');
      if (!provider) return { ref: null, reason: 'provider_not_found' };
      return { ref: { providerId: provider.id, model: cfg.model, provider } };
    }
    // auto
    if (ramTier(this.system.totalMem) === 'low') return { ref: null, reason: 'low_ram_opt_in' };
    const models = await this.registry.listModels().catch(() => []);
    const embeds = models.filter((m) => m.embedding);
    for (const pref of EMBEDDING_MODELS) {
      const hit = embeds.find((m) => m.model.split(':')[0].split('/').pop() === pref.model);
      if (hit) return { ref: { providerId: hit.providerId, model: hit.model, provider: this.registry.get(hit.providerId) } };
    }
    if (embeds[0]) return { ref: { providerId: embeds[0].providerId, model: embeds[0].model, provider: this.registry.get(embeds[0].providerId) } };
    return { ref: null, reason: 'none_installed' };
  }

  async status() {
    const { ref, reason } = await this.resolve();
    const models = await this.registry.listModels().catch(() => []);
    const candidates = models.filter((m) => m.embedding).map((m) => ({ providerId: m.providerId, model: m.model, sizeBytes: m.sizeBytes }));
    const low = ramTier(this.system.totalMem) === 'low';
    return {
      enabled: !!ref,
      available: !!ref && Date.now() >= this.failedUntil,
      providerId: ref?.providerId || null,
      model: ref?.model || null,
      reason: ref ? null : reason,
      retrieval: ref ? 'hybrid' : 'bm25',
      candidates,
      suggestion: candidates.length ? null : (low ? RECOMMENDED_EMBEDDING[1] : RECOMMENDED_EMBEDDING[0]),
      lowRamNote: low ? 'On 8 GB machines embeddings are opt-in: loading a second model can evict the chat model (OLLAMA_MAX_LOADED_MODELS=1) and force a reload on every turn. BM25 keyword search is used instead.' : null,
      lastError: this.lastError,
    };
  }

  /**
   * Embed texts. `kind` = 'query' | 'document' (selects the model's task prefix).
   * Returns `{ model, vectors: Float32Array[] }` or null when embeddings are unavailable.
   */
  async embed(texts, { kind = 'document', signal } = {}) {
    if (!texts.length) return null;
    if (Date.now() < this.failedUntil) return null;
    const { ref } = await this.resolve();
    if (!ref?.provider) return null;
    const prefix = embeddingProfileFor(ref.model).prefixes?.[kind] || '';
    const key = (t) => sha1(`${ref.model}\u0000${prefix}\u0000${t}`);
    const out = new Array(texts.length);
    const missing = [];
    texts.forEach((t, i) => {
      const hit = this.cache.get(key(t));
      if (hit) out[i] = hit; else missing.push(i);
    });
    try {
      for (let i = 0; i < missing.length; i += 32) {
        const batch = missing.slice(i, i + 32);
        const vecs = await ref.provider.embed({ model: ref.model, input: batch.map((j) => prefix + texts[j].slice(0, 8000)), keepAlive: '10m', signal });
        if (vecs.length !== batch.length) throw new Error(`embedding count mismatch (${vecs.length} vs ${batch.length})`);
        batch.forEach((j, n) => {
          const v = normalize(vecs[n]);
          out[j] = v;
          this.cache.set(key(texts[j]), v);
        });
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      this.lastError = e.message;
      this.failedUntil = Date.now() + 30000;
      log.warn(`Embedding failed (${ref.model}): ${e.message}; falling back to BM25 for 30s`);
      return null;
    }
    if (this.cache.size > 5000) for (const k of [...this.cache.keys()].slice(0, 1000)) this.cache.delete(k);
    this.lastError = null;
    return { model: ref.model, vectors: out };
  }
}
