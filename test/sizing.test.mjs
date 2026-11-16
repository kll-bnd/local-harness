// Context sizing math, budgets as fractions of the window, low-RAM (8 GB M1) behaviour.
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { computeContextPlan, kvCacheModel, memoryBudget, budgetsFor, ramTier, KV_BYTES } from '../server/context/sizing.mjs';
import { profileFor } from '../server/providers/catalog.mjs';
import { managedOllamaEnv } from '../server/providers/ollama-process.mjs';
import { DEFAULT_SETTINGS } from '../server/store/settings.mjs';
import { resolveImageParams, sizeForAspect } from '../server/image/defaults.mjs';
import { setup, GiB } from './helpers.mjs';

const MAC8 = { totalMem: 8 * GiB, platform: 'darwin', arch: 'arm64' };
const MAC16 = { totalMem: 16 * GiB, platform: 'darwin', arch: 'arm64' };
const MAC64 = { totalMem: 64 * GiB, platform: 'darwin', arch: 'arm64' };

// Real Nemotron 3.5 Bolt E4B metadata (Ollama /api/show of the UD-Q3_K_XL pull).
const nemotronArch = { blockCount: 42, embeddingLength: 2560, headCount: 8, headCountKv: 2, keyLength: 512, valueLength: 512, keyLengthSwa: 256, valueLengthSwa: 256, slidingWindow: 512, sharedKvLayers: 18 };
const MiB = 1024 ** 2;
const NEMO_OFFICIAL = 6180446208 + 991551808 + 736812096; // model + vision/audio projector + draft (≈7.9 GB)
const NEMO_Q3_TEXT = 4024 * MiB; // UD-Q3_K_XL model layer = its text-only copy
const NEMO_IQ3_TEXT = 3532 * MiB; // UD-IQ3_XXS text-only copy
const llamaArch = { blockCount: 32, embeddingLength: 4096, headCount: 32, headCountKv: 8 }; // Llama-3-8B

describe('KV cache model', () => {
  test('Llama-3-8B f16 ≈ 128 KiB/token; q8_0 ≈ 68 KiB/token', () => {
    assert.equal(kvCacheModel(llamaArch, {}, 'f16').perToken, 32 * 8 * 256 * 2);
    assert.equal(kvCacheModel(llamaArch, {}, 'q8_0').perToken, Math.round(32 * 8 * 256 * KV_BYTES.q8_0));
  });
  test('gemma4 / Nemotron: reproduces llama.cpp\'s own KV cache sizes (q8_0, flash attention)', () => {
    const kv = kvCacheModel(nemotronArch, profileFor('nemotron-3.5-bolt:e4b'), 'q8_0');
    // 42 blocks − 18 sharing KV = 24 with a cache: 4 global + 20 sliding-window
    assert.equal(kv.fullLayers, 4);
    assert.equal(kv.swaLayers, 20);
    // "creating non-SWA KV cache, size = 4096 cells … size = 34.00 MiB (4096 cells, 4 layers)"
    assert.equal(kv.perToken, 8704);
    assert.equal(kv.perToken * 4096, 34 * MiB);
    assert.equal(kv.perToken * 16384, 136 * MiB);
    // "creating SWA KV cache, size = 1024 cells" (window 512 + batch 512) → 21.25 MiB at every context
    assert.equal(kv.swaCells, 1024);
    assert.equal(kv.fixedFor(4096), 21.25 * MiB);
    assert.equal(kv.fixedFor(65536), 21.25 * MiB);
    assert.equal(kv.fixedFor(256), Math.round(21.25 * MiB * 256 / 1024), 'a tiny context caps the window too');
    // context is cheap: 16K ≈ 157 MiB, 32K ≈ 293 MiB, 64K ≈ 565 MiB of KV
    const total = (n) => (kv.perToken * n + kv.fixedFor(n)) / MiB;
    assert.equal(total(16384), 157.25);
    assert.equal(total(32768), 293.25);
    assert.equal(total(65536), 565.25);
    // without the sliding-window layout all 24 layers cache every token
    const full = kvCacheModel({ ...nemotronArch, slidingWindow: null }, {}, 'q8_0');
    assert.equal(full.perToken, 24 * 2 * 1024 * KV_BYTES.q8_0);
  });

  test('a sliding_window_pattern array wins over the profile; empty / truncated arrays never zero the estimate', () => {
    const pat = Array.from({ length: 42 }, (_, i) => (i + 1) % 6 !== 0); // true = sliding
    assert.equal(kvCacheModel({ ...nemotronArch, slidingWindowPattern: pat }, {}, 'q8_0').fullLayers, 4);
    const ref = kvCacheModel(nemotronArch, profileFor('nemotron-3.5-bolt:e4b'), 'q8_0');
    for (const blank of [[], [true, false]]) {
      const kv = kvCacheModel({ ...nemotronArch, slidingWindowPattern: blank }, profileFor('nemotron-3.5-bolt:e4b'), 'q8_0');
      assert.equal(kv.perToken, ref.perToken, 'falls back to the profile layout');
    }
    // per-layer head counts blanked by a non-verbose /api/show
    for (const heads of [[], [0, 0], [2]]) {
      const kv = kvCacheModel({ ...nemotronArch, headCountKv: heads }, profileFor('nemotron-3.5-bolt:e4b'), 'q8_0');
      assert.ok(kv.perToken > 0, JSON.stringify(heads));
    }
    assert.equal(kvCacheModel({ ...nemotronArch, headCountKv: [] }, profileFor('nemotron-3.5-bolt:e4b'), 'q8_0').perToken, 4 * 8 * 1024 * KV_BYTES.q8_0, 'falls back to head_count');
    assert.equal(kvCacheModel({ ...nemotronArch, headCountKv: Array(42).fill(2) }, profileFor('nemotron-3.5-bolt:e4b'), 'q8_0').perToken, 8704);
  });

  test('falls back to a parameter-count heuristic without metadata', () => {
    const kv = kvCacheModel({ parameterCount: 8e9 }, {}, 'f16');
    assert.equal(kv.source, 'heuristic');
    assert.equal(kv.perToken, 16384 * 8);
  });
});

