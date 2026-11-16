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
import { startServer } from '../../server/index.mjs';
import { deepMerge } from '../../server/lib/util.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
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
 * @param {boolean} [o.ollamaBinary]   install a fake `ollama` binary (Ollama "installed but stopped")
 */
export async function startStack({ ram = 16, models, ollama = true, image = true, delayMs = 2, stepMs = 30, pullStepMs = 60, settings = {}, ollamaBinary = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-ui-'));
  const fake = ollama ? await startFakeOllama({ port: 0, delayMs, models, pullStepMs }) : null;
  const a1111 = image ? await startFakeA1111({ port: 0, stepMs, drawThings: true }) : null;
  let ollamaUrl = fake?.url || `http://127.0.0.1:${await freePort()}`;
  const extra = {};
  if (ollamaBinary) {
    const bin = path.join(dataDir, 'ollama');
    await fs.writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, '..', 'fake-ollama-bin.mjs')}" "$@"\n`);
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
  const srv = await startServer({ port: 0, dataDir, autodetect: true, logLevel: 'error', system: { totalMem: ram * GiB, platform: 'darwin', arch: 'arm64' }, processGuards: false });
  const api = async (method, p, body) => {
    const res = await fetch(srv.url + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
  };
  const sys = { totalMem: ram * GiB, platform: 'darwin', arch: 'arm64' };
  const stack = {
    url: srv.url, dataDir, fake, a1111, srv, api,
    /** Stop the Harness server (the page sees it disappear). */
    async stopServer() { await stack.srv.close(); },
    /** Start it again on the same port and data dir. */
    async startServerAgain() {
      const port = Number(new URL(stack.url).port);
      stack.srv = await startServer({ port, dataDir, autodetect: true, logLevel: 'error', system: sys, processGuards: false });
      if (stack.srv.url !== stack.url) throw new Error(`restarted on ${stack.srv.url}, expected ${stack.url}`);
    },
    async close() {
      await stack.srv.close().catch(() => {});
      await fake?.close().catch(() => {});
      await a1111?.close().catch(() => {});
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
  return stack;
}

let browserPromise = null;
export function browser() {
  browserPromise ||= chromium.launch();
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
};

/** Open the UI in a fresh browser context. */
export async function openApp(stack, { hash = '', colorScheme = 'light', width = 1280, height = 800, desktop = false, reducedMotion = 'reduce' } = {}) {
  const b = await browser();
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme, reducedMotion, acceptDownloads: true });
  await ctx.addInitScript(CSP_INIT);
  if (desktop) await ctx.addInitScript(DESKTOP_INIT);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`${stack.url}/${hash}`);
  await page.waitForSelector('html.ready');
  return {
    page, ctx, errors, requests,
    /** No uncaught errors, console errors or CSP violations happened. */
    async assertClean(assert) {
      const csp = await page.evaluate(() => window.__csp || []).catch(() => []);
      assert.deepEqual([...errors, ...csp.map((c) => `csp: ${c}`)], []);
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
  const input = page.locator('.composer-input');
  await input.click();
  await input.fill(text);
  await input.press('Enter');
  if (wait) await waitIdle(page);
}

/** Wait until the current chat is not generating (send button is not a stop button) and the DOM settled. */
export async function waitIdle(page, timeout = 20000) {
  await page.waitForFunction(() => {
    const b = document.querySelector('.send-btn');
    return b && !b.classList.contains('stop') && !document.querySelector('.turn-status .spinner');
  }, null, { timeout });
  await page.waitForTimeout(150);
}

export function lastTurn(page) { return page.locator('.turn').last(); }

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 10000, interval = 50 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('waitFor timed out');
    await sleep(interval);
  }
}
