// The single client for the Harness backend. It mirrors docs/API.md section by section; nothing else in
// the UI talks to the backend. Every request — JSON, uploads, streamed replies and the global event stream —
// goes through ONE function, `transport()`, so the native Mac app (which may have no HTTP server at all) can
// carry the traffic over its own bridge by defining `window.harnessTransport` with the same shape.
// Errors are normalised to ApiError { status, code, message, details }.

export class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message || code || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'unknown';
    this.details = details;
  }
}

const enc = encodeURIComponent;
const qs = (o = {}) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false);
  return p.length ? `?${p.map(([k, v]) => `${enc(k)}=${enc(v === true ? '1' : v)}`).join('&')}` : '';
};

// ------------------------------------------------------------------------------------------------ transport
/**
 * The transport contract (also what `window.harnessTransport` must implement):
 *
 *   transport(request) → Promise<response>
 *   request  = { method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE',
 *                path: '/api/…?query'           — always a relative path starting with /api/
 *                headers: { [lower-case name]: string },
 *                body: Uint8Array | null       — always bytes (JSON already UTF-8 encoded, uploads read into
 *                                                 memory): WKWebView drops Blob/File/FormData bodies
 *                signal: AbortSignal            — on abort: cancel the request, stop the body, reject with an
 *                                                 Error whose name is 'AbortError'
 *                keepalive: boolean }           — hint: the page may be unloading (fetch keepalive)
 *   response = { status: number,
 *                headers: { [lower-case name]: string },
 *                body: AsyncIterable<Uint8Array> — the body in order, chunk by chunk, as soon as it arrives
 *                                                  (server-sent event streams must not be buffered) }
 *
 * A network-level failure (nothing reached the backend) rejects with a TypeError, like fetch.
 */
async function fetchTransport({ method, path, headers, body, signal, keepalive }) {
  const res = await fetch(path, { method, headers, body: body ?? undefined, signal, keepalive: !!keepalive, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  const out = {};
  res.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return { status: res.status, headers: out, body: readerChunks(res.body, signal) };
}

async function* readerChunks(stream, signal) {
  if (!stream) return;
  const reader = stream.getReader();
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}

export function transport(req) {
  const t = typeof window !== 'undefined' && typeof window.harnessTransport === 'function' ? window.harnessTransport : fetchTransport;
  return t(req);
}

/** Observers of every response (security gate: 401 auth_required / 423 locked → lock screen). */
const responseHooks = new Set();
export function onApiError(fn) { responseHooks.add(fn); return () => responseHooks.delete(fn); }
/** Observers of every request sent (method, path) — e.g. to know when Harness last saw the user act. */
const requestHooks = new Set();
export function onApiRequest(fn) { requestHooks.add(fn); return () => requestHooks.delete(fn); }

const textEncoder = new TextEncoder();

async function collect(body) {
  const parts = [];
  let n = 0;
  for await (const c of body) { parts.push(c); n += c.length; }
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of parts) { all.set(c, o); o += c.length; }
  return all;
}
const decodeText = (bytes) => new TextDecoder().decode(bytes);

function errorFrom(status, bytes) {
  let body = null;
  try { body = JSON.parse(decodeText(bytes)); } catch { /* not JSON */ }
  const e = body?.error || {};
  const err = new ApiError(status, e.code || `http_${status}`, e.message || `HTTP ${status}`, e.details || null);
  for (const fn of responseHooks) { try { fn(err); } catch { /* observer failed */ } }
  return err;
}

/** One request through the transport. body: plain object (sent as JSON), Blob/File/ArrayBuffer/Uint8Array (sent as
 *  bytes) or undefined. Never reads statusText (WebKit reports wrong ones for custom schemes). */
async function send(method, path, { body, signal, headers = {}, keepalive = false } = {}) {
  const h = { accept: 'application/json', ...headers };
  let payload = null;
  if (body !== undefined && body !== null) {
    // Bodies are always bytes: WKWebView drops Blob/File/FormData bodies on custom schemes (harness://app).
    if (body instanceof Uint8Array) payload = body;
    else if (body instanceof ArrayBuffer) payload = new Uint8Array(body);
    else if (body instanceof Blob) payload = new Uint8Array(await body.arrayBuffer());
    else { payload = textEncoder.encode(JSON.stringify(body)); h['content-type'] = 'application/json'; }
  }
  for (const fn of requestHooks) { try { fn(method, path); } catch { /* observer failed */ } }
  // Every request can be stopped by abortAll() (Harness locking); keepalive ones are meant to outlive the page.
  const ctl = new AbortController();
  if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', () => ctl.abort(), { once: true }); }
  if (!keepalive) inflight.add(ctl);
  try {
    const res = await transport({ method, path, headers: h, body: payload, signal: ctl.signal, keepalive });
    return { ...res, body: settleWith(res.body, () => inflight.delete(ctl)) };
  } catch (e) {
    inflight.delete(ctl);
    if (e?.name === 'AbortError' || ctl.signal.aborted) throw abortError();
    throw new ApiError(0, 'network', 'Harness is not reachable. Is the app still running?');
  }
}

const inflight = new Set();
const abortError = () => { const e = new Error('Aborted'); e.name = 'AbortError'; return e; };
async function* settleWith(body, done) {
  try { for await (const c of body) yield c; } finally { done(); }
}

/**
 * Stop every request in flight (Harness is locking and the page is about to be replaced): they end as quiet
 * AbortErrors here instead of being cancelled by the navigation, which some engines report as page errors.
 */
export function abortAll() {
  for (const c of inflight) { try { c.abort(); } catch { /* ignore */ } }
  inflight.clear();
}

/** JSON (or text) request; non-2xx → ApiError. */
async function request(method, path, opts = {}) {
  const res = await send(method, path, opts);
  let bytes;
  try { bytes = await collect(res.body); } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(0, 'stream_interrupted', 'The connection to Harness was interrupted.');
  }
  if (res.status < 200 || res.status >= 300) throw errorFrom(res.status, bytes);
  if (opts.raw) return { status: res.status, headers: res.headers, bytes };
  const ct = res.headers['content-type'] || '';
  const text = decodeText(bytes);
  return ct.includes('json') ? (text ? JSON.parse(text) : null) : text;
}

