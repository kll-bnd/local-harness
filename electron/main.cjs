'use strict';
// Harness desktop shell (Electron main process).
//
// Thin by design: it starts the zero-dependency backend in-process (server/index.mjs → startServer),
// shows its URL in one locked-down BrowserWindow, adds a native menu / Dock / global shortcut, and
// closes the backend cleanly on quit. All decision logic lives in ./lib/*.cjs (unit-tested without a
// display in electron/test/); this file is wiring only.
const {
  app, BrowserWindow, Menu, shell, dialog, ipcMain, session, nativeTheme, powerSaveBlocker, powerMonitor, globalShortcut, screen, clipboard,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { resolveDataDir, desktopPaths } = require('./lib/paths.cjs');
const { MENU_ACTIONS, loadDesktopConfig } = require('./lib/config.cjs');
const security = require('./lib/security.cjs');
const menus = require('./lib/menu.cjs');
const windowState = require('./lib/window-state.cjs');
const { createActivityGuard, backendBusy, ACTIVITY_EVENTS } = require('./lib/activity.cjs');
const { findRunningHarness, findAppHarness } = require('./lib/instance.cjs');
const { startOrRefuse, alreadyOpenMessage } = require('./lib/backend.cjs');
const { teeConsoleToFile } = require('./lib/logfile.cjs');

const isMac = process.platform === 'darwin';
const ROOT = path.resolve(__dirname, '..');
// Test hook (electron/test/e2e.mjs): a script that drives the app. Not shipped in packaged builds.
const E2E_SCRIPT = process.env.HARNESS_E2E_SCRIPT || null;
const headless = !!E2E_SCRIPT;

// ------------------------------------------------------------------ before `ready`: paths + single instance
app.setName('Harness');
const dataDir = resolveDataDir();
const paths = desktopPaths(dataDir);
let dataDirError = null;
try {
  fs.mkdirSync(paths.sessionData, { recursive: true });
  fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
} catch (e) {
  dataDirError = e;
}

if (dataDirError) {
  // Without a usable data dir there is no single-instance lock and no server: explain and exit.
  app.whenReady().then(async () => {
    await reportStartupError(Object.assign(new Error(`Cannot use the data folder ${dataDir}: ${dataDirError.message}`), { code: dataDirError.code }));
    app.exit(1);
  });
  return; // CommonJS top-level return: wire nothing else in this process
}

// One location regardless of how Harness is launched: Electron's userData IS the backend data dir
// (~/Library/Application Support/Harness on macOS); Chromium's caches go to a sub-folder.
app.setPath('userData', dataDir);
app.setPath('sessionData', paths.sessionData);

if (!app.requestSingleInstanceLock()) {
  // Another Harness window app owns this data dir; it receives 'second-instance' and shows itself.
  app.quit();
  return; // CommonJS top-level return: wire nothing else in this process
}

let logger = null;
try { logger = teeConsoleToFile(paths.logFile); } catch (e) { console.warn(`Harness: cannot write log file: ${e.message}`); }

const { config: desktop, warnings: configWarnings } = loadDesktopConfig(paths.desktopConfig);
for (const w of configWarnings) console.warn(`[desktop] ${w}`);

let server = null; // { url, port, close, app } when the backend runs in this process
let appUrl = null;
let appOrigin = null;
let win = null;
let quitting = false;
let shutdownDone = false;
let shuttingDown = false;
let activity = null;
let saveTimer = null;
let registeredShortcut = null;

const hooks = {
  // Replaced by the E2E script so tests never launch a real browser.
  openExternal: (url) => shell.openExternal(url),
  showItemInFolder: (p) => shell.showItemInFolder(p),
};

// ---------------------------------------------------------------------------------------------- helpers
const backgroundColor = () => (nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#fafafa');

function openExternal(url) {
  if (!security.isExternalHttpUrl(url)) return false;
  Promise.resolve(hooks.openExternal(url)).catch((e) => console.warn(`[desktop] openExternal failed: ${e.message}`));
  return true;
}

/** Deliver a menu action to the page without bringing the window forward (e.g. lock on sleep). */
function notifyPage(action) {
  if (!MENU_ACTIONS.includes(action) || !win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (!wc.isLoading()) wc.send('harness:menu-action', action);
}

function sendToPage(action) {
  if (!MENU_ACTIONS.includes(action)) return;
  const w = showWindow();
  if (!w) return;
  const wc = w.webContents;
  if (wc.isLoading()) wc.once('did-finish-load', () => wc.send('harness:menu-action', action));
  else wc.send('harness:menu-action', action);
}

function showDataFolder() {
  shell.openPath(dataDir).then((err) => { if (err) console.warn(`[desktop] ${err}`); });
}

function showLogFile() {
  if (fs.existsSync(paths.logFile)) shell.showItemInFolder(paths.logFile);
  else showDataFolder();
}

function setBadge(text) {
  if (isMac && app.dock) app.dock.setBadge(text);
  else app.setBadgeCount(Number.parseInt(text, 10) || 0);
}

function applyTheme(settings) {
  const t = settings?.ui?.theme;
  nativeTheme.themeSource = t === 'light' || t === 'dark' ? t : 'system';
}

// ------------------------------------------------------------------------------- sessions and locking
/**
 * Give our own window an API session (docs/API.md §10.5) without a prompt when that is possible: the in-process
 * backend's startServer().auth.createSession() (it throws while locked in password mode: the page then shows
 * Harness's lock screen and the unlock there sets the cookie). The app never talks to a backend it did not start.
 * The cookie is set WITHOUT an expiry so Chromium keeps it in memory only, never in its on-disk cookie store.
 * @returns {Promise<string>} the URL to load
 */
async function windowSessionUrl() {
  if (server?.auth?.createSession) {
    let c = null;
    try { c = server.auth.createSession(); } catch { return appUrl; }
    try {
      await session.defaultSession.cookies.set({ url: appUrl, name: c.name, value: c.value, httpOnly: true, sameSite: 'strict', path: '/' });
    } catch (e) { console.warn(`[desktop] could not give the window a session: ${e.message}`); }
  }
  return appUrl;
}

/** Lock Harness now (system sleep, screen lock): startServer().security.lock('app') (docs/API.md §10.5); the page is told too. */
async function lockHarness(reason) {
  notifyPage('lock');
  const sec = server?.security;
  if (!sec?.lock) return false;
  if (sec.state !== 'unlocked' && sec.state !== 'migrating') return false; // nothing to lock (locked, error, setup)
  if (sec.mode === 'off') return false;
  try {
    await sec.lock('app');
    console.log(`[desktop] locked Harness (${reason})`);
    return true;
  } catch (e) {
    console.warn(`[desktop] could not lock Harness (${reason}): ${e.message}`);
    return false;
  }
}

function scheduleSaveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateNow, 500);
}

function saveStateNow() {
  clearTimeout(saveTimer);
  if (!win || win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
  windowState.writeState(paths.windowState, windowState.captureState(win));
}

// ----------------------------------------------------------------------------------------------- window
function createWindow(startUrl = appUrl) {
  const st = windowState.fitToDisplays(windowState.readState(paths.windowState), screen.getAllDisplays(), screen.getPrimaryDisplay());
  const devIcon = path.join(ROOT, 'build', 'icon.png');
  const init = { appVersion: app.getVersion(), actions: MENU_ACTIONS, fullscreen: false };
  win = new BrowserWindow({
    x: st.x, y: st.y, width: st.width, height: st.height,
    minWidth: windowState.MIN_SIZE.width, minHeight: windowState.MIN_SIZE.height,
    show: false,
    title: 'Harness',
    backgroundColor: backgroundColor(),
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : {}),
    ...(!isMac && !app.isPackaged && fs.existsSync(devIcon) ? { icon: devIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: true,
      additionalArguments: [`--harness-desktop=${encodeURIComponent(JSON.stringify(init))}`],
    },
  });
  if (st.maximized) win.maximize();
  const w = win;
  const wc = w.webContents;

  w.once('ready-to-show', () => { if (!headless || process.env.HARNESS_E2E_SHOW === '1') w.show(); else w.showInactive(); });

  // Navigation: the window only ever shows the local server. http(s) links go to the system browser.
  const guardNav = (e, url) => {
    const d = security.navigationDecision(url, appOrigin);
    if (d === 'allow') return;
    e.preventDefault();
    if (d === 'external') openExternal(url);
    else console.warn(`[desktop] blocked navigation to ${String(url).slice(0, 200)}`);
  };
  wc.on('will-navigate', guardNav);
  wc.on('will-redirect', guardNav);
  wc.setWindowOpenHandler(({ url }) => {
    if (security.windowOpenDecision(url) === 'external') openExternal(url);
    return { action: 'deny' };
  });

  const sendFullscreen = () => { if (!wc.isDestroyed()) wc.send('harness:fullscreen', w.isFullScreen()); };
  wc.on('dom-ready', sendFullscreen);
  w.on('enter-full-screen', sendFullscreen);
  w.on('leave-full-screen', sendFullscreen);

  wc.on('context-menu', (_e, params) => {
    const template = menus.buildContextMenuTemplate(params, {
      replaceMisspelling: (word) => wc.replaceMisspelling(word),
      copyText: (text) => clipboard.writeText(text),
      openExternal: (url) => openExternal(url),
      copyImageAt: (x, y) => wc.copyImageAt(x, y),
      lookUp: () => wc.showDefinitionForSelection?.(),
    }, { isMac });
    if (template.length) Menu.buildFromTemplate(template).popup({ window: w });
  });

  wc.on('render-process-gone', async (_e, details) => {
    console.error(`[desktop] renderer gone: ${details.reason} (exit ${details.exitCode})`);
    if (details.reason === 'clean-exit' || quitting || headless) return;
    const { response } = await dialog.showMessageBox(w, {
      type: 'warning', message: 'The Harness window stopped unexpectedly.',
      detail: 'Your chats are safe — they are stored by the local server. Reload the window?', buttons: ['Reload', 'Quit'], defaultId: 0,
    });
    if (response === 0) wc.reload(); else app.quit();
  });

  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) console.error(`[desktop] failed to load ${url}: ${desc} (${code})`);
  });

  w.on('resize', scheduleSaveState);
  w.on('move', scheduleSaveState);
  w.on('close', (e) => {
    saveStateNow();
    if (quitting || !isMac || !desktop.hideOnClose) return;
    // macOS convention: closing the window keeps the app running; the Dock icon or ⌘⇧Space brings it back.
    e.preventDefault();
    if (w.isFullScreen()) {
      w.once('leave-full-screen', () => w.hide());
      w.setFullScreen(false);
    } else {
      w.hide();
    }
  });
  w.on('closed', () => { if (win === w) win = null; });

  w.loadURL(startUrl);
  return w;
}

