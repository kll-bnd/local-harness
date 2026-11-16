// End-to-end harness for the web UI: each test starts its own stack (fake Ollama + fake Draw Things +
// the real Harness server, on free ports, with a temp data dir) and drives Chromium with Playwright.
//
//   const stack = await startStack({ ram: 8 });
//   const app = await openApp(stack);            // { page, ctx, errors, assertClean, shot }
//   ...
//   await app.close(); await stack.close();
//
// Playwright + Chromium are installed globally (resolved via createRequire, not a package dependency).
// Set HARNESS_UI_SHOTS=/some/dir to save screenshots taken with app.shot(name).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startFakeOllama } from '../fake-ollama.mjs';
import { startFakeA1111 } from '../fake-a1111.mjs';
import { startFakeCatalog } from './fake-catalog.mjs';
import { startServer } from '../../server/index.mjs';
import { deepMerge } from '../../server/lib/util.mjs';

const require = createRequire(import.meta.url);
// HARNESS_UI_BROWSER=webkit runs the suite in the Safari engine (the browser fallback path on a Mac).
const browserName = process.env.HARNESS_UI_BROWSER || 'chromium';
const browserType = require('playwright')[browserName];
if (!browserType) throw new Error(`Unknown HARNESS_UI_BROWSER "${browserName}" (use chromium, webkit or firefox)`);
const here = path.dirname(fileURLToPath(import.meta.url));
export const GiB = 1024 ** 3;

process.env.HARNESS_NO_OLLAMA_AUTOSTART = '1';
process.env.HARNESS_LOG_LEVEL ||= 'error';

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/**
 * @param {object} o
 * @param {number} [o.ram=16]          simulated RAM in GB (8 = the target M1 MacBook)
 * @param {object} [o.models]          fake Ollama model table ({} = nothing installed)
 * @param {boolean} [o.ollama=true]    run the fake Ollama
 * @param {boolean} [o.image=true]     run the fake Draw Things (A1111 API)
 * @param {number} [o.delayMs=2]       fake Ollama delay per streamed chunk
 * @param {number} [o.stepMs=30]       fake diffusion step time
 * @param {object} [o.settings]        merged into settings.json before the server starts
 * @param {boolean|'slow-gpu'} [o.ollamaBinary]  install a fake `ollama` binary (Ollama "installed but stopped");
 *                                     'slow-gpu': one whose GPU discovery takes FAKE_GPU_DELAY_MS
 * @param {boolean} [o.secure=false]   0.2 defaults ON: password protection, API sessions and "Block all internet
 *                                     access" (the UI meets the setup screen first). Off = the explicit opt-out of
 *                                     docs/API.md 10.10, so flows that are not about security start in the app.
 * @param {boolean} [o.offlineLock]    override the internet blocker (secure stacks default to on)
 * @param {(dir: string) => Promise} [o.prepare]  write files into the data dir before the server starts
 * @param {string} [o.reuseDataDir]    start on an existing data dir (e.g. one an opt-out stack left as 0.1 did)
 * @param {boolean} [o.catalog=false]  run a fake Hugging Face + ollama.com (the model catalogue's sources)
 */
