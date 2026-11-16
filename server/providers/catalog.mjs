// Static model knowledge: context-length overrides, family profiles (sampling defaults, sliding-window
// attention layout, image token cost) and the curated "recommended models" list.
// Everything here is best-effort data that the app can live without; it is surfaced to the UI as such.
import { GiB } from '../lib/util.mjs';

/**
 * Context-length overrides: the *real* usable context when a model's metadata advertises more.
 * `match` is tested against the model name and the GGUF general.name / basename.
 */
export const CONTEXT_OVERRIDES = [
  {
    match: /nemotron[-_. ]?3\.5[-_. ]?bolt/i,
    contextLength: 65536,
    note: 'Nemotron 3.5 Bolt E4B is trained for 64K tokens; its metadata advertises 128K.',
  },
];

/**
 * Family profiles. First match wins. `match` is tested against `<model name> <architecture>`.
 * - sampling: suggested defaults, used only when neither the user nor the model's Modelfile sets a value.
 * - swa: sliding-window attention layout for the KV-cache estimate. `globalEvery: N` means 1 of every N
 *   layers uses full attention and the rest only keep `window` tokens (window read from metadata when present).
 * - imageTokens: approximate prompt tokens per attached image.
 */
export const MODEL_PROFILES = [
  {
    id: 'nemotron-bolt',
    match: /nemotron[-_. ]?3\.5[-_. ]?bolt/i,
    family: 'gemma4',
    label: 'NVIDIA Nemotron 3.5 Bolt',
    // = the model file's general.sampling.* (temp 1, top_k 64, top_p 0.95), which is read and preferred when present.
    sampling: { temperature: 1.0, top_p: 0.95, top_k: 64 },
    // gemma4 layout (llama.cpp's own log): 42 blocks, 18 share KV (no cache of their own), the other 24 are
    // 4 global + 20 sliding-window (1 in 6 global; a sliding_window_pattern array in the metadata wins).
    swa: { globalEvery: 6, window: 512 },
    imageTokens: 280,
    // Measured: 13,499 characters of English prompt = 3,020 tokens (≈4.5 chars/token).
    charsPerToken: 4.5,
    notes: 'Gemma-4 based (7.5B parameters, "E4B") tuned for multi-turn tool use. Trained for 64K context.',
  },
  { id: 'gemma4', match: /gemma-?4/i, family: 'gemma4', sampling: { temperature: 1.0, top_p: 0.95, top_k: 64 }, swa: { globalEvery: 6, window: 512 }, imageTokens: 280 },
  { id: 'gemma3n', match: /gemma-?3n/i, family: 'gemma3n', sampling: { temperature: 1.0, top_p: 0.95, top_k: 64 }, swa: { globalEvery: 5, window: 512 }, imageTokens: 256 },
  { id: 'gemma3', match: /gemma-?3/i, family: 'gemma3', sampling: { temperature: 1.0, top_p: 0.95, top_k: 64 }, swa: { globalEvery: 6, window: 1024 }, imageTokens: 256 },
  { id: 'gemma2', match: /gemma-?2/i, family: 'gemma2', sampling: { temperature: 0.7, top_p: 0.95 } },
  { id: 'qwen3', match: /qwen-?3/i, family: 'qwen3', sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 } },
  { id: 'qwen2.5', match: /qwen-?2\.5/i, family: 'qwen2', sampling: { temperature: 0.7, top_p: 0.8, top_k: 20 } },
  { id: 'deepseek-r1', match: /deepseek-?r1/i, family: 'deepseek', sampling: { temperature: 0.6, top_p: 0.95 } },
  { id: 'llama3', match: /llama-?3/i, family: 'llama', sampling: { temperature: 0.7, top_p: 0.9 } },
  { id: 'mistral', match: /mistral|ministral/i, family: 'mistral', sampling: { temperature: 0.3 } },
  { id: 'phi', match: /phi-?[34]/i, family: 'phi', sampling: { temperature: 0.7 } },
  { id: 'llava', match: /llava|bakllava|moondream/i, family: 'llava', sampling: {}, imageTokens: 576 },
];

export const DEFAULT_PROFILE = { id: 'default', family: null, sampling: {}, imageTokens: 576 };

