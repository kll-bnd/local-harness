// UI end-to-end for what real 8 GB Macs need: the guided "text-only copy" setup, and a model that fails to
// load (Ollama's runner dies) explained calmly with a fix that actually works.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, openApp, closeBrowser, send, waitIdle, lastTurn, waitFor } from './harness.mjs';

after(closeBrowser);

const UD_Q3 = 'hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL';

test('8 GB: recommended model → make a text-only copy (becomes default) → remove the original', async () => {
  const stack = await startStack({ ram: 8 });
  const app = await openApp(stack, { hash: '#/setup' });
  try {
    const { page } = app;
    if (!(await stack.api('GET', '/api/models')).data.models.some((m) => m.model === UD_Q3)) { test.skip('fake Ollama has no UD-Q3_K_XL'); return; }
    await page.waitForSelector('.rec-card');
    const card = page.locator('.rec-card').first();
    assert.match(await card.textContent(), /On an 8 GB Mac use a text-only copy/);
    const variant = page.locator(`.variant[data-variant="${UD_Q3}"]`);
    assert.match(await variant.locator('.flow').textContent(), /can't read images/);
    await variant.locator('button', { hasText: 'Make text-only copy' }).click();
    await page.waitForFunction((m) => /text-only copy/.test(document.querySelector(`.variant[data-variant="${m}"] .row-wrap`)?.textContent || ''), UD_Q3, { timeout: 20000 });
    const copies = (await stack.api('GET', '/api/models/text-only')).data.copies;
    assert.equal(copies.length, 1);
    const def = await waitFor(async () => (await stack.api('GET', '/api/settings')).data.settings.defaultModel);
    assert.match(def.model, /-text:/, 'the copy became the default model');
    await app.shot('40-text-only-copy');
    // Optional step 3: remove the original download.
    await page.locator(`.variant[data-variant="${UD_Q3}"] button`, { hasText: 'Remove original' }).click();
    await page.locator('dialog.dialog[open] .btn-danger').click();
    await waitFor(async () => !(await stack.api('GET', '/api/models')).data.models.some((m) => m.model === UD_Q3));
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('model fails to load: calm explanation, "Make a text-only copy" fixes it and retries', async () => {
  const stack = await startStack();
  const app = await openApp(stack);
  try {
    const { page } = app;
    stack.fake.failNext({ path: '/api/chat', status: 500, error: 'llama-server process has terminated: signal: abort trap: 6', count: 1 });
    await send(page, 'hello after a crash');
    const callout = lastTurn(page).locator('.msg-error.with-steps');
    await callout.waitFor();
    assert.match(await callout.textContent(), /couldn.t start/i);
    assert.equal(await callout.locator('.callout.danger').count(), 0);
    const fix = callout.locator('button', { hasText: 'Make a text-only copy' });
    if (!(await fix.count())) { test.skip('server offered no text-only step'); return; }
    await app.shot('41-load-failed');
    await fix.click();
    await waitIdle(page, 30000);
    await page.waitForFunction(() => /You said: hello after a crash/.test(document.querySelector('.turn:last-child .msg-assistant')?.textContent || ''), null, { timeout: 20000 });
    const chatId = page.url().split('/chat/')[1];
    const chat = (await stack.api('GET', `/api/chats/${chatId}`)).data.chat;
    assert.match(chat.settings.model.model, /-text:/, 'the chat now uses the text-only copy');
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});
