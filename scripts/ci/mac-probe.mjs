#!/usr/bin/env node
// CI-only: fact-finding against a REAL Ollama on a GitHub macOS runner. Prints one compact line per
// fact so the job log stays short. Not part of the app.
//
//   node scripts/ci/mac-probe.mjs api        # API behaviours Harness relies on (tiny models)
//   node scripts/ci/mac-probe.mjs nemotron   # the real Nemotron 3.5 Bolt E4B: load, memory, tools
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

async function api(p, body, { method, timeoutMs = 900000 } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(O + p, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* NDJSON or plain text */ }
    return { status: res.status, json, text, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, json: null, text: '', ms: Date.now() - t0, error: `${e.name}: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}` };
  }
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
    return { freeMb: pick('Pages free'), inactiveMb: pick('Pages inactive'), wiredMb: pick('Pages wired down'), compressedMb: pick('Pages occupied by compressor'), swap };
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

  await section('prompt cache vs RSS (32K context, alternating two different long prompts)', async () => {
    const o = { num_ctx: 32768, num_predict: 4 };
    await api('/api/chat', { model: CHAT, think: false, stream: false, messages: [user('hi')], options: o });
    await mem('loaded @32K');
    for (let i = 1; i <= 4; i++) {
      const a = await api('/api/chat', { model: CHAT, think: false, stream: false, messages: [user(`${LONG_A} ${LONG_A} ${LONG_A} Reply OK. (${i})`)], options: o });
      const b = await api('/api/chat', { model: CHAT, think: false, stream: false, messages: [user(`${LONG_B} ${LONG_B} ${LONG_B} Reply OK. (${i})`)], options: o });
      out(`round ${i}`, { a: stats(a.json), b: stats(b.json), rss: rss() });
    }
    await mem('after alternating');
    logFind(/prompt cache|cache state|cache size|saved to prompt cache/i, { max: 6, n: 300 });
    logFind(/starting llama-server/, { max: 1, n: 3000 });
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

async function exercise(M, tag) {
  await section(`[${tag}] memory vs num_ctx`, async () => {
    for (const ctx of [2048, 4096, 8192, 16384, 32768]) {
      const r = await api('/api/chat', { model: M, stream: false, messages: [user('Say hello in five words.')], options: { num_ctx: ctx, num_predict: 16 } });
      out(`num_ctx=${ctx}`, { http: r.status, content: r.json?.message?.content, thinking: r.json?.message?.thinking, ...stats(r.json) }, 160);
      await mem(`${ctx}`);
      if (r.status !== 200) break;
    }
  });
  await section(`[${tag}] long prompt at 8K, then switching conversations`, async () => {
    const o = { num_ctx: 8192, num_predict: 8 };
    const a = await api('/api/chat', { model: M, stream: false, messages: [user(`${LONG_A} Reply with OK.`)], options: o });
    out('long A', { chars: LONG_A.length, content: a.json?.message?.content, ...stats(a.json) }, 120);
    await mem('after long A');
    for (let i = 1; i <= 3; i++) {
      const b = await api('/api/chat', { model: M, stream: false, messages: [user(`${LONG_B} Reply with OK. (${i})`)], options: o });
      const a2 = await api('/api/chat', { model: M, stream: false, messages: [user(`${LONG_A} Reply with OK. (${i})`)], options: o });
      out(`switch ${i}`, { b: stats(b.json), a: stats(a2.json), rss: rss() });
    }
    await mem('after switching');
  });
  await section(`[${tag}] tools`, async () => {
    const tools = [
      { type: 'function', function: { name: 'generate_image', description: 'Generate an image from a text prompt and show it to the user.', parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'What to draw' } }, required: ['prompt'] } } },
      { type: 'function', function: { name: 'get_current_time', description: 'Get the current date and time.', parameters: { type: 'object', properties: {} } } },
    ];
    const o = { num_ctx: 4096, num_predict: 300, temperature: 0 };
    const q = user('Draw me a red fox in the snow.');
    const call = await api('/api/chat', { model: M, stream: false, tools, messages: [q], options: o });
    out('tool call', { http: call.status, message: call.json?.message, ...stats(call.json) }, 400);
    const calls = call.json?.message?.tool_calls || [];
    if (calls.length) {
      const back = await api('/api/chat', { model: M, stream: false, tools, messages: [q, { role: 'assistant', content: '', tool_calls: calls }, { role: 'tool', tool_name: 'generate_image', content: 'Image generated and shown to the user.' }], options: o });
      out('after tool result', { http: back.status, message: back.json?.message, error: back.json?.error }, 400);
    }
    const st = await api('/api/chat', { model: M, tools, messages: [user('What time is it right now?')], options: o });
    const ls = lines(st.text);
    out('streamed tool call', { http: st.status, total_lines: ls.length, tool_lines: ls.filter((l) => l.message?.tool_calls).slice(0, 2), last: ls.at(-1) }, 300);
    const plain = await api('/api/chat', { model: M, stream: false, tools, messages: [user('What is the capital of France?')], options: o });
    out('question needing no tool', { http: plain.status, message: plain.json?.message }, 300);
  });
  await section(`[${tag}] thinking and structured output`, async () => {
    const o = { num_ctx: 4096, num_predict: 300, temperature: 0 };
    for (const think of [true, false, undefined]) {
      const r = await api('/api/chat', { model: M, stream: false, ...(think === undefined ? {} : { think }), messages: [user('What is 17 * 3?')], options: o });
      out(`think=${think}`, { http: r.status, error: r.json?.error, thinking: r.json?.message?.thinking, content: r.json?.message?.content, eval_tokens: r.json?.eval_count }, 220);
    }
    const s = await api('/api/chat', { model: M, stream: false, format: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }, messages: [user('Give a short title for a chat about cooking pasta.')], options: { num_ctx: 2048, num_predict: 60, temperature: 0 } });
    out('format schema', { http: s.status, message: s.json?.message, error: s.json?.error });
  });
}

