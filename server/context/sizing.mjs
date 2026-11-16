// RAM-aware context window sizing ("as much memory as allowed").
//
// estimated memory = model weights + compute overhead + KV cache(num_ctx) [+ other resident models]
// KV cache per token = Σ_layers kv_heads × (key_dim + value_dim) × bytes_per_element
// Sliding-window layers only cache `window` tokens, so they cost a fixed amount instead of per-token.
import { GiB, MiB, clamp, formatBytes, formatTokensK } from '../lib/util.mjs';

export const MIN_CTX = 2048;
export const DEFAULT_FALLBACK_CTX = 8192;

/** Bytes per K/V element for Ollama's OLLAMA_KV_CACHE_TYPE values (q8_0: 34 bytes per 32 values). */
export const KV_BYTES = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 };
/** Extra cells llama.cpp adds to a sliding-window KV cache (its default micro-batch). */
export const SWA_UBATCH = 512;

export function ramTier(totalMem) {
  const gb = totalMem / GiB;
  if (gb <= 8.5) return 'low';
  if (gb <= 16.5) return 'medium';
  return 'high';
}

/**
 * Safe memory budget for model + KV cache.
 * Apple Silicon: Metal's recommended working set is ~2/3 of RAM (≤36 GB) or ~3/4 (larger), and we also
 * keep a fixed reserve for macOS + apps — generous on ≤8 GB machines, where swapping makes the Mac unusable.
 */
export function memoryBudget({ totalMem, platform = process.platform, arch = process.arch, memoryFraction = null }) {
  const tier = ramTier(totalMem);
  if (memoryFraction && memoryFraction > 0 && memoryFraction <= 1) {
    return { budgetBytes: Math.floor(totalMem * memoryFraction), fraction: memoryFraction, osReserveBytes: Math.floor(totalMem * (1 - memoryFraction)), tier, source: 'setting' };
  }
  const appleSilicon = platform === 'darwin' && arch === 'arm64';
  const gpuFraction = appleSilicon ? (totalMem <= 36 * GiB ? 0.66 : 0.75) : 0.75;
  const osReserve = tier === 'low' ? 3.25 * GiB : tier === 'medium' ? 4 * GiB : 6 * GiB;
  const budget = Math.max(0.5 * GiB, Math.min(totalMem * gpuFraction, totalMem - osReserve));
  return { budgetBytes: Math.floor(budget), fraction: Math.round((budget / totalMem) * 1000) / 1000, osReserveBytes: Math.floor(totalMem - budget), tier, source: appleSilicon ? 'apple-silicon' : 'default' };
}

/** Compute/graph overhead beyond weights and KV cache (rough). */
export function overheadBytes(modelBytes) {
  return Math.round(256 * MiB + 0.03 * (modelBytes || 0));
}

/**
 * Per-layer metadata may be a scalar or an array. A non-verbose /api/show can blank or truncate long arrays, so an
 * array only counts when it has one positive number per layer; otherwise its positive entries' average (or the
 * fallback) is used — a missing/empty array never turns the estimate into 0 bytes.
 */
function sumOrScalar(v, layers, fallback = 0) {
  if (Array.isArray(v)) {
    const nums = v.map(Number).filter((x) => Number.isFinite(x) && x > 0);
    if (nums.length && nums.length >= layers) { const t = nums.slice(0, layers).reduce((a, b) => a + b, 0); return { total: t, avg: t / layers }; }
    const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : Number(fallback) || 0;
    return { total: avg * layers, avg };
  }
  const n = Number(v) || Number(fallback) || 0;
  return { total: n * layers, avg: n };
}

const firstNum = (v) => (Array.isArray(v) ? v.map(Number).find((x) => Number.isFinite(x) && x > 0) : Number(v)) || 0;

/**
 * KV-cache cost model from architecture metadata.
 * Returns `{ perToken, fixedFor(ctx), fullLayers, swaLayers, window, source }`.
 */
