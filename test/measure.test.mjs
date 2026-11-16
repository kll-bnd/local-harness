// Context sizing self-correction from real memory use (Ollama /api/ps measurements).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeContextPlan, fitMeasurements, kvCacheModel, overheadBytes, roundCtx } from '../server/context/sizing.mjs';
import { formatTokensK } from '../server/lib/util.mjs';
import { MeasurementStore } from '../server/context/measurements.mjs';
import { profileFor } from '../server/providers/catalog.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setup, newChat, send, byType, tmpDir, GiB } from './helpers.mjs';

const MAC8 = { totalMem: 8 * GiB, platform: 'darwin', arch: 'arm64' };
const BUDGET8 = Math.floor(8 * GiB - 3.25 * GiB);
// Real Nemotron 3.5 Bolt E4B metadata (gemma4: 18 of 42 blocks share KV; 4 global + 20 sliding-window layers).
const nemoArch = { blockCount: 42, embeddingLength: 2560, headCount: 8, headCountKv: 2, keyLength: 512, valueLength: 512, keyLengthSwa: 256, valueLengthSwa: 256, slidingWindow: 512, sharedKvLayers: 18 };
const nemoProfile = profileFor('nemotron-3.5-bolt:e4b');
const Q4 = 4.6e9;
const at = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();

const plan = (extra = {}) => computeContextPlan({ providerKind: 'ollama', modelMax: 65536, modelMaxSource: 'override', modelBytes: Q4, arch: nemoArch, profile: nemoProfile, system: MAC8, kvCacheType: 'f16', lowRamCap: 16384, ...extra });
const kvPerToken = kvCacheModel(nemoArch, nemoProfile, 'f16').perToken;
const estFixed = Q4 + overheadBytes(Q4) + kvCacheModel(nemoArch, nemoProfile, 'f16').fixedFor(1e9);

