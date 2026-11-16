#!/usr/bin/env node
// A minimal bridge client (docs/BRIDGE.md) for checking a backend without the app, e.g. on Linux:
//   node native/test/bridge-client.mjs <backend script> <data dir>
// Starts the backend, sends hello, then a few requests; prints one line per check.
import { spawn } from 'node:child_process';

const [script = 'server/index.mjs', dataDir = '/tmp/harness-bridge-check'] = process.argv.slice(2);
const child = spawn(process.execPath, [script, '--bridge', '--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });
const MAX = 1_048_576;
const frame = (type, id, payload = Buffer.alloc(0)) => {
  const b = Buffer.alloc(9 + payload.length);
  b.writeUInt32BE(5 + payload.length, 0); b.writeUInt8(type, 4); b.writeUInt32BE(id, 5); payload.copy(b, 9);
  return b;
};
const waiting = new Map();
const events = [];
let onEvent = null;
let buf = Buffer.alloc(0);
child.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const n = buf.readUInt32BE(0);
    if (buf.length < 4 + n) break;
    const type = buf.readUInt8(4), id = buf.readUInt32BE(5), payload = Buffer.from(buf.subarray(9, 4 + n));
    buf = buf.subarray(4 + n);
    if (type === 0x15) { const e = JSON.parse(payload); events.push(e); onEvent?.(e); continue; }
    const w = waiting.get(id);
    if (!w) continue;
    if (type === 0x11) w.head = JSON.parse(payload);
    else if (type === 0x12) { w.chunks.push(payload); w.times.push(Date.now() - w.t0); w.onChunk?.(); }
    else if (type === 0x13) { waiting.delete(id); w.resolve({ ...w.head, body: Buffer.concat(w.chunks), times: w.times }); }
  }
});
let nextId = 0;
function request(method, path, { body, headers = {}, onChunk } = {}) {
  const id = ++nextId;
  return { id, done: new Promise((resolve) => {
    waiting.set(id, { resolve, chunks: [], times: [], t0: Date.now(), onChunk });
    child.stdin.write(frame(0x01, id, Buffer.from(JSON.stringify({ method, path, headers }))));
    if (body) { const b = Buffer.from(body); for (let o = 0; o < b.length; o += MAX) child.stdin.write(frame(0x02, id, b.subarray(o, o + MAX))); }
    child.stdin.write(frame(0x03, id));
  }) };
}
const say = (k, v) => console.log(`bridge-client ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const ready = new Promise((resolve) => { onEvent = (e) => { if (e.type === 'ready' || e.type === 'fatal') resolve(e); }; });
child.stdin.write(frame(0x05, 0, Buffer.from(JSON.stringify({ op: 'hello', protocol: 1, app: { name: 'Harness', version: '0.0.0', kind: 'check' }, dataKey: null }))));
const r = await Promise.race([ready, new Promise((x) => setTimeout(() => x({ type: 'timeout' }), 30000))]);
say('ready', r);
const show = async (label, req) => { const res = await req.done; say(label, { status: res.status, ct: res.headers?.['content-type'], bytes: res.body.length, pieces: res.times.length, head: res.body.subarray(0, 120).toString('utf8') }); return res; };
await show('GET /', request('GET', '/'));
await show('GET /api/health', request('GET', '/api/health'));
await show('GET /api/security', request('GET', '/api/security'));
await show('GET /api/chats', request('GET', '/api/chats'));
if (script.includes('mock')) {
  await show('POST /api/echo', request('POST', '/api/echo', { body: '{"a":1}', headers: { 'content-type': 'application/json' } }));
  await show('POST /api/stream', request('POST', '/api/stream?n=4&ms=100'));
  const big = Buffer.alloc(3 * MAX + 5); for (let i = 0; i < big.length; i++) big[i] = (Math.imul(i, 31) + 7) & 255;
  await show('POST /api/upload', request('POST', '/api/upload', { body: big, headers: { 'content-type': 'application/octet-stream' } }));
  const f = request('GET', '/api/forever?ms=50', { onChunk: () => { child.stdin.write(frame(0x04, f.id)); } });
  await new Promise((x) => setTimeout(x, 300));
  await show('GET /api/cancel-status', request('GET', '/api/cancel-status'));
}
child.stdin.write(frame(0x05, 0, Buffer.from(JSON.stringify({ op: 'shutdown' }))));
const code = await new Promise((x) => child.on('exit', x));
say('exit', { code, events: events.map((e) => e.type), stderrLines: stderr.split('\n').filter(Boolean).length });
