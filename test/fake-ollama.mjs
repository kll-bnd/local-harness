#!/usr/bin/env node
// A realistic fake Ollama server (native API) for tests and UI development.
//   node test/fake-ollama.mjs --port 11434 [--delay 25]
//   import { startFakeOllama } from './fake-ollama.mjs'; const fake = await startFakeOllama({ port: 0 });
//
// Implements: GET /api/version, /api/tags, /api/ps; POST /api/show, /api/chat (NDJSON stream or not),
// /api/generate (load / unload via keep_alive 0), /api/embed, /api/pull (progress stream), DELETE /api/delete.
// Test hooks: fake.requests (recorded bodies), fake.failNext({path, status, error, match, count}),
// fake.setDelay(ms), fake.loaded (Map), fake.unloads (array of model names),
// fake.chatScript = ({model, messages, tools}) => ({thinking, content, toolCalls:[{name, arguments}]}) | null  (override a reply).
import http from 'node:http';
import { respond, chunkText, fakeEmbedding, fakeTokenCount, readBody, sendJson, sleep, parseArgs, isCli } from './fake-model.mjs';

const GiB = 1024 ** 3;
const now = () => new Date().toISOString();

export const FAKE_OLLAMA_MODELS = {
  'nemotron-3.5-bolt:e4b': {
    family: 'gemma4', params: '7.9B', quant: 'Q4_K_M', size: Math.round(6.0 * GiB), caps: ['completion', 'tools', 'thinking', 'vision'],
    info: { 'general.architecture': 'gemma4', 'general.name': 'NVIDIA Nemotron 3.5 Bolt E4B', 'general.parameter_count': 7.9e9, 'gemma4.context_length': 131072, 'gemma4.block_count': 35, 'gemma4.embedding_length': 2048, 'gemma4.attention.head_count': 8, 'gemma4.attention.head_count_kv': 2, 'gemma4.attention.key_length': 256, 'gemma4.attention.value_length': 256, 'gemma4.attention.sliding_window': 512 },
    parameters: 'temperature 1\ntop_k 64\ntop_p 0.95\nstop "<end_of_turn>"',
  },
  'hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:Q4_K_M': {
    family: 'gemma4', params: '7.9B', quant: 'Q4_K_M', size: 4.6e9, caps: ['completion', 'tools', 'thinking', 'vision'],
    info: { 'general.architecture': 'gemma4', 'general.name': 'NVIDIA-Nemotron-3.5-Bolt-E4B', 'general.basename': 'NVIDIA-Nemotron-3.5-Bolt', 'gemma4.context_length': 131072, 'gemma4.block_count': 35, 'gemma4.embedding_length': 2048, 'gemma4.attention.head_count': 8, 'gemma4.attention.head_count_kv': 2, 'gemma4.attention.key_length': 256, 'gemma4.attention.value_length': 256, 'gemma4.attention.sliding_window': 512 },
  },
  'qwen3:4b': {
    family: 'qwen3', params: '4.0B', quant: 'Q4_K_M', size: 2.5e9, caps: ['completion', 'tools', 'thinking'],
    info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960, 'qwen3.block_count': 36, 'qwen3.embedding_length': 2560, 'qwen3.attention.head_count': 32, 'qwen3.attention.head_count_kv': 8, 'qwen3.attention.key_length': 128, 'qwen3.attention.value_length': 128 },
    parameters: 'temperature 0.6\ntop_k 20\ntop_p 0.95',
  },
  'gemma3:4b': {
    family: 'gemma3', params: '4.3B', quant: 'Q4_K_M', size: 3.3e9, caps: ['completion', 'vision'],
    info: { 'general.architecture': 'gemma3', 'gemma3.context_length': 131072, 'gemma3.block_count': 34, 'gemma3.embedding_length': 2560, 'gemma3.attention.head_count': 8, 'gemma3.attention.head_count_kv': 4, 'gemma3.attention.key_length': 256, 'gemma3.attention.value_length': 256, 'gemma3.attention.sliding_window': 1024 },
  },
  'deepseek-r1:1.5b': {
    family: 'qwen2', params: '1.8B', quant: 'Q4_K_M', size: 1.1e9, caps: ['completion'],
    info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 131072, 'qwen2.block_count': 28, 'qwen2.embedding_length': 1536, 'qwen2.attention.head_count': 12, 'qwen2.attention.head_count_kv': 2 },
  },
  'gemma2:2b': {
    family: 'gemma2', params: '2.6B', quant: 'Q4_0', size: 1.6e9, caps: ['completion'],
    info: { 'general.architecture': 'gemma2', 'gemma2.context_length': 8192, 'gemma2.block_count': 26, 'gemma2.embedding_length': 2304, 'gemma2.attention.head_count': 8, 'gemma2.attention.head_count_kv': 4, 'gemma2.attention.key_length': 256, 'gemma2.attention.value_length': 256 },
  },
  'embeddinggemma:latest': {
    family: 'gemma3', params: '307M', quant: 'BF16', size: 0.62e9, caps: ['embedding'],
    info: { 'general.architecture': 'gemma3', 'gemma3.context_length': 2048, 'gemma3.embedding_length': 768, 'gemma3.block_count': 24, 'gemma3.pooling_type': 1 },
  },
};

