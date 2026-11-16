// Regression tests for the runtime review findings: PDF bombs, backend timeouts, races and stuck chats,
// background pre-emption, stale server context, retrieval scaling, the 8 GB RAM lease, image fixes, spawns.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { setup, newChat, send, byType, tmpDir, waitFor, GiB } from './helpers.mjs';
import { startFakeA1111 } from './fake-a1111.mjs';
import { startFakeComfyUI } from './fake-comfyui.mjs';
import { startFakeOpenAI } from './fake-openai.mjs';
import { processUpload } from '../server/docs/extract.mjs';
import { AttachmentStore } from '../server/store/attachments.mjs';
import { A1111Provider } from '../server/image/a1111.mjs';
import { ComfyUIProvider } from '../server/image/comfyui.mjs';
import { ImageService } from '../server/image/service.mjs';
import { backendFetch } from '../server/lib/backend-http.mjs';
import { ProviderRegistry } from '../server/providers/registry.mjs';
import { BM25Index } from '../server/memory/bm25.mjs';
import { HybridIndex } from '../server/memory/hybrid.mjs';
import { encodeVector } from '../server/memory/vectors.mjs';
import { openInBrowser } from '../server/index.mjs';
import { OllamaProcess } from '../server/providers/ollama-process.mjs';

A1111Provider.pollMs = 20;

