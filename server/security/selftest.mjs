// "Is internet access really blocked?" — the on-demand self-test of POST /api/network/test (docs/API.md §10.6).
//
// Code layer: asks the in-app blocker about the hosts Harness would contact (nothing is sent).
// OS layer: only where an OS sandbox claims to cover the process doing it — opens a TCP connection to a public IP
// address (no name lookup involved), sends one UDP datagram to it, and tries a name lookup, from inside the same
// sandbox profile `ollama serve` runs under (or from this process when the launcher sandboxed all of Harness). If
// the sandbox does not hold, that single connection attempt is what reveals it: the result is `reachable` and
// `osEnforced` is reported false from then on.
import { spawn } from 'node:child_process';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { assertEgress } from './egress.mjs';

const CODE_TARGETS = ['huggingface.co:443', 'ollama.com:443', 'registry.ollama.ai:443'];
const probeTarget = () => process.env.HARNESS_EGRESS_PROBE_TARGET || '1.1.1.1:443';
const probeName = () => process.env.HARNESS_EGRESS_PROBE_NAME || 'example.com';

const DENIED = new Set(['EPERM', 'EACCES']);

// Runs inside the sandbox (as `node -e`): prints one JSON line { tcp, udp, dns }, each { ok, code }.
const PROBE_SRC = `
const net = require('net'), dgram = require('dgram'), dns = require('dns');
const [host, port] = process.argv[1].split(':'); const name = process.argv[2];
const out = {};
const done = () => { if (out.tcp && out.udp && out.dns) { process.stdout.write(JSON.stringify(out) + '\\n'); process.exit(0); } };
const s = net.connect({ host, port: Number(port) });
const t = setTimeout(() => { out.tcp = { ok: false, code: 'ETIMEDOUT' }; s.destroy(); done(); }, 4000);
s.on('connect', () => { clearTimeout(t); out.tcp = { ok: true }; s.destroy(); done(); });
s.on('error', (e) => { clearTimeout(t); out.tcp = { ok: false, code: e.code || 'ERROR' }; done(); });
const u = dgram.createSocket('udp4');
u.on('error', (e) => { out.udp = { ok: false, code: e.code || 'ERROR' }; try { u.close(); } catch {} done(); });
u.send(Buffer.from('harness-egress-test'), Number(port === '443' ? 53 : port), host, (e) => { out.udp = e ? { ok: false, code: e.code || 'ERROR' } : { ok: true }; try { u.close(); } catch {} done(); });
dns.lookup(name, (e) => { out.dns = e ? { ok: false, code: e.code || 'ERROR' } : { ok: true }; done(); });
setTimeout(() => { out.tcp ||= { ok: false, code: 'ETIMEDOUT' }; out.udp ||= { ok: false, code: 'ETIMEDOUT' }; out.dns ||= { ok: false, code: 'ETIMEDOUT' }; done(); }, 8000);
`;

function inProcessProbe() {
  return new Promise((resolve) => {
    const [host, port] = probeTarget().split(':');
    const out = {};
    const finish = () => { if (out.tcp && out.udp && out.dns) resolve(out); };
    const s = net.connect({ host, port: Number(port) });
    const t = setTimeout(() => { out.tcp = { ok: false, code: 'ETIMEDOUT' }; s.destroy(); finish(); }, 4000);
    s.on('connect', () => { clearTimeout(t); out.tcp = { ok: true }; s.destroy(); finish(); });
    s.on('error', (e) => { clearTimeout(t); out.tcp = { ok: false, code: e.code || 'ERROR' }; finish(); });
    const u = dgram.createSocket('udp4');
    u.on('error', (e) => { out.udp = { ok: false, code: e.code || 'ERROR' }; try { u.close(); } catch { /* closed */ } finish(); });
    u.send(Buffer.from('harness-egress-test'), port === '443' ? 53 : Number(port), host, (e) => { out.udp = e ? { ok: false, code: e.code || 'ERROR' } : { ok: true }; try { u.close(); } catch { /* closed */ } finish(); });
    dns.lookup(probeName(), (e) => { out.dns = e ? { ok: false, code: e.code || 'ERROR' } : { ok: true }; finish(); });
  });
}

function sandboxedProbe(sandboxExec, profile) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(sandboxExec, ['-f', profile, process.execPath, '-e', PROBE_SRC, probeTarget(), probeName()], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { resolve({ error: e.code || e.message }); return; }
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: e.code || e.message }); });
    child.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ error: 'no_result' }); } });
  });
}

function classify(r, what) {
  if (!r) return { result: 'inconclusive', detail: 'no answer' };
  if (r.ok) return { result: 'reachable', detail: `${what} went through: the OS sandbox does not block it` };
  if (DENIED.has(r.code)) return { result: 'blocked', detail: `${what} refused by the OS (${r.code})` };
  if (what === 'name lookup' && /ENOTFOUND|EAI_AGAIN|EAI_FAIL/.test(r.code || '')) return { result: 'blocked', detail: `name lookup did not resolve (${r.code})` };
  return { result: 'inconclusive', detail: `${what} failed with ${r.code} (the network may simply be offline)` };
}

/**
 * @param {object} o
 * @param {import('./network.mjs').NetworkGuard} o.network
 * @param {{ sandboxExec: string, profile: string }} o.ollama  the sandbox the managed Ollama runs under
 */
export async function runEgressSelfTest({ network, ollama }) {
  const st = network.status();
  const results = [];
  for (const t of CODE_TARGETS) {
    try { assertEgress(`https://${t}`, 'other'); results.push({ layer: 'code', target: t, result: 'allowed', detail: 'internet access is allowed right now' }); } catch { results.push({ layer: 'code', target: t, result: 'blocked', detail: 'refused by Harness before any name lookup' }); }
  }
  const target = probeTarget();
  if (!st.blocked || !st.osEnforced) {
    results.push({ layer: 'os', target, result: 'skipped', detail: !st.blocked ? 'internet access is allowed right now' : 'no OS sandbox covers Harness here (only the in-app blocker applies)' });
    return { blocked: st.blocked, results };
  }
  const r = st.osScope === 'backend' ? await inProcessProbe() : await sandboxedProbe(ollama.sandboxExec, ollama.profile);
  if (r.error) {
    results.push({ layer: 'os', target, result: 'inconclusive', detail: `could not run the probe inside the sandbox (${r.error})` });
  } else {
    results.push({ layer: 'os', target: `tcp ${target}`, ...classify(r.tcp, 'a direct TCP connection') });
    results.push({ layer: 'os', target: `udp ${target.split(':')[0]}:53`, ...classify(r.udp, 'a UDP datagram') });
    results.push({ layer: 'os', target: `dns ${probeName()}`, ...classify(r.dns, 'name lookup') });
    if ([r.tcp, r.udp, r.dns].some((x) => x?.ok)) network.osBroken = true;
  }
  return { blocked: st.blocked, osEnforced: network.status().osEnforced, results };
}