export function kvCacheModel(arch = {}, profile = {}, kvCacheType = 'f16') {
  const bpe = KV_BYTES[kvCacheType] ?? 2;
  const layers = Number(arch.blockCount) || 0;
  const headCount = firstNum(arch.headCount);
  const emb = Number(arch.embeddingLength) || 0;
  if (!layers || (!headCount && !firstNum(arch.keyLength))) {
    // Heuristic fallback: ~16 KiB/token per billion params at f16 (Llama-3-8B ≈ 128 KiB/token).
    const paramsB = arch.parameterCount ? arch.parameterCount / 1e9 : 7;
    const perToken = Math.round(16384 * paramsB * (bpe / 2));
    return { perToken, fixedFor: () => 0, fullLayers: null, swaLayers: 0, window: null, source: 'heuristic' };
  }
  const headDimK = firstNum(arch.keyLength) || (headCount ? emb / headCount : 0);
  const headDimV = firstNum(arch.valueLength) || headDimK;
  const kvHeads = sumOrScalar(arch.headCountKv ?? headCount, layers, headCount);
  let effectiveLayers = layers;
  if (arch.sharedKvLayers && arch.sharedKvLayers < layers) effectiveLayers = layers - Number(arch.sharedKvLayers);

  // Sliding-window layout: metadata pattern if present, else family profile.
  let window = Number(arch.slidingWindow) || null;
  let globalEvery = null;
  let globalLayers = null;
  if (Array.isArray(arch.slidingWindowPattern) && arch.slidingWindowPattern.length >= effectiveLayers) {
    // true = sliding layer (an empty / truncated array is ignored: the profile's layout is used instead)
    const pat = arch.slidingWindowPattern.slice(0, effectiveLayers);
    globalLayers = pat.filter((x) => !x).length;
  } else if (!Array.isArray(arch.slidingWindowPattern) && Number(arch.slidingWindowPattern) > 1) {
    globalEvery = Number(arch.slidingWindowPattern);
  } else if (profile?.swa) {
    globalEvery = profile.swa.globalEvery;
    window = window || profile.swa.window;
  }
  const perLayer = kvHeads.avg * (headDimK + headDimV) * bpe;
  // gemma4 metadata gives sliding-window layers their own (smaller) key/value lengths (`*_swa`).
  const perLayerSwa = kvHeads.avg * ((Number(arch.keyLengthSwa) || headDimK) + (Number(arch.valueLengthSwa) || Number(arch.keyLengthSwa) || headDimV)) * bpe;
  let fullLayers = effectiveLayers;
  let swaLayers = 0;
  if (window && (globalEvery || globalLayers != null)) {
    fullLayers = globalLayers != null ? globalLayers : Math.ceil(effectiveLayers / globalEvery);
    swaLayers = effectiveLayers - fullLayers;
  }
  const perToken = Math.round(fullLayers * perLayer);
  // llama.cpp sizes the sliding-window cache at window + one micro-batch (512) cells, whatever the context.
  const swaCells = (ctx) => Math.min((window || 0) + SWA_UBATCH, ctx);
  const fixedFor = (ctx) => Math.round(swaLayers * perLayerSwa * swaCells(ctx));
  return { perToken, fixedFor, fullLayers, swaLayers, window: swaLayers ? window : null, swaCells: swaLayers ? swaCells(Number.MAX_SAFE_INTEGER) : null, source: swaLayers ? 'metadata+swa' : 'metadata' };
}

export function roundCtx(n) {
  if (n >= 8192) return Math.floor(n / 2048) * 2048;
  if (n >= 4096) return Math.floor(n / 1024) * 1024;
  return Math.floor(n / 512) * 512;
}

const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * True when a sample shows part of the model running on the CPU: Ollama's /api/ps `size_vram < size`
 * (`cpuBytes` = size − size_vram), compared with the resident total.
 */
export function isCpuSplit(sample) {
  if (Number.isFinite(sample?.cpuBytes)) return sample.cpuBytes > Math.max(64 * MiB, 0.03 * (sample.totalBytes || 0));
  return Number.isFinite(sample?.vramBytes) && sample.vramBytes >= 0 && sample.vramBytes < sample.totalBytes * 0.97;
}

/** Samples whose load made macOS swap/compress (RSS then under-reports: never used as a size). */
export const isPressured = (smp) => !!smp?.pressure?.signal;

/**
 * The smallest context at which loading pushed the machine into swap, unless a later clean sample at that context
 * or more shows it fits now (other apps closed). Returns { numCtx, sample } or null.
 */