function pdf({ pages = 1, content, cmap }) {
  const objs = ['1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj'];
  const kids = Array.from({ length: pages }, (_, i) => `${10 + i} 0 R`).join(' ');
  objs.push(`2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pages} /Resources << /Font << /F1 4 0 R >> >> >> endobj`);
  const z = zlib.deflateSync(Buffer.from(content, 'latin1'), { level: 1 });
  objs.push(`3 0 obj << /Length ${z.length} /Filter /FlateDecode >>\nstream\n${z.toString('latin1')}\nendstream endobj`);
  if (cmap) {
    const cz = zlib.deflateSync(Buffer.from(cmap, 'latin1'));
    objs.push('4 0 obj << /Type /Font /Subtype /Type0 /ToUnicode 5 0 R >> endobj');
    objs.push(`5 0 obj << /Length ${cz.length} /Filter /FlateDecode >>\nstream\n${cz.toString('latin1')}\nendstream endobj`);
  } else objs.push('4 0 obj << /Type /Font /Subtype /Type1 >> endobj');
  for (let i = 0; i < pages; i++) objs.push(`${10 + i} 0 obj << /Type /Page /Parent 2 0 R /Contents 3 0 R >> endobj`);
  return Buffer.from(`%PDF-1.4\n${objs.join('\n')}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

const timed = (fn) => { const t = Date.now(); const r = fn(); return { r, ms: Date.now() - t }; };

describe('#4 hostile PDFs are bounded', () => {
  test('shared huge content streams, giant TJ arrays, 64K-range cmaps and deflate bombs finish quickly', () => {
    const cases = [
      pdf({ pages: 40, content: 'BT /F1 12 Tf ' + '1 0 0 1 0 0 Tm '.repeat(150000) + '(x) Tj ET' }),
      pdf({ content: 'BT [' + '1 '.repeat(100000) + '] TJ ET' }),
      pdf({ pages: 20, content: 'BT /F1 12 Tf (ab) Tj ET', cmap: `begincodespacerange <0000> <FFFF> endcodespacerange\nbeginbfrange\n${Array.from({ length: 40 }, () => '<0000> <FFFF> <0041>').join('\n')}\nendbfrange` }),
      pdf({ content: ' '.repeat(96 * 1024 * 1024) }),
    ];
    for (const buf of cases) {
      const { r, ms } = timed(() => processUpload('a.pdf', 'application/pdf', buf));
      assert.ok(ms < 4000, `took ${ms} ms`);
      assert.ok(r.kind === 'text' || r.kind === 'binary', r.kind);
      assert.ok((r.text || '').length <= 5_000_000);
    }
  });

  test('extraction runs in a worker with a deadline: a stuck extraction becomes an attachment with an error, not a hung request', async () => {
    const h = await setup();
    const saved = AttachmentStore.extractTimeoutMs;
    try {
      AttachmentStore.extractTimeoutMs = 1;
      const buf = pdf({ pages: 5, content: 'BT /F1 12 Tf (Hello world) Tj ET' });
      const r = await fetch(`${h.url}/api/attachments?name=doc.pdf`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: buf });
      assert.equal(r.status, 201);
      const a = (await r.json()).attachment;
      assert.equal(a.kind, 'binary');
      assert.match(a.error, /Could not extract text/);
      AttachmentStore.extractTimeoutMs = saved;
      const ok = await (await fetch(`${h.url}/api/attachments?name=doc.pdf`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: buf })).json();
      assert.equal(ok.attachment.kind, 'text');
      assert.equal(ok.attachment.error ?? null, null);
    } finally { AttachmentStore.extractTimeoutMs = saved; await h.close(); }
  });
});

describe('#5 backend calls: no hidden 300 s client timeout, timeouts vs unreachable, interrupt on failure', () => {
  test('backend requests do not go through undici fetch (whose 300 s headersTimeout killed long jobs)', async () => {
    const fake = await startFakeA1111({ port: 0, stepMs: 1 });
    const orig = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('undici fetch must not be used for backend calls'); };
    try {
      const p = new A1111Provider({ id: 'dt', name: 'Draw Things', baseUrl: fake.url });
      const r = await p.generate({ prompt: 'x', negativePrompt: '', width: 64, height: 64, steps: 2, cfg: 1, seed: 1, count: 1 });
      assert.equal(r.images.length, 1);
    } finally { globalThis.fetch = orig; await fake.close(); }
  });

  test('a configured timeout says "Timed out", an unreachable server says "Cannot reach"', async () => {
    const hang = http.createServer(() => {});
    await new Promise((r) => hang.listen(0, '127.0.0.1', r));
    const target = { id: 'x', name: 'Backend', baseUrl: `http://127.0.0.1:${hang.address().port}` };
    try {
      await assert.rejects(backendFetch(target, '/slow', { timeoutMs: 150 }), (e) => e.code === 'timeout' && e.status === 504 && /Timed out waiting for Backend/.test(e.message));
    } finally { hang.closeAllConnections?.(); hang.close(); }
    await assert.rejects(backendFetch({ ...target, baseUrl: 'http://127.0.0.1:1' }, '/x', { timeoutMs: 2000 }), (e) => e.code === 'connection_failed' && /Cannot reach Backend at http:\/\/127\.0\.0\.1:1 \(ECONNREFUSED\)/.test(e.message));
  });

  test('an image job that times out is interrupted on the backend and reported as a timeout', async () => {
    const a1111 = await startFakeA1111({ port: 0, stepMs: 200 });
    const h = await setup({ system: { totalMem: 16 * GiB, platform: 'darwin', arch: 'arm64' }, settings: { image: { custom: [{ id: 'dt', name: 'Draw Things', kind: 'a1111', baseUrl: a1111.url, enabled: true }] }, titles: { auto: false } } });
    try {
      h.app.settings.get().image.timeoutSec = 0.3; // in-memory only (the schema minimum is 10 s)
      const r = await h.c.sse('/api/images/generate', { providerId: 'dt', prompt: 'slow', steps: 50 });
      const err = byType(r.events, 'error')[0] || byType(r.events, 'image_error')[0];
      assert.ok(err, JSON.stringify(r.events.map((e) => e.type)));
      assert.equal(err.code, 'timeout');
      assert.match(err.message, /Timed out after 0\.3 s waiting for Draw Things/);
      await waitFor(() => a1111.interrupts >= 1);
    } finally { await h.close(); await a1111.close(); }
  });
});

