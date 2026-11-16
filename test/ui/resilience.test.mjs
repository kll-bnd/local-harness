// UI end-to-end: what happens when things go wrong — the server restarts, Ollama stops, or another window is
// already generating in the same chat (409 chat_busy).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, openApp, closeBrowser, send, lastTurn, sleep } from './harness.mjs';

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
    await page.locator('.composer-input').fill('are you still there?');
    await page.locator('.composer-input').press('Enter');
    const t = page.locator('.toast-error');
    await t.waitFor();
    assert.match(await t.textContent(), /isn.t running|isn.t reachable|not running/i);
    assert.equal(await page.locator('.composer-input').inputValue(), 'are you still there?');
  } finally { await app.close(); await stack.close(); }
});

test('busy: a chat already generating elsewhere answers 409 → "still replying" with Stop, nothing lost', async () => {
  const stack = await startStack({ delayMs: 30 });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await send(page, 'first message');
    const chatId = page.url().split('/chat/')[1];
    // Another window starts a long generation in this chat.
    const ac = new AbortController();
    const other = fetch(`${stack.url}/api/chats/${chatId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'long answer 3000' }), signal: ac.signal }).then((r) => r.body?.getReader().read()).catch(() => {});
    await sleep(300);
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
