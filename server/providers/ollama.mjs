// Ollama native API client (/api/chat, /api/tags, /api/show, /api/pull, /api/delete, /api/ps, /api/embed).
import { ProviderError } from '../lib/errors.mjs';
import { readNdjson } from '../lib/streams.mjs';
import { backendFetch, guardStream } from '../lib/backend-http.mjs';
import { newId } from '../lib/ids.mjs';

export function classifyOllamaError(status, message, providerId) {
  const msg = String(message || `HTTP ${status}`);
  let code = 'provider_error';
  if (/does not support tools/i.test(msg)) code = 'tools_unsupported';
  else if (/does not support thinking|think.*not supported/i.test(msg)) code = 'thinking_unsupported';
  else if (/does not support (chat|generate|completion)/i.test(msg)) code = 'not_chat_model';
  else if (status === 404 || /not found|try pulling/i.test(msg)) code = 'model_not_found';
  else if (/context|too long|exceed/i.test(msg) && /token|context|length/i.test(msg)) code = 'context_overflow';
  return new ProviderError(msg, { status: status === 404 ? 404 : 502, code, providerId });
}

const ns = (v) => (Number.isFinite(v) ? Math.round(v / 1e6) : null);

export function parseArgs(a) {
  if (a && typeof a === 'object') return a;
  if (typeof a === 'string') {
    try { return JSON.parse(a); } catch { return { _raw: a }; }
  }
  return {};
}

/** Parse Ollama's Modelfile `parameters` text ("temperature 1\nstop \"<x>\"") into an object. */
export function parseModelfileParameters(text) {
  const out = {};
  if (!text || typeof text !== 'string') return out;
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(.+)$/);
    if (!m) continue;
    const [, k, rawV] = m;
    let v = rawV.trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    if (k === 'stop') (out.stop ||= []).push(v);
    else out[k] = v;
  }
  return out;
}

/**
 * Ollama parses string keep_alive values with Go's time.ParseDuration, which rejects unit-less strings
 * ("-1", "30") → HTTP 400. Numeric strings are therefore sent as numbers (seconds; negative = forever).
 */
export function normalizeKeepAlive(v) {
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return v;
}

export function toOllamaMessage(m) {
  const out = { role: m.role, content: m.content ?? '' };
  if (m.images?.length) out.images = m.images.map((i) => i.base64);
  if (m.toolCalls?.length) out.tool_calls = m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.arguments || {} } }));
  if (m.role === 'tool' && m.toolName) out.tool_name = m.toolName;
  return out;
}

export class OllamaProvider {
  constructor({ id = 'ollama', name = 'Ollama', baseUrl = 'http://127.0.0.1:11434', builtin = true } = {}) {
    this.id = id;
    this.kind = 'ollama';
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.builtin = builtin;
    this.capabilities = { setContext: true, pull: true, delete: true, unload: true, embeddings: true };
  }