function showWindow() {
  if (!appUrl) return null;
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

function toggleWindow() {
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
    if (isMac) app.hide(); else win.hide();
    return;
  }
  showWindow();
  if (isMac) app.focus({ steal: true });
}

// ---------------------------------------------------------------------------------- session & security
function lockDownSession(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(security.isPermissionAllowed(permission, details?.requestingUrl || wc?.getURL(), appOrigin));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => security.isPermissionAllowed(permission, requestingOrigin, appOrigin));
  ses.setDevicePermissionHandler(() => false);
  // The page may only talk to the local server: no remote images, fonts, scripts or trackers.
  // (Links the user clicks open in the system browser instead.)
  const warned = new Set();
  // Keep Harness's session cookie in memory only: drop Max-Age/Expires from its Set-Cookie so Chromium does not
  // write it to its on-disk cookie store (a session is useless once Harness locks, but it need not sit on disk).
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    const h = details.responseHeaders || {};
    const key = Object.keys(h).find((k) => k.toLowerCase() === 'set-cookie');
    if (!key || !security.isAppUrl(details.url, appOrigin)) return callback({});
    h[key] = h[key].map((c) => (/^\s*harness_session=/.test(c) ? c.replace(/;\s*(max-age|expires)=[^;]*/gi, '') : c));
    return callback({ responseHeaders: h });
  });
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let ok = true;
    try {
      const u = new URL(details.url);
      if (/^(https?|wss?):$/.test(u.protocol)) {
        const asHttp = u.protocol.startsWith('ws') ? `http${u.protocol === 'wss:' ? 's' : ''}://${u.host}` : u.origin;
        ok = asHttp === appOrigin;
      } else if (u.protocol === 'file:') {
        ok = false;
      }
    } catch { ok = false; }
    if (!ok && !warned.has(details.url) && warned.size < 50) { warned.add(details.url); console.warn(`[desktop] blocked request to ${details.url.slice(0, 200)}`); }
    callback({ cancel: !ok });
  });
}

