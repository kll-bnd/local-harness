// UI end-to-end for the model catalogue (docs/API.md 10.8) against the real backend reading fake copies of
// Hugging Face and ollama.com (fake-catalog.mjs): browsing both sources without typing (sorts, kind, fits this Mac,
// size, publisher, search) with endless scrolling, the in-place "Allow internet" prompt while blocked, a model page
// with its card (remote pictures blocked), and download-and-set-up on an 8 GB Mac (text-only copy).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, openApp, closeBrowser, waitFor } from './harness.mjs';

after(closeBrowser);

const PASSWORD = 'violet anchor maple drum';
const NEMOTRON = 'unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF';

const items = (page) => page.locator('.cat-browser:visible .cat-item');
const listState = (page) => page.evaluate(() => [...document.querySelectorAll('.cat-browser .cat-item')].filter((e) => e.offsetParent).map((e) => ({
  id: e.dataset.id, fits: e.dataset.fits, text: e.textContent,
})));
/** Wait for a fresh list after a filter change (the loading row disappears and rows are there). */
async function settled(page) {
  await page.waitForFunction(() => !document.querySelector('.cat-browser .cat-loading') && document.querySelectorAll('.cat-browser .cat-item, .cat-browser .empty').length > 0);
}

test('browsing while internet access is blocked: allow in place, then both sources with filters and endless scrolling', async () => {
  const stack = await startStack({ secure: true, catalog: true, ram: 16 });
  const app = await openApp(stack);
  try {
    const { page } = app;
    // Set up, then go to Models → Hugging Face.
    await page.waitForSelector('.gate input[name="password"]');
    await page.fill('.gate input[name="password"]', PASSWORD);
    await page.fill('.gate input[name="password2"]', PASSWORD);
    await page.click('.gate-form button[type="submit"]');
    await page.waitForSelector('.rk-key');
    await page.check('.rk-confirm input');
    await page.click('.gate-actions .btn-primary');
    await page.waitForSelector('.app .sidebar');
    await page.goto(`${stack.url}/#/models`);
    // Installed + recommended work while blocked ("On this Mac").
    await page.waitForSelector('.models-body .rec-card');
    await page.locator('.models-tabs a', { hasText: 'Hugging Face' }).click();
    // Not an error: the allow prompt in place.
    await page.waitForSelector('.cat-browser .allow-panel');
    assert.match(await page.locator('.allow-panel').textContent(), /needs the internet/);
    assert.equal(await page.locator('.cat-foot .callout').count(), 0);
    await page.locator('.allow-panel button', { hasText: 'Allow internet for 15 minutes' }).click();
    await page.fill('dialog.confirm-pw input[type="password"]', PASSWORD);
    await page.locator('dialog.confirm-pw .dialog-actions .btn-primary').click();
    // The list loads by itself once allowed.
    await page.waitForSelector('.cat-browser[data-source="huggingface"] .cat-item');
    assert.equal(await items(page).count(), 24);
    // Not a chat model (text-to-video) is never listed.
    assert.ok(!(await listState(page)).some((x) => /Wan2/.test(x.id)));
    // Fit at a glance on every row; what does not fit is dimmed, not hidden.
    const rows = await listState(page);
    assert.ok(rows.some((r) => r.fits === 'true') && rows.some((r) => r.fits === 'false'));
    assert.ok(await page.locator('.cat-item.unfit').count() > 0);
    await app.shot('40-catalogue-hf');

    // Endless scrolling by cursor.
    await page.locator('.view-scroll').evaluate((e) => { e.scrollTop = e.scrollHeight; });
    await waitFor(async () => (await items(page).count()) > 24, { timeout: 20000 });
    await page.locator('.view-scroll').evaluate((e) => { e.scrollTop = e.scrollHeight; });
    await page.waitForSelector('.cat-end', { timeout: 10000 });
    assert.equal(await items(page).count(), 60, 'every chat-capable repository, no duplicates');

    // Sort: most downloaded first.
    await page.locator('.cat-seg button', { hasText: 'Most downloaded' }).click();
    await settled(page);
    const dl = await page.evaluate(() => [...document.querySelectorAll('.cat-browser .cat-item .cat-meta')].slice(0, 5).map((e) => e.textContent));
    assert.match(dl[0], /812K downloads/);
    // Kind: vision only.
    await page.locator('.cat-seg button', { hasText: 'Vision' }).click();
    await settled(page);
    for (const r of await listState(page)) assert.match(r.text, /vision/);
    // Fits this Mac.
    await page.locator('.cat-fits').click();
    await settled(page);
    const fitting = await listState(page);
    assert.ok(fitting.length > 0 && fitting.every((r) => r.fits === 'true'));
    // Size + publisher (Hugging Face only) and search as one more filter.
    await page.locator('.cat-fits').click();
    await page.locator('.cat-seg button', { hasText: 'All' }).click();
    await settled(page);
    await page.selectOption('.cat-size', '0-3');
    await settled(page);
    // Up to 3B: millions of parameters or at most 3B.
    assert.ok((await listState(page)).every((r) => /(\d+M|[0-2](\.\d+)?B|3B) parameters/.test(r.text)), JSON.stringify((await listState(page)).map((r) => r.text)));
    await page.selectOption('.cat-size', '');
    await page.fill('.cat-pub', 'bartowski');
    await page.waitForFunction(() => [...document.querySelectorAll('.cat-browser .cat-item')].every((e) => e.querySelector('.cat-pub-name')?.textContent === 'bartowski') && document.querySelectorAll('.cat-browser .cat-item').length > 0);
    await page.fill('.cat-pub', '');
    await page.fill('.cat-search', 'qwen');
    await page.waitForFunction(() => { const it = [...document.querySelectorAll('.cat-browser[data-source="huggingface"] .cat-item')]; return it.length > 0 && it.every((e) => /qwen/i.test(e.dataset.id)); });

    // The Ollama library: popular / newest, kind, endless scrolling.
    await page.locator('.models-tabs a', { hasText: 'Ollama library' }).click();
    await page.waitForSelector('.cat-browser[data-source="ollama"] .cat-item');
    assert.equal(await page.locator('.cat-browser[data-source="ollama"] .cat-seg button').first().textContent(), 'Popular');
    assert.equal(await page.locator('.cat-browser[data-source="ollama"] .cat-pub').count(), 0, 'publisher is a Hugging Face filter');
    // The site's own pages (20 per page), followed by cursor as the list scrolls.
    assert.equal(await page.locator('.cat-browser[data-source="ollama"] .cat-item').count(), 20);
    await page.locator('.view-scroll').evaluate((e) => { e.scrollTop = e.scrollHeight; });
    await waitFor(async () => (await page.locator('.cat-browser[data-source="ollama"] .cat-item').count()) > 20, { timeout: 20000 });
    // Cloud-only entries are not offered.
    assert.equal(await page.locator('.cat-browser[data-source="ollama"] .cat-item[data-id="kimi-k2"]').count(), 0);
    await page.locator('.cat-browser[data-source="ollama"] .cat-seg button', { hasText: 'Embedding' }).click();
    await page.waitForFunction(() => { const it = [...document.querySelectorAll('.cat-browser[data-source="ollama"] .cat-item')]; return it.length === 1 && it[0].dataset.id === 'nomic-embed-text'; });
    await page.locator('.cat-browser[data-source="ollama"] .cat-seg button', { hasText: 'Newest' }).click();
    await page.locator('.cat-browser[data-source="ollama"] .cat-seg button', { hasText: 'All' }).click();
    await page.waitForFunction(() => document.querySelector('.cat-browser[data-source="ollama"] .cat-item')?.dataset.id === 'community-model-0');
    await app.shot('41-catalogue-ollama');
    // Going back to Hugging Face keeps its list and filters.
    await page.locator('.models-tabs a', { hasText: 'Hugging Face' }).click();
    assert.equal(await page.locator('.cat-browser[data-source="huggingface"] .cat-search').inputValue(), 'qwen');
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('a model page: description, numbers, every file with its fit, and the card with remote pictures blocked', async () => {
  const stack = await startStack({ catalog: true, ram: 8, models: {} });
  const app = await openApp(stack, { hash: '#/models/huggingface' });
  try {
    const { page } = app;
    await page.waitForSelector(`.cat-item[data-id="${NEMOTRON}"]`);
    await page.locator(`.cat-item[data-id="${NEMOTRON}"]`).click();
    await page.waitForSelector('.model-head');
    assert.match(page.url(), /#\/models\/huggingface\/unsloth\/NVIDIA-Nemotron-3\.5-Bolt-E4B-GGUF$/);
    // "Will this run on my Mac?" at a glance.
    assert.match(await page.locator('.glance').textContent(), /Runs on this Mac: .+ as a text-only copy/);
    const kv = await page.locator('.model-kv').textContent();
    assert.match(kv, /7\.5B/);
    assert.match(kv, /apache-2\.0/);
    assert.match(kv, /128K/);
    // Files: sizes, fit, the recommended one highlighted, the one the registry does not serve marked.
    const rows = page.locator('.files-table tbody tr');
    assert.equal(await rows.count(), 5);
    assert.equal(await page.locator('.files-table tr.recommended').count(), 1);
    assert.match(await page.locator('.files-table tr[data-tag="Q8_0"]').textContent(), /Not downloadable/);
    assert.ok(await page.locator('.files-table tr.unfit').count() >= 1);
    assert.match(await page.locator('.files-table tr.unfit .dl-anyway').first().textContent(), /Download anyway/);
    // The card: markdown rendered with the sanitizer; remote pictures become quiet placeholders; no script runs.
    const card = page.locator('.model-card');
    await card.waitFor();
    assert.equal(await card.locator('h2', { hasText: 'How to run' }).count(), 1);
    assert.equal(await card.locator('.code-block').count(), 1);
    assert.equal(await card.locator('table').count(), 1);
    assert.equal(await card.locator('img').count(), 0);
    assert.equal(await card.locator('.img-placeholder').count(), 2);
    assert.equal(await card.locator('script').count(), 0);
    assert.equal(await card.locator('a', { hasText: 'our license' }).getAttribute('href'), null, 'relative links go nowhere');
    const ext = card.locator('a', { hasText: 'the release notes' });
    assert.equal(await ext.getAttribute('target'), '_blank');
    assert.equal(await ext.getAttribute('rel'), 'noopener noreferrer');
    const requested = app.requests.filter((u) => !u.startsWith(stack.url));
    assert.deepEqual(requested, [], 'the page itself never contacts another site');
    await app.shot('42-model-page');

    // An Ollama library model page from its list.
    await page.goto(`${stack.url}/#/models/ollama/qwen3`);
    await page.waitForFunction(() => /qwen3/.test(document.querySelector('.model-title')?.textContent || ''));
    assert.ok(await page.locator('.files-table tbody tr').count() >= 5);
    assert.match(await page.locator('.model-card').textContent(), /runs locally with Ollama/);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('8 GB Mac: download and set up from the catalogue makes the text-only copy and the default model', async () => {
  const stack = await startStack({ catalog: true, ram: 8, models: {}, pullStepMs: 30 });
  const app = await openApp(stack, { hash: `#/models/huggingface/${NEMOTRON}` });
  try {
    const { page } = app;
    await page.waitForSelector('.glance.ok');
    const btn = page.locator('.glance button', { hasText: 'Download and set up' });
    const model = await btn.getAttribute('data-model');
    await btn.click();
    await page.waitForSelector('.glance .pull-progress, .glance .badge');
    // Downloaded, made into a text-only copy, and chosen as the default.
    await waitFor(async () => {
      const r = (await stack.api('GET', '/api/models')).data;
      return r.models.some((m) => /-text:/.test(m.model)) && /-text:/.test(r.defaultModel?.model || '');
    }, { timeout: 20000 });
    await page.waitForFunction(() => /is ready/.test(document.querySelector('.toasts')?.textContent || ''));
    assert.match(await page.locator('.toasts').textContent(), /text-only copy/);
    // Back on the page the file is now installed.
    await page.reload();
    await page.waitForSelector(`.files-table tr[data-tag="${model.split(':').pop()}"] .badge`, { timeout: 10000 });
    assert.match(await page.locator(`.files-table tr[data-tag="${model.split(':').pop()}"]`).textContent(), /installed/);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});
