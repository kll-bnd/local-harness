// Replays what the real 7 GB Mac runner showed with the Nemotron UD-Q3_K_XL text-only copy: a resident size BELOW
// the model file right after the load made the plan grow from 2K to 16K, and four consecutive turns each paid a
// model reload (16K swap → 8K → 4K → 2K). Now: the measured fixed part never goes below the weights, auto mode never
// grows a loaded model's window (it waits for the next cold load), a swap-inducing window is cut in ONE step, and
// a plan warning is a notice once per chat, not every turn.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setup, newChat, send, byType, GiB } from './helpers.mjs';
import { computeContextPlan } from '../server/context/sizing.mjs';
import { profileFor } from '../server/providers/catalog.mjs';
import { planCompaction } from '../server/context/compaction.mjs';

const MiB = 1024 ** 2;
const MAC7 = { totalMem: 7 * GiB, platform: 'darwin', arch: 'arm64' };
const MAC8 = { totalMem: 8 * GiB, platform: 'darwin', arch: 'arm64' };
const MAC16 = { totalMem: 16 * GiB, platform: 'darwin', arch: 'arm64' };
const HF = 'hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL';
const COPY = 'nvidia-nemotron-3.5-bolt-e4b-text:ud-q3_k_xl';
const WEIGHTS = 4024 * MiB;
const nemoArch = { blockCount: 42, embeddingLength: 2560, headCount: 8, headCountKv: 2, keyLength: 512, valueLength: 512, keyLengthSwa: 256, valueLengthSwa: 256, slidingWindow: 512, sharedKvLayers: 18 };
const plan = (extra) => computeContextPlan({ providerKind: 'ollama', modelMax: 65536, modelMaxSource: 'override', modelBytes: WEIGHTS, arch: nemoArch, profile: profileFor('nemotron-3.5-bolt'), system: MAC7, kvCacheType: 'q8_0', lowRamCap: 16384, ...extra });
const at = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
const numCtxSent = (h) => h.fake.chatRequests().filter((b) => !/extract durable|running summary|short, specific title/.test(JSON.stringify(b.messages.slice(0, 2)))).map((b) => b.options.num_ctx);

describe('plan rules (unit)', () => {
  test('a resident size below the model file never lowers the fixed part below the weights', () => {
    const p = plan({ measurements: [{ numCtx: 2048, totalBytes: 3.11e9, source: 'rss', loaded: true, pressure: { swapDeltaBytes: 0, compressedDeltaBytes: 328 * MiB, signal: false }, at: at(1) }] });
    assert.equal(p.memory.basis, 'measured');
    assert.equal(p.memory.measurement.fixedBytes, WEIGHTS);
    assert.equal(p.memory.measurement.flooredToWeights, true);
    assert.equal(p.numCtx, 2048, 'it stays at the minimum — the old fit said 16K');
    assert.ok(p.warnings.some((w) => w.code === 'model_exceeds_budget'));
    assert.match(p.explanation, /below the 3\.9 GB model file — not all of it was resident yet, so the file size is used as the minimum/);
  });

  test('auto mode does not grow a loaded window (pending until the next cold load); shrinking and explicit modes are unaffected', () => {
    const roomy = (extra) => computeContextPlan({ providerKind: 'ollama', modelMax: 65536, modelBytes: 2.5e9, arch: { blockCount: 36, embeddingLength: 2560, headCount: 32, headCountKv: 8, keyLength: 128, valueLength: 128 }, profile: {}, system: MAC16, kvCacheType: 'f16', ...extra });
    const free = roomy({});
    assert.ok(free.numCtx > 8192);
    const held = roomy({ loadedCtx: 8192 });
    assert.equal(held.numCtx, 8192);
    assert.equal(held.limitedBy, 'loaded');
    assert.equal(held.pendingNumCtx, free.numCtx);
    assert.match(held.explanation, new RegExp(`^8K of 64K context — the window the model is loaded with; it will use ${Math.round(free.numCtx / 1024)}K next time the model loads`));
    assert.equal(roomy({ loadedCtx: 200000 }).numCtx, free.numCtx, 'shrinking is not held back');
    assert.equal(roomy({ loadedCtx: 200000 }).pendingNumCtx, null);
    assert.equal(roomy({ loadedCtx: 8192, mode: 32768 }).numCtx, 32768, 'an explicit window is the user\'s choice');
    assert.equal(roomy({ loadedCtx: 8192, mode: 'max' }).numCtx, 65536);
  });

  test('after a load made macOS swap, the window is cut in one step by what the swap growth allows', () => {
    const q = (pressure, extra) => computeContextPlan({ providerKind: 'ollama', modelMax: 40960, modelBytes: 2.5e9, arch: { blockCount: 36, embeddingLength: 2560, headCount: 32, headCountKv: 8, keyLength: 128, valueLength: 128 }, profile: {}, system: MAC16, kvCacheType: 'f16', measurements: [{ numCtx: 40960, totalBytes: 6e9, loaded: true, pressure: { ...pressure, signal: true }, at: at(1) }], ...extra });
    // 2.84 GB over at 144 KiB/token → 19.3K tokens less: 40K → 20K at once
    const big = q({ swapDeltaBytes: 1.136e9, compressedDeltaBytes: 1.704e9 });
    assert.equal(big.numCtx, 20480);
    assert.equal(big.limitedBy, 'memory_pressure');
    // a small overshoot is one notch, a huge one goes straight to the minimum
    assert.equal(q({ swapDeltaBytes: 300e6, compressedDeltaBytes: 0 }).numCtx, 38912);
    assert.equal(q({ swapDeltaBytes: 4e9, compressedDeltaBytes: 4e9 }).numCtx, 2048);
  });
});