const PULLABLE = { 'llama3.2:3b': { family: 'llama', params: '3.2B', quant: 'Q4_K_M', size: 2.0e9, caps: ['completion', 'tools'], info: { 'general.architecture': 'llama', 'llama.context_length': 131072, 'llama.block_count': 28, 'llama.embedding_length': 3072, 'llama.attention.head_count': 24, 'llama.attention.head_count_kv': 8 } }, 'nomic-embed-text:latest': { family: 'nomic-bert', params: '137M', quant: 'F16', size: 0.27e9, caps: ['embedding'], info: { 'general.architecture': 'nomic-bert', 'nomic-bert.context_length': 2048, 'nomic-bert.pooling_type': 1 } } };

const norm = (name) => (name && !name.includes(':') ? `${name}:latest` : name);

export async function startFakeOllama({ port = 0, host = '127.0.0.1', delayMs = 0, models, pullStepMs = 5, log = false } = {}) {
  const installed = new Map(Object.entries(models || FAKE_OLLAMA_MODELS).map(([k, v]) => [k, { ...v, modified: now(), digest: `sha256:${Buffer.from(k).toString('hex').padEnd(64, '0').slice(0, 64)}` }]));
  const fake = {
    requests: [],
    loaded: new Map(),
    unloads: [],
    unloadDelayMs: 0,
    delayMs,
    failures: [],
    setDelay(ms) { this.delayMs = ms; },
    failNext(f) { this.failures.push({ count: 1, status: 500, error: 'injected failure', ...f }); },
    clear() { this.requests.length = 0; this.unloads.length = 0; this.failures.length = 0; },
    installed,
    chatRequests() { return this.requests.filter((r) => r.path === '/api/chat').map((r) => r.body); },
    /**
     * What /api/ps reports per model: size = sizeBytes ?? baseBytes + perTokenBytes·num_ctx,
     * size_vram = min(size, vramCapBytes) (CPU split when smaller), context_length only if reportContext.
     * Defaults: baseBytes = model file size, perTokenBytes = 1000, no VRAM cap, reportContext = true.
     */
    psProfiles: new Map(),
    setPsProfile(name, profile) { if (profile) this.psProfiles.set(name, profile); else this.psProfiles.delete(name); },
  };

  const find = (name) => installed.get(name) || installed.get(norm(name)) || null;
  const resolveName = (name) => (installed.has(name) ? name : installed.has(norm(name)) ? norm(name) : name);

  function takeFailure(path, body) {
    const i = fake.failures.findIndex((f) => (!f.path || f.path === path) && (!f.match || f.match(body)));
    if (i < 0) return null;
    const f = fake.failures[i];
    if (--f.count <= 0) fake.failures.splice(i, 1);
    return f;
  }

  function markLoaded(name, keepAlive, numCtx) {
    if (typeof keepAlive === 'string' && !/^-?(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(keepAlive)) {
      // Real Ollama parses string durations with Go's time.ParseDuration ("-1" / "30" are rejected).
      const e = new Error(`time: missing unit in duration "${keepAlive}"`);
      e.status = 400;
      throw e;
    }
    if (keepAlive === 0 || keepAlive === '0' || keepAlive === '0s') {
      fake.unloads.push(name);
      // Like real Ollama, the memory is freed shortly AFTER the request returns (configurable).
      if (fake.unloadDelayMs) setTimeout(() => fake.loaded.delete(name), fake.unloadDelayMs);
      else fake.loaded.delete(name);
      return;
    }
    fake.loaded.set(name, { at: Date.now(), numCtx: numCtx || 4096, expires: new Date(Date.now() + 30 * 60000).toISOString() });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const raw = await readBody(req);
    let body = {};
    if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); } }
    fake.requests.push({ method: req.method, path: url.pathname, body, at: Date.now() });
    if (log) console.log(`[fake-ollama] ${req.method} ${url.pathname}`);
    const fail = takeFailure(url.pathname, body);
    if (fail) return sendJson(res, fail.status, { error: fail.error });
    try {
      if (req.method === 'GET' && url.pathname === '/api/version') return sendJson(res, 200, { version: '0.12.6-fake' });
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) { res.writeHead(200); return res.end('Ollama is running'); }
      if (req.method === 'GET' && url.pathname === '/api/tags') {
        return sendJson(res, 200, { models: [...installed.entries()].map(([name, m]) => ({ name, model: name, modified_at: m.modified, size: m.size, digest: m.digest, details: { parent_model: '', format: 'gguf', family: m.family, families: [m.family], parameter_size: m.params, quantization_level: m.quant } })) });
      }
      if (req.method === 'GET' && url.pathname === '/api/ps') {
        return sendJson(res, 200, {
          models: [...fake.loaded.entries()].filter(([n]) => find(n)).map(([name, l]) => {
            const m = find(name);
            const pr = fake.psProfiles.get(name) || {};
            const size = pr.sizeBytes ?? Math.round((pr.baseBytes ?? m.size) + (pr.perTokenBytes ?? 1000) * l.numCtx);
            const vram = pr.vramCapBytes != null ? Math.min(size, pr.vramCapBytes) : size;
            return { name, model: name, size, digest: m.digest, details: { family: m.family, parameter_size: m.params, quantization_level: m.quant }, expires_at: l.expires, size_vram: vram, ...(pr.reportContext === false ? {} : { context_length: l.numCtx }) };
          }),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/show') {
        const name = body.model || body.name;
        const m = find(name);
        if (!m) return sendJson(res, 404, { error: `model '${name}' not found` });
        return sendJson(res, 200, {
          license: 'fake', modelfile: `FROM ${name}`, parameters: m.parameters || '',
          template: m.caps.includes('tools') ? '{{- if .Tools }}tools{{ end }}{{ .Prompt }}' : '{{ .Prompt }}',
          details: { parent_model: '', format: 'gguf', family: m.family, families: [m.family], parameter_size: m.params, quantization_level: m.quant },
          model_info: m.info, capabilities: m.caps, modified_at: m.modified,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/generate') {
        const name = resolveName(body.model);
        if (!find(name)) return sendJson(res, 404, { error: `model '${body.model}' not found, try pulling it first` });
        if (find(name).caps.includes('embedding') && !find(name).caps.includes('completion')) return sendJson(res, 400, { error: `"${name}" does not support generate` });
        markLoaded(name, body.keep_alive, body.options?.num_ctx);
        return sendJson(res, 200, { model: name, created_at: now(), response: '', done: true, done_reason: body.keep_alive === 0 ? 'unload' : 'load' });
      }
      if (req.method === 'POST' && url.pathname === '/api/embed') {
        const name = resolveName(body.model);
        const m = find(name);
        if (!m) return sendJson(res, 404, { error: `model '${body.model}' not found` });
        if (!m.caps.includes('embedding')) return sendJson(res, 400, { error: `"${name}" does not support embeddings` });
        const input = Array.isArray(body.input) ? body.input : [body.input];
        markLoaded(name, body.keep_alive, 2048);
        return sendJson(res, 200, { model: name, embeddings: input.map((t) => fakeEmbedding(t)), total_duration: 1e6, load_duration: 0, prompt_eval_count: input.length * 8 });
      }
      if (req.method === 'POST' && url.pathname === '/api/pull') {
        const name = norm(body.model || body.name);
        const src = PULLABLE[name] || PULLABLE[body.model] || (installed.get(name) ? installed.get(name) : FAKE_OLLAMA_MODELS[name]);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const w = (o) => res.write(JSON.stringify(o) + '\n');
        w({ status: 'pulling manifest' });
        if (!src) { w({ error: 'pull model manifest: file does not exist' }); return res.end(); }
        const total = 100 * 1024 * 1024;
        const digest = `sha256:${'ab'.repeat(32)}`;
        let aborted = false;
        res.on('close', () => { aborted = true; });
        for (let i = 0; i <= 10 && !aborted; i++) { w({ status: `pulling ${digest.slice(7, 19)}`, digest, total, completed: Math.round((total * i) / 10) }); await sleep(pullStepMs); }
        if (aborted) return;
        w({ status: 'verifying sha256 digest' });
        w({ status: 'writing manifest' });
        installed.set(name, { ...src, modified: now(), digest });
        w({ status: 'success' });
        return res.end();
      }
      if (req.method === 'DELETE' && url.pathname === '/api/delete') {
        const name = resolveName(body.model || body.name);
        if (!installed.has(name)) return sendJson(res, 404, { error: `model '${body.model}' not found` });
        installed.delete(name);
        fake.loaded.delete(name);
        res.writeHead(200);
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const name = resolveName(body.model);
        const m = find(name);
        if (!m) return sendJson(res, 404, { error: `model "${body.model}" not found, try pulling it first` });
        if (!m.caps.includes('completion')) return sendJson(res, 400, { error: `"${name}" does not support chat` });
        if (body.tools?.length && !m.caps.includes('tools')) return sendJson(res, 400, { error: `registry.ollama.ai/library/${name} does not support tools` });
        if (body.think && !m.caps.includes('thinking')) return sendJson(res, 400, { error: `"${name}" does not support thinking` });
        const numCtx = body.options?.num_ctx || 4096;
        markLoaded(name, body.keep_alive, numCtx);
        const out = fake.chatScript?.({ model: name, messages: body.messages || [], tools: body.tools }) || respond({ model: name, messages: body.messages || [], tools: body.tools, think: body.think, capabilities: m.caps });
        const promptTokens = Math.min(numCtx, fakeTokenCount(body.messages || [], body.tools));
        const evalCount = Math.max(1, Math.ceil((out.content.length + out.thinking.length) / 3.5));
        const final = { model: name, created_at: now(), message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', total_duration: 120e6, load_duration: 5e6, prompt_eval_count: promptTokens, prompt_eval_duration: 40e6, eval_count: evalCount, eval_duration: 75e6 };
        const toolCalls = out.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
        if (body.stream === false) {
          return sendJson(res, 200, { ...final, message: { role: 'assistant', content: out.content, ...(out.thinking ? { thinking: out.thinking } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } });
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        let aborted = false;
        res.on('close', () => { aborted = true; });
        const w = (o) => { if (!aborted) res.write(JSON.stringify(o) + '\n'); };
        for (const c of chunkText(out.thinking, 9)) { if (aborted) return; w({ model: name, created_at: now(), message: { role: 'assistant', content: '', thinking: c }, done: false }); if (fake.delayMs) await sleep(fake.delayMs); }
        for (const c of chunkText(out.content, 7)) { if (aborted) return; w({ model: name, created_at: now(), message: { role: 'assistant', content: c }, done: false }); if (fake.delayMs) await sleep(fake.delayMs); }
        if (toolCalls.length) w({ model: name, created_at: now(), message: { role: 'assistant', content: '', tool_calls: toolCalls }, done: false });
        const midFail = takeFailure('/api/chat#stream', body);
        if (midFail) { w({ error: midFail.error }); return res.end(); }
        w(final);
        return res.end();
      }
      sendJson(res, 404, { error: `fake-ollama: no route ${req.method} ${url.pathname}` });
    } catch (e) {
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
      else res.end();
    }
  });
  await new Promise((r) => server.listen(port, host, r));
  fake.port = server.address().port;
  fake.url = `http://${host}:${fake.port}`;
  fake.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return fake;
}

if (isCli(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  const fake = await startFakeOllama({ port: Number(a.port || 11434), delayMs: Number(a.delay ?? 25), log: a.log === 'true' });
  console.log(`fake Ollama listening on ${fake.url} (models: ${[...fake.installed.keys()].join(', ')})`);
}
