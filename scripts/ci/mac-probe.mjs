#!/usr/bin/env node
// CI-only: fact-finding against a REAL Ollama on a GitHub macOS runner. Prints one compact line per
// fact so the job log stays short. Not part of the app.
//
//   node scripts/ci/mac-probe.mjs api        # API behaviours Harness relies on (tiny models)
//   node scripts/ci/mac-probe.mjs nemotron   # the real Nemotron 3.5 Bolt E4B: load, memory, tools
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const O = process.env.O || 'http://127.0.0.1:11434';
const LOG = process.env.OLLAMA_LOG || '';
const mode = process.argv[2] || 'api';

const clip = (s, n = 500) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s);
const compact = (v, n = 500) => JSON.stringify(v, (k, x) => (typeof x === 'string' ? clip(x, n) : x));
const out = (label, v, n) => console.log(`${label}: ${typeof v === 'string' ? clip(v, 1200) : compact(v, n)}`);
const head = (t) => console.log(`\n## ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function api(p, body, { method, timeoutMs = 1500000, base = O } = {}) {
  // node:http rather than fetch: fetch gives up after 300 s without response headers, and Ollama
  // sends none until the first token.
  const t0 = Date.now();
  const u = new URL(base + p);
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: method || (data ? 'POST' : 'GET'), headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* NDJSON or plain text */ }
        resolve({ status: res.statusCode, json, text, ms: Date.now() - t0 });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response in ${timeoutMs} ms`)));
    req.on('error', (e) => resolve({ status: 0, json: null, text: '', ms: Date.now() - t0, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}
const lines = (text) => text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });

