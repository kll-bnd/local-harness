// "Is internet access really blocked?" — the on-demand self-test of POST /api/network/test (docs/API.md §10.6).
//
// Code layer: asks the in-app blocker about the hosts Harness would contact (nothing is sent).
// OS layer (the offline-lock sandbox profile, proven on macOS 26: it blocks every outbound TCP/UDP connection and
// DNS lookup to anything but this Mac — it does NOT police connections accepted on a listening socket, which is why
// the managed Ollama is bound to loopback and that is checked here too). Runs only where an OS sandbox claims to
// cover the process doing it, from inside the same profile `ollama serve` runs under (or, for a backend the
// launcher sandboxed, from a child of the backend, which inherits it): a TCP connection to a public IPv4 and IPv6
// address (no name lookup involved), a UDP datagram, and a name lookup. The refusals the sandbox produces — EPERM /
// EACCES, ECONNREFUSED for UDP, ENOTFOUND for lookups — count as `blocked`. If the sandbox does not hold, that single
// attempt is what reveals it: `reachable`, and `osEnforced` is reported false from then on.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { assertEgress, isLoopbackHost } from './egress.mjs';

const CODE_TARGETS = ['huggingface.co:443', 'ollama.com:443', 'registry.ollama.ai:443'];
const probeTarget = () => process.env.HARNESS_EGRESS_PROBE_TARGET || '1.1.1.1:443';
const probeTarget6 = () => process.env.HARNESS_EGRESS_PROBE_TARGET6 || '[2606:4700:4700::1111]:443';
const probeName = () => process.env.HARNESS_EGRESS_PROBE_NAME || 'example.com';

const BLOCKED_SOCKET = new Set(['EPERM', 'EACCES', 'ECONNREFUSED']);
const BLOCKED_DNS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EPERM', 'EACCES', 'ECONNREFUSED']);

// Runs as `node -e` inside the sandbox: prints one JSON line { tcp, tcp6, udp, dns }, each { ok, code }.
const PROBE_SRC = `
const net = require('net'), dgram = require('dgram'), dns = require('dns');
const split = (t) => { const m = /^\\[?([^\\]]+?)\\]?:(\\d+)$/.exec(t); return [m[1], Number(m[2])]; };
const [h4, p4] = split(process.argv[1]); const [h6, p6] = split(process.argv[2]); const name = process.argv[3];
const out = {};
const done = () => { if (out.tcp && out.tcp6 && out.udp && out.dns) { process.stdout.write(JSON.stringify(out) + '\\n'); process.exit(0); } };
const tcp = (key, host, port) => {
  const s = net.connect({ host, port });
  const t = setTimeout(() => { out[key] ||= { ok: false, code: 'ETIMEDOUT' }; s.destroy(); done(); }, 4000);
  s.on('connect', () => { clearTimeout(t); out[key] = { ok: true }; s.destroy(); done(); });
  s.on('error', (e) => { clearTimeout(t); out[key] ||= { ok: false, code: e.code || 'ERROR' }; done(); });
};
tcp('tcp', h4, p4);
tcp('tcp6', h6, p6);
const u = dgram.createSocket('udp4');
const udpDone = (r) => { if (out.udp) return; out.udp = r; try { u.close(); } catch {} done(); };
u.on('error', (e) => udpDone({ ok: false, code: e.code || 'ERROR' }));
u.connect(53, h4, (e) => {
  if (e) return udpDone({ ok: false, code: e.code || 'ERROR' });
  u.send(Buffer.from('harness-egress-test'), (e2) => { if (e2) return udpDone({ ok: false, code: e2.code || 'ERROR' }); setTimeout(() => udpDone({ ok: true }), 300); });
});
dns.lookup(name, (e) => { out.dns = e ? { ok: false, code: e.code || 'ERROR' } : { ok: true }; done(); });
setTimeout(() => { for (const k of ['tcp', 'tcp6', 'udp', 'dns']) out[k] ||= { ok: false, code: 'ETIMEDOUT' }; done(); }, 8000);
`;

function runProbe(cmd, args) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { resolve({ error: e.code || e.message }); return; }
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: e.code || e.message }); });
    child.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ error: 'no_result' }); } });
  });
}

function classify(r, what, blockedCodes) {
  if (!r) return { result: 'inconclusive', detail: 'no answer' };
  if (r.ok) return { result: 'reachable', detail: `${what} went out: the OS sandbox does not block it` };
  if (blockedCodes.has(r.code)) return { result: 'blocked', detail: `${what} refused by the OS sandbox (${r.code})` };
  return { result: 'inconclusive', detail: `${what} failed with ${r.code} (the network may simply be offline here)` };
}

