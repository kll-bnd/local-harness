#!/usr/bin/env node
// Drives the real Harness.app in self-test mode on a Mac and checks what only the outside can see: listening
// sockets, child processes after quit, memory, and (with --grep-marker) whether a chat marker is readable on disk.
//   node native/test/run-selftest.mjs --app dist/native/Harness.app --label mock --script native/test/selftest-mock.js
//        [--backend native/test/mock-backend.mjs] [--launches 2] [--files a,b] [--data <dir>] [--timeout 300]
// Prints one `selftest| <label> …` line per fact and appends them to $FACTS.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const app = path.resolve(opt('app', 'dist/native/Harness.app'));
const label = opt('label', 'selftest');
const script = path.resolve(opt('script', 'native/test/selftest-mock.js'));
const backend = opt('backend') ? path.resolve(opt('backend')) : null;
const launches = Number(opt('launches', '1'));
const files = opt('files', '');
const timeoutS = Number(opt('timeout', '300'));
const dataDir = path.resolve(opt('data', fs.mkdtempSync(path.join(os.tmpdir(), `harness-${label}-data-`))));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-${label}-out-`));
const FACTS = process.env.FACTS || '/tmp/native-facts.txt';
const lines = [];
const say = (k, v) => { const l = `selftest| ${label} ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 700); lines.push(l); console.log(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return e.stdout || ''; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function descendants(pid) {
  const out = [];
  const walk = (p) => { for (const c of sh('pgrep', ['-P', String(p)]).split('\n').filter(Boolean).map(Number)) { out.push(c); walk(c); } };
  walk(pid);
  return out;
}

function sockets(pids) {
  const list = pids.join(',');
  const inet = sh('lsof', ['-nP', '-a', '-p', list, '-i']).split('\n').slice(1).filter(Boolean);
  const listen = inet.filter((l) => /\(LISTEN\)/.test(l) || /UDP/.test(l));
  const unix = sh('lsof', ['-nP', '-a', '-p', list, '-U']).split('\n').slice(1).filter(Boolean);
  const short = (l) => l.replace(/\s+/g, ' ').replace(/ 0x[0-9a-f]+ 0t0/, '').slice(0, 110);
  return { inet: inet.length, listening: listen.map(short), connections: inet.filter((l) => !listen.includes(l)).map(short).slice(0, 4), unix: unix.length };
}

function memory(appPid, backendPid) {
  const rss = (pid) => Number(sh('ps', ['-o', 'rss=', '-p', String(pid)]).trim() || 0) * 1024;
  const fp = (pid) => { const m = sh('footprint', ['-p', String(pid)]).match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/i); if (!m) return null; return Math.round(Number(m[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[m[2].toUpperCase()]); };
  const webkit = sh('ps', ['-axo', 'pid=,rss=,comm=']).split('\n').filter((l) => /WebKit\.(WebContent|Networking|GPU)/.test(l)).map((l) => {
    const [pid, kb, ...c] = l.trim().split(/\s+/);
    return { pid: Number(pid), name: c.join(' ').split('.').pop(), mb: Math.round(Number(kb) / 1024), footprintMB: fp(Number(pid)) };
  });
  const r = { appMB: Math.round(rss(appPid) / 1048576), appFootprintMB: fp(appPid), backendMB: backendPid ? Math.round(rss(backendPid) / 1048576) : null, backendFootprintMB: backendPid ? fp(backendPid) : null, webkit };
  r.totalRssMB = r.appMB + (r.backendMB || 0) + webkit.reduce((a, w) => a + w.mb, 0);
  r.totalFootprintMB = (r.appFootprintMB || 0) + (r.backendFootprintMB || 0) + webkit.reduce((a, w) => a + (w.footprintMB || 0), 0);
  return r;
}

const exe = path.join(app, 'Contents', 'MacOS', 'Harness');
let pass = 0, fail = 0, marker = null, lastRes = {};
for (let n = 1; n <= launches; n++) {
  const args = ['--self-test', outDir, '--self-test-script', script, '--data-dir', dataDir];
  if (backend) args.push('--backend', backend);
  if (files) args.push('--open-panel-files', files);
  const logFile = path.join(outDir, `stdio-${n}.log`);
  const out = fs.openSync(logFile, 'w');
  const t0 = Date.now();
  const child = spawn(exe, args, { stdio: ['ignore', out, out], env: { ...process.env, HARNESS_GLOBAL_SHORTCUT: 'CommandOrControl+Shift+Space' } });
  let exited = null;
  child.on('exit', (code, sig) => { exited = { code, sig, s: Math.round((Date.now() - t0) / 1000) }; });
  // Wait for the page.
  let st = null;
  for (let i = 0; i < 600 && !exited; i++) { st = readJson(path.join(outDir, 'state.json')); if (st?.pageLoads >= 1 && st?.launch === n) break; await sleep(100); }
  if (st?.pageLoads >= 1) {
    say(`launch${n}.firstPage`, `${Date.now() - t0} ms after start`);
    const pids = [child.pid, ...descendants(child.pid)];
    const name = (p) => sh('ps', ['-o', 'comm=', '-p', String(p)]).trim().split('/').pop();
    const kids = pids.slice(1).map((p) => `${p}:${name(p)}`);
    say(`launch${n}.processes`, kids);
    // The app and the backend must hold no socket at all; an Ollama the backend started is the model server and
    // listens on 127.0.0.1 by design (reported separately).
    const ours = pids.filter((p) => !/^ollama/.test(name(p)));
    const theirs = pids.filter((p) => /^ollama/.test(name(p)));
    const sk = sockets(ours);
    say(`launch${n}.sockets`, { ok: sk.listening.length === 0, appAndBackend: sk, ollama: theirs.length ? sockets(theirs).listening : 'not started' });
    if (n === 1) { await sleep(Number(opt('settle', '8')) * 1000); say(`launch${n}.memory`, memory(child.pid, st.backendPid)); }
  } else {
    say(`launch${n}.firstPage`, `none (state ${JSON.stringify(st)})`);
  }
  for (let i = 0; i < timeoutS * 10 && !exited; i++) await sleep(100);
  if (!exited) { say(`launch${n}.exit`, 'timeout: killing'); child.kill('SIGKILL'); await sleep(500); }
  else say(`launch${n}.exit`, exited);
  const res = readJson(path.join(outDir, 'results.json')) || {};
  const backends = res.lists?.backendPids || [];
  await sleep(1500);
  const leftovers = [...backends.filter(alive), ...descendants(child.pid)];
  const ollama = sh('pgrep', ['-x', 'ollama']).trim();
  say(`launch${n}.cleanQuit`, { ok: exited?.code === 0 && leftovers.length === 0, status: res.status || null, leftoverProcesses: leftovers, ollamaRunning: ollama ? ollama.split('\n').length : 0 });
  if (exited?.code === 0 && leftovers.length === 0) pass++; else fail++;
  const passed = [];
  for (const [k, v] of Object.entries(res).filter(([k]) => k.startsWith('page.') && k !== 'page.marker')) {
    const ok = v && v.ok === true;
    if (ok) { pass++; passed.push(k.slice(5)); continue; }
    fail++;
    const detail = { ...v };
    delete detail.ok;
    say(`FAIL ${k.slice(5)}`, detail);
  }
  if (passed.length) say(`launch${n}.PASS`, passed.join(' '));
  for (const k of (opt('show', '') || '').split(',').filter(Boolean)) if (res[`page.${k}`]) say(`detail ${k}`, res[`page.${k}`]);
  if (res['page.marker']?.marker) marker = res['page.marker'].marker;
  lastRes = res;
  if (n < launches) await sleep(1000);
}

const res = lastRes;

if (marker) {
  const hits = sh('grep', ['-rlF', marker, dataDir]).split('\n').filter(Boolean).map((f) => path.relative(dataDir, f));
  const plainHits = hits.filter((f) => !f.startsWith('logs/'));
  say(`${plainHits.length === 0 ? 'PASS' : 'FAIL'} markerNotOnDisk`, { files: hits.length, plainFiles: plainHits, scanned: sh('find', [dataDir, '-type', 'f']).split('\n').filter(Boolean).length });
  if (plainHits.length) fail++; else pass++;
}
say('records', { contentRules: res.contentRules, keychainRead: res.keychainRead ?? null, keychainStore: res.keychainStore ?? null, startupError: res.startupError ?? null, downloads: (res.lists?.downloads || []).length, blocked: (res.lists?.blocked || []).slice(0, 4) });
say('summary', `${pass} passed, ${fail} failed`);
const appLog = path.join(dataDir, 'logs', 'harness.log');
if (fs.existsSync(appLog)) {
  const tail = fs.readFileSync(appLog, 'utf8').split('\n').filter((l) => /\[native|ERROR|WARN/.test(l)).slice(-Number(opt('log-lines', '12')));
  for (const l of tail) say('log', l.replace(/^\[native \S+\] /, '').slice(0, 200));
}
fs.appendFileSync(FACTS, lines.join('\n') + '\n');
process.exit(0);
