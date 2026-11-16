// UI end-to-end: image generation from a chat tool call on an 8 GB machine (unload → generate → reload made
// visible), and the image studio (direct generation, progress, gallery, reuse, delete, cancel).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, openApp, closeBrowser, send, waitIdle, lastTurn, waitFor } from './harness.mjs';

after(closeBrowser);

/** Record every status text the UI shows (phases can be brief; this proves they were rendered). */
async function recordStatuses(page) {
  await page.evaluate(() => {
    window.__seen = new Set();
    const grab = () => document.querySelectorAll('.job-steps li, .status-line, .main-titlebar .status-pill .label, .side-foot .machine').forEach((e) => window.__seen.add(e.textContent.trim()));
    new MutationObserver(grab).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

test('chat image at 8 GB: unload → generate → reload is shown, image renders inline with a lightbox', async () => {
  const stack = await startStack({ ram: 8, stepMs: 250 });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await recordStatuses(page);
    await send(page, 'draw a red fox curled up in the snow', { wait: false });
    await page.waitForSelector('.tool-card.tool-image');
    await page.waitForSelector('.image-job .job-steps li.active');
    await app.shot('10-image-generating');
    await waitIdle(page, 30000);
    const seen = [...await page.evaluate(() => [...window.__seen])].join('\n');
    assert.match(seen, /Unload nemotron/i, 'unload step shown');
    assert.match(seen, /Generate/, 'generate step shown');
    const turn = lastTurn(page);
    assert.match(await turn.locator('.turn-status').textContent(), /Unloaded nemotron-3\.5-bolt:e4b to free memory/);
    assert.match(await turn.locator('.turn-status').textContent(), /Reloaded the chat model/);
    const img = turn.locator('.tool-card .gen-img img');
    assert.match(await img.getAttribute('src'), /^\/api\/images\/img_[\w]+\/file$/);
    assert.ok(stack.fake.unloads.length >= 1, 'the backend really unloaded the chat model');
    await turn.locator('.tool-card .gen-img').click();
    await page.waitForSelector('dialog.lightbox[open]');
    assert.match(await page.locator('.lb-prompt').textContent(), /red fox/);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog.lightbox', { state: 'detached' });
    await app.shot('11-image-done');
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('studio: generate with settings, watch progress, find it in the gallery, reuse, delete', async () => {
  const stack = await startStack({ stepMs: 120 });
  const app = await openApp(stack, { hash: '#/images' });
  try {
    const { page } = app;
    await page.waitForSelector('.studio-prompt');
    await page.locator('.studio-prompt').fill('a lighthouse at dusk, oil painting');
    await page.locator('.aspect', { hasText: 'Landscape' }).click();
    await page.locator('input[name="steps"]').fill('4');
    await page.locator('input[name="steps"]').dispatchEvent('change');
    await page.locator('input[name="seed"]').fill('42');
    await page.locator('input[name="seed"]').dispatchEvent('change');
    await page.locator('.gen-btn').click();
    await page.waitForSelector('.studio-progress .progress');
    await app.shot('12-studio-progress');
    await page.waitForSelector('.studio-progress .gen-img img', { timeout: 20000 });
    assert.match(await page.locator('.studio-progress').textContent(), /Done in/);
    await page.waitForSelector('.g-item');
    assert.match(await page.locator('.g-item figcaption').first().textContent(), /lighthouse at dusk/);
    const { data } = await stack.api('GET', '/api/images');
    assert.equal(data.total, 1);
    const rec = data.images[0];
    assert.equal(rec.seed, 42);
    assert.equal(rec.params.steps, 4);
    assert.ok(rec.width > rec.height, 'landscape');

    // Reuse settings from the gallery into a cleared form.
    await page.locator('.studio-prompt').fill('');
    await page.locator('.g-thumb').first().click();
    await page.waitForSelector('dialog.lightbox[open]');
    await page.locator('.lb-actions button', { hasText: 'Reuse settings' }).click();
    await page.waitForFunction(() => /lighthouse at dusk/.test(document.querySelector('.studio-prompt')?.value || ''));
    assert.equal(await page.locator('input[name="seed"]').inputValue(), '42');

    // Delete from the lightbox.
    await page.locator('.g-thumb').first().click();
    await page.locator('.lb-actions button', { hasText: 'Delete' }).click();
    await page.locator('dialog.dialog[open] .btn-danger').click();
    await page.waitForSelector('.gallery .empty');
    assert.equal((await stack.api('GET', '/api/images')).data.total, 0);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('studio: a running generation can be cancelled', async () => {
  const stack = await startStack({ stepMs: 400 });
  const app = await openApp(stack, { hash: '#/images' });
  try {
    const { page } = app;
    await page.locator('.studio-prompt').fill('a very slow cathedral');
    await page.locator('input[name="steps"]').fill('30');
    await page.locator('input[name="steps"]').dispatchEvent('change');
    await page.locator('.gen-btn').click();
    await page.waitForSelector('.studio-progress .job-steps li.active');
    await page.locator('.studio-actions button', { hasText: 'Cancel' }).click();
    await page.waitForFunction(() => /Cancelled/.test(document.querySelector('.studio-progress')?.textContent || ''), null, { timeout: 15000 });
    await waitFor(async () => (await stack.api('GET', '/api/images/jobs')).data.jobs.some((j) => j.status === 'aborted'));
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});
