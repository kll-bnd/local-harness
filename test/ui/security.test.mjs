// UI end-to-end for version 0.2 with the protections ON (password, API sessions, "Block all internet access"):
// first-run setup and the recovery key, lock/unlock with the password and the recovery key, the retry delay,
// locking while a reply streams, auto-lock, encrypting 0.1 data, the allow-internet prompt with its automatic
// retry and countdown, password confirmation for sensitive actions, the `lock` menu action, and the rule that
// nothing derived from the user's content is kept in browser storage.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startStack, openApp, closeBrowser, send, waitFor, sleep } from './harness.mjs';

after(closeBrowser);

const PASSWORD = 'violet anchor maple drum';

/** First-run setup through the UI. → the recovery key that was shown. */
async function setupViaUi(page, password = PASSWORD) {
  await page.waitForSelector('.gate input[name="password"]');
  await page.fill('.gate input[name="password"]', password);
  await page.fill('.gate input[name="password2"]', password);
  await page.click('.gate-form button[type="submit"]');
  await page.waitForSelector('.rk-key');
  const key = (await page.locator('.rk-key .rk-group').allTextContents()).join('-');
  await page.check('.rk-confirm input');
  await page.click('.gate-actions .btn-primary');
  await page.waitForSelector('.app .sidebar');
  return key;
}

async function unlockViaUi(page, password = PASSWORD) {
  await page.waitForSelector('.gate input[name="password"]');
  await page.fill('.gate input[name="password"]', password);
  await page.click('.gate-submit');
  await page.waitForSelector('.app .sidebar');
}

/** Lock through the command (keyboard shortcut on Linux/Windows: Ctrl+Alt+L). */
async function lockViaKeys(page) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Control+KeyL' : 'Control+Alt+KeyL');
  await page.waitForSelector('.gate input[name="password"]');
}

