#!/usr/bin/env node
// A tiny stand-in for `node server/index.mjs --bridge` (docs/BRIDGE.md), used to prove the native app's transport
// on the Mac runner independently of the real backend. Frames on stdin/stdout, logs on stderr, no sockets.
//   node native/test/mock-backend.mjs --bridge --data-dir <dir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const dataDir = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : process.cwd();
const statePath = path.join(dataDir, 'mock-state.json');
const log = (...a) => process.stderr.write(`[harness ${new Date().toISOString()}] INFO mock: ${a.join(' ')}\n`);
const MAX = 1_048_576;

let state = { launches: 0, issuedKeyHash: null };
try { state = { ...state, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }; } catch { /* first launch */ }
state.launches += 1;
const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state));
saveState();

// ------------------------------------------------------------------------------------------- frames
function frame(type, id, payload = Buffer.alloc(0)) {
  const b = Buffer.alloc(9 + payload.length);
  b.writeUInt32BE(5 + payload.length, 0);
  b.writeUInt8(type, 4);
  b.writeUInt32BE(id, 5);
  payload.copy(b, 9);
  return b;
}
const send = (type, id, payload) => process.stdout.write(frame(type, id, payload));
const event = (o) => send(0x15, 0, Buffer.from(JSON.stringify(o)));
const head = (id, status, headers) => send(0x11, id, Buffer.from(JSON.stringify({ status, headers })));
const body = (id, data) => { const b = Buffer.isBuffer(data) ? data : Buffer.from(data); for (let o = 0; o < b.length; o += MAX) send(0x12, id, b.subarray(o, o + MAX)); };
const end = (id) => send(0x13, id);
const json = (id, status, o) => { head(id, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); body(id, JSON.stringify(o)); end(id); };

const streams = new Map(); // id → { head, chunks, cancelled, timers }
const controls = [];
const cancelled = [];
let hello = null;
let locked = false;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGM4EaABRww4OQAsNg8BoqhHXQAAAABJRU5ErkJggg==', 'base64'); // 4×3 px
const pattern = (b) => { for (let i = 0; i < b.length; i++) if (b[i] !== ((Math.imul(i, 31) + 7) & 255)) return false; return true; };

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const n = buf.readUInt32BE(0);
    if (n < 5 || n > MAX + 5) { log('corrupt frame stream'); process.exit(3); }
    if (buf.length < 4 + n) break;
    const type = buf.readUInt8(4);
    const id = buf.readUInt32BE(5);
    const payload = buf.subarray(9, 4 + n);
    buf = buf.subarray(4 + n);
    onFrame(type, id, Buffer.from(payload));
  }
});
process.stdin.on('end', () => { log('stdin closed: exiting'); process.exit(0); });

function onFrame(type, id, payload) {
  if (type === 0x05) {
    const c = JSON.parse(payload.toString('utf8'));
    controls.push(c.op);
    if (!hello) {
      if (c.op !== 'hello') { event({ type: 'fatal', code: 'bad_hello', message: 'first frame must be hello' }); process.exit(2); }
      hello = c;
      const key = typeof c.dataKey === 'string' ? c.dataKey : null;
      hello.keySent = !!key;
      hello.keyMatches = !!key && state.issuedKeyHash === crypto.createHash('sha256').update(key).digest('hex');
      delete hello.dataKey;
      log(`hello from ${c.app?.kind} ${c.app?.version}; key sent: ${hello.keySent}`);
      setTimeout(() => event({ type: 'progress', what: 'encrypting', done: 1, total: 2 }), 50);
      setTimeout(() => event({ type: 'ready', protocol: 1, version: '0.0.0-mock', locked: false, encryption: { mode: 'password' }, offlineLock: true }), 150);
      return;
    }
    if (c.op === 'ping') event({ type: 'pong' });
    if (c.op === 'lock') { locked = true; event({ type: 'locked' }); }
    if (c.op === 'shutdown') { log('shutdown'); setTimeout(() => process.exit(0), 50); }
    return;
  }
  if (type === 0x01) { streams.set(id, { head: JSON.parse(payload.toString('utf8')), chunks: [], timers: [] }); return; }
  if (type === 0x02) { streams.get(id)?.chunks.push(payload); return; }
  if (type === 0x04) {
    const s = streams.get(id);
    if (s) { s.cancelled = true; s.timers.forEach(clearTimeout); cancelled.push({ path: s.head.path, at: Date.now() }); streams.delete(id); }
    return;
  }
  if (type === 0x03) {
    const s = streams.get(id);
    if (s) handle(id, s, Buffer.concat(s.chunks));
  }
}