describe('fitMeasurements / computeContextPlan with measurements (unit)', () => {
  test('one sample corrects the fixed overhead and keeps the estimated bytes/token', () => {
    const base = plan();
    assert.equal(base.memory.basis, 'estimate');
    assert.equal(base.memory.measurement, null);
    assert.equal(base.limitedBy, 'memory');
    const n0 = base.numCtx;
    // Real use is 300 MB lower than estimated → more context fits.
    const M = base.memory.estimatedTotalBytes - 300e6;
    const p = plan({ measurements: [{ numCtx: n0, totalBytes: M, vramBytes: M, at: at(1) }] });
    assert.equal(p.memory.basis, 'measured');
    assert.equal(p.memory.measurement.method, 'offset');
    assert.equal(p.memory.measurement.samples, 1);
    assert.equal(p.memory.measurement.perTokenBytes, kvPerToken);
    assert.equal(p.memory.measurement.fixedBytes, Math.round(M - kvPerToken * n0));
    assert.ok(p.numCtx > base.numCtx, `${p.numCtx} > ${base.numCtx}`);
    assert.ok(p.memory.estimatedTotalBytes <= BUDGET8);
    assert.ok(p.explanation.includes(`calibrated from 1 measurement of this model (last: `) && p.explanation.includes(` at ${formatTokensK(n0)})`), p.explanation);
    assert.match(p.explanation, /measured-corrected/);
  });

  test('two distinct contexts also correct bytes/token (least squares, median per context, clamped)', () => {
    const trueFixed = 4.9e9;
    const trueSlope = kvPerToken * 2;
    const m = (n) => trueFixed + trueSlope * n;
    const samples = [
      { numCtx: 2048, totalBytes: m(2048), at: at(1) },
      { numCtx: 4096, totalBytes: m(4096), at: at(2) },
      { numCtx: 4096, totalBytes: m(4096) + 5e8, at: at(3) }, // noisy outlier at the same context
      { numCtx: 4096, totalBytes: m(4096), at: at(4) },
    ];
    const p = plan({ measurements: samples });
    const ms = p.memory.measurement;
    assert.equal(ms.method, 'linear');
    assert.equal(ms.distinctContexts, 2);
    assert.ok(Math.abs(ms.perTokenBytes - trueSlope) / trueSlope < 0.01, `slope ${ms.perTokenBytes} vs ${trueSlope}`);
    assert.ok(Math.abs(ms.fixedBytes - trueFixed) / trueFixed < 0.01);
    assert.equal(p.numCtx, Math.max(2048, roundCtx((BUDGET8 - trueFixed) / trueSlope)));
    // An absurd slope is clamped to 4× the estimate.
    const wild = fitMeasurements([{ numCtx: 2048, totalBytes: 5.0e9, at: at(1) }, { numCtx: 8192, totalBytes: 5.0e9 + kvPerToken * 20 * 6144, at: at(2) }], { estModelOnly: (n) => estFixed + kvPerToken * n, perToken: kvPerToken, modelBytes: Q4 });
    assert.equal(wild.method, 'linear-clamped');
    assert.equal(wild.perTokenBytes, kvPerToken * 4);
    // A negative slope (noise) falls back to the estimated slope.
    const neg = fitMeasurements([{ numCtx: 2048, totalBytes: 5.2e9, at: at(1) }, { numCtx: 8192, totalBytes: 5.1e9, at: at(2) }], { estModelOnly: (n) => estFixed + kvPerToken * n, perToken: kvPerToken, modelBytes: Q4 });
    assert.equal(neg.perTokenBytes, kvPerToken);
  });

  test('implausible samples are ignored', () => {
    const good = { numCtx: 4096, totalBytes: 5.0e9, vramBytes: 5.0e9, at: at(1) };
    const bad = [
      { numCtx: 4096, totalBytes: 1e6, at: at(2) }, // far below the weights
      { numCtx: 4096, totalBytes: 1e12, at: at(3) }, // absurdly large
      { numCtx: 100, totalBytes: 5e9, at: at(4) }, // context too small to be real
      { numCtx: 4096, totalBytes: Number.NaN, at: at(5) },
    ];
    const onlyBad = plan({ measurements: bad });
    assert.equal(onlyBad.memory.basis, 'estimate');
    assert.equal(onlyBad.memory.measurement.rejected, 4);
    assert.equal(onlyBad.numCtx, plan().numCtx);
    const mixed = plan({ measurements: [good, ...bad] });
    assert.equal(mixed.memory.basis, 'measured');
    assert.equal(mixed.memory.measurement.samples, 1);
    assert.equal(mixed.memory.measurement.rejected, 4);
    assert.equal(mixed.memory.measurement.latest.totalBytes, 5.0e9);
    // vram larger than the total is nonsense → treated as unknown, not as a CPU split
    const v = plan({ measurements: [{ ...good, vramBytes: 9e9 }] });
    assert.equal(v.memory.measurement.latest.vramBytes, null);
  });

  test('auto: an over-budget measurement brings the next plan down to what fits; explicit modes only warn', () => {
    const gem = { blockCount: 34, embeddingLength: 2560, headCount: 8, headCountKv: 4, keyLength: 256, valueLength: 256, slidingWindow: 1024 };
    const prof = profileFor('gemma3:4b');
    const g = (extra) => computeContextPlan({ providerKind: 'ollama', modelMax: 131072, modelBytes: 3.3e9, arch: gem, profile: prof, system: MAC8, kvCacheType: 'f16', lowRamCap: 16384, ...extra });
    assert.equal(g().numCtx, 16384);
    const over = [{ numCtx: 16384, totalBytes: 5.3e9, vramBytes: 5.3e9, at: at(1) }];
    const p = g({ measurements: over });
    assert.ok(p.numCtx < 16384);
    assert.equal(p.limitedBy, 'memory');
    assert.ok(p.memory.estimatedTotalBytes <= p.memory.budgetBytes, 'fits per the corrected estimate');
    assert.match(p.explanation, /^Measured 4\.9 GB at 16K \(over the safe budget of 4\.8 GB\); auto mode reduced the window to 8K using that measurement\./);
    assert.ok(!p.warnings.some((w) => w.code === 'measured_exceeds_budget'), 'handled, not warned');
    const manual = g({ measurements: over, mode: 16384 });
    assert.equal(manual.numCtx, 16384, 'explicit context is never changed');
    const w = manual.warnings.find((x) => x.code === 'measured_exceeds_budget');
    assert.ok(w, JSON.stringify(manual.warnings));
    assert.match(w.message, /Measured 4\.9 GB for this model at 16K — over the safe memory budget of 4\.8 GB on this 8 GB Mac; expect swapping\. About \d+K would fit/);
    const max = g({ measurements: over, mode: 'max' });
    assert.equal(max.numCtx, 131072);
    assert.ok(max.warnings.some((x) => x.code === 'exceeds_budget'));
  });

  test('CPU split (size_vram < size): auto shrinks to what fits on the GPU; explicit warns with advice', () => {
    const split = [{ numCtx: 16384, totalBytes: 4.4e9, vramBytes: 4.25e9, at: at(1) }];
    const p = plan({ measurements: split, modelBytes: 3.9e9 });
    assert.equal(p.memory.measurement.gpuCapBytes, 4.25e9);
    assert.ok(p.numCtx < 16384);
    assert.ok(p.memory.estimatedTotalBytes <= 4.25e9, `${p.memory.estimatedTotalBytes}`);
    assert.match(p.explanation, /^Measured 4\.1 GB at 16K \(\d+ MB of it on the CPU\); auto mode reduced the window to \d+K/);
    assert.match(p.explanation, /\(what fits on the GPU\)/);
    const manual = plan({ measurements: split, modelBytes: 3.9e9, mode: 16384 });
    assert.equal(manual.numCtx, 16384);
    const w = manual.warnings.find((x) => x.code === 'cpu_offload');
    assert.match(w.message, /Ollama placed only 4\.0 GB of 4\.1 GB on the GPU at 16K \(3% runs on the CPU\).*Use a smaller context window \(about \d+K fits on the GPU\) or a smaller quantization/);
    // A later fully-on-GPU sample bigger than the cap lifts it.
    const lifted = plan({ measurements: [...split, { numCtx: 16384, totalBytes: 4.5e9, vramBytes: 4.5e9, at: at(2) }], modelBytes: 3.9e9 });
    assert.equal(lifted.memory.measurement.gpuCapBytes, null);
  });
});

