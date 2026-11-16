// Long-term memory: extraction, dedupe/update, retrieval + injection, pinned, incognito, recall, CRUD.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, looksLikeSecret } from '../server/memory/memories.mjs';
import { setup, newChat, send, byType, tmpDir } from './helpers.mjs';

const lastMainRequest = (fake) => fake.chatRequests().filter((b) => !/extract durable|running summary|short, specific title/.test(JSON.stringify(b.messages.slice(0, 2)))).at(-1);

describe('memory store (unit)', () => {
  test('dedupe turns near-duplicates into updates; exact repeats are unchanged', async () => {
    const store = await new MemoryStore({ dataDir: await tmpDir(), embedder: null }).load();
    const a = await store.add({ content: 'The user prefers dark roast coffee.', category: 'preference' });
    assert.equal(a.action, 'added');
    const b = await store.add({ content: 'the user prefers dark roast coffee' });
    assert.equal(b.action, 'unchanged');
    const c = await store.add({ content: 'The user prefers dark roast coffee, black.' });
    assert.equal(c.action, 'updated');
    assert.equal(c.memory.id, a.memory.id);
    assert.equal(store.items.size, 1);
    await store.add({ content: 'The user lives in Lisbon.' });
    assert.equal(store.items.size, 2);
    assert.equal(store.search('where does the user live')[0].memory.content, 'The user lives in Lisbon.');
    assert.ok(looksLikeSecret('my api key is sk-abcdefghijklmnopqrstuv'));
    assert.ok(looksLikeSecret("The user's password is hunter2."));
    assert.ok(!looksLikeSecret('The user likes passwords managers.'));
  });
});