describe('compaction that would not shrink the prompt (seen in the Mac run: 51 tokens evicted, 74-token summary)', () => {
  test('automatic compaction is skipped when the evictable span is smaller than the summary budget; "compact now" still runs', () => {
    const msg = (role, i) => ({ id: `m${i}`, role, content: 'x' });
    const live = [msg('user', 1), msg('assistant', 2), msg('user', 3), msg('assistant', 4), msg('user', 5)];
    const liveTokens = [20, 5, 20, 6, 420]; // the newest message alone is most of the prompt
    const budgets = { compactAt: 480, compactTarget: 288, keepRecentTokens: 160, maxSummaryTokens: 64 };
    const plain = planCompaction({ live, liveTokens, fixedTokens: 74, budgets });
    assert.ok(plain && plain.evictTokens < 64, 'without the guard it would evict a tiny span');
    assert.equal(planCompaction({ live, liveTokens, fixedTokens: 74, budgets, minEvictTokens: 64 }), null);
    assert.ok(planCompaction({ live, liveTokens, fixedTokens: 74, budgets, minEvictTokens: 64, force: true }));
    const bigger = planCompaction({ live, liveTokens: [200, 50, 180, 40, 100], fixedTokens: 74, budgets, minEvictTokens: 64 });
    assert.ok(bigger && bigger.evictTokens >= 64, 'a worthwhile span is still compacted');
  });
});