function registerIpc() {
  const fromApp = (e) => !!win && e.sender === win.webContents && security.isAppUrl(e.senderFrame?.url, appOrigin);
  ipcMain.handle('harness:open-external', (e, url) => (fromApp(e) ? openExternal(url) : false));
  ipcMain.handle('harness:show-in-folder', (e, p) => {
    if (!fromApp(e)) return false;
    const resolved = security.resolveInsideDir(p, dataDir);
    if (!resolved) return false;
    hooks.showItemInFolder(resolved);
    return true;
  });
  ipcMain.handle('harness:set-badge', (e, text) => {
    if (!fromApp(e)) return false;
    const s = security.sanitizeBadge(text);
    if (s === null) return false;
    setBadge(s);
    return true;
  });
}

function registerGlobalShortcut() {
  if (!desktop.globalShortcut) return;
  try {
    if (globalShortcut.register(desktop.globalShortcut, toggleWindow)) registeredShortcut = desktop.globalShortcut;
    else console.warn(`[desktop] global shortcut ${desktop.globalShortcut} is already used by another app; change it in ${paths.desktopConfig}`);
  } catch (e) {
    console.warn(`[desktop] invalid global shortcut ${desktop.globalShortcut}: ${e.message}`);
  }
}

// ------------------------------------------------------------------------------------------- start-up
/**
 * Start the backend in this process, or — when another process holds the data folder — return who holds it.
 * The window only ever shows the backend this app started: another holder is never loaded and never sent a
 * credential (it could be any program that wrote harness.lock); the app explains and quits (alreadyOpen()).
 * @returns {Promise<{ url: string } | { other: object }>}
 */
