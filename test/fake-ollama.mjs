#!/usr/bin/env node
// A realistic fake Ollama server (native API) for tests and UI development, modelled on Ollama 0.40.x.
//   node test/fake-ollama.mjs --port 11434 [--delay 25]
//   import { startFakeOllama } from './fake-ollama.mjs'; const fake = await startFakeOllama({ port: 0 });
//
// Implements: GET /api/version, /api/tags, /api/ps; POST /api/show, /api/chat (NDJSON stream or not),
// /api/generate (load / unload via keep_alive 0), /api/embed, /api/pull (progress stream), /api/create (files),
// DELETE /api/delete.
// Behaviour copied from the real server: unit-less keep_alive strings → 400; `think` omitted on a thinking model
// means thinking ON; tool calls carry ids; history tool_calls arguments must be objects (a string → 400);
// prompt_eval_cached_count; /api/ps `size` is NOT the resident footprint (KV + buffers, weights excluded) —
// the resident size is what fake.runners() reports (llama-server RSS) for the fake memory probe.
// Test hooks: fake.requests (recorded bodies), fake.failNext({path, status, error, match, count}),
// fake.setDelay(ms), fake.loaded (Map), fake.unloads (array of model names), fake.setPsProfile(name, profile),
// fake.failLoad(name, {unlessCpu}) (HTTP 500 "llama-server process has terminated"), fake.creates,
// fake.chatScript = ({model, messages, tools}) => ({thinking, content, toolCalls:[{name, arguments}]}) | null  (override a reply).
import http from 'node:http';
import { respond, chunkText, fakeEmbedding, fakeTokenCount, readBody, sendJson, sleep, parseArgs, isCli } from './fake-model.mjs';

const GiB = 1024 ** 3;
const now = () => new Date().toISOString();

const MiB = 1024 ** 2;
// Real `/api/show` facts for NVIDIA Nemotron 3.5 Bolt E4B (Ollama 0.40.13 on Apple Silicon, probed by the coordinator).
const NEMOTRON_INFO = {
  'general.architecture': 'gemma4', 'general.name': 'NVIDIA-Nemotron-3.5-Bolt-E4B', 'general.basename': 'NVIDIA-Nemotron-3.5-Bolt', 'general.parameter_count': 7518069290,
  'general.sampling.temp': 1, 'general.sampling.top_k': 64, 'general.sampling.top_p': 0.95,
  'gemma4.context_length': 131072, 'gemma4.block_count': 42, 'gemma4.embedding_length': 2560, 'gemma4.attention.head_count': 8, 'gemma4.attention.head_count_kv': 2,
  'gemma4.attention.key_length': 512, 'gemma4.attention.key_length_swa': 256, 'gemma4.attention.value_length': 512, 'gemma4.attention.value_length_swa': 256,
  'gemma4.attention.sliding_window': 512, 'gemma4.attention.shared_kv_layers': 18,
};
// The Go template in Nemotron's Modelfile (`TEMPLATE "…"`, 159 chars) and the GGUF's jinja template, which is what
// /api/show returns in `template` for these models (and /api/create rejects).
export const NEMOTRON_GO_TEMPLATE = '{{ if .System }}<bos><|turn>system\n{{ .System }}<turn|>\n{{ end }}{{ if .Prompt }}<|turn>user\n{{ .Prompt }}<turn|>\n{{ end }}<|turn>model\n{{ .Response }}<turn|>\n';
const NEMOTRON_JINJA = '{%- set ns = namespace(first=true) -%}{%- for message in messages -%}<|turn>{{ message["role"] }}\n{{ message["content"] | trim }}<turn|>\n{%- endfor -%}{%- if add_generation_prompt -%}<|turn>model\n{%- endif -%}';
const NEMOTRON_PARAMS = 'stop "<bos>"\nstop "<|turn>"\nstop "<turn|>"\nstop "<|turn>user"';
const GEMMA_TEMPLATE = NEMOTRON_JINJA;

