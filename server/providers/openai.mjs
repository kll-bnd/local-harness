// Generic OpenAI-compatible client (llama.cpp llama-server, LM Studio, MLX-LM, vLLM, LocalAI, ...).
import { ProviderError, isAbortError } from '../lib/errors.mjs';
import { readSse } from '../lib/streams.mjs';
import { newId } from '../lib/ids.mjs';
import { withTimeout } from '../lib/util.mjs';

export function classifyOpenAIError(status, message, providerId) {
  const msg = String(message || `HTTP ${status}`);
  let code = 'provider_error';
  if (/tool|function.?call/i.test(msg) && /support|jinja|not (allowed|enabled)|unsupported|invalid/i.test(msg)) code = 'tools_unsupported';
  else if (/context|n_ctx|too long|exceed/i.test(msg) && /token|context|length|n_ctx/i.test(msg)) code = 'context_overflow';
  else if (status === 404 && /model/i.test(msg)) code = 'model_not_found';
  else if (/image|vision|multimodal|mmproj/i.test(msg) && /support|not/i.test(msg)) code = 'vision_unsupported';
  return new ProviderError(msg, { status: status === 404 ? 404 : 502, code, providerId });
}

export function toOpenAIMessage(m) {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId || 'call_0', content: m.content ?? '' };
  const out = { role: m.role };
  if (m.images?.length && m.role === 'user') {
    out.content = [
      ...(m.content ? [{ type: 'text', text: m.content }] : []),
      ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime || 'image/png'};base64,${i.base64}` } })),
    ];
  } else {
    out.content = m.content ?? '';
  }
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) } }));
    if (!out.content) out.content = null;
  }
  return out;
}

const OPTION_MAP = { temperature: 'temperature', top_p: 'top_p', top_k: 'top_k', min_p: 'min_p', repeat_penalty: 'repeat_penalty', seed: 'seed', stop: 'stop', num_predict: 'max_tokens', presence_penalty: 'presence_penalty', frequency_penalty: 'frequency_penalty' };

export class OpenAICompatProvider {
  /**
   * @param {object} o
   * @param {string} o.baseUrl root URL (a trailing /v1 is stripped)
   * @param {'llamacpp'|'lmstudio'|'generic'} [o.flavor]
   */
  constructor({ id, name, baseUrl, apiKey = '', flavor = 'generic', builtin = false }) {
    this.id = id;
    this.kind = 'openai';
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    this.apiKey = apiKey;
    this.flavor = flavor;
    this.builtin = builtin;
    this.capabilities = { setContext: false, pull: false, delete: false, unload: false, embeddings: true };
    this._serverInfo = null;
  }

  headers(json = true) {
    const h = {};
    if (json) h['content-type'] = 'application/json';
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async request(path, { method = 'GET', body, signal, timeoutMs } = {}) {
    let res;
    try {
      res = await fetch(this.baseUrl + path, { method, headers: this.headers(body !== undefined), body: body !== undefined ? JSON.stringify(body) : undefined, signal: withTimeout(signal, timeoutMs) });
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) throw e;
      if (e?.name === 'TimeoutError') throw new ProviderError(`${this.name} timed out (${path})`, { code: 'timeout', providerId: this.id });
      throw new ProviderError(`Cannot reach ${this.name} at ${this.baseUrl}`, { code: 'connection_failed', providerId: this.id, cause: e });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = text;
      try { const j = JSON.parse(text); msg = j.error?.message || j.error || j.message || text; } catch { /* plain */ }
      throw classifyOpenAIError(res.status, typeof msg === 'string' ? msg : JSON.stringify(msg), this.id);
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
      await this.json('/v1/models', { timeoutMs: 1500 });
      if (this.flavor === 'generic' || this.flavor === 'llamacpp') {
        const props = await this.json('/props', { timeoutMs: 1000 }).catch(() => null);
        if (props && (props.default_generation_settings || props.total_slots !== undefined)) this.flavor = 'llamacpp';
      }
      return { ok: true, version: null, flavor: this.flavor };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code };
    }
  }

  /** Flavor-specific server facts: llama.cpp /props (n_ctx), LM Studio /api/v0/models (loaded ctx, type). */
  async serverInfo({ refresh = false } = {}) {
    if (this._serverInfo && !refresh && Date.now() - this._serverInfo.at < 10000) return this._serverInfo;
    const info = { at: Date.now(), nCtx: null, models: {} };
    if (this.flavor === 'llamacpp') {
      const props = await this.json('/props', { timeoutMs: 2000 }).catch(() => null);
      if (props) {
        info.nCtx = props.default_generation_settings?.n_ctx ?? props.n_ctx ?? null;
        info.vision = !!(props.modalities?.vision);
        info.modelPath = props.model_path || null;
      }
    } else if (this.flavor === 'lmstudio') {
      const j = await this.json('/api/v0/models', { timeoutMs: 2000 }).catch(() => null);
      for (const m of j?.data || []) {
        info.models[m.id] = { type: m.type, maxContext: m.max_context_length ?? null, loadedContext: m.loaded_context_length ?? null, state: m.state, quantization: m.quantization, arch: m.arch };
      }
    }
    this._serverInfo = info;
    return info;
  }

  async listModels() {
    const j = await this.json('/v1/models', { timeoutMs: 5000 });
    const info = await this.serverInfo().catch(() => ({ models: {} }));
    return (j.data || []).map((m) => {
      const lm = info.models?.[m.id];
      return {
        model: m.id,
        name: m.id,
        sizeBytes: m.meta?.size ?? null,
        digest: null,
        modifiedAt: m.created ? new Date(m.created * 1000).toISOString() : null,
        family: lm?.arch || null,
        families: null,
        parameterSize: m.meta?.n_params ? `${(m.meta.n_params / 1e9).toFixed(1)}B` : null,
        quantization: lm?.quantization || null,
        format: null,
        _meta: m.meta || null,
        _lm: lm || null,
      };
    });
  }

  async *chat({ model, messages, tools, options = {}, signal, think }) {
    const body = { model, messages: messages.map(toOpenAIMessage), stream: true, stream_options: { include_usage: true } };
    for (const [k, v] of Object.entries(options || {})) {
      if (v === null || v === undefined || !(k in OPTION_MAP)) continue;
      if (k === 'num_predict' && v < 0) continue;
      body[OPTION_MAP[k]] = v;
    }
    if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
    if (think === false && this.flavor === 'llamacpp') body.chat_template_kwargs = { enable_thinking: false };
    const res = await this.request('/v1/chat/completions', { method: 'POST', body, signal });
    const calls = new Map();
    let finish = null;
    let usage = null;
    let timings = null;
    for await (const ev of readSse(res.body)) {
      if (ev.data === '[DONE]') break;
      let j;
      try { j = JSON.parse(ev.data); } catch { continue; }
      if (j.error) throw classifyOpenAIError(500, j.error.message || JSON.stringify(j.error), this.id);
      if (j.usage) usage = j.usage;
      if (j.timings) timings = j.timings;
      const choice = j.choices?.[0];
      if (!choice) continue;
      const d = choice.delta || choice.message || {};
      const reasoning = d.reasoning_content ?? d.reasoning;
      if (reasoning) yield { type: 'thinking', text: reasoning };
      if (typeof d.content === 'string' && d.content) yield { type: 'content', text: d.content };
      for (const tc of d.tool_calls || []) {
        const idx = tc.index ?? calls.size;
        const cur = calls.get(idx) || { id: null, name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
        calls.set(idx, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    for (const c of [...calls.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) {
      let args = {};
      if (c.args.trim()) { try { args = JSON.parse(c.args); } catch { args = { _raw: c.args }; } }
      yield { type: 'tool_call', call: { id: c.id || newId('call'), name: c.name || 'unknown', arguments: args } };
    }
    yield {
      type: 'done',
      doneReason: finish === 'length' ? 'length' : finish === 'tool_calls' ? 'tool_calls' : 'stop',
      usage: {
        promptTokens: usage?.prompt_tokens ?? timings?.prompt_n ?? null,
        completionTokens: usage?.completion_tokens ?? timings?.predicted_n ?? null,
        totalMs: timings ? Math.round((timings.prompt_ms || 0) + (timings.predicted_ms || 0)) : null,
        loadMs: null,
        promptMs: timings?.prompt_ms != null ? Math.round(timings.prompt_ms) : null,
        evalMs: timings?.predicted_ms != null ? Math.round(timings.predicted_ms) : null,
      },
    };
  }

  async embed({ model, input, signal }) {
    const j = await this.json('/v1/embeddings', { method: 'POST', body: { model, input }, signal, timeoutMs: 120000 });
    return (j.data || []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
  }

  async ps() {
    if (this.flavor === 'lmstudio') {
      const info = await this.serverInfo({ refresh: true }).catch(() => ({ models: {} }));
      return Object.entries(info.models).filter(([, m]) => m.state === 'loaded').map(([id, m]) => ({ model: id, name: id, sizeBytes: null, vramBytes: null, expiresAt: null, contextLength: m.loadedContext }));
    }
    return [];
  }

  async *pull() { throw new ProviderError(`${this.name} does not support pulling models through the API`, { status: 400, code: 'unsupported', providerId: this.id }); }
  async deleteModel() { throw new ProviderError(`${this.name} does not support deleting models through the API`, { status: 400, code: 'unsupported', providerId: this.id }); }
  async unload() { /* not supported: no-op */ }
}