async function startBackend() {
  const r = await startOrRefuse({
    dataDir,
    port: desktop.port,
    findRunning: findRunningHarness,
    findApp: findAppHarness,
    startServer: async (opts) => (await import(pathToFileURL(path.join(ROOT, 'server', 'index.mjs')).href)).startServer(opts),
    // Test hook: skip the probe so the e2e test exercises the backend's own HARNESS_ALREADY_RUNNING path.
    probeFirst: !(E2E_SCRIPT && process.env.HARNESS_E2E_SKIP_PROBE === '1'),
  });
  if (r.other) return { other: r.other };
  server = r.server;
  return { url: server.url };
}

/** Another process holds the data folder: one native dialog, then quit. */
async function alreadyOpen(other) {
  const { title, message } = alreadyOpenMessage(other);
  console.log(`[desktop] ${title}: ${message}`);
  if (!headless) {
    await dialog.showMessageBox({ type: 'info', title, message: title, detail: message, buttons: ['Quit'], defaultId: 0, cancelId: 0 });
  }
}

async function reportStartupError(err) {
  console.error('[desktop] server failed to start:', err);
  if (headless) return;
  const hint = err?.code === 'EACCES' || err?.code === 'EPERM'
    ? `Harness cannot write to its data folder. Check its permissions:\n${dataDir}`
    : `Data folder: ${dataDir}`;
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'Harness',
    message: 'Harness could not start its local server.',
    detail: `${err?.message || err}\n\n${hint}\nLog file: ${paths.logFile}\n\nIf this keeps happening, run "npm run doctor" in the Harness folder.`,
    buttons: ['Quit', 'Show Log File'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) showLogFile();
}