test('first run: choose a password with honest feedback, see the recovery key once, then the app', async () => {
  const stack = await startStack({ secure: true });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await page.waitForSelector('.gate');
    // (The harness writes settings.json into the data dir, which Harness counts as earlier data.)
    assert.match(await page.locator('.gate').textContent(), /Welcome to Harness|Protect your chats with a password/);
    // Honest feedback, no composition rules.
    await page.fill('.gate input[name="password"]', 'short');
    assert.match(await page.locator('.pw-strength').textContent(), /Too short/);
    await page.fill('.gate input[name="password"]', 'password123');
    assert.match(await page.locator('.pw-strength').textContent(), /Very easy to guess/);
    await page.fill('.gate input[name="password"]', PASSWORD);
    assert.match(await page.locator('.pw-strength').textContent(), /Good|Strong/);
    await page.fill('.gate input[name="password2"]', 'something else');
    await page.click('.gate-form button[type="submit"]');
    await page.waitForFunction(() => /don't match/.test(document.querySelector('.gate-error')?.textContent || ''));
    await page.fill('.gate input[name="password2"]', PASSWORD);
    await app.shot('30-setup');
    await page.click('.gate-form button[type="submit"]');

    // The recovery key: shown once, with the explicit "I have stored it" step.
    await page.waitForSelector('.rk-key');
    const groups = await page.locator('.rk-key .rk-group').allTextContents();
    assert.equal(groups[0], 'HRK1');
    assert.equal(groups.length, 14);
    assert.match(await page.locator('.gate').textContent(), /gone for good/);
    const cont = page.locator('.gate-actions .btn-primary');
    assert.equal(await cont.isDisabled(), true);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.rk-actions button', { hasText: 'Save as file' }).click()]);
    const saved = await fs.readFile(await dl.path(), 'utf8');
    assert.ok(saved.includes(groups.join('-')));
    await app.shot('31-recovery-key');
    await page.check('.rk-confirm input');
    assert.equal(await cont.isDisabled(), false);
    await cont.click();
    await page.waitForSelector('.app .sidebar');
    const sec = await page.evaluate(async () => (await fetch('/api/security')).json());
    assert.equal(sec.state, 'unlocked');
    assert.equal(sec.session.authenticated, true);
    assert.ok(sec.recoveryKey?.createdAt);
    // The session cookie is HttpOnly: nothing readable from script.
    assert.equal(await page.evaluate(() => document.cookie), '');
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('lock and unlock with the password and with the recovery key (then choose a new password)', async () => {
  const stack = await startStack({ secure: true });
  const app = await openApp(stack, { hash: '#/settings/privacy' });
  try {
    const { page } = app;
    const key = await setupViaUi(page);
    await page.waitForSelector('.privacy');
    // Lock now from the palette.
    await page.keyboard.press('Control+KeyK');
    await page.keyboard.type('Lock Harness');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.gate input[name="password"]');
    assert.equal(await page.locator('.app').count(), 0, 'the app is gone, not hidden');
    assert.match(await page.locator('.gate').textContent(), /Harness is locked/);
    await app.shot('32-lock');
    await unlockViaUi(page);
    await page.waitForSelector('.privacy'); // back where they were
    assert.match(page.url(), /#\/settings\/privacy$/);

    // Recovery key → password reset window → choose a new password.
    await lockViaKeys(page);
    await page.locator('.gate-switch').click();
    await page.fill('.gate textarea', key.toLowerCase().replace(/-/g, ' '));
    await page.click('.gate-submit');
    await page.waitForFunction(() => /Choose a new password/.test(document.querySelector('.gate')?.textContent || ''));
    await page.fill('.gate input[name="password"]', 'quiet harbour lantern seven');
    await page.fill('.gate input[name="password2"]', 'quiet harbour lantern seven');
    await page.click('.gate-form button[type="submit"]');
    await page.waitForSelector('.app .sidebar');
    await lockViaKeys(page);
    await page.fill('.gate input[name="password"]', PASSWORD);
    await page.click('.gate-submit');
    await page.waitForFunction(() => /not the password/.test(document.querySelector('.gate-error')?.textContent || ''));
    await page.fill('.gate input[name="password"]', 'quiet harbour lantern seven');
    await page.click('.gate-submit');
    await page.waitForSelector('.app .sidebar');
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('wrong passwords: three free tries, then a growing wait with a countdown', async () => {
  const stack = await startStack({ secure: true });
  await stack.setupPassword(PASSWORD);
  await stack.api('POST', '/api/security/lock', {});
  const app = await openApp(stack);
  try {
    const { page } = app;
    await page.waitForSelector('.gate input[name="password"]');
    for (let i = 0; i < 3; i++) {
      await page.fill('.gate input[name="password"]', `wrong guess ${i}`);
      await page.click('.gate-submit');
      await page.waitForFunction(() => /not the password/.test(document.querySelector('.gate-error')?.textContent || '') && !document.querySelector('.gate-submit.busy'));
    }
    await page.fill('.gate input[name="password"]', 'wrong guess 4');
    await page.click('.gate-submit');
    await page.waitForFunction(() => /try again in/i.test(document.querySelector('.gate-wait')?.textContent || ''));
    assert.equal(await page.locator('.gate-submit').isDisabled(), true);
    await app.shot('33-lock-wait');
    // The wait ends by itself; then the right password works.
    await page.waitForFunction(() => !document.querySelector('.gate-submit')?.disabled, null, { timeout: 8000 });
    await unlockViaUi(page);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('locking while a reply streams stops it and leaves nothing of the chat on the page', async () => {
  const stack = await startStack({ secure: true, delayMs: 25 });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await setupViaUi(page);
    await page.goto(`${stack.url}/#/chat`);
    await send(page, 'Tell me about lighthouses, long answer 900', { wait: false });
    await page.waitForFunction(() => /word40/.test(document.querySelector('.turn:last-child')?.textContent || ''));
    const chatHash = await page.evaluate(() => location.hash);
    await lockViaKeys(page);
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    assert.ok(!/lighthouses|word40/.test(html), 'no chat text in the locked page');
    const sec = (await stack.api('GET', '/api/security')).data;
    assert.equal(sec.state, 'locked');
    await unlockViaUi(page);
    assert.equal(await page.evaluate(() => location.hash), chatHash);
    // The partial reply was kept and is not still running.
    await page.waitForFunction(() => /word40/.test(document.querySelector('.turn:last-child')?.textContent || ''));
    await page.waitForFunction(() => !document.querySelector('.send-btn.stop'));
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('auto-lock: after the chosen idle time Harness locks and the page goes to the lock screen by itself', async () => {
  const stack = await startStack({ secure: true });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await setupViaUi(page);
    await page.goto(`${stack.url}/#/settings/privacy`);
    await page.waitForSelector('.privacy');
    await page.selectOption('.privacy select[aria-label="Lock Harness after"]', '5');
    await waitFor(async () => (await page.evaluate(async () => (await (await fetch('/api/settings')).json()).settings.security.idleLockMinutes)) === 5);
    // An idle page sends nothing that would keep Harness awake (no polling; the event stream does not count).
    await sleep(1500);
    const before = app.requests.filter((u) => u.includes('/api/') && !u.endsWith('/api/events')).length;
    await sleep(2500);
    assert.equal(app.requests.filter((u) => u.includes('/api/') && !u.endsWith('/api/events')).length, before, 'no requests while idle');
    // Five minutes pass (the backend's own idle check, run now instead of waiting).
    const core = stack.srv.core;
    core.lastActivity = Date.now() - 6 * 60000;
    core._checkIdle();
    await page.waitForSelector('.gate input[name="password"]', { timeout: 5000 });
    assert.equal(await page.locator('.privacy').count(), 0);
    await unlockViaUi(page);
    await page.waitForSelector('.privacy');
    // A lock from elsewhere (the Mac sleeping in the native app, another window) works the same way.
    await stack.unlock(PASSWORD);
    await stack.api('POST', '/api/security/lock', {});
    await page.waitForSelector('.gate input[name="password"]', { timeout: 5000 });
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('a minute before auto-lock a quiet hint offers to stay unlocked; using the page keeps Harness open', async () => {
  const stack = await startStack({ secure: true });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await setupViaUi(page);
    await stack.unlock(PASSWORD);
    await stack.api('PATCH', '/api/settings', { security: { idleLockMinutes: 1 } });
    await page.waitForFunction(async () => (await (await fetch('/api/security')).json()).idleLockMinutes === 1);
    await page.reload();
    await page.waitForSelector('.app .sidebar');
    assert.equal(await page.locator('.idle-hint').count(), 0);
    // Let most of the minute pass on the page's clock (no requests meanwhile).
    await page.clock.install();
    await page.clock.fastForward('00:45');
    await page.waitForSelector('.idle-hint', { timeout: 5000 });
    assert.match(await page.locator('.idle-hint').textContent(), /locks in \d+ s/);
    await app.shot('35-idle-hint');
    // "Stay unlocked" tells Harness the user is here.
    const before = (await stack.api('GET', '/api/security')).data.idleLockAt;
    await page.locator('.idle-hint button', { hasText: 'Stay unlocked' }).click();
    await page.waitForSelector('.idle-hint', { state: 'detached' });
    const after = (await stack.api('GET', '/api/security')).data.idleLockAt;
    assert.ok(Date.parse(after) > Date.parse(before), 'the activity signal moved the lock time');
    assert.equal((await stack.api('GET', '/api/security')).data.state, 'unlocked');
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('desktop menu: the `lock` action locks Harness', async () => {
  const stack = await startStack({ secure: true });
  const app = await openApp(stack, { desktop: true });
  try {
    const { page } = app;
    await setupViaUi(page);
    await page.waitForFunction(() => typeof window.__menu === 'function');
    await page.evaluate(() => window.__menu('lock'));
    await page.waitForSelector('.gate input[name="password"]');
    assert.equal((await stack.api('GET', '/api/security')).data.state, 'locked');
    // Pressing Lock again on the lock screen is not replayed after unlocking.
    await page.waitForFunction(() => typeof window.__menu === 'function');
    await page.evaluate(() => window.__menu('lock'));
    // The drag region is marked for WebKit too; controls inside stay clickable.
    await unlockViaUi(page);
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.gate').count(), 0, 'still unlocked');
    assert.equal(await page.locator('.main-titlebar').getAttribute('data-app-region'), 'drag');
    assert.equal(await page.locator('.main-titlebar button[aria-label="Toggle inspector"]').getAttribute('data-app-region'), 'no-drag');
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('0.1 data is encrypted when the password is chosen, with progress', async () => {
  // A plain data directory as Harness 0.1 left it: chats, a memory, an attachment.
  const plain = await startStack();
  const phrase = 'The lighthouse keeper writes in teal ink';
  for (let i = 0; i < 40; i++) await plain.api('POST', '/api/chats/import', { title: `Old chat ${i}`, messages: [{ role: 'user', content: `${phrase} (${i}).` }, { role: 'assistant', content: 'Noted.' }] });
  await plain.api('POST', '/api/memories', { content: `${phrase}.`, category: 'fact' });
  const dataDir = plain.dataDir;
  await plain.srv.close();
  await fs.rm(path.join(dataDir, 'launch.json'), { force: true });
  const stack = await startStack({ secure: true, reuseDataDir: dataDir });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await page.waitForSelector('.gate');
    assert.match(await page.locator('.gate').textContent(), /will be encrypted/);
    await page.fill('.gate input[name="password"]', PASSWORD);
    await page.fill('.gate input[name="password2"]', PASSWORD);
    await page.click('.gate-form button[type="submit"]');
    await page.waitForSelector('.rk-key');
    // While the key is on screen the existing files are being encrypted, with progress.
    await page.waitForSelector('.mig:not([hidden])');
    assert.match(await page.locator('.mig').textContent(), /Encrypting your data/);
    await page.waitForFunction(() => document.querySelector('.mig')?.hidden || /of \d+ files/.test(document.querySelector('.mig')?.textContent || ''), null, { timeout: 15000 });
    await app.shot('36-migration');
    await page.check('.rk-confirm input');
    await page.click('.gate-actions .btn-primary');
    // Then the app with the old chats.
    await page.waitForSelector('.app .sidebar', { timeout: 30000 });
    await page.waitForFunction(() => /Old chat 39/.test(document.querySelector('.sidebar')?.textContent || ''));
    // On disk nothing is readable any more.
    const hits = [];
    const walk = async (d) => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if ((await fs.readFile(p)).includes('teal ink')) hits.push(path.relative(dataDir, p));
      }
    };
    await walk(dataDir);
    assert.deepEqual(hits, []);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); await plain.close(); }
});

test('downloads while internet access is blocked: one allow prompt, the download starts by itself, countdown and Block now', async () => {
  const stack = await startStack({ secure: true, ram: 16, models: {}, pullStepMs: 30 });
  const app = await openApp(stack, { hash: '#/models' });
  try {
    const { page } = app;
    await setupViaUi(page);
    await page.goto(`${stack.url}/#/models`);
    // The chat stays silent about it; the title bar shows the blocked shield.
    await page.waitForSelector('.net-shield-wrap[data-state="blocked"]');
    await page.fill('.pull-row input', 'qwen3:4b');
    await page.locator('.pull-row button', { hasText: 'Download' }).click();
    // Exactly one prompt, from error.details.allow.
    await page.waitForSelector('dialog.confirm-pw');
    assert.equal(await page.locator('dialog[open]').count(), 1);
    assert.match(await page.locator('dialog.confirm-pw').textContent(), /Allow internet for 15 minutes/);
    await page.fill('dialog.confirm-pw input[type="password"]', 'not it');
    await page.locator('dialog.confirm-pw .dialog-actions .btn-primary').click();
    await page.waitForFunction(() => /not your Harness password/.test(document.querySelector('dialog.confirm-pw')?.textContent || ''));
    await page.fill('dialog.confirm-pw input[type="password"]', PASSWORD);
    await page.locator('dialog.confirm-pw .dialog-actions .btn-primary').click();
    await page.waitForSelector('dialog.confirm-pw', { state: 'detached' });
    // The download was retried automatically and finishes.
    await stack.unlock(PASSWORD); // a CLI-style session for the checks below
    await waitFor(async () => (await stack.api('GET', '/api/models')).data.models?.some((m) => m.model === 'qwen3:4b'), { timeout: 20000 });
    // Countdown in the title bar, then Block now.
    await page.waitForSelector('.net-shield-wrap[data-state="allowed"]');
    assert.match(await page.locator('.net-shield').textContent(), /Online 1[45]:\d\d/);
    await app.shot('34-internet-allowed');
    await page.locator('.net-block').click();
    await page.waitForSelector('.net-shield-wrap[data-state="blocked"]');
    assert.equal((await stack.api('GET', '/api/network')).data.offlineLock.blocked, true);
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('sensitive actions ask for the password: an encrypted backup download', async () => {
  const stack = await startStack({ secure: true });
  const app = await openApp(stack);
  try {
    const { page } = app;
    await setupViaUi(page);
    await page.goto(`${stack.url}/#/settings/privacy`);
    await page.locator('.privacy button', { hasText: 'Download backup' }).click();
    await page.fill('dialog input[name="passphrase"]', 'tide pool backup words');
    await page.fill('dialog input[name="passphrase2"]', 'tide pool backup words');
    await page.locator('dialog .dialog-actions .btn-primary', { hasText: 'Download' }).click();
    await page.waitForSelector('dialog.confirm-pw');
    await page.fill('dialog.confirm-pw input[type="password"]', 'wrong password');
    await page.locator('dialog.confirm-pw .dialog-actions .btn-primary').click();
    await page.waitForFunction(() => /not your Harness password/.test(document.querySelector('dialog.confirm-pw')?.textContent || ''));
    await page.fill('dialog.confirm-pw input[type="password"]', PASSWORD);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('dialog.confirm-pw .dialog-actions .btn-primary').click()]);
    const file = await dl.path();
    const env = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(env.format, 'harness.backup.encrypted');
    assert.equal(env.cipher, 'aes-256-gcm');
    // Restoring it needs the backup's passphrase and the Harness password (X-Harness-Confirm).
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.privacy button', { hasText: 'Restore from backup' }).click()]);
    await chooser.setFiles(file);
    await page.fill('dialog input[name="passphrase"]', 'wrong words');
    await page.locator('dialog .dialog-actions .btn-primary', { hasText: 'Restore' }).click();
    await page.fill('dialog.confirm-pw input[type="password"]', PASSWORD);
    await page.locator('dialog.confirm-pw .dialog-actions .btn-primary').click();
    await page.waitForFunction(() => /passphrase/i.test(document.querySelector('dialog.confirm-pw .field-error')?.textContent || ''));
    await page.locator('dialog.confirm-pw .dialog-actions .btn', { hasText: 'Cancel' }).click();
    const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.privacy button', { hasText: 'Restore from backup' }).click()]);
    await chooser2.setFiles(file);
    await page.fill('dialog input[name="passphrase"]', 'tide pool backup words');
    await page.locator('dialog .dialog-actions .btn-primary', { hasText: 'Restore' }).click();
    await page.fill('dialog.confirm-pw input[type="password"]', PASSWORD);
    await page.locator('dialog.confirm-pw .dialog-actions .btn-primary').click();
    await page.waitForFunction(() => /Backup restored/.test(document.querySelector('.toasts')?.textContent || ''));
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('protection mode: "Don\'t ask on this Mac" needs the password; the lock screen then opens with one click', async () => {
  const stack = await startStack({ secure: true });
  const app = await openApp(stack, { hash: '#/settings/privacy' });
  try {
    const { page } = app;
    await setupViaUi(page);
    await page.waitForSelector('.privacy');
    await app.shot('37-privacy');
    // The self-test, in plain words per layer.
    await page.locator('.privacy button', { hasText: 'Check that nothing can get out' }).click();
    await page.waitForSelector('.selftest-head', { timeout: 15000 });
    assert.match(await page.locator('.selftest-head').textContent(), /Nothing got out/);
    assert.match(await page.locator('.selftest-list').textContent(), /Harness itself: refused to connect to huggingface\.co:443/);
    await page.locator('.mode-card[data-mode="keychain"]').click();
    await page.waitForSelector('dialog.confirm-pw');
    await page.locator('dialog.confirm-pw .dialog-actions .btn', { hasText: 'Cancel' }).click();
    assert.equal(await page.locator('.mode-card[aria-checked="true"]').getAttribute('data-mode'), 'password', 'nothing changes without the password');
    await page.locator('.mode-card[data-mode="keychain"]').click();
    await page.fill('dialog.confirm-pw input[type="password"]', PASSWORD);
    await page.locator('dialog.confirm-pw .dialog-actions .btn-primary').click();
    await page.waitForSelector('.mode-card[data-mode="keychain"][aria-checked="true"]');
    await lockViaKeys(page);
    await page.locator('.gate button', { hasText: 'Open Harness' }).click();
    await page.waitForSelector('.privacy');
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('keychain mode: a launcher\'s #launch=<code> signs the window in and leaves no trace in the address', async () => {
  const stack = await startStack({ secure: true });
  await stack.setupPassword(PASSWORD);
  const m = await stack.api('POST', '/api/security/mode', { password: PASSWORD, mode: 'keychain' });
  assert.equal(m.status, 200);
  await stack.waitUnlocked();
  const lc = await stack.api('POST', '/api/auth/launch-code', {});
  assert.equal(lc.status, 200, JSON.stringify(lc.data));
  const app = await openApp(stack, { hash: `#launch=${lc.data.code}` });
  try {
    const { page } = app;
    await page.waitForSelector('.app .sidebar');
    assert.equal(await page.evaluate(() => location.hash), '');
    assert.ok(!(await page.evaluate(() => history.length > 0 && location.href)).includes('launch='));
    // Without a code a new window is told to use the launcher (or the password).
    const other = await openApp(stack);
    try {
      await other.page.waitForSelector('.gate');
      assert.match(await other.page.locator('.gate').textContent(), /Open Harness from its launcher/);
    } finally { await other.close(); }
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

test('browser storage holds nothing derived from the user: drafts live in the UI-state store', async () => {
  const stack = await startStack({ secure: true });
  const app = await openApp(stack);
  try {
    const { page } = app;
    // Leftovers from 0.1 are moved to the UI-state store and removed from the browser.
    await page.evaluate(() => { localStorage.setItem('harness.draft.new', 'an old draft from 0.1'); localStorage.setItem('harness.ui.sidebar', 'true'); });
    await setupViaUi(page);
    await page.goto(`${stack.url}/#/chat`);
    // The 0.1 draft came along (from the UI-state store now).
    await page.waitForFunction(() => document.querySelector('.composer-input')?.value === 'an old draft from 0.1');
    const secret = 'Draft about the secret Heron launch date';
    await page.locator('.composer-input').fill(secret);
    await page.locator('.composer-input').press('End');
    await page.keyboard.type('!');
    await waitFor(async () => JSON.stringify((await page.evaluate(async () => (await fetch('/api/ui-state')).json())).state).includes(secret));
    const dump = await page.evaluate(async () => {
      const out = { local: {}, session: {}, idb: [], caches: [] };
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out.local[k] = localStorage.getItem(k); }
      for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); out.session[k] = sessionStorage.getItem(k); }
      for (const db of (await indexedDB.databases?.()) || []) {
        const d = await new Promise((res, rej) => { const r = indexedDB.open(db.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        for (const store of d.objectStoreNames) {
          const all = await new Promise((res) => { const r = d.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
          out.idb.push(JSON.stringify(all));
        }
        d.close();
      }
      if (self.caches) out.caches = await caches.keys();
      return out;
    });
    const all = JSON.stringify(dump);
    assert.ok(!all.includes('Heron'), `draft text found in browser storage: ${all}`);
    assert.ok(!all.includes('old draft'), 'the 0.1 draft was removed from localStorage');
    assert.deepEqual(Object.keys(dump.local).filter((k) => k !== 'harness.ui.theme' && k !== 'harness.debug'), []);
    assert.deepEqual(dump.session, {});
    // The draft survives a reload (from the server).
    await page.reload();
    await page.waitForSelector('.composer-input');
    await page.waitForFunction((t) => document.querySelector('.composer-input')?.value.startsWith(t), secret);
    // No request ever carried a Blob/File/FormData body (WKWebView drops them on custom schemes): upload a file.
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('button[aria-label="Attach files"]').click()]);
    await chooser.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello there') });
    await page.waitForSelector('.attach-row .attach-chip:not(.uploading), .attach-row [data-status="ready"]', { timeout: 10000 }).catch(() => {});
    await waitFor(async () => (await page.evaluate(() => window.__bodyKinds)).some((k) => /Uint8Array/.test(k)));
    const kinds = await page.evaluate(() => window.__bodyKinds);
    assert.ok(!kinds.some((k) => /Blob|File|FormData/.test(k)), kinds.join(', '));
    await app.assertClean(assert);
  } finally { await app.close(); await stack.close(); }
});

export { sleep };