describe('end-to-end replay through the fake memory probe', () => {
  test('7 GB Mac, Nemotron text-only copy: RSS below the file at 2K → stays at 2K, no reloads, the warning is a notice once', async () => {
    const h = await setup({ system: MAC7, settings: { titles: { auto: false }, memory: { enabled: false } } });
    try {
      assert.equal((await h.c.post('/api/models/text-only', { model: HF })).status, 201);
      await h.c.patch('/api/settings', { defaultModel: { providerId: 'ollama', model: COPY } });
      // truly resident: weights + buffers; what macOS reports right after the load: 3.11 GB, compressor +328 MB, no swap
      h.fake.setPsProfile(COPY, { baseBytes: 4.3e9, perTokenBytes: 8704, psSizeBytes: 90e6 });
      h.probe.rssDeficitBytes = 4.3e9 + 8704 * 2048 - 3.11e9;
      h.probe.compressedPerLoadedBytes = 328 * MiB;
      const id = await newChat(h.c);
      const turns = [];
      for (const text of ['hello', 'and again', 'one more', 'last one']) turns.push(await send(h.c, id, text));
      const p1 = byType(turns[0].events, 'start')[0].contextPlan;
      assert.equal(p1.numCtx, 2048);
      const meas = (await h.c.get(`/api/models/measurements?model=${encodeURIComponent(COPY)}`)).data;
      assert.equal(meas.samples[0].totalBytes, 3.11e9);
      assert.equal(meas.samples[0].pressure.signal, false);
      assert.equal(meas.samples[0].pressure.compressedDeltaBytes, 328 * MiB);
      const after = (await h.c.get(`/api/models/context?model=${encodeURIComponent(COPY)}`)).data.contextPlan;
      assert.equal(after.memory.basis, 'measured');
      assert.equal(after.numCtx, 2048, 'the old fit grew this to 16K');
      assert.equal(after.memory.measurement.flooredToWeights, true);
      assert.deepEqual(numCtxSent(h), [2048, 2048, 2048, 2048], 'never reloaded');
      assert.deepEqual(turns.map((r) => byType(r.events, 'model_status').filter((e) => e.phase === 'loading').length), [1, 0, 0, 0]);
      assert.deepEqual(turns.map((r) => byType(r.events, 'notice').filter((n) => n.code === 'model_exceeds_budget').length), [1, 0, 0, 0], 'once per chat');
      assert.ok(turns.every((r) => byType(r.events, 'start')[0].contextPlan.warnings !== undefined), 'the plan itself still carries it');
      // a new chat gets the notice once too
      const r5 = await send(h.c, await newChat(h.c), 'new chat');
      assert.equal(byType(r5.events, 'notice').filter((n) => n.code === 'model_exceeds_budget').length, 1);
    } finally { await h.close(); }
  });

  test('a larger window found by measuring waits for the next cold load (keep_alive expiry), then applies once', async () => {
    const h = await setup({ system: MAC8, settings: { defaultModel: { providerId: 'ollama', model: 'qwen3:4b' }, titles: { auto: false }, memory: { enabled: false } } });
    try {
      // resident footprint lower than the estimate (fixed part is floored at the 2.5 GB file)
      h.fake.setPsProfile('qwen3:4b', { baseBytes: 2.0e9, perTokenBytes: 147456 });
      const id = await newChat(h.c);
      const r1 = await send(h.c, id, 'hi');
      const n0 = byType(r1.events, 'start')[0].contextPlan.numCtx;
      assert.equal(n0, 14336);
      const held = (await h.c.get('/api/models/context?model=qwen3:4b')).data.contextPlan;
      assert.equal(held.numCtx, 14336);
      assert.equal(held.limitedBy, 'loaded');
      assert.equal(held.pendingNumCtx, 16384);
      assert.match(held.explanation, /the window the model is loaded with; it will use 16K next time the model loads/);
      const r2 = await send(h.c, id, 'again');
      assert.equal(byType(r2.events, 'model_status').length, 0, 'no reload mid-conversation');
      // keep_alive expired: Ollama no longer has it loaded → the next turn loads cold with the larger window
      h.fake.loaded.delete('qwen3:4b');
      const r3 = await send(h.c, id, 'later');
      assert.equal(byType(r3.events, 'model_status')[0].reason, 'not_loaded');
      assert.deepEqual(numCtxSent(h), [14336, 14336, 16384]);
      assert.equal((await h.c.get('/api/models/context?model=qwen3:4b')).data.contextPlan.pendingNumCtx, null);
      // an explicit unload through the API also makes the next load cold
      h.fake.setPsProfile('qwen3:4b', { baseBytes: 2.6e9, perTokenBytes: 120000 });
      await h.c.post('/api/models/unload', { model: 'qwen3:4b' });
      assert.equal(h.app.engine.loadedCtxFor('ollama', 'qwen3:4b'), null);
    } finally { await h.close(); }
  });

  test('16 GB: a load that swaps is cut to what fits in ONE reload, then stays (no further reloads)', async () => {
    const h = await setup({ system: MAC16, settings: { defaultModel: { providerId: 'ollama', model: 'qwen3:4b' }, titles: { auto: false }, memory: { enabled: false } } });
    try {
      h.fake.setPsProfile('qwen3:4b', { baseBytes: 2.8e9, perTokenBytes: 147456 });
      h.probe.freeBytes = 7.07e9; // other apps leave 7.07 GB: 40K (8.84 GB) swaps by 1.77 GB; 28K (7.03 GB) does not
      const id = await newChat(h.c);
      const r1 = await send(h.c, id, 'hi');
      const n = byType(r1.events, 'notice').find((x) => x.code === 'memory_pressure');
      assert.ok(n, JSON.stringify(byType(r1.events, 'notice')));
      assert.match(n.message, /at 40K made macOS swap .* From the next message the context window will be 28K/);
      await send(h.c, id, 'again');
      const r3 = await send(h.c, id, 'third');
      await send(h.c, id, 'fourth');
      assert.deepEqual(numCtxSent(h), [40960, 28672, 28672, 28672], 'one reload to what fits (halving would give 20K)');
      assert.equal(byType(r3.events, 'model_status').length, 0);
      const p = (await h.c.get('/api/models/context?model=qwen3:4b')).data.contextPlan;
      assert.equal(p.limitedBy, 'memory_pressure');
      assert.equal(p.numCtx, 28672);
    } finally { await h.close(); }
  });
});
