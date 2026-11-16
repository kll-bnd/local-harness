// Auto-summarizer: triggering, incrementality, tool-pair integrity, map-reduce, fallback, originals preserved.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { planCompaction, summarizeSpan, activeSummary } from '../server/context/compaction.mjs';
import { budgetsFor } from '../server/context/sizing.mjs';
import { makeCounter } from '../server/context/tokens.mjs';
import { DEFAULT_SETTINGS } from '../server/store/settings.mjs';
import { activePath } from '../server/chat/tree.mjs';
import { respond } from './fake-model.mjs';
import { setup, newChat, send, byType } from './helpers.mjs';

const filler = (i) => `Topic ${i}: ` + 'we discussed the design of the harness application in considerable detail '.repeat(10);
const isSummarizerReq = (b) => /running summary|take notes on one part/.test(b.messages?.[0]?.content || '');

describe('planCompaction (unit)', () => {
  const budgets = { ...budgetsFor(4096, DEFAULT_SETTINGS) };
  test('no compaction under the threshold', () => {
    const live = [{ id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant' }, { id: 'u2', role: 'user' }];
    assert.equal(planCompaction({ live, liveTokens: [100, 100, 100], fixedTokens: 200, budgets }), null);
  });

  test('property: never splits a tool call from its result and always keeps the last user message', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let iter = 0; iter < 400; iter++) {
      const live = [];
      const n = 3 + Math.floor(rnd() * 25);
      let id = 0;
      while (live.length < n) {
        live.push({ id: `m${id++}`, role: 'user' });
        const steps = Math.floor(rnd() * 3);
        for (let s = 0; s < steps; s++) {
          const k = 1 + Math.floor(rnd() * 2);
          live.push({ id: `m${id++}`, role: 'assistant', toolCalls: Array.from({ length: k }, (_, j) => ({ id: `c${id}_${j}` })) });
          for (let j = 0; j < k; j++) live.push({ id: `m${id++}`, role: 'tool' });
        }
        if (rnd() > 0.2) live.push({ id: `m${id++}`, role: 'assistant' });
      }
      if (live.at(-1).role !== 'user') live.push({ id: `m${id++}`, role: 'user' });
      const liveTokens = live.map(() => 20 + Math.floor(rnd() * 400));
      const plan = planCompaction({ live, liveTokens, fixedTokens: 300, budgets, minKeepMessages: 1 + Math.floor(rnd() * 3), force: rnd() > 0.5 });
      if (!plan) continue;
      const b = plan.boundary;
      assert.ok(b > 0 && b < live.length);
      assert.notEqual(live[b].role, 'tool', `iter ${iter}: tail starts with a tool result`);
      assert.ok(!(live[b - 1].role === 'assistant' && live[b - 1].toolCalls?.length), `iter ${iter}: evicted a tool call but kept its result`);
      const lastUser = live.map((m) => m.role).lastIndexOf('user');
      assert.ok(b <= lastUser, `iter ${iter}: evicted the final user message`);
    }
  });

  test('prefers user-message boundaries and respects the verbatim tail budget', () => {
    const live = [];
    for (let i = 0; i < 10; i++) live.push({ id: `u${i}`, role: 'user' }, { id: `a${i}`, role: 'assistant' });
    live.push({ id: 'uq', role: 'user' });
    const liveTokens = live.map(() => 200);
    const plan = planCompaction({ live, liveTokens, fixedTokens: 300, budgets });
    assert.ok(plan);
    assert.equal(live[plan.boundary].role, 'user');
    assert.ok(plan.keepTokens <= plan.tailBudget);
  });
});

