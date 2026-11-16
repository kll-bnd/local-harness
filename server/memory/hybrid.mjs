// Hybrid (BM25 + embeddings) index with JSON persistence of items and vectors.
import { BM25Index, tokenize } from './bm25.mjs';
import { dot, encodeVector, decodeVector } from './vectors.mjs';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';
import { log } from '../lib/log.mjs';

export class HybridIndex {
  /**
   * @param {object} o
   * @param {string|null} o.file persistence path (null = memory only)
   * @param {import('./embedder.mjs').Embedder|null} o.embedder
   */
  constructor({ file = null, embedder = null, persistItems = true } = {}) {
    this.file = file;
    this.embedder = embedder;
    this.persistItems = persistItems;
    this.items = new Map();
    this.vectors = new Map(); // id -> { model, vec }
    this.bm25 = new BM25Index();
    this._saveTimer = null;
    this._embedding = null;
  }

  async load() {
    if (!this.file) return this;
    const j = await readJson(this.file, null);
    for (const it of j?.items || []) {
      if (this.persistItems) this._put(it.id, it.text, it.meta || {});
      if (it.vec) {
        try { this.vectors.set(it.id, { model: it.vec.model, vec: decodeVector(it.vec.b64) }); } catch { /* skip */ }
      }
    }
    return this;
  }

  _put(id, text, meta) {
    this.items.set(id, { id, text, meta });
    this.bm25.add(id, text);
  }

  upsert(id, text, meta = {}) {
    const prev = this.items.get(id);
    this._put(id, text, meta);
    if (prev && prev.text !== text) this.vectors.delete(id);
    this.scheduleSave();
  }

  remove(id) {
    if (!this.items.has(id)) return false;
    this.items.delete(id);
    this.bm25.remove(id);
    this.vectors.delete(id);
    this.scheduleSave();
    return true;
  }

  removeWhere(pred) {
    let n = 0;
    for (const it of [...this.items.values()]) if (pred(it)) { this.remove(it.id); n++; }
    return n;
  }

  clear() {
    this.items.clear();
    this.vectors.clear();
    this.bm25 = new BM25Index();
    this.scheduleSave();
  }

  get size() { return this.items.size; }

  /** Embed items lacking a vector for the current embedding model. Safe to call often. */
  async ensureEmbeddings({ signal, filter } = {}) {
    if (!this.embedder) return 0;
    if (this._embedding) return this._embedding;
    this._embedding = (async () => {
      const { ref } = await this.embedder.resolve();
      if (!ref) return 0;
      const todo = [...this.items.values()].filter((it) => (!filter || filter(it)) && this.vectors.get(it.id)?.model !== ref.model);
      let done = 0;
      for (let i = 0; i < todo.length; i += 32) {
        const batch = todo.slice(i, i + 32);
        const r = await this.embedder.embed(batch.map((b) => b.text), { kind: 'document', signal });
        if (!r) break;
        batch.forEach((b, n) => { if (this.items.has(b.id)) this.vectors.set(b.id, { model: r.model, vec: r.vectors[n] }); });
        done += batch.length;
      }
      if (done) this.scheduleSave();
      return done;
    })().catch((e) => { log.warn('ensureEmbeddings failed:', e.message); return 0; }).finally(() => { this._embedding = null; });
    return this._embedding;
  }

  /**
   * Search. `queryVector` = `{model, vec}` from Embedder (or null for lexical-only).
   * Returns `[{ id, item, score, semantic, lexical }]` sorted by score.
   */
  search(query, { k = 5, filter, queryVector = null, minSimilarity = 0.5, minLexical = 0.12 } = {}) {
    const f = filter ? (id) => filter(this.items.get(id)) : null;
    const lexHits = this.bm25.search(query, { k: Math.max(50, k * 5), filter: f });
    const qTerms = [...new Set(tokenize(query))];
    const idfSum = qTerms.reduce((a, t) => a + this.bm25.idf(t), 0) || 1;
    const lexScore = (id) => {
      const d = this.bm25.docs.get(id);
      if (!d) return 0;
      let s = 0;
      for (const t of qTerms) if (d.tf.has(t)) s += this.bm25.idf(t);
      return s / idfSum;
    };
    const cands = new Map();
    for (const h of lexHits) cands.set(h.id, { lexical: lexScore(h.id), semantic: null });
    const useVec = queryVector && queryVector.vec;
    if (useVec) {
      for (const [id, v] of this.vectors) {
        if (v.model !== queryVector.model) continue;
        if (f && !f(id)) continue;
        if (!this.items.has(id)) continue;
        const s = dot(queryVector.vec, v.vec);
        const c = cands.get(id) || { lexical: lexScore(id), semantic: null };
        c.semantic = s;
        cands.set(id, c);
      }
    }
    const out = [];
    for (const [id, c] of cands) {
      let score;
      let ok;
      if (c.semantic !== null) {
        score = 0.75 * c.semantic + 0.25 * c.lexical;
        ok = c.semantic >= minSimilarity || c.lexical >= 0.5;
      } else {
        score = c.lexical;
        ok = c.lexical >= minLexical;
      }
      if (ok) out.push({ id, item: this.items.get(id), score, semantic: c.semantic, lexical: c.lexical });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, k);
  }

  scheduleSave() {
    if (!this.file || this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.save().catch((e) => log.warn('index save failed', e.message)); }, 300);
    this._saveTimer.unref?.();
  }

  async save() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (!this.file) return;
    const items = [...this.items.values()].map((it) => {
      const v = this.vectors.get(it.id);
      return { id: it.id, ...(this.persistItems ? { text: it.text, meta: it.meta } : {}), ...(v ? { vec: { model: v.model, b64: encodeVector(v.vec) } } : {}) };
    });
    await writeJsonAtomic(this.file, { version: 1, items }, { pretty: false });
  }
}
