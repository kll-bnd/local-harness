// Behaviour verified against a real Ollama 0.40.13 on Apple Silicon (coordinator's probes), with the fakes made to
// match: keep_alive forms (R1), explicit think and tool-call shapes (R2), measuring what the Mac really experiences
// (R3), no hidden client timeout on /api/chat (R4), the managed runner environment (R5), Nemotron's real files,
// load failures and text-only copies, empty answers after tool results, and the live-check author's findings.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setup, newChat, send, byType, text, waitFor, GiB } from './helpers.mjs';
import { startFakeA1111 } from './fake-a1111.mjs';
import { NEMOTRON_GO_TEMPLATE } from './fake-ollama.mjs';
import { normalizeKeepAlive, classifyPullError, classifyOllamaError, argsObject, modelfileBlobs } from '../server/providers/ollama.mjs';
import { managedOllamaEnv, promptCacheMiB } from '../server/providers/ollama-process.mjs';
import { DEFAULT_SETTINGS } from '../server/store/settings.mjs';
import { parseModelfileTemplate, parametersForCreate, textOnlyTemplate } from '../server/providers/text-only.mjs';
import { parseRunners, parseSwapUsage, parseVmStat, pressureDelta, createMemoryProbe } from '../server/system/memory-probe.mjs';
import { ComfyUIProvider } from '../server/image/comfyui.mjs';
import { A1111Provider } from '../server/image/a1111.mjs';

A1111Provider.pollMs = 20;
const MAC8 = { totalMem: 8 * GiB, platform: 'darwin', arch: 'arm64' };
const MAC16 = { totalMem: 16 * GiB, platform: 'darwin', arch: 'arm64' };
const HF = 'hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL';
const COPY = 'nvidia-nemotron-3.5-bolt-e4b-text:ud-q3_k_xl';
const isInternal = (b) => /extract durable|running summary|short, specific title/.test(JSON.stringify(b.messages.slice(0, 2)));

describe('R1 keep_alive forms', () => {
  test('numbers and unit strings pass; unit-less numeric strings become numbers; "0" unloads', async () => {
    assert.equal(normalizeKeepAlive('-1'), -1);
    assert.equal(normalizeKeepAlive('3600.5'), 3600.5);
    assert.equal(normalizeKeepAlive('0'), 0);
    assert.equal(normalizeKeepAlive('1h30m'), '1h30m');
    const h = await setup();
    try {
      const gen = (keep_alive) => fetch(`${h.fake.url}/api/generate`, { method: 'POST', body: JSON.stringify({ model: 'qwen3:4b', keep_alive }) });
      assert.equal((await gen('-1')).status, 400, 'the fake rejects unit-less strings like real Ollama');
      assert.equal((await (await gen('30')).json()).error, 'time: missing unit in duration "30"');
      assert.equal((await gen(300)).status, 200);
      assert.equal((await gen('5m')).status, 200);
      assert.equal((await gen('0')).status, 200, 'string zero is accepted (unloads)');
      assert.equal(h.fake.loaded.has('qwen3:4b'), false);
    } finally { await h.close(); }
  });
});