const get = (p, o) => request('GET', p, o);
/** A request the backend described itself (e.g. error.details.allow of offline_lock). Only /api/ paths. */
export function call(method, path, body) {
  if (typeof path !== 'string' || !path.startsWith('/api/') || !/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) throw new ApiError(0, 'bad_request', 'Not a Harness API request.');
  return request(method, path, method === 'GET' ? {} : { body: body ?? {} });
}
const post = (p, body = {}, o = {}) => request('POST', p, { ...o, body });
const patch = (p, body, o = {}) => request('PATCH', p, { ...o, body });
const put = (p, body, o = {}) => request('PUT', p, { ...o, body });
const del = (p, o) => request('DELETE', p, o);

/** Incremental server-sent-events parser over a chunk iterator. Calls onEvent({type, …data}, eventName). */
async function readSse(body, onEvent) {
  const decoder = new TextDecoder();
  let buf = '';
  let last = null;
  const flush = (block) => {
    let type = null;
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    let ev;
    try { ev = JSON.parse(data.join('\n')); } catch { return; }
    if (!ev.type && type) ev.type = type;
    last = ev;
    onEvent(ev, type);
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      flush(block);
    }
  }
  if (buf.trim()) flush(buf);
  return last;
}

/**
 * Open an SSE endpoint (POST by default) and deliver each event to onEvent(event). Setup errors (a JSON error
 * before any SSE bytes) reject with ApiError; aborting via `signal` resolves with { aborted: true }.
 */
export async function stream(path, body, onEvent, { signal, method = 'POST', headers = {} } = {}) {
  let res;
  try {
    res = await send(method, path, { body: method === 'GET' ? undefined : (body ?? {}), signal, headers: { accept: 'text/event-stream', ...headers } });
  } catch (e) {
    if (e?.name === 'AbortError') return { aborted: true };
    throw e;
  }
  if (res.status < 200 || res.status >= 300) throw errorFrom(res.status, await collect(res.body).catch(() => new Uint8Array()));
  const ct = res.headers['content-type'] || '';
  if (!ct.includes('event-stream')) {
    const text = decodeText(await collect(res.body));
    return { json: ct.includes('json') && text ? JSON.parse(text) : null };
  }
  try {
    const last = await readSse(res.body, onEvent);
    return { last };
  } catch (e) {
    if (e?.name === 'AbortError' || signal?.aborted) return { aborted: true };
    throw new ApiError(0, 'stream_interrupted', 'The connection to Harness was interrupted.');
  }
}

/**
 * The global event stream (GET /api/events, docs/API.md 5.1) through the transport: onEvent(data, eventName).
 * Resolves when the stream ends ({ last } — after a lock the final event is `locked`) or { aborted }.
 */
export function events(onEvent, { signal } = {}) {
  return stream('/api/events', undefined, onEvent, { signal, method: 'GET' });
}

