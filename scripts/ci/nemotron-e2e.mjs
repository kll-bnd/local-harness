#!/usr/bin/env node
// CI-only: end-to-end proof of the user's scenario on a real Mac — Harness + a real Ollama + Nemotron 3.5 Bolt E4B,
// driven ONLY through Harness's public HTTP/SSE API (the server runs in-process on a free port with a temp data dir;
// test/fake-a1111.mjs stands in for Draw Things). Nothing else is simulated — in particular not the RAM size.
//
//   node scripts/ci/nemotron-e2e.mjs
//   env: OLLAMA_URL (default http://127.0.0.1:11434)  TAG (model to pull; default: the backend's choice)
//        CLEANUP=1 (delete the text-only copy and the pulled model at the end)  BUDGET_MIN (default 25)
//
// Prints one compact line per fact and ends with a summary block (one line per step). Exit 0 when steps 1–8 passed.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const TAG_ENV = process.env.TAG || '';
const CLEANUP = process.env.CLEANUP === '1';
const BUDGET_MS = Number(process.env.BUDGET_MIN || 25) * 60000;
const MIN = 60000;
const T0 = Date.now();

// Harness reads the Ollama URL from OLLAMA_HOST; Ollama is already running, so no auto-start.
process.env.OLLAMA_HOST = new URL(OLLAMA_URL).host;
process.env.HARNESS_NO_OLLAMA_AUTOSTART = '1';

// ------------------------------------------------------------------------------------------------ output helpers
const clip = (s, n = 300) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…(+${t.length - n})` : t; };
const j = (v, n = 300) => clip(JSON.stringify(v, (k, x) => (typeof x === 'string' ? clip(x, 160) : x)), n);
const say = (label, v = '') => console.log(clip(`  ${label}${v === '' ? '' : `: ${typeof v === 'string' ? v : j(v)}`}`, 320));
const gb = (b) => (Number.isFinite(b) ? `${(b / 1024 ** 3).toFixed(2)} GB` : String(b));
const mb = (b) => (Number.isFinite(b) ? `${Math.round(b / 1024 ** 2)} MB` : String(b));
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const elapsed = () => secs(Date.now() - T0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Skip extends Error {}
class Check extends Error {} // an expected check failure (no stack trace in the output)
const skip = (why) => { throw new Skip(why); };
const fail = (why) => { throw new Check(why); };
const results = [];

async function step(n, name, fn, { optional = false, minLeftMs = 0 } = {}) {
  const t = Date.now();
  console.log(`\n## ${n}. ${name}  [t+${elapsed()}]`);
  let status = 'PASS';
  let key = '';
  try {
    if (optional && Date.now() - T0 + minLeftMs > BUDGET_MS) skip(`time budget (${Math.round(BUDGET_MS / MIN)} min) nearly used`);
    const r = (await fn()) || {};
    status = r.status || 'PASS';
    key = r.key || '';
  } catch (e) {
    status = e instanceof Skip ? 'SKIP' : 'FAIL';
    key = e instanceof Skip || e instanceof Check ? e.message : `${e.message} @ ${String(e.stack || '').split('\n')[1]?.trim()}`;
  }
  console.log(clip(`=> ${status} (${secs(Date.now() - t)}) ${key}`, 400));
  results.push({ n, name, status, key, ms: Date.now() - t });
  return status;
}