export const FAKE_OLLAMA_MODELS = {
  // Official tag: model layer + vision/audio projector + speculative-decoding draft model ≈ 7.9 GB.
  'nemotron-3.5-bolt:e4b': {
    family: 'gemma4', params: '7.52B', quant: 'Q6_K', caps: ['completion', 'tools', 'thinking', 'vision', 'audio'],
    blobs: [{ kind: 'model', size: 6180446208 }, { kind: 'projector', size: 991551808 }, { kind: 'draft', size: 736812096 }],
    info: { ...NEMOTRON_INFO, 'general.name': 'NVIDIA Nemotron 3.5 Bolt E4B' },
    parameters: NEMOTRON_PARAMS, template: GEMMA_TEMPLATE, modelfileTemplate: NEMOTRON_GO_TEMPLATE,
  },
  // Hugging Face quant as pulled: model layer + 946 MiB projector. No "thinking" capability reported.
  'hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL': {
    family: 'gemma4', params: '7.52B', quant: 'Q3_K_M', caps: ['tools', 'completion', 'vision', 'audio'],
    blobs: [{ kind: 'model', size: 4024 * MiB }, { kind: 'projector', size: 946 * MiB }],
    info: NEMOTRON_INFO, parameters: NEMOTRON_PARAMS, template: GEMMA_TEMPLATE, modelfileTemplate: NEMOTRON_GO_TEMPLATE,
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

const hexOf = (k, salt = '') => Buffer.from(`${salt}${k}`).toString('hex').padEnd(64, '0').slice(0, 64);
const RUNNER_OVERHEAD = 300 * 1024 * 1024;

const trivial = (t) => !t || /^\s*\{\{-?\s*\.Prompt\s*-?\}\}\s*$/.test(t);

function prepareModel(name, v) {
  const blobs = (v.blobs || [{ kind: 'model', size: v.size }]).map((b, i) => ({ ...b, digest: b.digest || hexOf(name, `${b.kind}${i}:`) }));
  const size = v.size ?? blobs.reduce((a, b) => a + b.size, 0);
  return { ...v, blobs, size, weightBytes: blobs.reduce((a, b) => a + b.size, 0), modified: now(), digest: `sha256:${hexOf(name)}` };
}

export async function startFakeOllama({ port = 0, host = '127.0.0.1', delayMs = 0, models, pullStepMs = 5, log = false } = {}) {
  const installed = new Map(Object.entries(models || FAKE_OLLAMA_MODELS).map(([k, v]) => [k, prepareModel(k, v)]));
  const fake = {
    requests: [],
    loaded: new Map(),
    unloads: [],
    creates: [],
    unloadDelayMs: 0,
    headerDelayMs: 0,
    delayMs,
    failures: [],
    loadFailures: new Map(),
    lastPrompt: new Map(),
    setDelay(ms) { this.delayMs = ms; },
    failNext(f) { this.failures.push({ count: 1, status: 500, error: 'injected failure', ...f }); },
    /** Loading `name` fails like a crashed runner (HTTP 500); with unlessCpu it loads when options.num_gpu is 0. */
    failLoad(name, { unlessCpu = true, error = 'llama-server process has terminated: signal: abort trap' } = {}) {
      if (name) this.loadFailures.set(name, { unlessCpu, error }); else this.loadFailures.clear();
    },
    clear() { this.requests.length = 0; this.unloads.length = 0; this.failures.length = 0; },
    installed,
    chatRequests() { return this.requests.filter((r) => r.path === '/api/chat').map((r) => r.body); },
    /**
     * True resident footprint per loaded model (what the llama-server process really occupies):
     *   resident = baseBytes + perTokenBytes·num_ctx   (defaults: file size + 300 MB, 1000 B/token)
     * /api/ps reports `size` = resident − weights − runner overhead (KV + buffers, like the real server), or
     * `psSizeBytes` verbatim (e.g. Nemotron's flat ~90 MB); with num_gpu 0 `size` includes the weights and
     * `size_vram` is 0. `vramCapBytes` puts what exceeds it on the CPU (size_vram < size).
     * `reportContext: false` omits context_length.
     */
    psProfiles: new Map(),
    setPsProfile(name, profile) { if (profile) this.psProfiles.set(name, profile); else this.psProfiles.delete(name); },
    residentBytes(name) {
      const l = this.loaded.get(name);
      const m = find(name);
      if (!l || !m) return 0;
      const pr = this.psProfiles.get(name) || {};
      return Math.round((pr.baseBytes ?? m.weightBytes + RUNNER_OVERHEAD) + (pr.perTokenBytes ?? 1000) * l.numCtx);
    },
    /** llama-server runner processes (for the fake memory probe): [{ pid, rssBytes, args, model }]. */
    runners() {
      return [...this.loaded.entries()].filter(([n]) => find(n)).map(([name, l], i) => {
        const m = find(name);
        const blob = m.blobs.find((b) => b.kind === 'model');
        const mm = m.blobs.find((b) => b.kind === 'projector');
        return { pid: 40000 + i, model: name, rssBytes: this.residentBytes(name), args: `/Applications/Ollama.app/Contents/Resources/llama-server --model /Users/me/.ollama/models/blobs/sha256-${blob.digest}${mm ? ` --mmproj /Users/me/.ollama/models/blobs/sha256-${mm.digest}` : ''} --ctx-size ${l.numCtx} --port ${50000 + i}` };
      });
    },
  };

  const find = (name) => installed.get(name) || installed.get(norm(name)) || null;
  const resolveName = (name) => (installed.has(name) ? name : installed.has(norm(name)) ? norm(name) : name);
  const notFound = (name) => ({ error: `model '${name}' not found` });

  function takeFailure(path, body) {
    const i = fake.failures.findIndex((f) => (!f.path || f.path === path) && (!f.match || f.match(body)));
    if (i < 0) return null;
    const f = fake.failures[i];
    if (--f.count <= 0) fake.failures.splice(i, 1);
    return f;
  }

  function httpError(status, message) { return Object.assign(new Error(message), { status }); }

  function markLoaded(name, keepAlive, numCtx, options = {}) {
    if (typeof keepAlive === 'string' && keepAlive !== '0' && !/^-?(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(keepAlive)) {
      // Real Ollama parses string durations with Go's time.ParseDuration: "-1" / "30" are rejected, "0" is accepted.
      throw httpError(400, `time: missing unit in duration "${keepAlive}"`);
    }
    if (keepAlive === 0 || keepAlive === '0' || keepAlive === '0s') {
      fake.unloads.push(name);
      // Like real Ollama, the memory is freed shortly AFTER the request returns (configurable).
      if (fake.unloadDelayMs) setTimeout(() => fake.loaded.delete(name), fake.unloadDelayMs);
      else fake.loaded.delete(name);
      return;
    }
    const ctx = numCtx || 4096;
    const cur = fake.loaded.get(name);
    const lf = fake.loadFailures.get(name);
    if (lf && !(cur && cur.numCtx === ctx) && !(lf.unlessCpu && options.num_gpu === 0)) {
      fake.loaded.delete(name);
      throw httpError(500, lf.error);
    }
    const reloaded = !cur || cur.numCtx !== ctx || cur.cpu !== (options.num_gpu === 0);
    fake.loaded.set(name, { at: Date.now(), numCtx: ctx, cpu: options.num_gpu === 0, expires: new Date(Date.now() + 30 * 60000).toISOString() });
    return reloaded;
  }

  function psEntry(name, l) {
    const m = find(name);
    const pr = fake.psProfiles.get(name) || {};
    const resident = fake.residentBytes(name);
    let size = pr.psSizeBytes ?? Math.max(16 * 1024 * 1024, resident - m.weightBytes - RUNNER_OVERHEAD);
    let vram = size;
    if (l.cpu) { size = resident - RUNNER_OVERHEAD; vram = 0; } else if (pr.vramCapBytes != null) vram = Math.max(0, size - Math.max(0, resident - pr.vramCapBytes));
    return { name, model: name, size: Math.round(size), digest: m.digest, details: { parent_model: '', format: 'gguf', family: m.family, families: [m.family], parameter_size: m.params, quantization_level: m.quant }, expires_at: l.expires, size_vram: Math.round(vram), ...(pr.reportContext === false ? {} : { context_length: l.numCtx }) };
  }

  function blobOwner(digest) {
    for (const m of installed.values()) for (const b of m.blobs) if (b.digest === digest) return { m, b };
    return null;
  }

  /** Common-prefix "prompt cache" like llama-server's: tokens of leading messages identical to the last request. */
  function cachedTokens(name, messages, tools) {
    const prev = fake.lastPrompt.get(name);
    fake.lastPrompt.set(name, { messages, tools: JSON.stringify(tools || null) });
    if (!prev || prev.tools !== JSON.stringify(tools || null)) return 0;
    let i = 0;
    while (i < messages.length && i < prev.messages.length && JSON.stringify(messages[i]) === JSON.stringify(prev.messages[i])) i++;
    return i ? fakeTokenCount(messages.slice(0, i), tools) - 1 : 0;
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
      if (req.method === 'GET' && url.pathname === '/api/version') return sendJson(res, 200, { version: '0.40.13-fake' });
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) { res.writeHead(200); return res.end('Ollama is running'); }
      if (req.method === 'GET' && url.pathname === '/api/tags') {
        return sendJson(res, 200, {
          models: [...installed.entries()].map(([name, m]) => {
            const arch = m.info?.['general.architecture'];
            const ctx = arch ? m.info[`${arch}.context_length`] : undefined;
            const emb = arch ? m.info[`${arch}.embedding_length`] : undefined;
            return { name, model: name, modified_at: m.modified, size: m.size, digest: m.digest, details: { parent_model: '', format: 'gguf', family: m.family, families: [m.family], parameter_size: m.params, quantization_level: m.quant, ...(ctx ? { context_length: ctx } : {}), ...(emb ? { embedding_length: emb } : {}) } };
          }),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/ps') {
        return sendJson(res, 200, { models: [...fake.loaded.entries()].filter(([n]) => find(n)).map(([name, l]) => psEntry(name, l)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/show') {
        const name = body.model || body.name;
        const m = find(name);
        if (!m) return sendJson(res, 404, notFound(name));
        const template = m.template ?? (m.caps.includes('tools') ? '{{- if .Tools }}tools{{ end }}{{ .Prompt }}' : '{{ .Prompt }}');
        // Like `ollama show --modelfile`: FROM lines (model, projector, …), TEMPLATE "…" (Go template, may span lines;
        // quotes escaped), PARAMETER lines. For GGUF-native models show.template holds the jinja template instead.
        const goTemplate = m.modelfileTemplate ?? (trivial(template) || template.includes('{%') ? null : template);
        const modelfile = `# Modelfile generated by "ollama show"\n${m.blobs.map((b) => `FROM /Users/me/.ollama/models/blobs/sha256-${b.digest}`).join('\n')}\n${goTemplate ? `TEMPLATE "${goTemplate.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n` : ''}${(m.parameters || '').split('\n').filter(Boolean).map((l) => `PARAMETER ${l}`).join('\n')}`;
        return sendJson(res, 200, {
          license: 'fake', modelfile, parameters: m.parameters || '', template,
          details: { parent_model: '', format: 'gguf', family: m.family, families: [m.family], parameter_size: m.params, quantization_level: m.quant },
          model_info: m.info, capabilities: m.caps, modified_at: m.modified,
          ...(m.blobs.some((b) => b.kind === 'projector') ? { projector_info: { 'general.architecture': 'clip' } } : {}),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/create') {
        const name = norm(body.model);
        if (!name || !body.files || typeof body.files !== 'object') return sendJson(res, 400, { error: 'neither \'from\' or \'files\' was specified' });
        if (typeof body.template === 'string' && body.template.includes('{%')) return sendJson(res, 400, { error: 'template error: template: :35: function "key" not defined' });
        const blobs = [];
        let src = null;
        for (const [file, d] of Object.entries(body.files)) {
          const digest = String(d).replace(/^sha256:/, '');
          const own = blobOwner(digest);
          if (!own) return sendJson(res, 400, { error: `blob sha256:${digest} not found (${file})` });
          blobs.push({ ...own.b, kind: 'model' });
          src = own.m;
        }
        const params = Object.entries(body.parameters || {}).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k} ${JSON.stringify(x)}`) : [`${k} ${typeof v === 'string' ? JSON.stringify(v) : v}`])).join('\n');
        // As observed: a copy of the gemma4 model layer reports completion/tools/thinking, without a template "{{ .Prompt }}".
        const caps = src.family === 'gemma4' ? ['completion', 'tools', 'thinking'] : ['completion'];
        installed.set(name, prepareModel(name, { family: src.family, params: src.params, quant: src.quant, caps, blobs, info: src.info, parameters: params, template: body.template ?? '{{ .Prompt }}', modelfileTemplate: body.template ?? null }));
        fake.creates.push({ model: name, body });
        if (body.stream === false) return sendJson(res, 200, { status: 'success' });
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({ status: 'using existing layer' }) + '\n');
        res.write(JSON.stringify({ status: 'writing manifest' }) + '\n');
        res.write(JSON.stringify({ status: 'success' }) + '\n');
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/api/generate') {
        const name = resolveName(body.model);
        if (!find(name)) return sendJson(res, 404, notFound(body.model));
        if (find(name).caps.includes('embedding') && !find(name).caps.includes('completion') && body.keep_alive !== 0) return sendJson(res, 400, { error: `"${name}" does not support generate` });
        markLoaded(name, body.keep_alive, body.options?.num_ctx, body.options);
        return sendJson(res, 200, { model: name, created_at: now(), response: '', done: true, done_reason: body.keep_alive === 0 ? 'unload' : 'load' });
      }
      if (req.method === 'POST' && url.pathname === '/api/embed') {
        const name = resolveName(body.model);
        const m = find(name);
        if (!m) return sendJson(res, 404, notFound(body.model));
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
        installed.set(name, { ...prepareModel(name, src), digest });
        w({ status: 'success' });
        return res.end();
      }
      if (req.method === 'DELETE' && url.pathname === '/api/delete') {
        const name = resolveName(body.model || body.name);
        if (!installed.has(name)) return sendJson(res, 404, notFound(body.model));
        installed.delete(name);
        fake.loaded.delete(name);
        res.writeHead(200);
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const name = resolveName(body.model);
        const m = find(name);
        if (!m) return sendJson(res, 404, notFound(body.model));
        if (!m.caps.includes('completion')) return sendJson(res, 400, { error: `"${name}" does not support chat` });
        if (body.tools?.length && !m.caps.includes('tools')) return sendJson(res, 400, { error: `registry.ollama.ai/library/${name} does not support tools` });
        if (body.think && !m.caps.includes('thinking')) return sendJson(res, 400, { error: `"${name}" does not support thinking` });
        for (const msg of body.messages || []) {
          for (const tc of msg.tool_calls || []) {
            if (typeof tc.function?.arguments === 'string') return sendJson(res, 400, { error: "Value looks like object, but can't find closing '}' symbol" });
          }
        }
        const numCtx = body.options?.num_ctx || 4096;
        const reloaded = markLoaded(name, body.keep_alive, numCtx, body.options);
        // Real Ollama: `think` omitted on a thinking-capable model means thinking is ON.
        const thinking = body.think === undefined ? m.caps.includes('thinking') : !!body.think;
        const out = { ...(fake.chatScript?.({ model: name, messages: body.messages || [], tools: body.tools }) || respond({ model: name, messages: body.messages || [], tools: body.tools, think: thinking, capabilities: m.caps })) };
        let doneReason = 'stop';
        if (thinking && m.caps.includes('thinking') && !out.thinking && !out.toolCalls.length) out.thinking = 'Let me think step by step about what is being asked here before I answer. '.repeat(4);
        const budget = body.options?.num_predict;
        if (budget && out.thinking) {
          // The thinking spends the num_predict budget first.
          const thinkTokens = Math.ceil(out.thinking.length / 3.5);
          if (thinkTokens >= budget) { out.thinking = out.thinking.slice(0, Math.floor(budget * 3.5)); out.content = ''; doneReason = 'length'; }
          else if (Math.ceil(out.content.length / 3.5) > budget - thinkTokens) { out.content = out.content.slice(0, Math.floor((budget - thinkTokens) * 3.5)); doneReason = 'length'; }
        }
        const promptTokens = Math.min(numCtx, fakeTokenCount(body.messages || [], body.tools));
        const cached = Math.min(promptTokens - 1, cachedTokens(name, body.messages || [], body.tools));
        const evalCount = Math.max(1, Math.ceil((out.content.length + out.thinking.length) / 3.5));
        const final = { model: name, created_at: now(), message: { role: 'assistant', content: '' }, done: true, done_reason: doneReason, total_duration: 120e6, load_duration: reloaded ? 900e6 : 5e6, prompt_eval_count: promptTokens, ...(cached > 0 ? { prompt_eval_cached_count: cached } : {}), prompt_eval_duration: 40e6, eval_count: evalCount, eval_duration: 75e6 };
        const toolCalls = out.toolCalls.map((c, i) => ({ id: `call_${Math.random().toString(36).slice(2, 10)}`, function: { index: i, name: c.name, arguments: c.arguments } }));
        if (body.stream === false) {
          return sendJson(res, 200, { ...final, message: { role: 'assistant', content: out.content, ...(out.thinking ? { thinking: out.thinking } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } });
        }
        // Real Ollama sends no response headers until the first token (prompt processing can take minutes).
        if (fake.headerDelayMs) await sleep(fake.headerDelayMs);
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
