// Shared request helper for local model / image backends, on top of http-client (no hidden timeouts).
import { httpRequest, isTimeoutError } from './http-client.mjs';
import { ProviderError, isAbortError } from './errors.mjs';
import { withTimeout } from './util.mjs';

/**
 * Map a low-level error to a ProviderError that says which of these happened:
 *  - the caller aborted            → the original AbortError (not an error to report)
 *  - a timeout we configured fired → code 'timeout'           ("Timed out waiting for X …")
 *  - the backend is not reachable  → code 'connection_failed' ("Cannot reach X at URL (ECONNREFUSED)")
 */
export function mapBackendError(e, target, path, { userSignal, signal, timeoutMs } = {}) {
  if (e instanceof ProviderError) return e;
  const timedOut = isTimeoutError(e) || signal?.reason?.name === 'TimeoutError' || userSignal?.reason?.name === 'TimeoutError';
  if (timedOut) {
    const secs = timeoutMs ? ` after ${Math.round(timeoutMs / 1000)} s` : '';
    return new ProviderError(`Timed out waiting for ${target.name} to respond (${path})${secs}`, { status: 504, code: 'timeout', providerId: target.id, cause: e });
  }
  if (userSignal?.aborted || isAbortError(e)) return e;
  const code = e?.code && typeof e.code === 'string' ? e.code : null;
  return new ProviderError(`Cannot reach ${target.name} at ${target.baseUrl}${code ? ` (${code})` : ''}`, { code: 'connection_failed', providerId: target.id, cause: e });
}

/**
 * @param {{baseUrl, name, id, apiKey?}} target
 * @returns {Promise<import('./http-client.mjs').HttpResponse>}
 */
export async function backendFetch(target, path, { method = 'GET', headers = {}, body, rawBody, signal, timeoutMs } = {}) {
  const sig = withTimeout(signal, timeoutMs);
  const h = { ...headers };
  if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
  if (target.apiKey) h.authorization = `Bearer ${target.apiKey}`;
  try {
    return await httpRequest(target.baseUrl + path, { method, headers: h, body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined), signal: sig });
  } catch (e) {
    throw mapBackendError(e, target, path, { userSignal: signal, signal: sig, timeoutMs });
  }
}

/** Iterate a streamed body; a dropped connection becomes a ProviderError instead of a raw socket error. */
export async function* guardStream(iterable, target, path, signal) {
  try {
    for await (const x of iterable) yield x;
  } catch (e) {
    if (signal?.aborted && signal.reason?.name !== 'TimeoutError') throw e;
    if (isTimeoutError(e) || signal?.reason?.name === 'TimeoutError') throw mapBackendError(e, target, path, { signal });
    throw new ProviderError(`Connection to ${target.name} was lost while streaming (${path})`, { code: 'connection_failed', providerId: target.id, cause: e });
  }
}
