// UI end-to-end: what happens when things go wrong — the server restarts, Ollama stops, or another window is
// already generating in the same chat (409 chat_busy).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, openApp, closeBrowser, send, lastTurn, waitFor } from './harness.mjs';

after(closeBrowser);

test('reconnect: a server restart shows a banner, then the app resyncs on its own', async () => {
  const stack = await startStack();
  const app = await openApp(stack);
  try {
    const { page } = app;
    await send(page, 'before the restart');
    await stack.stopServer();
    await page.waitForSelector('.conn-banner', { timeout: 15000 });
    assert.match(await page.locator('.conn-banner').textContent(), /Reconnecting/);
    await stack.startServerAgain();
    await page.waitForSelector('.conn-banner', { state: 'detached', timeout: 20000 });
    await send(page, 'after the restart');
    assert.match(await lastTurn(page).locator('.msg-assistant .prose').textContent(), /after the restart/);
    assert.equal(await page.locator('.turn').count(), 2);
  } finally { await app.close(); await stack.close(); }
});

test('errors: Ollama stopping mid-session gives a human message, and the typed text is kept', async () => {
  const stack = await startStack();
  const app = await openApp(stack);
  try {
    const { page } = app;
    await send(page, 'hello');
    await stack.fake.close();
    // Diagnostics for a failure: every toast that appears, and the requests sent from here on.
    await page.evaluate(() => {
      window.__toastLog = [];
      new MutationObserver(() => { for (const x of document.querySelectorAll('.toast')) { const t = `${x.className}: ${x.textContent}`; if (!window.__toastLog.includes(t)) window.__toastLog.push(t); } }).observe(document.body, { childList: true, subtree: true });
    });
    const fromRequest = app.requests.length;
    await page.locator('.composer-input').fill('are you still there?');
    await page.locator('.composer-input').press('Enter');
    const t = page.locator('.toast-error');
    await t.waitFor().catch(async (e) => {
      // Say what the page showed instead (the CI log prints only the failure).
      const seen = await page.evaluate(() => ({
        toasts: window.__toastLog,
        hash: location.hash,
        active: document.activeElement?.className,
        last: document.querySelectorAll('.turn')[document.querySelectorAll('.turn').length - 1]?.textContent.slice(0, 300),
        composer: document.querySelector('.composer-input')?.value,
        sendBtn: document.querySelector('.send-btn')?.outerHTML.slice(0, 200),
      })).catch(() => null);
      throw new Error(`${e.message}\npage: ${JSON.stringify(seen)}\nrequests: ${app.requests.slice(fromRequest).map((u) => u.replace(stack.url, '')).join(' ')}`);
    });
    assert.match(await t.textContent(), /isn.t running|isn.t reachable|not running/i);
    // Nothing typed is lost: either it is back in the composer (failed before the stream started) or it is
    // in the transcript with an inline error and Retry (failed mid-stream).
    await page.waitForFunction(() => document.querySelector('.composer-input').value === 'are you still there?'
      || (/are you still there/.test(document.querySelector('.turn:last-child .msg-user')?.textContent || '') && document.querySelector('.turn:last-child .msg-error button[data-action="regenerate"]')));
  } finally { await app.close(); await stack.close(); }
});

test('busy: a chat already generating elsewhere answers 409 → "still replying" with Stop, nothing lost', async () => {
  const stack = await startStack({ delayMs: 30 });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await send(page, 'first message');
    const chatId = page.url().split('/chat/')[1];
    // Let the server release the first turn.
    await waitFor(async () => !(await stack.api('GET', `/api/chats/${chatId}`)).data.chat?.generating);
    // Another window starts a long generation in this chat.
    const ac = new AbortController();
    let otherStatus = null;
    const other = fetch(`${stack.url}/api/chats/${chatId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'long answer 3000' }), signal: ac.signal })
      .then((r) => { otherStatus = r.status; return r.body?.getReader().read(); }).catch(() => {});
    await waitFor(() => otherStatus === 200);
    assert.equal(otherStatus, 200, 'the other generation is running');
    await page.locator('.composer-input').fill('my second message');
    await page.locator('.composer-input').press('Enter');
    const t = page.locator('.toast', { hasText: 'still replying' });
    await t.waitFor();
    assert.equal(await t.locator('button', { hasText: 'Stop' }).count(), 1);
    assert.equal(await page.locator('.composer-input').inputValue(), 'my second message');
    ac.abort();
    await other;
  } finally { await app.close(); await stack.close(); }
});

test('slow start: "Loading …" / "Reading the conversation…" come from the server\'s model_status with elapsed time', async () => {
  const stack = await startStack({ delayMs: 1800 });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await page.evaluate(() => {
      window.__seen = new Set();
      new MutationObserver(() => document.querySelectorAll('.status-line, .status-hint').forEach((e) => window.__seen.add(e.textContent))).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await send(page, 'hi', { wait: false });
    await page.waitForFunction(() => /You said: hi/.test(document.querySelector('.msg-assistant .prose')?.textContent || ''), null, { timeout: 30000 });
    const seen = (await page.evaluate(() => [...window.__seen])).join('\n');
    assert.match(seen, /(Loading .+|Reading the conversation.*)… \d+ s/, `saw: ${seen}`);
    assert.doesNotMatch(seen, /nemotron-3\.5-bolt:e4b/, 'friendly names, not raw ids');
  } finally { await app.close(); await stack.close(); }
});
