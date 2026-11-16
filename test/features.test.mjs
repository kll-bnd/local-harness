// Attachments + document RAG, export/import, search, model management, system info, events,
// Ollama process spawning, OpenAI-compatible provider.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setup, newChat, send, byType, text, tmpDir, parseSse, waitFor } from './helpers.mjs';
import { startFakeOpenAI } from './fake-openai.mjs';
import { makePng } from './png.mjs';
import { buildPdf } from './pdf-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

async function upload(h, name, buf, mime, chatId) {
  const q = new URLSearchParams({ name, ...(chatId ? { chatId } : {}) });
  const r = await fetch(`${h.url}/api/attachments?${q}`, { method: 'POST', headers: { 'content-type': mime }, body: buf });
  return { status: r.status, data: await r.json() };
}

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

describe('attachments and document RAG', () => {
  let h;
  before(async () => { h = await setup({ settings: { tools: { enabled: false }, memory: { enabled: false }, titles: { auto: false } } }); });
  after(() => h.close());

  test('small text/code files are inlined into the user message', async () => {
    const chat = await newChat(h.c);
    const up = await upload(h, 'hello.py', Buffer.from('def greet():\n    return "hi from the file"\n'), 'text/x-python', chat);
    assert.equal(up.status, 201);
    assert.equal(up.data.attachment.kind, 'text');
    assert.ok(up.data.attachment.tokens > 0);
    const r = await send(h.c, chat, 'What does this code do?', { attachments: [up.data.attachment.id] });
    assert.equal(byType(r.events, 'start')[0].userMessage.attachments[0].name, 'hello.py');
    const lastUser = h.fake.chatRequests().at(-1).messages.at(-1);
    assert.match(lastUser.content, /<file name="hello.py">\ndef greet\(\):[\s\S]*<\/file>\n\nWhat does this code do\?/);
    const txt = await h.c.get(`/api/attachments/${up.data.attachment.id}/text`);
    assert.match(txt.data.text, /hi from the file/);
  });

  test('large documents are chunked and only relevant excerpts are retrieved per turn', async () => {
    const chat = await newChat(h.c, { settings: { context: { mode: 4096 } } });
    const sections = Array.from({ length: 60 }, (_, i) => `Section ${i}. ${i === 42 ? 'The warranty for the Zephyr router lasts exactly 37 months from purchase.' : 'This section describes routine maintenance procedures for office equipment and furniture.'} ${'Additional filler text about policies and procedures. '.repeat(6)}`);
    const up = await upload(h, 'manual.txt', Buffer.from(sections.join('\n\n')), 'text/plain', chat);
    const a = up.data.attachment;
    assert.ok(a.chunks > 5, `chunks ${a.chunks}`);
    const r = await send(h.c, chat, 'How long is the Zephyr router warranty?', { attachments: [a.id] });
    const ret = byType(r.events, 'retrieval')[0];
    assert.ok(ret.documents.length >= 1);
    const lastUser = h.fake.chatRequests().at(-1).messages.at(-1);
    assert.match(lastUser.content, /Excerpts from attached documents:[\s\S]*Zephyr router lasts exactly 37 months/);
    assert.match(lastUser.content, /\[Document attached: manual\.txt/);
    assert.ok(!lastUser.content.includes('Section 3.'), 'irrelevant sections are not sent');
    const ctx = byType(r.events, 'context')[0];
    assert.ok(ctx.breakdown.documents > 0 && ctx.breakdown.documents <= Math.ceil(4096 * 0.2) + 50);
    // follow-up turn on the same chat retrieves again from the earlier attachment
    await send(h.c, chat, 'And the Zephyr warranty starts when?');
    assert.match(h.fake.chatRequests().at(-1).messages.at(-1).content, /37 months/);
  });

  test('PDF uploads are text-extracted; unsupported binaries are refused at send time', async () => {
    const chat = await newChat(h.c);
    const pdf = await upload(h, 'spec.pdf', buildPdf(['BT /F1 12 Tf 72 720 Td (Quarterly revenue grew 12 percent) Tj ET']), 'application/pdf', chat);
    assert.equal(pdf.data.attachment.kind, 'text');
    assert.equal(pdf.data.attachment.pages, 1);
    await send(h.c, chat, 'summarize', { attachments: [pdf.data.attachment.id] });
    assert.match(h.fake.chatRequests().at(-1).messages.at(-1).content, /Quarterly revenue grew 12 percent/);
    const bin = await upload(h, 'blob.bin', Buffer.from([0, 1, 2, 3, 4, 0, 0, 9]), 'application/octet-stream', chat);
    assert.equal(bin.data.attachment.kind, 'binary');
    assert.equal(bin.data.attachment.status, 'error');
    const r = await send(h.c, chat, 'read this', { attachments: [bin.data.attachment.id] });
    assert.equal(r.status, 400);
    assert.equal(r.error.error.code, 'attachment_unusable');
  });

  test('images go to vision models as base64; non-vision models get a placeholder note', async () => {
    const chat = await newChat(h.c);
    const png = makePng(32, 16, 3);
    const up = await upload(h, 'pic.png', png, 'image/png', chat);
    assert.equal(up.data.attachment.kind, 'image');
    assert.equal(up.data.attachment.width, 32);
    const raw = await fetch(h.url + up.data.attachment.url);
    assert.equal(raw.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await raw.arrayBuffer()).length, png.length);
    const r = await send(h.c, chat, 'what is in this picture?', { attachments: [up.data.attachment.id], model: { model: 'gemma3:4b' } });
    assert.match(text(r.events), /\[I see 1 image\(s\)\]/);
    const lastUser = h.fake.chatRequests().at(-1).messages.at(-1);
    assert.equal(lastUser.images[0], png.toString('base64'));
    const chat2 = await newChat(h.c);
    await send(h.c, chat2, 'and now?', { attachments: [up.data.attachment.id], model: { model: 'gemma2:2b' } });
    const u2 = h.fake.chatRequests().at(-1).messages.at(-1);
    assert.equal(u2.images, undefined);
    assert.match(u2.content, /\[Image attached: pic\.png \(this model cannot see images\)\]/);
  });
});