export function pressureLimit(samples) {
  let worst = null;
  for (const smp of samples || []) {
    if (!isPressured(smp)) continue;
    const cleared = samples.some((o) => !isPressured(o) && o.loaded && o.numCtx >= smp.numCtx && String(o.at || '') > String(smp.at || ''));
    if (cleared) continue;
    if (!worst || smp.numCtx < worst.numCtx) worst = { numCtx: smp.numCtx, sample: smp };
  }
  return worst;
}

/**
 * Fit measured resident sizes (Ollama /api/ps `size` at a given num_ctx) to `total(ctx) = fixed + perToken·ctx`.
 * - 1 distinct context  → keep the estimated bytes/token, correct the fixed part (offset).
 * - ≥2 distinct contexts (≥1K apart) → least-squares slope too, clamped to ¼–4× the estimate.
 * Samples are sanity-checked against the estimate (0.4×–3×, ≥ half the weights) and repeated samples at the
 * same context are reduced to their median, so a single odd reading cannot swing the plan.
 * @param {Array<{numCtx, totalBytes, vramBytes?, at?}>} samples (already filtered to this model/digest/KV type)
 * @param {{ estModelOnly: (ctx:number)=>number, perToken: number, modelBytes?: number }} est
 * @returns {null | { usable, method, fixedBytes, perTokenBytes, samples, distinctContexts, rejected, latest, gpuCapBytes }}
 */
export function fitMeasurements(samples, { estModelOnly, perToken, modelBytes = 0 }) {
  if (!samples?.length) return null;
  const ok = [];
  let rejected = 0;
  for (const smp of samples) {
    if (isPressured(smp)) { rejected++; continue; } // RSS under-reports while macOS swaps: not a size
    const n = Number(smp.numCtx);
    const M = Number(smp.totalBytes);
    if (!Number.isFinite(n) || !Number.isFinite(M) || n < 256 || M <= 0) { rejected++; continue; }
    const est = estModelOnly(n);
    const r = est > 0 ? M / est : 1;
    if (r < 0.4 || r > 3 || (modelBytes > 0 && M < modelBytes * 0.5)) { rejected++; continue; }
    const v = Number(smp.vramBytes);
    ok.push({ ...smp, numCtx: n, totalBytes: M, vramBytes: Number.isFinite(v) && v >= 0 && v <= M * 1.05 ? v : null });
  }
  if (!ok.length) return { usable: false, method: 'none', samples: 0, distinctContexts: 0, rejected, latest: null, gpuCapBytes: null };
  const byCtx = new Map();
  for (const smp of ok) {
    if (!byCtx.has(smp.numCtx)) byCtx.set(smp.numCtx, []);
    byCtx.get(smp.numCtx).push(smp.totalBytes);
  }
  const groups = [...byCtx.entries()].map(([n, ms]) => ({ n, M: median(ms) })).sort((a, b) => a.n - b.n);
  const latest = ok.reduce((a, b) => (String(b.at || '') >= String(a.at || '') ? b : a));
  let B = perToken;
  let A;
  let method;
  const spread = groups.length ? groups[groups.length - 1].n - groups[0].n : 0;
  if (groups.length >= 2 && spread >= 1024) {
    const nBar = groups.reduce((a, g) => a + g.n, 0) / groups.length;
    const mBar = groups.reduce((a, g) => a + g.M, 0) / groups.length;
    let num = 0;
    let den = 0;
    for (const g of groups) { num += (g.n - nBar) * (g.M - mBar); den += (g.n - nBar) ** 2; }
    const raw = den > 0 ? num / den : NaN;
    const lo = perToken > 0 ? perToken * 0.25 : 0;
    const hi = perToken > 0 ? perToken * 4 : 1024 * 1024;
    B = Number.isFinite(raw) && raw > 0 ? clamp(raw, lo, hi) : (perToken > 0 ? perToken : 0);
    method = Number.isFinite(raw) && raw > 0 && B === raw ? 'linear' : 'linear-clamped';
    A = groups.reduce((a, g) => a + (g.M - B * g.n), 0) / groups.length;
  } else {
    const g = byCtx.has(latest.numCtx) ? { n: latest.numCtx, M: median(byCtx.get(latest.numCtx)) } : groups[groups.length - 1];
    A = g.M - B * g.n;
    method = 'offset';
  }
  // The resident need is at least the model file: every layer is touched for every token. A resident size below the
  // weights means pages not yet touched after the load (mmap) or already evicted under pressure — not a smaller model.
  const flooredToWeights = modelBytes > 0 && A < modelBytes;
  A = Math.max(A, modelBytes);
  // GPU capacity: the smallest GPU-resident size seen while the model was split across CPU/GPU,
  // unless a later fully-GPU sample proves more fits.
  const splits = ok.filter(isCpuSplit);
  let gpuCapBytes = splits.length ? Math.min(...splits.map((x) => x.vramBytes)) : null;
  if (gpuCapBytes !== null && ok.some((x) => !isCpuSplit(x) && x.totalBytes >= gpuCapBytes && String(x.at || '') > String(splits.find((y) => y.vramBytes === gpuCapBytes).at || ''))) gpuCapBytes = null;
  return {
    usable: true, method, fixedBytes: Math.round(A), perTokenBytes: Math.round(B), samples: ok.length, distinctContexts: groups.length, rejected, flooredToWeights,
    latest: { numCtx: latest.numCtx, totalBytes: latest.totalBytes, vramBytes: latest.vramBytes, at: latest.at || null, cpuSplit: isCpuSplit(latest) },
    gpuCapBytes,
  };
}

