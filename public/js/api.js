// The single client for the Harness backend. It mirrors docs/API.md section by section; nothing else in
// the UI calls fetch() directly. Errors are normalised to ApiError { status, code, message, details }.

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

async function parseError(res) {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  const e = body?.error || {};
  return new ApiError(res.status, e.code || `http_${res.status}`, e.message || res.statusText, e.details || null);
}

async function request(method, path, { body, signal, headers = {}, raw = false } = {}) {
  let res;
  const init = { method, signal, headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) init.body = body;
    else { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  }
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Harness is not reachable. Is the app still running?');
  }
  if (!res.ok) throw await parseError(res);
  if (raw) return res;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

const get = (p, o) => request('GET', p, o);
const post = (p, body = {}, o = {}) => request('POST', p, { ...o, body });
const patch = (p, body, o = {}) => request('PATCH', p, { ...o, body });
const put = (p, body, o = {}) => request('PUT', p, { ...o, body });
const del = (p, o) => request('DELETE', p, o);

/**
 * POST an SSE endpoint and deliver each event to onEvent(event). Resolves with the list of terminal
 * events once the stream closes. Setup errors (JSON error before any SSE bytes) reject with ApiError;
 * aborting via `signal` resolves with { aborted: true }.
 */
export async function stream(path, body, onEvent, { signal } = {}) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body ?? {}), signal });
  } catch (e) {
    if (e.name === 'AbortError') return { aborted: true };
    throw new ApiError(0, 'network', 'Harness is not reachable. Is the app still running?');
  }
  if (!res.ok) throw await parseError(res);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('event-stream')) {
    const data = ct.includes('json') ? await res.json() : null;
    return { json: data };
  }
  const reader = res.body.getReader();
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
    onEvent(ev);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
        flush(block);
      }
    }
    if (buf.trim()) flush(buf);
  } catch (e) {
    if (e.name === 'AbortError' || signal?.aborted) return { aborted: true, last };
    throw new ApiError(0, 'stream_interrupted', 'The connection to Harness was interrupted.');
  }
  return { last };
}

// ------------------------------------------------------------------------------------------------ 5.1
export const system = {
  health: () => get('/api/health'),
  info: ({ refresh } = {}) => get(`/api/system${qs({ refresh })}`),
};

// ------------------------------------------------------------------------------------------------ 5.2
export const settings = {
  get: () => get('/api/settings'),
  patch: (partial) => patch('/api/settings', partial),
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
  pull: (body, onEvent, opts) => stream('/api/models/pull', body, onEvent, opts),
  remove: (r) => del(`/api/models${qs(ref(r))}`),
  load: (r) => post('/api/models/load', ref(r)),
  unload: (r) => post('/api/models/unload', ref(r)),
  loaded: () => get('/api/models/loaded'),
  embeddings: () => get('/api/embeddings/status'),
  measurements: (r) => get(`/api/models/measurements${qs(ref(r))}`),
  resetMeasurements: (r) => del(`/api/models/measurements${qs(ref(r))}`),
};

// ------------------------------------------------------------------------------------------------ 5.5–5.8
export const chats = {
  list: ({ archived, q, limit, offset } = {}) => get(`/api/chats${qs({ archived, q, limit, offset })}`),
  create: (body = {}) => post('/api/chats', body),
  get: (id) => get(`/api/chats/${enc(id)}`),
  update: (id, body) => patch(`/api/chats/${enc(id)}`, body),
  remove: (id) => del(`/api/chats/${enc(id)}`),
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
  import: (payload) => post('/api/chats/import', payload),
};

export const search = (q, { limit } = {}, opts = {}) => get(`/api/search${qs({ q, limit })}`, opts);
export const backupUrl = () => '/api/export';

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
  /** Upload a File/Blob; onProgress is not available with fetch, so callers show an indeterminate state. */
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

/** Fire-and-forget request that survives page unload (used to flush pending deletes). */
export function beacon(method, path) {
  try { fetch(path, { method, keepalive: true }); } catch { /* ignore */ }
}