describe('#7/#8 one operation per chat, never stuck', () => {
  let h;
  before(async () => { h = await setup({ settings: { titles: { auto: false }, memory: { enabled: false } } }); });
  after(() => h.close());

  test('two concurrent sends: one streams, the other gets 409 chat_busy JSON, only one user message is stored', async () => {
    const id = await newChat(h.c);
    h.fake.setDelay(15);
    const [a, b] = await Promise.all([send(h.c, id, 'first message here'), send(h.c, id, 'second message here')]);
    h.fake.setDelay(0);
    const ok = [a, b].filter((x) => x.status === 200 && byType(x.events, 'done').length);
    const busy = [a, b].filter((x) => x.status === 409);
    assert.equal(ok.length, 1);
    assert.equal(busy.length, 1);
    assert.equal(busy[0].error.error.code, 'chat_busy');
    const d = (await h.c.get(`/api/chats/${id}`)).data;
    assert.equal(d.messages.filter((m) => m.role === 'user').length, 1);
    assert.equal(h.app.engine.busy(id), false);
    assert.equal(h.app.foreground, 0);
  });

  test('chat-linked image generation and a chat turn exclude each other too', async () => {
    const id = await newChat(h.c);
    h.fake.setDelay(15);
    const turn = send(h.c, id, 'a long answer please');
    await waitFor(() => h.app.engine.busy(id));
    const img = await h.c.post('/api/images/generate', { prompt: 'x', chatId: id });
    assert.equal(img.status, 409);
    assert.equal(img.data.error.code, 'chat_busy');
    await turn;
    h.fake.setDelay(0);
    assert.equal(h.app.engine.busy(id), false);
  });

  test('deleting the message being regenerated is refused while it runs; the chat is never left busy', async () => {
    const id = await newChat(h.c);
    await send(h.c, id, 'hello there');
    const d = (await h.c.get(`/api/chats/${id}`)).data;
    const asst = d.messages.find((m) => m.role === 'assistant');
    h.fake.setDelay(20);
    const regen = h.c.sse(`/api/chats/${id}/messages/${asst.id}/regenerate`, {});
    await waitFor(() => h.app.engine.busy(id));
    const del = await h.c.del(`/api/chats/${id}/messages/${d.path[0]}`);
    assert.equal(del.status, 409);
    await regen;
    h.fake.setDelay(0);
    assert.equal(h.app.engine.busy(id), false);
    assert.equal((await h.c.del(`/api/chats/${id}/messages/${d.path[0]}`)).status, 200);
  });

  test('run() on an anchor that vanished after reserve() throws message_deleted and releases the chat', async () => {
    const id = await newChat(h.c);
    const chat = h.app.chats.get(id);
    const rec = h.app.engine.reserve(id);
    const fg = h.app.foreground;
    await assert.rejects(h.app.engine.run({ chat, anchorId: 'msg_doesnotexist', reservation: rec }), (e) => e.code === 'message_deleted');
    assert.equal(h.app.engine.busy(id), false);
    assert.equal(h.app.foreground, fg - 1);
    const r = await send(h.c, id, 'still works');
    assert.equal(byType(r.events, 'done').length, 1);
  });

  test('a client disconnect aborts the turn and keeps the partial reply (status aborted)', async () => {
    const id = await newChat(h.c);
    h.fake.setDelay(30);
    const ac = new AbortController();
    const p = h.c.sseStream(`/api/chats/${id}/messages`, { content: 'tell me a long story about the sea and the wind' }, (ev) => { if (ev.type === 'token') ac.abort(); }, { signal: ac.signal });
    await p;
    await waitFor(() => !h.app.engine.busy(id));
    h.fake.setDelay(0);
    const a = (await h.c.get(`/api/chats/${id}`)).data.messages.find((m) => m.role === 'assistant');
    assert.equal(a.status, 'aborted');
    assert.ok(a.content.length > 0);
  });
});

