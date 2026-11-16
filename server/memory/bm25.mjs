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

export function tokenize(text) {
  if (!text) return [];
  const norm = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const out = [];
  for (const raw of norm.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) || []) {
    if (CJK.test(raw)) { for (const ch of raw) if (CJK.test(ch)) out.push(ch); continue; }
    const w = raw.replace(/['-]+$/g, '').replace(/'s$/, '');
    if (w.length < 2 && !/\d/.test(w)) continue;
    if (STOPWORDS.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

export class BM25Index {
  constructor({ k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.docs = new Map(); // id -> { tf: Map, len }
    this.df = new Map();
    this.totalLen = 0;
  }

  get size() { return this.docs.size; }

  add(id, text) {
    if (this.docs.has(id)) this.remove(id);
    const toks = tokenize(text);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    this.docs.set(id, { tf, len: toks.length });
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.totalLen += toks.length;
  }

  remove(id) {
    const d = this.docs.get(id);
    if (!d) return;
    for (const t of d.tf.keys()) {
      const n = (this.df.get(t) || 1) - 1;
      if (n <= 0) this.df.delete(t); else this.df.set(t, n);
    }
    this.totalLen -= d.len;
    this.docs.delete(id);
  }

  idf(t) {
    const N = this.docs.size;
    const n = this.df.get(t) || 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  /** @returns {Array<{id, score}>} sorted desc; `filter(id)` restricts candidates. */
  search(query, { k = 10, filter } = {}) {
    const qt = [...new Set(tokenize(query))];
    if (!qt.length || !this.docs.size) return [];
    const avg = this.totalLen / this.docs.size || 1;
    const scores = new Map();
    for (const t of qt) {
      if (!this.df.has(t)) continue;
      const idf = this.idf(t);
      for (const [id, d] of this.docs) {
        const f = d.tf.get(t);
        if (!f) continue;
        if (filter && !filter(id)) continue;
        const s = idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / avg)));
        scores.set(id, (scores.get(id) || 0) + s);
      }
    }
    return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score).slice(0, k);
  }

  /** Fraction of distinct query terms present in a doc (0..1) — a corpus-independent relevance signal. */
  coverage(query, id) {
    const qt = [...new Set(tokenize(query))];
    const d = this.docs.get(id);
    if (!qt.length || !d) return 0;
    return qt.filter((t) => d.tf.has(t)).length / qt.length;
  }
}