async function onReady() {
  if (isMac) {
    app.setAboutPanelOptions({
      applicationName: 'Harness',
      applicationVersion: app.getVersion(),
      version: `Electron ${process.versions.electron}`,
      credits: 'Chat with open-source models on your own Mac.',
    });
    if (!app.isPackaged && fs.existsSync(path.join(ROOT, 'build', 'icon.png'))) app.dock?.setIcon(path.join(ROOT, 'build', 'icon.png'));
    app.dock?.setMenu(Menu.buildFromTemplate(menus.buildDockMenuTemplate({ send: sendToPage })));
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(menus.buildAppMenuTemplate({ isMac, appName: 'Harness', send: sendToPage, showDataFolder, showLogFile })));

  let started;
  try {
    started = await startBackend();
  } catch (err) {
    await reportStartupError(err);
    shutdownDone = true;
    logger?.close();
    app.exit(1);
    return;
  }
  if (started.other) {
    await alreadyOpen(started.other);
    shutdownDone = true;
    logger?.close();
    app.exit(0);
    return;
  }
  appUrl = started.url;
  appOrigin = new URL(appUrl).origin;
  lockDownSession(session.defaultSession);
  registerIpc();

  // 0.2: the backend's `app` (and its event bus) exists only while Harness is unlocked and is recreated on every
  // unlock, so re-attach on each state change: startServer().security.on('state' | 'locked' | 'unlocked')
  // (docs/API.md §10.5). With a 0.1 backend there are no such events and `app` is always there.
  activity = createActivityGuard({ isBusy: () => backendBusy(server.app)(), blocker: powerSaveBlocker });
  let bus = null;
  const onEvent = (ev) => {
    if (ACTIVITY_EVENTS.has(ev.type)) activity.update();
    if (ev.type === 'settings.updated') applyTheme(ev.data?.settings);
  };
  const attachBus = () => {
    const b = server.app?.bus;
    if (!b || b === bus) return;
    bus?.off?.('event', onEvent);
    bus = b;
    b.on('event', onEvent);
    try { applyTheme(server.app.settings?.get?.()); } catch { /* settings not readable yet */ }
  };
  attachBus();
  const events = server.security?.on ? server.security : null;
  events?.on('unlocked', () => { attachBus(); activity.update(); });
  events?.on('state', (st) => { if (st?.state === 'unlocked') attachBus(); activity.update(); });
  events?.on('locked', () => { bus = null; activity.update(); });
  nativeTheme.on('updated', () => { if (win && !win.isDestroyed()) win.setBackgroundColor(backgroundColor()); });
  // Lock when the Mac sleeps or its screen locks (Electron's powerMonitor; 'lock-screen' exists on macOS and Windows).
  powerMonitor.on('suspend', () => { lockHarness('system sleep'); });
  powerMonitor.on('lock-screen', () => { lockHarness('screen locked'); });

  createWindow(await windowSessionUrl());
  registerGlobalShortcut();

  if (E2E_SCRIPT) {
    require(path.resolve(E2E_SCRIPT))({
      app, hooks, dataDir, paths, desktop, appUrl, lockHarness, windowSessionUrl, powerMonitor,
      get server() { return server; }, get window() { return win; }, get activity() { return activity; },
      get registeredShortcut() { return registeredShortcut; }, Menu,
    });
  }
}

// ------------------------------------------------------------------------------------------- lifecycle
app.on('second-instance', () => showWindow());
app.on('activate', () => showWindow()); // Dock icon click (macOS)
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});

app.on('before-quit', (e) => {
  quitting = true;
  if (shutdownDone) return;
  e.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  (async () => {
    saveStateNow();
    activity?.dispose();
    globalShortcut.unregisterAll();
    if (server) {
      console.log('[desktop] stopping the local server…');
      await Promise.race([server.close(), new Promise((r) => setTimeout(r, 10000).unref())]).catch((err) => console.error('[desktop] server close failed:', err));
    }
  })().finally(() => {
    shutdownDone = true;
    console.log('[desktop] bye');
    logger?.close();
    app.quit();
  });
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.quit()); // Ctrl+C in `npm run app`

app.whenReady().then(onReady).catch((err) => {
  console.error(err);
  app.exit(1);
});
