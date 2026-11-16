// Long-term memory store with dedupe-on-write and hybrid retrieval.
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';
import { newId } from '../lib/ids.mjs';
import { nowIso } from '../lib/util.mjs';
import { notFound, badRequest } from '../lib/errors.mjs';
import { tokenize } from './bm25.mjs';
import { dot } from './vectors.mjs';
import { HybridIndex } from './hybrid.mjs';

export const MEMORY_CATEGORIES = ['fact', 'preference', 'project', 'instruction', 'other'];

const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
export function looksLikeSecret(text) {
  return SECRET_RE.test(text) || /\b(password|passcode|pin code|api key|secret key)\s*(is|=|:)\s*\S+/i.test(text);
}

function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

const normText = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export class MemoryStore {
  constructor({ dataDir, embedder, bus }) {
    this.file = path.join(dataDir, 'memories.json');
    this.bus = bus;
    this.embedder = embedder;
    this.items = new Map();
    this.index = new HybridIndex({ file: path.join(dataDir, 'index', 'memory-vectors.json'), embedder, persistItems: false });
  }

  async load() {
    const j = await readJson(this.file, { version: 1, items: [] });
    for (const m of j.items || []) this.items.set(m.id, m);
    await this.index.load();
    for (const m of this.items.values()) this.index._put(m.id, m.content, {});
    return this;
  }

  async save() {
    await writeJsonAtomic(this.file, { version: 1, items: [...this.items.values()] });
  }

  list({ q, category, pinned, limit = 500, offset = 0 } = {}) {
    let arr = [...this.items.values()];
    if (category) arr = arr.filter((m) => m.category === category);
    if (pinned !== undefined) arr = arr.filter((m) => !!m.pinned === pinned);
    if (q) {
      const needle = q.toLowerCase();
      arr = arr.filter((m) => m.content.toLowerCase().includes(needle));
    }
    arr.sort((a, b) => (b.pinned - a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
    return { total: arr.length, items: arr.slice(offset, offset + limit) };
  }

  get(id) {
    const m = this.items.get(id);
    if (!m) throw notFound('Memory');
    return m;
  }

  pinned() {
    return [...this.items.values()].filter((m) => m.pinned).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Best near-duplicate for `content`, using cosine when vectors are available, else token Jaccard. */
  async findSimilar(content, { vector } = {}) {
    let best = null;
    for (const m of this.items.values()) {
      if (normText(m.content) === normText(content)) return { memory: m, similarity: 1, method: 'exact' };
      const j = jaccard(content, m.content);
      let sim = j;
      let method = 'lexical';
      const v = this.index.vectors.get(m.id);
      if (vector && v && v.model === vector.model) {
        const c = dot(vector.vec, v.vec);
        if (c > sim) { sim = c; method = 'semantic'; }
      }
      if (!best || sim > best.similarity) best = { memory: m, similarity: sim, method };
    }
    return best;
  }

  _publish(action, memory) {
    this.bus?.publish(`memory.${action}`, { memory });
  }

  /**
   * Add a memory with dedupe: near-duplicates update the existing memory instead.
   * @returns {{ action: 'added'|'updated'|'unchanged', memory }}
   */
  async add({ content, category = 'other', pinned = false, source = null, origin = 'manual', dedupe = true }) {
    content = String(content || '').trim().replace(/\s+/g, ' ');
    if (!content) throw badRequest('content is required');
    if (content.length > 2000) throw badRequest('content is too long (max 2000 chars)');
    if (!MEMORY_CATEGORIES.includes(category)) category = 'other';
    if (dedupe) {
      const emb = await this.embedder?.embed([content], { kind: 'document' }).catch(() => null);
      const vector = emb ? { model: emb.model, vec: emb.vectors[0] } : null;
      const sim = await this.findSimilar(content, { vector });
      const threshold = sim?.method === 'semantic' ? 0.92 : 0.7;
      if (sim && sim.similarity >= threshold) {
        if (normText(sim.memory.content) === normText(content)) {
          sim.memory.updatedAt = nowIso();
          if (pinned && !sim.memory.pinned) sim.memory.pinned = true;
          await this.save();
          return { action: 'unchanged', memory: sim.memory };
        }
        const updated = await this.update(sim.memory.id, { content, ...(pinned ? { pinned: true } : {}) }, { source });
        return { action: 'updated', memory: updated };
      }
    }
    const now = nowIso();
    const m = { id: newId('mem'), content, category, pinned: !!pinned, origin, source, createdAt: now, updatedAt: now, lastUsedAt: null, useCount: 0 };
    this.items.set(m.id, m);
    this.index.upsert(m.id, m.content);
    await this.save();
    this.index.ensureEmbeddings().catch(() => {});
    this._publish('added', m);
    return { action: 'added', memory: m };
  }

  async update(id, patch, { source } = {}) {
    const m = this.get(id);
    if (patch.content !== undefined) {
      const c = String(patch.content).trim().replace(/\s+/g, ' ');
      if (!c) throw badRequest('content must not be empty');
      m.content = c;
      this.index.upsert(m.id, c);
    }
    if (patch.category !== undefined) {
      if (!MEMORY_CATEGORIES.includes(patch.category)) throw badRequest(`category must be one of ${MEMORY_CATEGORIES.join(', ')}`);
      m.category = patch.category;
    }
    if (patch.pinned !== undefined) m.pinned = !!patch.pinned;
    if (source) m.source = source;
    m.updatedAt = nowIso();
    await this.save();
    this.index.ensureEmbeddings().catch(() => {});
    this._publish('updated', m);
    return m;
  }

  async delete(id) {
    const m = this.get(id);
    this.items.delete(id);
    this.index.remove(id);
    await this.save();
    this._publish('deleted', m);
    return m;
  }

  async clear() {
    const n = this.items.size;
    this.items.clear();
    this.index.clear();
    await this.save();
    this.bus?.publish('memory.cleared', { count: n });
    return n;
  }

  /** Hybrid retrieval. `queryVector` = `{model, vec}` or null. */
  search(query, { k = 6, queryVector = null, minSimilarity = 0.5, excludePinned = false } = {}) {
    const res = this.index.search(query, {
      k,
      queryVector,
      minSimilarity,
      filter: (it) => it && this.items.has(it.id) && (!excludePinned || !this.items.get(it.id).pinned),
    });
    return res.map((r) => ({ memory: this.items.get(r.id), score: Math.round(r.score * 1000) / 1000, semantic: r.semantic === null ? null : Math.round(r.semantic * 1000) / 1000, lexical: Math.round(r.lexical * 1000) / 1000 }));
  }

  async markUsed(ids) {
    if (!ids.length) return;
    const now = nowIso();
    for (const id of ids) {
      const m = this.items.get(id);
      if (m) { m.lastUsedAt = now; m.useCount = (m.useCount || 0) + 1; }
    }
    await this.save();
  }
}
