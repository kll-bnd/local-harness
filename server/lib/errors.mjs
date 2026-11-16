/** An error that maps directly onto an HTTP error response `{ error: { code, message, details } }`. */
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'bad_request', message, details);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (code, message) => new HttpError(409, code, message);

/**
 * Error from a model / image backend. `code` is one of:
 * connection_failed, model_not_found, tools_unsupported, thinking_unsupported, not_chat_model,
 * context_overflow, unsupported, timeout, provider_error.
 */
export class ProviderError extends Error {
  constructor(message, { status = 502, code = 'provider_error', providerId, cause } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.providerId = providerId;
    if (cause) this.cause = cause;
  }
}

export function isAbortError(e) {
  return !!e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
}

export function toErrorPayload(e) {
  if (e instanceof HttpError) return { status: e.status, body: { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } } };
  if (e instanceof ProviderError) {
    const status = e.code === 'model_not_found' || e.status === 404 ? 404 : e.code === 'connection_failed' ? 503 : e.code === 'timeout' ? 504 : e.status === 400 ? 400 : 502;
    return { status, body: { error: { code: e.code, message: e.message, ...(e.providerId ? { details: { providerId: e.providerId } } : {}) } } };
  }
  return { status: 500, body: { error: { code: 'internal_error', message: e?.message || String(e) } } };
}