describe('MeasurementStore', () => {
  test('records, caps samples, invalidates on model change, persists', async () => {
    const dir = await tmpDir();
    const st = await new MeasurementStore(dir).load();
    for (let i = 0; i < 8; i++) st.record('ollama', 'm:1', { digest: 'sha256:a', sizeBytes: 100 }, { numCtx: 4096, totalBytes: 200 + i, kvCacheType: 'f16', at: at(i) });
    st.record('ollama', 'm:1', { digest: 'sha256:a', sizeBytes: 100 }, { numCtx: 8192, totalBytes: 300, kvCacheType: 'f16', at: at(9) });
    assert.equal(st.samplesFor('ollama', 'm:1', { digest: 'sha256:a', sizeBytes: 100, kvCacheType: 'f16' }).length, 6, '5 per context + 1');
    assert.equal(st.samplesFor('ollama', 'm:1', { digest: 'sha256:a', sizeBytes: 100, kvCacheType: 'q8_0' }).length, 0, 'other KV precision');
    assert.equal(st.samplesFor('ollama', 'm:1', { digest: 'sha256:b', sizeBytes: 100 }).length, 0, 'digest changed → stale');
    assert.equal(st.samplesFor('ollama', 'm:1', { digest: 'sha256:a', sizeBytes: 999 }).length, 0, 'size changed → stale');
    await st.save();
    const again = await new MeasurementStore(dir).load();
    assert.equal(again.samplesFor('ollama', 'm:1', { digest: 'sha256:a', sizeBytes: 100 }).length, 6);
    again.record('ollama', 'm:1', { digest: 'sha256:b', sizeBytes: 100 }, { numCtx: 4096, totalBytes: 250, kvCacheType: 'f16', at: at(10) });
    assert.equal(again.get('ollama', 'm:1').samples.length, 1, 'a new build starts a fresh entry');
  });

  test('measure(): runner RSS is the size; ps size is only the non-weights part; context_length optional; remote/non-macOS not measured', async () => {
    const st = new MeasurementStore(null);
    const blob = 'ab'.repeat(32);
    const prov = (entries, baseUrl = 'http://127.0.0.1:11434') => ({ kind: 'ollama', id: 'ollama', baseUrl, ps: async () => entries });
    const probe = (runners, pressure = { swapUsedBytes: 0, compressedBytes: 0, level: 1 }) => ({ runners: async () => runners, pressure: async () => pressure });
    const runner = (rss) => [{ pid: 1, rssBytes: rss, modelBlob: blob, args: `llama-server --model /m/blobs/sha256-${blob}` }];
    // RSS of the runner serving this blob
    const s1 = await st.measure(prov([{ model: 'x:latest', sizeBytes: 90e6, vramBytes: 90e6 }]), 'x', { numCtx: 8192, kvCacheType: 'f16', sizeBytes: 4.2e9, modelBlob: blob, probe: probe(runner(4.4e9)) });
    assert.equal(s1.source, 'rss');
    assert.equal(s1.totalBytes, 4.4e9);
    assert.equal(s1.psSizeBytes, 90e6);
    assert.equal(s1.numCtx, 8192);
    assert.equal(s1.reportedContext, null);
    assert.equal(s1.cpuBytes, 0);
    // no runner visible → file + ps size (size excludes the weights) …
    const s2 = await st.measure(prov([{ model: 'x:latest', sizeBytes: 300e6, vramBytes: 200e6, contextLength: 4096 }]), 'x', { numCtx: 8192, kvCacheType: 'f16', sizeBytes: 4.2e9, probe: probe([]) });
    assert.equal(s2.source, 'ps');
    assert.equal(s2.totalBytes, 4.5e9);
    assert.equal(s2.numCtx, 4096, 'a smaller reported context (server cap) wins');
    assert.equal(s2.cpuBytes, 100e6);
    // … unless ps size is at least the file (CPU mode / older Ollama): then it already includes the weights
    const s3 = await st.measure(prov([{ model: 'x:latest', sizeBytes: 4.538e9, vramBytes: 0, contextLength: 32768 }]), 'x', { numCtx: 8192, kvCacheType: 'f16', sizeBytes: 4.2e9, probe: probe([]) });
    assert.equal(s3.totalBytes, 4.538e9);
    assert.equal(s3.numCtx, 8192, 'larger reported context (e.g. parallel slots) → keep what we sent');
    assert.equal(s3.cpuBytes, 4.538e9);
    // swap growth across a load is recorded as pressure (and only for a load)
    const before = { swapUsedBytes: 0.35e9, compressedBytes: 0.9e9, level: 1 };
    const after = { swapUsedBytes: 1.01e9, compressedBytes: 1.9e9, level: 1 };
    const s4 = await st.measure(prov([{ model: 'x:latest', sizeBytes: 90e6, vramBytes: 90e6 }]), 'x', { numCtx: 16384, kvCacheType: 'q8_0', sizeBytes: 4.2e9, modelBlob: blob, probe: probe(runner(2.7e9), after), baseline: before, loaded: true });
    assert.equal(s4.pressure.signal, true, 'level stayed 1 but swap grew 0.66 GB');
    assert.equal(s4.pressure.swapDeltaBytes, 0.66e9);
    const s5 = await st.measure(prov([{ model: 'x:latest', sizeBytes: 90e6, vramBytes: 90e6 }]), 'x', { numCtx: 16384, kvCacheType: 'q8_0', sizeBytes: 4.2e9, modelBlob: blob, probe: probe(runner(2.7e9), after), baseline: before, loaded: false });
    assert.equal(s5.pressure, null);
    // not measured: no probe (not macOS), a remote Ollama, another model
    assert.equal(await st.measure(prov([{ model: 'x:latest', sizeBytes: 1 }]), 'x', { numCtx: 8192, sizeBytes: 4.2e9 }), null);
    assert.equal(await st.measure(prov([{ model: 'x:latest', sizeBytes: 1 }], 'http://studio.local:11434'), 'x', { numCtx: 8192, sizeBytes: 4.2e9, probe: probe(runner(4e9)) }), null);
    assert.equal(await st.measure(prov([{ model: 'other', sizeBytes: 1 }]), 'x', { numCtx: 8192, probe: probe([]) }), null);
  });

  test('old-format entries (ps size taken as the total) are dropped on load', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'measurements.json'), JSON.stringify({ 'ollama/a:1': { digest: 'd', sizeBytes: 1, samples: [{ numCtx: 4096, totalBytes: 90e6 }] }, 'ollama/b:1': { v: 2, digest: 'd', sizeBytes: 1, samples: [{ numCtx: 4096, totalBytes: 4e9 }] } }));
    const st = await new MeasurementStore(dir).load();
    assert.equal(st.get('ollama', 'a:1'), null);
    assert.equal(st.get('ollama', 'b:1').samples.length, 1);
  });
});

