#!/usr/bin/env node
// Harness backend entry point.
//   import { startServer } from './server/index.mjs'
//   const { port, url, close } = await startServer({ port: 4747, dataDir, openBrowser: false })
// or: node server/index.mjs [--port 4747] [--data-dir DIR] [--open]
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defaultDataDir } from './app.mjs';
import { Core } from './core.mjs';
import { ensureDir } from './lib/fsx.mjs';
import { acquireDataDirLock } from './lib/instance-lock.mjs';
export { AlreadyRunningError } from './lib/instance-lock.mjs';
import { Router, sendJson, sendError, checkRequestOrigin, serveStatic, isAllowedOrigin } from './http/http.mjs';
import { Reply } from './routes/common.mjs';
import { registerSystemRoutes } from './routes/system.mjs';
import { registerModelRoutes } from './routes/models.mjs';
import { registerChatRoutes } from './routes/chats.mjs';
import { registerMemoryRoutes } from './routes/memories.mjs';
import { registerImageRoutes } from './routes/images.mjs';
import { registerSecurityRoutes, registerAppSecurityRoutes } from './routes/security.mjs';
import { registerCatalogRoutes } from './routes/catalog.mjs';
import { HttpError } from './lib/errors.mjs';
import { log, setLogLevel } from './lib/log.mjs';

export const DEFAULT_PORT = 4747;

/** Routes over the user's data: rebuilt for every unlocked `app` (each lock closes the app). */
function buildAppRouter(app) {
  const r = new Router();
  registerSystemRoutes(r, app);
  registerModelRoutes(r, app);
  registerChatRoutes(r, app);
  registerMemoryRoutes(r, app);
  registerImageRoutes(r, app);
  registerAppSecurityRoutes(r, app);
  registerCatalogRoutes(r, app);
  return r;
}

/** Routes that exist in every state (setup, unlock, lock, sessions, the internet blocker). */
function buildCoreRouter(core) {
  const r = new Router();
  registerSecurityRoutes(r, core);
  return r;
}

// Requests that do not keep Harness awake (status polling, the event stream).
const PASSIVE = /^(GET \/api\/(health|security|auth\/status|events|network))$/;

/**
 * The request handler shared by the HTTP listener and the bridge (`bridge: true` skips the Host/Origin checks and
 * sessions — no network is involved — but not the lock).
 */
export function makeHandler(core, { bridge = false } = {}) {
  const coreRouter = buildCoreRouter(core);
  const routerFor = (app) => (app.router ||= buildAppRouter(app));
  const handle = async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(res, 400, { error: { code: 'bad_request', message: 'Bad URL' } }); }
    if (!bridge) {
      const allowed = core.allowedOrigins();
      const ownPort = core.port ?? req.socket?.localPort;
      const reason = checkRequestOrigin(req, { ownPort, allowed });
      if (reason) return sendJson(res, 403, { error: { code: 'forbidden', message: reason } });
      const origin = req.headers.origin;
      if (origin && isAllowedOrigin(origin, { ownPort, allowed })) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'Origin');
        res.setHeader('access-control-allow-credentials', 'true');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type, x-filename, authorization, x-harness-confirm, x-harness-backup-passphrase', 'access-control-max-age': '600' });
        return res.end();
      }
    }
    if (url.pathname.startsWith('/api/')) {
      const done = core.requestStarted(!PASSIVE.test(`${req.method} ${url.pathname}`));
      res.once('close', done);
      res.once('finish', done);
      try {
        let m = coreRouter.match(req.method, url.pathname);
        let app = null;
        if (!m || m.allowed) {
          app = core.app;
          if (!app || core.state !== 'unlocked') core.requireApp(); // 423 locked / needs_setup / migrating
          const m2 = routerFor(app).match(req.method, url.pathname);
          if (m2 && !m2.allowed) m = m2;
          else if (!m) m = m2;
          else if (m2?.allowed) m = { allowed: [...new Set([...m.allowed, ...m2.allowed])] };
        }
        if (!m) return sendJson(res, 404, { error: { code: 'not_found', message: `No route for ${req.method} ${url.pathname}` } });
        if (m.allowed) return sendJson(res, 405, { error: { code: 'method_not_allowed', message: `Use ${m.allowed.join(', ')}` } }, { allow: m.allowed.join(', ') });
        const opts = m.route.opts || {};
        const auth = bridge ? { ok: true, via: 'bridge', sessionHash: 'bridge' } : core.auth.check(req);
        if (!opts.open && !auth.ok) throw new HttpError(401, 'auth_required', core.mode === 'password' ? 'Enter your Harness password to continue.' : 'Open Harness from its launcher to continue.', { reason: auth.reason || 'missing', unlock: core.mode === 'password' });
        if (!opts.open && !opts.whileLocked && !app) { app = core.requireApp(); }
        const out = await m.route.handler({ req, res, params: m.params, query: url.searchParams, url, app: app || core.app, core, auth, bridge });
        if (res.headersSent || res.writableEnded) return;
        if (out instanceof Reply) return sendJson(res, out.status, out.body, out.headers);
        if (out === undefined) return sendJson(res, 200, { ok: true });
        return sendJson(res, 200, out);
      } catch (e) {
        if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
        return sendError(res, e);
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Static files are GET only' } });
    const served = await serveStatic(req, res, core.publicDir, url.pathname).catch(() => false);
    if (!served && !res.headersSent) sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } });
  };
  // Last line of defence: nothing a request does may take the process (or the Electron app hosting it) down.
  return (req, res) => {
    let p;
    try { p = handle(req, res); } catch (e) { p = Promise.reject(e); }
    p.catch((e) => {
      log.error('Unhandled request error:', e?.stack || e);
      try { if (!res.headersSent) sendError(res, e); else res.destroy(); } catch { /* ignore */ }
    });
  };
}

