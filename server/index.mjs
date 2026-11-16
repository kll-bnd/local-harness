#!/usr/bin/env node
// Harness backend entry point.
//   import { startServer } from './server/index.mjs'
//   const { port, url, close } = await startServer({ port: 4747, dataDir, openBrowser: false })
// or: node server/index.mjs [--port 4747] [--data-dir DIR] [--open]
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from './app.mjs';
import { Router, sendJson, sendError, checkRequestOrigin, serveStatic, isAllowedOrigin } from './http/http.mjs';
import { Reply } from './routes/common.mjs';
import { registerSystemRoutes } from './routes/system.mjs';
import { registerModelRoutes } from './routes/models.mjs';
import { registerChatRoutes } from './routes/chats.mjs';
import { registerMemoryRoutes } from './routes/memories.mjs';
import { registerImageRoutes } from './routes/images.mjs';
import { log, setLogLevel } from './lib/log.mjs';

export const DEFAULT_PORT = 4747;

function buildRouter(app) {
  const r = new Router();
  registerSystemRoutes(r, app);
  registerModelRoutes(r, app);
  registerChatRoutes(r, app);
  registerMemoryRoutes(r, app);
  registerImageRoutes(r, app);
  return r;
}

function makeHandler(app, router) {
  return async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(res, 400, { error: { code: 'bad_request', message: 'Bad URL' } }); }
    const reason = checkRequestOrigin(req);
    if (reason) return sendJson(res, 403, { error: { code: 'forbidden', message: reason } });
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type, x-filename', 'access-control-max-age': '600' });
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) {
      const m = router.match(req.method, url.pathname);
      if (!m) return sendJson(res, 404, { error: { code: 'not_found', message: `No route for ${req.method} ${url.pathname}` } });
      if (m.allowed) return sendJson(res, 405, { error: { code: 'method_not_allowed', message: `Use ${m.allowed.join(', ')}` } }, { allow: m.allowed.join(', ') });
      try {
        const out = await m.route.handler({ req, res, params: m.params, query: url.searchParams, url, app });
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
    const served = await serveStatic(req, res, app.publicDir, url.pathname).catch(() => false);
    if (!served && !res.headersSent) sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } });
  };
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

function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
}

/**
 * Start the Harness server bound to 127.0.0.1.
 * @param {object} [o]
 * @param {number} [o.port=4747] preferred port; if busy, tries the next 10, then any free port. 0 = any free port.
 * @param {string} [o.dataDir] data directory (default: ~/Library/Application Support/Harness on macOS)
 * @param {boolean} [o.openBrowser=false]
 * @param {object} [o.system] test overrides: { totalMem, platform, arch }
 * @param {boolean} [o.autodetect=true] probe default ports of other local servers
 * @param {string} [o.logLevel]
 * @returns {Promise<{ port: number, url: string, close: () => Promise<void>, app: object }>}
 */
export async function startServer({ port = DEFAULT_PORT, dataDir, openBrowser = false, system, autodetect = true, logLevel, publicDir } = {}) {
  if (logLevel) setLogLevel(logLevel);
  const app = await createApp({ dataDir, system, autodetect, publicDir });
  const router = buildRouter(app);
  const server = http.createServer(makeHandler(app, router));
  server.keepAliveTimeout = 5000;
  server.requestTimeout = 0; // long-lived SSE streams
  let actual;
  const candidates = port === 0 ? [0] : [...Array.from({ length: 11 }, (_, i) => port + i), 0];
  for (const p of candidates) {
    try { actual = await listen(server, p); break; } catch (e) { if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e; }
  }
  const url = `http://127.0.0.1:${actual}`;
  app.url = url;
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  log.info(`Harness ${app.version} listening on ${url} (data: ${app.dataDir})`);
  if (openBrowser) openInBrowser(url);
  let closing = null;
  const close = () => {
    closing ||= (async () => {
      await new Promise((r) => { server.close(() => r()); for (const s of sockets) s.destroy(); });
      await app.close();
    })();
    return closing;
  };
  return { port: actual, url, close, app };
}

// ---------------------------------------------------------------------------------------------- CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const get = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const port = Number(get('--port') || process.env.HARNESS_PORT || DEFAULT_PORT);
  const dataDir = get('--data-dir') || process.env.HARNESS_DATA_DIR || undefined;
  const openBrowser = args.includes('--open') || process.env.HARNESS_OPEN === '1';
  startServer({ port, dataDir, openBrowser }).then(({ url, close }) => {
    console.log(`Harness running at ${url}`);
    const stop = async () => { await close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((e) => { console.error(e); process.exit(1); });
}