describe('#13 background model work yields to the user', () => {
  test('a running background task is aborted when a turn starts, re-queued, and completes afterwards', async () => {
    const h = await setup({ settings: { titles: { auto: false }, memory: { enabled: false } } });
    try {
      let runs = 0;
      let aborted = 0;
      h.app.background.schedule('test:long', async ({ signal }) => {
        runs++;
        if (runs > 1) return;
        await new Promise((_, rej) => signal.addEventListener('abort', () => { aborted++; rej(signal.reason); }, { once: true }));
      }, { needsModel: true });
      await waitFor(() => h.app.background.running?.key === 'test:long');
      const id = await newChat(h.c);
      const r = await send(h.c, id, 'my turn first');
      assert.equal(byType(r.events, 'done').length, 1);
      assert.equal(aborted, 1);
      await h.app.background.idle();
      assert.equal(runs, 2);
      assert.ok(h.app.background.history.some((x) => x.key === 'test:long' && x.preempted));
      assert.ok(h.app.background.history.some((x) => x.key === 'test:long' && x.ok));
    } finally { await h.close(); }
  });
});

describe('#14 OpenAI-compatible server context is re-read', () => {
  test('a llama-server restarted with a smaller -c is noticed after the short cache TTL', async () => {
    const oai = await startFakeOpenAI({ port: 0, nCtx: 32768 });
    const saved = ProviderRegistry.serverInfoTtlMs;
    ProviderRegistry.serverInfoTtlMs = 50;
    const h = await setup({ settings: { providers: { custom: [{ id: 'llama', name: 'llama-server', kind: 'openai', baseUrl: oai.url, enabled: true }] } } });
    try {
      const ctx = async () => (await h.c.get('/api/models/context?model=fake-llama&providerId=llama')).data.contextPlan.numCtx;
      assert.equal(await ctx(), 32768);
      oai.nCtx = 4096;
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(await ctx(), 4096);
    } finally { ProviderRegistry.serverInfoTtlMs = saved; await h.close(); await oai.close(); }
  });
});

describe('#15 retrieval cost does not grow with every turn', () => {
  test('a pasted 1500-word message searches a 6000-exchange index quickly', () => {
    const idx = new BM25Index();
    const words = Array.from({ length: 3000 }, (_, i) => `w${i.toString(36)}`);
    for (let i = 0; i < 6000; i++) idx.add(`d${i}`, Array.from({ length: 120 }, (_, j) => words[(i * 7 + j * 13) % words.length]).join(' '));
    const q = Array.from({ length: 1500 }, (_, j) => words[(j * 31) % words.length]).join(' ');
    const { ms } = timed(() => idx.search(q, { k: 8 }));
    assert.ok(ms < 300, `search took ${ms} ms`);
    for (let i = 0; i < 3000; i++) idx.remove(`d${i}`);
    assert.equal(idx.size, 3000);
    assert.ok(idx.search(words[5]).every((x) => Number(x.id.slice(1)) >= 3000));
  });

  test('saves append only what changed; reload gives the same results; the legacy JSON file is migrated', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'index', 'recall.json');
    const a = await new HybridIndex({ file }).load();
    for (let i = 0; i < 500; i++) a.upsert(`x${i}`, `exchange number ${i} about topic ${i % 17} and sailing boats ${i}`, { chatId: 'c' });
    a.vectors.set('x1', { model: 'm', vec: new Float32Array([1, 0, 0]) });
    await a.save();
    const size1 = (await fs.stat(a.itemsFile)).size;
    a.upsert('x500', 'one more exchange about sailing');
    await a.save();
    const size2 = (await fs.stat(a.itemsFile)).size;
    assert.ok(size2 - size1 < 300, `appended ${size2 - size1} bytes, not a rewrite`);
    a.remove('x3');
    await a.save();
    const b = await new HybridIndex({ file }).load();
    assert.equal(b.items.size, 500);
    assert.equal(b.items.has('x3'), false);
    assert.deepEqual(b.search('topic 5 sailing', { k: 5 }).map((x) => x.id), a.search('topic 5 sailing', { k: 5 }).map((x) => x.id));
    assert.deepEqual([...b.vectors.get('x1').vec], [1, 0, 0]);
    // legacy v1 single JSON file
    const dir2 = await tmpDir();
    const legacy = path.join(dir2, 'documents.json');
    await fs.writeFile(legacy, JSON.stringify({ version: 1, items: [{ id: 'l1', text: 'legacy text about kayaks', meta: { a: 1 }, vec: { model: 'm', b64: encodeVector(new Float32Array([0, 1])) } }] }));
    const c = await new HybridIndex({ file: legacy }).load();
    assert.equal(c.search('kayaks')[0].id, 'l1');
    await assert.rejects(fs.stat(legacy));
    const d2 = await new HybridIndex({ file: legacy }).load();
    assert.equal(d2.items.get('l1').meta.a, 1);
    assert.deepEqual([...d2.vectors.get('l1').vec], [0, 1]);
  });
});

