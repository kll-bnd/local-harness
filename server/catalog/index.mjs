// The browsable model catalogue (docs/API.md §10.8): one route, three sources.
//   local        installed models + Harness's curated recommendations (no network; works while blocked)
//   ollama       the Ollama library (ollama.com pages)          — only inside an "allow internet" window
//   huggingface  GGUF repositories on Hugging Face (its API)   — only inside an "allow internet" window
import { HttpError } from '../lib/errors.mjs';
import { OfflineLockError } from '../security/egress.mjs';
import { RECOMMENDED_MODELS } from '../providers/catalog.mjs';
import { TtlCache } from './net.mjs';
import { fitContext, curatedModels } from './fit.mjs';
import { hfList, hfDetail } from './huggingface.mjs';
import { ollamaList, ollamaDetail } from './ollama-library.mjs';

const SOURCES = new Set(['local', 'ollama', 'huggingface']);
const KINDS = new Set(['chat', 'vision', 'embedding']);
const HOST = { ollama: 'ollama.com', huggingface: 'huggingface.co' };

export class Catalog {
  constructor(app) {
    this.app = app;
    this.cache = new TtlCache();
  }

  _gate(source) {
    if (source !== 'local' && this.app.network?.blocked) throw new OfflineLockError('model_catalog', HOST[source]);
  }

  async _ctx() {
    const installed = await this.app.registry.listModels().catch(() => []);
    return { fits: fitContext(this.app), installedNames: new Set(installed.map((m) => String(m.model).toLowerCase())), curated: curatedModels(), cache: this.cache, installed };
  }

  static parseQuery(query) {
    const source = query.get('source') || 'local';
    if (!SOURCES.has(source)) throw new HttpError(400, 'bad_request', 'source must be local, ollama or huggingface');
    const kind = query.get('kind') || null;
    if (kind && !KINDS.has(kind)) throw new HttpError(400, 'bad_request', 'kind must be chat, vision or embedding');
    const limitRaw = query.get('limit');
    const limit = limitRaw ? Math.floor(Number(limitRaw)) : 24;
    if (!Number.isFinite(limit) || limit < 1 || limit > 50) throw new HttpError(400, 'bad_request', 'limit must be 1–50');
    const q = (query.get('q') || '').trim().slice(0, 100) || null;
    const publisher = (query.get('publisher') || '').trim().slice(0, 100) || null;
    if (publisher && !/^[\w.-]+$/.test(publisher)) throw new HttpError(400, 'bad_request', 'publisher must be a user or organisation name');
    const sort = query.get('sort') || 'trending';
    return { source, sort, kind, fits: query.get('fits') === 'true' || query.get('fits') === '1', minParams: query.get('minParams'), maxParams: query.get('maxParams'), publisher, q, cursor: query.get('cursor') || null, limit };
  }

  async list(q) {
    this._gate(q.source);
    const ctx = await this._ctx();
    const out = q.source === 'huggingface' ? await hfList(q, ctx) : q.source === 'ollama' ? await ollamaList(q, ctx) : this._localList(q, ctx);
    return { source: q.source, sort: q.sort, items: out.items, nextCursor: out.nextCursor, sourceNote: out.sourceNote ?? null, fetchedAt: out.fetchedAt || new Date().toISOString(), cached: !!out.cached };
  }

  async detail({ source, id }) {
    if (!SOURCES.has(source)) throw new HttpError(400, 'bad_request', 'source must be local, ollama or huggingface');
    if (typeof id !== 'string' || !id || id.length > 200) throw new HttpError(400, 'bad_request', 'id is required');
    this._gate(source);
    const ctx = await this._ctx();
    if (source === 'huggingface') return hfDetail(id, ctx);
    if (source === 'ollama') return ollamaDetail(id, ctx);
    return this._localDetail(id, ctx);
  }