describe('summarizeSpan (map-reduce)', () => {
  test('spans larger than the summarizer context are chunked, all facts survive, incremental with the old summary', async () => {
    const counter = makeCounter(1);
    const calls = [];
    const complete = async (messages, { maxTokens }) => {
      calls.push({ system: messages[0].content.slice(0, 40), user: messages[1].content, maxTokens });
      return respond({ model: 'x', messages }).content;
    };
    const span = [];
    for (let i = 0; i < 30; i++) {
      span.push({ id: `u${i}`, role: 'user', content: `FACT: key${i}\n${filler(i)}` });
      span.push({ id: `a${i}`, role: 'assistant', content: `Noted ${i}. ${filler(i)}` });
    }
    const r = await summarizeSpan({ complete, existingSummary: '## Key facts & context\n- FACT: oldfact', span, counter, ctxTokens: 2048, maxSummaryTokens: 245 });
    assert.equal(r.method, 'map-reduce');
    assert.ok(r.calls >= 3, `calls ${r.calls}`);
    for (let i = 0; i < 30; i++) assert.match(r.content, new RegExp(`FACT: key${i}\\b`));
    assert.match(r.content, /FACT: oldfact/);
    for (const c of calls) assert.ok(counter.text(c.user) < 2048, 'every summarizer prompt fits its context');
    const small = await summarizeSpan({ complete, existingSummary: '', span: span.slice(0, 2), counter, ctxTokens: 2048, maxSummaryTokens: 245 });
    assert.equal(small.method, 'single');
  });
});