/**
 * Decide num_ctx for a model.
 * @param {object} p
 * @param {'auto'|'max'|number} p.mode
 * @param {Array} [p.measurements] Ollama /api/ps samples for this model (same digest + KV type) — see fitMeasurements
 * @returns ContextPlan (see docs/API.md)
 */
export function computeContextPlan(p) {
  const {
    providerKind = 'ollama', serverCtx = null,
    modelMax: modelMaxIn, modelMaxSource = 'unknown', advertisedMax = null,
    modelBytes = 0, arch = {}, profile = {},
    mode = 'auto', maxAuto = null, lowRamCap = null,
    system = {}, memoryFraction = null, kvCacheType = 'f16',
    otherModelsBytes = 0,
    measurements = null,
    kvCacheTypeSource = null, // 'setting' | 'managed' | 'assumed' (Ollama not started by Harness: f16 assumed)
    smaller = null, // next smaller recommended file { model, approxSizeBytes, textOnly } (for "too big" advice)
    loadedCtx = null, // num_ctx the model is loaded with right now (auto mode does not grow it), or null when cold
  } = p;
  const totalMem = system.totalMem;
  const budget = memoryBudget({ totalMem, platform: system.platform, arch: system.arch, memoryFraction });
  const memBase = { totalBytes: totalMem, budgetBytes: budget.budgetBytes, budgetFraction: budget.fraction, osReserveBytes: budget.osReserveBytes, ramTier: budget.tier };
  const warnings = [];
  const machine = `${Math.round(totalMem / GiB)} GB ${system.platform === 'darwin' ? 'Mac' : 'machine'}`;

  // Servers that fix the context at launch (llama-server -c, LM Studio load settings).
  if (providerKind !== 'ollama') {
    // Never assume more than the fallback when the server did not tell us its loaded context: the model's
    // trained maximum (e.g. LM Studio before JIT loading) is not what the server will accept.
    const numCtx = serverCtx || Math.min(modelMaxIn || DEFAULT_FALLBACK_CTX, DEFAULT_FALLBACK_CTX);
    const known = !!serverCtx;
    if (!known) warnings.push({ code: 'context_unknown', message: `The server did not report its loaded context size; assuming ${formatTokensK(numCtx)}.` });
    return {
      numCtx, mode: 'server', modelMax: modelMaxIn || null, modelMaxSource, advertisedMax, limitedBy: 'server', fits: null, fitMax: null,
      memory: { ...memBase, modelBytes: modelBytes || null, overheadBytes: null, kvBytesPerToken: null, kvFixedBytes: null, kvCacheType: null, kvSource: null, kvBytes: null, otherModelsBytes, estimatedTotalBytes: null, basis: 'estimate', measurement: null },
      alternatives: null, warnings,
      explanation: known ? `Context is fixed by the server at ${formatTokensK(numCtx)} (set when the server/model was loaded).` : `Context size unknown; assuming ${formatTokensK(numCtx)}.`,
    };
  }

  const modelMax = modelMaxIn || DEFAULT_FALLBACK_CTX;
  if (!modelMaxIn) warnings.push({ code: 'context_unknown', message: `Model metadata has no context length; assuming ${formatTokensK(modelMax)}.` });
  const kv = kvCacheModel(arch, profile, kvCacheType);
  const overhead = overheadBytes(modelBytes);
  const estModelOnly = (ctx) => modelBytes + overhead + kv.perToken * ctx + kv.fixedFor(ctx);
  const fit = measurements?.length ? fitMeasurements(measurements, { estModelOnly, perToken: kv.perToken, modelBytes }) : null;
  const corr = fit?.usable ? fit : null;
  const modelOnly = corr ? (ctx) => corr.fixedBytes + corr.perTokenBytes * ctx : estModelOnly;
  const estimate = (ctx) => modelOnly(ctx) + otherModelsBytes;

  let fitMax;
  let modelFits;
  let gpuFitMax = null;
  if (corr) {
    const avail = budget.budgetBytes - otherModelsBytes;
    const solve = (cap) => (corr.perTokenBytes > 0 ? Math.floor((cap - corr.fixedBytes) / corr.perTokenBytes) : modelMax);
    fitMax = solve(avail);
    if (corr.gpuCapBytes) {
      gpuFitMax = Math.max(0, solve(corr.gpuCapBytes));
      fitMax = Math.min(fitMax, gpuFitMax);
    }
    modelFits = Math.min(avail, corr.gpuCapBytes ?? Infinity) > corr.fixedBytes + corr.perTokenBytes * MIN_CTX;
  } else {
    const available = budget.budgetBytes - modelBytes - overhead - otherModelsBytes;
    // Solve perToken*ctx + fixedFor(ctx) <= available (fixedFor saturates at window, so subtract its max).
    const fixedMax = kv.fixedFor(Number.MAX_SAFE_INTEGER);
    fitMax = kv.perToken > 0 ? Math.floor((available - fixedMax) / kv.perToken) : modelMax;
    modelFits = available > fixedMax + kv.perToken * MIN_CTX;
  }
  if (!Number.isFinite(fitMax)) fitMax = 0;
  fitMax = Math.max(0, fitMax);

  let numCtx;
  let limitedBy;
  let effMode = mode;
  if (typeof mode === 'number' || (typeof mode === 'string' && /^\d+$/.test(mode))) {
    const requested = Number(mode);
    effMode = 'manual';
    numCtx = clamp(Math.floor(requested), 512, modelMax);
    limitedBy = requested > modelMax ? 'model' : 'user';
    if (requested > modelMax) warnings.push({ code: 'clamped_to_model_max', message: `Requested ${formatTokensK(requested)} exceeds the model maximum ${formatTokensK(modelMax)}.` });
  } else if (mode === 'max') {
    numCtx = modelMax;
    limitedBy = 'model';
  } else {
    effMode = 'auto';
    let cap = maxAuto ? Math.min(modelMax, maxAuto) : modelMax;
    let capReason = maxAuto && maxAuto < modelMax ? 'setting' : 'model';
    // On ≤8 GB machines very long prompts are slow to process and leave no slack; cap auto mode.
    if (lowRamCap && budget.tier === 'low' && lowRamCap < cap) { cap = lowRamCap; capReason = 'low_ram_cap'; }
    if (fitMax >= cap) {
      numCtx = cap;
      limitedBy = capReason;
    } else {
      numCtx = Math.max(MIN_CTX, roundCtx(fitMax));
      limitedBy = 'memory';
    }
  }
  let autoNote = '';
  // Loading at some context made macOS swap / compress: come down (auto), or warn (explicit).
  const pLimit = measurements?.length ? pressureLimit(measurements) : null;
  if (pLimit) {
    const what = describePressure(pLimit.sample.pressure);
    if (effMode === 'auto') {
      if (pLimit.numCtx <= MIN_CTX) {
        numCtx = MIN_CTX;
        limitedBy = 'memory_pressure';
        warnings.push({
          code: 'model_too_big',
          message: `This model file (${formatBytes(modelBytes)}) is too big for this ${machine}: even the minimum ${formatTokensK(MIN_CTX)} context made macOS swap (${what}).${smaller ? ` Use a smaller file: ${smaller.model} (${formatBytes(smaller.approxSizeBytes)}${smaller.textOnly ? ' as a text-only copy' : ''}).` : ' Use a smaller model.'}`,
          ...(smaller ? { smallerModel: smaller.model } : {}),
        });
      } else {
        // One step, not repeated halving (each step is a model reload): take the swap + compressor growth the load
        // caused off the window at the corrected per-token cost, at least one notch below the pressured window.
        const pz = pLimit.sample.pressure || {};
        const excess = Math.max(0, pz.swapDeltaBytes || 0) + Math.max(0, pz.compressedDeltaBytes || 0);
        const perTok = corr?.perTokenBytes || kv.perToken || 0;
        const cut = perTok > 0 ? Math.ceil(excess / perTok) : Infinity;
        const cap = Math.max(MIN_CTX, Math.min(roundCtx(pLimit.numCtx - Math.max(cut, 512)), roundCtx(pLimit.numCtx - 1)));
        if (numCtx > cap) {
          numCtx = cap;
          limitedBy = 'memory_pressure';
          autoNote = `Loading this model at ${formatTokensK(pLimit.numCtx)} made macOS swap (${what}); auto mode reduced the window to ${formatTokensK(numCtx)}. `;
        }
      }
    } else if (numCtx >= pLimit.numCtx) {
      warnings.push({ code: 'memory_pressure', message: `Loading this model at ${formatTokensK(pLimit.numCtx)} made macOS swap (${what}). Your context setting was kept: lower it or switch to auto.` });
    }
  }
  // Auto mode never GROWS the window of a model that is loaded right now (that would reload it mid-conversation):
  // a larger window waits for the next cold load (unload / expiry / image job / restart). Shrinking is immediate.
  let pendingNumCtx = null;
  if (effMode === 'auto' && Number.isFinite(loadedCtx) && loadedCtx >= 512 && numCtx > loadedCtx) {
    pendingNumCtx = numCtx;
    numCtx = loadedCtx;
    limitedBy = 'loaded';
  }
  const total = estimate(numCtx);
  const fits = total <= budget.budgetBytes;
  if (!modelFits) {
    warnings.push({ code: 'model_exceeds_budget', message: `The model (${formatBytes(corr ? corr.fixedBytes : modelBytes)}${corr ? ' measured' : ''}) leaves no room for a useful context within the safe memory budget (${formatBytes(budget.budgetBytes)}) on this ${machine}. Expect swapping or CPU offload; consider a smaller quantization.` });
  } else if (!fits) {
    warnings.push({ code: 'exceeds_budget', message: `${corr ? 'Measurement-corrected estimate' : 'Estimated'} ${formatBytes(total)} exceeds the safe memory budget of ${formatBytes(budget.budgetBytes)}; generation may swap or offload to CPU.` });
  }

  // Bad outcomes seen in the latest real measurement.
  if (corr?.latest) {
    const L = corr.latest;
    const over = L.totalBytes + otherModelsBytes > budget.budgetBytes;
    const split = L.cpuSplit;
    const atOrAbove = numCtx >= L.numCtx;
    const fitK = formatTokensK(Math.max(MIN_CTX, roundCtx(Math.min(fitMax, modelMax))));
    if (effMode === 'auto' && (over || split) && !atOrAbove) {
      const what = [over ? `over the safe budget of ${formatBytes(budget.budgetBytes)}` : null, split ? `${formatBytes(L.totalBytes - L.vramBytes)} of it on the CPU` : null].filter(Boolean).join(', ');
      autoNote += `Measured ${formatBytes(L.totalBytes)} at ${formatTokensK(L.numCtx)} (${what}); auto mode reduced the window to ${formatTokensK(numCtx)} using that measurement. `;
    } else if (atOrAbove) {
      const explicit = effMode !== 'auto';
      if (over) {
        warnings.push({ code: 'measured_exceeds_budget', message: `Measured ${formatBytes(L.totalBytes)} for this model at ${formatTokensK(L.numCtx)} — over the safe memory budget of ${formatBytes(budget.budgetBytes)} on this ${machine}; expect swapping. ${explicit ? `About ${fitK} would fit: lower the context or switch to auto.` : 'Use a smaller quantization.'}` });
      }
      if (split) {
        const pct = Math.round(((L.totalBytes - L.vramBytes) / L.totalBytes) * 100);
        const gpuK = gpuFitMax !== null ? formatTokensK(Math.max(MIN_CTX, roundCtx(Math.min(gpuFitMax, modelMax)))) : null;
        warnings.push({ code: 'cpu_offload', message: `Ollama placed only ${formatBytes(L.vramBytes)} of ${formatBytes(L.totalBytes)} on the GPU at ${formatTokensK(L.numCtx)} (${pct}% runs on the CPU), which makes generation much slower. ${explicit && gpuK ? `Use a smaller context window (about ${gpuK} fits on the GPU) or a smaller quantization.` : 'Use a smaller quantization.'}` });
      }
    }
  }

  const totalNow = total;
  const maxTotal = estimate(modelMax);
  const alternatives = {
    max: { numCtx: modelMax, estimatedTotalBytes: maxTotal, fits: maxTotal <= budget.budgetBytes, overBudgetBytes: Math.max(0, maxTotal - budget.budgetBytes) },
    fitMax: Math.min(fitMax, modelMax),
  };

  const est = `${corr ? 'measured-corrected' : 'est.'} ${formatBytes(totalNow)} of ${formatBytes(totalMem)} RAM (safe budget ${formatBytes(budget.budgetBytes)})`;
  const modelSize = corr ? corr.fixedBytes : modelBytes;
  let explanation;
  if (!modelFits && effMode === 'auto') {
    explanation = `The model alone (${formatBytes(modelSize)}${corr ? ' measured' : ''}) exceeds the safe memory budget (${formatBytes(budget.budgetBytes)}) on this ${machine}; using the minimum ${formatTokensK(numCtx)} context. A smaller quantization is strongly recommended.`;
  } else if (limitedBy === 'memory') {
    explanation = `${formatTokensK(numCtx)} of ${formatTokensK(modelMax)} context — limited by RAM${corr?.gpuCapBytes && gpuFitMax !== null && gpuFitMax <= fitMax ? ' (what fits on the GPU)' : ''}; ${est}. Max mode (${formatTokensK(modelMax)}) would need ~${formatBytes(maxTotal)}${alternatives.max.fits ? '' : ' and would likely swap'}.`;
  } else if (limitedBy === 'user') {
    explanation = `${formatTokensK(numCtx)} of ${formatTokensK(modelMax)} context (manual); ${est}.`;
  } else if (limitedBy === 'loaded') {
    explanation = `${formatTokensK(numCtx)} of ${formatTokensK(modelMax)} context — the window the model is loaded with; it will use ${formatTokensK(pendingNumCtx)} next time the model loads (a larger window now would reload it mid-conversation); ${est}.`;
  } else if (limitedBy === 'memory_pressure') {
    explanation = `${formatTokensK(numCtx)} of ${formatTokensK(modelMax)} context — limited by what this ${machine} handled without swapping; ${est}.`;
  } else if (limitedBy === 'low_ram_cap') {
    explanation = `${formatTokensK(numCtx)} of ${formatTokensK(modelMax)} context — capped for responsiveness on this ${machine} (RAM alone would allow ~${formatTokensK(roundCtx(Math.min(fitMax, modelMax)))}; raise context.lowRamCap or use max mode for more); ${est}.`;
  } else if (limitedBy === 'setting') {
    explanation = `${formatTokensK(numCtx)} of ${formatTokensK(modelMax)} context (capped by the auto-mode limit setting); ${est}.`;
  } else {
    explanation = `${formatTokensK(numCtx)} of ${formatTokensK(modelMax)} context (model max); ${est}.${!fits && effMode === 'max' ? ' Over budget: may swap.' : ''}`;
  }
  explanation = autoNote + explanation;
  // Models like Nemotron (gemma4: 4 global KV layers) need little RAM per token: say that the file decides.
  const kvMaxBytes = kv.perToken * modelMax + kv.fixedFor(modelMax);
  const contextCheap = modelBytes > 0 && kvMaxBytes < 0.25 * modelBytes;
  if (contextCheap && limitedBy !== 'model' && limitedBy !== 'user') {
    explanation += ` Context is cheap for this model (the full ${formatTokensK(modelMax)} needs only ~${formatBytes(kvMaxBytes)} of KV cache); the model file (${formatBytes(modelBytes)}) is what decides whether it fits.`;
  }
  if (kvCacheTypeSource === 'assumed') {
    explanation += ' KV cache precision unknown (this Ollama was not started by Harness): assuming f16 to be safe — set context.kvCacheType if you know it.';
  }
  if (corr) {
    explanation += ` Memory use is calibrated from ${corr.samples} measurement${corr.samples === 1 ? '' : 's'} of this model (last: ${formatBytes(corr.latest.totalBytes)} at ${formatTokensK(corr.latest.numCtx)}${corr.flooredToWeights ? `; below the ${formatBytes(modelBytes)} model file — not all of it was resident yet, so the file size is used as the minimum` : ''}).`;
  }

  return {
    numCtx, mode: effMode, modelMax, modelMaxSource, advertisedMax, limitedBy, fits, fitMax: Math.min(fitMax, 10_000_000),
    pendingNumCtx,
    memory: {
      ...memBase, modelBytes, overheadBytes: overhead, kvBytesPerToken: kv.perToken, kvFixedBytes: kv.fixedFor(numCtx), kvCacheType, kvCacheTypeSource, kvSource: kv.source,
      kvMaxBytes, contextCheap,
      pressure: pLimit ? { numCtx: pLimit.numCtx, ...pLimit.sample.pressure } : null,
      kvLayers: { full: kv.fullLayers, slidingWindow: kv.swaLayers, window: kv.window },
      kvBytes: kv.perToken * numCtx + kv.fixedFor(numCtx), otherModelsBytes, estimatedTotalBytes: totalNow,
      basis: corr ? 'measured' : 'estimate',
      measurement: fit ? {
        method: fit.method, samples: fit.samples, distinctContexts: fit.distinctContexts, rejected: fit.rejected,
        fixedBytes: fit.usable ? fit.fixedBytes : null, perTokenBytes: fit.usable ? fit.perTokenBytes : null,
        estimatedFixedBytes: Math.round(modelBytes + overhead + kv.fixedFor(Number.MAX_SAFE_INTEGER)), estimatedPerTokenBytes: kv.perToken,
        gpuCapBytes: fit.gpuCapBytes, latest: fit.latest, flooredToWeights: !!fit.flooredToWeights,
      } : null,
    },
    alternatives, warnings, explanation,
  };
}