describe('R2 explicit think, tool-call shapes, cached prompt counts', () => {
  let h;
  before(async () => { h = await setup({ settings: { titles: { auto: true }, memory: { enabled: true, extractDelayMs: 0 }, defaultModel: { providerId: 'ollama', model: 'qwen3:4b' } } }); });
  after(() => h.close());

  test('every request carries think explicitly; internal calls never think (omitted = ON would eat num_predict)', async () => {
    const id = await newChat(h.c);
    await send(h.c, id, 'Hello there, my name is Ada and I live in Lisbon.');
    await h.app.background.idle();
    const all = h.fake.chatRequests();
    assert.ok(all.length >= 3, 'chat + title + memory extraction');
    for (const b of all) assert.equal(b.think, false, `${isInternal(b) ? 'internal' : 'chat'} request without think:false`);
    const chat = h.app.chats.get(id);
    assert.equal(chat.titleSource, 'auto');
    assert.ok(chat.title && chat.title !== 'New chat', `title: ${chat.title}`);
    // what Harness avoids: the fake (like Ollama) thinks when `think` is omitted and a small budget yields nothing
    const raw = await (await fetch(`${h.fake.url}/api/chat`, { method: 'POST', body: JSON.stringify({ model: 'qwen3:4b', stream: false, messages: [{ role: 'user', content: 'Write a short, specific title' }], options: { num_predict: 24 } }) })).json();
    assert.equal(raw.message.content, '');
    assert.ok(raw.message.thinking.length > 0);
    assert.equal(raw.done_reason, 'length');
  });

  test('a model without the thinking capability never gets think:true (the as-pulled Nemotron)', async () => {
    const id = await newChat(h.c, { settings: { reasoning: { think: 'on' }, model: { providerId: 'ollama', model: HF } } });
    const r = await send(h.c, id, 'hi');
    assert.equal(byType(r.events, 'done').length, 1, JSON.stringify(byType(r.events, 'error')));
    assert.equal(h.fake.chatRequests().at(-1).think, false);
    assert.equal(byType(r.events, 'notice').filter((n) => n.code === 'thinking_unsupported').length, 0);
  });

  test('tool calls keep Ollama\'s ids; history replays arguments as objects; cached prompt tokens are reported', async () => {
    const id = await newChat(h.c);
    const r = await send(h.c, id, 'calculate 6*7');
    const call = byType(r.events, 'tool_call')[0].toolCall;
    assert.match(call.id, /^call_[a-z0-9]+$/);
    const second = h.fake.chatRequests().filter((b) => !isInternal(b)).at(-1);
    const replayed = second.messages.find((m) => m.tool_calls);
    assert.equal(typeof replayed.tool_calls[0].function.arguments, 'object');
    assert.equal(second.messages.find((m) => m.role === 'tool').tool_name, 'calculate');
    const stats = byType(r.events, 'stats');
    assert.ok(stats[1].cachedPromptTokens > 0, 'the tool-loop call reuses the prompt prefix');
    assert.ok(stats[1].promptTokens > stats[1].cachedPromptTokens, 'prompt_eval_count is still the full prompt');
    // OpenAI-style string arguments in an imported chat are replayed as objects (a string is an HTTP 400)
    const imp = await h.c.post('/api/chats/import', { format: 'harness.chat', chat: { title: 'x', messages: {
      u: { id: 'u', parentId: null, role: 'user', content: 'calc' },
      a: { id: 'a', parentId: 'u', role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'calculate', arguments: '{"expression":"1+1"}' }] },
      t: { id: 't', parentId: 'a', role: 'tool', toolCallId: 'c1', toolName: 'calculate', content: '2' },
      b: { id: 'b', parentId: 't', role: 'assistant', content: 'It is 2.' },
    } } });
    const r2 = await send(h.c, imp.data.chats[0].id, 'thanks');
    assert.equal(byType(r2.events, 'done').length, 1, JSON.stringify(byType(r2.events, 'error')));
    assert.deepEqual(h.fake.chatRequests().filter((b) => !isInternal(b)).at(-1).messages.find((m) => m.tool_calls).tool_calls[0].function.arguments, { expression: '1+1' });
    assert.deepEqual(argsObject('[1,2]'), { value: [1, 2] });
  });
});

