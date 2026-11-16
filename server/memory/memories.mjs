// Long-term memory store with dedupe-on-write and hybrid retrieval.
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';
import { newId } from '../lib/ids.mjs';
import { nowIso } from '../lib/util.mjs';
import { notFound, badRequest, HttpError } from '../lib/errors.mjs';
import { tokenize } from './bm25.mjs';
import { dot } from './vectors.mjs';
import { HybridIndex } from './hybrid.mjs';

export const MEMORY_CATEGORIES = ['fact', 'preference', 'project', 'instruction', 'other'];
export const ORIGINS = ['manual', 'auto', 'tool', 'restore'];

// Credentials / secrets that must never be stored in long-term memory (memories are injected into prompts and
// included in backups). Patterns are anchored on distinctive prefixes or keywords and are linear-time.
const SECRET_PATTERNS = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/, // OpenAI / Anthropic style keys
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/, /\bhf_[A-Za-z0-9]{30,}/, /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{30,}/, /\bya29\.[0-9A-Za-z_-]{20,}/,
  /\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/, // Stripe
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bbearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  /\b(?:password|passwd|passcode|passphrase|pass phrase|pin(?: code| number)?|api[ _-]?key|secret(?: key)?|access token|auth token|private key|seed phrase|recovery phrase|2fa code|otp|cvv|cvc|security code)\b[^.\n]{0,24}?\b(?:is|was|=|:|are)\s*\S{3,}/i,
  /\b\d{3}-\d{2}-\d{4}\b/, // US SSN
];

