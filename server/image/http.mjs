// Shared HTTP helper for image backends.
import { ProviderError } from '../lib/errors.mjs';
import { backendFetch } from '../lib/backend-http.mjs';

export async function imageRequest(provider, path, { method = 'GET', body, rawBody, headers = {}, signal, timeoutMs, accept404 = false } = {}) {
  const res = await backendFetch(provider, path, { method, body, rawBody, headers, signal, timeoutMs });
  if (accept404 && res.status === 404) { res.cancel(); return null; }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try { const j = JSON.parse(text); msg = j.error?.message || j.error || j.detail || j.message || text; if (typeof msg !== 'string') msg = JSON.stringify(msg); } catch { /* plain */ }
    throw new ProviderError(`${provider.name}: ${String(msg || `HTTP ${res.status}`).slice(0, 500)}`, { status: res.status === 404 ? 404 : 502, code: res.status === 404 ? 'not_found' : 'provider_error', providerId: provider.id });
  }
  return res;
}

export async function imageJson(provider, path, opts) {
  const res = await imageRequest(provider, path, opts);
  if (!res) return null;
  const t = await res.text();
  return t ? JSON.parse(t) : {};
}

export function sniffImageMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF') return 'image/webp';
  return 'image/png';
}