describe('memory end-to-end', () => {
  let h;
  before(async () => { h = await setup({ settings: { tools: { enabled: false }, titles: { auto: false }, reasoning: { think: 'off' } } }); });
  after(() => h.close());

  test('extracts memories after a turn (background), then updates instead of duplicating', async () => {
    const chatA = await newChat(h.c);
    await send(h.c, chatA, 'Hi! My name is Ada and I prefer metric units.');
    await h.app.background.idle();
    let mems = (await h.c.get('/api/memories')).data.memories;
    const name = mems.find((m) => m.content === "The user's name is Ada.");
    assert.ok(name, JSON.stringify(mems));
    assert.equal(name.origin, 'auto');
    assert.equal(name.source.chatId, chatA);
    assert.ok(mems.find((m) => m.content === 'The user prefers metric units.'));
    const before = mems.length;
    const chatB = await newChat(h.c);
    await send(h.c, chatB, 'Correction: my name is Adaline.');
    await h.app.background.idle();
    mems = (await h.c.get('/api/memories')).data.memories;
    assert.equal(mems.length, before, 'updated, not duplicated');
    assert.ok(mems.find((m) => m.id === name.id && m.content === "The user's name is Adaline."));
    // the extraction prompt included existing memories with ids
    const extractReq = h.fake.chatRequests().filter((b) => /extract durable/.test(b.messages[0].content)).at(-1);
    assert.match(extractReq.messages[1].content, new RegExp(`\\[${name.id}\\]`));
    assert.ok(extractReq.format, 'structured output schema sent to Ollama');
  });

  test('secrets are never stored', async () => {
    const chat = await newChat(h.c);
    await send(h.c, chat, 'my password is hunter2');
    await h.app.background.idle();
    const mems = (await h.c.get('/api/memories')).data.memories;
    assert.ok(!mems.some((m) => /hunter2/.test(m.content)));
  });

  test('relevant memories are injected into the turn context; pinned memories into the system prompt', async () => {
    const chat = await newChat(h.c);
    const r = await send(h.c, chat, 'Should I give the distance in metric units?');
    const ret = byType(r.events, 'retrieval')[0];
    assert.ok(ret.memories.some((m) => /metric units/.test(m.content)), JSON.stringify(ret));
    const req = lastMainRequest(h.fake);
    const lastUser = req.messages.at(-1);
    assert.match(lastUser.content, /<context>[\s\S]*Memories about the user:[\s\S]*metric units[\s\S]*<\/context>/);
    assert.doesNotMatch(req.messages[0].content, /metric units/, 'non-pinned memories stay out of the cached system prefix');
    const name = (await h.c.get('/api/memories?q=Adaline')).data.memories[0];
    await h.c.patch(`/api/memories/${name.id}`, { pinned: true });
    await send(h.c, chat, 'hello again');
    assert.match(lastMainRequest(h.fake).messages[0].content, /What you know about the user[\s\S]*Adaline/);
    // placement=system puts retrieved memories in the system prompt instead
    await h.c.patch('/api/settings', { memory: { placement: 'system' } });
    await send(h.c, chat, 'metric units again?');
    assert.match(lastMainRequest(h.fake).messages[0].content, /metric units/);
    await h.c.patch('/api/settings', { memory: { placement: 'turn' } });
  });

  test('incognito chats neither read nor write memory and are excluded from recall', async () => {
    const chat = await newChat(h.c, { incognito: true });
    const count = (await h.c.get('/api/memories')).data.total;
    const r = await send(h.c, chat, 'My name is Zed and I live in Paris. Metric units?');
    await h.app.background.idle();
    assert.equal((await h.c.get('/api/memories')).data.total, count);
    assert.equal(byType(r.events, 'retrieval').length, 0);
    const req = lastMainRequest(h.fake);
    assert.doesNotMatch(JSON.stringify(req.messages), /Adaline|<context>/);
    assert.equal(h.app.recall.index.items.size === 0 || ![...h.app.recall.index.items.values()].some((i) => i.meta.chatId === chat), true);
  });

  test('cross-chat recall injects snippets from other chats', async () => {
    const a = await newChat(h.c);
    await send(h.c, a, 'The internal codename for the new project is BLUEFALCON.');
    await h.app.background.idle();
    const b = await newChat(h.c);
    const r = await send(h.c, b, 'What was the BLUEFALCON project codename about?');
    const ret = byType(r.events, 'retrieval')[0];
    assert.ok(ret?.recall.some((x) => x.chatId === a), JSON.stringify(ret));
    assert.match(lastMainRequest(h.fake).messages.at(-1).content, /Snippets from past conversations:[\s\S]*BLUEFALCON/);
    await h.c.patch('/api/settings', { recall: { enabled: false } });
    const r2 = await send(h.c, b, 'BLUEFALCON codename again?');
    assert.ok(!byType(r2.events, 'retrieval')[0]?.recall.length);
    await h.c.patch('/api/settings', { recall: { enabled: true } });
  });

  test('global memory switch off: no extraction, no injection', async () => {
    await h.c.patch('/api/settings', { memory: { enabled: false } });
    const before = (await h.c.get('/api/memories')).data.total;
    const chat = await newChat(h.c);
    await send(h.c, chat, 'I am working on a birdhouse. Metric units please.');
    await h.app.background.idle();
    assert.equal((await h.c.get('/api/memories')).data.total, before);
    assert.doesNotMatch(JSON.stringify(lastMainRequest(h.fake).messages), /Memories about the user|What you know about the user/);
    await h.c.patch('/api/settings', { memory: { enabled: true } });
  });

  test('CRUD + search API', async () => {
    const add = await h.c.post('/api/memories', { content: 'The user owns a red bicycle.', category: 'fact', pinned: false });
    assert.equal(add.status, 201);
    assert.equal(add.data.action, 'added');
    const id = add.data.memory.id;
    const dup = await h.c.post('/api/memories', { content: 'The user owns a red bicycle' });
    assert.equal(dup.data.action, 'unchanged');
    const bad = await h.c.post('/api/memories', { content: 'x', category: 'nope' });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, 'bad_request');
    const s = await h.c.post('/api/memories/search', { query: 'bicycle color' });
    assert.equal(s.data.results[0].memory.id, id);
    assert.equal(s.data.retrieval, 'bm25');
    const up = await h.c.patch(`/api/memories/${id}`, { content: 'The user owns a blue bicycle.', category: 'fact' });
    assert.equal(up.data.memory.content, 'The user owns a blue bicycle.');
    assert.equal((await h.c.del(`/api/memories/${id}`)).status, 200);
    assert.equal((await h.c.del(`/api/memories/${id}`)).status, 404);
    assert.equal((await h.c.del('/api/memories')).status, 400);
  });

  test('remember tool saves a memory and emits a memory event', async () => {
    await h.c.patch('/api/settings', { tools: { enabled: true } });
    const chat = await newChat(h.c);
    const r = await send(h.c, chat, 'please remember that my cat is called Tom');
    const ev = byType(r.events, 'memory')[0];
    assert.ok(ev, JSON.stringify(r.events.map((e) => e.type)));
    assert.equal(ev.origin, 'tool');
    assert.equal(ev.action, 'added');
    assert.match(ev.memory.content, /cat is called Tom/);
    assert.match(byType(r.events, 'done')[0].message.content, /Saved to memory/);
    await h.c.patch('/api/settings', { tools: { enabled: false } });
  });
});

describe('hybrid retrieval with an embedding model (16 GB)', () => {
  let h;
  before(async () => { h = await setup({ settings: { tools: { enabled: false }, titles: { auto: false }, embeddings: { model: 'auto' } }, system: { totalMem: 16 * 1024 ** 3, platform: 'darwin', arch: 'arm64' } }); });
  after(() => h.close());

  test('auto-detects embeddinggemma, embeds memories and uses semantic scores', async () => {
    const st = (await h.c.get('/api/embeddings/status')).data;
    assert.equal(st.enabled, true);
    assert.equal(st.model, 'embeddinggemma:latest');
    await h.c.post('/api/memories', { content: 'The user enjoys hiking in the Alps every summer.' });
    await h.c.post('/api/memories', { content: 'The user writes Rust for embedded devices.' });
    await h.app.memories.index.ensureEmbeddings();
    const s = (await h.c.post('/api/memories/search', { query: 'hiking alps summer trip', minSimilarity: 0.2 })).data;
    assert.equal(s.retrieval, 'hybrid');
    assert.equal(s.embeddingModel, 'embeddinggemma:latest');
    assert.match(s.results[0].memory.content, /hiking/);
    assert.ok(s.results[0].semantic > 0.2);
    const embedReq = h.fake.requests.find((r) => r.path === '/api/embed');
    assert.ok(embedReq.body.input.some((t) => t.startsWith('title: none | text: ')), 'document task prefix');
  });
});