describe('#19 8 GB Mac: the chat model and a diffusion model never run at the same time', () => {
  let h;
  let a1111;
  before(async () => {
    a1111 = await startFakeA1111({ port: 0, stepMs: 4 });
    h = await setup({ system: { totalMem: 8 * GiB, platform: 'darwin', arch: 'arm64' }, settings: { image: { custom: [{ id: 'dt', name: 'Draw Things', kind: 'a1111', baseUrl: a1111.url, enabled: true }] }, titles: { auto: false }, memory: { enabled: false } } });
  });
  after(async () => { await h.close(); await a1111.close(); });

  test('a chat turn in another chat waits (model_status waiting → ready) for a running image job', async () => {
    a1111.stepMs = 30;
    const img = h.c.sse('/api/images/generate', { providerId: 'dt', prompt: 'a lighthouse', steps: 10 });
    await waitFor(() => h.app.ram.status().holders.some((x) => x.kind === 'image'));
    const id = await newChat(h.c);
    const r = await send(h.c, id, 'hello while drawing');
    const ms = byType(r.events, 'model_status');
    assert.equal(ms[0].phase, 'waiting');
    assert.equal(ms[0].reason, 'image_job');
    assert.ok(ms.some((e) => e.phase === 'ready'));
    assert.equal(byType((await img).events, 'done').length, 1);
    a1111.stepMs = 4;
    assert.deepEqual(h.app.ram.status().holders, []);
  });

  test('an image job waits (image_status queued) for a running chat turn', async () => {
    const id = await newChat(h.c);
    h.fake.setDelay(20);
    const turn = send(h.c, id, 'please write a long answer about lighthouses');
    await waitFor(() => h.app.ram.status().holders.some((x) => x.kind === 'llm'));
    const r = await h.c.sse('/api/images/generate', { providerId: 'dt', prompt: 'a ship' });
    h.fake.setDelay(0);
    const st = byType(r.events, 'image_status');
    assert.equal(st[0].phase, 'queued');
    assert.equal(st[0].reason, 'model_in_use');
    assert.equal(byType(r.events, 'done').length, 1);
    assert.equal(byType((await turn).events, 'done').length, 1);
  });

  test('aborting a queued image job leaves no lease behind', async () => {
    const id = await newChat(h.c);
    h.fake.setDelay(20);
    const turn = send(h.c, id, 'another long answer please about the ocean');
    await waitFor(() => h.app.ram.status().holders.some((x) => x.kind === 'llm'));
    const ac = new AbortController();
    const img = h.c.sseStream('/api/images/generate', { providerId: 'dt', prompt: 'never' }, (ev) => { if (ev.type === 'image_status' && ev.phase === 'queued') ac.abort(); }, { signal: ac.signal });
    await img;
    await turn;
    h.fake.setDelay(0);
    await waitFor(() => h.app.images.active === 0 && !h.app.ram.status().holders.length && !h.app.ram.status().waiting.length);
    assert.equal(a1111.requests.filter((x) => x.body?.prompt === 'never').length, 0);
  });

  test('generation starts only once Ollama really dropped the model (keep_alive 0 returns early)', async () => {
    const id = await newChat(h.c);
    await send(h.c, id, 'warm up');
    h.fake.unloadDelayMs = 300;
    try {
      const t0 = Date.now();
      const r = await h.c.sse('/api/images/generate', { providerId: 'dt', prompt: 'after unload' });
      const st = byType(r.events, 'image_status');
      const un = st.find((s) => s.phase === 'unloaded');
      assert.equal(un.confirmed, true);
      assert.ok(Date.now() - t0 >= 280);
      // and when it never goes away in time, it says so and continues
      await send(h.c, id, 'warm up again');
      h.fake.unloadDelayMs = 5000;
      const saved = ImageService.unloadWaitMs;
      ImageService.unloadWaitMs = 100;
      try {
        const r2 = await h.c.sse('/api/images/generate', { providerId: 'dt', prompt: 'slow unload' });
        const un2 = byType(r2.events, 'image_status').find((s) => s.phase === 'unloaded');
        assert.equal(un2.confirmed, false);
        assert.match(un2.message, /did not report the models as unloaded/);
        assert.equal(byType(r2.events, 'done').length, 1);
      } finally { ImageService.unloadWaitMs = saved; }
    } finally { h.fake.unloadDelayMs = 0; }
  });
});

