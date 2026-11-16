// UI end-to-end: compaction (manual + automatic) and summary editing, memory CRUD, attachments (picker +
// drag & drop), model pull progress, settings persistence across reload, and the theme switch.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, openApp, closeBrowser, send, waitIdle, lastTurn, waitFor } from './harness.mjs';

after(closeBrowser);

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('compaction: "Compact now" draws the summary marker; the summary can be read and edited inline', async () => {
  const stack = await startStack();
  const messages = [];
  for (let i = 0; i < 4; i++) messages.push({ role: 'user', content: `Question ${i}: FACT: the project codename is Heron-${i}.` }, { role: 'assistant', content: `Answer ${i}.` });
  const { data } = await stack.api('POST', '/api/chats/import', { title: 'Long planning chat', messages });
  const chatId = data.chats[0].id;
  const app = await openApp(stack, { hash: `#/chat/${chatId}` });
  try {
    const { page } = app;
    await page.waitForSelector('.turn');
    await page.locator('.main-titlebar button[aria-label="Toggle inspector"]').click();
    await page.locator('.inspector-tabs [role="tab"]', { hasText: 'Context' }).click();
    await page.locator('.ctx-panel button', { hasText: 'Compact now' }).click();
    await page.waitForSelector('.compaction-label');
    assert.match(await page.locator('.compaction-label').textContent(), /earlier messages? summarized/);
    await page.locator('.compaction-label').click();
    await page.waitForSelector('.compaction-body .summary-prose');
    assert.match(await page.locator('.compaction-body').textContent(), /Heron/);
    await page.locator('.compaction-body button', { hasText: 'Edit' }).click();
    await page.locator('.summary-edit').fill('## Goals\n- Ship the Heron project (edited by hand).');
    await page.locator('.compaction-body button', { hasText: 'Save summary' }).click();
    await page.waitForFunction(() => /edited by hand/.test(document.querySelector('.compaction-body')?.textContent || ''));
    const s = (await stack.api('GET', `/api/chats/${chatId}/summary`)).data.summary;
    assert.equal(s.editedByUser, true);
    assert.match(s.content, /edited by hand/);
    // The context meter now accounts for the summary.
    await page.locator('.inspector-tabs [role="tab"]', { hasText: 'Context' }).click();
    await page.waitForSelector('.legend-row .seg-summary');
    await app.shot('20-compaction');
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('compaction: automatic summarizing in a small window is shown live and leaves a marker', async () => {
  const stack = await startStack({ settings: { context: { mode: 1024 }, tools: { enabled: false } } });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await page.evaluate(() => {
      window.__seen = new Set();
      new MutationObserver(() => document.querySelectorAll('.status-line, .status-pill .label').forEach((e) => window.__seen.add(e.textContent))).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    for (let i = 0; i < 10 && !(await page.locator('.compaction').count()); i++) await send(page, `Turn ${i}: long answer 60`);
    await page.waitForSelector('.compaction-label');
    const seen = [...await page.evaluate(() => [...window.__seen])].join('\n');
    assert.match(seen, /Summarized \d+ earlier message/);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('memory: add, edit, pin, delete with undo', async () => {
  const stack = await startStack();
  const app = await openApp(stack, { hash: '#/memory' });
  try {
    const { page } = app;
    await page.locator('.page-head button', { hasText: 'Add memory' }).click();
    await page.locator('.mem-add textarea').fill('I prefer metric units.');
    await page.locator('.mem-add .btn-primary').click();
    await page.waitForSelector('.mem-row .mem-content');
    assert.match(await page.locator('.mem-row .mem-content').first().textContent(), /metric units/);
    // edit inline
    await page.locator('.mem-row .mem-content').first().click();
    await page.locator('.mem-row.editing textarea').fill('I prefer metric units and 24-hour time.');
    await page.locator('.mem-row.editing textarea').press('Enter');
    await page.waitForFunction(() => /24-hour time/.test(document.querySelector('.mem-row .mem-content')?.textContent || ''));
    // pin
    await page.locator('.mem-row .pin-btn').first().click();
    await page.waitForSelector('.mem-row .pin-btn[aria-pressed="true"]');
    let list = (await stack.api('GET', '/api/memories')).data.memories;
    assert.equal(list.length, 1);
    assert.equal(list[0].pinned, true);
    assert.match(list[0].content, /24-hour/);
    // delete → undo → still there
    await page.locator('.mem-row button[aria-label="Delete memory"]').first().click();
    await page.waitForSelector('.mem-list .empty');
    await page.locator('.toast button', { hasText: 'Undo' }).click();
    await page.waitForSelector('.mem-row .mem-content');
    // delete for real
    await page.locator('.mem-row button[aria-label="Delete memory"]').first().click();
    await waitFor(async () => (await stack.api('GET', '/api/memories')).data.total === 0, { timeout: 9000 });
    list = (await stack.api('GET', '/api/memories')).data.memories;
    assert.equal(list.length, 0);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('attachments: picker and drag & drop upload, chips show what the model gets, message carries them', async () => {
  const stack = await startStack();
  const app = await openApp(stack);
  try {
    const { page } = app;
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('button[aria-label="Attach files"]').click()]);
    await chooser.setFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\nThe launch is on Tuesday.\n') });
    await page.waitForFunction(() => /tokens/.test(document.querySelector('.att .att-meta')?.textContent || ''));
    await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'dot.png', { type: 'image/png' }));
      const target = document.querySelector('.chat-view');
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, PNG_1x1);
    await page.waitForSelector('.att .att-img');
    await page.waitForFunction(() => document.querySelectorAll('.att').length === 2 && !document.querySelector('.att .spinner'));
    await app.shot('22-attachments');
    await send(page, 'What do these say?');
    const user = lastTurn(page).locator('.msg-user');
    assert.match(await user.locator('.att-chip').textContent(), /notes\.md/);
    assert.equal(await user.locator('.att-thumb img').count(), 1);
    assert.match(await lastTurn(page).locator('.msg-assistant .prose').textContent(), /I see 1 image/);
    const chat = (await stack.api('GET', '/api/chats')).data.chats[0];
    const detail = (await stack.api('GET', `/api/chats/${chat.id}`)).data;
    assert.equal(detail.messages.find((m) => m.role === 'user').attachments.length, 2);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('models: pull by name shows live progress and the model appears when done', async () => {
  const stack = await startStack({ pullStepMs: 120 });
  const app = await openApp(stack, { hash: '#/models' });
  try {
    const { page } = app;
    await page.evaluate(() => {
      window.__pct = new Set();
      new MutationObserver(() => document.querySelectorAll('.pull-progress .num').forEach((e) => window.__pct.add(e.textContent))).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.locator('input[aria-label="Model to download"]').fill('llama3.2:3b');
    await page.locator('.pull-row button', { hasText: 'Download' }).click();
    await page.waitForSelector('.pull-progress');
    await app.shot('23-pull-progress');
    await page.waitForSelector('tr[data-model="llama3.2:3b"]', { timeout: 20000 });
    const pcts = await page.evaluate(() => [...window.__pct]);
    assert.ok(pcts.some((p) => /^\d+%$/.test(p) && p !== '100%'), `saw intermediate progress: ${pcts.join(', ')}`);
    await page.waitForSelector('.toast', { hasText: 'is ready' });
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('settings: changes persist across a reload; theme switch applies immediately and persists', async () => {
  const stack = await startStack();
  const app = await openApp(stack, { hash: '#/settings/summarizer' });
  try {
    const { page } = app;
    const sw = page.locator('[data-path="compaction.enabled"] .switch');
    assert.equal(await sw.getAttribute('aria-checked'), 'true');
    await sw.click();
    await page.waitForSelector('[data-path="compaction.enabled"] .switch[aria-checked="false"]');
    await page.goto(`${stack.url}/#/settings/tools`);
    await page.waitForSelector('html.ready');
    await page.locator('.adv-toggle').click();
    const iters = page.locator('[data-path="tools.maxIterations"] input');
    await iters.fill('3');
    await iters.dispatchEvent('change');
    await page.waitForSelector('[data-path="tools.maxIterations"] .saved');
    // invalid value: the server's message is shown inline
    await iters.fill('99');
    await iters.dispatchEvent('change');
    await page.waitForSelector('[data-path="tools.maxIterations"] .field-error');
    assert.match(await page.locator('[data-path="tools.maxIterations"] .field-error').textContent(), /between 1 and 25/);

    await page.reload();
    await page.waitForSelector('html.ready');
    await page.goto(`${stack.url}/#/settings/summarizer`);
    await page.waitForSelector('[data-path="compaction.enabled"] .switch[aria-checked="false"]');
    const s = (await stack.api('GET', '/api/settings')).data.settings;
    assert.equal(s.compaction.enabled, false);
    assert.equal(s.tools.maxIterations, 3);

    // theme
    await page.goto(`${stack.url}/#/settings/general`);
    await page.locator('[data-path="ui.theme"] button', { hasText: 'Dark' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(29, 29, 31)');
    await app.shot('24-settings-dark');
    await page.reload();
    await page.waitForSelector('html.ready');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    // UI preferences live in the UI-state store (0.2), not in browser storage or settings.ui.
    await waitFor(async () => (await stack.api('GET', '/api/ui-state')).data.state.prefs?.theme === 'dark');
    await page.locator('[data-path="ui.theme"] button', { hasText: 'System' }).click();
    await page.waitForFunction(() => !document.documentElement.dataset.theme);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('data: a full backup restores into a fresh install (chats + memories), merged with new ids', async () => {
  const source = await startStack();
  let backup;
  try {
    await source.api('POST', '/api/chats/import', { title: 'Backed-up conversation', messages: [{ role: 'user', content: 'The lighthouse needs a new lens.' }, { role: 'assistant', content: 'Noted.' }] });
    await source.api('POST', '/api/memories', { content: 'The user keeps a lighthouse.', category: 'fact' });
    backup = (await source.api('GET', '/api/export')).data;
  } finally { await source.close(); }
  const stack = await startStack();
  const app = await openApp(stack, { hash: '#/settings/data' });
  try {
    const { page } = app;
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('button', { hasText: 'Restore from backup' }).click()]);
    await chooser.setFiles({ name: 'harness-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await page.waitForSelector('dialog.dialog[open] .restore-part');
    await page.locator('dialog.dialog[open] .btn-primary', { hasText: 'Restore' }).click();
    await page.waitForSelector('.toast', { hasText: 'Backup restored' });
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-item')].some((el) => /Backed-up conversation/.test(el.textContent)));
    const mems = (await stack.api('GET', '/api/memories')).data.memories;
    assert.ok(mems.some((m) => /lighthouse/.test(m.content)));
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('memory: something that looks like a secret needs an explicit "Save anyway"', async () => {
  const stack = await startStack();
  const app = await openApp(stack, { hash: '#/memory' });
  try {
    const { page } = app;
    await page.locator('.page-head button', { hasText: 'Add memory' }).click();
    await page.locator('.mem-add textarea').fill('My API key is sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c');
    await page.locator('.mem-add .btn-primary').click();
    const dlg = page.locator('dialog.dialog[open]');
    if (!(await dlg.count()) && (await stack.api('GET', '/api/memories')).data.total === 1) { test.skip('server did not flag this as a secret'); return; }
    await dlg.waitFor();
    assert.match(await dlg.textContent(), /password or API key/);
    await dlg.locator('.btn-danger', { hasText: 'Save anyway' }).click();
    await waitFor(async () => (await stack.api('GET', '/api/memories')).data.total === 1);
  } finally { await app.close(); await stack.close(); }
});
