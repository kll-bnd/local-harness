// Outbound requests of the model catalogue: no token, cookie or identifying header (a generic User-Agent), bounded
// in time and size, through the single egress choke point, and cached in memory only.
import { httpRequest } from '../lib/http-client.mjs';
import { assertEgress } from '../security/egress.mjs';
import { HttpError } from '../lib/errors.mjs';

export const USER_AGENT = 'Harness/0.2 (model catalogue)';
export const CACHE_TTL_MS = 5 * 60 * 1000;

export const bases = () => ({
  hf: (process.env.HARNESS_CATALOG_HF_BASE || 'https://huggingface.co').replace(/\/+$/, ''),
  hfRegistry: (process.env.HARNESS_CATALOG_HF_REGISTRY || 'https://hf.co').replace(/\/+$/, ''),
  ollama: (process.env.HARNESS_CATALOG_OLLAMA_BASE || 'https://ollama.com').replace(/\/+$/, ''),
});

export class CatalogUnavailable extends HttpError {
  constructor(source, message) { super(502, 'catalog_unavailable', message, { source }); }
}

/**
 * GET `url` → { status, headers, text, url }. Follows up to 3 redirects to the same site. Never sends cookies or
 * credentials. Throws CatalogUnavailable on network errors / timeouts / oversize bodies.
 */
export async function catalogGet(url, { source, accept = 'application/json', maxBytes = 4 * 1024 * 1024, timeoutMs = 15000, okStatuses = null } = {}) {
  let target = new URL(url);
  const origin = target.hostname.split('.').slice(-2).join('.');
  for (let hop = 0; hop < 4; hop++) {
    assertEgress(target, 'model_catalog');
    let res;
    try {
      res = await httpRequest(target.href, { method: 'GET', headers: { 'user-agent': USER_AGENT, accept, 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (e?.code === 'offline_lock') throw e;
      throw new CatalogUnavailable(source, `${source === 'ollama' ? 'ollama.com' : 'Hugging Face'} did not answer (${e?.name === 'TimeoutError' ? 'timeout' : e?.code || 'connection error'}).`);
    }
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      res.cancel();
      const next = new URL(res.headers.get('location'), target);
      if (next.protocol !== target.protocol || next.hostname.split('.').slice(-2).join('.') !== origin) throw new CatalogUnavailable(source, 'The site redirected somewhere else; not followed.');
      target = next;
      continue;
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const c of res.body) {
        size += c.length;
        if (size > maxBytes) { res.cancel(); throw new CatalogUnavailable(source, 'The answer was larger than expected; not read.'); }
        chunks.push(c);
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new CatalogUnavailable(source, `Reading the answer failed (${e?.code || e?.name || 'error'}).`);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (okStatuses && !okStatuses.includes(res.status)) return { status: res.status, headers: res.headers, text, url: target.href };
    return { status: res.status, headers: res.headers, text, url: target.href };
  }
  throw new CatalogUnavailable(source, 'Too many redirects.');
}

/** Small bounded in-memory TTL cache (never written to disk). */
export class TtlCache {
  constructor({ ttlMs = CACHE_TTL_MS, maxEntries = 200, maxBytes = 24 * 1024 * 1024 } = {}) {
    this.ttlMs = ttlMs; this.maxEntries = maxEntries; this.maxBytes = maxBytes;
    this.map = new Map();
    this.bytes = 0;
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expires) { this._drop(key, e); return undefined; }
    return e.value;
  }
  set(key, value, bytes = 1024) {
    const old = this.map.get(key);
    if (old) this._drop(key, old);
    this.map.set(key, { value, bytes, expires: Date.now() + this.ttlMs, at: Date.now() });
    this.bytes += bytes;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const [k, e] = this.map.entries().next().value;
      this._drop(k, e);
    }
  }
  _drop(k, e) { this.map.delete(k); this.bytes -= e.bytes; }
  clear() { this.map.clear(); this.bytes = 0; }
}