  async request(path, { method = 'GET', body, signal, timeoutMs } = {}) {
    const res = await backendFetch(this, path, { method, body, signal, timeoutMs });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch { /* plain text */ }
      throw classifyOllamaError(res.status, msg || `HTTP ${res.status}`, this.id);
    }
    return res;
  }

  async json(path, opts) {
    const res = await this.request(path, opts);
    const t = await res.text();
    return t ? JSON.parse(t) : {};
  }

  async status() {
    try {
      const j = await this.json('/api/version', { timeoutMs: 1500 });
      return { ok: true, version: j.version || null };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code };
    }
  }

  /** @returns {Promise<Array>} normalized model list entries */
  async listModels() {
    const j = await this.json('/api/tags', { timeoutMs: 5000 });
    return (j.models || []).map((m) => ({
      model: m.model || m.name,
      name: m.name || m.model,
      sizeBytes: m.size ?? null,
      digest: m.digest || null,
      modifiedAt: m.modified_at || null,
      family: m.details?.family || null,
      families: m.details?.families || null,
      parameterSize: m.details?.parameter_size || null,
      quantization: m.details?.quantization_level || null,
      format: m.details?.format || null,
    }));
  }

  async show(model) {
    return this.json('/api/show', { method: 'POST', body: { model }, timeoutMs: 10000 });
  }

  /**
   * Stream a chat completion. Yields normalized events:
   * {type:'content',text} | {type:'thinking',text} | {type:'tool_call',call} | {type:'done',doneReason,usage}
   */
  async *chat({ model, messages, tools, options, keepAlive, think, format, signal }) {
    const body = { model, messages: messages.map(toOllamaMessage), stream: true };
    if (options && Object.keys(options).length) body.options = options;
    if (keepAlive !== undefined && keepAlive !== null) body.keep_alive = normalizeKeepAlive(keepAlive);
    if (tools?.length) body.tools = tools;
    if (think !== undefined && think !== null) body.think = think;
    if (format) body.format = format;
    const res = await this.request('/api/chat', { method: 'POST', body, signal });
    for await (const obj of readNdjson(guardStream(res.body, this, '/api/chat', signal))) {
      if (obj.error) throw classifyOllamaError(500, obj.error, this.id);
      const m = obj.message || {};
      if (m.thinking) yield { type: 'thinking', text: m.thinking };
      if (m.content) yield { type: 'content', text: m.content };
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          yield { type: 'tool_call', call: { id: tc.id || newId('call'), name: tc.function?.name || 'unknown', arguments: parseArgs(tc.function?.arguments) } };
        }
      }
      if (obj.done) {
        yield {
          type: 'done',
          doneReason: obj.done_reason || 'stop',
          usage: {
            promptTokens: obj.prompt_eval_count ?? null,
            completionTokens: obj.eval_count ?? null,
            totalMs: ns(obj.total_duration),
            loadMs: ns(obj.load_duration),
            promptMs: ns(obj.prompt_eval_duration),
            evalMs: ns(obj.eval_duration),
          },
        };
        return;
      }
    }
  }

  async embed({ model, input, keepAlive, signal }) {
    const body = { model, input };
    if (keepAlive !== undefined && keepAlive !== null) body.keep_alive = normalizeKeepAlive(keepAlive);
    const j = await this.json('/api/embed', { method: 'POST', body, signal, timeoutMs: 120000 });
    return j.embeddings || [];
  }

  /** Stream pull progress: yields `{status, digest, total, completed}`. */
  async *pull({ model, signal }) {
    const res = await this.request('/api/pull', { method: 'POST', body: { model, stream: true }, signal });
    for await (const obj of readNdjson(guardStream(res.body, this, '/api/pull', signal))) {
      if (obj.error) throw new ProviderError(obj.error, { code: /not found|does not exist|manifest/i.test(obj.error) ? 'model_not_found' : 'provider_error', providerId: this.id });
      yield { status: obj.status || '', digest: obj.digest || null, total: obj.total ?? null, completed: obj.completed ?? null };
    }
  }

  async deleteModel(model) {
    await this.request('/api/delete', { method: 'DELETE', body: { model }, timeoutMs: 30000 });
  }

  async ps() {
    const j = await this.json('/api/ps', { timeoutMs: 3000 });
    return (j.models || []).map((m) => ({
      model: m.model || m.name,
      name: m.name || m.model,
      sizeBytes: m.size ?? null,
      vramBytes: m.size_vram ?? null,
      expiresAt: m.expires_at || null,
      contextLength: m.context_length ?? null,
      digest: m.digest || null,
    }));
  }

  /** Unload a model now (keep_alive: 0). Embedding models reject /api/generate, so fall back to /api/embed. */
  async unload(model) {
    try {
      await this.request('/api/generate', { method: 'POST', body: { model, keep_alive: 0 }, timeoutMs: 15000 });
    } catch (e) {
      if (e.code === 'not_chat_model' || /embed/i.test(e.message)) {
        await this.request('/api/embed', { method: 'POST', body: { model, input: [], keep_alive: 0 }, timeoutMs: 15000 }).catch(() => {});
      } else throw e;
    }
  }

  /** Preload a model into memory (empty generate request). */
  async load(model, { keepAlive, options } = {}) {
    const body = { model };
    if (keepAlive !== undefined && keepAlive !== null) body.keep_alive = normalizeKeepAlive(keepAlive);
    if (options) body.options = options;
    await this.request('/api/generate', { method: 'POST', body, timeoutMs: 300000 });
  }
}