// Process-level guards, installed only after the server is listening (start-up failures still surface normally).
let guardRefs = 0;
const onUnhandledRejection = (e) => log.error('Unhandled promise rejection (kept running):', e?.stack || e);
const onUncaughtException = (e) => log.error('Uncaught exception (kept running):', e?.stack || e);
export function installProcessGuards() {
  if (guardRefs++ === 0) {
    process.on('unhandledRejection', onUnhandledRejection);
    process.on('uncaughtException', onUncaughtException);
  }
}
export function removeProcessGuards() {
  if (guardRefs > 0 && --guardRefs === 0) {
    process.off('unhandledRejection', onUnhandledRejection);
    process.off('uncaughtException', onUncaughtException);
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve(server.address().port); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}

export function openInBrowser(url, { spawnFn = spawn, platform = process.platform } = {}) {
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const hint = (why) => log.warn(`Could not open a browser (${why}); open ${url} yourself.`);
  try {
    const child = spawnFn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (e) => hint(e.code || e.message));
    child.unref?.();
  } catch (e) {
    hint(e.code || e.message);
  }
}

/**
 * Start the Harness server bound to 127.0.0.1.
 * @param {object} [o]
 * @param {number} [o.port=4747] preferred port; if busy, tries the next 10, then any free port. 0 = any free port.
 * @param {string} [o.dataDir] data directory (default: ~/Library/Application Support/Harness on macOS)
 * @param {boolean} [o.openBrowser=false] open the UI (keychain/off modes: with a one-time launch code)
 * @param {object} [o.system] test overrides: { totalMem, platform, arch }
 * @param {boolean} [o.autodetect=true] probe default ports of other local servers
 * @param {string} [o.logLevel]
 * @param {{ mode?: 'password'|'keychain'|'off', apiAuth?: boolean, kdf?: object }} [o.security]
 *        explicit opt-outs for tests and development stacks (docs/API.md §10.10)
 * @param {boolean} [o.offlineLock] false = do not block internet access (tests / development)
 * @param {object} [o.keychain] keychain-mode key store override (tests)
 * @returns {Promise<{ port, url, close, app, core, auth: { createSession, launchUrl } }>} `app` is the unlocked
 *          app (null while locked) — read it from the returned object each time.
 */
