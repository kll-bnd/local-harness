// Reference bridge client (docs/BRIDGE.md): starts `node server/index.mjs --bridge` as a child and talks frames to
// it — what the native app does in Swift. Used by the tests; also handy for scripting a bridge backend.
//
//   const b = await BridgeClient.start({ dataDir });
//   const r = await b.request('GET', '/api/health');            // { status, headers, body: Buffer, json() }
//   const s = b.stream('POST', '/api/chats/x/messages', { body: { content: 'hi' } });
//   for await (const chunk of s.body) { … s.cancel() }          // CANCEL frame
//   b.on('event', (ev) => …); await b.control('lock'); await b.shutdown();
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { T, PROTOCOL, MAX_PAYLOAD, encodeFrame, FrameDecoder } from './frames.mjs';

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');

export class BridgeClient extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {string|null} [o.dataKey] keychain mode: base64 of the 32-byte key; null in password mode
   * @param {object} [o.env] extra environment for the child
   * @param {boolean} [o.waitReady=true] resolve after `ready` (rejects on `fatal`)
   */
  static async start({ dataDir, dataKey = null, env = {}, waitReady = true, node = process.execPath, args = [] } = {}) {
    const child = spawn(node, [...args, ENTRY, '--bridge', '--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    const c = new BridgeClient(child);
    c.sendControl({ op: 'hello', protocol: PROTOCOL, app: { name: 'Harness', version: 'test', kind: 'reference-client' }, dataKey });
    if (waitReady) await c.ready;
    return c;
  }

  constructor(child) {
    super();
    this.child = child;
    this.decoder = new FrameDecoder();
    this.nextId = 1;
    this.pending = new Map(); // id → stream state
    this.events = [];
    this.stderr = '';
    this.exited = new Promise((resolve) => child.on('exit', (code, signal) => { this.exitCode = code; resolve({ code, signal }); for (const s of this.pending.values()) s.fail(new Error('backend exited')); }));
    this.ready = new Promise((resolve, reject) => {
      this.on('event', (ev) => {
        if (ev.type === 'ready') resolve(ev);
        if (ev.type === 'fatal') { const e = new Error(ev.message); e.code = ev.code; e.event = ev; reject(e); }
      });
      this.exited.then(({ code }) => reject(Object.assign(new Error(`backend exited (${code}) before ready: ${this.stderr.slice(-500)}`), { code: 'exited' })));
    });
    this.ready.catch(() => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-20000); });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      for (const f of this.decoder.push(chunk)) this._frame(f);
    });
  }

  _frame(f) {
    if (f.type === T.EVENT) {
      let ev = null;
      try { ev = JSON.parse(f.payload.toString('utf8')); } catch { return; }
      this.events.push(ev);
      this.emit('event', ev);
      return;
    }
    const s = this.pending.get(f.stream);
    if (!s) return;
    if (f.type === T.RES_HEAD) s.head(JSON.parse(f.payload.toString('utf8')));
    else if (f.type === T.RES_BODY) s.chunk(Buffer.from(f.payload));
    else if (f.type === T.RES_END) { this.pending.delete(f.stream); s.end(); }
  }

  _write(buf) { if (!this.child.stdin.destroyed) this.child.stdin.write(buf); }
  sendControl(msg) { this._write(encodeFrame(T.CONTROL, 0, Buffer.from(JSON.stringify(msg)))); }
  control(op, extra = {}) { this.sendControl({ op, ...extra }); }

  /** Low level: open a stream. `body` may be a Buffer, a string or an object (sent as JSON). */
  stream(method, p, { headers = {}, body } = {}) {
    const id = this.nextId++;
    let buf = null;
    const h = { ...headers };
    if (body !== undefined) {
      buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      if (!Buffer.isBuffer(body) && typeof body !== 'string') h['content-type'] ||= 'application/json';
      h['content-length'] = String(buf.length);
    }
    const queue = [];
    let waiting = null;
    let ended = false;
    let failed = null;
    let headResolve;
    let headReject;
    const headP = new Promise((res, rej) => { headResolve = res; headReject = rej; });
    headP.catch(() => {});
    const wake = () => { if (waiting) { const w = waiting; waiting = null; w(); } };
    const state = {
      head: (hd) => headResolve(hd),
      chunk: (c) => { queue.push(c); wake(); },
      end: () => { ended = true; wake(); },
      fail: (e) => { failed = e; headReject(e); wake(); },
    };
    this.pending.set(id, state);
    this._write(encodeFrame(T.REQ_HEAD, id, Buffer.from(JSON.stringify({ method, path: p, headers: h }))));
    if (buf) for (let off = 0; off < buf.length; off += MAX_PAYLOAD) this._write(encodeFrame(T.REQ_BODY, id, buf.subarray(off, off + MAX_PAYLOAD)));
    this._write(encodeFrame(T.REQ_END, id));
    const self = this;
    return {
      id,
      head: headP,
      body: (async function* () {
        for (;;) {
          if (queue.length) { yield queue.shift(); continue; }
          if (ended || failed) { if (failed && !ended) throw failed; return; }
          await new Promise((r) => { waiting = r; });
        }
      })(),
      cancel() {
        self.pending.delete(id);
        ended = true;
        wake();
        self._write(encodeFrame(T.CANCEL, id));
      },
    };
  }

  /** A whole request: resolves { status, headers, body, text(), json() }. */
  async request(method, p, opts = {}) {
    const s = this.stream(method, p, opts);
    const head = await s.head;
    const parts = [];
    for await (const c of s.body) parts.push(c);
    const body = Buffer.concat(parts);
    return { status: head.status, headers: head.headers, body, text: () => body.toString('utf8'), json: () => JSON.parse(body.toString('utf8') || 'null') };
  }

  /** Wait for an event matching `pred` (already received ones count). */
  waitForEvent(pred, timeoutMs = 10000) {
    const hit = this.events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.off('event', on); reject(new Error('timed out waiting for a bridge event')); }, timeoutMs);
      const on = (ev) => { if (pred(ev)) { clearTimeout(t); this.off('event', on); resolve(ev); } };
      this.on('event', on);
    });
  }

  /** `shutdown` control message; resolves with the exit status. */
  async shutdown() { this.control('shutdown'); return this.exited; }

  /** Close stdin (as if the app died); resolves with the exit status. */
  async closeStdin() { this.child.stdin.end(); return this.exited; }

  kill() { try { this.child.kill('SIGKILL'); } catch { /* gone */ } }
}
