// What can this process reach? Run plainly and under the offline-lock sandbox; prints one JSON line.
//   node native/ci/net-probe.mjs <label>
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const label = process.argv[2] || 'plain';
const T = 6000;
const short = (e) => (e && (e.code || e.cause?.code || e.name)) || String(e);

function tcp(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: T });
    s.once('connect', () => { s.destroy(); resolve('ok'); });
    s.once('timeout', () => { s.destroy(); resolve('timeout'); });
    s.once('error', (e) => resolve(`err:${short(e)}`));
  });
}

async function timed(p) {
  return Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), T + 2000))]);
}

async function loopback(host) {
  const srv = http.createServer((q, r) => r.end('pong'));
  try {
    await new Promise((res, rej) => { srv.once('error', rej); srv.listen(0, host, res); });
  } catch (e) { return `listen-err:${short(e)}`; }
  const { port } = srv.address();
  const r = await new Promise((resolve) => {
    http.get({ host, port, path: '/', timeout: T }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b === 'pong' ? 'ok' : `bad:${b}`)); })
      .on('error', (e) => resolve(`err:${short(e)}`));
  });
  srv.close();
  return r;
}

async function unixSock() {
  const p = path.join(os.tmpdir(), `harness-probe-${process.pid}.sock`);
  try { fs.unlinkSync(p); } catch { /* none */ }
  const srv = net.createServer((s) => s.end('u'));
  try { await new Promise((res, rej) => { srv.once('error', rej); srv.listen(p, res); }); } catch (e) { return `listen-err:${short(e)}`; }
  const r = await new Promise((resolve) => {
    const c = net.connect(p);
    c.on('data', () => { c.destroy(); resolve('ok'); });
    c.on('error', (e) => resolve(`err:${short(e)}`));
  });
  srv.close();
  try { fs.unlinkSync(p); } catch { /* gone */ }
  return r;
}

const out = { label, sandboxedEnv: process.env.HARNESS_SANDBOXED === '1' };
out.tcpPublicIp = await timed(tcp('1.1.1.1', 443));
out.tcpPublicIp6 = await timed(tcp('2606:4700:4700::1111', 443));
out.dnsLookup = await timed(dns.promises.lookup('example.com').then((a) => `ok:${a.address}`, (e) => `err:${short(e)}`));
out.dnsResolve4 = await timed(dns.promises.resolve4('example.org').then((a) => `ok:${a[0]}`, (e) => `err:${short(e)}`));
out.dnsLocalhost = await timed(dns.promises.lookup('localhost').then((a) => `ok:${a.address}`, (e) => `err:${short(e)}`));
out.httpsFetch = await timed(fetch('https://example.com/', { signal: AbortSignal.timeout(T) }).then((r) => `ok:${r.status}`, (e) => `err:${short(e)}`));
out.loopback4 = await timed(loopback('127.0.0.1'));
out.loopback6 = await timed(loopback('::1'));
out.listenAny = await timed(loopback('0.0.0.0'));
out.unixSocket = await timed(unixSock());
console.log(`net-probe ${JSON.stringify(out)}`);
