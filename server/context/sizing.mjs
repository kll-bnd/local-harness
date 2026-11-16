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

function sumOrScalar(v, layers) {
  if (Array.isArray(v)) return { total: v.reduce((a, b) => a + (Number(b) || 0), 0), avg: v.reduce((a, b) => a + (Number(b) || 0), 0) / (v.length || 1) };
  const n = Number(v) || 0;
  return { total: n * layers, avg: n };
}

/**
 * KV-cache cost model from architecture metadata.
 * Returns `{ perToken, fixedFor(ctx), fullLayers, swaLayers, window, source }`.
 */
export function kvCacheModel(arch = {}, profile = {}, kvCacheType = 'f16') {
  const bpe = KV_BYTES[kvCacheType] ?? 2;
  const layers = Number(arch.blockCount) || 0;
  const headCount = Number(Array.isArray(arch.headCount) ? arch.headCount[0] : arch.headCount) || 0;
  const emb = Number(arch.embeddingLength) || 0;
  if (!layers || (!headCount && !arch.keyLength)) {
    // Heuristic fallback: ~16 KiB/token per billion params at f16 (Llama-3-8B ≈ 128 KiB/token).
    const paramsB = arch.parameterCount ? arch.parameterCount / 1e9 : 7;
    const perToken = Math.round(16384 * paramsB * (bpe / 2));
    return { perToken, fixedFor: () => 0, fullLayers: null, swaLayers: 0, window: null, source: 'heuristic' };
  }
  const headDimK = Number(arch.keyLength) || (headCount ? emb / headCount : 0);
  const headDimV = Number(arch.valueLength) || headDimK;
  const kvHeads = sumOrScalar(arch.headCountKv ?? headCount, layers);
  let effectiveLayers = layers;
  if (arch.sharedKvLayers && arch.sharedKvLayers < layers) effectiveLayers = layers - Number(arch.sharedKvLayers);

  // Sliding-window layout: metadata pattern if present, else family profile.
  let window = Number(arch.slidingWindow) || null;
  let globalEvery = null;
  let globalLayers = null;
  if (Array.isArray(arch.slidingWindowPattern)) {
    // true = sliding layer
    const pat = arch.slidingWindowPattern.slice(0, effectiveLayers);
    globalLayers = pat.filter((x) => !x).length;
  } else if (Number(arch.slidingWindowPattern) > 1) {
    globalEvery = Number(arch.slidingWindowPattern);
  } else if (profile?.swa) {
    globalEvery = profile.swa.globalEvery;
    window = window || profile.swa.window;
  }
  const perLayer = kvHeads.avg * (headDimK + headDimV) * bpe;
  let fullLayers = effectiveLayers;
  let swaLayers = 0;
  if (window && (globalEvery || globalLayers != null)) {
    fullLayers = globalLayers != null ? globalLayers : Math.ceil(effectiveLayers / globalEvery);
    swaLayers = effectiveLayers - fullLayers;
  }
  const perToken = Math.round(fullLayers * perLayer);
  const fixedFor = (ctx) => Math.round(swaLayers * perLayer * Math.min(window || 0, ctx));
  return { perToken, fixedFor, fullLayers, swaLayers, window: swaLayers ? window : null, source: swaLayers ? 'metadata+swa' : 'metadata' };
}

function roundCtx(n) {
  if (n >= 8192) return Math.floor(n / 2048) * 2048;
  if (n >= 4096) return Math.floor(n / 1024) * 1024;
  return Math.floor(n / 512) * 512;
}