export function profileFor(...names) {
  const hay = names.filter(Boolean).join(' ');
  return MODEL_PROFILES.find((p) => p.match.test(hay)) || DEFAULT_PROFILE;
}

export function contextOverrideFor(...names) {
  const hay = names.filter(Boolean).join(' ');
  return CONTEXT_OVERRIDES.find((o) => o.match.test(hay)) || null;
}

/** Embedding models in preference order (Ollama tags). */
export const EMBEDDING_MODELS = [
  { model: 'embeddinggemma', approxSizeBytes: 0.62e9, dims: 768, prefixes: { query: 'task: search result | query: ', document: 'title: none | text: ' } },
  { model: 'nomic-embed-text', approxSizeBytes: 0.27e9, dims: 768, prefixes: { query: 'search_query: ', document: 'search_document: ' } },
  { model: 'mxbai-embed-large', approxSizeBytes: 0.67e9, dims: 1024, prefixes: { query: 'Represent this sentence for searching relevant passages: ', document: '' } },
  { model: 'snowflake-arctic-embed', approxSizeBytes: 0.67e9, dims: 1024, prefixes: { query: 'Represent this sentence for searching relevant passages: ', document: '' } },
  { model: 'bge-m3', approxSizeBytes: 1.2e9, dims: 1024, prefixes: { query: '', document: '' } },
  { model: 'all-minilm', approxSizeBytes: 0.046e9, dims: 384, prefixes: { query: '', document: '' } },
  { model: 'qwen3-embedding', approxSizeBytes: 0.64e9, dims: 1024, prefixes: { query: 'Instruct: Given a search query, retrieve relevant passages\nQuery: ', document: '' } },
];

export const EMBEDDING_NAME_RE = /embed|bge-|\be5-|minilm|gte-|arctic-embed/i;

export function embeddingProfileFor(model) {
  const base = String(model).split(':')[0].split('/').pop();
  return EMBEDDING_MODELS.find((e) => base === e.model || base.startsWith(e.model)) || { model, prefixes: { query: '', document: '' } };
}

const MiB = 1024 ** 2;
export const NEMOTRON_HF_REPO = 'hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF';
const NEMO_UD_PROJECTOR = 946 * MiB;
const hfNemo = (tag, layerMiB, label, extra = {}) => ({
  model: `${NEMOTRON_HF_REPO}:${tag}`, label, approxSizeBytes: layerMiB * MiB + NEMO_UD_PROJECTOR,
  modelLayerBytes: layerMiB * MiB, projectorBytes: NEMO_UD_PROJECTOR, textOnlyBytes: layerMiB * MiB, ...extra,
});

/**
 * Curated recommended chat models. `variants` are ordered largest → smallest; `approxSizeBytes` is the download
 * (and resident) size as pulled — for Nemotron these are the real layer sizes reported by the registry.
 * `textOnlyBytes`: size of a text-only copy (model layer without the vision/audio projector, see
 * POST /api/models/text-only). `lowRam`: how the variant is presented on ≤ 8 GB machines.
 */
