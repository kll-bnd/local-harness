'use strict';
// Runs INSIDE the Electron main process when HARNESS_E2E_SCRIPT points here (see electron/test/e2e.mjs).
// Drives the real window and prints one `E2E_RESULT {json}` line, then quits the app normally.
const fs = require('node:fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = function drive(ctx) {
  const { app, hooks, Menu } = ctx;
  const out = { checks: {}, info: {} };
  const opened = [];
  const revealed = [];
  hooks.openExternal = (url) => { opened.push(url); };
  hooks.showItemInFolder = (p) => { revealed.push(p); };

  const check = (name, ok, detail) => { out.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; };

  async function waitFor(fn, ms = 5000) {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) return v;
      await sleep(50);
    }
  }

  async function run() {
    const win = ctx.window;
    const wc = win.webContents;
    if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));
    const js = (code) => wc.executeJavaScript(code, true);
    const appUrl = ctx.appUrl;
    const origin = new URL(appUrl).origin;

    out.info.appUrl = appUrl;
    out.info.inProcessServer = !!ctx.server;
    out.info.version = app.getVersion();
    out.info.electron = process.versions.electron;
    out.info.registeredShortcut = ctx.registeredShortcut;

    // 0. Harness 0.2 security (docs/API.md §10): set up a throw-away password, give the window its session.
    //    Skipped (info.security = null) against a backend without /api/security.
    let auth = {};
    const secNow = async () => { try { const r = await fetch(`${appUrl}/api/security`); return r.ok ? r.json() : null; } catch { return null; } };
    let sec = await secNow();
    out.info.security = sec ? { state: sec.state, mode: sec.mode, plainDataFound: sec.plainDataFound, transport: sec.transport, offlineLock: sec.offlineLock } : null;
    if (sec && ctx.server) {
      if (sec.state === 'needs_setup') {
        const pw = require('node:crypto').randomBytes(18).toString('base64url');
        const r = await fetch(`${appUrl}/api/security/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) });
        const j = await r.json().catch(() => null);
        // The recovery key is checked for shape only and never printed.
        check('setup_returns_recovery_key_once', r.ok && /^HRK1-/.test(j?.recoveryKey || ''), { status: r.status, state: j?.state });
        // Wait for 'unlocked': with 0.1 data present the backend migrates first (and was seen to pass through a
        // transient 'locked' state while doing so).
        const states = [];
        sec = await waitFor(async () => { const x = await secNow(); if (x && states.at(-1) !== x.state) states.push(x.state); return x && x.state === 'unlocked' ? x : null; }, 60000);
        out.info.setupStates = states;
        out.info.securityAfterSetup = sec ? { state: sec.state, mode: sec.mode } : null;
      }
      const url = await ctx.windowSessionUrl();
      await wc.loadURL(url);
      const st = await js(`fetch('/api/auth/status').then((r) => r.json()).catch(() => null)`);
      check('window_has_session', st?.authenticated === true, st);
      const cookies = await require('electron').session.defaultSession.cookies.get({ url: appUrl, name: 'harness_session' });
      check('session_cookie_in_memory_only', cookies.length > 0 && cookies.every((c) => c.session === true), cookies.map((c) => ({ session: c.session, hasExpiry: c.expirationDate != null })));
      try { const c = ctx.server.auth.createSession(); auth = { cookie: `${c.name}=${c.value}` }; } catch (e) { out.info.authError = e.message; }
      const data = await fetch(`${appUrl}/api/chats`, { headers: auth });
      check('data_routes_answer_with_session', data.ok, { status: data.status });
      const anon = await fetch(`${appUrl}/api/chats`);
      check('data_routes_refuse_without_session', anon.status === 401 || anon.status === 423, { status: anon.status });
    }

    // 1. The window shows the local server.
    check('window_loads_server_url', wc.getURL().startsWith(origin), wc.getURL());
    const page = await js(`({ title: document.title, body: document.body ? document.body.innerText.slice(0, 80) : null })`);
    out.info.page = page;

    // 2. Preload contract.
    const contract = await js(`({
      classes: [...document.documentElement.classList],
      apiType: typeof window.harnessDesktop,
      keys: window.harnessDesktop ? Object.keys(window.harnessDesktop).sort() : null,
      platform: window.harnessDesktop && window.harnessDesktop.platform,
      appVersion: window.harnessDesktop && window.harnessDesktop.appVersion,
      frozen: Object.isFrozen(window.harnessDesktop),
      nodeRequire: typeof require, nodeProcess: typeof process, ipc: typeof window.ipcRenderer,
    })`);
    out.info.contract = contract;
    check('preload_api_present', contract.apiType === 'object' && JSON.stringify(contract.keys) === JSON.stringify(['appVersion', 'onMenuAction', 'openExternal', 'platform', 'setBadge', 'showInFolder']));
    check('preload_values', contract.platform === process.platform && contract.appVersion === app.getVersion(), { platform: contract.platform, appVersion: contract.appVersion });
    check('html_classes', contract.classes.includes('desktop') && (process.platform !== 'darwin' || contract.classes.includes('desktop-mac')), contract.classes);
    check('no_node_in_page', contract.nodeRequire === 'undefined' && contract.nodeProcess === 'undefined' && contract.ipc === 'undefined');

    // Classes survive the page overwriting <html class>.
    await js(`document.documentElement.className = 'theme-x'`);
    await sleep(50);
    const cls2 = await js(`[...document.documentElement.classList]`);
    check('html_classes_reapplied', cls2.includes('desktop') && cls2.includes('theme-x'), cls2);

    // 3. Native menu → page.
    await js(`window.__menu = []; window.__off = window.harnessDesktop.onMenuAction((a) => window.__menu.push(a)); true`);
    const menu = Menu.getApplicationMenu();
    for (const a of ['new-chat', 'open-settings', 'stop-generation']) menu.getMenuItemById(`action:${a}`).click();
    const got = await waitFor(() => js(`window.__menu.length >= 3 && window.__menu`), 3000);
    check('menu_action_reaches_page', JSON.stringify(got) === JSON.stringify(['new-chat', 'open-settings', 'stop-generation']), got);
    const accel = {};
    for (const a of ['new-chat', 'open-settings', 'search-chats', 'stop-generation', 'toggle-sidebar']) accel[a] = menu.getMenuItemById(`action:${a}`).accelerator;
    out.info.accelerators = accel;
    const roles = [];
    for (const top of menu.items) roles.push(top.role || top.label);
    out.info.topMenus = roles;

    // 4. Navigation lock + external links.
    await js(`location.href = 'https://example.com/navigate-away'; true`).catch(() => {});
    await sleep(600);
    check('external_navigation_blocked', wc.getURL().startsWith(origin) && opened.includes('https://example.com/navigate-away'), { url: wc.getURL(), opened: [...opened] });
    await js(`location.href = 'file:///etc/passwd'; true`).catch(() => {});
    await sleep(400);
    check('file_navigation_blocked', wc.getURL().startsWith(origin) && !opened.some((u) => u.startsWith('file:')), wc.getURL());
    const w1 = await js(`String(window.open('https://example.org/popup'))`);
    const w2 = await js(`String(window.open('file:///etc/hosts'))`);
    const w3 = await js(`String(window.open('javascript:alert(1)'))`);
    await sleep(300);
    check('window_open_denied_and_routed', w1 === 'null' && w2 === 'null' && w3 === 'null' && BrowserWindowCount() === 1 && opened.includes('https://example.org/popup') && !opened.some((u) => !/^https?:/.test(u)), { opened: [...opened], windows: BrowserWindowCount() });

    // 5. IPC argument validation (main process).
    const ipc = await js(`Promise.all([
      harnessDesktop.openExternal('https://example.net/ok'),
      harnessDesktop.openExternal('file:///etc/passwd'),
      harnessDesktop.openExternal('javascript:alert(1)'),
      harnessDesktop.showInFolder(${JSON.stringify(ctx.paths.desktopConfig)}),
      harnessDesktop.showInFolder('desktop.json'),
      harnessDesktop.showInFolder('/etc/passwd'),
      harnessDesktop.showInFolder('../../../../etc/passwd'),
      harnessDesktop.setBadge('3'),
      harnessDesktop.setBadge(''),
      harnessDesktop.setBadge(5),
    ])`);
    check('ipc_validation', JSON.stringify(ipc) === JSON.stringify([true, false, false, true, true, false, false, true, true, true]) && revealed.length === 2 && revealed.every((p) => p.endsWith('desktop.json')), { ipc, revealed });

    // 6. The page cannot reach the internet; the local API works.
    const net = await js(`Promise.all([
      fetch('https://example.com/').then(() => 'reached', (e) => 'blocked'),
      fetch('http://127.0.0.1:9/').then(() => 'reached', (e) => 'blocked'),
      fetch('/api/health').then((r) => r.json()).then((j) => j.ok ? 'ok' : 'bad', (e) => 'error: ' + e.message),
      new Promise((res) => { const i = new Image(); i.onload = () => res('reached'); i.onerror = () => res('blocked'); i.src = 'https://example.com/pixel.png'; }),
    ])`);
    check('remote_requests_blocked', JSON.stringify(net) === JSON.stringify(['blocked', 'blocked', 'ok', 'blocked']), net);

    // 7. Permissions denied by default.
    const perms = await js(`Promise.all(['geolocation', 'notifications', 'camera', 'microphone'].map((name) =>
      navigator.permissions.query({ name }).then((s) => name + ':' + s.state, (e) => name + ':error')))`);
    const geo = await js(`new Promise((res) => navigator.geolocation.getCurrentPosition(() => res('granted'), (e) => res('denied:' + e.code), { timeout: 3000 }))`);
    check('permissions_denied', perms.every((p) => p.endsWith(':denied')) && geo.startsWith('denied'), { perms, geo });

    // 8. Full-screen class (needs a window manager; informational on bare Xvfb).
    win.setFullScreen(true);
    const fsOn = await waitFor(() => js(`document.documentElement.classList.contains('desktop-fullscreen')`), 2500);
    win.setFullScreen(false);
    const fsOff = await waitFor(async () => !(await js(`document.documentElement.classList.contains('desktop-fullscreen')`)), 2500);
    out.info.fullscreenClass = { on: fsOn, off: fsOff, isFullScreenReported: win.isFullScreen() };

    // 9. In-process backend hooks: theme sync and App Nap guard during a real (fake-model) generation.
    if (ctx.server) {
      const { nativeTheme } = require('electron');
      const patch = (body) => fetch(`${appUrl}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body) });
      await patch({ ui: { theme: 'dark' } });
      const dark = nativeTheme.themeSource;
      await patch({ ui: { theme: 'system' } });
      check('theme_follows_settings', dark === 'dark' && nativeTheme.themeSource === 'system', { dark, after: nativeTheme.themeSource });

      if (process.env.HARNESS_E2E_FAKE_OLLAMA === '1') {
        const chat = await (await fetch(`${appUrl}/api/chats`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: '{}' })).json();
        const before = ctx.activity.active;
        const res = fetch(`${appUrl}/api/chats/${chat.chat.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ content: 'long answer 120', model: { providerId: 'ollama', model: 'qwen3:4b' } }) });
        const during = await waitFor(() => ctx.activity.active, 5000);
        const r = await res;
        const text = await r.text();
        const after = await waitFor(() => !ctx.activity.active, 6000);
        check('app_nap_guard_tracks_generation', !before && during && after && r.status === 200, { before, during, afterIdle: after, status: r.status, streamBytes: text.length, tail: text.slice(-160) });
      }
    }

    // 10. Global shortcut registration (X11 grab under Xvfb; informational).
    out.info.globalShortcutRegistered = ctx.registeredShortcut ? require('electron').globalShortcut.isRegistered(ctx.registeredShortcut) : false;

    check('single_window', BrowserWindowCount() === 1);

    // 11. Locking (0.2): the 15th menu action reaches the page; a screen lock locks the in-process backend.
    //     Last, because the real UI reacts to 'lock' by locking Harness.
    await js(`window.__menu = window.__menu || []; window.__menu.length = 0; true`);
    menu.getMenuItemById('action:lock').click();
    const gotLock = await waitFor(() => js(`window.__menu.includes('lock')`), 3000);
    check('lock_menu_action_reaches_page', gotLock === true && menu.getMenuItemById('action:lock').accelerator === (process.platform === 'darwin' ? 'Control+Command+L' : 'Control+Shift+L'), { got: gotLock, accelerator: menu.getMenuItemById('action:lock').accelerator });
    if (sec && ctx.server) {
      ctx.powerMonitor.emit('lock-screen');
      const locked = await waitFor(async () => (await secNow())?.state === 'locked', 15000);
      const after = await fetch(`${appUrl}/api/chats`, { headers: auth });
      check('screen_lock_locks_backend', locked === true && after.status === 423, { locked, status: after.status });
      check('app_nap_released_when_locked', !ctx.activity?.active);
    } else {
      out.info.lockOnSleep = 'not tested (no 0.2 security in this backend)';
    }
  }

  function BrowserWindowCount() {
    return require('electron').BrowserWindow.getAllWindows().length;
  }

  const timeout = setTimeout(() => {
    out.error = 'driver timeout';
    console.log(`E2E_RESULT ${JSON.stringify(out)}`);
    app.quit();
  }, 60000);

  run().catch((e) => { out.error = e.stack || String(e); }).finally(() => {
    clearTimeout(timeout);
    out.info.logFileExists = fs.existsSync(ctx.paths.logFile);
    process.stdout.write(`E2E_RESULT ${JSON.stringify(out)}\n`);
    app.quit(); // the real quit path: before-quit → server.close()
  });
};