describe('export, import, search', () => {
  let h;
  before(async () => { h = await setup({ settings: { tools: { enabled: false }, memory: { enabled: false } } }); });
  after(() => h.close());

  test('markdown + JSON export, JSON/OpenAI import, full-text search, backup export', async () => {
    const chat = await newChat(h.c, { title: 'Export test' });
    await send(h.c, chat, 'The aardvark question about burrows');
    await send(h.c, chat, 'second message here');
    const md = await fetch(`${h.url}/api/chats/${chat}/export?format=markdown`);
    assert.match(md.headers.get('content-disposition'), /Export test\.md/);
    const mdText = await md.text();
    assert.match(mdText, /^# Export test/);
    assert.match(mdText, /## User\n\nThe aardvark question about burrows/);
    assert.match(mdText, /## Assistant \(nemotron-3.5-bolt:e4b\)\n\nYou said: The aardvark/);
    const js = await h.c.get(`/api/chats/${chat}/export?format=json`);
    assert.equal(js.data.format, 'harness.chat');
    assert.equal(Object.keys(js.data.chat.messages).length, 4);
    const imp = await h.c.post('/api/chats/import', js.data);
    assert.equal(imp.status, 201);
    const newId = imp.data.chats[0].id;
    assert.notEqual(newId, chat, 'id collision → new id');
    const d = (await h.c.get(`/api/chats/${newId}`)).data;
    assert.equal(d.messages.length, 4);
    assert.equal(d.path.length, 4);
    const oa = await h.c.post('/api/chats/import', { title: 'From OpenAI', messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello!' }] });
    const od = (await h.c.get(`/api/chats/${oa.data.chats[0].id}`)).data;
    assert.deepEqual(od.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal((await h.c.post('/api/chats/import', { nope: 1 })).status, 400);
    const s = await h.c.get('/api/search?q=' + encodeURIComponent('aardvark burrows'));
    assert.ok(s.data.results.length >= 2);
    const hit = s.data.results.find((x) => x.chatId === chat && x.role === 'user');
    assert.match(hit.snippet, /aardvark/);
    assert.ok(hit.highlights.length >= 2);
    assert.equal((await h.c.get('/api/search')).status, 400);
    const backup = await h.c.get('/api/export');
    assert.equal(backup.data.format, 'harness.backup');
    assert.ok(backup.data.chats.length >= 3);
  });
});

describe('model management, system info, events', () => {
  let h;
  before(async () => { h = await setup({ settings: { tools: { enabled: false }, memory: { enabled: false } } }); });
  after(() => h.close());

  test('list, info, pull with streamed progress, delete, unload, load', async () => {
    const list = (await h.c.get('/api/models?details=1')).data;
    const nemo = list.models.find((m) => m.model === 'nemotron-3.5-bolt:e4b');
    assert.ok(nemo.capabilities.includes('tools'));
    assert.equal(nemo.contextLength, 65536);
    assert.equal(list.defaultModel.model, 'nemotron-3.5-bolt:e4b', 'Nemotron preferred as default');
    assert.ok(list.models.find((m) => m.model === 'embeddinggemma:latest').embedding);
    const pull = await h.c.sse('/api/models/pull', { model: 'llama3.2:3b' });
    const prog = byType(pull.events, 'progress');
    assert.ok(prog.length >= 10);
    assert.ok(prog.some((p) => p.percent === 100));
    assert.equal(byType(pull.events, 'done')[0].status, 'success');
    assert.ok((await h.c.get('/api/models?refresh=1')).data.models.some((m) => m.model === 'llama3.2:3b'));
    const bad = await h.c.sse('/api/models/pull', { model: 'definitely-not-a-model' });
    assert.match(byType(bad.events, 'error')[0].message, /file does not exist/);
    assert.equal((await h.c.del('/api/models?model=' + encodeURIComponent('llama3.2:3b'))).status, 200);
    assert.ok(!(await h.c.get('/api/models?refresh=1')).data.models.some((m) => m.model === 'llama3.2:3b'));
    const load = await h.c.post('/api/models/load', { model: 'qwen3:4b' });
    assert.ok(load.data.numCtx > 0);
    const loaded = (await h.c.get('/api/models/loaded')).data.models;
    assert.ok(loaded.some((m) => m.model === 'qwen3:4b'));
    await h.c.post('/api/models/unload', { model: 'qwen3:4b' });
    assert.ok(h.fake.unloads.includes('qwen3:4b'));
    const rec = (await h.c.get('/api/models/recommended')).data;
    assert.equal(rec.models[0].name, 'NVIDIA Nemotron 3.5 Bolt E4B');
    assert.equal(rec.models[0].variants[0].installed, true);
  });

  test('system info + provider status', async () => {
    const s = (await h.c.get('/api/system')).data;
    assert.equal(s.app.name, 'harness');
    assert.ok(s.machine.totalMemBytes > 0 && s.machine.ramTier);
    assert.ok(s.machine.memoryBudget.budgetBytes > 0);
    assert.equal(s.providers[0].id, 'ollama');
    assert.equal(s.providers[0].status, 'running');
    assert.equal(s.providers[0].version, '0.12.6-fake');
    assert.ok('installed' in s.ollama && s.ollama.recommendedEnv.OLLAMA_FLASH_ATTENTION === '1');
    assert.ok(Array.isArray(s.imageProviders));
    assert.equal(s.embeddings.enabled, false);
  });

  test('global /api/events stream delivers background events', async () => {
    const ac = new AbortController();
    const got = [];
    const res = await fetch(h.url + '/api/events', { signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) { got.push(...parseSse(buf.slice(0, i + 2))); buf = buf.slice(i + 2); }
        }
      } catch { /* aborted */ }
    })();
    await waitFor(() => got.some((e) => e.type === 'hello'));
    const chat = await newChat(h.c, { title: 'evented' });
    await send(h.c, chat, 'hello events');
    await waitFor(() => got.some((e) => e.type === 'generation.finished'));
    ac.abort();
    await pump;
    assert.ok(got.some((e) => e.type === 'chat.created' && e.chat.title === 'evented'));
    assert.ok(got.some((e) => e.type === 'generation.started' && e.chatId === chat));
  });
});

describe('Ollama process management', () => {
  test('spawns `ollama serve` with the memory-friendly environment and stops it', async () => {
    const dir = await tmpDir();
    const port = await freePort();
    const envFile = path.join(dir, 'env.json');
    const bin = path.join(dir, 'ollama');
    await fs.writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, 'fake-ollama-bin.mjs')}" "$@"\n`);
    await fs.chmod(bin, 0o755);
    const h = await setup({ system: { totalMem: 8 * 1024 ** 3, platform: 'darwin', arch: 'arm64' }, settings: { ollama: { binaryPath: bin }, providers: { builtin: { ollama: { baseUrl: `http://127.0.0.1:${port}` } } } } });
    process.env.FAKE_OLLAMA_ENV_FILE = envFile;
    try {
      const info = (await h.c.get('/api/system')).data;
      assert.equal(info.providers[0].status, 'unreachable');
      assert.equal(info.ollama.installed, true);
      const st = await h.c.post('/api/providers/ollama/start');
      assert.equal(st.status, 200, JSON.stringify(st.data));
      assert.equal(st.data.started, true);
      const env = JSON.parse(await fs.readFile(envFile, 'utf8'));
      assert.equal(env.OLLAMA_HOST, `127.0.0.1:${port}`);
      assert.equal(env.OLLAMA_FLASH_ATTENTION, '1');
      assert.equal(env.OLLAMA_KV_CACHE_TYPE, 'q8_0');
      assert.equal(env.OLLAMA_NUM_PARALLEL, '1');
      assert.equal(env.OLLAMA_MAX_LOADED_MODELS, '1');
      assert.equal(env.argv[0], 'serve');
      // the app now knows the KV cache is q8_0 → larger context estimate
      const plan = (await h.c.get('/api/models/context?model=' + encodeURIComponent('hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:Q4_K_M'))).data.contextPlan;
      assert.equal(plan.memory.kvCacheType, 'q8_0');
      const again = await h.c.post('/api/providers/ollama/start');
      assert.equal(again.data.alreadyRunning, true);
      const stop = await h.c.post('/api/providers/ollama/stop');
      assert.equal(stop.data.stopped, true);
      await waitFor(async () => (await h.c.get('/api/providers?refresh=1')).data.providers[0].status === 'unreachable');
    } finally {
      delete process.env.FAKE_OLLAMA_ENV_FILE;
      await h.close();
    }
  });
});

describe('OpenAI-compatible provider (llama.cpp flavour)', () => {
  let h;
  let oa;
  before(async () => {
    oa = await startFakeOpenAI({ port: 0, nCtx: 8192 });
    h = await setup({ settings: { memory: { enabled: false }, titles: { auto: false } } });
  });
  after(async () => { await h.close(); await oa.close(); });

  test('custom endpoint: streaming, server-fixed context, tool calls with partial args, reasoning_content, tools fallback', async () => {
    const add = await h.c.post('/api/providers', { name: 'My llama-server', kind: 'openai', baseUrl: oa.url + '/v1' });
    assert.equal(add.status, 201);
    const pid = add.data.provider.id;
    assert.equal(add.data.provider.status, 'running');
    assert.equal(add.data.provider.flavor, 'llamacpp');
    const models = (await h.c.get('/api/models?refresh=1')).data.models.filter((m) => m.providerId === pid);
    assert.ok(models.some((m) => m.model === 'fake-llama'));
    const chat = await newChat(h.c, { settings: { model: { providerId: pid, model: 'fake-llama' } } });
    const r = await send(h.c, chat, 'hello llama');
    assert.equal(text(r.events), 'You said: hello llama');
    const ctx = byType(r.events, 'context')[0];
    assert.equal(ctx.numCtx, 8192);
    assert.equal(ctx.contextPlan.limitedBy, 'server');
    const req = oa.requests.filter((x) => x.path === '/v1/chat/completions').at(-1).body;
    assert.equal(req.stream, true);
    assert.equal(req.stream_options.include_usage, true);
    assert.equal(req.options, undefined, 'no Ollama options on OpenAI endpoints');
    assert.ok(byType(r.events, 'stats')[0].promptTokens > 0);

    const t = await send(h.c, chat, 'calculate 6*7');
    assert.equal(byType(t.events, 'tool_call')[0].toolCall.arguments.expression, '6*7');
    assert.match(byType(t.events, 'done')[0].message.content, /= 42/);
    const toolReq = oa.requests.filter((x) => x.path === '/v1/chat/completions').at(-1).body;
    const tm = toolReq.messages.find((m) => m.role === 'tool');
    const am = toolReq.messages.find((m) => m.tool_calls);
    assert.equal(tm.tool_call_id, am.tool_calls[0].id);
    assert.equal(typeof am.tool_calls[0].function.arguments, 'string');

    const chat2 = await newChat(h.c, { settings: { model: { providerId: pid, model: 'fake-reasoner' } } });
    const rr = await send(h.c, chat2, 'think hard');
    assert.match(byType(rr.events, 'reasoning').map((e) => e.delta).join(''), /Thinking about: think hard/);

    const chat3 = await newChat(h.c, { settings: { model: { providerId: pid, model: 'fake-notools' } } });
    const nt = await send(h.c, chat3, 'no tools here');
    assert.ok(byType(nt.events, 'notice').some((n) => n.code === 'tools_unsupported'));
    assert.equal(text(nt.events), 'You said: no tools here');
    assert.equal((await h.c.del(`/api/providers/${pid}`)).status, 200);
  });
});