describe('end-to-end on an 8 GB Mac (fake Ollama /api/ps)', () => {
  const MODEL = 'gemma3:4b';
  // True footprint: 3.8 GB fixed + 90 KB/token (≈3.7× the architecture estimate) → 16K needs ~5.3 GB.
  const profile = { baseBytes: 3.8e9, perTokenBytes: 90000 };
  const isInternal = (b) => /extract durable|running summary|short, specific title/.test(JSON.stringify(b.messages.slice(0, 2)));

  test('auto mode: measured over-budget → next turn uses a smaller window; mid-turn and background calls keep the loaded num_ctx', async () => {
    const TM = 'qwen3:4b'; // has tools → the first turn is a two-call tool loop
    const h = await setup({ system: MAC8, settings: { defaultModel: { providerId: 'ollama', model: TM }, titles: { auto: true } } });
    try {
      // True footprint: 3.0 GB fixed + 160 KB/token (the architecture estimate says ~147 KB/token).
      h.fake.setPsProfile(TM, { baseBytes: 3.0e9, perTokenBytes: 160000 });
      const truth = (n) => 3.0e9 + 160000 * n;
      const chat = await newChat(h.c);
      const r1 = await send(h.c, chat, 'please calculate 2+2');
      const p1 = byType(r1.events, 'start')[0].contextPlan;
      assert.equal(p1.memory.basis, 'estimate');
      assert.equal(p1.limitedBy, 'memory');
      assert.ok(truth(p1.numCtx) > p1.memory.budgetBytes, 'the estimate over-commits');
      const turn1 = h.fake.chatRequests().filter((b) => !isInternal(b));
      assert.equal(turn1.length, 2, 'tool loop: two model calls');
      assert.ok(turn1.every((b) => b.options.num_ctx === p1.numCtx), 'num_ctx is not changed mid tool-loop');
      const n = byType(r1.events, 'notice').find((x) => x.code === 'measured_exceeds_budget');
      assert.ok(n, JSON.stringify(byType(r1.events, 'notice')));
      assert.ok(n.nextNumCtx < p1.numCtx);
      assert.ok(n.message.includes(`From the next message the context window will be ${formatTokensK(n.nextNumCtx)}`), n.message);
      const types = r1.events.map((e) => e.type);
      assert.ok(types.indexOf('notice', types.indexOf('stats')) < types.indexOf('done'), 'surfaced in the same stream, before done');
      // background title + memory extraction after turn 1 reuse the loaded window (no reload)
      await h.app.background.idle();
      const bg1 = h.fake.chatRequests().filter(isInternal);
      assert.ok(bg1.length >= 2);
      assert.ok(bg1.every((b) => b.options.num_ctx === p1.numCtx), JSON.stringify(bg1.map((b) => b.options.num_ctx)));

      const meas = (await h.c.get(`/api/models/measurements?model=${TM}`)).data;
      assert.equal(meas.samples.length, 1);
      assert.equal(meas.samples[0].numCtx, p1.numCtx);
      assert.equal(meas.samples[0].reportedContext, p1.numCtx);
      assert.equal(meas.samples[0].totalBytes, truth(p1.numCtx));
      assert.equal(meas.samples[0].kvCacheType, 'f16');
      assert.equal(meas.basis, 'measured');
      assert.equal(meas.loadedNumCtx, p1.numCtx);

      const r2 = await send(h.c, chat, 'and now?');
      const p2 = byType(r2.events, 'start')[0].contextPlan;
      assert.equal(p2.numCtx, n.nextNumCtx);
      assert.equal(p2.memory.basis, 'measured');
      assert.ok(p2.memory.estimatedTotalBytes <= p2.memory.budgetBytes, 'fits per the corrected estimate');
      assert.ok(truth(p2.numCtx) <= p2.memory.budgetBytes, 'and really fits');
      assert.ok(p2.explanation.includes(`auto mode reduced the window to ${formatTokensK(p2.numCtx)} using that measurement`), p2.explanation);
      assert.equal(h.fake.chatRequests().filter((b) => !isInternal(b)).at(-1).options.num_ctx, p2.numCtx);
      assert.ok(!byType(r2.events, 'notice').some((x) => x.code === 'measured_exceeds_budget'), 'fits now');
      await h.app.background.idle();
      assert.equal(h.fake.chatRequests().filter(isInternal).at(-1).options.num_ctx, p2.numCtx);
      // Second distinct context → bytes/token learned; the plan stays within the real budget.
      const r3 = await send(h.c, chat, 'third');
      const p3 = byType(r3.events, 'start')[0].contextPlan;
      assert.equal(p3.memory.measurement.method, 'linear');
      assert.ok(Math.abs(p3.memory.measurement.perTokenBytes - 160000) < 2000, `${p3.memory.measurement.perTokenBytes}`);
      assert.ok(truth(p3.numCtx) <= p3.memory.budgetBytes);
      // Persistence across restart.
      await h.restart();
      const after = (await h.c.get(`/api/models/context?model=${TM}`)).data.contextPlan;
      assert.equal(after.memory.basis, 'measured');
      assert.equal(after.numCtx, p3.numCtx);
      // Measurements can be switched off and reset.
      await h.c.patch('/api/settings', { context: { useMeasurements: false } });
      assert.equal((await h.c.get(`/api/models/context?model=${TM}`)).data.contextPlan.memory.basis, 'estimate');
      await h.c.patch('/api/settings', { context: { useMeasurements: true } });
      assert.equal((await h.c.del(`/api/models/measurements?model=${TM}`)).data.removed, true);
      assert.equal((await h.c.get(`/api/models/context?model=${TM}`)).data.contextPlan.memory.basis, 'estimate');
    } finally {
      await h.close();
    }
  });

  test('explicit context: warns (once per turn) and never changes it', async () => {
    const h = await setup({ system: MAC8, settings: { defaultModel: { providerId: 'ollama', model: MODEL }, titles: { auto: false }, memory: { enabled: false } } });
    try {
      h.fake.setPsProfile(MODEL, profile);
      const chat = await newChat(h.c, { settings: { context: { mode: 16384 } } });
      const r1 = await send(h.c, chat, 'hi');
      const n1 = byType(r1.events, 'notice').filter((x) => x.code === 'measured_exceeds_budget');
      assert.equal(n1.length, 1);
      assert.match(n1[0].message, /Your context setting \(16K\) was kept; about \d+K would fit/);
      const r2 = await send(h.c, chat, 'again');
      const p2 = byType(r2.events, 'start')[0].contextPlan;
      assert.equal(p2.numCtx, 16384);
      assert.equal(p2.mode, 'manual');
      assert.ok(p2.warnings.some((w) => w.code === 'measured_exceeds_budget'));
      assert.equal(byType(r2.events, 'notice').filter((x) => x.code === 'measured_exceeds_budget').length, 1, 'not duplicated');
      assert.equal(h.fake.chatRequests().at(-1).options.num_ctx, 16384);
    } finally {
      await h.close();
    }
  });

  test('CPU split reported by Ollama is surfaced and auto mode moves to what fits on the GPU', async () => {
    const h = await setup({ system: MAC8, settings: { defaultModel: { providerId: 'ollama', model: MODEL }, titles: { auto: false }, memory: { enabled: false } } });
    try {
      h.fake.setPsProfile(MODEL, { baseBytes: 3.6e9, perTokenBytes: 30000, vramCapBytes: 3.9e9, reportContext: false });
      const chat = await newChat(h.c);
      const r1 = await send(h.c, chat, 'hello');
      const n = byType(r1.events, 'notice').find((x) => x.code === 'cpu_offload');
      assert.ok(n, JSON.stringify(byType(r1.events, 'notice')));
      assert.match(n.message, /Ollama could not place all of gemma3:4b on the GPU at 16K: \d+ MB runs on the CPU, which is much slower\./);
      const meas = (await h.c.get(`/api/models/measurements?model=${MODEL}`)).data;
      assert.equal(meas.samples[0].reportedContext, null, 'context_length absent → num_ctx we sent');
      assert.equal(meas.samples[0].numCtx, 16384);
      const r2 = await send(h.c, chat, 'again');
      const p2 = byType(r2.events, 'start')[0].contextPlan;
      assert.ok(p2.numCtx < 16384);
      assert.ok(p2.memory.estimatedTotalBytes <= 3.9e9);
      assert.match(p2.explanation, /on the CPU\); auto mode reduced the window/);
    } finally {
      await h.close();
    }
  });

  test('a changed model build (new digest/size) invalidates its measurements', async () => {
    const h = await setup({ system: MAC8, settings: { defaultModel: { providerId: 'ollama', model: MODEL }, titles: { auto: false }, memory: { enabled: false } } });
    try {
      h.fake.setPsProfile(MODEL, profile);
      const chat = await newChat(h.c);
      await send(h.c, chat, 'hi');
      assert.equal((await h.c.get(`/api/models/context?model=${MODEL}`)).data.contextPlan.memory.basis, 'measured');
      // re-pulled as a different build
      const m = h.fake.installed.get(MODEL);
      m.digest = 'sha256:' + 'cd'.repeat(32);
      m.size = 3.1e9;
      h.app.registry.invalidate();
      const meas = (await h.c.get(`/api/models/measurements?model=${MODEL}`)).data;
      assert.equal(meas.stale, true);
      assert.equal(meas.validSamples, 0);
      const p = (await h.c.get(`/api/models/context?model=${MODEL}`)).data.contextPlan;
      assert.equal(p.memory.basis, 'estimate');
      assert.equal(p.numCtx, 16384);
      await send(h.c, chat, 'again');
      const e = h.app.measurements.get('ollama', MODEL);
      assert.equal(e.digest, m.digest);
      assert.equal(e.samples.length, 1, 'old samples dropped');
    } finally {
      await h.close();
    }
  });
});
