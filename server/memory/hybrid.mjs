// Hybrid (BM25 + embeddings) index with incremental persistence:
//   <base>.items.jsonl   append-only log of {op:"put",id,text,meta} / {op:"del",id}
//   <base>.vectors.bin   append-only log of binary records [op u8][idLen u16][id][modelLen u16][model][dim u32][f32 × dim]
// Each save appends only what changed since the last one; the logs are compacted (rewritten atomically) when they
// grow past ~2× the live data. A legacy single-file JSON index (v1) is migrated on first load.
import fs from 'node:fs/promises';
import path from 'node:path';
import { BM25Index, tokenize } from './bm25.mjs';
import { dot, decodeVector } from './vectors.mjs';
import { readJson, writeFileAtomic, readFileData, appendData } from '../lib/fsx.mjs';
import { log } from '../lib/log.mjs';

/** Map that reports set/delete so changes can be persisted incrementally. */
class TrackedMap extends Map {
  constructor(onChange) { super(); this.onChange = onChange; }
  set(k, v) { super.set(k, v); this.onChange?.(k); return this; }
  delete(k) { const had = super.delete(k); if (had) this.onChange?.(k); return had; }
  clear() { super.clear(); this.onChange?.(null); }
}

function encodeVecRecord(op, id, model = '', vec = null) {
  const idB = Buffer.from(id, 'utf8');
  const mB = Buffer.from(model || '', 'utf8');
  const dim = vec ? vec.length : 0;
  const buf = Buffer.alloc(1 + 2 + idB.length + 2 + mB.length + 4 + dim * 4);
  let o = 0;
  buf[o++] = op;
  buf.writeUInt16LE(idB.length, o); o += 2; idB.copy(buf, o); o += idB.length;
  buf.writeUInt16LE(mB.length, o); o += 2; mB.copy(buf, o); o += mB.length;
  buf.writeUInt32LE(dim, o); o += 4;
  if (dim) Buffer.from(vec.buffer, vec.byteOffset, dim * 4).copy(buf, o);
  return buf;
}

function* decodeVecRecords(buf) {
  let o = 0;
  while (o + 9 <= buf.length) {
    const op = buf[o];
    const idLen = buf.readUInt16LE(o + 1);
    if (o + 3 + idLen + 2 > buf.length) return;
    const id = buf.toString('utf8', o + 3, o + 3 + idLen);
    let p = o + 3 + idLen;
    const mLen = buf.readUInt16LE(p); p += 2;
    if (p + mLen + 4 > buf.length) return;
    const model = buf.toString('utf8', p, p + mLen); p += mLen;
    const dim = buf.readUInt32LE(p); p += 4;
    if (dim > 65536 || p + dim * 4 > buf.length) return; // truncated tail (crash mid-append)
    let vec = null;
    if (op === 1 && dim) { vec = new Float32Array(dim); Buffer.from(vec.buffer).set(buf.subarray(p, p + dim * 4)); }
    p += dim * 4;
    yield { op, id, model, vec };
    o = p;
  }
}

export class HybridIndex {
  /**
   * @param {object} o
   * @param {string|null} o.file persistence base path (".json" is stripped; null = memory only)
   * @param {import('./embedder.mjs').Embedder|null} o.embedder
   */
  constructor({ file = null, embedder = null, persistItems = true } = {}) {
    this.file = file;
    this.base = file ? file.replace(/\.json$/, '') : null;
    this.embedder = embedder;
    this.persistItems = persistItems;
    this.items = new Map();
    this._dirtyItems = new Set();
    this._dirtyVecs = new Set();
    this._needsRewrite = false;
    this._logRecords = 0;
    this.vectors = new TrackedMap((k) => { if (k === null) this._needsRewrite = true; else this._dirtyVecs.add(k); });
    this.bm25 = new BM25Index();
    this._saveTimer = null;
    this._saving = Promise.resolve();
    this._embedding = null;
  }

  get itemsFile() { return `${this.base}.items.jsonl`; }
  get vectorsFile() { return `${this.base}.vectors.bin`; }