describe('empty final answer after tool results (Nemotron after generate_image)', () => {
  test('the image is the answer; other tools: one retry without tools, then a neutral line — never an error or a blank bubble', async () => {
    const a1111 = await startFakeA1111({ port: 0, stepMs: 1 });
    const h = await setup({ system: MAC16, settings: { image: { custom: [{ id: 'dt', name: 'Draw Things', kind: 'a1111', baseUrl: a1111.url, enabled: true }] }, titles: { auto: false }, memory: { enabled: false }, defaultModel: { providerId: 'ollama', model: 'qwen3:4b' } } });
    try {
      const id = await newChat(h.c);
      const n0 = h.fake.chatRequests().length;
      const r = await send(h.c, id, 'draw a red fox in the snow silent after tools');
      const done = byType(r.events, 'done')[0];
      assert.ok(done, JSON.stringify(byType(r.events, 'error')));
      assert.equal(done.message.fallback, 'image');
      assert.match(done.message.content, /^Here is the image of “a red fox in the snow/);
      assert.equal(h.fake.chatRequests().length - n0, 2, 'no retry for an image answer');
      assert.equal(byType(r.events, 'error').length, 0);

      const r2 = await send(h.c, id, 'silent after tools: calculate 2+2');
      const d2 = byType(r2.events, 'done')[0];
      assert.match(d2.message.content, /^Tool calculate returned: 2\+2 = 4/, 'answered on the retry');
      assert.equal(d2.message.fallback, undefined);
      assert.equal(h.fake.chatRequests().at(-1).tools, undefined, 'the retry offers no tools');

      const r3 = await send(h.c, id, 'always silent after tools: calculate 3*3');
      const d3 = byType(r3.events, 'done')[0];
      assert.equal(d3.message.fallback, 'tool_summary');
      assert.equal(d3.message.content, 'Tool results — calculate: 3*3 = 9');
      assert.equal(text(r3.events), d3.message.content, 'streamed like any answer');
      await h.restart();
      const kept = (await h.c.get(`/api/chats/${id}`)).data.messages.filter((m) => m.fallback);
      assert.deepEqual(kept.map((m) => m.fallback), ['image', 'tool_summary'], 'persisted');
    } finally { await h.close(); await a1111.close(); }
  });
});

