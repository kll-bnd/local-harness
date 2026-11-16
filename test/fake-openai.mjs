#!/usr/bin/env node
// Fake OpenAI-compatible server (llama.cpp llama-server flavour) incl. image generation.
//   node test/fake-openai.mjs --port 8080 [--delay 20] [--images true]
// Implements: GET /v1/models, /props, /health; POST /v1/chat/completions (SSE stream with partial
// tool-call arguments, reasoning_content, usage, timings), /v1/embeddings, /v1/images/generations (b64_json PNGs).
import http from 'node:http';
import { respond, chunkText, fakeEmbedding, fakeTokenCount, readBody, sendJson, sleep, parseArgs, isCli } from './fake-model.mjs';
import { makePng } from './png.mjs';

export async function startFakeOpenAI({ port = 0, host = '127.0.0.1', delayMs = 0, nCtx = 8192, models = ['fake-llama', 'fake-reasoner', 'fake-notools', 'fake-embed'], images = true, imageDelayMs = 0, llamacpp = true } = {}) {
  const fake = { requests: [], delayMs, nCtx, failures: [], failNext(f) { this.failures.push({ count: 1, status: 500, error: 'injected failure', ...f }); } };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const raw = await readBody(req);
    let body = {};
    if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJson(res, 400, { error: { message: 'invalid JSON' } }); } }
    fake.requests.push({ method: req.method, path: url.pathname, body, headers: req.headers });
    const fi = fake.failures.findIndex((f) => !f.path || f.path === url.pathname);
    if (fi >= 0) { const f = fake.failures[fi]; if (--f.count <= 0) fake.failures.splice(fi, 1); return sendJson(res, f.status, { error: { message: f.error } }); }
    if (url.pathname === '/health') return sendJson(res, 200, { status: 'ok' });
    if (url.pathname === '/props' && llamacpp) return sendJson(res, 200, { default_generation_settings: { n_ctx: fake.nCtx, temperature: 0.8 }, total_slots: 1, model_path: '/models/fake-llama.gguf', modalities: { vision: false } });
    if (url.pathname === '/v1/models') return sendJson(res, 200, { object: 'list', data: models.map((id) => ({ id, object: 'model', created: 1700000000, owned_by: 'llamacpp', meta: { n_ctx_train: 32768, n_params: 1.5e9, size: 1.1e9 } })) });
    if (url.pathname === '/v1/embeddings') {
      const input = Array.isArray(body.input) ? body.input : [body.input];
      return sendJson(res, 200, { object: 'list', data: input.map((t, i) => ({ object: 'embedding', index: i, embedding: fakeEmbedding(t) })), model: body.model, usage: { prompt_tokens: input.length * 8, total_tokens: input.length * 8 } });
    }
    if (url.pathname === '/v1/images/generations' && images) {
      const n = body.n || 1;
      const [w, h] = String(body.size || '512x512').split('x').map(Number);
      if (imageDelayMs) await sleep(imageDelayMs);
      const seed = Number.isFinite(body.seed) ? body.seed : 7;
      return sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data: Array.from({ length: n }, (_, i) => ({ b64_json: makePng(w || 512, h || 512, seed + i).toString('base64'), revised_prompt: body.prompt })) });
    }
    if (url.pathname === '/v1/chat/completions') {
      const model = body.model || models[0];
      if (body.tools?.length && /notools/.test(model)) return sendJson(res, 500, { error: { code: 500, message: 'tools param requires --jinja flag', type: 'server_error' } });
      const out = respond({ model, messages: body.messages || [], tools: body.tools, think: /reasoner/.test(model), capabilities: /reasoner/.test(model) ? ['thinking'] : [] });
      const promptTokens = fakeTokenCount(body.messages || [], body.tools);
      const completionTokens = Math.max(1, Math.ceil((out.content.length + out.thinking.length) / 3.5));
      const id = `chatcmpl-${Date.now()}`;
      const toolCalls = out.toolCalls.map((c, i) => ({ index: i, id: `call_${i}_${Date.now()}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
      if (!body.stream) {
        return sendJson(res, 200, { id, object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: out.content, ...(out.thinking ? { reasoning_content: out.thinking } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let aborted = false;
      res.on('close', () => { aborted = true; });
      const w = (o) => { if (!aborted) res.write(`data: ${JSON.stringify(o)}\n\n`); };
      const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
      w({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] });
      for (const c of chunkText(out.thinking, 9)) { w({ ...base, choices: [{ index: 0, delta: { reasoning_content: c }, finish_reason: null }] }); if (fake.delayMs) await sleep(fake.delayMs); }
      for (const c of chunkText(out.content, 7)) { w({ ...base, choices: [{ index: 0, delta: { content: c }, finish_reason: null }] }); if (fake.delayMs) await sleep(fake.delayMs); }
      for (const tc of toolCalls) {
        const args = tc.function.arguments;
        const half = Math.floor(args.length / 2);
        w({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: tc.index, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: args.slice(0, half) } }] }, finish_reason: null }] });
        w({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: tc.index, function: { arguments: args.slice(half) } }] }, finish_reason: null }] });
      }
      w({ ...base, choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }], timings: { prompt_n: promptTokens, prompt_ms: 30, predicted_n: completionTokens, predicted_ms: 60 } });
      if (body.stream_options?.include_usage) w({ ...base, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } });
      if (!aborted) res.write('data: [DONE]\n\n');
      return res.end();
    }
    sendJson(res, 404, { error: { message: `fake-openai: no route ${req.method} ${url.pathname}` } });
  });
  await new Promise((r) => server.listen(port, host, r));
  fake.port = server.address().port;
  fake.url = `http://${host}:${fake.port}`;
  fake.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return fake;
}

if (isCli(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  const fake = await startFakeOpenAI({ port: Number(a.port || 8080), delayMs: Number(a.delay ?? 20), images: a.images !== 'false' });
  console.log(`fake OpenAI-compatible server listening on ${fake.url}`);
}
