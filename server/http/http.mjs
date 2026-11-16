// HTTP plumbing: router, body parsing, JSON/SSE responses, localhost-only security, static files.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError, ProviderError, toErrorPayload } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';

// ---------------------------------------------------------------------------------------------- router
export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (m, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler, opts, pattern });
  }
  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  put(p, h, o) { this.add('PUT', p, h, o); }
  patch(p, h, o) { this.add('PATCH', p, h, o); }
  delete(p, h, o) { this.add('DELETE', p, h, o); }
  match(method, pathname) {
    let allowed = null;
    for (const r of this.routes) {
      const m = pathname.match(r.re);
      if (!m) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) { (allowed ||= []).push(r.method); continue; }
      const params = {};
      try {
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      } catch {
        throw new HttpError(400, 'bad_request', 'Malformed percent-encoding in URL');
      }
      return { route: r, params };
    }
    return allowed ? { allowed } : null;
  }
}

// ---------------------------------------------------------------------------------------------- body
export async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', `Request body exceeds ${Math.round(limit / 1024 / 1024)} MB`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, { limit, optional = false } = {}) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  const buf = await readBody(req, limit);
  if (!buf.length) {
    if (optional) return {};
    throw new HttpError(400, 'bad_request', 'JSON body required');
  }
  if (!ct.includes('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (v === null || typeof v !== 'object') throw new Error('not an object');
    return v;
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body is not valid JSON');
  }
}

// ---------------------------------------------------------------------------------------------- responses
export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data), ...headers });
  res.end(data);
}

export function sendError(res, e) {
  const { status, body } = toErrorPayload(e);
  if (status >= 500 && !(e instanceof HttpError) && !(e instanceof ProviderError)) log.error('Request failed:', e?.stack || e);
  sendJson(res, status, body);
}

/**
 * Open an SSE stream on a response. Each event is written as
 *   event: <type>\n data: <json>\n\n
 * and the JSON always carries `type` too, so clients can parse `data:` lines alone.
 */
export function openSse(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.socket?.setNoDelay?.(true);
  res.write(': harness stream\n\n');
  let closed = false;
  let seq = 0;
  const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15000);
  ping.unref?.();
  const ac = new AbortController();
  const onClose = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    ac.abort();
  };
  res.on('close', onClose);
  req.on('aborted', onClose);
  return {
    signal: ac.signal,
    get closed() { return closed; },
    send(type, data = {}) {
      if (closed) return false;
      seq++;
      res.write(`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      return true;
    },
    end() {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      res.end();
    },
  };
}

// ---------------------------------------------------------------------------------------------- security
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Baseline CSP sent with every HTML page (the UI adds a stricter <meta> policy of its own). */
export const HTML_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function hostnameOf(hostHeader) {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

export function extraAllowedOrigins() {
  return (process.env.HARNESS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * DNS-rebinding + CSRF protection. Returns null if allowed, else a reason.
 * - Host must be localhost / 127.0.0.1 / [::1] (any port).
 * - Origin (when present) must be this server's own origin (same port) or explicitly allowed
 *   (`HARNESS_ALLOWED_ORIGINS`, `settings.security.allowedOrigins`); "null" and everything else is rejected.
 * - Sec-Fetch-Site: cross-site is rejected unless the Origin is explicitly allowed.
 */
export function checkRequestOrigin(req, { ownPort = null, allowed = [] } = {}) {
  const host = hostnameOf(req.headers.host);
  if (!host || !LOCAL_HOSTNAMES.has(host)) return `Host "${req.headers.host || ''}" is not allowed`;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!isAllowedOrigin(origin, { ownPort: ownPort ?? req.socket?.localPort, allowed })) return `Origin "${origin}" is not allowed`;
  } else if (req.headers['sec-fetch-site'] === 'cross-site') {
    return 'Cross-site request rejected';
  }
  return null;
}

export function isAllowedOrigin(origin, { ownPort = null, allowed = [] } = {}) {
  if (typeof origin !== 'string' || !origin || origin === 'null') return false;
  const extra = [...extraAllowedOrigins(), ...(allowed || [])].map((o) => String(o).replace(/\/+$/, ''));
  if (extra.includes(origin)) return true;
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return u.protocol === 'http:' && LOCAL_HOSTNAMES.has(host === '::1' ? '[::1]' : host) && ownPort != null && port === Number(ownPort);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------- static
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

export async function serveStatic(req, res, publicDir, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return false; }
  if (rel.includes('\0')) return false;
  let file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(path.normalize(publicDir + path.sep)) && file !== path.normalize(publicDir)) return false;
  let st = await fsp.stat(file).catch(() => null);
  if (st?.isDirectory()) { file = path.join(file, 'index.html'); st = await fsp.stat(file).catch(() => null); }
  if (!st || !st.isFile()) {
    // SPA fallback for extension-less paths
    if (path.extname(rel)) return false;
    file = path.join(publicDir, 'index.html');
    st = await fsp.stat(file).catch(() => null);
    if (!st) return false;
  }
  const ext = path.extname(file).toLowerCase();
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
  if (ext === '.html' || ext === '.htm') headers['content-security-policy'] = HTML_CSP;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}