describe('R3 memory measured as the Mac experiences it', () => {
  test('probe parsers: ps runners, vm.swapusage, vm_stat, pressure deltas (level alone is not a signal)', () => {
    const ps = [
      '  101  151234 /Applications/Ollama.app/Contents/Resources/ollama serve',
      `  202 4404020 /Applications/Ollama.app/Contents/Resources/llama-server --model /Users/x/.ollama/models/blobs/sha256-${'a'.repeat(64)} --ctx-size 4096`,
      '  303   88000 /usr/local/bin/ollama runner --model /x/blobs/sha256-' + 'b'.repeat(64),
      '  404    1000 /bin/zsh',
    ].join('\n');
    const rs = parseRunners(ps);
    assert.deepEqual(rs.map((r) => r.pid), [202, 303]);
    assert.equal(rs[0].rssBytes, 4404020 * 1024);
    assert.equal(rs[0].modelBlob, 'a'.repeat(64));
    assert.equal(parseSwapUsage('total = 2048.00M  used = 658.25M  free = 1389.75M  (encrypted)'), Math.round(658.25 * 1024 ** 2));
    assert.equal(parseSwapUsage('total = 4.00G  used = 1.50G  free = 2.50G'), 1.5 * 1024 ** 3);
    assert.equal(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  1000.\nPages occupied by compressor:   58000.\n'), 58000 * 16384);
    assert.equal(pressureDelta({ swapUsedBytes: 0, compressedBytes: 0.9e9, level: 1 }, { swapUsedBytes: 0.1e9, compressedBytes: 1.0e9, level: 1 }).signal, false);
    assert.equal(pressureDelta({ swapUsedBytes: 0, compressedBytes: 0.9e9, level: 1 }, { swapUsedBytes: 0.66e9, compressedBytes: 1.9e9, level: 1 }).signal, true);
    assert.equal(createMemoryProbe({ platform: 'linux' }), null, 'estimate only off macOS');
  });

  test('RSS-based sample; loading into swap steps auto mode down, then names a smaller file; explicit modes only warn', async () => {
    const h = await setup({ system: MAC8, settings: { defaultModel: { providerId: 'ollama', model: COPY }, titles: { auto: false }, memory: { enabled: false } } });
    try {
      assert.equal((await h.c.post('/api/models/text-only', { model: HF })).status, 201);
      h.fake.setPsProfile(COPY, { baseBytes: 4.3e9, perTokenBytes: 9000, psSizeBytes: 90e6 }); // ps size flat ~90 MB, like Nemotron
      const id = await newChat(h.c);
      const r1 = await send(h.c, id, 'hello');
      const p1 = byType(r1.events, 'start')[0].contextPlan;
      const meas = (await h.c.get(`/api/models/measurements?model=${encodeURIComponent(COPY)}`)).data;
      assert.equal(meas.samples[0].source, 'rss');
      assert.equal(meas.samples[0].totalBytes, 4.3e9 + 9000 * p1.numCtx, 'the runner RSS, not ps size');
      assert.equal(meas.samples[0].psSizeBytes, 90e6);
      assert.equal(meas.samples[0].pressure.signal, false);
      // the Mac now has much less free memory (other apps): the next load swaps
      h.probe.freeBytes = 3.2e9;
      h.fake.loaded.clear();
      h.app.engine.loadedCtx.clear();
      const r2 = await send(h.c, id, 'again');
      const p2 = byType(r2.events, 'start')[0].contextPlan;
      const n2 = byType(r2.events, 'notice').find((n) => n.code === 'memory_pressure');
      assert.ok(n2, JSON.stringify(byType(r2.events, 'notice')));
      assert.match(n2.message, new RegExp(`Loading ${COPY.replace(/[.]/g, '\\.')} at \\d+K made macOS swap \\(\\+\\d+(\\.\\d)? [GM]B swap, \\+\\d+(\\.\\d)? [GM]B compressed\\)\\. From the next message the context window will be \\d+K`));
      const p3 = (await h.c.get(`/api/models/context?model=${encodeURIComponent(COPY)}`)).data.contextPlan;
      assert.equal(p3.limitedBy, 'memory_pressure');
      // one step to what the swap growth allows (1.25 GB over ≫ the KV cost of the window → the minimum), not halving
      assert.equal(p3.numCtx, 2048, `${p2.numCtx} → ${p3.numCtx}`);
      assert.match(p3.explanation, /made macOS swap .*auto mode reduced the window/);
      assert.equal(p3.memory.pressure.numCtx, p2.numCtx);
      // explicit context: warned, kept
      const manual = (await h.c.get(`/api/models/context?model=${encodeURIComponent(COPY)}&mode=${p2.numCtx}`)).data.contextPlan;
      assert.equal(manual.numCtx, p2.numCtx);
      assert.ok(manual.warnings.some((w) => w.code === 'memory_pressure'));
      // even the minimum context swaps → "too big for this Mac" and the next smaller recommended file
      h.probe.freeBytes = 1e9;
      await h.c.patch('/api/settings', { context: { mode: 2048 } });
      h.fake.loaded.clear();
      h.app.engine.loadedCtx.clear();
      await send(h.c, id, 'at the minimum');
      await h.c.patch('/api/settings', { context: { mode: 'auto' } });
      const p4 = (await h.c.get(`/api/models/context?model=${encodeURIComponent(COPY)}`)).data.contextPlan;
      const big = p4.warnings.find((w) => w.code === 'model_too_big');
      assert.ok(big, JSON.stringify(p4.warnings));
      assert.match(big.message, /is too big for this 8 GB Mac: even the minimum 2K context made macOS swap .* Use a smaller file: hf\.co\/unsloth\/NVIDIA-Nemotron-3\.5-Bolt-E4B-GGUF:UD-Q2_K_XL \(3\.\d GB as a text-only copy\)\./);
      assert.equal(p4.numCtx, 2048);
      // a later clean load at that context clears it (other apps were closed)
      h.probe.freeBytes = Infinity;
      h.fake.loaded.clear();
      h.app.engine.loadedCtx.clear();
      await h.c.patch('/api/settings', { context: { mode: 8192 } });
      await send(h.c, id, 'room again');
      await h.c.patch('/api/settings', { context: { mode: 'auto' } });
      const p5 = (await h.c.get(`/api/models/context?model=${encodeURIComponent(COPY)}`)).data.contextPlan;
      assert.ok(!p5.warnings.some((w) => w.code === 'model_too_big'));
    } finally { await h.close(); }
  });

  test('no probe (not macOS) → estimate only; no runner visible → model file + ps size', async () => {
    const h = await setup({ system: { totalMem: 16 * GiB, platform: 'linux', arch: 'x64' }, probe: null, settings: { defaultModel: { providerId: 'ollama', model: 'qwen3:4b' }, titles: { auto: false }, memory: { enabled: false } } });
    try {
      await send(h.c, await newChat(h.c), 'hi');
      assert.equal((await h.c.get('/api/models/measurements?model=qwen3:4b')).data.samples.length, 0);
      assert.match((await h.c.get('/api/models/context?model=qwen3:4b')).data.contextPlan.explanation, /KV cache precision unknown \(this Ollama was not started by Harness\): assuming f16/);
    } finally { await h.close(); }
    const h2 = await setup({ system: MAC16, settings: { defaultModel: { providerId: 'ollama', model: 'qwen3:4b' }, titles: { auto: false }, memory: { enabled: false } } });
    try {
      h2.probe.hideRunners = true;
      await send(h2.c, await newChat(h2.c), 'hi');
      const smp = (await h2.c.get('/api/models/measurements?model=qwen3:4b')).data.samples[0];
      assert.equal(smp.source, 'ps');
      assert.equal(smp.totalBytes, 2.5e9 + smp.psSizeBytes);
    } finally { await h2.close(); }
  });

  test('image unload decisions and loaded-model reports use the resident footprint, not ps size', async () => {
    const a1111 = await startFakeA1111({ port: 0, stepMs: 1 });
    const h = await setup({ system: MAC16, settings: { image: { custom: [{ id: 'dt', name: 'Draw Things', kind: 'a1111', baseUrl: a1111.url, enabled: true }] }, titles: { auto: false }, memory: { enabled: false } } });
    try {
      await send(h.c, await newChat(h.c), 'hi'); // the official 7.9 GB Nemotron
      const loaded = (await h.c.get('/api/models/loaded')).data.models[0];
      assert.ok(loaded.sizeBytes < 1e9, 'ps size excludes the weights');
      assert.ok(loaded.residentBytes > 7.9e9, `resident ${loaded.residentBytes}`);
      assert.equal(loaded.residentBasis, 'measured');
      // SDXL (~7 GB) next to the 7.9 GB chat model does not fit in 16 GB — ps size alone (~0.1 GB) said it did
      const r = await h.c.sse('/api/images/generate', { providerId: 'dt', prompt: 'x', model: 'sdxl_base_1.0.safetensors [d4e5f6]' });
      const un = byType(r.events, 'image_status').find((s) => s.phase === 'unloading');
      assert.ok(un, JSON.stringify(byType(r.events, 'image_status')));
      assert.equal(un.reason, 'insufficient_ram');
      assert.ok(byType(r.events, 'done')[0].job.memory.loadedBytes > 7.9e9);
      // a small image model next to it still fits
      await send(h.c, await newChat(h.c), 'again');
      const r2 = await h.c.sse('/api/images/generate', { providerId: 'dt', prompt: 'y', model: 'sd_turbo.safetensors [a1b2c3]' });
      assert.equal(byType(r2.events, 'done')[0].job.memory.reason, 'fits');
    } finally { await h.close(); await a1111.close(); }
  });
});

describe('R4 no hidden client timeout on /api/chat', () => {
  test('a chat turn does not use undici fetch and survives a slow first token (headers arrive late)', async () => {
    const h = await setup({ settings: { titles: { auto: false }, memory: { enabled: false } } });
    const orig = globalThis.fetch;
    try {
      h.fake.headerDelayMs = 1200;
      const id = await newChat(h.c);
      const c = h.c;
      // the test client itself still needs fetch: keep a private reference for it
      const clientFetch = orig;
      globalThis.fetch = (url, ...rest) => (String(url).startsWith(h.url) ? clientFetch(url, ...rest) : Promise.reject(new Error('backend calls must not use undici fetch')));
      const r = await c.sse(`/api/chats/${id}/messages`, { content: 'slow prompt processing' });
      assert.equal(byType(r.events, 'done').length, 1, JSON.stringify(byType(r.events, 'error')));
    } finally { globalThis.fetch = orig; h.fake.headerDelayMs = 0; await h.close(); }
  });
});

describe('R5 the environment of an app-spawned ollama serve', () => {
  test('OLLAMA_NO_CLOUD and a RAM-scaled prompt-cache cap (LLAMA_ARG_CACHE_RAM); both configurable', () => {
    const base = { baseUrl: 'http://127.0.0.1:11434' };
    const env = (totalMem, ollama = {}) => managedOllamaEnv({ ...DEFAULT_SETTINGS, ollama: { ...DEFAULT_SETTINGS.ollama, ...ollama } }, { ...base, totalMem });
    assert.equal(env(8 * GiB).LLAMA_ARG_CACHE_RAM, '512');
    assert.equal(env(16 * GiB).LLAMA_ARG_CACHE_RAM, '2048');
    assert.equal(env(64 * GiB).LLAMA_ARG_CACHE_RAM, undefined, 'runner default above 16 GB');
    assert.equal(env(8 * GiB, { promptCacheMiB: 256 }).LLAMA_ARG_CACHE_RAM, '256');
    assert.equal(env(8 * GiB, { promptCacheMiB: null }).LLAMA_ARG_CACHE_RAM, undefined);
    assert.equal(env(8 * GiB).OLLAMA_NO_CLOUD, '1');
    assert.equal(env(8 * GiB, { noCloud: false }).OLLAMA_NO_CLOUD, undefined);
    assert.equal(promptCacheMiB('auto', 8 * GiB), 512);
  });

  test('system info says when the protections are NOT in effect (an Ollama Harness did not start) and how to get them', async () => {
    const h = await setup();
    try {
      const o = (await h.c.get('/api/system')).data.ollama;
      assert.equal(o.protections.inEffect, false);
      assert.equal(o.protections.external, true);
      assert.match(o.protections.message, /not started by Harness, so its memory protections are not in effect .*quit the other Ollama .* restart Harness/);
      assert.equal(o.protections.wanted.OLLAMA_NO_CLOUD, '1');
      assert.equal((await h.c.patch('/api/settings', { ollama: { promptCacheMiB: 'lots' } })).status, 400);
    } finally { await h.close(); }
  });
});

describe('Nemotron: load failures and text-only copies', () => {
  let h;
  before(async () => { h = await setup({ system: MAC8, settings: { titles: { auto: false }, memory: { enabled: false } } }); });
  after(() => h.close());

  test('a runner crash while loading → model_load_failed with next steps; the chat is not stuck; background work does not retry-loop', async () => {
    h.fake.failLoad(HF);
    const id = await newChat(h.c, { settings: { model: { providerId: 'ollama', model: HF } } });
    const n0 = h.fake.chatRequests().length;
    const r = await send(h.c, id, 'hello');
    const err = byType(r.events, 'error')[0];
    assert.equal(err.code, 'model_load_failed');
    assert.match(err.message, /could not be loaded: Ollama's model runner stopped while starting it \(llama-server process has terminated: signal: abort trap\)\. This happens when the image\/audio part .* Next step: create a text-only copy/);
    assert.deepEqual(err.nextSteps.map((s) => s.action), ['create_text_only_copy', 'use_smaller_file', 'retry']);
    assert.deepEqual(err.nextSteps[0].body, { model: HF, providerId: 'ollama' });
    assert.equal(h.fake.chatRequests().length - n0, 1, 'tried once, no retry loop');
    assert.equal(h.app.engine.busy(id), false);
    const a = (await h.c.get(`/api/chats/${id}`)).data.messages.find((m) => m.role === 'assistant');
    assert.equal(a.status, 'error');
    assert.equal(a.errorCode, 'model_load_failed');
    await assert.rejects(h.app.llm.complete({ ref: { providerId: 'ollama', model: HF }, messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'model_load_failed' && /Skipped/.test(e.message));
    assert.equal(h.fake.chatRequests().length - n0, 1, 'background calls are skipped while the failure is fresh');
    const pre = await h.c.post('/api/models/load', { model: HF });
    assert.equal(pre.status, 502);
    assert.equal(pre.data.error.code, 'model_load_failed');
    assert.equal(pre.data.error.details.nextSteps[0].action, 'create_text_only_copy');
  });

  test('the verified recipe: first FROM blob, the Modelfile TEMPLATE (never show.template), parsed stop parameters', async () => {
    const show = await (await fetch(`${h.fake.url}/api/show`, { method: 'POST', body: JSON.stringify({ model: HF }) })).json();
    assert.ok(show.template.includes('{%'), 'show.template holds the GGUF jinja template');
    const r = await h.c.post('/api/models/text-only', { model: HF });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.model, COPY);
    assert.equal(r.data.template, 'modelfile');
    assert.deepEqual(r.data.capabilities, ['completion', 'tools', 'thinking']);
    assert.match(r.data.note, /Deleting .* frees its projector's disk space; the copy keeps the weights/);
    const body = h.fake.creates.at(-1).body;
    assert.deepEqual(body.files, { 'model.gguf': `sha256:${modelfileBlobs(show.modelfile)[0]}` });
    assert.equal(body.template, NEMOTRON_GO_TEMPLATE);
    assert.equal(body.template.length, 159);
    assert.deepEqual(body.parameters, { stop: ['<bos>', '<|turn>', '<turn|>', '<|turn>user'] });
    assert.equal(body.stream, false);
    // the copy loads (no projector) and may think
    const id = await newChat(h.c, { settings: { model: { providerId: 'ollama', model: COPY }, reasoning: { think: 'on' } } });
    const t = await send(h.c, id, 'hello');
    assert.equal(byType(t.events, 'done').length, 1, JSON.stringify(byType(t.events, 'error')));
    assert.equal(h.fake.chatRequests().at(-1).think, true);
    // idempotent, listed, deletable (only copies Harness made)
    const again = await h.c.post('/api/models/text-only', { model: HF });
    assert.equal(again.status, 200);
    assert.equal(again.data.created, false);
    assert.equal((await h.c.get('/api/models/text-only')).data.copies[0].source, HF);
    assert.equal((await h.c.post('/api/models/text-only', { model: 'qwen3:4b' })).data.error.code, 'not_multimodal');
    assert.equal((await h.c.del('/api/models/text-only?model=qwen3:4b')).status, 404);
    assert.equal((await h.c.del(`/api/models/text-only?model=${encodeURIComponent(COPY)}`)).status, 200);
    assert.equal(h.fake.installed.has(COPY), false);
    h.fake.failLoad(null);
  });

  test('template parsing: "…" over several lines with escapes, """…""", none (→ no template)', () => {
    assert.equal(parseModelfileTemplate('FROM /b/sha256-x\nTEMPLATE "a\n\\"b\\" \\\\ c"\nPARAMETER stop "x"'), 'a\n"b" \\ c');
    assert.equal(parseModelfileTemplate('TEMPLATE """{{ .Prompt }}\nx"""'), '{{ .Prompt }}\nx');
    assert.equal(parseModelfileTemplate('FROM x\nPARAMETER stop "y"'), null);
    assert.deepEqual(textOnlyTemplate({ modelfile: 'FROM x', template: '{%- jinja -%}' }), { template: undefined, source: 'none' });
    assert.deepEqual(parametersForCreate('stop "a"\nstop "b"\ntemperature 0.7\nnum_ctx 4096'), { stop: ['a', 'b'], temperature: 0.7, num_ctx: 4096 });
  });
});

describe('live-check findings', () => {
  test('pull errors: offline vs really not found', () => {
    assert.equal(classifyPullError('pull model manifest: Get "https://registry.ollama.ai/v2/library/x/manifests/latest": dial tcp: lookup registry.ollama.ai: no such host', 'x', 'ollama').code, 'registry_unreachable');
    assert.equal(classifyPullError('pull model manifest: file does not exist', 'x', 'ollama').code, 'model_not_found');
    assert.equal(classifyPullError('file does not exist', 'hf.co/a/b:Q3_K_XL', 'ollama').code, 'model_not_found');
    assert.equal(classifyOllamaError(500, 'llama-server process has terminated: signal: abort trap', 'ollama').code, 'model_load_failed');
  });

  test('ComfyUI validation errors keep their node-level detail', async () => {
    const srv = http.createServer((req, res) => {
      res.writeHead(req.url === '/prompt' ? 400 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/prompt'
        ? { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '', extra_info: {} }, node_errors: { 4: { errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "ckpt_name: 'missing.safetensors' not in ['sd15.safetensors']" }], class_type: 'CheckpointLoaderSimple' } } }
        : {}));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const p = new ComfyUIProvider({ id: 'c', name: 'ComfyUI', baseUrl: `http://127.0.0.1:${srv.address().port}` });
      await assert.rejects(p.generate({ prompt: 'x', negativePrompt: '', width: 64, height: 64, steps: 1, cfg: 1, seed: 1, count: 1, model: 'missing.safetensors' }), (e) => {
        assert.equal(e.code, 'workflow_invalid');
        assert.match(e.message, /Prompt outputs failed validation: CheckpointLoaderSimple \(node 4\): Value not in list — ckpt_name: 'missing\.safetensors' not in \['sd15\.safetensors'\]/);
        assert.ok(e.nodeErrors[4]);
        return true;
      });
    } finally { srv.close(); }
  });

  test('KV precision: unknown for an Ollama Harness did not start (f16 assumed, said so) unless set', async () => {
    const h = await setup({ settings: { defaultModel: { providerId: 'ollama', model: 'qwen3:4b' } } });
    try {
      const p = (await h.c.get('/api/models/context?model=qwen3:4b')).data.contextPlan;
      assert.equal(p.memory.kvCacheType, 'f16');
      assert.equal(p.memory.kvCacheTypeSource, 'assumed');
      process.env.OLLAMA_KV_CACHE_TYPE = 'q8_0'; // Harness's own environment says nothing about another Ollama
      try { assert.equal((await h.c.get('/api/models/context?model=qwen3:4b')).data.contextPlan.memory.kvCacheType, 'f16'); } finally { delete process.env.OLLAMA_KV_CACHE_TYPE; }
      await h.c.patch('/api/settings', { context: { kvCacheType: 'q8_0' } });
      const q = (await h.c.get('/api/models/context?model=qwen3:4b')).data.contextPlan;
      assert.equal(q.memory.kvCacheType, 'q8_0');
      assert.equal(q.memory.kvCacheTypeSource, 'setting');
      assert.ok(!/precision unknown/.test(q.explanation));
    } finally { await h.close(); }
  });

  test('pulling a tag that must never be suggested says why', async () => {
    const h = await setup();
    try {
      const r = await h.c.sse('/api/models/pull', { model: 'nemotron-3.5-bolt:latest' });
      assert.match(byType(r.events, 'start')[0].warning.message, /different, 22 GB model/);
    } finally { await h.close(); }
  });
});
