// Shared HTTP helper for image backends.
import { ProviderError } from '../lib/errors.mjs';
import { backendFetch } from '../lib/backend-http.mjs';

export async function imageRequest(provider, path, { method = 'GET', body, rawBody, headers = {}, signal, timeoutMs, accept404 = false } = {}) {
  const res = await backendFetch(provider, path, { method, body, rawBody, headers, signal, timeoutMs });
  if (accept404 && res.status === 404) { res.cancel(); return null; }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text;
    let nodeErrors = null;
    try {
      const j = JSON.parse(text);
      msg = j.error?.message || j.error || j.detail || j.message || text;
      if (typeof msg !== 'string') msg = JSON.stringify(msg);
      if (j.error?.details) msg += ` (${String(j.error.details).slice(0, 300)})`;
      // ComfyUI: an invalid workflow is HTTP 400 {error:{message:"Prompt outputs failed validation"}, node_errors:{…}}
      if (j.node_errors && typeof j.node_errors === 'object' && Object.keys(j.node_errors).length) {
        nodeErrors = j.node_errors;
        msg = `${msg}: ${formatNodeErrors(j.node_errors)}`;
      }
    } catch { /* plain */ }
    const e = new ProviderError(`${provider.name}: ${String(msg || `HTTP ${res.status}`).slice(0, 1500)}`, { status: res.status === 404 ? 404 : nodeErrors ? 400 : 502, code: res.status === 404 ? 'not_found' : nodeErrors ? 'workflow_invalid' : 'provider_error', providerId: provider.id });
    if (nodeErrors) e.nodeErrors = nodeErrors;
    throw e;
  }
  return res;
}

/** ComfyUI node_errors → "CheckpointLoaderSimple (node 4): Value not in list — ckpt_name: 'x' not in [...]; …". */
export function formatNodeErrors(nodeErrors) {
  const parts = [];
  for (const [id, ne] of Object.entries(nodeErrors || {})) {
    const errs = Array.isArray(ne?.errors) ? ne.errors : [];
    const what = errs.map((x) => [x?.message, x?.details].filter(Boolean).join(' — ')).filter(Boolean).join('; ') || 'invalid';
    parts.push(`${ne?.class_type || 'node'} (node ${id}): ${what}`);
  }
  return parts.join('; ').slice(0, 1200);
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