describe('auto-compaction end-to-end (fake Ollama, 2K window)', () => {
  let h;
  before(async () => {
    h = await setup({ settings: { tools: { enabled: false }, memory: { enabled: false }, recall: { enabled: false }, titles: { auto: false }, reasoning: { think: 'off' } } });
  });
  after(() => h.close());

  test('triggers over the threshold, is incremental, keeps originals, and the model sees the summary', async () => {
    const chatId = await newChat(h.c, { settings: { context: { mode: 2048 } } });
    const compactions = [];
    let turns = 0;
    for (let i = 1; i <= 14 && compactions.filter((e) => e.status === 'completed').length < 2; i++) {
      const r = await send(h.c, chatId, `FACT: f${i}\n${filler(i)}`);
      turns++;
      assert.ok(byType(r.events, 'done').length === 1, `turn ${i} finished: ${JSON.stringify(byType(r.events, 'error'))}`);
      for (const e of byType(r.events, 'compaction')) compactions.push({ ...e, turn: i });
      const ctx = byType(r.events, 'context')[0];
      assert.ok(ctx.used <= ctx.budget, `turn ${i}: used ${ctx.used} > budget ${ctx.budget}`);
    }
    const done = compactions.filter((e) => e.status === 'completed');
    assert.equal(done.length, 2, `expected 2 compactions, got ${JSON.stringify(compactions.map((c) => [c.turn, c.status]))}`);
    assert.ok(compactions[0].status === 'started' && compactions[0].messages > 0);
    assert.ok(done[0].usedAfter < done[0].usedBefore);

    const sumReqs = h.fake.chatRequests().filter(isSummarizerReq);
    assert.equal(sumReqs.length, 2);
    // Incremental: the second summarizer call gets the first summary + only the newly evicted span.
    const second = sumReqs[1].messages[1].content;
    const existing = second.match(/<existing_summary>([\s\S]*?)<\/existing_summary>/)[1];
    const spanText = second.match(/<conversation_span>([\s\S]*?)<\/conversation_span>/)[1];
    assert.match(existing, /FACT: f1\b/);
    assert.doesNotMatch(spanText, /User: FACT: f1\b/);
    assert.match(done[1].summary.content, /FACT: f1\b/);
    assert.equal(done[1].summary.previousSummaryId, done[0].summary.id);
    // Summarizer used the same num_ctx as chat (no model reload).
    const mainReqs = h.fake.chatRequests().filter((b) => !isSummarizerReq(b));
    assert.ok(sumReqs.every((b) => b.options.num_ctx === 2048) && mainReqs.every((b) => b.options.num_ctx === 2048));

    // The model sees the summary, not the evicted messages.
    const lastMain = mainReqs.at(-1);
    assert.match(lastMain.messages[0].content, /## Summary of the earlier conversation/);
    assert.ok(!lastMain.messages.some((m) => /^FACT: f1\b/.test(m.content)));
    assert.equal(lastMain.messages[1].role, 'user');

    // Originals are never deleted.
    const d = (await h.c.get(`/api/chats/${chatId}`)).data;
    assert.equal(d.messages.length, turns * 2);
    assert.ok(d.messages.some((m) => m.content.startsWith('FACT: f1\n')));
    assert.equal(d.chat.summary.id, done[1].summary.id);
    const sv = (await h.c.get(`/api/chats/${chatId}/summary`)).data;
    assert.equal(sv.history.length, 2);
    assert.ok(sv.compactedMessageCount > 0);
  });

  test('summary is editable and deletable; manual compact; per-chat off switch', async () => {
    const chatId = await newChat(h.c, { settings: { context: { mode: 4096 } } });
    for (let i = 1; i <= 3; i++) await send(h.c, chatId, `FACT: m${i}\n${filler(i)}`);
    const r = await h.c.post(`/api/chats/${chatId}/compact`, { keepRecentMessages: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.messagesSummarized >= 2);
    assert.match(r.data.summary.content, /FACT: m1/);
    const ed = await h.c.put(`/api/chats/${chatId}/summary`, { content: '## Key facts & context\n- EDITED-BY-USER marker' });
    assert.equal(ed.data.summary.editedByUser, true);
    await send(h.c, chatId, 'next question');
    const lastMain = h.fake.chatRequests().filter((b) => !isSummarizerReq(b)).at(-1);
    assert.match(lastMain.messages[0].content, /EDITED-BY-USER marker/);
    const del = await h.c.del(`/api/chats/${chatId}/summary`);
    assert.equal(del.status, 200);
    assert.equal(del.data.summary, null);
    // per-chat off: no summary is used even if one existed
    await h.c.post(`/api/chats/${chatId}/compact`, {});
    await h.c.patch(`/api/chats/${chatId}`, { settings: { compaction: { enabled: false } } });
    await send(h.c, chatId, 'another question');
    const after = h.fake.chatRequests().filter((b) => !isSummarizerReq(b)).at(-1);
    assert.doesNotMatch(after.messages[0].content, /Summary of the earlier conversation/);
  });

  test('summarizer failure degrades to hard truncation; originals preserved; turn still answers', async () => {
    const chatId = await newChat(h.c, { settings: { context: { mode: 2048 } } });
    h.fake.failNext({ path: '/api/chat', match: isSummarizerReq, status: 500, error: 'summarizer exploded', count: 100 });
    let failed = null;
    let truncated = null;
    for (let i = 1; i <= 12 && !(failed && truncated); i++) {
      const r = await send(h.c, chatId, `FACT: g${i}\n${filler(i)}`);
      assert.equal(byType(r.events, 'done').length, 1, `turn ${i} must still complete`);
      failed ||= byType(r.events, 'compaction').find((e) => e.status === 'failed');
      truncated ||= byType(r.events, 'notice').find((e) => e.code === 'context_truncated');
      const ctx = byType(r.events, 'context')[0];
      assert.ok(ctx.used <= ctx.budget);
    }
    assert.ok(failed, 'compaction failure reported');
    assert.match(failed.error, /summarizer exploded/);
    assert.equal(failed.fallback, 'truncate');
    assert.ok(truncated, 'hard truncation kicked in');
    const chat = h.app.chats.get(chatId);
    assert.equal(chat.summaries.length, 0);
    assert.ok(chat.compaction.lastError);
    assert.ok(activePath(chat).some((m) => m.content.startsWith('FACT: g1\n')), 'original message still stored');
    assert.equal(activeSummary(chat, activePath(chat)), null);
    h.fake.failures.length = 0;
  });
});