function rss() {
  try {
    const rows = execFileSync('ps', ['-axo', 'rss=,comm='], { encoding: 'utf8' }).split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean)
      .filter((m) => /ollama|llama-server/.test(m[2]))
      .map((m) => ({ mb: Math.round(Number(m[1]) / 1024), proc: path.basename(m[2]) }));
    return { totalMb: rows.reduce((s, r) => s + r.mb, 0), procs: rows.map((r) => `${r.proc}=${r.mb}`).join(' ') };
  } catch (e) { return { error: e.message }; }
}
function vm() {
  try {
    const swap = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).trim().replace(/\s+/g, ' ');
    const stat = execFileSync('vm_stat', { encoding: 'utf8' });
    const page = Number(stat.match(/page size of (\d+)/)?.[1] || 16384);
    const pick = (k) => Math.round((Number(stat.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1] || 0) * page) / 2 ** 20);
    let pressure = null;
    try { pressure = Number(execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { /* not available */ }
    return { freeMb: pick('Pages free'), inactiveMb: pick('Pages inactive'), wiredMb: pick('Pages wired down'), compressedMb: pick('Pages occupied by compressor'), swapUsedMb: Number(swap.match(/used = ([\d.]+)M/)?.[1] ?? NaN), pressure };
  } catch (e) { return { error: e.message }; }
}
async function mem(label) {
  const ps = await api('/api/ps');
  const m = (ps.json?.models || []).map((x) => ({ name: x.name, sizeMb: Math.round(x.size / 2 ** 20), vramMb: Math.round(x.size_vram / 2 ** 20), ctx: x.context_length }));
  out(`mem[${label}]`, { ps: m, rss: rss(), vm: vm() });
}
const logText = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } };
function logFind(re, { max = 3, n = 1500, from = 0 } = {}) {
  const hits = logText().slice(from).split('\n').filter((l) => re.test(l));
  for (const l of hits.slice(-max)) console.log(`  log> ${clip(l.replace(/^time=\S+\s+/, ''), n)}`);
  if (!hits.length) console.log(`  log> (no line matching ${re})`);
}
const stats = (j) => j && ({
  done_reason: j.done_reason, load_s: +((j.load_duration || 0) / 1e9).toFixed(2), prompt_tokens: j.prompt_eval_count, cached: j.prompt_eval_cached_count,
  prompt_tps: j.prompt_eval_duration ? Math.round(j.prompt_eval_count / (j.prompt_eval_duration / 1e9)) : null,
  eval_tokens: j.eval_count, eval_tps: j.eval_duration ? +(j.eval_count / (j.eval_duration / 1e9)).toFixed(1) : null, error: j.error,
});
const user = (content, extra = {}) => ({ role: 'user', content, ...extra });
const LONG_A = Array(300).fill('The quick brown fox jumps over the lazy dog.').join(' ');
const LONG_B = Array(300).fill('Pack my box with five dozen liquor jugs.').join(' ');
const WEATHER = [{ type: 'function', function: { name: 'get_weather', description: 'Get the current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];

async function section(title, fn) {
  head(title);
  try { await fn(); } catch (e) { out('PROBE ERROR', `${e.stack || e}`); }
}

async function probeApi() {
  const CHAT = process.env.CHAT || 'qwen3:0.6b';
  const PLAIN = process.env.PLAIN || 'gemma3:270m';
  const opts = { num_ctx: 2048, num_predict: 3 };

  await section('server', async () => {
    out('version', (await api('/api/version')).json);
    logFind(/msg="server config"/, { max: 1, n: 4000 });
  });

  await section('keep_alive forms', async () => {
    for (const ka of ['5m', 300, -1, '-1', '30', '0', 0, '1h30m', 3600.5]) {
      const r = await api('/api/chat', { model: CHAT, stream: false, keep_alive: ka, messages: [user('hi')], options: opts });
      const ps = await api('/api/ps');
      out(`keep_alive=${JSON.stringify(ka)}`, { http: r.status, error: r.json?.error, done_reason: r.json?.done_reason, expires_at: ps.json?.models?.[0]?.expires_at ?? null, now: new Date().toISOString() });
    }
  });

  await section('thinking', async () => {
    const off = await api('/api/chat', { model: CHAT, think: false, stream: false, messages: [user('What is 2+2? One word.')], options: { num_ctx: 2048, num_predict: 40 } });
    out('think:false', { http: off.status, message: off.json?.message, ...stats(off.json) });
    const none = await api('/api/chat', { model: CHAT, stream: false, messages: [user('What is 2+2? One word.')], options: { num_ctx: 2048, num_predict: 60 } });
    out('think omitted', { http: none.status, message: none.json?.message });
    for (const level of ['low', 'high']) {
      const r = await api('/api/chat', { model: CHAT, think: level, stream: false, messages: [user('hi')], options: { num_ctx: 2048, num_predict: 20 } });
      out(`think:"${level}"`, { http: r.status, error: r.json?.error, hasThinking: !!r.json?.message?.thinking });
    }
    const bad = await api('/api/chat', { model: PLAIN, think: true, stream: false, messages: [user('hi')], options: { num_predict: 5 } });
    out('think:true on a model without thinking', { http: bad.status, body: bad.json ?? bad.text });
    const badStream = await api('/api/chat', { model: PLAIN, think: true, messages: [user('hi')], options: { num_predict: 5 } });
    out('same, streaming', { http: badStream.status, firstLines: lines(badStream.text).slice(0, 2) });
  });

  await section('tools', async () => {
    const q = user('What is the weather in Paris? Use the tool.');
    const o = { num_ctx: 4096, num_predict: 200, temperature: 0 };
    const call = await api('/api/chat', { model: CHAT, think: false, stream: false, tools: WEATHER, messages: [q], options: o });
    out('tool call', { http: call.status, message: call.json?.message });
    const calls = call.json?.message?.tool_calls || [];
    const variants = {
      'tool_name': { role: 'tool', tool_name: 'get_weather', content: '18 C, sunny' },
      'tool_name + tool_call_id': { role: 'tool', tool_name: 'get_weather', tool_call_id: calls[0]?.id, content: '18 C, sunny' },
      'name (OpenAI style)': { role: 'tool', name: 'get_weather', content: '18 C, sunny' },
      'bare role tool': { role: 'tool', content: '18 C, sunny' },
    };
    for (const [label, toolMsg] of Object.entries(variants)) {
      const r = await api('/api/chat', { model: CHAT, think: false, stream: false, tools: WEATHER, messages: [q, { role: 'assistant', content: '', tool_calls: calls }, toolMsg], options: o });
      out(`tool result as ${label}`, { http: r.status, error: r.json?.error, content: r.json?.message?.content, more_calls: r.json?.message?.tool_calls?.length || 0 });
    }
    const strArgs = calls.map((c) => ({ ...c, function: { ...c.function, arguments: JSON.stringify(c.function?.arguments ?? {}) } }));
    const r2 = await api('/api/chat', { model: CHAT, think: false, stream: false, tools: WEATHER, messages: [q, { role: 'assistant', content: '', tool_calls: strArgs }, variants.tool_name], options: o });
    out('assistant tool_calls with arguments as a JSON string', { http: r2.status, error: r2.json?.error, content: r2.json?.message?.content });
    const noId = calls.map((c) => ({ function: { name: c.function?.name, arguments: c.function?.arguments } }));
    const r3 = await api('/api/chat', { model: CHAT, think: false, stream: false, tools: WEATHER, messages: [q, { role: 'assistant', content: '', tool_calls: noId }, variants.tool_name], options: o });
    out('assistant tool_calls without id/index', { http: r3.status, error: r3.json?.error, content: r3.json?.message?.content });
    const bad = await api('/api/chat', { model: PLAIN, stream: false, tools: WEATHER, messages: [user('hi')], options: { num_predict: 5 } });
    out('tools on a model without tool support', { http: bad.status, body: bad.json ?? bad.text });
    const badStream = await api('/api/chat', { model: PLAIN, tools: WEATHER, messages: [user('hi')], options: { num_predict: 5 } });
    out('same, streaming', { http: badStream.status, firstLines: lines(badStream.text).slice(0, 2) });
  });

  await section('abort mid-stream', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    let got = 0;
    try {
      const res = await fetch(`${O}/api/chat`, { method: 'POST', body: JSON.stringify({ model: CHAT, think: false, messages: [user('Count from 1 to 500, one number per line.')], options: { num_ctx: 2048, num_predict: 400 } }), signal: ac.signal });
      for await (const chunk of res.body) { got += chunk.length; if (got > 600) ac.abort(); }
    } catch (e) { out('client abort', { after_ms: Date.now() - t0, bytes: got, error: e.name }); }
    await sleep(1500);
    const r = await api('/api/chat', { model: CHAT, think: false, stream: false, messages: [user('hi')], options: opts });
    out('next request after abort', { http: r.status, ms: r.ms, ...stats(r.json) });
    logFind(/cancel|aborted|context canceled/i, { max: 2, n: 300 });
  });

  await section('unload', async () => {
    const before = rss();
    const t0 = Date.now();
    const r = await api('/api/generate', { model: CHAT, keep_alive: 0 });
    let gone = null;
    for (let i = 0; i < 100; i++) { if (!((await api('/api/ps')).json?.models || []).length) { gone = Date.now() - t0; break; } await sleep(100); }
    const samples = [];
    for (const wait of [0, 500, 1500, 3000]) { await sleep(wait); samples.push(`${Date.now() - t0}ms=${rss().totalMb}MB`); }
    out('unload', { http: r.status, body: r.json, ps_empty_after_ms: gone, rss_before: before, rss_after: samples.join(' ') });
  });
}

function redPng(n) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(n * 3, 0).map((_, i) => (i % 3 === 0 ? 255 : 0))]);
  const raw = Buffer.concat(Array(n).fill(row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function parseParams(text) {
  const p = {};
  for (const l of String(text || '').split('\n')) {
    const m = l.match(/^(\S+)\s+(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } } else if (v !== '' && !Number.isNaN(Number(v))) v = Number(v);
    if (m[1] in p) p[m[1]] = [].concat(p[m[1]], v); else p[m[1]] = v;
  }
  return p;
}

const flags = (cmd) => String(cmd || '').replace(/^.*?llama-server /, '').replace(/\S*\/blobs\/sha256-(\w{8})\w+/g, '<blob $1>').replace(/"$/, '');
function lastServerCmd(from, file = LOG) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').slice(from); } catch { /* no log */ }
  const l = text.split('\n').filter((x) => /starting llama-server/.test(x)).at(-1);
  return l ? flags(l.match(/cmd="(.*)"/)?.[1] ?? l) : '(no llama-server start line)';
}
function logSince(from, re, max = 14) {
  const hits = logText().slice(from).split('\n').filter((l) => re.test(l));
  for (const l of hits.slice(0, max)) console.log(`  log> ${clip(l.replace(/^time=\S+\s+/, ''), 230)}`);
  if (!hits.length) console.log(`  log> (nothing matching ${re})`);
}
const MEMLOG = /kv[ _]cache|KV self size|n_ctx_seq\s|n_swa|swa_full|compute buffer size|model buffer size\s+=\s+\d{3,}|offloaded \d+\/\d+|prompt cache is enabled|has bfloat|memory_seq|failed|GGML_ASSERT|cannot run/i;

async function hello(model, ctx, extra = {}) {
  const mark = logText().length;
  const r = await api('/api/chat', { model, stream: false, think: false, messages: [user('Say hello in five words.')], options: { num_ctx: ctx, num_predict: 12, ...extra } });
  let res = r;
  if (r.status === 400 && /think/.test(r.json?.error || '')) res = await api('/api/chat', { model, stream: false, messages: [user('Say hello in five words.')], options: { num_ctx: ctx, num_predict: 12, ...extra } });
  out(`hello ${model} @${ctx}${extra.num_gpu === 0 ? ' cpu' : ''}`, { http: res.status, thinkFalseRejected: r !== res, content: res.json?.message?.content, ...stats(res.json), error: res.json?.error ?? res.error }, 200);
  return { ok: res.status === 200, mark };
}

async function probeNemotron() {
  const REPO = process.env.HF_REPO || 'unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF';
  const TAG = process.env.TAG || 'UD-Q3_K_XL';
  const M = `hf.co/${REPO}:${TAG}`;
  const blob = (digest) => path.join(os.homedir(), '.ollama/models/blobs', `sha256-${digest}`);
  let layers = [];
  let show = {};

  await section('machine', async () => {
    out('machine', { cpu: os.cpus()[0]?.model, cores: os.cpus().length, totalMemGb: +(os.totalmem() / 2 ** 30).toFixed(1), vm: vm(), version: (await api('/api/version')).json?.version });
  });

  await section(`pull ${M}`, async () => {
    const r = await api('/api/pull', { model: M, stream: true });
    out('pull', { http: r.status, seconds: Math.round(r.ms / 1000), last: lines(r.text).at(-1), error: r.error });
    show = (await api('/api/show', { model: M })).json || {};
    out('show', { capabilities: show.capabilities, details: show.details, parameters: show.parameters, templateChars: show.template?.length, templateHead: show.template?.slice(0, 120) }, 300);
    try {
      layers = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ollama/models/manifests/hf.co', REPO, TAG), 'utf8')).layers.map((l) => ({ type: l.mediaType.replace('application/vnd.ollama.image.', ''), digest: l.digest.slice(7), mb: Math.round(l.size / 2 ** 20) }));
    } catch (e) { out('manifest', `not readable: ${e.message}`); }
    out('layers', layers.map((l) => `${l.type}=${l.mb}MB`));
    const mf = String(show.modelfile || '');
    out('modelfile (non-comment lines, clipped)', mf.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => clip(l, 110)).slice(0, 40), 120);
    const t = layers.find((l) => l.type === 'template');
    if (t) { const text = fs.readFileSync(blob(t.digest), 'utf8'); out('template layer (Go template)', { chars: text.length, text }, 1500); }
    const p = layers.find((l) => l.type === 'params');
    if (p) out('params layer', fs.readFileSync(blob(p.digest), 'utf8'));
  });

  const model = layers.find((l) => l.type === 'model');
  const goTemplate = (() => { const t = layers.find((l) => l.type === 'template'); try { return t ? fs.readFileSync(blob(t.digest), 'utf8') : null; } catch { return null; } })();
  const params = parseParams(show.parameters);
  let TEXT = null;

  await section('text-only copies: which create request keeps the model\'s own chat format?', async () => {
    if (!model) { out('skip', 'no model layer'); return; }
    const files = { 'model.gguf': `sha256:${model.digest}` };
    const variants = [
      ['go', { files, template: goTemplate, parameters: params }],
      ['jinja', { files, template: show.template, parameters: params }],
      ['none', { files, parameters: params }],
    ];
    for (const [name, body] of variants) {
      if (name !== 'none' && !body.template) { out(`variant ${name}`, 'skipped: no template text'); continue; }
      const id = `nemotron-text-${name}:probe`;
      const c = await api('/api/create', { model: id, stream: false, ...body });
      const s = (await api('/api/show', { model: id })).json || {};
      out(`variant ${name}: create`, { http: c.status, body: c.json ?? clip(c.text, 300), capabilities: s.capabilities, templateChars: s.template?.length, templateHead: s.template?.slice(0, 80), runner: s.details?.runner }, 200);
      if (c.status !== 200) continue;
      const h = await hello(id, 2048);
      out(`variant ${name}: llama-server flags`, lastServerCmd(h.mark));
      if (h.ok && !/--chat-template chatml/.test(lastServerCmd(h.mark)) && !TEXT) TEXT = id;
    }
    out('text-only model chosen for the remaining checks', TEXT ?? 'none kept the native format; using the first that loads');
    if (!TEXT) TEXT = 'nemotron-text-none:probe';
  });

  await section('does LLAMA_ARG_CACHE_RAM reach llama-server through `ollama serve`?', async () => {
    const log2 = '/tmp/harness-ci-ollama2.log';
    const child = spawn('ollama', ['serve'], { env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11500', LLAMA_ARG_CACHE_RAM: '256', OLLAMA_NO_CLOUD: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_FLASH_ATTENTION: '1' }, stdio: ['ignore', fs.openSync(log2, 'w'), fs.openSync(log2, 'a')] });
    let spawnError = null;
    child.on('error', (e) => { spawnError = e.message; });
    await sleep(300);
    if (spawnError) { out('skip', `could not start a second ollama: ${spawnError}`); return; }
    try {
      await api('/api/generate', { model: TEXT, keep_alive: 0 });
      for (let i = 0; i < 60; i++) { if ((await api('/api/version', undefined, { base: 'http://127.0.0.1:11500', timeoutMs: 2000 })).status === 200) break; await sleep(500); }
      const r = await api('/api/chat', { model: TEXT, stream: false, think: false, messages: [user('Hi')], options: { num_ctx: 2048, num_predict: 4 } }, { base: 'http://127.0.0.1:11500' });
      out('chat via second server', { http: r.status, content: r.json?.message?.content, error: r.json?.error ?? r.error });
      const text = fs.readFileSync(log2, 'utf8');
      for (const l of text.split('\n').filter((x) => /prompt cache|cache-ram|LLAMA_ARG|OLLAMA_NO_CLOUD|no cloud/i.test(x)).slice(0, 6)) console.log(`  log> ${clip(l.replace(/^time=\S+\s+/, ''), 400)}`);
      out('flags', lastServerCmd(0, log2));
    } finally { child.kill('SIGTERM'); await sleep(1500); }
  });

  await section('memory at two context sizes (text-only)', async () => {
    for (const ctx of [4096, 16384]) {
      const h = await hello(TEXT, ctx);
      await mem(`text-only @${ctx}`);
      logSince(h.mark, MEMLOG);
    }
  });

  await section('tools (text-only)', async () => {
    const tools = [
      { type: 'function', function: { name: 'generate_image', description: 'Generate an image from a text prompt and show it to the user.', parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'What to draw' } }, required: ['prompt'] } } },
      { type: 'function', function: { name: 'get_current_time', description: 'Get the current date and time.', parameters: { type: 'object', properties: {} } } },
    ];
    const o = { num_ctx: 4096, num_predict: 90, temperature: 0 };
    const q = user('Draw me a red fox in the snow.');
    const call = await api('/api/chat', { model: TEXT, stream: false, think: false, tools, messages: [q], options: o });
    out('tool call', { http: call.status, message: call.json?.message, ...stats(call.json) }, 400);
    const calls = call.json?.message?.tool_calls || [];
    if (calls.length) {
      const back = await api('/api/chat', { model: TEXT, stream: false, think: false, tools, messages: [q, { role: 'assistant', content: '', tool_calls: calls }, { role: 'tool', tool_name: 'generate_image', content: 'Image generated and shown to the user.' }], options: o });
      out('after tool result', { http: back.status, message: back.json?.message, error: back.json?.error }, 400);
    }
    const st = await api('/api/chat', { model: TEXT, think: false, tools, messages: [user('What time is it right now?')], options: o });
    const ls = lines(st.text);
    out('streamed tool call', { http: st.status, total_lines: ls.length, tool_lines: ls.filter((l) => l.message?.tool_calls).slice(0, 1), last: ls.at(-1) }, 300);
  });

  await section('thinking and structured output (text-only)', async () => {
    const o = { num_ctx: 4096, num_predict: 70, temperature: 0 };
    for (const think of [true, false, undefined]) {
      const r = await api('/api/chat', { model: TEXT, stream: false, ...(think === undefined ? {} : { think }), messages: [user('What is 17 * 3?')], options: o });
      out(`think=${think}`, { http: r.status, error: r.json?.error, thinking: r.json?.message?.thinking, content: r.json?.message?.content, eval_tokens: r.json?.eval_count }, 160);
    }
    const s = await api('/api/chat', { model: TEXT, stream: false, think: false, format: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }, messages: [user('Give a short title for a chat about cooking pasta.')], options: { num_ctx: 2048, num_predict: 40, temperature: 0 } });
    out('format schema', { http: s.status, message: s.json?.message, error: s.json?.error });
    const sys = await api('/api/chat', { model: TEXT, stream: false, think: false, messages: [{ role: 'system', content: 'You are a pirate. Always answer like a pirate.' }, user('Where is the treasure?')], options: { num_ctx: 2048, num_predict: 30, temperature: 0 } });
    out('system prompt respected?', { http: sys.status, content: sys.json?.message?.content }, 300);
  });

  await section('the model with a projector: as pulled (BF16 projector), then the Q8 projector alias', async () => {
    await api('/api/generate', { model: TEXT, keep_alive: 0 });
    const h = await hello(M, 2048);
    out('as pulled: flags', lastServerCmd(h.mark));
    logSince(h.mark, /has bfloat|cannot run|GGML_ASSERT|clip_model_loader: (has|model size)|mmproj|projector/i, 8);
    const alias = `hf.co/${REPO}:${TAG.replace(/^UD-/, '')}`;
    if (alias === M) return;
    const r = await api('/api/pull', { model: alias, stream: true });
    out(`pull ${alias}`, { http: r.status, seconds: Math.round(r.ms / 1000), last: lines(r.text).at(-1), error: r.error });
    const h2 = await hello(alias, 2048);
    out('alias: flags', lastServerCmd(h2.mark));
    logSince(h2.mark, /has bfloat|cannot run|GGML_ASSERT|clip_model_loader: (has|model size)|mmproj|projector/i, 8);
    await mem('alias with projector @2K');
    if (h2.ok) {
      const img = await api('/api/chat', { model: alias, stream: false, messages: [user('What colour is this image? One word.', { images: [redPng(64).toString('base64')] })], options: { num_ctx: 4096, num_predict: 12 } });
      out('image input', { http: img.status, content: img.json?.message?.content, ...stats(img.json), error: img.json?.error }, 200);
      await mem('after image');
    }
  });
}

if (mode === 'nemotron') await probeNemotron(); else await probeApi();