/** TCP addresses `pid` listens on ("127.0.0.1:11434", "*:11434", "[::1]:11434"), or null when unknown. */
export async function listeningAddresses(pid, { platform = process.platform } = {}) {
  if (!pid) return null;
  if (platform === 'linux') {
    try {
      const inodes = new Set();
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) { try { const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`)); if (m) inodes.add(m[1]); } catch { /* gone */ } }
      const out = [];
      for (const [f, v6] of [['tcp', false], ['tcp6', true]]) {
        let lines = [];
        try { lines = fs.readFileSync(`/proc/${pid}/net/${f}`, 'utf8').split('\n').slice(1); } catch { continue; }
        for (const line of lines) {
          const c = line.trim().split(/\s+/);
          if (c.length < 10 || c[3] !== '0A' || !inodes.has(c[9])) continue;
          const [hex, portHex] = c[1].split(':');
          const port = parseInt(portHex, 16);
          if (!v6) out.push(`${hex.match(/../g).reverse().map((x) => parseInt(x, 16)).join('.')}:${port}`);
          else out.push(/^0+$/.test(hex) ? `[::]:${port}` : hex === '00000000000000000000000001000000' ? `[::1]:${port}` : `[${hex}]:${port}`);
        }
      }
      return out;
    } catch { return null; }
  }
  if (platform === 'darwin') {
    return new Promise((resolve) => {
      let out = '';
      let child;
      try { child = spawn('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve(null); return; }
      const t = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', () => { clearTimeout(t); resolve(null); });
      child.on('close', () => { clearTimeout(t); resolve(out.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1))); });
    });
  }
  return null;
}

const hostOfAddr = (a) => a.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');

/**
 * @param {object} o
 * @param {import('./network.mjs').NetworkGuard} o.network
 * @param {{ sandboxExec: string, profile: string, pid?: number|null, managed?: boolean }} o.ollama
 */
export async function runEgressSelfTest({ network, ollama }) {
  const st = network.status();
  const results = [];
  for (const t of CODE_TARGETS) {
    try { assertEgress(`https://${t}`, 'other'); results.push({ layer: 'code', target: t, result: 'allowed', detail: 'internet access is allowed right now' }); } catch { results.push({ layer: 'code', target: t, result: 'blocked', detail: 'refused by Harness before any name lookup' }); }
  }
  // the managed Ollama must listen on loopback only (the sandbox does not police accepted connections)
  if (ollama.managed && ollama.pid) {
    const addrs = await listeningAddresses(ollama.pid);
    if (!addrs) results.push({ layer: 'listen', target: 'ollama', result: 'inconclusive', detail: 'could not read the listening addresses of the Ollama Harness started' });
    else if (!addrs.length) results.push({ layer: 'listen', target: 'ollama', result: 'inconclusive', detail: 'the Ollama Harness started listens on nothing (yet)' });
    else {
      const exposed = addrs.filter((a) => !isLoopbackHost(hostOfAddr(a)));
      results.push(exposed.length
        ? { layer: 'listen', target: `ollama ${addrs.join(', ')}`, result: 'exposed', detail: `the Ollama Harness started can be reached from other computers on ${exposed.join(', ')}` }
        : { layer: 'listen', target: `ollama ${addrs.join(', ')}`, result: 'loopback', detail: 'the Ollama Harness started listens on this Mac only' });
    }
  } else {
    results.push({ layer: 'listen', target: 'ollama', result: 'skipped', detail: ollama.managed ? 'no process id' : 'Harness did not start this Ollama (its listening address is its own setting)' });
  }
  const target = probeTarget();
  if (!st.blocked || !st.osEnforced) {
    results.push({ layer: 'os', target, result: 'skipped', detail: !st.blocked ? 'internet access is allowed right now' : 'no OS sandbox covers Harness here (only the in-app blocker applies)' });
    return { blocked: st.blocked, osEnforced: st.osEnforced, results };
  }
  const args = ['-e', PROBE_SRC, target, probeTarget6(), probeName()];
  const r = st.osScope === 'backend' ? await runProbe(process.execPath, args) : await runProbe(ollama.sandboxExec, ['-f', ollama.profile, process.execPath, ...args]);
  if (r.error) {
    results.push({ layer: 'os', target, result: 'inconclusive', detail: `could not run the probe inside the sandbox (${r.error})` });
  } else {
    results.push({ layer: 'os', target: `tcp ${target}`, ...classify(r.tcp, 'a direct TCP connection to a public IPv4 address', BLOCKED_SOCKET) });
    results.push({ layer: 'os', target: `tcp ${probeTarget6()}`, ...classify(r.tcp6, 'a direct TCP connection to a public IPv6 address', BLOCKED_SOCKET) });
    results.push({ layer: 'os', target: `udp ${target.split(':')[0]}:53`, ...classify(r.udp, 'a UDP datagram to a public address', BLOCKED_SOCKET) });
    results.push({ layer: 'os', target: `dns ${probeName()}`, ...classify(r.dns, 'a name lookup', BLOCKED_DNS) });
    if ([r.tcp, r.tcp6, r.udp, r.dns].some((x) => x?.ok)) network.osBroken = true;
  }
  return { blocked: st.blocked, osEnforced: network.status().osEnforced, results };
}