describe('#21 image subsystem fixes', () => {
  test('ComfyUI makes one image per prompt (batch_size 1) with consecutive seeds', async () => {
    const comfy = await startFakeComfyUI({ port: 0, stepMs: 1 });
    try {
      const p = new ComfyUIProvider({ id: 'c', name: 'ComfyUI', baseUrl: comfy.url });
      const r = await p.generate({ prompt: 'two cats', negativePrompt: '', width: 64, height: 64, steps: 2, cfg: 1, seed: 41, count: 2, model: 'sd15_dreamshaper_8.safetensors', sampler: 'euler', scheduler: 'normal' });
      assert.equal(r.images.length, 2);
      assert.equal(comfy.prompts.length, 2);
      const seeds = comfy.prompts.map((x) => Object.values(x.workflow).find((n) => n.class_type === 'KSampler').inputs.seed);
      assert.deepEqual(seeds, [41, 42]);
      for (const x of comfy.prompts) assert.equal(Object.values(x.workflow).find((n) => n.class_type === 'EmptyLatentImage').inputs.batch_size, 1);
    } finally { await comfy.close(); }
  });

  test('regenerating an image turn makes a new image (new seed), not a text reply', async () => {
    const a1111 = await startFakeA1111({ port: 0, stepMs: 1 });
    const h = await setup({ system: { totalMem: 16 * GiB, platform: 'darwin', arch: 'arm64' }, settings: { image: { custom: [{ id: 'dt', name: 'Draw Things', kind: 'a1111', baseUrl: a1111.url, enabled: true }] }, titles: { auto: false } } });
    try {
      const id = await newChat(h.c);
      const first = await h.c.post('/api/images/generate', { providerId: 'dt', prompt: 'a red fox', chatId: id, stream: false });
      assert.equal(first.status, 200, JSON.stringify(first.data));
      const am = first.data.message;
      const before = h.fake.chatRequests().length;
      const r = await h.c.sse(`/api/chats/${id}/messages/${am.id}/regenerate`, {});
      assert.equal(byType(r.events, 'start').length, 1);
      const done = byType(r.events, 'done')[0];
      assert.ok(done.generationId);
      assert.equal(done.createdMessageIds.length, 1);
      assert.equal(h.fake.chatRequests().length, before, 'no LLM call');
      const d = (await h.c.get(`/api/chats/${id}`)).data;
      const results = d.messages.filter((m) => m.kind === 'image_result');
      assert.equal(results.length, 2);
      assert.notEqual(results[0].images[0].seed, results[1].images[0].seed);
      assert.equal(results[0].parentId, results[1].parentId, 'siblings under the same request');
    } finally { await h.close(); await a1111.close(); }
  });

  test('Draw Things / A1111 detection: tolerant of minimal APIs, no false positives', async () => {
    const serve = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
    const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const servers = {
      htmlEverywhere: await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>router admin</html>'); }),
      notFound: await serve((req, res) => json(res, 404, { detail: 'Not Found' })),
      otherJson: await serve((req, res) => json(res, 200, req.url === '/' ? { status: 'ok', version: 3 } : [])),
      rootConfig: await serve((req, res) => (req.url === '/' ? json(res, 200, { steps: 8, model: 'flux_schnell_q8p.ckpt', guidance_scale: 1 }) : json(res, 404, { detail: 'Not Found' }))),
      txt2imgOnly: await serve((req, res) => (req.url === '/sdapi/v1/txt2img' ? json(res, 405, { detail: 'Method Not Allowed' }) : json(res, 404, { detail: 'Not Found' }))),
    };
    try {
      const st = async (s) => new A1111Provider({ id: 'x', name: 'x', baseUrl: `http://127.0.0.1:${s.address().port}` }).status();
      assert.equal((await st(servers.htmlEverywhere)).ok, false);
      assert.equal((await st(servers.notFound)).ok, false);
      assert.equal((await st(servers.otherJson)).ok, false);
      const rc = await st(servers.rootConfig);
      assert.equal(rc.ok, true);
      assert.equal(rc.currentModel, 'flux_schnell_q8p.ckpt');
      assert.equal((await st(servers.txt2imgOnly)).ok, true);
      const dt = await startFakeA1111({ port: 0, drawThings: true });
      assert.equal((await new A1111Provider({ id: 'd', name: 'd', baseUrl: dt.url }).status()).ok, true);
      await dt.close();
    } finally { for (const s of Object.values(servers)) s.close(); }
  });

  test('the attachment text cache is bounded; previewing context never mutates the chat', async () => {
    const h = await setup({ settings: { titles: { auto: false }, memory: { enabled: false } } });
    try {
      for (let i = 0; i < 60; i++) {
        const a = (await (await fetch(`${h.url}/api/attachments?name=f${i}.txt`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: `file ${i} `.repeat(50) })).json()).attachment;
        await h.app.attachments.readText(a.id);
      }
      assert.ok(h.app.attachments._textCache.size <= 50, String(h.app.attachments._textCache.size));
      const id = await newChat(h.c);
      await send(h.c, id, 'hello');
      const chat = h.app.chats.get(id);
      const before = JSON.stringify(chat);
      const p = await h.c.get(`/api/chats/${id}/context?draft=${encodeURIComponent('a draft message')}`);
      assert.equal(p.status, 200, JSON.stringify(p.data));
      assert.equal(JSON.stringify(chat), before);
    } finally { await h.close(); }
  });
});

describe('#23 spawns never crash the process', () => {
  test('a missing browser opener only logs a hint', async () => {
    const child = new EventEmitter();
    child.unref = () => {};
    openInBrowser('http://127.0.0.1:4747', { spawnFn: () => { setImmediate(() => child.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }))); return child; }, platform: 'linux' });
    openInBrowser('http://127.0.0.1:4747', { spawnFn: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } });
    await new Promise((r) => setTimeout(r, 30));
  });

  test('an ollama binary that cannot be executed is an error result, not a crash', async () => {
    const dir = await tmpDir();
    const bin = path.join(dir, 'ollama');
    await fs.writeFile(bin, '#!/nonexistent/interpreter\n');
    await fs.chmod(bin, 0o755);
    const p = new OllamaProcess({ getSettings: () => ({ ollama: { binaryPath: bin } }), getProvider: () => ({ baseUrl: 'http://127.0.0.1:1', status: async () => ({ ok: false }) }), totalMem: 16 * GiB });
    const r = await p.start({ timeoutMs: 3000 });
    assert.equal(r.started, false);
    assert.equal(r.code, 'spawn_failed');
    assert.match(r.error, /Could not start .*ENOENT/);
  });
});