describe('memory budget', () => {
  test('tiers and conservative reserve on 8 GB Macs', () => {
    assert.equal(ramTier(8 * GiB), 'low');
    assert.equal(ramTier(16 * GiB), 'medium');
    assert.equal(ramTier(64 * GiB), 'high');
    const b8 = memoryBudget(MAC8);
    assert.equal(b8.budgetBytes, Math.floor(8 * GiB - 3.25 * GiB)); // 4.75 GB: OS reserve beats the 66% Metal cap
    const b16 = memoryBudget(MAC16);
    assert.equal(b16.budgetBytes, Math.floor(16 * GiB * 0.66));
    assert.equal(memoryBudget(MAC64).budgetBytes, Math.floor(64 * GiB * 0.75));
    assert.equal(memoryBudget({ ...MAC16, memoryFraction: 0.5 }).budgetBytes, 8 * GiB);
  });
});

describe('context plan', () => {
  const nemo = (sys, modelBytes, extra = {}) => computeContextPlan({ providerKind: 'ollama', modelMax: 65536, modelMaxSource: 'override', advertisedMax: 131072, modelBytes, arch: nemotronArch, profile: profileFor('nemotron-3.5-bolt:e4b'), system: sys, kvCacheType: 'f16', ...extra });

  test('16 GB Mac: Nemotron E4B gets the full 64K (model max, not the advertised 128K)', () => {
    const p = nemo(MAC16, NEMO_OFFICIAL);
    assert.equal(p.numCtx, 65536);
    assert.equal(p.limitedBy, 'model');
    assert.equal(p.fits, true);
    assert.match(p.explanation, /^64K of 64K context \(model max\); est\. \d+\.\d GB of 16\.0 GB RAM/);
  });

  test('8 GB Mac, official tag (7.9 GB with projector and draft model): model alone exceeds the budget → minimum window + strong warning', () => {
    const p = nemo(MAC8, NEMO_OFFICIAL);
    assert.equal(p.numCtx, 2048);
    assert.equal(p.limitedBy, 'memory');
    assert.ok(p.warnings.some((w) => w.code === 'model_exceeds_budget'));
    assert.match(p.explanation, /exceeds the safe memory budget/);
    assert.equal(p.alternatives.max.fits, false);
    assert.ok(p.alternatives.max.overBudgetBytes > 0);
  });

  test('8 GB Mac, UD-Q3_K_XL text-only copy (f16 KV): RAM-limited window, explanation names RAM and what max would cost', () => {
    const p = nemo(MAC8, NEMO_Q3_TEXT);
    assert.equal(p.limitedBy, 'memory');
    assert.ok(p.numCtx >= 8192 && p.numCtx < 65536, `numCtx ${p.numCtx}`);
    assert.ok(p.memory.estimatedTotalBytes <= p.memory.budgetBytes);
    assert.match(p.explanation, /limited by RAM/);
    assert.match(p.explanation, /Max mode \(64K\) would need ~\d+\.\d GB/);
    // Without sliding-window knowledge the same model gets a much smaller window (conservative).
    const conservative = computeContextPlan({ providerKind: 'ollama', modelMax: 65536, modelBytes: NEMO_Q3_TEXT, arch: { ...nemotronArch, slidingWindow: null }, profile: {}, system: MAC8, kvCacheType: 'f16' });
    assert.ok(conservative.numCtx < p.numCtx);
    // q8_0 KV cache (app-managed Ollama) allows more context than f16.
    const q8 = nemo(MAC8, NEMO_Q3_TEXT, { kvCacheType: 'q8_0' });
    assert.ok(q8.numCtx >= p.numCtx);
    // the explanation says that the file, not the window, decides (q8_0: 64K of KV ≈ 565 MiB)
    assert.match(q8.explanation, /Context is cheap for this model \(the full 64K needs only ~565 MB of KV cache\); the model file \(3\.9 GB\) is what decides whether it fits\./);
    assert.equal(q8.memory.contextCheap, true);
  });

  test('max mode ignores RAM; manual mode clamps to model max; maxAuto caps auto', () => {
    const m = nemo(MAC8, NEMO_Q3_TEXT, { mode: 'max' });
    assert.equal(m.numCtx, 65536);
    assert.equal(m.fits, false);
    assert.ok(m.warnings.some((w) => w.code === 'exceeds_budget'));
    const manual = nemo(MAC16, NEMO_OFFICIAL, { mode: 200000 });
    assert.equal(manual.numCtx, 65536);
    assert.ok(manual.warnings.some((w) => w.code === 'clamped_to_model_max'));
    const capped = nemo(MAC64, NEMO_OFFICIAL, { maxAuto: 16384 });
    assert.equal(capped.numCtx, 16384);
    assert.equal(capped.limitedBy, 'setting');
  });

  test('auto mode on 8 GB is capped (lowRamCap) for responsiveness even when RAM would allow more', () => {
    const p = nemo(MAC8, NEMO_IQ3_TEXT, { kvCacheType: 'q8_0', lowRamCap: 16384 });
    assert.equal(p.numCtx, 16384);
    assert.equal(p.limitedBy, 'low_ram_cap');
    assert.match(p.explanation, /capped for responsiveness on this 8 GB Mac \(RAM alone would allow ~64K;/);
    assert.match(p.explanation, /Context is cheap for this model/);
    assert.equal(nemo(MAC16, NEMO_OFFICIAL, { lowRamCap: 16384 }).numCtx, 65536, 'cap only applies on ≤8 GB');
    assert.equal(nemo(MAC8, NEMO_IQ3_TEXT, { kvCacheType: 'q8_0', lowRamCap: 16384, mode: 'max' }).numCtx, 65536, 'max mode bypasses the cap');
  });

  test('other resident models (embeddings) reduce the window', () => {
    const a = nemo(MAC8, NEMO_Q3_TEXT);
    const b = nemo(MAC8, NEMO_Q3_TEXT, { otherModelsBytes: 0.3e9 });
    assert.ok(b.numCtx < a.numCtx);
  });

  test('OpenAI-compatible servers: context fixed by the server', () => {
    const p = computeContextPlan({ providerKind: 'openai', serverCtx: 32768, modelMax: 131072, system: MAC16 });
    assert.equal(p.numCtx, 32768);
    assert.equal(p.limitedBy, 'server');
    const unknown = computeContextPlan({ providerKind: 'openai', system: MAC16 });
    assert.equal(unknown.numCtx, 8192);
    assert.ok(unknown.warnings.some((w) => w.code === 'context_unknown'));
  });
});

describe('budgets scale with the window (sane at 4K–8K)', () => {
  const s = DEFAULT_SETTINGS;
  for (const n of [2048, 4096, 8192, 65536]) {
    test(`numCtx ${n}`, () => {
      const b = budgetsFor(n, s);
      assert.ok(b.replyReserve >= 384 && b.replyReserve <= 8192);
      assert.ok(b.input + b.replyReserve === n);
      assert.ok(b.compactAt < b.input && b.compactTarget < b.compactAt);
      assert.ok(b.maxSummaryTokens + b.memories + b.recall + b.keepRecentTokens < b.input, 'injection budgets fit inside the input budget');
      assert.ok(b.maxSummaryTokens >= 192);
      if (n <= 8192) {
        assert.ok(b.memories <= n * 0.06 && b.documents <= n * 0.2 + 1, `memories ${b.memories} docs ${b.documents}`);
        assert.ok(b.replyReserve <= Math.max(384, n * 0.16));
      } else {
        assert.equal(b.replyReserve, 8192);
        assert.equal(b.maxSummaryTokens, 3000);
      }
    });
  }
});

describe('low-RAM process + image defaults', () => {
  test('app-spawned ollama serve env: flash attention, q8_0 KV, 1 parallel, 1 loaded model on 8 GB', () => {
    const env8 = managedOllamaEnv(DEFAULT_SETTINGS, { baseUrl: 'http://127.0.0.1:11434', totalMem: 8 * GiB });
    assert.equal(env8.OLLAMA_FLASH_ATTENTION, '1');
    assert.equal(env8.OLLAMA_KV_CACHE_TYPE, 'q8_0');
    assert.equal(env8.OLLAMA_NUM_PARALLEL, '1');
    assert.equal(env8.OLLAMA_MAX_LOADED_MODELS, '1');
    assert.equal(env8.OLLAMA_HOST, '127.0.0.1:11434');
    const env16 = managedOllamaEnv(DEFAULT_SETTINGS, { baseUrl: 'http://127.0.0.1:11434', totalMem: 16 * GiB });
    assert.equal(env16.OLLAMA_MAX_LOADED_MODELS, undefined);
  });

  test('image defaults: 512-class sizes and few-step params on 8 GB; warnings instead of blocking', () => {
    const low = resolveImageParams({ prompt: 'x' }, { settings: DEFAULT_SETTINGS, totalMem: 8 * GiB, model: 'sdxl_base_1.0.safetensors' });
    assert.equal(low.params.width, 512);
    assert.equal(low.params.height, 512);
    assert.ok(low.warnings.some((w) => w.code === 'heavy_model_low_ram'));
    const big = resolveImageParams({ prompt: 'x', width: 1024, height: 1024, count: 3 }, { settings: DEFAULT_SETTINGS, totalMem: 8 * GiB, model: 'sd_turbo' });
    assert.equal(big.params.width, 1024);
    assert.ok(big.warnings.some((w) => w.code === 'large_size_low_ram'));
    assert.ok(big.warnings.some((w) => w.code === 'batch_low_ram'));
    const turbo = resolveImageParams({ prompt: 'x' }, { settings: DEFAULT_SETTINGS, totalMem: 16 * GiB, model: 'sd_turbo.safetensors' });
    assert.equal(turbo.params.steps, 2);
    assert.equal(turbo.params.cfg, 1);
    const schnell = resolveImageParams({ prompt: 'x', aspect: 'portrait' }, { settings: DEFAULT_SETTINGS, totalMem: 32 * GiB, model: 'flux1-schnell-q8' });
    assert.equal(schnell.params.steps, 4);
    assert.deepEqual([schnell.params.width, schnell.params.height], [832, 1216]);
    assert.deepEqual(sizeForAspect('wide', 1024), { width: 1344, height: 768 });
    const userOverride = resolveImageParams({ prompt: 'x', steps: 30 }, { settings: DEFAULT_SETTINGS, totalMem: 8 * GiB, model: 'sd_turbo' });
    assert.equal(userOverride.params.steps, 30);
    assert.ok(userOverride.warnings.some((w) => w.code === 'steps_high_for_family'));
  });
});

describe('8 GB machine end-to-end (system override)', () => {
  let h;
  before(async () => { h = await setup({ system: MAC8, settings: { embeddings: { model: 'auto' } } }); });
  after(() => h.close());

  test('model info / context endpoints explain the RAM limit; max mode cost is reported', async () => {
    const r = await h.c.get('/api/models/info?model=' + encodeURIComponent('hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL'));
    assert.equal(r.status, 200);
    assert.equal(r.data.info.contextLength, 65536);
    assert.equal(r.data.info.contextLengthSource, 'override');
    assert.equal(r.data.info.advertisedContextLength, 131072);
    assert.equal(r.data.contextPlan.limitedBy, 'memory');
    assert.ok(r.data.contextPlan.numCtx < 65536);
    assert.ok(r.data.budgets.replyReserve < 2000);
    const mx = await h.c.get('/api/models/context?mode=max&model=' + encodeURIComponent('nemotron-3.5-bolt:e4b'));
    assert.equal(mx.data.contextPlan.numCtx, 65536);
    assert.equal(mx.data.contextPlan.fits, false);
  });

  test('recommended list on 8 GB: a text-only copy of a UD-* Nemotron file, honest about the trade-offs', async () => {
    const r = await h.c.get('/api/models/recommended');
    assert.equal(r.data.machine.ramTier, 'low');
    const nemo = r.data.models[0];
    assert.equal(nemo.id, 'nemotron-3.5-bolt-e4b');
    assert.equal(nemo.suggestedVariant, 'hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-IQ3_XXS', 'the comfortable choice');
    assert.equal(nemo.largestRealisticVariant, 'hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL');
    assert.equal(nemo.suggestTextOnly, true);
    assert.match(nemo.lowRamNote, /largest that is realistic.*leaves almost nothing for macOS.*comfortable choice, with a small quality trade-off/);
    for (const v of nemo.variants) {
      assert.ok(v.estimate.estimatedTotalBytes > 0 && v.estimate.explanation);
      assert.match(v.model, /^nemotron-3\.5-bolt:e4b$|GGUF:UD-/, 'only tags that really download');
    }
    const official = nemo.variants[0];
    assert.equal(official.estimate.fits, false);
    assert.equal(official.notForThisMachine, true);
    assert.match(official.estimate.explanation, /Not usable on 8 GB/);
    const q3 = nemo.variants.find((v) => v.model.endsWith(':UD-Q3_K_XL'));
    assert.equal(q3.approxSizeBytes, (4024 + 946) * 1024 * 1024, 'real layer sizes: model + projector');
    assert.equal(q3.textOnly.model, 'nvidia-nemotron-3.5-bolt-e4b-text:ud-q3_k_xl');
    assert.equal(q3.textOnly.approxSizeBytes, 4024 * 1024 * 1024);
    assert.equal(q3.estimate.basis, 'text_only_copy');
    assert.match(q3.estimate.explanation, /^Largest that is realistic on 8 GB, as a text-only copy/);
    assert.equal(q3.asPulledEstimate.fits, false, 'with the projector it does not fit');
    assert.ok(nemo.avoid.some((a) => a.model.endsWith(':Q4_K_M')) && nemo.avoid.some((a) => a.model === 'nemotron-3.5-bolt:latest'));
    assert.equal(r.data.embedding[0].model, 'embeddinggemma');
  });

  test('embeddings are opt-in on 8 GB (BM25 by default) even when an embedding model is installed', async () => {
    const r = await h.c.get('/api/embeddings/status');
    assert.equal(r.data.enabled, false);
    assert.equal(r.data.reason, 'low_ram_opt_in');
    assert.equal(r.data.retrieval, 'bm25');
    assert.ok(r.data.lowRamNote);
    assert.ok(r.data.candidates.some((c) => c.model === 'embeddinggemma:latest'));
    await h.c.patch('/api/settings', { embeddings: { model: { providerId: 'ollama', model: 'embeddinggemma:latest' } } });
    const r2 = await h.c.get('/api/embeddings/status');
    assert.equal(r2.data.enabled, true);
    assert.equal(r2.data.retrieval, 'hybrid');
    await h.c.patch('/api/settings', { embeddings: { model: 'auto' } });
  });

  test('a chat at 8 GB uses the small window: num_ctx sent to Ollama, summarizer = chat model', async () => {
    await h.c.patch('/api/settings', { defaultModel: { providerId: 'ollama', model: 'hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL' } });
    const chat = (await h.c.post('/api/chats', {})).data.chat.id;
    const r = await h.c.sse(`/api/chats/${chat}/messages`, { content: 'hello small machine' });
    const ctx = r.events.find((e) => e.type === 'context');
    assert.ok(ctx.numCtx < 65536);
    const body = h.fake.chatRequests().at(-1);
    assert.equal(body.options.num_ctx, ctx.numCtx);
    assert.equal(body.keep_alive, '30m');
    assert.equal(h.app.settings.get().compaction.model, null);
    assert.equal(h.app.settings.get().memory.model, null);
  });
});