async function probeNemotron() {
  const REPO = process.env.HF_REPO || 'unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF';
  const TAG = process.env.TAG || 'UD-Q3_K_XL';
  const M = `hf.co/${REPO}:${TAG}`;

  await section('machine', async () => {
    out('machine', { cpu: os.cpus()[0]?.model, cores: os.cpus().length, totalMemGb: +(os.totalmem() / 2 ** 30).toFixed(1), freeMemGb: +(os.freemem() / 2 ** 30).toFixed(1), release: os.release(), vm: vm() });
    out('version', (await api('/api/version')).json);
  });

  await section(`which tags resolve on hf.co for ${REPO}`, async () => {
    for (const tag of ['UD-Q3_K_XL', 'Q3_K_XL', 'UD-Q4_K_XL', 'Q4_K_M', 'Q3_K_M', 'UD-IQ3_XXS', 'UD-Q2_K_XL', 'UD-IQ2_M', 'latest']) {
      try {
        const res = await fetch(`https://hf.co/v2/${REPO}/manifests/${tag}`, { headers: { accept: 'application/vnd.docker.distribution.manifest.v2+json' }, signal: AbortSignal.timeout(30000) });
        const j = await res.json().catch(() => null);
        out(tag, { http: res.status, layers: (j?.layers || []).map((l) => `${l.mediaType.replace('application/vnd.ollama.image.', '')}=${Math.round(l.size / 2 ** 20)}MB`), error: j?.errors || j?.error }, 200);
      } catch (e) { out(tag, { error: e.message }); }
    }
  });

  let modelDigest = null;
  await section(`pull ${M}`, async () => {
    const t0 = Date.now();
    const r = await api('/api/pull', { model: M, stream: true }, { timeoutMs: 1500000 });
    const ls = lines(r.text);
    out('pull', { http: r.status, seconds: Math.round((Date.now() - t0) / 1000), statuses: [...new Set(ls.map((l) => (l.status || '').replace(/sha256:\w+|[0-9a-f]{12}/, '<digest>')))].slice(0, 12), error: ls.find((l) => l.error)?.error ?? r.error, last: ls.at(-1) });
    const tags = await api('/api/tags');
    for (const m of tags.json?.models || []) out('installed', { name: m.name, sizeMb: Math.round(m.size / 2 ** 20), details: m.details }, 200);
    const show = await api('/api/show', { model: M });
    const j = show.json || {};
    out('show', { http: show.status, capabilities: j.capabilities, details: j.details, parameters: j.parameters, template: j.template, model_info: Object.fromEntries(Object.entries(j.model_info || {}).filter(([, v]) => !Array.isArray(v))) }, 300);
    const froms = String(j.modelfile || '').split('\n').filter((l) => /^(FROM|ADAPTER|PARSER|RENDERER|TEMPLATE|PARAMETER)\b/.test(l));
    out('modelfile directives', froms.map((l) => clip(l, 160)));
    modelDigest = String(j.modelfile || '').match(/^FROM\s+\S*sha256[-:]([0-9a-f]{64})/m)?.[1] || null;
    try {
      const mf = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ollama/models/manifests/hf.co', REPO, TAG), 'utf8'));
      out('on-disk manifest layers', mf.layers.map((l) => `${l.mediaType.replace('application/vnd.ollama.image.', '')}=${Math.round(l.size / 2 ** 20)}MB ${l.digest.slice(7, 19)}`));
      modelDigest = mf.layers.find((l) => l.mediaType.endsWith('.model'))?.digest.slice(7) || modelDigest;
    } catch (e) { out('on-disk manifest', `not readable: ${e.message}`); }
    out('model layer digest', modelDigest);
    out('disk', execFileSync('df', ['-h', '/'], { encoding: 'utf8' }).split('\n')[1]);
  });

  let fullWorks = false;
  await section('load as pulled (with the vision/audio projector)', async () => {
    const mark = logText().length;
    const r = await api('/api/chat', { model: M, stream: false, messages: [user('Say hello in five words.')], options: { num_ctx: 2048, num_predict: 16 } });
    out('chat', { http: r.status, content: r.json?.message?.content, ...stats(r.json) }, 200);
    fullWorks = r.status === 200;
    await mem('as pulled @2K');
    logFind(/starting llama-server/, { max: 1, n: 3500, from: mark });
    if (!fullWorks) {
      const seg = logText().slice(mark).split('\n');
      const i = seg.findIndex((l) => /GGML_ASSERT|libc\+\+abi|abort|terminat|failed to|error:/i.test(l));
      console.log('  log around the first failure:');
      for (const l of seg.slice(Math.max(0, i - 14), i + 4)) console.log(`  log> ${clip(l.replace(/^time=\S+\s+/, ''), 260)}`);
      const cpu = await api('/api/chat', { model: M, stream: false, messages: [user('Say hello in five words.')], options: { num_ctx: 2048, num_predict: 16, num_gpu: 0 } });
      out('same with num_gpu: 0', { http: cpu.status, content: cpu.json?.message?.content, ...stats(cpu.json) }, 200);
      await mem('as pulled, num_gpu 0');
    }
  });
  if (fullWorks) {
    await section('image input on the model as pulled', async () => {
      const png = redPng(64).toString('base64');
      const r = await api('/api/chat', { model: M, stream: false, messages: [user('What colour is this image? One word.', { images: [png] })], options: { num_ctx: 4096, num_predict: 20 } });
      out('image chat', { http: r.status, content: r.json?.message?.content, ...stats(r.json) }, 200);
      await mem('after image');
    });
    await exercise(M, 'as pulled');
    await api('/api/generate', { model: M, keep_alive: 0 });
    await sleep(2000);
  }

  const TEXT = `nemotron-bolt-e4b-text:${TAG.toLowerCase()}`;
  let textWorks = false;
  await section(`create a text-only copy (${TEXT}) from the model layer alone`, async () => {
    if (!modelDigest) { out('skip', 'no model layer digest found'); return; }
    const show = (await api('/api/show', { model: M })).json || {};
    const attempts = [
      ['files + parameters', { model: TEXT, files: { 'model.gguf': `sha256:${modelDigest}` }, parameters: parseParams(show.parameters), stream: false }],
      ['files only', { model: TEXT, files: { 'model.gguf': `sha256:${modelDigest}` }, stream: false }],
    ];
    for (const [label, body] of attempts) {
      const r = await api('/api/create', body, { timeoutMs: 600000 });
      out(`create (${label})`, { http: r.status, body: r.json ?? clip(r.text, 400), ms: r.ms });
      if (r.status === 200 && !r.json?.error) break;
    }
    const s = (await api('/api/show', { model: TEXT })).json || {};
    out('show text-only', { capabilities: s.capabilities, details: s.details, parameters: s.parameters, template: s.template }, 300);
    const mark = logText().length;
    const r = await api('/api/chat', { model: TEXT, stream: false, messages: [user('Say hello in five words.')], options: { num_ctx: 2048, num_predict: 16 } });
    out('chat', { http: r.status, content: r.json?.message?.content, ...stats(r.json) }, 200);
    textWorks = r.status === 200;
    logFind(/starting llama-server/, { max: 1, n: 3500, from: mark });
    if (!textWorks) {
      const seg = logText().slice(mark).split('\n');
      const i = seg.findIndex((l) => /GGML_ASSERT|libc\+\+abi|abort|terminat|failed to|error:/i.test(l));
      for (const l of seg.slice(Math.max(0, i - 14), i + 4)) console.log(`  log> ${clip(l.replace(/^time=\S+\s+/, ''), 260)}`);
    }
  });
  if (textWorks) {
    await exercise(TEXT, 'text-only');
    await section('unload the text-only model', async () => {
      const before = rss();
      const t0 = Date.now();
      await api('/api/generate', { model: TEXT, keep_alive: 0 });
      const samples = [];
      for (const wait of [200, 800, 2000, 4000]) { await sleep(wait); samples.push(`${Date.now() - t0}ms=${rss().totalMb}MB`); }
      out('unload', { rss_before: before, rss_after: samples.join(' '), ps: (await api('/api/ps')).json?.models?.length });
    });
  }
  await section('log lines about memory and layout', async () => {
    logFind(/offloaded \d+\/\d+ layers|model buffer size\s+=\s+\d{3,}|KV self size|kv cache|n_ctx_seq\s|llama_kv_cache|compute buffer size|sched.go.*(memory|vram)|n_swa|swa_full/i, { max: 24, n: 240 });
  });
}

if (mode === 'nemotron') await probeNemotron(); else await probeApi();
