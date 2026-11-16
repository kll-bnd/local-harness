// Bridge mode (docs/BRIDGE.md): the backend as a child of the native app, talking frames over stdin/stdout and
// opening no listening socket of any kind. Requests go through the same handler as HTTP requests (makeHandler with
// `bridge: true`: no Host/Origin checks or sessions — no network is involved — but the same lock).
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { T, PROTOCOL, MAX_PAYLOAD, encodeFrame, FrameDecoder } from './frames.mjs';
import { Core } from '../core.mjs';
import { defaultDataDir } from '../app.mjs';
import { makeHandler, installProcessGuards } from '../index.mjs';
import { acquireDataDirLock } from '../lib/instance-lock.mjs';
import { appKeychain } from '../security/keychain.mjs';
import { ensureDir } from '../lib/fsx.mjs';
import { log, logToStderr } from '../lib/log.mjs';

const HELLO_TIMEOUT_MS = Number(process.env.HARNESS_BRIDGE_HELLO_TIMEOUT_MS) || 30000;
const B64_32 = /^[A-Za-z0-9+/]{43}=$/;

/** Ordered writer onto stdout with backpressure: `send()` resolves when the bytes were handed to the pipe. */
class FrameWriter {
  constructor(out) { this.out = out; this.closed = false; out.on('error', () => { this.closed = true; }); }
  send(type, stream, payload) {
    if (this.closed) return Promise.resolve(false);
    const f = encodeFrame(type, stream, payload);
    return new Promise((resolve) => {
      try { this.out.write(f, () => resolve(true)); } catch { this.closed = true; resolve(false); }
    });
  }
  event(ev) { return this.send(T.EVENT, 0, Buffer.from(JSON.stringify(ev))); }
}

const socketStub = Object.freeze({ setNoDelay() {}, setKeepAlive() {}, setTimeout() {}, remoteAddress: 'bridge', localPort: null, destroy() {} });

/** The request side of one stream: a Readable with the fields handlers read from an IncomingMessage. */
class BridgeRequest extends Readable {
  constructor({ method, url, headers }, onRead) {
    super({ highWaterMark: 4 * MAX_PAYLOAD });
    this.method = String(method || 'GET').toUpperCase();
    this.url = url;
    this.headers = headers;
    this.rawHeaders = Object.entries(headers).flat();
    this.httpVersion = '1.1';
    this.socket = socketStub;
    this.connection = socketStub;
    this.aborted = false;
    this._onRead = onRead;
  }
  _read() { this._onRead?.(); }
}

/** The response side: a Writable with the http.ServerResponse surface the routes use; frames out. */
class BridgeResponse extends Writable {
  constructor(stream, writer) {
    super({ highWaterMark: MAX_PAYLOAD });
    this.stream = stream;
    this.writer = writer;
    this.statusCode = 200;
    this.statusMessage = '';
    this.headersSent = false;
    this.cancelled = false;
    this.socket = socketStub;
    this._headers = new Map();
  }
  setHeader(k, v) { this._headers.set(String(k).toLowerCase(), v); return this; }
  getHeader(k) { return this._headers.get(String(k).toLowerCase()); }
  getHeaders() { return Object.fromEntries(this._headers); }
  hasHeader(k) { return this._headers.has(String(k).toLowerCase()); }
  removeHeader(k) { this._headers.delete(String(k).toLowerCase()); }
  writeHead(status, msgOrHeaders, maybeHeaders) {
    if (this.headersSent) return this;
    const headers = typeof msgOrHeaders === 'object' && msgOrHeaders ? msgOrHeaders : maybeHeaders || {};
    this.statusCode = status;
    for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    this.headersSent = true;
    const out = {};
    for (const [k, v] of this._headers) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : String(v);
    this._head = this.cancelled ? null : this.writer.send(T.RES_HEAD, this.stream, Buffer.from(JSON.stringify({ status, headers: out })));
    return this;
  }
  flushHeaders() { if (!this.headersSent) this.writeHead(this.statusCode); }
  _write(chunk, enc, cb) {
    if (!this.headersSent) this.writeHead(this.statusCode);
    if (this.cancelled) { cb(); return; }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc);
    const sends = [];
    for (let off = 0; off < buf.length; off += MAX_PAYLOAD) sends.push(this.writer.send(T.RES_BODY, this.stream, buf.subarray(off, off + MAX_PAYLOAD)));
    Promise.all(sends).then(() => cb(), () => cb());
  }
  _final(cb) {
    if (!this.headersSent) this.writeHead(this.statusCode);
    if (this.cancelled) { cb(); return; }
    this.writer.send(T.RES_END, this.stream).then(() => cb(), () => cb());
  }
  /** CANCEL from the app: exactly like a client disconnect; nothing more is sent for this stream. */
  cancel() {
    this.cancelled = true;
    this.destroy();
  }
}

/**
 * Run the bridge on stdin/stdout. Resolves when the backend has shut down (the caller exits).
 * @param {object} o
 * @param {string} [o.dataDir]
 */
