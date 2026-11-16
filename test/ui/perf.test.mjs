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

    // Stream the same text through the app's streaming renderer, ~7 characters per token, 4 tokens per frame
    // (≈ 240 tokens/s: far faster than an 8 GB Mac produces, so this is a worst case), with layout each frame.
    const stream = await page.evaluate(async (text) => {
      const { StreamingMarkdown } = await import('/js/lib/markdown.js');
      const host = document.createElement('div');
      host.className = 'prose';
      host.style.cssText = 'position:fixed;left:0;top:0;width:700px;height:600px;overflow:auto;opacity:0.01';
      document.body.append(host);
      const md = new StreamingMarkdown(host);
      const times = [];
      let pos = 0;
      const t = performance.now();
      while (pos < text.length) {
        pos = Math.min(text.length, pos + 28);
        const a = performance.now();
        md.update(text.slice(0, pos));
        void host.scrollHeight; // include layout
        times.push(performance.now() - a);
        if (times.length % 50 === 0) await new Promise((r) => requestAnimationFrame(r));
      }
      const f0 = performance.now();
      md.finish(text);
      void host.scrollHeight;
      const finish = performance.now() - f0;
      host.remove();
      times.sort((x, y) => x - y);
      return { updates: times.length, total: performance.now() - t, p50: times[Math.floor(times.length / 2)], p95: times[Math.floor(times.length * 0.95)], max: times[times.length - 1], finish };
    }, `Here it is:\n\n${big}\n\nDone.`);
    const report = { codeLines: lines, open: ms(open), highlightedAfter: ms(highlighted), openLongestTask: ms(Math.max(0, ...openRec.long)), streamUpdates: stream.updates, streamTotal: ms(stream.total), updateP50: `${stream.p50.toFixed(2)} ms`, updateP95: `${stream.p95.toFixed(2)} ms`, updateMax: ms(stream.max), finalRenderWithHighlight: ms(stream.finish) };
    console.log('PERF 2000-line code', JSON.stringify(report));
    assert.ok(lines >= 2000);
    assert.ok(stream.p95 < 8, `streaming update p95 ${stream.p95} ms — should not grow with the block`);
    assert.ok(open < 4000, `opening took ${open} ms`);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});