export async function startStack({ ram = 16, models, ollama = true, image = true, delayMs = 2, stepMs = 30, pullStepMs = 60, settings = {}, ollamaBinary = false, secure = false, offlineLock, prepare, reuseDataDir = null, catalog = false } = {}) {
  const dataDir = reuseDataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'harness-ui-'));
  const fake = ollama ? await startFakeOllama({ port: 0, delayMs, models, pullStepMs }) : null;
  const a1111 = image ? await startFakeA1111({ port: 0, stepMs, drawThings: true }) : null;
  const catalogFake = catalog ? await startFakeCatalog() : null;
  if (catalogFake) {
    // The backend reads these on every catalogue request (tests in one file run one at a time).
    process.env.HARNESS_CATALOG_HF_BASE = catalogFake.url;
    process.env.HARNESS_CATALOG_HF_REGISTRY = catalogFake.url;
    process.env.HARNESS_CATALOG_OLLAMA_BASE = catalogFake.url;
  }
  let ollamaUrl = fake?.url || `http://127.0.0.1:${await freePort()}`;
  const extra = {};
  let binDir = null;
  if (ollamaBinary) {
    // Outside the data dir: Harness 0.2 makes every file in there 0600 (not executable).
    binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-bin-'));
    const bin = path.join(binDir, 'ollama');
    // 'slow-gpu': listens at once but answers only after FAKE_GPU_DELAY_MS (another app loading onto the GPU).
    const script = ollamaBinary === 'slow-gpu' ? path.join(here, 'fake-ollama-slow-gpu.mjs') : path.join(here, '..', 'fake-ollama-bin.mjs');
    await fs.writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await fs.chmod(bin, 0o755);
    extra.ollama = { binaryPath: bin, autoStart: false, stopOnExit: true };
  }
  const base = {
    providers: { autodetect: true, builtin: { ollama: { baseUrl: ollamaUrl }, llamacpp: { enabled: false }, lmstudio: { enabled: false } } },
    image: { autodetect: true, builtin: { a1111: { enabled: !!a1111, baseUrl: a1111?.url || `http://127.0.0.1:${await freePort()}` }, comfyui: { enabled: false } } },
    ollama: { autoStart: false },
    embeddings: { model: 'off' },
    memory: { extractDelayMs: 200 },
  };
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify(deepMerge(deepMerge(base, extra), settings), null, 2));
  if (prepare) await prepare(dataDir);
  // Secure stacks use cheap scrypt parameters so unlocking in tests takes milliseconds, not half a second.
  const securityOpts = secure
    ? { security: { kdf: { N: 1024, r: 8, p: 1 } }, ...(offlineLock === undefined ? {} : { offlineLock }) }
    : { security: { mode: 'off', apiAuth: false }, offlineLock: offlineLock ?? false };
  const sys = { totalMem: ram * GiB, platform: 'darwin', arch: 'arm64' };
  const srv = await startServer({ port: 0, dataDir, autodetect: true, logLevel: 'error', system: sys, processGuards: false, keychain: 'file', ...securityOpts });
  let token = null; // a CLI-style session for stack.api() on secure stacks
  const api = async (method, p, body, headers = {}) => {
    const h = { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
    const res = await fetch(stack.url + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
  };
  const stack = {
    url: srv.url, dataDir, fake, a1111, srv, api, secure, catalog: catalogFake,
    /** Secure stacks: choose the password from outside the UI (→ the recovery key); stack.api() then has a session. */
    async setupPassword(password) {
      const r = await api('POST', '/api/security/setup', { password, session: 'token' });
      if (r.status !== 200) throw new Error(`setup failed: ${r.status} ${JSON.stringify(r.data)}`);
      token = r.data.sessionToken || null;
      await stack.waitUnlocked();
      return r.data;
    },
    /** Wait until a migration (encrypting existing files) is over. */
    async waitUnlocked(timeout = 20000) {
      const t0 = Date.now();
      while ((await api('GET', '/api/security')).data.state === 'migrating') {
        if (Date.now() - t0 > timeout) throw new Error('still migrating');
        await sleep(100);
      }
    },
    /** Secure stacks: give stack.api() a session by unlocking (also unlocks a locked Harness). */
    async unlock(password) {
      const r = await api('POST', '/api/security/unlock', { password, session: 'token' });
      if (r.status !== 200) throw new Error(`unlock failed: ${r.status} ${JSON.stringify(r.data)}`);
      token = r.data.sessionToken || token;
      await stack.waitUnlocked();
      return r.data;
    },
    setToken(t) { token = t; },
    /** Stop the Harness server (the page sees it disappear). */
    async stopServer() { await stack.srv.close(); },
    /** Start it again on the same port and data dir. */
    async startServerAgain() {
      const port = Number(new URL(stack.url).port);
      stack.srv = await startServer({ port, dataDir, autodetect: true, logLevel: 'error', system: sys, processGuards: false, keychain: 'file', ...securityOpts });
      if (stack.srv.url !== stack.url) throw new Error(`restarted on ${stack.srv.url}, expected ${stack.url}`);
    },
    async close() {
      await stack.srv.close().catch(() => {});
      await fake?.close().catch(() => {});
      await a1111?.close().catch(() => {});
      if (catalogFake) {
        await catalogFake.close().catch(() => {});
        for (const k of ['HARNESS_CATALOG_HF_BASE', 'HARNESS_CATALOG_HF_REGISTRY', 'HARNESS_CATALOG_OLLAMA_BASE']) if (process.env[k] === catalogFake.url) delete process.env[k];
      }
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
      if (binDir) await fs.rm(binDir, { recursive: true, force: true }).catch(() => {});
    },
  };
  return stack;
}

let browserPromise = null;
export function browser() {
  browserPromise ||= browserType.launch();
  return browserPromise;
}
export async function closeBrowser() {
  if (browserPromise) { const b = await browserPromise; browserPromise = null; await b.close(); }
}

const DESKTOP_INIT = () => {
  const add = () => { if (!document.documentElement) return setTimeout(add, 0); document.documentElement.classList.add('desktop', 'desktop-mac'); return null; };
  add();
  window.__menu = null;
  window.__desktopCalls = [];
  window.harnessDesktop = {
    platform: 'darwin',
    appVersion: '0.0.0-test',
    onMenuAction(cb) { window.__menu = cb; },
    openExternal(url) { window.__desktopCalls.push(['openExternal', url]); },
    showInFolder(p) { window.__desktopCalls.push(['showInFolder', p]); },
    setBadge(t) { window.__desktopCalls.push(['setBadge', t]); },
  };
};

const CSP_INIT = () => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  // Record what kind of body every request carries: WKWebView drops Blob/File/FormData bodies on custom
  // schemes, so the UI must only ever send strings or bytes (checked by a test).
  window.__bodyKinds = [];
  const orig = window.fetch;
  window.fetch = function (input, init) {
    const b = init && init.body;
    if (b != null) window.__bodyKinds.push(Object.prototype.toString.call(b));
    return orig.apply(this, arguments);
  };
};