/** POST that answers with a file (backup, export): returns { blob, filename }. */
async function postForFile(path, body, { headers = {} } = {}) {
  const r = await request('POST', path, { body, headers: { accept: '*/*', ...headers }, raw: true });
  const cd = r.headers['content-disposition'] || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  return { blob: new Blob([r.bytes], { type: r.headers['content-type'] || 'application/octet-stream' }), filename: m ? decodeURIComponent(m[1]) : null };
}

// ------------------------------------------------------------------------------------------------ 5.1
export const system = {
  health: () => get('/api/health'),
  info: ({ refresh } = {}) => get(`/api/system${qs({ refresh })}`),
};

// ------------------------------------------------------------------------------------------------ 10.1–10.3
/** Base64url of a UTF-8 string (for X-Harness-Backup-Passphrase). */
export function base64url(text) {
  let bin = '';
  for (const b of textEncoder.encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const security = {
  status: () => get('/api/security'),
  setup: (password) => post('/api/security/setup', { password }),
  /** { password } | { recoveryKey } | {} (keychain mode) */
  unlock: (body = {}) => post('/api/security/unlock', body),
  lock: () => post('/api/security/lock', {}),
  /** password may be omitted inside a passwordReset window. */
  changePassword: ({ password, newPassword }) => post('/api/security/password', password ? { password, newPassword } : { newPassword }),
  newRecoveryKey: (password) => post('/api/security/recovery-key', { password }),
  /** From off mode with no password ever set, turning encryption on takes { mode, newPassword } (→ recoveryKey). */
  setMode: ({ password, mode, newPassword }) => post('/api/security/mode', newPassword ? { mode, newPassword } : { password, mode }),
  /** A new data key; everything is re-encrypted (state migrating) and a new recovery key is returned once. */
  rekey: (password) => post('/api/security/rekey', { password }),
  /** → { confirmation, expiresAt }: a single-use X-Harness-Confirm value (2 minutes). */
  confirm: (password) => post('/api/security/confirm', { password }),
  /** The owner has seen the "changed from outside" notice (security.tamper). → { tamper: null } */
  dismissTamper: () => post('/api/security/tamper/dismiss', {}),
  /** The user is here (pointer, keys…): keeps Harness from auto-locking. → { ok, idleLockAt } */
  activity: () => post('/api/security/activity', {}),
};

export const auth = {
  /** Exchange a one-use #launch=<code> for a session cookie. */
  session: (code) => post('/api/auth/session', { code }),
  status: () => get('/api/auth/status'),
  logout: () => post('/api/auth/logout', {}),
};

// ------------------------------------------------------------------------------------------------ 10.4
export const uiState = {
  get: () => get('/api/ui-state'),
  put: (state) => put('/api/ui-state', { state }),
  /** { set: { key: value }, remove: [key] } — top-level keys only. */
  patch: ({ set, remove } = {}, { keepalive = false } = {}) => patch('/api/ui-state', { ...(set ? { set } : {}), ...(remove?.length ? { remove } : {}) }, { keepalive }),
};

export const backup = {
  /** Full backup download; passphrase null → plain harness.backup, otherwise the encrypted envelope. → { blob, filename } */
  create: ({ password, passphrase = null }) => postForFile('/api/export', { password, passphrase }),
};

// ------------------------------------------------------------------------------------------------ 10.6
export const network = {
  /** → the offlineLock status (the backend answers { offlineLock: {…} }). */
  get: () => get('/api/network').then((r) => r?.offlineLock || r),
  /** minutes 1–120; needs the password. → { offlineLock, restartRequired } */
  allow: ({ minutes = 15, password }) => post('/api/network/allow', { minutes, password }),
  block: () => post('/api/network/block', {}),
  /** Turning the blocker off needs the password; turning it on does not. */
  setEnabled: (enabled, { password } = {}) => put('/api/network', enabled ? { enabled: true } : { enabled: false, password }),
  test: () => post('/api/network/test', {}),
};

// ------------------------------------------------------------------------------------------------ 10.8
export const catalog = {
  list: ({ source = 'local', sort, kind, fits, minParams, maxParams, publisher, q, cursor, limit } = {}, opts = {}) =>
    get(`/api/catalog${qs({ source, sort, kind, fits: fits ? 'true' : undefined, minParams, maxParams, publisher, q, cursor, limit })}`, opts),
  model: ({ source, id }, opts = {}) => get(`/api/catalog/model${qs({ source, id })}`, opts),
};

// ------------------------------------------------------------------------------------------------ 5.2
export const settings = {
  get: () => get('/api/settings'),
  /** keepalive: the request survives a reload/quit right after the change (small bodies only). */
  patch: (partial, { keepalive = false } = {}) => patch('/api/settings', partial, { keepalive }),
  reset: () => post('/api/settings/reset'),
};

export const presets = {
  list: () => get('/api/presets'),
  create: (p) => post('/api/presets', p),
  update: (id, p) => patch(`/api/presets/${enc(id)}`, p),
  remove: (id) => del(`/api/presets/${enc(id)}`),
};

// ------------------------------------------------------------------------------------------------ 5.3
export const providers = {
  list: ({ refresh } = {}) => get(`/api/providers${qs({ refresh })}`),
  refresh: () => post('/api/providers/refresh'),
  create: (p) => post('/api/providers', p),
  update: (id, p) => patch(`/api/providers/${enc(id)}`, p),
  remove: (id) => del(`/api/providers/${enc(id)}`),
  startOllama: () => post('/api/providers/ollama/start'),
  stopOllama: () => post('/api/providers/ollama/stop'),
};

// ------------------------------------------------------------------------------------------------ 5.4
const ref = (r) => ({ model: r.model, providerId: r.providerId || undefined });
export const models = {
  list: ({ refresh, details = true } = {}) => get(`/api/models${qs({ refresh, details })}`),
  info: (r, { refresh } = {}) => get(`/api/models/info${qs({ ...ref(r), refresh })}`),
  context: (r, mode) => get(`/api/models/context${qs({ ...ref(r), mode })}`),
  recommended: () => get('/api/models/recommended'),
  /** SSE: start → progress… → done | error */
  pull: (body, onEvent, opts) => stream('/api/models/pull', body, onEvent, opts), // body: { model, providerId?, textOnlyCopy? }
  remove: (r) => del(`/api/models${qs(ref(r))}`),
  load: (r) => post('/api/models/load', ref(r)),
  unload: (r) => post('/api/models/unload', ref(r)),
  loaded: () => get('/api/models/loaded'),
  embeddings: () => get('/api/embeddings/status'),
  measurements: (r) => get(`/api/models/measurements${qs(ref(r))}`),
  /** Text-only copies of multimodal models (same weights, no vision/audio projector; ~1 GB less RAM). */
  textOnlyCopies: () => get('/api/models/text-only'),
  createTextOnly: ({ model, providerId, name } = {}) => post('/api/models/text-only', { model, providerId, name }),
  removeTextOnly: (r) => del(`/api/models/text-only${qs(ref(r))}`),
  resetMeasurements: (r) => del(`/api/models/measurements${qs(ref(r))}`),
};

// ------------------------------------------------------------------------------------------------ 5.5–5.8
export const chats = {
  list: ({ archived, q, limit, offset } = {}) => get(`/api/chats${qs({ archived, q, limit, offset })}`),
  create: (body = {}) => post('/api/chats', body),
  get: (id) => get(`/api/chats/${enc(id)}`),
  update: (id, body) => patch(`/api/chats/${enc(id)}`, body),
  remove: (id, { deleteMemories } = {}) => del(`/api/chats/${enc(id)}${qs({ deleteMemories: deleteMemories ? 'true' : undefined })}`),
  removeUrl: (id) => `/api/chats/${enc(id)}`,
  title: (id) => post(`/api/chats/${enc(id)}/title`),
  fork: (id, messageId) => post(`/api/chats/${enc(id)}/fork`, messageId ? { messageId } : {}),
  context: (id, { draft, signal } = {}) => get(`/api/chats/${enc(id)}/context${qs({ draft })}`, { signal }),

  send: (id, body, onEvent, opts) => stream(`/api/chats/${enc(id)}/messages`, body, onEvent, opts),
  regenerate: (id, mid, body, onEvent, opts) => stream(`/api/chats/${enc(id)}/messages/${enc(mid)}/regenerate`, body || {}, onEvent, opts),
  /** User message → SSE (unless generate:false); assistant message → JSON {message, path}. */
  edit: (id, mid, body, onEvent, opts) => stream(`/api/chats/${enc(id)}/messages/${enc(mid)}/edit`, body, onEvent, opts),
  deleteMessage: (id, mid) => del(`/api/chats/${enc(id)}/messages/${enc(mid)}`),
  branch: (id, messageId) => post(`/api/chats/${enc(id)}/branch`, { messageId }),
  stop: (id) => post(`/api/chats/${enc(id)}/stop`),

  summary: (id) => get(`/api/chats/${enc(id)}/summary`),
  putSummary: (id, content) => put(`/api/chats/${enc(id)}/summary`, { content }),
  deleteSummary: (id) => del(`/api/chats/${enc(id)}/summary`),
  compact: (id, body = {}) => post(`/api/chats/${enc(id)}/compact`, body),

  exportUrl: (id, format = 'markdown', { embedImages } = {}) => `/api/chats/${enc(id)}/export${qs({ format, embedImages })}`,
  import: (payload, { passphrase } = {}) => post('/api/chats/import', payload, { headers: passphrase ? { 'x-harness-backup-passphrase': base64url(passphrase) } : {} }),
};

export const search = (q, { limit } = {}, opts = {}) => get(`/api/search${qs({ q, limit })}`, opts);
/**
 * Restore a harness.backup (merged, new ids). parts: { chats, attachments, images, memories, presets } booleans;
 * settings: 'skip'|'safe'|'full'. confirmation: X-Harness-Confirm from security.confirm(); passphrase for an
 * encrypted backup.
 */
export const restore = (backupData, { settings = 'skip', confirmation, passphrase, ...parts } = {}) => post(
  `/api/restore${qs({ settings, ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v ? '1' : '0'])) })}`,
  backupData,
  { headers: { ...(confirmation ? { 'x-harness-confirm': confirmation } : {}), ...(passphrase ? { 'x-harness-backup-passphrase': base64url(passphrase) } : {}) } },
);

// ------------------------------------------------------------------------------------------------ 5.9
export const memories = {
  list: ({ q, category, pinned, limit, offset } = {}) => get(`/api/memories${qs({ q, category, pinned: pinned === undefined ? undefined : String(pinned), limit, offset })}`),
  create: (body) => post('/api/memories', body),
  update: (id, body) => patch(`/api/memories/${enc(id)}`, body),
  remove: (id) => del(`/api/memories/${enc(id)}`),
  clear: () => del('/api/memories?confirm=true'),
  search: (query, { k, minSimilarity } = {}) => post('/api/memories/search', { query, k, minSimilarity }),
  extract: (chatId, { full } = {}) => post('/api/memories/extract', { chatId, full: !!full }),
};

// ------------------------------------------------------------------------------------------------ 5.10
export const attachments = {
  /** Upload a File/Blob (sent as bytes); progress is not available with fetch, so callers show an indeterminate state. */
  upload: (file, { chatId, signal } = {}) => request('POST', `/api/attachments${qs({ name: file.name || 'pasted', chatId })}`, {
    body: file, signal, headers: { 'content-type': file.type || 'application/octet-stream' },
  }),
  get: (id) => get(`/api/attachments/${enc(id)}`),
  text: (id, { maxChars } = {}) => get(`/api/attachments/${enc(id)}/text${qs({ maxChars })}`),
  remove: (id) => del(`/api/attachments/${enc(id)}`),
  contentUrl: (id) => `/api/attachments/${enc(id)}/content`,
};

// ------------------------------------------------------------------------------------------------ 5.11
export const images = {
  providers: ({ refresh } = {}) => get(`/api/images/providers${qs({ refresh })}`),
  createProvider: (p) => post('/api/images/providers', p),
  updateProvider: (id, p) => patch(`/api/images/providers/${enc(id)}`, p),
  removeProvider: (id) => del(`/api/images/providers/${enc(id)}`),
  models: ({ providerId } = {}) => get(`/api/images/models${qs({ providerId })}`),
  defaults: ({ model, aspect } = {}) => get(`/api/images/defaults${qs({ model, aspect })}`),
  /** SSE: [message×2] image_job → image_status… → image_progress… → image… → image_done → done | error */
  generate: (body, onEvent, opts) => stream('/api/images/generate', { ...body, stream: true }, onEvent, opts),
  jobs: () => get('/api/images/jobs'),
  cancel: (jobId) => post(`/api/images/jobs/${enc(jobId)}/cancel`),
  list: ({ chatId, source, q, limit, offset } = {}) => get(`/api/images${qs({ chatId, source, q, limit, offset })}`),
  get: (id) => get(`/api/images/${enc(id)}`),
  remove: (id) => del(`/api/images/${enc(id)}`),
  fileUrl: (id, { download: dl } = {}) => `/api/images/${enc(id)}/file${qs({ download: dl })}`,
};

/** Fire-and-forget request that should survive page unload (flushes pending deletes / UI state). */
export function beacon(method, path, body) {
  send(method, path, { body, keepalive: true }).then((r) => collect(r.body)).catch(() => {});
}
