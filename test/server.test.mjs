// HTTP server: security, routing, chats, SSE streaming, reasoning, branching, tool loop, abort, persistence.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setup, newChat, send, byType, text, waitFor } from './helpers.mjs';

function rawRequest(port, { method = 'GET', path = '/api/health', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('server basics & security', () => {
  let h;
  before(async () => { h = await setup(); });
  after(() => h.close());

  test('binds 127.0.0.1 and serves health + static UI', async () => {
    assert.match(h.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await h.c.get('/api/health');
    assert.deepEqual(r.data, { ok: true, name: 'harness', version: '0.1.0' });
    const ui = await fetch(h.url + '/');
    assert.equal(ui.status, 200);
    assert.match(await ui.text(), /<title>Harness<\/title>/);
    const spa = await fetch(h.url + '/chats/some-id');
    assert.equal(spa.status, 200, 'SPA fallback');
    const trav = await rawRequest(h.srv.port, { path: '/../package.json', headers: { host: '127.0.0.1' } });
    assert.notEqual(trav.status, 200);
  });

  test('rejects non-localhost Host headers (DNS rebinding)', async () => {
    for (const host of ['evil.com', 'evil.com:4747', '127.0.0.1.nip.io', 'localhost.evil.com']) {
      const r = await rawRequest(h.srv.port, { headers: { host } });
      assert.equal(r.status, 403, host);
      assert.equal(JSON.parse(r.body).error.code, 'forbidden');
    }
    for (const host of ['localhost:4747', '127.0.0.1', '[::1]:4747']) {
      assert.equal((await rawRequest(h.srv.port, { headers: { host } })).status, 200, host);
    }
  });

  test('rejects cross-site Origins (CSRF), allows localhost dev origins with CORS', async () => {
    for (const origin of ['http://evil.com', 'null', 'https://localhost.evil.com', 'file://']) {
      const r = await rawRequest(h.srv.port, { method: 'POST', path: '/api/chats', headers: { host: '127.0.0.1', origin, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 403, origin);
    }
    const cs = await rawRequest(h.srv.port, { headers: { host: '127.0.0.1', 'sec-fetch-site': 'cross-site' } });
    assert.equal(cs.status, 403);
    const ok = await rawRequest(h.srv.port, { headers: { host: '127.0.0.1:4747', origin: 'http://localhost:5173' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], 'http://localhost:5173');
    const pre = await rawRequest(h.srv.port, { method: 'OPTIONS', path: '/api/chats', headers: { host: '127.0.0.1', origin: 'http://127.0.0.1:3000', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers['access-control-allow-methods'], /PATCH/);
  });

  test('error format, 404/405/415/400', async () => {
    const nf = await h.c.get('/api/nope');
    assert.equal(nf.status, 404);
    assert.deepEqual(Object.keys(nf.data.error).sort(), ['code', 'message']);
    assert.equal((await h.c.del('/api/health')).status, 405);
    const ct = await fetch(h.url + '/api/chats', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(ct.status, 415);
    const bad = await fetch(h.url + '/api/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'bad_json');
    assert.equal((await h.c.get('/api/chats/chat_missing')).status, 404);
  });

  test('settings: get, validated patch, reset', async () => {
    const g = await h.c.get('/api/settings');
    assert.equal(g.data.settings.context.mode, 'auto');
    assert.ok(g.data.defaults);
    const p = await h.c.patch('/api/settings', { params: { temperature: 0.4 }, ui: { theme: 'dark', fontSize: 15 } });
    assert.equal(p.data.settings.params.temperature, 0.4);
    assert.equal(p.data.settings.ui.fontSize, 15);
    const bad = await h.c.patch('/api/settings', { context: { mode: 'gigantic' } });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error.message, /context\.mode/);
    const r = await h.c.post('/api/settings/reset');
    assert.equal(r.data.settings.params.temperature, null);
    await h.c.patch('/api/settings', { providers: { builtin: { ollama: { baseUrl: h.fake.url } } }, embeddings: { model: 'off' }, memory: { extractDelayMs: 0 }, ollama: { autoStart: false } });
  });

  test('presets: built-ins read-only, user presets CRUD, used by chats', async () => {
    const list = (await h.c.get('/api/presets')).data.presets;
    assert.ok(list.find((p) => p.id === 'default' && p.builtin));
    assert.equal((await h.c.patch('/api/presets/default', { name: 'x' })).status, 403);
    const cr = await h.c.post('/api/presets', { name: 'Pirate', systemPrompt: 'You talk like a pirate.', params: { temperature: 0.9 } });
    assert.equal(cr.status, 201);
    const id = cr.data.preset.id;
    const chat = await newChat(h.c, { settings: { presetId: id } });
    await send(h.c, chat, 'ahoy');
    const req = h.fake.chatRequests().at(-1);
    assert.match(req.messages[0].content, /pirate/);
    assert.equal(req.options.temperature, 0.9);
    assert.equal((await h.c.patch(`/api/presets/${id}`, { description: 'Arr' })).data.preset.description, 'Arr');
    assert.equal((await h.c.del(`/api/presets/${id}`)).status, 200);
  });
});

describe('chats, streaming, reasoning, branching, tools', () => {
  let h;
  before(async () => { h = await setup({ settings: { titles: { auto: true }, memory: { enabled: false } } }); });
  after(() => h.close());

  test('chat CRUD, list ordering, pin/archive, rename', async () => {
    const a = await newChat(h.c, { title: 'Alpha' });
    const b = await newChat(h.c);
    await h.c.patch(`/api/chats/${a}`, { pinned: true });
    let list = (await h.c.get('/api/chats')).data.chats;
    assert.equal(list[0].id, a);
    await h.c.patch(`/api/chats/${b}`, { archived: true, title: 'Bravo' });
    list = (await h.c.get('/api/chats')).data.chats;
    assert.ok(!list.some((c) => c.id === b));
    const arch = (await h.c.get('/api/chats?archived=true')).data.chats;
    assert.equal(arch[0].title, 'Bravo');
    assert.equal(arch[0].titleSource, 'user');
    const bad = await h.c.patch(`/api/chats/${a}`, { settings: { nonsense: 1 } });
    assert.equal(bad.status, 400);
    assert.equal((await h.c.del(`/api/chats/${b}`)).status, 200);
    assert.equal((await h.c.get(`/api/chats/${b}`)).status, 404);
  });

  test('SSE stream: event order, tokens, stats, done; auto title; per-model sampling defaults', async () => {
    const chat = await newChat(h.c);
    const r = await send(h.c, chat, 'Hello world from the test suite', { model: { model: 'gemma3:4b' } });
    const types = r.events.map((e) => e.type);
    assert.equal(types[0], 'start');
    assert.ok(types.indexOf('context') < types.indexOf('token'));
    assert.equal(types.at(-1), 'done');
    assert.equal(text(r.events), 'You said: Hello world from the test suite');
    const done = byType(r.events, 'done')[0];
    assert.equal(done.reason, 'stop');
    assert.equal(done.message.status, 'complete');
    assert.equal(done.message.content, 'You said: Hello world from the test suite');
    assert.ok(done.stats.promptTokens > 0);
    assert.ok(byType(r.events, 'stats')[0].tokensPerSecond > 0);
    const req = h.fake.chatRequests().at(-1);
    assert.ok(req.options.num_ctx >= 2048 && req.options.num_ctx <= 131072);
    assert.equal(req.options.top_k, 64, 'gemma profile default applied');
    assert.equal(req.options.temperature, 1.0);
    await h.app.background.idle();
    const d = (await h.c.get(`/api/chats/${chat}`)).data;
    assert.equal(d.chat.title, 'Hello World From The');
    assert.equal(d.chat.titleSource, 'auto');
    assert.deepEqual(d.path, d.messages.map((m) => m.id));
  });

  test('reasoning: Ollama thinking field and inline <think> tags stream as reasoning and are not resent', async () => {
    const chat = await newChat(h.c);
    const r = await send(h.c, chat, 'Why is the sky blue?', { model: { model: 'qwen3:4b' } });
    const reasoning = byType(r.events, 'reasoning').map((e) => e.delta).join('');
    assert.equal(reasoning, 'Thinking about: Why is the sky blue?');
    assert.equal(h.fake.chatRequests().at(-1).think, true);
    await send(h.c, chat, 'And at sunset?', { model: { model: 'qwen3:4b' } });
    const hist = h.fake.chatRequests().at(-1).messages;
    assert.ok(!JSON.stringify(hist).includes('Thinking about'), 'reasoning is not resent');
    // think off → think:false sent
    await h.c.patch(`/api/chats/${chat}`, { settings: { reasoning: { think: 'off' } } });
    await send(h.c, chat, 'ok', { model: { model: 'qwen3:4b' } });
    assert.equal(h.fake.chatRequests().at(-1).think, false);

    const chat2 = await newChat(h.c);
    const r2 = await send(h.c, chat2, 'inline please', { model: { model: 'deepseek-r1:1.5b' } });
    assert.equal(byType(r2.events, 'reasoning').map((e) => e.delta).join(''), 'Reasoning about: inline please');
    const done = byType(r2.events, 'done')[0].message;
    assert.equal(done.content, 'You said: inline please');
    assert.equal(done.reasoning, 'Reasoning about: inline please');
    assert.equal(h.fake.chatRequests().at(-1).think, undefined, 'no think flag for models without the capability');
  });

  test('branching: regenerate, edit-and-resend, switch branch, delete subtree', async () => {
    const chat = await newChat(h.c);
    await send(h.c, chat, 'first question');
    const r2 = await send(h.c, chat, 'second question');
    const u2 = byType(r2.events, 'start')[0].userMessage.id;
    const a2 = byType(r2.events, 'done')[0].message.id;
    // regenerate a2 → sibling
    const rg = await h.c.sse(`/api/chats/${chat}/messages/${a2}/regenerate`, {});
    const a2b = byType(rg.events, 'done')[0].message;
    assert.equal(a2b.parentId, u2);
    let d = (await h.c.get(`/api/chats/${chat}`)).data;
    const a2bMsg = d.messages.find((m) => m.id === a2b.id);
    assert.deepEqual(a2bMsg.siblingIds, [a2, a2b.id]);
    assert.equal(d.path.at(-1), a2b.id);
    // edit u2 → new sibling user message + reply
    const ed = await h.c.sse(`/api/chats/${chat}/messages/${u2}/edit`, { content: 'second question, edited' });
    const u2b = byType(ed.events, 'start')[0].userMessage;
    assert.equal(u2b.parentId, d.messages.find((m) => m.id === u2).parentId);
    assert.equal(u2b.editedFrom, u2);
    assert.equal(text(ed.events), 'You said: second question, edited');
    // model history for the edited branch excludes the old branch
    const hist = h.fake.chatRequests().at(-1).messages.map((m) => m.content).join('|');
    assert.ok(!hist.includes('second question|'), hist);
    // switch back to the original branch → remembers the regenerated leaf
    const sw = await h.c.post(`/api/chats/${chat}/branch`, { messageId: u2 });
    assert.equal(sw.data.activeLeafId, a2b.id);
    // delete the original u2 subtree → falls back to the edited branch
    const del = await h.c.del(`/api/chats/${chat}/messages/${u2}`);
    assert.deepEqual(del.data.deleted.sort(), [u2, a2, a2b.id].sort());
    d = (await h.c.get(`/api/chats/${chat}`)).data;
    assert.equal(d.path.includes(u2b.id), true);
    // edit assistant message → sibling without generation
    const am = d.messages.find((m) => m.id === d.path.at(-1));
    const ea = await h.c.post(`/api/chats/${chat}/messages/${am.id}/edit`, { content: 'hand-edited answer' });
    assert.equal(ea.data.message.edited, true);
    assert.equal(ea.data.path.at(-1), ea.data.message.id);
    // fork into a new chat
    const fk = await h.c.post(`/api/chats/${chat}/fork`, { messageId: u2b.id });
    assert.equal(fk.status, 201);
    assert.equal(fk.data.path.length, 3);
  });

  test('tool loop: calculate end-to-end, iteration cap, unknown tool', async () => {
    const chat = await newChat(h.c);
    const r = await send(h.c, chat, 'please calculate (17.5 * 3) / sqrt(2)');
    const call = byType(r.events, 'tool_call')[0];
    assert.equal(call.toolCall.name, 'calculate');
    const res = byType(r.events, 'tool_result')[0];
    assert.match(res.content, /= 37\.1231/);
    assert.equal(res.isError, false);
    const done = byType(r.events, 'done')[0];
    assert.match(done.message.content, /Tool calculate returned: \(17\.5 \* 3\) \/ sqrt\(2\) = 37\.123/);
    assert.equal(done.createdMessageIds.length, 3);
    // tool messages are sent back with tool_name; assistant tool_calls preserved
    const req = h.fake.chatRequests().at(-1);
    const toolMsg = req.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.tool_name, 'calculate');
    assert.equal(req.messages.find((m) => m.tool_calls).tool_calls[0].function.name, 'calculate');
    // tool definitions offered
    assert.ok(req.tools.some((t) => t.function.name === 'get_current_time'));
    assert.ok(!req.tools.some((t) => t.function.name === 'fetch_url'), 'fetch_url off by default');
    assert.ok(!req.tools.some((t) => t.function.name === 'generate_image'), 'generate_image hidden without an image provider');

    await h.c.patch(`/api/chats/${chat}`, { settings: { tools: { builtin: { get_current_time: true } } } });
    await h.c.patch('/api/settings', { tools: { maxIterations: 2 } });
    const loop = await send(h.c, chat, 'loop forever please');
    assert.equal(byType(loop.events, 'tool_call').length, 2);
    assert.equal(byType(loop.events, 'done')[0].reason, 'stop');
    assert.equal(h.fake.chatRequests().at(-1).tools, undefined, 'final iteration offers no tools');
    await h.c.patch('/api/settings', { tools: { maxIterations: 6 } });

    const unk = await send(h.c, chat, 'use tool does_not_exist {}');
    assert.equal(byType(unk.events, 'tool_call').length, 0, 'tool not offered → model cannot call it');
  });

  test('graceful fallback when the backend rejects tools; models without tool capability get none', async () => {
    const chat = await newChat(h.c);
    h.fake.failNext({ path: '/api/chat', status: 400, error: 'registry.ollama.ai/library/nemotron does not support tools', match: (b) => !!b.tools });
    const r = await send(h.c, chat, 'hello there');
    assert.ok(byType(r.events, 'notice').some((n) => n.code === 'tools_unsupported'));
    assert.equal(text(r.events), 'You said: hello there');
    h.app.registry._infoCache.clear();
    await send(h.c, chat, 'hi gemma2', { model: { model: 'gemma2:2b' } });
    assert.equal(h.fake.chatRequests().at(-1).tools, undefined);
  });

  test('abort via stop endpoint keeps the partial answer; busy chats return 409', async () => {
    const chat = await newChat(h.c);
    h.fake.setDelay(15);
    let stopped = null;
    let sawToken = false;
    const events = await h.c.sseStream(`/api/chats/${chat}/messages`, { content: 'long answer 300' }, async (ev) => {
      if (ev.type === 'token' && !sawToken) {
        sawToken = true;
        const busy = await send(h.c, chat, 'second message while busy');
        assert.equal(busy.status, 409);
        assert.equal(busy.error.error.code, 'chat_busy');
        stopped = await h.c.post(`/api/chats/${chat}/stop`);
      }
    });
    h.fake.setDelay(0);
    assert.equal(stopped.data.stopped, true);
    const done = byType(events, 'done')[0];
    assert.equal(done.reason, 'aborted');
    assert.equal(done.message.status, 'aborted');
    assert.ok(done.message.content.length > 0 && done.message.content.length < 1000);
    const d = (await h.c.get(`/api/chats/${chat}`)).data;
    assert.equal(d.messages.find((m) => m.id === done.message.id).status, 'aborted');
    assert.equal(d.chat.generating, null);
  });

  test('client disconnect aborts the generation', async () => {
    const chat = await newChat(h.c);
    h.fake.setDelay(15);
    const ac = new AbortController();
    await h.c.sseStream(`/api/chats/${chat}/messages`, { content: 'long answer 300' }, (ev) => { if (ev.type === 'token') ac.abort(); }, { signal: ac.signal });
    await waitFor(() => !h.app.engine.busy(chat));
    h.fake.setDelay(0);
    const d = (await h.c.get(`/api/chats/${chat}`)).data;
    assert.equal(d.messages.find((m) => m.role === 'assistant').status, 'aborted');
  });

  test('setup errors are JSON (no stream): unknown model, provider down', async () => {
    const chat = await newChat(h.c);
    const r = await send(h.c, chat, 'hi', { model: { model: 'no-such-model:1b' } });
    assert.equal(r.status, 404);
    assert.equal(r.error.error.code, 'model_not_found');
    const d = (await h.c.get(`/api/chats/${chat}`)).data;
    assert.equal(d.messages.length, 0, 'no dangling user message');
    await h.c.patch('/api/settings', { providers: { builtin: { ollama: { baseUrl: 'http://127.0.0.1:9' } } } });
    h.app.registry.invalidate();
    const down = await send(h.c, chat, 'hi', { model: { providerId: 'ollama', model: 'gemma3:4b' } });
    assert.equal(down.status, 503);
    assert.equal(down.error.error.code, 'connection_failed');
    await h.c.patch('/api/settings', { providers: { builtin: { ollama: { baseUrl: h.fake.url } } } });
    h.app.registry.invalidate();
  });

  test('token calibration converges on the backend tokenizer and is reported in usage', async () => {
    const chat = await newChat(h.c);
    for (let i = 0; i < 4; i++) await send(h.c, chat, `calibration round ${i}: ` + 'some ordinary english text for counting tokens. '.repeat(20), { model: { model: 'gemma3:4b' } });
    const cal = h.app.calibrator.get('ollama', 'gemma3:4b');
    assert.ok(cal.samples >= 4);
    assert.ok(cal.ratio > 1.05 && cal.ratio < 2.5, `ratio ${cal.ratio}`);
    const r = await send(h.c, chat, 'one more ' + 'ordinary english text. '.repeat(30), { model: { model: 'gemma3:4b' } });
    const ctx = byType(r.events, 'context')[0];
    const actual = byType(r.events, 'stats')[0].promptTokens;
    assert.ok(Math.abs(ctx.used - actual) / actual < 0.15, `estimate ${ctx.used} vs actual ${actual}`);
    assert.ok(ctx.calibration > 1.05, `calibration factor reported: ${ctx.calibration}`);
    const pv = (await h.c.get(`/api/chats/${chat}/context?draft=${encodeURIComponent('what next?')}`)).data;
    assert.ok(pv.context.used > 0 && pv.context.breakdown.history > 0);
    assert.equal(pv.plan.numCtx, pv.context.numCtx);
  });
});

describe('persistence across restart', () => {
  test('chats, messages, memories, settings and calibration survive; interrupted streams become aborted', async () => {
    const h = await setup({ settings: { memory: { enabled: true } } });
    try {
      const chat = await newChat(h.c, { title: 'Persist me' });
      await send(h.c, chat, 'My name is Persist and I prefer tea.');
      await h.app.background.idle();
      await h.c.patch('/api/settings', { params: { temperature: 0.33 } });
      await h.c.post('/api/memories', { content: 'The user has a dog named Rex.', pinned: true });
      // simulate a crash mid-stream
      const c = h.app.chats.get(chat);
      const leaf = c.messages[c.activeLeafId];
      leaf.status = 'streaming';
      await h.app.chats.saveNow(c);
      const memCount = (await h.c.get('/api/memories')).data.total;
      await h.restart();
      const d = (await h.c.get(`/api/chats/${chat}`)).data;
      assert.equal(d.chat.title, 'Persist me');
      assert.equal(d.messages.length, 2);
      assert.equal(d.messages.find((m) => m.role === 'assistant').status, 'aborted');
      assert.equal((await h.c.get('/api/settings')).data.settings.params.temperature, 0.33);
      assert.equal((await h.c.get('/api/memories')).data.total, memCount);
      assert.ok((await h.c.get('/api/memories?pinned=true')).data.memories.some((m) => /Rex/.test(m.content)));
      assert.ok(h.app.calibrator.get('ollama', 'nemotron-3.5-bolt:e4b')?.samples >= 1);
      const r = await send(h.c, chat, 'still there?');
      assert.equal(byType(r.events, 'done').length, 1);
    } finally {
      await h.close();
    }
  });
});