/** Open the UI in a fresh browser context. */
export async function openApp(stack, { hash = '', colorScheme = 'light', width = 1280, height = 800, desktop = false, reducedMotion = 'reduce' } = {}) {
  const b = await browser();
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme, reducedMotion, acceptDownloads: true });
  await ctx.addInitScript(CSP_INIT);
  if (desktop) await ctx.addInitScript(DESKTOP_INIT);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000); // generous: a busy CI Mac or an 8 GB M1 under memory pressure is slow
  const errors = [];
  const requests = [];
  // WebKit reports every same-origin request that a navigation (a reload, page.goto, Harness locking) cancels
  // as an error "… due to access control checks." — noise, not a fault of the page: it is ignored when it
  // happens around a navigation of the page. (The UI makes no cross-origin requests at all.)
  const navigations = [];
  const raw = []; // { text, at } — classified when asserted (the navigation may be reported after its noise)
  const navNoise = ({ text, at }) => /\/api\/\S* due to access control checks\.?$/.test(text) && navigations.some((t) => Math.abs(at - t) < 3000);
  page.on('request', (r) => {
    requests.push(r.url());
    try { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navigations.push(Date.now()); } catch { /* frame gone */ }
  });
  const record = (text) => { raw.push({ text, at: Date.now() }); errors.push(text); };
  page.on('pageerror', (e) => record(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) record(`console: ${m.text()}`); });
  await page.goto(`${stack.url}/${hash}`);
  await page.waitForSelector('html.ready');
  return {
    page, ctx, errors, requests,
    /** No uncaught errors, console errors or CSP violations happened. */
    async assertClean(assert) {
      const csp = await page.evaluate(() => window.__csp || []).catch(() => []);
      assert.deepEqual([...raw.filter((e) => !navNoise(e)).map((e) => e.text), ...csp.map((c) => `csp: ${c}`)], []);
    },
    async shot(name) {
      if (!process.env.HARNESS_UI_SHOTS) return;
      await fs.mkdir(process.env.HARNESS_UI_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.HARNESS_UI_SHOTS, `${name}.png`) });
    },
    async close() { await ctx.close().catch(() => {}); },
  };
}

// ------------------------------------------------------------------------------------------------ helpers
/** Type into the composer and send with Enter. */
export async function send(page, text, { wait = true } = {}) {
  const before = await page.evaluate(() => document.querySelectorAll('.turn').length);
  const input = page.locator('.composer-input');
  await input.click();
  await input.fill(text);
  await input.press('Enter');
  if (!wait) return;
  // First the message's turn appears — otherwise "idle" could be the moment before the request started.
  await page.waitForFunction((n) => document.querySelectorAll('.turn').length > n, before);
  await waitIdle(page);
}

/** Wait until the current chat is not generating (send button is not a stop button) and the DOM settled. */
export async function waitIdle(page, timeout = 30000) {
  // Not generating, and the last turn shows its final render (rendering follows the stream frame by frame,
  // which a busy machine delays).
  await page.waitForFunction(() => {
    const b = document.querySelector('.send-btn');
    const turns = document.querySelectorAll('.turn');
    const last = turns[turns.length - 1];
    return b && !b.classList.contains('stop') && !document.querySelector('.turn-status .spinner') && (!last || last.dataset.state !== 'live');
  }, null, { timeout });
  await page.waitForTimeout(150);
}

export function lastTurn(page) { return page.locator('.turn').last(); }

/** Whether the page considers itself on a Mac — decided the way the app decides (navigator.platform). */
export function pageIsMac(page) {
  return page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
}

/**
 * Press a shortcut written the way the app writes them ("Mod+K", "Mod+Ctrl+L", "Mod+Shift+F"): `Mod` is ⌘ on a
 * Mac and Ctrl elsewhere, `Ctrl` is the Control key — for whatever platform the page runs on.
 */
export async function pressChord(page, chord) {
  const mac = await pageIsMac(page);
  const keys = chord.split('+').map((k) => {
    if (k === 'Mod') return mac ? 'Meta' : 'Control';
    if (k === 'Ctrl') return 'Control';
    if (/^[A-Z]$/.test(k)) return `Key${k}`;
    if (/^[0-9]$/.test(k)) return `Digit${k}`;
    return k;
  });
  await page.keyboard.press(keys.join('+'));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 20000, interval = 50 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('waitFor timed out');
    await sleep(interval);
  }
}