export const RECOMMENDED_MODELS = [
  {
    id: 'nemotron-3.5-bolt-e4b',
    name: 'NVIDIA Nemotron 3.5 Bolt E4B',
    description: 'Fast Gemma-4-based model tuned for multi-turn tool use. Real context 64K.',
    tags: ['recommended', 'tools', 'thinking', 'fast'],
    contextLength: 65536,
    family: 'gemma4',
    // Real /api/show metadata (UD-Q3_K_XL pull), used for the pre-download fit estimate.
    archHint: { blockCount: 42, embeddingLength: 2560, headCount: 8, headCountKv: 2, keyLength: 512, valueLength: 512, keyLengthSwa: 256, valueLengthSwa: 256, slidingWindow: 512, sharedKvLayers: 18, parameterCount: 7518069290 },
    // On ≤ 8 GB the vision/audio projector costs ~1 GB of RAM the Mac does not have: recommend a text-only copy.
    textOnly: { supported: true, recommendedOnLowRam: true },
    lowRamAdvice: {
      suggested: `${NEMOTRON_HF_REPO}:UD-IQ3_XXS`,
      largestRealistic: `${NEMOTRON_HF_REPO}:UD-Q3_K_XL`,
      note: 'On an 8 GB Mac use a text-only copy. UD-Q3_K_XL (4.0 GB) is the largest that is realistic: it runs, but leaves almost nothing for macOS and an app window (measured ≈4.3 GB resident at 2–4K context on a 7 GB Mac that was already swapping). UD-IQ3_XXS or UD-Q2_K_XL (≈3.5 GB) are the comfortable choice, with a small quality trade-off.',
    },
    variants: [
      { model: 'nemotron-3.5-bolt:e4b', label: 'Official (vision + audio + draft model)', approxSizeBytes: 6180446208 + 991551808 + 736812096, modelLayerBytes: 6180446208, projectorBytes: 991551808, draftBytes: 736812096, textOnlyBytes: 6180446208, minRamBytes: 16 * GiB, note: '7.9 GB download: the model plus a vision/audio projector and a speculative-decoding draft model. Not usable on 8 GB.' },
      hfNemo('UD-Q4_K_XL', 4826, 'UD-Q4_K_XL (GGUF)'),
      hfNemo('UD-Q3_K_XL', 4024, 'UD-Q3_K_XL (GGUF)', { lowRam: 'largest_realistic', note: 'Largest that is realistic on 8 GB, as a text-only copy (4.0 GB): runs, but leaves almost nothing for macOS and other apps.' }),
      hfNemo('UD-Q2_K_XL', 3569, 'UD-Q2_K_XL (GGUF)', { lowRam: 'comfortable', note: 'Comfortable on 8 GB as a text-only copy (≈3.5 GB); some quality loss versus UD-Q3_K_XL.' }),
      hfNemo('UD-IQ3_XXS', 3532, 'UD-IQ3_XXS (GGUF)', { lowRam: 'comfortable', note: 'Comfortable on 8 GB as a text-only copy (≈3.5 GB); some quality loss versus UD-Q3_K_XL.' }),
    ],
    // Tags that look plausible but must never be suggested.
    avoid: [
      { model: 'nemotron-3.5-bolt:latest', reason: 'A different, 22 GB model — not the E4B.' },
      { model: `${NEMOTRON_HF_REPO}:latest`, reason: 'The 14 GB BF16 file.' },
      { model: `${NEMOTRON_HF_REPO}:Q4_K_M`, reason: 'This tag does not exist in the repository (use UD-Q4_K_XL).' },
      { model: `${NEMOTRON_HF_REPO}:Q3_K_M`, reason: 'This tag does not exist in the repository (use UD-Q3_K_XL).' },
      { model: `${NEMOTRON_HF_REPO}:Q3_K_XL`, reason: 'Alias without "UD-": the manifest exists but the download fails ("file does not exist"). Use UD-Q3_K_XL.' },
      { model: `${NEMOTRON_HF_REPO}:Q4_K_XL`, reason: 'Alias without "UD-" — only the UD-* tags download. Use UD-Q4_K_XL.' },
      { model: `${NEMOTRON_HF_REPO}:Q2_K_XL`, reason: 'Alias without "UD-" — only the UD-* tags download. Use UD-Q2_K_XL.' },
    ],
  },
  {
    id: 'qwen3-4b', name: 'Qwen3 4B', description: 'Small hybrid reasoning model with tool use.', tags: ['thinking', 'tools'], contextLength: 40960, family: 'qwen3',
    archHint: { blockCount: 36, embeddingLength: 2560, headCount: 32, headCountKv: 8, keyLength: 128, valueLength: 128 },
    variants: [{ model: 'qwen3:4b', label: 'Q4_K_M', approxSizeBytes: 2.5e9 }],
  },
  {
    id: 'gemma3-4b', name: 'Gemma 3 4B', description: 'Multimodal (vision) model from Google.', tags: ['vision'], contextLength: 131072, family: 'gemma3',
    archHint: { blockCount: 34, embeddingLength: 2560, headCount: 8, headCountKv: 4, keyLength: 256, valueLength: 256, slidingWindow: 1024 },
    variants: [{ model: 'gemma3:4b', label: 'Q4_K_M', approxSizeBytes: 3.3e9 }],
  },
  {
    id: 'llama3.2-3b', name: 'Llama 3.2 3B', description: 'Compact general model, good on 8 GB machines.', tags: ['tools', 'fast'], contextLength: 131072, family: 'llama',
    archHint: { blockCount: 28, embeddingLength: 3072, headCount: 24, headCountKv: 8, keyLength: 128, valueLength: 128 },
    variants: [{ model: 'llama3.2:3b', label: 'Q4_K_M', approxSizeBytes: 2.0e9 }],
  },
  {
    id: 'qwen3-8b', name: 'Qwen3 8B', description: 'Stronger reasoning; needs 16 GB+.', tags: ['thinking', 'tools'], contextLength: 40960, family: 'qwen3',
    archHint: { blockCount: 36, embeddingLength: 4096, headCount: 32, headCountKv: 8, keyLength: 128, valueLength: 128 },
    variants: [{ model: 'qwen3:8b', label: 'Q4_K_M', approxSizeBytes: 5.2e9 }],
  },
];