function handle(id, s, reqBody) {
  const { method, path: full, headers } = s.head;
  const url = new URL(full, 'http://mock');
  const p = url.pathname;
  const q = (k, d) => Number(url.searchParams.get(k) || d);
  const done = () => streams.delete(id);
  if (locked && p.startsWith('/api/') && !p.startsWith('/api/mock/') && p !== '/api/cancel-status') {
    return json(id, 423, { error: { code: 'locked', message: 'Harness is locked' } }), done();
  }
  if (p === '/' || p === '/index.html') {
    head(id, 200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'" });
    body(id, '<!doctype html><html><head><meta charset="utf-8"><title>Harness mock</title></head><body><header class="titlebar" style="height:40px"><span>mock title bar</span></header><main id="out">mock page</main></body></html>');
    end(id); return done();
  }
  if (p === '/api/echo') {
    return json(id, 200, { method, path: full, headers, bodyLength: reqBody.length, bodyText: reqBody.length < 4096 ? reqBody.toString('utf8') : null }), done();
  }
  if (p === '/api/upload') {
    return json(id, 200, { length: reqBody.length, pattern: pattern(reqBody), sha256: crypto.createHash('sha256').update(reqBody).digest('hex'), contentType: headers['content-type'] || null }), done();
  }
  if (p === '/api/image.png') { head(id, 200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); body(id, PNG); end(id); return done(); }
  if (p === '/api/download') {
    head(id, 200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': "attachment; filename*=UTF-8''chat%20export.md" });
    body(id, '# exported\n'.repeat(1000)); end(id); return done();
  }
  if (p === '/api/stream' || p === '/api/forever' || p === '/api/events') {
    head(id, 200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const n = p === '/api/stream' ? q('n', 6) : 1e9;
    const ms = p === '/api/events' ? 15000 : q('ms', 300);
    if (p === '/api/events') body(id, `event: hello\ndata: ${JSON.stringify({ type: 'hello' })}\n\n`);
    let i = 0;
    const tick = () => {
      if (s.cancelled) return;
      if (i >= n) { end(id); done(); return; }
      body(id, `event: token\ndata: ${JSON.stringify({ type: 'token', i, t: Date.now() })}\n\n`);
      i += 1;
      s.timers.push(setTimeout(tick, ms));
    };
    tick();
    return;
  }
  if (p === '/api/cancel-status') return json(id, 200, { cancelled }), done();
  if (p === '/api/mock/hello') return json(id, 200, { keySent: hello.keySent, keyMatches: hello.keyMatches, launches: state.launches, controls, app: hello.app }), done();
  if (p === '/api/mock/emit') {
    const o = JSON.parse(reqBody.toString('utf8') || '{}');
    json(id, 200, { ok: true });
    done();
    if (o.type === 'keychain-key' && o.random) {
      const key = crypto.randomBytes(32).toString('base64');
      state.issuedKeyHash = crypto.createHash('sha256').update(key).digest('hex');
      saveState();
      fs.writeFileSync(path.join(dataDir, 'launch.json'), JSON.stringify({ version: 1, offlineLock: true, offlineLockSuspendedUntil: null, encryption: 'keychain' }));
      setTimeout(() => event({ type: 'keychain-key', dataKey: key }), 20);
    } else if (o.type === 'keychain-key') {
      fs.writeFileSync(path.join(dataDir, 'launch.json'), JSON.stringify({ version: 1, offlineLock: true, offlineLockSuspendedUntil: null, encryption: 'password' }));
      setTimeout(() => event({ type: 'keychain-key', dataKey: null }), 20);
    } else {
      if (o.type === 'unlocked') locked = false;
      setTimeout(() => event(o), 20);
    }
    return;
  }
  json(id, 404, { error: { code: 'not_found', message: `No route for ${method} ${p}` } });
  done();
}
