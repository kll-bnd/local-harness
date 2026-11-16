// Issues reported by the UI engineer while building against the server: `done` means "you can send again",
// imported titles are kept, the automatic default model fits the machine, honest load / prompt progress.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setup, newChat, send, byType, GiB } from './helpers.mjs';
import { startFakeA1111 } from './fake-a1111.mjs';
import { FAKE_OLLAMA_MODELS } from './fake-ollama.mjs';
import { WAIT_PROGRESS } from '../server/chat/engine.mjs';
import { A1111Provider } from '../server/image/a1111.mjs';

A1111Provider.pollMs = 20;
const MAC8 = { totalMem: 8 * GiB, platform: 'darwin', arch: 'arm64' };
const MAC16 = { totalMem: 16 * GiB, platform: 'darwin', arch: 'arm64' };
const HF = 'hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL';

describe('1. done means "you can send again"', () => {
  test('a send issued from the done handler is accepted; the turn is already on disk', async () => {
    const a1111 = await startFakeA1111({ port: 0, stepMs: 1 });
    const h = await setup({ system: MAC16, settings: { titles: { auto: false }, memory: { enabled: false }, image: { custom: [{ id: 'dt', name: 'Draw Things', kind: 'a1111', baseUrl: a1111.url, enabled: true }] } } });
    try {
      const id = await newChat(h.c);
      let second = null;
      let onDisk = null;
      await h.c.sseStream(`/api/chats/${id}/messages`, { content: 'first' }, async (ev) => {
        if (ev.type !== 'done') return;
        onDisk = JSON.parse(await fs.readFile(path.join(h.dataDir, 'chats', `${id}.json`), 'utf8'));
        second = await send(h.c, id, 'second, right away');
      });
      assert.equal(second.status, 200, JSON.stringify(second.error));
      assert.equal(byType(second.events, 'done').length, 1);
      assert.ok(Object.values(onDisk.messages).some((m) => m.role === 'assistant' && m.status === 'complete' && m.content === 'You said: first' && m.stats), 'persisted with stats before done');
      // the same for a chat-linked image turn
      let afterImage = null;
      await h.c.sseStream('/api/images/generate', { providerId: 'dt', prompt: 'a kite', chatId: id }, async (ev) => {
        if (ev.type === 'done') afterImage = await send(h.c, id, 'nice image');
      });
      assert.equal(afterImage.status, 200, JSON.stringify(afterImage.error));
    } finally { await h.close(); await a1111.close(); }
  });
});

describe('2. imported titles are kept', () => {
  test('an imported chat with a title is never auto-retitled; untitled imports and new chats are titled once', async () => {
    const h = await setup({ settings: { titles: { auto: true }, memory: { enabled: false } } });
    try {
      const imp = await h.c.post('/api/chats/import', { title: 'Trip to Porto', messages: [{ role: 'user', content: 'Plan my weekend' }, { role: 'assistant', content: 'Sure.' }] });
      const id = imp.data.chats[0].id;
      assert.equal(imp.data.chats[0].titleSource, 'import');
      await send(h.c, id, 'What about Sunday?');
      await h.app.background.idle();
      const c = (await h.c.get(`/api/chats/${id}`)).data.chat;
      assert.equal(c.title, 'Trip to Porto');
      assert.equal(c.titleSource, 'import');
      await h.restart();
      assert.equal((await h.c.get(`/api/chats/${id}`)).data.chat.titleSource, 'import', 'persisted');
      // without a title → auto-titled
      const untitled = (await h.c.post('/api/chats/import', { messages: [{ role: 'user', content: 'hello world from the import' }] })).data.chats[0].id;
      await send(h.c, untitled, 'more');
      await h.app.background.idle();
      assert.equal((await h.c.get(`/api/chats/${untitled}`)).data.chat.titleSource, 'auto');
      // once auto-titled, later turns never change it
      const fresh = await newChat(h.c);
      await send(h.c, fresh, 'first words of a chat');
      await h.app.background.idle();
      const t1 = (await h.c.get(`/api/chats/${fresh}`)).data.chat.title;
      const nTitle = h.fake.chatRequests().filter((b) => /short, specific title/.test(JSON.stringify(b.messages))).length;
      await send(h.c, fresh, 'something completely different now');
      await h.app.background.idle();
      assert.equal((await h.c.get(`/api/chats/${fresh}`)).data.chat.title, t1);
      assert.equal(h.fake.chatRequests().filter((b) => /short, specific title/.test(JSON.stringify(b.messages))).length, nTitle, 'no second title call');
      // an explicit "regenerate title" still works on an imported chat
      const re = await h.c.post(`/api/chats/${id}/title`);
      assert.equal(re.data.chat.titleSource, 'auto');
    } finally { await h.close(); }
  });
});