  // ------------------------------------------------------------------------------------------ local
  _localItems(ctx) {
    const items = [];
    const seen = new Set();
    for (const rec of RECOMMENDED_MODELS) {
      const best = rec.variants.map((v) => ({ v, e: ctx.fits.listFit({ sizeBytes: v.textOnlyBytes && ctx.fits.lowRam ? v.textOnlyBytes : v.approxSizeBytes, contextLength: rec.contextLength, name: v.model }) }));
      const fitting = best.filter((b) => b.e?.fits).sort((a, b) => (b.e.sizeBytes || 0) - (a.e.sizeBytes || 0))[0] || best[0];
      const installed = rec.variants.some((v) => ctx.installedNames.has(String(v.model).toLowerCase()));
      for (const v of rec.variants) seen.add(String(v.model).toLowerCase());
      items.push({
        source: 'local', id: rec.id, name: rec.name, publisher: 'harness', description: rec.description || null,
        kind: rec.tags?.includes('vision') ? 'vision' : 'chat', capabilities: (rec.tags || []).filter((t) => ['tools', 'thinking', 'vision'].includes(t)),
        parameters: rec.archHint?.parameterCount || null, architecture: rec.family || null, contextLength: rec.contextLength || null,
        downloads: null, likes: null, trendingScore: null, updatedAt: null, gated: false, license: null, tags: rec.tags || [],
        fit: fitting?.e ? { ...fitting.e, basis: 'tag_sizes' } : null, installed, recommended: true, url: null,
      });
    }
    for (const m of ctx.installed) {
      const name = String(m.model).toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      items.push({
        source: 'local', id: m.model, name: m.model, publisher: m.providerId || 'local', description: null,
        kind: (m.capabilities || []).includes('embedding') ? 'embedding' : (m.capabilities || []).includes('vision') ? 'vision' : 'chat', capabilities: m.capabilities || [],
        parameters: null, architecture: m.family || null, contextLength: null, downloads: null, likes: null, trendingScore: null, updatedAt: m.modifiedAt || null,
        gated: false, license: null, tags: [], fit: m.sizeBytes ? ctx.fits.listFit({ sizeBytes: m.sizeBytes, name: m.model }) : null, installed: true, recommended: false, url: null,
      });
    }
    return items;
  }

  _localList(q, ctx) {
    let items = this._localItems(ctx);
    if (q.q) { const n = q.q.toLowerCase(); items = items.filter((i) => `${i.name} ${i.id} ${i.description || ''}`.toLowerCase().includes(n)); }
    if (q.kind) items = items.filter((i) => i.kind === q.kind);
    if (q.fits) items = items.filter((i) => i.fit?.fits);
    let offset = 0;
    if (q.cursor) { const o = Number(Buffer.from(q.cursor, 'base64url').toString('utf8')); if (!Number.isInteger(o) || o < 0) throw new HttpError(400, 'bad_cursor', 'Bad cursor'); offset = o; }
    const slice = items.slice(offset, offset + q.limit);
    return { items: slice, nextCursor: offset + q.limit < items.length ? Buffer.from(String(offset + q.limit)).toString('base64url') : null, sourceNote: 'installed models and Harness recommendations (no network)' };
  }

  _localDetail(id, ctx) {
    const item = this._localItems(ctx).find((i) => i.id === id);
    if (!item) throw new HttpError(404, 'catalog_not_found', 'Not an installed model or a Harness recommendation.');
    const rec = RECOMMENDED_MODELS.find((r) => r.id === id);
    const files = (rec?.variants || []).map((v) => {
      const asText = !!(v.textOnlyBytes && ctx.fits.lowRam && rec.textOnly?.recommendedOnLowRam);
      const est = ctx.fits.estimate({ bytes: asText ? v.textOnlyBytes : v.approxSizeBytes, contextLength: rec.contextLength, name: v.model });
      const tag = String(v.model).split(':').pop();
      return {
        tag, model: v.model, files: [], sizeBytes: v.modelLayerBytes || v.approxSizeBytes || null, projectorBytes: v.projectorBytes || null, downloadBytes: v.approxSizeBytes || null,
        contextLength: rec.contextLength || null, inputs: null, pullable: true,
        fit: est ? { ...est, basis: asText ? 'text_only_copy' : 'as_pulled' } : null,
        textOnly: rec.textOnly?.supported ? { model: null, sizeBytes: v.textOnlyBytes || null, recommended: asText } : null,
        installed: ctx.installedNames.has(String(v.model).toLowerCase()), recommended: false, note: v.note || null,
      };
    });
    return { ...item, license: null, baseModels: [], card: null, files, projectors: [], hasProjector: files.some((f) => f.projectorBytes), recommendedTag: null, downloadable: files.length > 0, sourceNote: 'Harness recommendation; GET /api/models/recommended has the full advice', notes: [] };
  }
}