// ------------------------------------------------------------------------------------------------ HTTP (node:http)
let BASE = null;
/** JSON (or raw) request; node:http so nothing gives up after 300 s without headers. */
function api(method, p, body, { timeoutMs = 2 * MIN, raw = false, base = BASE } = {}) {
  const u = new URL(base + p);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        if (!raw) { try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ } }
        resolve({ status: res.statusCode, json, buf, headers: res.headers, ms: Date.now() - t0 });
      });
      res.on('error', (e) => resolve({ status: 0, error: e.message, ms: Date.now() - t0 }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${secs(timeoutMs)}`)));
    req.on('error', (e) => resolve({ status: 0, error: e.message, ms: Date.now() - t0 }));
    if (data) req.write(data);
    req.end();
  });
}

function parseSseBlock(block) {
  let type = null;
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) type = line.slice(7);
    else if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  if (!type || !data.length) return null;
  try { return { type, ...JSON.parse(data.join('\n')) }; } catch { return null; }
}

/**
 * POST (or GET) an SSE endpoint; collects every event with `t` = ms since the request. Closing (timeout) aborts the
 * server-side job. Returns { status, events, error?, timedOut?, ms }.
 */
function sse(method, p, body, { timeoutMs = 10 * MIN, onEvent = null } = {}) {
  const u = new URL(BASE + p);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const events = [];
    let done = false;
    const finish = (extra) => { if (!done) { done = true; clearTimeout(timer); resolve({ events, ms: Date.now() - t0, ...extra }); } };
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, (res) => {
      const ct = res.headers['content-type'] || '';
      if (!ct.includes('event-stream')) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ } finish({ status: res.statusCode, error: json?.error || { message: `HTTP ${res.statusCode}` } }); });
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = parseSseBlock(buf.slice(0, i));
          buf = buf.slice(i + 2);
          if (ev) { ev.t = Date.now() - t0; events.push(ev); try { onEvent?.(ev); } catch { /* printing only */ } }
        }
      });
      res.on('end', () => finish({ status: res.statusCode }));
      res.on('error', (e) => finish({ status: res.statusCode, error: { message: e.message } }));
    });
    const timer = setTimeout(() => { req.destroy(); finish({ status: 0, timedOut: true, error: { message: `no end of stream after ${secs(timeoutMs)} (aborted)` } }); }, timeoutMs);
    req.on('error', (e) => finish({ status: 0, error: { message: e.message } }));
    if (data) req.write(data);
    req.end();
  });
}

const byType = (events, type) => events.filter((e) => e.type === type);

/** "start@0.0 context@0.1 model_status(loading)@0.1 token×23@5.2–9.8 stats@9.9 done@10.0" (clipped into lines). */
function timeline(events) {
  const parts = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const runType = ['token', 'reasoning', 'image_progress', 'progress'].includes(e.type) ? e.type : null;
    if (runType) {
      let k = i;
      while (k + 1 < events.length && events[k + 1].type === runType) k++;
      parts.push(`${runType}×${k - i + 1}@${(e.t / 1000).toFixed(1)}–${(events[k].t / 1000).toFixed(1)}`);
      i = k;
      continue;
    }
    const sub = e.type === 'model_status' ? `(${e.phase}${e.reason ? `:${e.reason}` : ''})` : e.type === 'image_status' ? `(${e.phase})` : e.type === 'compaction' ? `(${e.status})` : e.type === 'notice' ? `(${e.code})` : e.type === 'error' ? `(${e.code})` : '';
    parts.push(`${e.type}${sub}@${(e.t / 1000).toFixed(1)}`);
  }
  const lines = [];
  let cur = '';
  for (const p of parts) { if ((cur + ' ' + p).length > 290) { lines.push(cur); cur = p; } else cur = cur ? `${cur} ${p}` : p; }
  if (cur) lines.push(cur);
  return lines.slice(0, 6);
}

function printTurn(r, label = 'turn') {
  if (r.error && !r.events.length) { say(`${label} failed`, `HTTP ${r.status} ${j(r.error)}`); return null; }
  for (const l of timeline(r.events)) say('events', l);
  const ms = byType(r.events, 'model_status');
  if (ms.length) say('model_status', ms.map((e) => `${e.phase}${e.reason ? `(${e.reason})` : ''}${e.loadMs != null ? ` load ${secs(e.loadMs)}` : ''}@${secs(e.t)}`).join(' → '));
  for (const n of byType(r.events, 'notice')) say(`notice ${n.code}`, n.message);
  const err = byType(r.events, 'error')[0];
  if (err) say('error', `${err.code}: ${err.message}${err.nextSteps ? ` | nextSteps ${err.nextSteps.map((s) => s.action).join(',')}` : ''}`);
  const done = byType(r.events, 'done')[0];
  const reasoning = byType(r.events, 'reasoning').map((e) => e.delta).join('');
  if (reasoning) say('reasoning', `${reasoning.length} chars: ${clip(reasoning.replace(/\s+/g, ' '), 200)}`);
  if (done) {
    say('text', `${done.message?.fallback ? `[fallback ${done.message.fallback}] ` : ''}${clip((done.message?.content || '').replace(/\s+/g, ' '), 260)}`);
    say('done', `reason ${done.reason}, ${secs(done.t)} total`);
  }
  const stats = byType(r.events, 'stats');
  for (const st of stats) say(`stats[${st.iteration}]`, `prompt ${st.promptTokens} tok (cached ${st.cachedPromptTokens ?? 'n/a'}), reply ${st.completionTokens} tok, ${st.tokensPerSecond} tok/s, prompt ${st.promptTokensPerSecond} tok/s, load ${secs(st.loadMs || 0)}, call ${secs(st.totalMs || 0)}`);
  const ctx = byType(r.events, 'context')[0];
  if (ctx) say('context', `numCtx ${ctx.numCtx}, used ${ctx.used} (${ctx.percent}%), calibration ${ctx.calibration}, breakdown ${j(ctx.breakdown, 200)}`);
  return done;
}

// ------------------------------------------------------------------------------------------------ bus listener
const bus = [];
let busReq = null;
function listenBus() {
  const u = new URL(`${BASE}/api/events`);
  busReq = http.get({ host: u.hostname, port: u.port, path: u.pathname }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = parseSseBlock(buf.slice(0, i));
        buf = buf.slice(i + 2);
        if (ev) { ev.at = Date.now(); bus.push(ev); if (bus.length > 5000) bus.splice(0, 1000); }
      }
    });
    res.on('error', () => {});
  });
  busReq.on('error', () => {});
}

/** What the background queue is doing right before a turn (a running model task gets pre-empted by it). */
const preemptions = [];
async function noteBackground(label) {
  const s = await api('GET', '/api/system', undefined, { timeoutMs: 30000 });
  const bg = s.json?.background;
  if (bg?.running) preemptions.push({ label, task: bg.running.key, at: Date.now() });
}

// ------------------------------------------------------------------------------------------------ the run
const S = {}; // shared state between steps

async function main() {
  console.log(`# Harness × Nemotron end-to-end — node ${process.version}, ${process.platform}/${process.arch}, ${gb(os.totalmem())} RAM (real), Ollama ${OLLAMA_URL}, budget ${Math.round(BUDGET_MS / MIN)} min${TAG_ENV ? `, TAG=${TAG_ENV}` : ''}${CLEANUP ? ', CLEANUP=1' : ''}`);
  const { startServer } = await import(path.join(ROOT, 'server', 'index.mjs'));
  const { startFakeA1111 } = await import(path.join(ROOT, 'test', 'fake-a1111.mjs'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-e2e-'));
  // stepMs 150 × 2–4 steps: a short but visible "generating" phase
  const a1111 = await startFakeA1111({ port: 0, stepMs: 150, drawThings: true });
  const srv = await startServer({ port: 0, dataDir, autodetect: false, openBrowser: false, logLevel: 'warn', processGuards: true });
  BASE = srv.url;
  say('harness', `${srv.url} data ${dataDir}; Draw Things stand-in (fake A1111) ${a1111.url}`);
  listenBus();

  // Settings through the API: no other local servers, quick memory extraction, short summaries for step 11.
  const pre = await api('PATCH', '/api/settings', { providers: { autodetect: false }, memory: { extractDelayMs: 1000 }, compaction: { maxSummaryTokens: 64 } });
  if (pre.status !== 200) say('settings patch failed', j(pre.json));

  const model = () => ({ providerId: 'ollama', model: S.copy || S.tag });
  const needModel = () => { if (!S.installed) skip('no installed Nemotron model (step 3 failed)'); };
  const needChat = () => { needModel(); if (!S.chatOk) skip('the plain chat turn (step 6) did not work'); };
  const critical = [];
  const run = async (n, name, fn, opts) => { const st = await step(n, name, fn, opts); if (n <= 8) critical.push(st); return st; };

  // 1 ------------------------------------------------------------------------------------------
  await run(1, 'System info', async () => {
    const r = await api('GET', '/api/system?refresh=1');
    if (r.status !== 200) fail(`GET /api/system → ${r.status}`);
    const m = r.json.machine;
    say('machine', `${m.platform}/${m.arch}, ${m.chip}, ${m.cpus} cpus, ${gb(m.totalMemBytes)} RAM, tier ${m.ramTier}, safe budget ${gb(m.memoryBudget?.budgetBytes)} (${m.memoryBudget?.source})`);
    const o = r.json.providers.find((p) => p.id === 'ollama');
    say('ollama', `${o?.status} ${o?.version || ''} at ${o?.baseUrl}${o?.error ? ` (${o.error})` : ''}`);
    const pr = r.json.ollama?.protections;
    say('protections', `inEffect ${pr?.inEffect}, external ${pr?.external ?? false}: ${pr?.message}`);
    say('kv/env Harness would set', j(pr?.wanted, 280));
    S.tier = m.ramTier;
    if (o?.status !== 'running') fail('Ollama is not reachable');
    const external = pr?.inEffect === false && pr?.external === true;
    return { key: `${m.platform}/${m.arch} ${gb(m.totalMemBytes)} tier ${m.ramTier} budget ${gb(m.memoryBudget?.budgetBytes)}; Ollama ${o.version}; protections ${external ? 'not in effect (external Ollama, as expected)' : `inEffect=${pr?.inEffect}`}`, status: external ? 'PASS' : 'WARN' };
  });

  // 2 ------------------------------------------------------------------------------------------
  await run(2, 'Recommended models for this machine', async () => {
    const r = await api('GET', '/api/models/recommended');
    if (r.status !== 200) fail(`→ ${r.status}`);
    say('machine', j(r.json.machine));
    for (const m of r.json.models) {
      say(`model ${m.id}`, `suggested ${m.suggestedVariant}${m.largestRealisticVariant ? `, largestRealistic ${m.largestRealisticVariant}` : ''}${m.suggestTextOnly ? ', suggestTextOnly' : ''}, fitsThisMachine ${m.fitsThisMachine}, installed ${m.installed}`);
      if (m.id !== 'nemotron-3.5-bolt-e4b') continue;
      if (m.lowRamNote) say('lowRamNote', m.lowRamNote);
      for (const v of m.variants) {
        say(`  variant ${v.model.replace('hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF', 'hf…GGUF')}`, `${gb(v.approxSizeBytes)}${v.textOnlyBytes ? `, text-only ${gb(v.textOnlyBytes)}` : ''}${v.lowRam ? `, lowRam ${v.lowRam}` : ''}${v.notForThisMachine ? ', notForThisMachine' : ''}; est. ${v.estimate.numCtx} ctx, fits ${v.estimate.fits}, ${v.estimate.limitedBy}${v.estimate.basis ? `, basis ${v.estimate.basis}` : ''}${v.textOnly ? `; copy ${v.textOnly.model} recommended ${v.textOnly.recommended}` : ''}`);
      }
      const q3 = m.variants.find((v) => v.lowRam === 'largest_realistic') || m.variants[0];
      say('example explanation', q3.estimate.explanation);
      if (m.avoid?.length) say('avoid', m.avoid.map((a) => a.model.split(':').pop()).join(', '));
      S.nemo = m;
    }
    if (!S.nemo) fail('no Nemotron entry');
    return { key: `suggested ${S.nemo.suggestedVariant}${S.nemo.largestRealisticVariant ? ` / largest realistic ${S.nemo.largestRealisticVariant}` : ''}, text-only ${!!S.nemo.suggestTextOnly}, fits ${S.nemo.fitsThisMachine}` };
  });

  // 3 ------------------------------------------------------------------------------------------
  await run(3, 'Pull the recommended Nemotron file through Harness', async () => {
    let why;
    if (TAG_ENV) { S.tag = TAG_ENV; why = 'TAG from the environment'; } else if (S.nemo?.largestRealisticVariant) { S.tag = S.nemo.largestRealisticVariant; why = `the backend's "largest realistic" choice for this ${S.tier}-RAM machine (its comfortable suggestion would be ${S.nemo.suggestedVariant})`; } else if (S.nemo?.suggestedVariant) { S.tag = S.nemo.suggestedVariant; why = "the backend's suggestedVariant (largest that fits with a useful window)"; } else fail('no tag to pull');
    say('tag', `${S.tag} — ${why}`);
    const list = await api('GET', '/api/models?refresh=1');
    if (list.json?.models?.some((m) => m.model === S.tag)) { S.installed = true; say('already installed', 'skipping the download'); return { key: `${S.tag} already installed`, status: 'PASS' }; }
    let lastPrint = 0;
    let printed = 0;
    const r = await sse('POST', '/api/models/pull', { model: S.tag }, {
      timeoutMs: 30 * MIN,
      onEvent: (e) => {
        if (e.type === 'start') say('start', `${e.model}${e.warning ? ` WARNING ${e.warning.message}` : ''}`);
        else if (e.type === 'progress' && e.total && (Date.now() - lastPrint > 15000 || e.completed === e.total) && printed < 12) { lastPrint = Date.now(); printed++; say(`progress @${secs(e.t)}`, `${e.status} ${mb(e.completed)}/${mb(e.total)} (${e.percent ?? Math.round((e.completed / e.total) * 100)}%)`); } else if (e.type === 'error') say('error', `${e.code}: ${e.message}`);
      },
    });
    const done = byType(r.events, 'done')[0];
    if (!done) fail(`pull did not finish: ${j(r.error || byType(r.events, 'error')[0])}`);
    S.installed = true;
    const steps = byType(r.events, 'progress');
    const bytes = Math.max(0, ...steps.map((p) => p.total || 0));
    return { key: `${S.tag} pulled in ${secs(r.ms)} (${steps.length} progress events, largest layer ${mb(bytes)})` };
  });

  // 4 ------------------------------------------------------------------------------------------
  await run(4, 'Create the text-only copy', async () => {
    needModel();
    const r = await api('POST', '/api/models/text-only', { model: S.tag }, { timeoutMs: 5 * MIN });
    say(`POST /api/models/text-only → ${r.status}`, j(r.json, 300));
    if (r.status !== 201 && r.status !== 200) fail(`${r.json?.error?.code}: ${r.json?.error?.message}`);
    S.copy = r.json.model;
    const info = await api('GET', `/api/models/info?model=${encodeURIComponent(S.copy)}`);
    say('copy info', `capabilities ${j(info.json?.info?.capabilities)}, size ${gb(info.json?.info?.sizeBytes)}, blobs ${info.json?.info?.blobs?.length}, hasProjector ${info.json?.info?.hasProjector}, ctx ${info.json?.info?.contextLength} (${info.json?.info?.contextLengthSource})`);
    const def = (await api('GET', '/api/models')).json?.defaultModel;
    let status = 'PASS';
    let note = `default model is the copy (${def?.model})`;
    if (def?.model !== S.copy) {
      status = 'WARN';
      note = `default was ${def?.model}, not the copy — set explicitly`;
      await api('PATCH', '/api/settings', { defaultModel: { providerId: 'ollama', model: S.copy } });
    }
    say('default model', note);
    return { key: `${S.copy} (${r.json.created ? 'created' : 'existed'}, template ${r.json.template}, caps ${(r.json.capabilities || []).join('/')}); ${note}`, status };
  });


  // 5 ------------------------------------------------------------------------------------------
  const showPlan = async (label) => {
    const r = await api('GET', `/api/models/context?model=${encodeURIComponent(model().model)}`, undefined, { timeoutMs: 2 * MIN });
    const p = r.json?.contextPlan;
    if (!p) fail(`no plan: ${j(r.json)}`);
    say(`${label}`, `numCtx ${p.numCtx}, limitedBy ${p.limitedBy}, basis ${p.memory?.basis}, kv ${p.memory?.kvCacheType}/${p.memory?.kvCacheTypeSource}, est. ${gb(p.memory?.estimatedTotalBytes)} of budget ${gb(p.memory?.budgetBytes)}, contextCheap ${p.memory?.contextCheap}${p.memory?.pressure ? `, pressure ${j(p.memory.pressure, 160)}` : ''}`);
    say('explanation', p.explanation);
    for (const w of p.warnings || []) say(`warning ${w.code}`, w.message);
    return p;
  };
  await run(5, 'Context plan for the copy on this machine', async () => {
    needModel();
    S.plan0 = await showPlan('plan');
    return { key: `numCtx ${S.plan0.numCtx}, ${S.plan0.limitedBy}, basis ${S.plan0.memory?.basis}, warnings ${(S.plan0.warnings || []).map((w) => w.code).join(',') || 'none'}` };
  });

  // A chat with tiny prompts and replies (the virtual GPU is slow): short system prompt, tools off, small num_predict.
  const newChat = async (settings, title) => {
    const r = await api('POST', '/api/chats', { ...(title ? { title } : {}), settings: { model: model(), systemPrompt: 'You are a concise assistant. Answer briefly.', tools: { enabled: false }, params: { num_predict: 48, temperature: 0.7 }, ...settings } });
    if (r.status !== 201) fail(`create chat → ${r.status} ${j(r.json)}`);
    return r.json.chat.id;
  };
  const send = async (chatId, content, label, timeoutMs = 10 * MIN) => {
    await noteBackground(label);
    return sse('POST', `/api/chats/${chatId}/messages`, { content }, { timeoutMs });
  };

  // 6 ------------------------------------------------------------------------------------------
  await run(6, 'Plain chat turn (SSE) + resulting measurement', async () => {
    needModel();
    S.chat1 = await newChat({});
    const r = await send(S.chat1, 'Hi! My name is Ada and I live in Lisbon. Reply with one short sentence.', 'turn 1');
    const done = printTurn(r, 'turn 1');
    S.turn1 = r;
    if (!done) fail(`no done: ${j(r.error || byType(r.events, 'error')[0])}`);
    S.chatOk = true;
    const meas = await api('GET', `/api/models/measurements?model=${encodeURIComponent(model().model)}`);
    const samples = meas.json?.samples || [];
    say('measurements', `${samples.length} sample(s), basis ${meas.json?.basis}, loadedNumCtx ${meas.json?.loadedNumCtx}`);
    for (const smp of samples.slice(-2)) say('sample', `ctx ${smp.numCtx} (sent ${smp.sentNumCtx}, reported ${smp.reportedContext}), total ${gb(smp.totalBytes)} via ${smp.source}, rss ${gb(smp.rssBytes)}, ps size ${mb(smp.psSizeBytes)}/vram ${mb(smp.psVramBytes)}, cpu ${mb(smp.cpuBytes)}, loaded ${smp.loaded}, pressure ${j(smp.pressure, 200)}`);
    await probeDiagnostics();
    S.plan1 = await showPlan('plan after turn 1');
    const changed = S.plan1.numCtx !== S.plan0?.numCtx ? ` (${S.plan0?.numCtx} → ${S.plan1.numCtx})` : '';
    const st = byType(r.events, 'stats')[0];
    return { key: `${secs(r.ms)}; ${st?.completionTokens} tok @ ${st?.tokensPerSecond} tok/s, prompt ${st?.promptTokens} @ ${st?.promptTokensPerSecond} tok/s, load ${secs(st?.loadMs || 0)}; samples ${samples.length} (${samples.at(-1)?.source || 'none'}); plan basis ${S.plan1.memory?.basis}${changed}, ${S.plan1.limitedBy}` };
  });

  // 7 ------------------------------------------------------------------------------------------
  await run(7, 'Second turn in the same chat (prompt cache, calibration)', async () => {
    needChat();
    const r = await send(S.chat1, 'Now one short sentence about snow.', 'turn 2');
    const done = printTurn(r, 'turn 2');
    if (!done) fail(`no done: ${j(r.error || byType(r.events, 'error')[0])}`);
    const c1 = byType(S.turn1.events, 'context')[0]?.calibration;
    const c2 = byType(r.events, 'context')[0]?.calibration;
    const ctx = await api('GET', `/api/chats/${S.chat1}/context`);
    const c3 = ctx.json?.context?.calibration;
    const st = byType(r.events, 'stats')[0];
    say('calibration', `turn 1 ${c1} → turn 2 ${c2} → now ${c3}`);
    say('prompt cache', `prompt ${st?.promptTokens} tokens, ${st?.cachedPromptTokens ?? 'n/a'} reused`);
    return { key: `${secs(r.ms)}; prompt ${st?.promptTokens} tok, cached ${st?.cachedPromptTokens ?? 'n/a'}; calibration ${c1} → ${c3}${c1 !== c3 ? ' (moved)' : ' (unchanged)'}`, status: st?.cachedPromptTokens > 0 || c1 !== c3 ? 'PASS' : 'WARN' };
  });

  // 8 ------------------------------------------------------------------------------------------
  await run(8, '"Draw me a red fox in the snow." — the model calls generate_image', async () => {
    needModel();
    const reg = await api('POST', '/api/images/providers', { name: 'Draw Things (stand-in)', kind: 'a1111', baseUrl: a1111.url });
    say('image provider', `${reg.status} ${reg.json?.provider?.id} ${reg.json?.provider?.status}`);
    const chat = await newChat({ tools: { enabled: true, builtin: { generate_image: true, remember: false, recall: false, get_current_time: false, calculate: false, fetch_url: false } }, params: { num_predict: 96, temperature: 0.7 } });
    S.chatImg = chat;
    const r = await send(chat, 'Draw me a red fox in the snow.', 'image turn', 14 * MIN);
    printTurn(r, 'image turn');
    const call = byType(r.events, 'tool_call')[0];
    if (call) say('tool_call', `${call.toolCall.name} ${j(call.toolCall.arguments, 240)} (id ${call.toolCall.id})`);
    const phases = byType(r.events, 'image_status').map((e) => `${e.phase}${e.reason ? `(${e.reason})` : ''}${e.models ? ` ${e.models.join(',')}` : ''}${e.confirmed !== undefined ? ` confirmed=${e.confirmed}` : ''}@${secs(e.t)}`);
    if (phases.length) say('image phases', phases.join(' → '));
    const img = byType(r.events, 'image')[0]?.image;
    const idone = byType(r.events, 'image_done')[0];
    if (img) say('image', `${img.id} ${img.width}×${img.height} ${img.mime} ${img.bytes} B, seed ${img.seed}, model ${img.model}, prompt "${clip(img.prompt, 120)}"`);
    if (idone) say('image_done', `chatModelUnloaded ${idone.chatModelUnloaded}, reload ${idone.reload}, memory ${j(idone.job?.memory, 220)}`);
    const tr = byType(r.events, 'tool_result')[0];
    if (tr) say('tool_result', clip(tr.content, 200));
    if (!call) fail(`the model did not call a tool (${byType(r.events, 'done')[0] ? 'answered in text' : j(r.error || byType(r.events, 'error')[0])})`);
    if (call.toolCall.name !== 'generate_image') fail(`called ${call.toolCall.name}`);
    if (!img) fail('no image event');
    const file = await api('GET', img.url, undefined, { raw: true });
    const b = file.buf || Buffer.alloc(0);
    const png = b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.subarray(12, 16).toString('latin1') === 'IHDR';
    const w = png ? b.readUInt32BE(16) : null;
    const h = png ? b.readUInt32BE(20) : null;
    say('image bytes', `GET ${img.url} → ${file.status}, ${b.length} B, ${file.headers?.['content-type']}, PNG ${png}${png ? ` ${w}×${h}` : ''}`);
    const done = byType(r.events, 'done')[0];
    if (!png) fail('image bytes are not a valid PNG');
    if (!done) fail(`image generated but the turn did not finish: ${j(r.error || byType(r.events, 'error')[0])}`);
    return { key: `${secs(r.ms)}; args ${j(call.toolCall.arguments, 80)}; phases ${byType(r.events, 'image_status').map((e) => e.phase).join('>')}; PNG ${w}×${h}; final ${done.message?.fallback ? `fallback ${done.message.fallback}` : 'text'}: "${clip(done.message?.content, 60)}"` };
  });

  // 9 ------------------------------------------------------------------------------------------
  await step(9, 'Thinking on, then off', async () => {
    needChat();
    const caps = (await api('GET', `/api/models/info?model=${encodeURIComponent(model().model)}`)).json?.info?.capabilities || [];
    if (!caps.includes('thinking')) skip(`${model().model} lists no "thinking" capability (${caps.join('/')}) — Harness never sends think:true to it`);
    const chat = await newChat({ reasoning: { think: 'on' }, params: { num_predict: 160, temperature: 0.6 } });
    const on = await send(chat, 'What is 17+25? Answer with only the number.', 'think on', 8 * MIN);
    printTurn(on, 'think on');
    const rOn = byType(on.events, 'reasoning').map((e) => e.delta).join('');
    const aOn = byType(on.events, 'done')[0]?.message?.content || '';
    await api('PATCH', `/api/chats/${chat}`, { settings: { reasoning: { think: 'off' }, params: { num_predict: 32 } } });
    const off = await send(chat, 'And 10+5? Only the number.', 'think off', 6 * MIN);
    printTurn(off, 'think off');
    const rOff = byType(off.events, 'reasoning').map((e) => e.delta).join('');
    const aOff = byType(off.events, 'done')[0]?.message?.content || '';
    const ok = rOn.length > 0 && rOff.length === 0 && aOff.trim().length > 0;
    return { key: `on: ${rOn.length} reasoning chars separate, answer "${clip(aOn.trim(), 40)}"; off: ${rOff.length} reasoning chars, answer "${clip(aOff.trim(), 40)}"`, status: ok ? (aOn.trim() ? 'PASS' : 'WARN') : 'FAIL' };
  }, { optional: true, minLeftMs: 4 * MIN });

  // 10 -----------------------------------------------------------------------------------------
  await step(10, 'Auto-title and memory extraction (background)', async () => {
    needChat();
    const deadline = Math.min(Date.now() + 7 * MIN, T0 + BUDGET_MS - 2 * MIN);
    let bg = null;
    let chat = null;
    let idlePolls = 0;
    for (;;) {
      bg = (await api('GET', '/api/system', undefined, { timeoutMs: 30000 })).json?.background;
      chat = (await api('GET', `/api/chats/${S.chat1}`)).json?.chat;
      const idle = !bg?.running && !(bg?.pending || []).length;
      idlePolls = idle ? idlePolls + 1 : 0;
      // done when the queue is idle and the title arrived — or idle for 30 s (nothing more is coming)
      if ((idle && chat?.titleSource === 'auto') || idlePolls >= 6 || Date.now() > deadline) break;
      await sleep(5000);
    }
    const titleEv = bus.find((e) => e.type === 'chat.updated' && e.chat?.id === S.chat1 && e.chat?.titleSource === 'auto');
    const memEv = bus.filter((e) => e.type === 'memory.extracted');
    const gens = bus.filter((e) => e.type === 'generation.finished' && e.chatId === S.chat1);
    const t1 = gens[0]?.at;
    say('title', `"${chat?.title}" (${chat?.titleSource})${titleEv && t1 ? `, ${secs(titleEv.at - t1)} after turn 1 finished` : ''}`);
    const mems = (await api('GET', '/api/memories')).json;
    say('memories', `${mems?.total ?? 0}: ${clip((mems?.memories || []).map((m) => `${m.content} [${m.origin}${m.needsReview ? ', needsReview' : ''}]`).join(' | '), 260)}`);
    for (const e of memEv) say('memory.extracted', `${e.chatId} +${e.added?.length || 0} ~${e.updated?.length || 0}${t1 ? ` at turn1+${secs(e.at - t1)}` : ''}`);
    say('pre-empted by our turns', preemptions.length ? preemptions.map((p) => `${p.task} (by ${p.label})`).join(', ') : 'none observed');
    say('background now', j(bg, 250));
    const titled = chat?.titleSource === 'auto';
    return { key: `title "${clip(chat?.title, 50)}" (${chat?.titleSource}); memories ${mems?.total ?? 0}; extraction runs ${memEv.length}; pre-emptions ${preemptions.length}; queue ${bg?.running ? `running ${bg.running.key}` : 'idle'}`, status: titled ? 'PASS' : 'WARN' };
  }, { optional: true, minLeftMs: 3 * MIN });

  // 11 -----------------------------------------------------------------------------------------
  await step(11, 'Forced compaction on a tiny window', async () => {
    needChat();
    // 512 is the API minimum, but its 128-token prompt budget leaves the summarizer no room; 1024 keeps it fast.
    const chat = await newChat({ context: { mode: 1024 }, params: { num_predict: 8, temperature: 0.5 }, memory: { enabled: false }, recall: { enabled: false } });
    // Deterministic: two short turns give the summarizer something old to evict; from then on each message is sized
    // (from the context event: used / compactAt) to push the next prompt past the compaction threshold.
    const SENTENCE = 'The lighthouse keeper logged wind, rain, ships and gulls; the lamp was cleaned and the log was signed. ';
    const sized = (i, tokens) => `Note ${i}: ${SENTENCE.repeat(Math.max(1, Math.ceil((tokens * 4) / SENTENCE.length)))}Reply with just OK.`;
    let compacted = null;
    let need = 30;
    const deadline = Math.min(Date.now() + 9 * MIN, T0 + BUDGET_MS - MIN);
    for (let i = 1; i <= 6 && !compacted && Date.now() < deadline; i++) {
      const r = await send(chat, i <= 2 ? `Short note ${i}: the wind is from the north. Reply with just OK.` : sized(i, need), `compaction turn ${i}`, Math.max(MIN, deadline - Date.now()));
      const comp = byType(r.events, 'compaction');
      const ctx = byType(r.events, 'context')[0];
      const reply = byType(r.events, 'stats').at(-1)?.completionTokens || 8;
      if (ctx?.compactAt) need = Math.min(600, Math.max(40, ctx.compactAt - (ctx.used + reply) + 60));
      say(`turn ${i}`, `${secs(r.ms)}, used ${ctx?.used}/${ctx?.budget} (compactAt ${ctx?.compactAt}), compaction ${comp.map((c) => c.status).join(',') || '-'}, next message ~${need} tok${byType(r.events, 'error')[0] ? `, error ${byType(r.events, 'error')[0].code}` : ''}`);
      for (const c of comp) {
        if (c.status === 'started') say('compaction started', `${c.messages} msgs, ${c.tokens} tok, kept ${c.keptMessages}, used ${c.usedBefore}, threshold ${c.threshold}`);
        if (c.status === 'completed') { compacted = c; say('compaction completed', `${c.messages} msgs, ${c.calls} call(s), ${c.usedBefore} → ${c.usedAfter} tok`); say('summary', clip(c.summary?.content?.replace(/\s+/g, ' '), 280)); }
        if (c.status === 'failed') say('compaction failed', `${c.error} (fallback ${c.fallback})`);
      }
    }
    if (!compacted) fail('compaction did not complete within the bound');
    return { key: `${compacted.messages} messages → summary of ${compacted.summary?.tokens} tok in ${compacted.calls} call(s); used ${compacted.usedBefore} → ${compacted.usedAfter}` };
  }, { optional: true, minLeftMs: 4 * MIN });

  // 12 -----------------------------------------------------------------------------------------
  await step(12, 'Cleanup (CLEANUP=1)', async () => {
    if (!CLEANUP) skip('CLEANUP not set: the copy and the pulled model stay installed');
    const out = [];
    if (S.copy) out.push(`copy ${(await api('DELETE', `/api/models/text-only?model=${encodeURIComponent(S.copy)}`)).status}`);
    if (S.tag) out.push(`original ${(await api('DELETE', `/api/models?model=${encodeURIComponent(S.tag)}`)).status}`);
    say('deleted', out.join(', '));
    return { key: out.join(', ') };
  });

  // ---------------------------------------------------------------------------------------- summary
  busReq?.destroy();
  await srv.close().catch(() => {});
  await a1111.close().catch(() => {});
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
  const ok = critical.length === 8 && critical.every((s) => s === 'PASS' || s === 'WARN');
  console.log(`\n# SUMMARY (${elapsed()} total; exit ${ok ? 0 : 1}: steps 1–8 ${ok ? 'passed' : 'did not all pass'})`);
  for (const r of results) console.log(clip(`S${r.n} ${r.status.padEnd(4)} ${secs(r.ms).padStart(7)}  ${r.name}: ${r.key}`, 300));
  return ok ? 0 : 1;
}

/** Raw macOS memory-probe values (direct module call — diagnostics only, not part of the API flow). */
async function probeDiagnostics() {
  if (process.platform !== 'darwin') { say('probe', `not macOS (${process.platform}): Harness measures estimate-only here`); return; }
  try {
    const { createMemoryProbe } = await import(path.join(ROOT, 'server', 'system', 'memory-probe.mjs'));
    const p = createMemoryProbe();
    const [runners, pressure] = await Promise.all([p.runners(), p.pressure()]);
    say('probe runners (parsed)', j((runners || []).map((r) => ({ pid: r.pid, rss: gb(r.rssBytes), blob: r.modelBlob?.slice(0, 12), exe: r.args.split(/\s+/)[0].split('/').pop() })), 300));
    say('probe pressure (parsed)', `swap used ${mb(pressure?.swapUsedBytes)}, compressor ${mb(pressure?.compressedBytes)}, level ${pressure?.level}`);
    const raw = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }); } catch (e) { return `ERR ${e.message}`; } };
    const psLines = raw('/bin/ps', ['-axo', 'pid=,rss=,args=']).split('\n').filter((l) => /llama-server|ollama/.test(l)).map((l) => l.trim().replace(/\s+--\S+\s+\S+/g, (m) => (m.length > 60 ? `${m.slice(0, 60)}…` : m)));
    for (const l of psLines.slice(0, 4)) say('raw ps', l);
    say('raw vm.swapusage', raw('/usr/sbin/sysctl', ['-n', 'vm.swapusage']).trim());
    say('raw vm_stat compressor', (raw('/usr/bin/vm_stat', []).split('\n').find((l) => /occupied by compressor|page size/.test(l)) || '').trim());
    say('raw pressure level', raw('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim());
  } catch (e) {
    say('probe diagnostics failed', e.message);
  }
}

process.on('unhandledRejection', (e) => console.log(`  [unhandled] ${clip(e?.stack || e, 300)}`));
main().then((code) => process.exit(code), (e) => { console.log(`FATAL ${clip(e?.stack || e, 600)}`); process.exit(1); });
