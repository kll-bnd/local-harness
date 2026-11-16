// Idle memory of the Electron build for comparison (CI only). Launches dist/mac-arm64/Harness.app on a fresh data
// folder, waits for its UI, measures the app and all its helper processes, quits it. Prints one `electron|` line.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const app = path.resolve(process.argv[2] || 'dist/mac-arm64/Harness.app');
const settle = Number(process.argv[3] || 20);
const FACTS = process.env.FACTS || '/tmp/native-facts.txt';
const sh = (c, a) => { try { return execFileSync(c, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return e.stdout || ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-electron-'));
const exe = path.join(app, 'Contents', 'MacOS', 'Harness');
const child = spawn(exe, [], { env: { ...process.env, HARNESS_DATA_DIR: data, HARNESS_GLOBAL_SHORTCUT: '' }, stdio: 'ignore' });
let up = false;
for (let i = 0; i < 300 && !up; i++) {
  try { const r = await fetch('http://127.0.0.1:4747/api/health'); up = r.ok; } catch { /* not yet */ }
  await sleep(200);
}
await sleep(settle * 1000);
const desc = (pid) => { const out = []; const walk = (p) => { for (const c of sh('pgrep', ['-P', String(p)]).split('\n').filter(Boolean).map(Number)) { out.push(c); walk(c); } }; walk(pid); return out; };
const fp = (pid) => { const m = sh('footprint', ['-p', String(pid)]).match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/i); return m ? Math.round(Number(m[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[m[2].toUpperCase()]) : null; };
const procs = [child.pid, ...desc(child.pid)].map((pid) => {
  const [kb, ...c] = sh('ps', ['-o', 'rss=,comm=', '-p', String(pid)]).trim().split(/\s+/);
  return { pid, name: c.join(' ').split('/').pop(), mb: Math.round(Number(kb) / 1024), footprintMB: fp(pid) };
});
const total = procs.reduce((a, p) => a + p.mb, 0);
const totalFp = procs.reduce((a, p) => a + (p.footprintMB || 0), 0);
const size = sh('du', ['-sh', app]).split('\t')[0];
const line = `electron| idle after ${settle} s (server up: ${up}): total RSS ${total} MB, footprint ${totalFp} MB, app size ${size}; ${JSON.stringify(procs.map((p) => `${p.name} ${p.mb}/${p.footprintMB}`))}`;
console.log(line);
fs.appendFileSync(FACTS, line + '\n');
child.kill('SIGTERM');
for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(200);
if (child.exitCode === null) child.kill('SIGKILL');
