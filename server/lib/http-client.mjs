// Minimal HTTP client on node:http/https for calls to local backends (Ollama, llama.cpp, Draw Things, ComfyUI…).
//
// Why not global fetch: undici's default headersTimeout/bodyTimeout (300 s) kill legitimate long calls — a
// diffusion job that answers only when finished, or Ollama /api/chat, which sends no headers until the first
// token (model load + a big prompt on an 8 GB Mac can exceed 5 minutes). Here the ONLY timeouts are the ones
// the caller passes (AbortSignal, e.g. AbortSignal.timeout(ms)); the socket itself never times out.
//
// Errors:  connection problems → Error with .code (ECONNREFUSED, ENOTFOUND, ECONNRESET, …) and name 'HttpConnectError'
//          caller timeout       → the signal's reason (DOMException name 'TimeoutError')
//          caller abort         → the signal's reason (DOMException name 'AbortError')
import http from 'node:http';
import https from 'node:https';
import { assertEgress } from '../security/egress.mjs';

const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 32 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 32 });

class Headers {
  constructor(raw) { this.raw = raw || {}; }
  get(name) {
    const v = this.raw[String(name).toLowerCase()];
    return Array.isArray(v) ? v.join(', ') : (v ?? null);
  }
}

export class HttpResponse {
  constructor(res, url) {
    this.status = res.statusCode;
    this.ok = res.statusCode >= 200 && res.statusCode < 300;
    this.headers = new Headers(res.headers);
    this.url = url;
    /** Async-iterable of Buffers (node IncomingMessage). */
    this.body = res;
  }

  async buffer() {
    const chunks = [];
    for await (const c of this.body) chunks.push(c);
    return Buffer.concat(chunks);
  }

  async text() { return (await this.buffer()).toString('utf8'); }

  async json() {
    const t = await this.text();
    return t ? JSON.parse(t) : {};
  }

  async arrayBuffer() {
    const b = await this.buffer();
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }

  cancel() { this.body.destroy(); }
}

function connectError(err, url) {
  const e = new Error(`${err.code || 'connection error'} ${url.host}`);
  e.name = 'HttpConnectError';
  e.code = err.code || 'ECONNERROR';
  e.cause = err;
  return e;
}

/**
 * @param {string|URL} input
 * @param {object} [o]
 * @param {string} [o.method]
 * @param {object} [o.headers]
 * @param {string|Buffer|Uint8Array} [o.body]
 * @param {AbortSignal} [o.signal]   the only timeout mechanism (abort/timeout at any stage, incl. while streaming)
 * @param {Function} [o.lookup]      custom DNS lookup (fetch_url pins the vetted address)
 * @param {object} [o.agent]         override agent (false = no keep-alive)
 * @param {string} [o.egress]        what this request is for, in an offline_lock refusal (docs/API.md §10.6)
 * @returns {Promise<HttpResponse>}
 */
export function httpRequest(input, { method = 'GET', headers = {}, body, signal, lookup, agent, egress = 'other' } = {}) {
  const url = input instanceof URL ? input : new URL(input);
  // The single outbound choke point: a non-local destination is refused while internet access is blocked,
  // before any name resolution.
  try { assertEgress(url, egress); } catch (e) { return Promise.reject(e); }
  const isHttps = url.protocol === 'https:';
  if (!isHttps && url.protocol !== 'http:') return Promise.reject(new Error(`Unsupported protocol ${url.protocol}`));
  const mod = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const h = { ...headers };
    let payload = body;
    if (typeof payload === 'string') payload = Buffer.from(payload);
    if (payload) h['content-length'] = payload.length;
    const req = mod.request(url, {
      method,
      headers: h,
      agent: agent !== undefined ? agent : lookup ? false : isHttps ? httpsAgent : httpAgent,
      ...(lookup ? { lookup } : {}),
    });
    let settled = false;
    const onAbort = () => {
      const reason = signal.reason;
      req.destroy(reason instanceof Error ? reason : Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      if (!settled) { settled = true; reject(reason); }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('response', (res) => {
      settled = true;
      res.on('close', () => signal?.removeEventListener('abort', onAbort));
      resolve(new HttpResponse(res, url.toString()));
    });
    req.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      if (signal?.aborted) reject(signal.reason);
      else reject(connectError(err, url));
    });
    if (payload) req.end(payload); else req.end();
  });
}

export const isTimeoutError = (e) => e?.name === 'TimeoutError';
export const isConnectError = (e) => e?.name === 'HttpConnectError';