describe('3. the automatic default model fits the machine', () => {
  test('8 GB: not the 7.9 GB official tag; a text-only copy beats its multimodal original; 16 GB keeps Nemotron', async () => {
    const h = await setup({ system: MAC8 });
    try {
      const d1 = (await h.c.get('/api/models')).data.defaultModel;
      assert.equal(d1.model, 'qwen3:4b', 'the first recommended model that fits');
      await h.c.post('/api/models/text-only', { model: HF });
      const d2 = (await h.c.get('/api/models')).data.defaultModel;
      assert.equal(d2.model, 'nvidia-nemotron-3.5-bolt-e4b-text:ud-q3_k_xl');
      const r = await send(h.c, await newChat(h.c), 'hi');
      assert.equal(byType(r.events, 'start')[0].model.model, d2.model);
    } finally { await h.close(); }
    const h16 = await setup({ system: MAC16 });
    try {
      assert.equal((await h16.c.get('/api/models')).data.defaultModel.model, 'nemotron-3.5-bolt:e4b');
    } finally { await h16.close(); }
  });

  test('nothing fits → the first candidate, and its plan says it does not fit', async () => {
    const h = await setup({ system: MAC8, fakeOptions: { models: { 'nemotron-3.5-bolt:e4b': FAKE_OLLAMA_MODELS['nemotron-3.5-bolt:e4b'], 'nemotron-3.5-bolt:latest': { ...FAKE_OLLAMA_MODELS['qwen3:4b'], size: 22e9 } } } });
    try {
      const d = (await h.c.get('/api/models')).data.defaultModel;
      assert.equal(d.model, 'nemotron-3.5-bolt:e4b', 'never the avoided 22 GB :latest tag first');
      const p = (await h.c.get(`/api/models/context?model=${encodeURIComponent(d.model)}`)).data.contextPlan;
      assert.ok(p.warnings.some((w) => w.code === 'model_exceeds_budget'));
    } finally { await h.close(); }
  });
});

describe('5. model_status: loading vs reading the prompt', () => {
  test('first request loads (loading → ready → loaded with loadMs); a slow prompt reports evaluating; a new window reloads', async () => {
    const saved = { ...WAIT_PROGRESS };
    WAIT_PROGRESS.firstMs = 100;
    WAIT_PROGRESS.everyMs = 150;
    const h = await setup({ settings: { titles: { auto: false }, memory: { enabled: false }, defaultModel: { providerId: 'ollama', model: 'qwen3:4b' } } });
    try {
      const id = await newChat(h.c);
      const r1 = await send(h.c, id, 'hi');
      const ms1 = byType(r1.events, 'model_status');
      assert.deepEqual(ms1.map((e) => e.phase), ['loading', 'ready', 'loaded']);
      assert.equal(ms1[0].reason, 'not_loaded');
      assert.equal(ms1[0].model, 'qwen3:4b');
      assert.equal(ms1[1].reason, 'loaded');
      assert.equal(ms1[2].loadMs, 900);
      // warm model, slow prompt processing: "reading the prompt", then ready
      h.fake.headerDelayMs = 450;
      const r2 = await send(h.c, id, 'a long question');
      h.fake.headerDelayMs = 0;
      const ms2 = byType(r2.events, 'model_status');
      assert.ok(ms2.length >= 3, JSON.stringify(ms2));
      assert.ok(ms2.slice(0, -1).every((e) => e.phase === 'evaluating' && e.elapsedMs >= 100 && /^Reading the prompt \(~\d+ tokens\)… \d+ s$/.test(e.message)), JSON.stringify(ms2));
      assert.ok(ms2[1].elapsedMs > ms2[0].elapsedMs);
      assert.deepEqual([ms2.at(-1).phase, ms2.at(-1).reason], ['ready', 'prompt_read']);
      // a different context window makes Ollama reload
      await h.c.patch(`/api/chats/${id}`, { settings: { context: { mode: 4096 } } });
      const r3 = await send(h.c, id, 'smaller window');
      const ms3 = byType(r3.events, 'model_status');
      assert.equal(ms3[0].reason, 'context_change');
      assert.match(ms3[0].message, /^Reloading qwen3:4b with a 4K context…$/);
      // fast turn on a loaded model: no model_status at all
      const r4 = await send(h.c, id, 'quick');
      assert.equal(byType(r4.events, 'model_status').length, 0);
      // after a restart the server asks Ollama what is loaded instead of announcing a load
      await h.restart();
      const r5 = await send(h.c, id, 'after restart');
      assert.equal(byType(r5.events, 'model_status').length, 0, JSON.stringify(byType(r5.events, 'model_status')));
    } finally { Object.assign(WAIT_PROGRESS, saved); await h.close(); }
  });
});
