// Which offline-lock profile variant blocks what (CI only)? For each variant: does sandbox-exec accept it,
// what can a process inside reach (net-probe), and can a peer that is NOT loopback connect to a server
// inside (the runner's own LAN address)? Prints one `sb-variant` line per variant.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const probe = path.join(here, 'net-probe.mjs');
const mdns = `(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
(deny mach-lookup (global-name "com.apple.mDNSResponder"))
(deny mach-lookup (global-name "com.apple.dnssd.service"))`;
const head = '(version 1)\n(allow default)\n(deny network*)\n';
const variants = {
  shipped: fs.readFileSync(path.join(repo, 'server/security/offline-lock.sb'), 'utf8'),
  draft: fs.readFileSync(path.join(repo, 'native/probe/offline-lock-draft.sb'), 'utf8'),
  bazel: `${head}(allow network-inbound (local ip "localhost:*"))\n(allow network* (remote ip "localhost:*"))\n(allow network* (remote unix-socket))\n${mdns}\n`,
  noBind: `${head}(allow network-outbound (remote ip "localhost:*"))\n(allow network-inbound (remote ip "localhost:*"))\n(allow network* (remote unix-socket))\n(allow network* (local unix-socket))\n${mdns}\n`,
  inboundLocal: `${head}(allow network-outbound (remote ip "localhost:*"))\n(allow network-inbound (local ip "localhost:*"))\n(allow network-bind (local ip "*:*"))\n(allow network* (remote unix-socket))\n(allow network* (local unix-socket))\n${mdns}\n`,
};
const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address || null;
let ns = null;
try { ns = fs.readFileSync('/etc/resolv.conf', 'utf8').split('\n').find((l) => l.startsWith('nameserver'))?.split(/\s+/)[1] || null; } catch { /* none */ }
console.log(`sb-variant env: lan=${lan} nameserver=${ns}`);

function connect(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 4000 });
    s.once('data', () => { s.destroy(); resolve('ok'); });
    s.once('timeout', () => { s.destroy(); resolve('timeout'); });
    s.once('error', (e) => resolve(`err:${e.code}`));
    s.once('end', () => resolve('closed'));
  });
}

async function inbound(file) {
  const child = spawn('/usr/bin/sandbox-exec', ['-f', file, process.execPath, probe, 'serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve) => {
    let buf = '';
    const t = setTimeout(() => resolve(null), 8000);
    child.stdout.on('data', (d) => { buf += d; const m = buf.match(/PORT (\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    child.stderr.on('data', (d) => { buf += d; });
    child.on('exit', () => { clearTimeout(t); resolve(null); });
  });
  if (!port) { child.kill('SIGKILL'); return { serve: 'no-port' }; }
  const r = { loopback: await connect('127.0.0.1', port), lan: lan ? await connect(lan, port) : 'no-lan-ip' };
  child.kill('SIGKILL');
  return r;
}

for (const [name, text] of Object.entries(variants)) {
  const file = path.join(os.tmpdir(), `harness-sb-${name}.sb`);
  fs.writeFileSync(file, text);
  let parse = 'ok';
  try { execFileSync('/usr/bin/sandbox-exec', ['-f', file, '/usr/bin/true'], { stdio: 'pipe' }); } catch (e) { parse = `err:${String(e.stderr || e.message).trim().slice(0, 160)}`; }
  if (parse !== 'ok') { console.log(`sb-variant ${name}: parse=${parse}`); continue; }
  let inside = null;
  try {
    const out = execFileSync('/usr/bin/sandbox-exec', ['-f', file, process.execPath, probe, name], { encoding: 'utf8', timeout: 90000, env: { ...process.env, HARNESS_SANDBOXED: '1' } });
    inside = JSON.parse(out.trim().replace(/^net-probe /, ''));
    delete inside.label; delete inside.sandboxedEnv;
  } catch (e) { inside = `failed: ${String(e.stderr || e.message).slice(0, 160)}`; }
  console.log(`sb-variant ${name}: inside=${JSON.stringify(inside)} inbound=${JSON.stringify(await inbound(file))}`);
}
// Without any sandbox, for comparison (the LAN connection must work here, or the inbound test proves nothing).
const plainChild = spawn(process.execPath, [probe, 'serve'], { stdio: ['ignore', 'pipe', 'ignore'] });
const plainPort = await new Promise((resolve) => { let b = ''; plainChild.stdout.on('data', (d) => { b += d; const m = b.match(/PORT (\d+)/); if (m) resolve(Number(m[1])); }); setTimeout(() => resolve(null), 8000); });
console.log(`sb-variant none: inbound=${JSON.stringify({ loopback: plainPort ? await connect('127.0.0.1', plainPort) : 'no-port', lan: plainPort && lan ? await connect(lan, plainPort) : 'n/a' })}`);
plainChild.kill('SIGKILL');