/** Name for a text-only copy of `model` (valid Ollama name, lower case): "<repo>-text:<tag>". */
export function textOnlyName(model) {
  const [pathPart, tag = 'latest'] = String(model).split(/:(?=[^/:]*$)/);
  const base = pathPart.split('/').pop().replace(/-gguf$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return `${base}-text:${tag.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`;
}

/** The catalog variant a (possibly text-only copy) model name refers to, with its recommendation. */
export function catalogVariantFor(model) {
  const m = String(model || '');
  for (const rec of RECOMMENDED_MODELS) {
    for (const v of rec.variants) {
      if (v.model === m) return { rec, variant: v, textOnly: false };
      if (textOnlyName(v.model) === m) return { rec, variant: v, textOnly: true };
    }
  }
  return null;
}

export function avoidedTag(model) {
  for (const rec of RECOMMENDED_MODELS) for (const a of rec.avoid || []) if (a.model === model) return a;
  return null;
}

/**
 * The next smaller recommended file for `model` (same family first; on ≤ 8 GB the "comfortable" variant), or a
 * smaller recommended model of another family. Sizes are those of a text-only copy where one is recommended.
 * @returns {null | { model, approxSizeBytes, label, textOnly }}
 */
export function smallerVariantFor(model, { totalMem = 0, sizeBytes = null } = {}) {
  const hit = catalogVariantFor(model);
  const lowRam = totalMem > 0 && totalMem <= 8.5 * GiB;
  const sizeOf = (rec, v) => (lowRam && rec.textOnly?.recommendedOnLowRam && v.textOnlyBytes ? v.textOnlyBytes : v.approxSizeBytes);
  if (!hit && !sizeBytes) return null;
  const current = hit ? sizeOf(hit.rec, hit.variant) : sizeBytes;
  const pick = (rec, v) => ({ model: v.model, approxSizeBytes: sizeOf(rec, v), label: v.label, textOnly: !!(lowRam && rec.textOnly?.recommendedOnLowRam) });
  if (hit) {
    const smaller = hit.rec.variants.filter((v) => sizeOf(hit.rec, v) < current * 0.97);
    if (smaller.length) {
      const comfy = lowRam && smaller.find((v) => v.lowRam === 'comfortable');
      return pick(hit.rec, comfy || smaller[0]);
    }
  }
  const others = RECOMMENDED_MODELS.filter((r) => r !== hit?.rec).flatMap((r) => r.variants.map((v) => ({ r, v }))).filter(({ r, v }) => sizeOf(r, v) < current * 0.97).sort((a, b) => sizeOf(b.r, b.v) - sizeOf(a.r, a.v));
  return others.length ? pick(others[0].r, others[0].v) : null;
}

export const RECOMMENDED_EMBEDDING = [
  { id: 'embeddinggemma', name: 'EmbeddingGemma 300M', model: 'embeddinggemma', approxSizeBytes: 0.62e9, description: 'Best quality small embedding model; improves memory and document search.' },
  { id: 'nomic-embed-text', name: 'Nomic Embed Text', model: 'nomic-embed-text', approxSizeBytes: 0.27e9, description: 'Very small embedding model; good choice on 8 GB machines.' },
];