export async function startServer({ port = DEFAULT_PORT, dataDir, openBrowser = false, system, autodetect = true, logLevel, publicDir, processGuards = true, security, offlineLock, keychain } = {}) {
  if (logLevel) setLogLevel(logLevel);
  const dir = path.resolve(dataDir || defaultDataDir());
  await ensureDir(dir);
  // One server per data dir; throws AlreadyRunningError (code HARNESS_ALREADY_RUNNING, .url) otherwise.
  const lock = await acquireDataDirLock(dir);
  let core;
  let server;
  let actual;
  try {
    core = new Core({ dataDir: dir, system, autodetect, publicDir, transport: 'listener', security, offlineLock, keychain });
    await core.init();
    server = http.createServer(makeHandler(core));
    server.keepAliveTimeout = 5000;
    server.requestTimeout = 0; // long-lived SSE streams
    server.on('clientError', (err, socket) => {
      if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
    const candidates = port === 0 ? [0] : [...Array.from({ length: 11 }, (_, i) => port + i), 0];
    for (const p of candidates) {
      try { actual = await listen(server, p); break; } catch (e) { if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e; }
    }
  } catch (e) {
    await core?.close().catch(() => {});
    lock.release();
    throw e;
  }
  const url = `http://127.0.0.1:${actual}`;
  core.url = url;
  core.port = actual;
  if (core.app) { core.app.url = url; core.app.port = actual; }
  lock.update({ url, port: actual });
  if (processGuards) installProcessGuards();
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  log.info(`Harness ${core.version} listening on ${url} (${core.state}, encryption: ${core.mode})`);
  const auth = {
    /** A session for an in-process shell (Electron). Throws while locked in password mode. */
    createSession() {
      if (core.state !== 'unlocked' && core.state !== 'migrating' && core.mode === 'password') throw new HttpError(423, 'locked', 'Harness is locked.');
      const s = core.auth.createSession();
      return { name: 'harness_session', value: s.token, maxAgeSec: Math.round((Date.parse(s.expiresAt) - Date.now()) / 1000), expiresAt: s.expiresAt };
    },
    /** A one-time launch URL (keychain/off modes; in password mode the browser's lock screen creates the session). */
    launchUrl() {
      if (core.mode === 'password') throw new HttpError(409, 'password_mode', 'Password mode: the browser gets its session by unlocking.');
      return `${url}/#launch=${core.auth.mintLaunchCode().code}`;
    },
  };
  if (openBrowser) {
    let target = url;
    try { if (core.mode !== 'password') target = auth.launchUrl(); } catch { /* plain URL */ }
    openInBrowser(target);
  }
  let closing = null;
  const close = () => {
    closing ||= (async () => {
      await new Promise((r) => { server.close(() => r()); for (const s of sockets) s.destroy(); });
      try { await core.close(); } finally {
        lock.release();
        if (processGuards) removeProcessGuards();
      }
    })();
    return closing;
  };
  // Lock state for an in-process shell (Electron): `security.state` now; events 'state' { state, mode },
  // 'locked' { reason }, 'unlocked' {} via on()/off(); `security.lock(reason)` locks without an HTTP round trip.
  const shell = {
    get state() { return core.state; },
    get mode() { return core.mode; },
    lock: (reason = 'app') => core.lock(reason),
    on: (event, fn) => { core.on(event, fn); return () => core.off(event, fn); },
    off: (event, fn) => core.off(event, fn),
  };
  return { port: actual, url, close, core, auth, security: shell, on: shell.on, off: shell.off, get app() { return core.app; } };
}

// ---------------------------------------------------------------------------------------------- CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const get = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const dataDir = get('--data-dir') || process.env.HARNESS_DATA_DIR || undefined;
  if (args.includes('--bridge')) {
    // Native app: frames on stdin/stdout, no listening socket (docs/BRIDGE.md).
    import('./bridge/server.mjs').then(({ runBridge }) => runBridge({ dataDir })).catch((e) => { console.error(e); process.exit(1); });
  } else {
    const port = Number(get('--port') || process.env.HARNESS_PORT || DEFAULT_PORT);
    const openBrowser = args.includes('--open') || process.env.HARNESS_OPEN === '1';
    startServer({ port, dataDir, openBrowser }).then(({ url, close }) => {
      console.log(`Harness running at ${url}`);
      const stop = async () => { await close(); process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    }).catch((e) => {
      if (e?.code === 'HARNESS_ALREADY_RUNNING') {
        console.log(e.url ? `Harness is already running at ${e.url} (same data folder).` : e.message);
        if (openBrowser && e.url) openInBrowser(e.url);
        process.exitCode = 0;
        return;
      }
      console.error(e);
      process.exit(1);
    });
  }
}
