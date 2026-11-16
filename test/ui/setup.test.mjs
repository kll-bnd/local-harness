// UI end-to-end: first run. No model installed → the setup page recommends one that fits and downloads it
// with progress; Ollama installed but stopped → "Start Ollama".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, openApp, closeBrowser } from './harness.mjs';

after(closeBrowser);

test('first run without models: setup recommends a model for 8 GB and downloads it', async () => {
  const stack = await startStack({ ram: 8, models: {}, pullStepMs: 40 });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await page.waitForFunction(() => location.hash === '#/setup');
    await page.waitForSelector('.rec-card');
    const body = await page.locator('.setup-page').textContent();
    assert.match(body, /No chat model installed yet/);
    assert.match(body, /8 GB/);
    assert.match(body, /Tuned for 8 GB/);
    // Nemotron is first; on 8 GB its default quant is flagged as too large and a smaller one is the best fit.
    const nemo = page.locator('.rec-card').first();
    assert.match(await nemo.locator('h3').textContent(), /Nemotron/);
    assert.match(await nemo.locator('.variant.suggested').textContent(), /best fit/);
    assert.match(await nemo.textContent(), /too large/);
    // The image step points to Draw Things' API server when no image backend runs? (Here one runs.)
    await app.shot('30-setup-first-run');
    await page.locator('.rec-card[data-rec="llama3.2-3b"] .variant button', { hasText: 'Download' }).click();
    await page.waitForSelector('.pull-progress');
    await page.waitForFunction(() => /1 chat model installed/.test(document.querySelector('.setup-page')?.textContent || ''), null, { timeout: 20000 });
    await page.locator('.page-head button', { hasText: 'Start chatting' }).click();
    await page.waitForFunction(() => location.hash === '#/chat');
    await page.waitForFunction(() => /llama3\.2/i.test(document.querySelector('.intro-model')?.textContent || ''));
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('Ollama installed but stopped: setup offers "Start Ollama" and the app comes alive', async () => {
  const stack = await startStack({ ollama: false, ollamaBinary: true, image: false });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await page.waitForFunction(() => location.hash === '#/setup');
    await page.waitForSelector('.setup-step button', { hasText: 'Start Ollama' });
    assert.match(await page.locator('.setup-page').textContent(), /installed but not running/);
    assert.match(await page.locator('.setup-page').textContent(), /Draw Things/);
    await page.locator('.setup-step button', { hasText: 'Start Ollama' }).click();
    await page.waitForFunction(() => /Ollama .*is running/.test(document.querySelector('.setup-page')?.textContent || ''), null, { timeout: 20000 });
    await page.waitForFunction(() => /chat models? installed/.test(document.querySelector('.setup-page')?.textContent || ''), null, { timeout: 20000 });
    assert.match(await page.locator('.side-foot .machine').textContent(), /Ollama/);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});
