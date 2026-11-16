// Performance budget checks for long chats and long code: opening a 400-message chat with code blocks,
// scrolling through all of it, rendering a 2,000-line code block, and streaming that block token by token.
// Numbers are printed (`node --test --test-reporter=spec test/ui/perf.test.mjs`); the asserted limits are
// deliberately generous so the suite stays stable on a loaded CI machine — they catch pathologies
// (re-rendering everything per token, O(n²) streaming), not small regressions.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, openApp, closeBrowser } from './harness.mjs';

after(closeBrowser);

const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0; };
const ms = (n) => `${Math.round(n)} ms`;

function codeBlock(lines, lang = 'js') {
  const out = [];
  for (let i = 0; i < lines; i++) out.push(`  const value${i} = compute(${i}, "item-${i}") + ${i % 7}; // line ${i}`);
  return `\`\`\`${lang}\nfunction big() {\n${out.join('\n')}\n}\n\`\`\``;
}

function longChat(n) {
  const messages = [];
  for (let i = 0; i < n / 2; i++) {
    messages.push({ role: 'user', content: `Question ${i}: how do I handle case ${i}?` });
    messages.push({ role: 'assistant', content: `## Case ${i}\n\nHere is a **short** explanation with a list:\n\n- first point ${i}\n- second point\n\n${codeBlock(12 + (i % 20), i % 2 ? 'python' : 'js')}\n\nThat should do it.` });
  }
  return { title: `Long chat (${n} messages)`, messages };
}

/** Install a frame-time + long-task recorder in the page. */
async function startRecording(page) {
  await page.evaluate(() => {
    window.__perf = { frames: [], long: [] };
    let last = performance.now();
    const tick = (t) => { window.__perf.frames.push(t - last); last = t; if (window.__perf.on) requestAnimationFrame(tick); };
    window.__perf.on = true;
    requestAnimationFrame(tick);
    try {
      window.__perf.obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__perf.long.push(e.duration); });
      window.__perf.obs.observe({ type: 'longtask', buffered: false });
    } catch { /* longtask unsupported (WebKit) */ }
  });
}
async function stopRecording(page) {
  return page.evaluate(() => { window.__perf.on = false; window.__perf.obs?.disconnect(); return { frames: window.__perf.frames.slice(1), long: window.__perf.long }; });
}

