// Shared HTTP helper for image backends.
import { ProviderError, isAbortError } from '../lib/errors.mjs';
import { withTimeout } from '../lib/util.mjs';

export async function imageRequest(provider, path, { method = 'GET', body, rawBody, headers = {}, signal, timeoutMs, accept404 = false } = {}) {
  let res;
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (provider.apiKey) h.authorization = `Bearer ${provider.apiKey}`;
  try {
    res = await fetch(provider.baseUrl + path, { method, headers: h, body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined), signal: withTimeout(signal, timeoutMs) });
  } catch (e) {
    if (signal?.aborted || isAbortError(e)) throw e;
    if (e?.name === 'TimeoutError') throw new ProviderError(`${provider.name} timed out (${path})`, { code: 'timeout', providerId: provider.id });
    throw new ProviderError(`Cannot reach ${provider.name} at ${provider.baseUrl}`, { code: 'connection_failed', providerId: provider.id, cause: e });
  }
  if (accept404 && res.status === 404) return null;
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
