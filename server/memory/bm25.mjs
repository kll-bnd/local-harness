// Lexical search: tokenizer + incremental in-memory BM25 index.

const STOPWORDS = new Set(`a about above after again against all am an and any are as at be because been before being below between both but by
can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it
its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than
that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who
whom why will with would you your yours yourself yourselves s t don ll ve re d m o y also get got let like can't won't it's i'm i've i'd you're
please thanks thank hi hello hey ok okay yes yeah`.split(/\s+/));

function stem(w) {
  if (w.length <= 4) return w;
  if (w.endsWith('ies') && w.length > 5) return w.slice(0, -3) + 'y';
  if (w.endsWith('ing') && w.length > 6) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 5) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 5 && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 4) return w.slice(0, -1);
  return w;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const ASCII_ONLY = /^[\x00-\x7f]*$/;
const ASCII_WORD = /[a-z0-9][a-z0-9_'-]*/g;
const UNI_WORD = /[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu;

export function tokenize(text) {
  if (!text) return [];
  const ascii = ASCII_ONLY.test(text);
  const norm = ascii ? text.toLowerCase() : text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const out = [];
  for (const raw of norm.match(ascii ? ASCII_WORD : UNI_WORD) || []) {
    if (!ascii && CJK.test(raw)) { for (const ch of raw) if (CJK.test(ch)) out.push(ch); continue; }
    let w = raw;
    if (w.endsWith("'") || w.endsWith('-')) w = w.replace(/['-]+$/g, '');
    if (w.endsWith("'s")) w = w.slice(0, -2);
    if (w.length < 2 && !(w >= '0' && w <= '9')) continue;
    if (STOPWORDS.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

/** Max distinct query terms used per search (the rarest ones): a pasted 1500-word message stays cheap. */
export const MAX_QUERY_TERMS = 48;

export class BM25Index {
  // Inverted index with integer doc numbers and flat posting arrays [docNum, tf, docNum, tf, …]; removed
  // documents are tombstoned and the postings compacted once they make up half of the index. Building and
  // searching cost ∝ matching postings, never ∝ (all docs × query terms).
  constructor({ k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.ids = []; // docNum -> id | null (removed)
    this.num = new Map(); // id -> docNum
    this.lens = []; // docNum -> token count
    this.terms = []; // docNum -> distinct terms (for df bookkeeping on removal)
    this.postings = new Map(); // term -> [docNum, tf, ...]
    this.dfs = new Map(); // term -> live document frequency
    this.totalLen = 0;
    this.dead = 0;
  }

  get size() { return this.num.size; }

  /** { has(id), get(id) → {len} } — compatibility view used by callers. */
  get docs() {
    const self = this;
    return { has: (id) => self.num.has(id), get: (id) => (self.num.has(id) ? { len: self.lens[self.num.get(id)] } : undefined), get size() { return self.num.size; } };
  }

  add(id, text) {
    if (this.num.has(id)) this.remove(id);
    const toks = tokenize(text);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    const n = this.ids.length;
    this.ids.push(id);
    this.num.set(id, n);
    this.lens.push(toks.length);
    this.terms.push([...tf.keys()]);
    for (const [t, f] of tf) {
      let p = this.postings.get(t);
      if (!p) { p = []; this.postings.set(t, p); }
      p.push(n, f);
      this.dfs.set(t, (this.dfs.get(t) || 0) + 1);
    }
    this.totalLen += toks.length;
  }

  remove(id) {
    const n = this.num.get(id);
    if (n === undefined) return;
    for (const t of this.terms[n]) {
      const d = (this.dfs.get(t) || 1) - 1;
      if (d <= 0) this.dfs.delete(t); else this.dfs.set(t, d);
    }
    this.totalLen -= this.lens[n];
    this.ids[n] = null;
    this.terms[n] = [];
    this.num.delete(id);
    if (++this.dead > 1000 && this.dead > this.num.size) this._compact();
  }

  _compact() {
    const ids = [];
    const lens = [];
    const terms = [];
    const remap = new Int32Array(this.ids.length).fill(-1);
    this.ids.forEach((id, n) => { if (id !== null) { remap[n] = ids.length; ids.push(id); lens.push(this.lens[n]); terms.push(this.terms[n]); } });
    for (const [t, p] of this.postings) {
      const q = [];
      for (let i = 0; i < p.length; i += 2) { const m = remap[p[i]]; if (m >= 0) q.push(m, p[i + 1]); }
      if (q.length) this.postings.set(t, q); else this.postings.delete(t);
    }
    this.ids = ids;
    this.lens = lens;
    this.terms = terms;
    this.num = new Map(ids.map((id, i) => [id, i]));
    this.dead = 0;
  }

  idf(t) {
    const N = this.num.size;
    const n = this.dfs.get(t) || 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  /** The distinct query terms actually used (present in the index, rarest first, capped). */
  queryTerms(query) {
    const qt = [...new Set(tokenize(query))].filter((t) => this.dfs.has(t));
    if (qt.length <= MAX_QUERY_TERMS) return qt;
    return qt.sort((a, b) => this.dfs.get(a) - this.dfs.get(b)).slice(0, MAX_QUERY_TERMS);
  }

  /**
   * Score matching documents. Returns { hits: [{id, score}] (top k), matched: Map(id → Σ idf of matched terms) }.
   */
  searchDetailed(query, { k = 10, filter, terms } = {}) {
    const matched = new Map();
    if (!this.num.size) return { hits: [], matched };
    const qt = terms || this.queryTerms(query);
    if (!qt.length) return { hits: [], matched };
    const avg = this.totalLen / this.num.size || 1;
    const scores = new Map();
    for (const t of qt) {
      const p = this.postings.get(t);
      if (!p) continue;
      const idf = this.idf(t);
      for (let i = 0; i < p.length; i += 2) {
        const id = this.ids[p[i]];
        if (id === null) continue;
        if (filter && !filter(id)) continue;
        const f = p[i + 1];
        const sc = idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.lens[p[i]]) / avg)));
        scores.set(id, (scores.get(id) || 0) + sc);
        matched.set(id, (matched.get(id) || 0) + idf);
      }
    }
    const hits = [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score).slice(0, k);
    return { hits, matched };
  }

  /** @returns {Array<{id, score}>} sorted desc; `filter(id)` restricts candidates. */
  search(query, { k = 10, filter } = {}) {
    return this.searchDetailed(query, { k, filter }).hits;
  }

  /** Fraction of distinct query terms present in a doc (0..1). */
  coverage(query, id) {
    const qt = [...new Set(tokenize(query))];
    const n = this.num.get(id);
    if (!qt.length || n === undefined) return 0;
    const set = new Set(this.terms[n]);
    return qt.filter((t) => set.has(t)).length / qt.length;
  }
}