test('perf: a 400-message chat with code blocks opens fast and scrolls smoothly end to end', async () => {
  const stack = await startStack();
  const { data } = await stack.api('POST', '/api/chats/import', longChat(400));
  const id = data.chats[0].id;
  const app = await openApp(stack);
  try {
    const { page } = app;
    await startRecording(page);
    const t0 = await page.evaluate((cid) => { const t = performance.now(); location.hash = `#/chat/${cid}`; return t; }, id);
    await page.waitForFunction(() => document.querySelectorAll('.turn').length === 200 && document.querySelector('.turn:last-of-type .prose'));
    const open = await page.evaluate((start) => new Promise((r) => requestAnimationFrame(() => r(performance.now() - start))), t0);
    const openRec = await stopRecording(page);
    const materialized = await page.locator('.turn:not(.turn-lazy)').count();
    // Scroll from the bottom to the top and back, a viewport at a time, like a fast wheel.
    await startRecording(page);
    const scroll = await page.evaluate(async () => {
      const sc = document.querySelector('.transcript-scroll');
      const step = sc.clientHeight * 0.9;
      const t = performance.now();
      let steps = 0;
      for (let i = 0; i < 400 && sc.scrollTop > 0; i++) { sc.scrollTop -= step; steps++; await new Promise((r) => requestAnimationFrame(r)); }
      for (let i = 0; i < 400 && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2; i++) { sc.scrollTop += step; steps++; await new Promise((r) => requestAnimationFrame(r)); }
      return { steps, total: performance.now() - t, height: sc.scrollHeight };
    });
    const rec = await stopRecording(page);
    const report = {
      open: ms(open), openLongestTask: ms(Math.max(0, ...openRec.long)), materializedAtOpen: materialized,
      scrollSteps: scroll.steps, scrollHeightPx: Math.round(scroll.height), scrollTotal: ms(scroll.total),
      frameP50: ms(pct(rec.frames, 0.5)), frameP95: ms(pct(rec.frames, 0.95)), frameMax: ms(Math.max(...rec.frames)),
      longTasks: rec.long.length, longestTask: ms(Math.max(0, ...rec.long)),
      domNodes: await page.evaluate(() => document.getElementsByTagName('*').length),
    };
    console.log('PERF long chat', JSON.stringify(report));
    assert.ok(open < 4000, `opening took ${open} ms`);
    assert.ok(materialized < 60, 'old turns are rendered lazily');
    assert.ok(pct(rec.frames, 0.95) < 120, `p95 frame ${pct(rec.frames, 0.95)} ms while scrolling`);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

/**
 * In the page: stream `text` through the app's StreamingMarkdown (`chunkLines` = its strategy), ~7 characters per
 * token and 4 tokens per update (≈ 240 tokens/s, far faster than an 8 GB Mac produces), forcing layout after every
 * update. → per-update times in order, plus the finished height (to compare strategies).
 */
async function streamInPage(page, text, chunkLines) {
  return page.evaluate(async ({ text: t, chunkLines: per }) => {
    const { StreamingMarkdown } = await import('/js/lib/markdown.js');
    const saved = StreamingMarkdown.chunkLines;
    if (per != null) StreamingMarkdown.chunkLines = per; // null: the app's own setting
    const host = document.createElement('div');
    host.className = 'prose';
    host.style.cssText = 'position:fixed;left:0;top:0;width:700px;height:600px;overflow:auto;opacity:0.01';
    document.body.append(host);
    const md = new StreamingMarkdown(host);
    const times = [];
    let pos = 0;
    const t0 = performance.now();
    while (pos < t.length) {
      pos = Math.min(t.length, pos + 28);
      const a = performance.now();
      md.update(t.slice(0, pos));
      void host.scrollHeight; // include layout
      times.push(performance.now() - a);
      if (times.length % 50 === 0) await new Promise((r) => requestAnimationFrame(r));
    }
    const total = performance.now() - t0;
    const streamedHeight = host.scrollHeight;
    const f0 = performance.now();
    md.finish(t);
    void host.scrollHeight;
    const finish = performance.now() - f0;
    host.remove();
    StreamingMarkdown.chunkLines = saved;
    return { times, total, finish, streamedHeight };
  }, { text, chunkLines });
}

/**
 * In the page: does one update's cost depend on how big the open block already is? Grow a block to each size in
 * one (unmeasured) update, then time 40 small updates there. O(delta) → flat across sizes; O(block) → grows.
 */
async function costBySize(page, text, sizes, chunkLines) {
  return page.evaluate(async ({ text: t, sizes: list, chunkLines: per }) => {
    const { StreamingMarkdown } = await import('/js/lib/markdown.js');
    const saved = StreamingMarkdown.chunkLines;
    if (per != null) StreamingMarkdown.chunkLines = per; // null: the app's own setting
    const host = document.createElement('div');
    host.className = 'prose';
    host.style.cssText = 'position:fixed;left:0;top:0;width:700px;height:600px;overflow:auto;opacity:0.01';
    document.body.append(host);
    const md = new StreamingMarkdown(host);
    const offsets = [];
    for (let i = 0, line = 0; i < t.length; i++) if (t[i] === '\n') { line++; offsets[line] = i + 1; }
    const out = {};
    for (const lines of list) {
      let pos = offsets[lines] || t.length;
      md.update(t.slice(0, pos));
      void host.scrollHeight;
      await new Promise((r) => requestAnimationFrame(r));
      // Timed as one batch: WebKit's clock has 1 ms resolution, too coarse for a single update.
      const a = performance.now();
      for (let k = 0; k < 40; k++) {
        pos = Math.min(t.length, pos + 28);
        md.update(t.slice(0, pos));
        void host.scrollHeight;
      }
      out[lines] = { mean: (performance.now() - a) / 40 };
    }
    host.remove();
    StreamingMarkdown.chunkLines = saved;
    return out;
  }, { text, sizes, chunkLines });
}

const median = (a) => pct(a, 0.5);
/** Median and p95 of the first, middle and last fifth of the updates, in the order they happened. */
function fifths(times) {
  const n = times.length;
  const part = (i) => times.slice(Math.floor((n * i) / 5), Math.floor((n * (i + 1)) / 5));
  // mean: robust to a coarse clock (WebKit rounds performance.now() to 1 ms); median and p95 as measured.
  const stat = (a) => ({ mean: +(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(3), median: +median(a).toFixed(2), p95: +pct(a, 0.95).toFixed(2) });
  return { updates: n, first: stat(part(0)), middle: stat(part(2)), last: stat(part(4)), p95: +pct(times, 0.95).toFixed(2) };
}

test('perf: a 2,000-line code block renders once and streams in O(delta) per frame', async () => {
  const stack = await startStack();
  const big = codeBlock(2000);
  const { data } = await stack.api('POST', '/api/chats/import', { title: 'Big file', messages: [{ role: 'user', content: 'Show me the file' }, { role: 'assistant', content: `Here it is:\n\n${big}\n\nDone.` }] });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await startRecording(page);
    const t0 = await page.evaluate((cid) => { const t = performance.now(); location.hash = `#/chat/${cid}`; return t; }, data.chats[0].id);
    await page.waitForFunction(() => document.querySelector('.code-block code'));
    const open = await page.evaluate((start) => new Promise((r) => requestAnimationFrame(() => r(performance.now() - start))), t0);
    await page.waitForFunction(() => document.querySelector('.code-block code.hljs'), null, { timeout: 10000 });
    const highlighted = await page.evaluate((start) => performance.now() - start, t0);
    const openRec = await stopRecording(page);
    const lines = await page.evaluate(() => document.querySelector('.code-block code').textContent.split('\n').length);

    const s = await streamInPage(page, `Here it is:\n\n${big}\n\nDone.`, null);
    const f = fifths(s.times);
    const report = { codeLines: lines, open: ms(open), highlightedAfter: ms(highlighted), openLongestTask: ms(Math.max(0, ...openRec.long)), streamTotal: ms(s.total), updates: f, finalRenderWithHighlight: ms(s.finish) };
    console.log('PERF 2000-line code', JSON.stringify(report));
    assert.ok(lines >= 2000);
    // O(delta): the last updates (2,000 lines already on screen) cost about what the first ones did. A ceiling
    // stays as a backstop, generous enough for a slow or busy machine.
    assert.ok(f.last.mean <= f.first.mean * 3 + 0.5, `updates grow with the block: first fifth ${f.first.mean} ms, last fifth ${f.last.mean} ms per update`);
    assert.ok(f.p95 < 40, `streaming update p95 ${f.p95} ms`);
    assert.ok(open < 4000, `opening took ${open} ms`);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('perf: one streamed update costs the same whether the open code block has 250 or 4,000 lines', async () => {
  const stack = await startStack();
  const app = await openApp(stack);
  try {
    const { page } = app;
    const text = `Here it is:\n\n${codeBlock(4400)}\n\nDone.`; // the block stays open past line 4,000
    const sizes = [250, 1000, 2000, 4000];
    // The app's renderer (code in chunks of lines) and, for comparison, one text node for the whole block.
    const chunked = await costBySize(page, text, sizes, null);
    const single = await costBySize(page, text, sizes, 0);
    const r = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, `${v.mean.toFixed(3)} ms`]));
    console.log('PERF update cost by block size (mean of 40 updates)', JSON.stringify({ chunked: r(chunked), singleTextNode: r(single) }));
    // Whole streams of a 500- and a 2,000-line block, both strategies (first / middle / last fifth).
    const full = {};
    for (const n of [500, 2000]) {
      const t = `Intro\n\n${codeBlock(n)}\n\nDone.`;
      const a = await streamInPage(page, t, null);
      const b = await streamInPage(page, t, 0);
      full[n] = { chunked: { ...fifths(a.times), height: a.streamedHeight }, singleTextNode: { ...fifths(b.times), height: b.streamedHeight } };
      assert.equal(a.streamedHeight, b.streamedHeight, 'chunks render exactly like one block');
    }
    console.log('PERF streaming by fifths', JSON.stringify(full));
    const small = chunked[250].mean;
    const large = chunked[4000].mean;
    assert.ok(large <= small * 3 + 0.5, `an update at 4,000 lines (${large.toFixed(3)} ms) costs much more than at 250 (${small.toFixed(3)} ms)`);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});