  async load() {
    if (!this.file) return this;
    const legacy = await readJson(this.file, null);
    if (legacy?.items) {
      for (const it of legacy.items) {
        if (this.persistItems && typeof it.id === 'string' && typeof it.text === 'string') this._put(it.id, it.text, it.meta || {});
        if (it.vec) { try { this.vectors.set(it.id, { model: it.vec.model, vec: decodeVector(it.vec.b64) }); } catch { /* skip */ } }
      }
      this._needsRewrite = true;
      await this.save();
      await fs.rm(this.file, { force: true });
      log.info(`Migrated ${path.basename(this.file)} to incremental index files`);
      return this;
    }
    if (this.persistItems) {
      const txt = await readFileData(this.itemsFile).then((b) => b.toString('utf8'), (e) => { if (e.status === 423) throw e; return ''; });
      let lines = 0;
      for (const line of txt.split('\n')) {
        if (!line) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        this._logRecords++;
        if (r.op === 'put' && typeof r.id === 'string' && typeof r.text === 'string') this.items.set(r.id, { id: r.id, text: r.text, meta: r.meta || {} });
        else if (r.op === 'del' && typeof r.id === 'string') this.items.delete(r.id);
        if (++lines % 2000 === 0) await new Promise((res) => setImmediate(res));
      }
      // Build the lexical index without blocking the event loop for long (yields every 500 documents).
      let n = 0;
      for (const it of this.items.values()) {
        this.bm25.add(it.id, it.text);
        if (++n % 500 === 0) await new Promise((res) => setImmediate(res));
      }
    }
    const bin = await readFileData(this.vectorsFile).catch((e) => { if (e.status === 423) throw e; return null; });
    if (bin) {
      for (const r of decodeVecRecords(bin)) {
        this._logRecords++;
        if (r.op === 1 && r.vec) Map.prototype.set.call(this.vectors, r.id, { model: r.model, vec: r.vec });
        else if (r.op === 2) Map.prototype.delete.call(this.vectors, r.id);
      }
    }
    this._dirtyItems.clear();
    this._dirtyVecs.clear();
    return this;
  }

  _put(id, text, meta) {
    this.items.set(id, { id, text, meta });
    this.bm25.add(id, text);
    if (this.persistItems) this._dirtyItems.add(id);
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
    if (this.persistItems) this._dirtyItems.add(id);
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
    this._needsRewrite = true;
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
    const allTerms = [...new Set(tokenize(query))].slice(0, 2000);
    const used = this.bm25.queryTerms(query);
    // lexical = Σ idf(matched terms) / Σ idf(query terms); unseen terms count in the denominator only.
    const idfSum = allTerms.reduce((a, t) => a + this.bm25.idf(t), 0) || 1;
    const { hits: lexHits, matched } = this.bm25.searchDetailed(query, { k: Math.max(50, k * 5), filter: f, terms: used });
    const lexScore = (id) => (matched.get(id) || 0) / idfSum;
    const cands = new Map();
    for (const h of lexHits) cands.set(h.id, { lexical: lexScore(h.id), semantic: null });
    const useVec = queryVector && queryVector.vec;
    if (useVec) {
      for (const [id, v] of this.vectors) {
        if (v.model !== queryVector.model) continue;
        if (f && !f(id)) continue;
        if (!this.items.has(id)) continue;
        const sim = dot(queryVector.vec, v.vec);
        const c = cands.get(id);
        if (c) c.semantic = sim;
        else if (sim >= minSimilarity) cands.set(id, { lexical: lexScore(id), semantic: sim });
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

  /** Persist changes: append only what changed, or rewrite (compact) when the logs got large. */
  save() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (!this.file) return Promise.resolve();
    this._saving = this._saving.catch(() => {}).then(() => this._save());
    return this._saving;
  }

  async _save() {
    await fs.mkdir(path.dirname(this.base), { recursive: true });
    const live = (this.persistItems ? this.items.size : 0) + this.vectors.size;
    if (this._needsRewrite || this._logRecords > 2 * live + 2000) {
      this._needsRewrite = false;
      this._dirtyItems.clear();
      this._dirtyVecs.clear();
      if (this.persistItems) {
        await writeFileAtomic(this.itemsFile, () => [...this.items.values()].map((it) => JSON.stringify({ op: 'put', id: it.id, text: it.text, meta: it.meta })).join('\n') + (this.items.size ? '\n' : ''));
      }
      await writeFileAtomic(this.vectorsFile, () => Buffer.concat([...this.vectors].map(([id, v]) => encodeVecRecord(1, id, v.model, v.vec))));
      this._logRecords = live;
      return;
    }
    if (this._dirtyItems.size && this.persistItems) {
      const ids = [...this._dirtyItems];
      this._dirtyItems.clear();
      const lines = ids.map((id) => { const it = this.items.get(id); return JSON.stringify(it ? { op: 'put', id, text: it.text, meta: it.meta } : { op: 'del', id }); });
      await appendData(this.itemsFile, lines.join('\n') + '\n');
      this._logRecords += ids.length;
    }
    if (this._dirtyVecs.size) {
      const ids = [...this._dirtyVecs];
      this._dirtyVecs.clear();
      const recs = ids.map((id) => { const v = this.vectors.get(id); return v ? encodeVecRecord(1, id, v.model, v.vec) : encodeVecRecord(2, id); });
      await appendData(this.vectorsFile, Buffer.concat(recs));
      this._logRecords += ids.length;
    }
  }
}