function luhnCard(text) {
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const d = m[0].replace(/[ -]/g, '');
    if (d.length < 13 || d.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let x = d.charCodeAt(d.length - 1 - i) - 48;
      if (i % 2) { x *= 2; if (x > 9) x -= 9; }
      sum += x;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

export function looksLikeSecret(text) {
  const t = String(text || '');
  return SECRET_PATTERNS.some((re) => re.test(t)) || luhnCard(t);
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

  /** Pinned memories that are confirmed (needsReview memories are never injected). */
  pinned() {
    return [...this.items.values()].filter((m) => m.pinned && !m.needsReview).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  _publish(action, memory) {
    this.bus?.publish(`memory.${action}`, { memory });
  }

  /**
   * The one guarded write path for every origin (manual API/UI, the `remember` tool, background extraction,
   * backup restore):
   *  - secrets are never stored: auto/tool/restore origins are skipped (`action: "rejected"`), a manual add is
   *    refused with HttpError 422 `secret_detected` unless `allowSecret: true` is passed explicitly;
   *  - dedupe only merges near-identical statements: an exact repeat is `unchanged`, a refinement that keeps every
   *    word of the old memory and adds at most a few becomes an update; anything else ("John" → "Sarah") is a
   *    new memory;
   *  - auto/tool origins never modify a manual or pinned memory;
   *  - `needsReview` marks memories saved from turns that contained untrusted content (kept out of prompts until
   *    the user confirms them).
   * @returns {{ action: 'added'|'updated'|'unchanged'|'rejected', memory, reason? }}
   */
  async add({ content, category = 'other', pinned = false, source = null, origin = 'manual', dedupe = true, allowSecret = false, needsReview = false }) {
    content = String(content || '').trim().replace(/\s+/g, ' ');
    if (!content) throw badRequest('content is required');
    if (content.length > 2000) throw badRequest('content is too long (max 2000 chars)');
    if (!MEMORY_CATEGORIES.includes(category)) category = 'other';
    if (!ORIGINS.includes(origin)) origin = 'manual';
    if (looksLikeSecret(content) && !(origin === 'manual' && allowSecret)) {
      if (origin === 'manual') throw new HttpError(422, 'secret_detected', 'This looks like a password, key or other secret. Memories are sent to the model and included in backups, so it was not saved. Pass allowSecret: true to save it anyway.');
      return { action: 'rejected', memory: null, reason: 'secret' };
    }
    if (dedupe) {
      const emb = dedupe === 'exact' ? null : await this.embedder?.embed([content], { kind: 'document' }).catch(() => null);
      const vector = emb ? { model: emb.model, vec: emb.vectors[0] } : null;
      const sim = this.findDuplicate(content, { vector, exactOnly: dedupe === 'exact' });
      if (sim) {
        const target = sim.memory;
        const protectedTarget = (target.pinned || target.origin === 'manual') && origin !== 'manual';
        if (sim.kind === 'exact' || protectedTarget) {
          if (!protectedTarget) {
            target.updatedAt = nowIso();
            if (pinned && !target.pinned) target.pinned = true;
            if (origin === 'manual' && target.needsReview) target.needsReview = false;
            await this.save();
          }
          return { action: 'unchanged', memory: target, ...(protectedTarget && sim.kind !== 'exact' ? { reason: 'protected' } : {}) };
        }
        const updated = await this.update(target.id, { content, ...(pinned ? { pinned: true } : {}) }, { source, origin });
        return { action: 'updated', memory: updated };
      }
    }
    const now = nowIso();
    const m = { id: newId('mem'), content, category, pinned: !!pinned, origin, source, createdAt: now, updatedAt: now, lastUsedAt: null, useCount: 0 };
    if (needsReview && origin !== 'manual') m.needsReview = true;
    this.items.set(m.id, m);
    this.index.upsert(m.id, m.content);
    await this.save();
    this.index.ensureEmbeddings().catch(() => {});
    this._publish('added', m);
    return { action: 'added', memory: m };
  }

  /**
   * A near-duplicate of `content`: exact (normalized) match, or a refinement (new ⊇ old words, ≤ 3 added), or —
   * with embeddings — a cosine ≥ 0.97 paraphrase that shares ≥ 80% of its words. Returns `{memory, kind}` or null.
   */
  findDuplicate(content, { vector = null, exactOnly = false } = {}) {
    const nc = normText(content);
    const A = new Set(tokenize(content));
    let best = null;
    for (const m of this.items.values()) {
      if (normText(m.content) === nc) return { memory: m, kind: 'exact' };
      if (exactOnly) continue;
      const B = new Set(tokenize(m.content));
      if (!A.size || !B.size) continue;
      let inter = 0;
      for (const x of B) if (A.has(x)) inter++;
      const refinement = inter === B.size && A.size - B.size <= 3 && A.size >= B.size;
      let paraphrase = false;
      const v = this.index.vectors.get(m.id);
      if (vector && v && v.model === vector.model) paraphrase = dot(vector.vec, v.vec) >= 0.97 && inter / Math.max(A.size, B.size) >= 0.8;
      if (refinement || paraphrase) {
        const score = inter / (A.size + B.size - inter);
        if (!best || score > best.score) best = { memory: m, kind: refinement ? 'refinement' : 'paraphrase', score };
      }
    }
    return best;
  }

  /** Back-compat helper (tests/tools): best near-duplicate or null. */
  async findSimilar(content, { vector } = {}) {
    const d = this.findDuplicate(content, { vector });
    return d ? { memory: d.memory, similarity: d.kind === 'exact' ? 1 : d.score, method: d.kind } : null;
  }

  /**
   * Update a memory. `origin` = who asks: auto/tool callers may not modify manual or pinned memories.
   * Content changes go through the same secret filter as add().
   */
  async update(id, patch, { source, origin = 'manual', allowSecret = false } = {}) {
    const m = this.get(id);
    if (origin !== 'manual' && (m.pinned || m.origin === 'manual')) throw new HttpError(409, 'memory_protected', 'Manual and pinned memories can only be changed by the user');
    if (patch.content !== undefined) {
      const c = String(patch.content).trim().replace(/\s+/g, ' ');
      if (!c) throw badRequest('content must not be empty');
      if (c.length > 2000) throw badRequest('content is too long (max 2000 chars)');
      if (looksLikeSecret(c) && !(origin === 'manual' && allowSecret)) throw new HttpError(422, 'secret_detected', 'This looks like a password, key or other secret, so it was not saved. Pass allowSecret: true to save it anyway.');
      m.content = c;
      this.index.upsert(m.id, c);
    }
    if (patch.category !== undefined) {
      if (!MEMORY_CATEGORIES.includes(patch.category)) throw badRequest(`category must be one of ${MEMORY_CATEGORIES.join(', ')}`);
      m.category = patch.category;
    }
    if (patch.pinned !== undefined) m.pinned = !!patch.pinned;
    if (patch.needsReview === false || (origin === 'manual' && (patch.pinned === true || patch.content !== undefined))) delete m.needsReview;
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
  search(query, { k = 6, queryVector = null, minSimilarity = 0.5, excludePinned = false, includeUnreviewed = false } = {}) {
    const res = this.index.search(query, {
      k,
      queryVector,
      minSimilarity,
      filter: (it) => it && this.items.has(it.id) && (!excludePinned || !this.items.get(it.id).pinned) && (includeUnreviewed || !this.items.get(it.id).needsReview),
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