/**
 * Decide num_ctx for a model.
 * @param {object} p
 * @param {'auto'|'max'|number} p.mode
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
  } = p;
  const totalMem = system.totalMem;
  const budget = memoryBudget({ totalMem, platform: system.platform, arch: system.arch, memoryFraction });
  const memBase = { totalBytes: totalMem, budgetBytes: budget.budgetBytes, budgetFraction: budget.fraction, osReserveBytes: budget.osReserveBytes, ramTier: budget.tier };
  const warnings = [];
  const machine = `${Math.round(totalMem / GiB)} GB ${system.platform === 'darwin' ? 'Mac' : 'machine'}`;

  // Servers that fix the context at launch (llama-server -c, LM Studio load settings).
  if (providerKind !== 'ollama') {
    const numCtx = serverCtx || modelMaxIn || DEFAULT_FALLBACK_CTX;
    const known = !!(serverCtx || modelMaxIn);
    if (!known) warnings.push({ code: 'context_unknown', message: `The server did not report its context size; assuming ${formatTokensK(numCtx)}.` });
    return {
      numCtx, mode: 'server', modelMax: modelMaxIn || null, modelMaxSource, advertisedMax, limitedBy: 'server', fits: null, fitMax: null,
      memory: { ...memBase, modelBytes: modelBytes || null, overheadBytes: null, kvBytesPerToken: null, kvFixedBytes: null, kvCacheType: null, kvSource: null, kvBytes: null, otherModelsBytes, estimatedTotalBytes: null },
      alternatives: null, warnings,
      explanation: known ? `Context is fixed by the server at ${formatTokensK(numCtx)} (set when the server/model was loaded).` : `Context size unknown; assuming ${formatTokensK(numCtx)}.`,
    };
  }

  const modelMax = modelMaxIn || DEFAULT_FALLBACK_CTX;
  if (!modelMaxIn) warnings.push({ code: 'context_unknown', message: `Model metadata has no context length; assuming ${formatTokensK(modelMax)}.` });
  const kv = kvCacheModel(arch, profile, kvCacheType);
  const overhead = overheadBytes(modelBytes);
  const estimate = (ctx) => modelBytes + overhead + kv.perToken * ctx + kv.fixedFor(ctx) + otherModelsBytes;
  const available = budget.budgetBytes - modelBytes - overhead - otherModelsBytes;
  // Solve perToken*ctx + fixedFor(ctx) <= available (fixedFor saturates at window, so subtract its max).
  const fixedMax = kv.fixedFor(Number.MAX_SAFE_INTEGER);
  let fitMax = kv.perToken > 0 ? Math.floor((available - fixedMax) / kv.perToken) : modelMax;
  if (!Number.isFinite(fitMax)) fitMax = 0;
  fitMax = Math.max(0, fitMax);
  const modelFits = available > fixedMax + kv.perToken * MIN_CTX;

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
  const total = estimate(numCtx);
  const fits = total <= budget.budgetBytes;
  if (!modelFits) {
    warnings.push({ code: 'model_exceeds_budget', message: `The model (${formatBytes(modelBytes)}) leaves no room for a useful context within the safe memory budget (${formatBytes(budget.budgetBytes)}) on this ${machine}. Expect swapping or CPU offload; consider a smaller quantization.` });
  } else if (!fits) {
    warnings.push({ code: 'exceeds_budget', message: `Estimated ${formatBytes(total)} exceeds the safe memory budget of ${formatBytes(budget.budgetBytes)}; generation may swap or offload to CPU.` });
  }
  const maxTotal = estimate(modelMax);
  const alternatives = {
    max: { numCtx: modelMax, estimatedTotalBytes: maxTotal, fits: maxTotal <= budget.budgetBytes, overBudgetBytes: Math.max(0, maxTotal - budget.budgetBytes) },
    fitMax: Math.min(fitMax, modelMax),
  };

  const est = `est. ${formatBytes(total)} of ${formatBytes(totalMem)} RAM (safe budget ${formatBytes(budget.budgetBytes)})`;
  let explanation;
  if (!modelFits && effMode === 'auto') {
    explanation = `The model alone (${formatBytes(modelBytes)}) exceeds the safe memory budget (${formatBytes(budget.budgetBytes)}) on this ${machine}; using the minimum ${formatTokensK(numCtx)} context. A smaller quantization is strongly recommended.`;
  } else if (limitedBy === 'memory') {
    explanation = `${formatTokensK(numCtx)} of ${formatTokensK(modelMax)} context — limited by RAM; ${est}. Max mode (${formatTokensK(modelMax)}) would need ~${formatBytes(maxTotal)}${alternatives.max.fits ? '' : ' and would likely swap'}.`;
  } else if (limitedBy === 'user') {
    explanation = `${formatTokensK(numCtx)} of ${formatTokensK(modelMax)} context (manual); ${est}.`;
  } else if (limitedBy === 'low_ram_cap') {
    explanation = `${formatTokensK(numCtx)} of ${formatTokensK(modelMax)} context — capped for responsiveness on this ${machine} (RAM would allow ~${formatTokensK(roundCtx(Math.min(fitMax, modelMax)))}; raise context.lowRamCap or use max mode for more); ${est}.`;
  } else if (limitedBy === 'setting') {
    explanation = `${formatTokensK(numCtx)} of ${formatTokensK(modelMax)} context (capped by the auto-mode limit setting); ${est}.`;
  } else {
    explanation = `${formatTokensK(numCtx)} of ${formatTokensK(modelMax)} context (model max); ${est}.${!fits && effMode === 'max' ? ' Over budget: may swap.' : ''}`;
  }

  return {
    numCtx, mode: effMode, modelMax, modelMaxSource, advertisedMax, limitedBy, fits, fitMax: Math.min(fitMax, 10_000_000),
    memory: {
      ...memBase, modelBytes, overheadBytes: overhead, kvBytesPerToken: kv.perToken, kvFixedBytes: kv.fixedFor(numCtx), kvCacheType, kvSource: kv.source,
      kvLayers: { full: kv.fullLayers, slidingWindow: kv.swaLayers, window: kv.window },
      kvBytes: kv.perToken * numCtx + kv.fixedFor(numCtx), otherModelsBytes, estimatedTotalBytes: total,
    },
    alternatives, warnings, explanation,
  };
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