export async function runBridge({ dataDir, stdin = process.stdin, stdout = process.stdout, exit = (code) => process.exit(code) } = {}) {
  logToStderr(true);
  installProcessGuards();
  const writer = new FrameWriter(stdout);
  const decoder = new FrameDecoder();
  const streams = new Map(); // id → { req, res }
  let core = null;
  let lock = null;
  let handler = null;
  let ready = false;
  let shuttingDown = null;
  const queue = []; // frames received before `ready`
  let helloResolve;
  const hello = new Promise((r) => { helloResolve = r; });
  let gotHello = false;

  const fatal = async (code, message, url = null) => {
    log.error(`Bridge start-up failed: ${code}`);
    await writer.event({ type: 'fatal', code, message, url });
    await core?.close().catch(() => {});
    lock?.release();
    exit(1);
  };

  const shutdown = (why) => {
    shuttingDown ||= (async () => {
      log.info(`Bridge shutting down (${why})`);
      for (const { res } of streams.values()) res.cancel(); // abort what runs; partial replies are kept
      streams.clear();
      await core?.close().catch((e) => log.warn(`Shutdown: ${e.message}`));
      lock?.release();
      exit(0);
    })();
    return shuttingDown;
  };

  const control = async (msg) => {
    if (msg.op === 'ping') return writer.event({ type: 'pong' });
    if (msg.op === 'lock') return core?.lock('bridge').catch((e) => log.warn(`Bridge lock: ${e.code || e.message}`));
    if (msg.op === 'shutdown') return shutdown('shutdown');
    if (msg.op === 'hello') return; // duplicate hello: ignore
    log.warn(`Bridge: unknown control op ${String(msg.op).slice(0, 40)}`);
  };

  const dispatch = (f) => {
    if (f.type === T.CONTROL) {
      let msg = null;
      try { msg = JSON.parse(f.payload.toString('utf8')); } catch { /* ignored below */ }
      if (msg) control(msg);
      return;
    }
    const s = streams.get(f.stream);
    if (f.type === T.REQ_HEAD) {
      if (!f.stream || s) return; // stream ids must be non-zero and unique among open streams
      let head;
      try { head = JSON.parse(f.payload.toString('utf8')); } catch { head = null; }
      const res = new BridgeResponse(f.stream, writer);
      if (!head || typeof head.path !== 'string' || !head.path.startsWith('/')) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'bad_request', message: 'REQ_HEAD needs { method, path, headers }' } }));
        return;
      }
      const headers = {};
      for (const [k, v] of Object.entries(head.headers || {})) headers[String(k).toLowerCase()] = String(v);
      const req = new BridgeRequest({ method: head.method, url: head.path, headers }, () => stdin.resume());
      streams.set(f.stream, { req, res });
      // Once answered (or cancelled), any body the handler did not read is dropped, and reading resumes.
      res.once('close', () => {
        if (streams.get(f.stream)?.res === res) streams.delete(f.stream);
        if (!req.readableEnded) req.destroy();
        stdin.resume();
      });
      handler(req, res);
      return;
    }
    if (!s) return;
    if (f.type === T.REQ_BODY) { if (!s.req.push(Buffer.from(f.payload))) stdin.pause(); return; }
    if (f.type === T.REQ_END) { s.req.push(null); return; }
    if (f.type === T.CANCEL) {
      streams.delete(f.stream);
      s.req.aborted = true;
      s.req.emit('aborted');
      s.res.cancel();
      s.req.destroy();
    }
  };

  stdin.on('data', (chunk) => {
    let frames;
    try { frames = decoder.push(chunk); } catch (e) {
      log.error(`Bridge: ${e.message}; stopping`);
      stdin.pause();
      if (!gotHello) fatal('bad_hello', 'The first frame is not a valid hello.'); else shutdown('corrupt stream');
      return;
    }
    for (const f of frames) {
      if (!gotHello) {
        gotHello = true;
        let msg = null;
        if (f.type === T.CONTROL) { try { msg = JSON.parse(f.payload.toString('utf8')); } catch { /* bad */ } }
        helloResolve(msg && msg.op === 'hello' ? msg : null);
        continue;
      }
      if (!ready) queue.push(f); else dispatch(f);
    }
  });
  stdin.on('end', () => { if (!gotHello) helloResolve(null); shutdown('stdin closed'); });
  stdin.on('error', () => shutdown('stdin error'));

  const timer = setTimeout(() => { if (!gotHello) { gotHello = true; helloResolve(null); } }, HELLO_TIMEOUT_MS);
  const msg = await hello;
  clearTimeout(timer);
  if (shuttingDown && !msg) return;
  if (!msg || msg.protocol !== PROTOCOL) return fatal('bad_hello', msg ? `Unsupported bridge protocol ${msg.protocol} (this backend speaks ${PROTOCOL}).` : 'The first frame must be a hello control message.');
  if (msg.dataKey != null && !(typeof msg.dataKey === 'string' && B64_32.test(msg.dataKey))) return fatal('bad_hello', 'hello.dataKey must be null or base64 of 32 bytes.');

  const dir = path.resolve(dataDir || defaultDataDir());
  try {
    await ensureDir(dir);
    lock = await acquireDataDirLock(dir);
  } catch (e) {
    if (e?.code === 'HARNESS_ALREADY_RUNNING') return fatal('data_dir_locked', 'Another Harness is using this data folder.', e.url || null);
    return fatal('startup_failed', e.message);
  }
  try {
    const keychain = appKeychain({ initialKey: msg.dataKey ? Buffer.from(msg.dataKey, 'base64') : null, emit: (ev) => writer.event(ev) });
    core = new Core({ dataDir: dir, transport: 'bridge', keychain, emit: (ev) => writer.event(ev) });
    await core.init();
    lock.update({ url: null, port: null, transport: 'bridge' });
    handler = makeHandler(core, { bridge: true });
  } catch (e) {
    if (e?.code === 'wrong_key') return fatal('wrong_key', 'The key from the Keychain does not open this data. Start again with dataKey: null to unlock with the password.');
    return fatal('startup_failed', e.message);
  }
  if (shuttingDown) return;
  ready = true;
  await writer.event({ type: 'ready', protocol: PROTOCOL, version: core.version, locked: core.state !== 'unlocked', state: core.state, encryption: { mode: core.mode }, offlineLock: core.network.status().enabled });
  log.info(`Harness ${core.version} bridge ready (${core.state}, encryption: ${core.mode})`);
  for (const f of queue.splice(0)) dispatch(f);
}