function describePressure(p = {}) {
  const parts = [];
  if (p.swapDeltaBytes > 0) parts.push(`+${formatBytes(p.swapDeltaBytes)} swap`);
  if (p.compressedDeltaBytes > 0) parts.push(`+${formatBytes(p.compressedDeltaBytes)} compressed`);
  if (!parts.length && p.level >= 2) parts.push(`memory pressure level ${p.level}`);
  return parts.join(', ') || 'memory pressure';
}

/**
 * Token budgets for one request, all derived as fractions of the actual window so they stay sane
 * from 4K to 128K. `s` = effective settings (context/compaction/memory/recall/documents sections).
 */
export function budgetsFor(numCtx, s = {}) {
  const frac = (v, f, lo, hi) => (typeof v === 'number' && v > 0 ? Math.floor(v) : Math.floor(clamp(numCtx * f, lo, hi)));
  const replyReserve = frac(s.context?.replyReserve, 0.15, 384, 8192);
  const input = Math.max(256, numCtx - replyReserve);
  const compaction = s.compaction || {};
  return {
    numCtx,
    replyReserve,
    input,
    compactAt: Math.floor(input * clamp(compaction.threshold ?? 0.75, 0.3, 0.98)),
    compactTarget: Math.floor(input * clamp(compaction.target ?? 0.45, 0.1, 0.9)),
    keepRecentTokens: Math.floor(input * clamp(compaction.keepRecentFraction ?? 0.25, 0.05, 0.8)),
    maxSummaryTokens: frac(compaction.maxSummaryTokens, 0.12, 192, 3000),
    memories: frac(s.memory?.maxTokens, 0.05, 96, 1500),
    recall: frac(s.recall?.maxTokens, 0.04, 0, 800),
    documents: frac(s.documents?.maxTokens, 0.2, 256, 16000),
    inlineFileMax: frac(s.documents?.inlineMaxTokens, 0.25, 512, 32000),
  };
}
