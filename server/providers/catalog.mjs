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
    sampling: { temperature: 0.6, top_p: 0.95, top_k: 64 },
    swa: { globalEvery: 5, window: 512 },
    imageTokens: 280,
    notes: 'Gemma-4-E4B derivative tuned for multi-turn tool use. Sampling defaults are an assumption.',
  },
  { id: 'gemma4', match: /gemma-?4/i, family: 'gemma4', sampling: { temperature: 1.0, top_p: 0.95, top_k: 64 }, swa: { globalEvery: 5, window: 512 }, imageTokens: 280 },
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

/**
 * Curated recommended chat models. Sizes are approximate download/RAM sizes (unverified) used to
 * pre-compute a fit estimate for this machine; `variants` are ordered largest → smallest.
 */
export const RECOMMENDED_MODELS = [
  {
    id: 'nemotron-3.5-bolt-e4b',
    name: 'NVIDIA Nemotron 3.5 Bolt E4B',
    description: 'Fast ~4B-effective-parameter model tuned for multi-turn tool use. Real context 64K.',
    tags: ['recommended', 'tools', 'thinking', 'fast'],
    contextLength: 65536,
    family: 'gemma4',
    // Architecture hints (assumed Gemma-3n-E4B-like) used only for the pre-download fit estimate.
    archHint: { blockCount: 35, embeddingLength: 2048, headCount: 8, headCountKv: 2, keyLength: 256, valueLength: 256 },
    variants: [
      { model: 'nemotron-3.5-bolt:e4b', label: 'Default quant', approxSizeBytes: 6.0 * GiB },
      { model: 'hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:Q4_K_M', label: 'Q4_K_M (GGUF)', approxSizeBytes: 4.6e9 },
      { model: 'hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:Q3_K_M', label: 'Q3_K_M (GGUF, low RAM)', approxSizeBytes: 3.9e9 },
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

export const RECOMMENDED_EMBEDDING = [
  { id: 'embeddinggemma', name: 'EmbeddingGemma 300M', model: 'embeddinggemma', approxSizeBytes: 0.62e9, description: 'Best quality small embedding model; improves memory and document search.' },
  { id: 'nomic-embed-text', name: 'Nomic Embed Text', model: 'nomic-embed-text', approxSizeBytes: 0.27e9, description: 'Very small embedding model; good choice on 8 GB machines.' },
];
