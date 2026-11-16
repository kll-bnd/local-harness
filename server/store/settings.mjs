// Global settings: defaults, validation, persistence (settings.json).
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';
import { deepMerge, clone } from '../lib/util.mjs';
import { badRequest } from '../lib/errors.mjs';
import { obj, num, bool, str, oneOf, any, arrayOf, modelRef, custom, validatePatch, sanitizeValue } from './schema.mjs';
import { log } from '../lib/log.mjs';

export function defaultOllamaUrl() {
  const h = process.env.OLLAMA_HOST;
  if (!h) return 'http://127.0.0.1:11434';
  if (/^https?:\/\//.test(h)) return h.replace(/\/+$/, '');
  const hostPort = h.includes(':') ? h : `${h}:11434`;
  return `http://${hostPort.replace(/^0\.0\.0\.0/, '127.0.0.1')}`;
}

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  defaultModel: null,
  defaultPresetId: 'default',
  systemPrompt: null,
  params: { temperature: null, top_p: null, top_k: null, min_p: null, repeat_penalty: null, seed: null, num_predict: null, stop: null },
  keepAlive: '30m',
  context: { mode: 'auto', maxAuto: null, lowRamCap: 16384, kvCacheType: 'auto', memoryFraction: null, replyReserve: 'auto', useMeasurements: true },
  reasoning: { think: 'auto' },
  compaction: { enabled: true, threshold: 0.75, target: 0.45, keepRecentFraction: 0.25, minKeepMessages: 2, maxSummaryTokens: 'auto', model: null },
  memory: { enabled: true, autoExtract: true, model: null, topK: 6, maxTokens: 'auto', minSimilarity: 0.5, placement: 'turn', extractDelayMs: 4000 },
  recall: { enabled: true, autoInject: true, topK: 3, maxTokens: 'auto', minSimilarity: 0.6 },
  embeddings: { model: 'auto' },
  documents: { topK: 6, maxTokens: 'auto', inlineMaxTokens: 'auto', chunkTokens: 400, maxHistoryImages: 4 },
  tools: {
    enabled: true,
    maxIterations: 6,
    builtin: { remember: true, recall: true, get_current_time: true, calculate: true, fetch_url: false, generate_image: true },
    fetchUrl: { allowPrivateNetwork: false, maxChars: 20000 },
  },
  titles: { auto: true, model: null },
  providers: {
    autodetect: true,
    builtin: {
      ollama: { enabled: true, baseUrl: null },
      llamacpp: { enabled: true, baseUrl: 'http://127.0.0.1:8080' },
      lmstudio: { enabled: true, baseUrl: 'http://127.0.0.1:1234' },
    },
    custom: [],
  },
  ollama: { autoStart: true, stopOnExit: true, binaryPath: null, flashAttention: true, kvCacheType: 'q8_0', numParallel: 1, maxLoadedModels: 'auto', extraEnv: {} },
  image: {
    enabled: true,
    providerId: null,
    model: null,
    defaults: { width: null, height: null, steps: null, cfg: null, sampler: null, negativePrompt: '', count: 1 },
    unloadChatModel: 'auto',
    reloadAfter: 'lazy',
    feedbackToModel: false,
    comfyWorkflow: null,
    timeoutSec: 600,
    autodetect: true,
    builtin: {
      a1111: { enabled: true, baseUrl: 'http://127.0.0.1:7860' },
      comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' },
    },
    custom: [],
  },
  security: { allowedOrigins: [] },
  ui: { theme: 'system' },
});

const url = () => custom((v, p) => {
  if (typeof v !== 'string') return `${p} must be a URL string`;
  try { const u = new URL(v); if (!/^https?:$/.test(u.protocol)) return `${p} must be http(s)`; } catch { return `${p} must be a valid URL`; }
  return null;
});
// Number of seconds (negative = forever), a numeric string (sent to Ollama as a number), or a Go duration ("30m", "1h30m").
const keepAlive = custom((v, p) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && (/^\s*-?\d+(\.\d+)?\s*$/.test(v) || /^-?(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(v))) ? null : `${p} must be a duration like "30m", "-1" or a number of seconds`, { nullable: true });
const thinkV = oneOf(['auto', 'on', 'off', 'low', 'medium', 'high']);
export const PARAMS_SCHEMA = obj({
  temperature: num(0, 5), top_p: num(0, 1), top_k: num(0, 1000, { int: true }), min_p: num(0, 1), repeat_penalty: num(0, 5),
  seed: num(-1, 2 ** 53, { int: true }), num_predict: num(-2, 1e6, { int: true }), stop: arrayOf(str({ nullable: false, max: 100 }), { nullable: true, max: 16 }),
  presence_penalty: num(-2, 2), frequency_penalty: num(-2, 2),
});
const providerEntry = obj({ id: str({ nullable: false, max: 64 }), name: str({ nullable: false, max: 100 }), kind: oneOf(['ollama', 'openai']), baseUrl: url(), apiKey: str({ max: 500 }), enabled: bool() }, { open: false, required: ['id', 'kind', 'baseUrl'] });
const imageProviderEntry = obj({ id: str({ nullable: false, max: 64 }), name: str({ nullable: false, max: 100 }), kind: oneOf(['a1111', 'comfyui', 'openai']), baseUrl: url(), apiKey: str({ max: 500 }), enabled: bool(), workflow: any() }, { required: ['id', 'kind', 'baseUrl'] });
const toolFlags = obj({ remember: bool(), recall: bool(), get_current_time: bool(), calculate: bool(), fetch_url: bool(), generate_image: bool() });
const modelOrNull = modelRef();
const embedModel = custom((v, p) => (v === 'auto' || v === 'off' || (v && typeof v === 'object' && typeof v.model === 'string') ? null : `${p} must be 'auto', 'off' or {providerId, model}`), { nullable: true });

export const SETTINGS_SCHEMA = obj({
  version: num(1, 1),
  defaultModel: modelOrNull,
  defaultPresetId: str({ max: 64 }),
  systemPrompt: str({ max: 50000 }),
  params: PARAMS_SCHEMA,
  keepAlive,
  context: obj({
    mode: custom((v, p) => (v === 'auto' || v === 'max' || (Number.isInteger(v) && v >= 512 && v <= 2 ** 21) ? null : `${p} must be 'auto', 'max' or an integer token count >= 512`)),
    maxAuto: num(512, 2 ** 21, { int: true }),
    lowRamCap: num(2048, 2 ** 21, { int: true }),
    useMeasurements: bool(),
    kvCacheType: oneOf(['auto', 'f16', 'q8_0', 'q4_0']),
    memoryFraction: num(0.1, 1),
    replyReserve: num(64, 65536, { int: true, auto: true }),
  }),
  reasoning: obj({ think: thinkV }),
  compaction: obj({
    enabled: bool(), threshold: num(0.3, 0.98, { nullable: false }), target: num(0.1, 0.9, { nullable: false }), keepRecentFraction: num(0.05, 0.8, { nullable: false }),
    minKeepMessages: num(1, 50, { int: true, nullable: false }), maxSummaryTokens: num(64, 16000, { int: true, auto: true }), model: modelOrNull,
  }),
  memory: obj({
    enabled: bool(), autoExtract: bool(), model: modelOrNull, topK: num(0, 50, { int: true, nullable: false }), maxTokens: num(0, 20000, { int: true, auto: true }),
    minSimilarity: num(0, 1, { nullable: false }), placement: oneOf(['turn', 'system']), extractDelayMs: num(0, 600000, { int: true, nullable: false }),
  }),
  recall: obj({ enabled: bool(), autoInject: bool(), topK: num(0, 20, { int: true, nullable: false }), maxTokens: num(0, 20000, { int: true, auto: true }), minSimilarity: num(0, 1, { nullable: false }) }),
  embeddings: obj({ model: embedModel }),
  documents: obj({
    topK: num(1, 50, { int: true, nullable: false }), maxTokens: num(64, 100000, { int: true, auto: true }), inlineMaxTokens: num(0, 200000, { int: true, auto: true }),
    chunkTokens: num(100, 4000, { int: true, nullable: false }), maxHistoryImages: num(0, 50, { int: true, nullable: false }),
  }),
  tools: obj({ enabled: bool(), maxIterations: num(1, 25, { int: true, nullable: false }), builtin: toolFlags, fetchUrl: obj({ allowPrivateNetwork: bool(), maxChars: num(500, 200000, { int: true, nullable: false }) }) }),
  titles: obj({ auto: bool(), model: modelOrNull }),
  providers: obj({
    autodetect: bool(),
    builtin: obj({
      ollama: obj({ enabled: bool(), baseUrl: url() }),
      llamacpp: obj({ enabled: bool(), baseUrl: url() }),
      lmstudio: obj({ enabled: bool(), baseUrl: url() }),
    }),
    custom: arrayOf(providerEntry, { max: 50 }),
  }),
  ollama: obj({
    autoStart: bool(), stopOnExit: bool(), binaryPath: str({ max: 1000 }), flashAttention: bool(), kvCacheType: oneOf(['f16', 'q8_0', 'q4_0']),
    numParallel: num(1, 16, { int: true, nullable: false }), maxLoadedModels: custom((v, p) => (v === 'auto' || (Number.isInteger(v) && v >= 1 && v <= 16) ? null : `${p} must be 'auto' or 1-16`)),
    extraEnv: custom((v, p) => (v && typeof v === 'object' && Object.keys(v).every((k) => /^OLLAMA_[A-Z_]+$/.test(k)) ? null : `${p} keys must look like OLLAMA_*`)),
  }),
  image: obj({
    enabled: bool(), providerId: str({ max: 64 }), model: str({ max: 500 }),
    defaults: obj({ width: num(64, 4096, { int: true }), height: num(64, 4096, { int: true }), steps: num(1, 200, { int: true }), cfg: num(0, 50), sampler: str({ max: 100 }), negativePrompt: str({ max: 5000 }), count: num(1, 8, { int: true, nullable: false }) }),
    unloadChatModel: oneOf(['auto', 'always', 'never']), reloadAfter: oneOf(['lazy', 'eager']), feedbackToModel: bool(),
    comfyWorkflow: custom((v, p) => (v && typeof v === 'object' && !Array.isArray(v) ? null : `${p} must be a ComfyUI API-format workflow object`)),
    timeoutSec: num(10, 7200, { int: true, nullable: false }), autodetect: bool(),
    builtin: obj({ a1111: obj({ enabled: bool(), baseUrl: url() }), comfyui: obj({ enabled: bool(), baseUrl: url() }) }),
    custom: arrayOf(imageProviderEntry, { max: 50 }),
  }),
  security: obj({
    // Extra browser origins allowed to call the API (e.g. a UI dev server); the app's own origin is always allowed.
    allowedOrigins: arrayOf(custom((v, p) => {
      if (typeof v !== 'string') return `${p} must be an origin string`;
      try { const u = new URL(v); return (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'app:') && u.origin === v.replace(/\/+$/, '') ? null : `${p} must be an origin like http://localhost:5173`; } catch { return `${p} must be an origin like http://localhost:5173`; }
    }, { nullable: false }), { max: 20 }),
  }),
  ui: custom((v, p) => (v && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(v).length < 65536 ? null : `${p} must be an object (< 64KB)`)),
});

/** Keys a chat may override (subset of global settings). */
export const CHAT_SETTINGS_SCHEMA = obj({
  model: modelOrNull,
  presetId: str({ max: 64 }),
  systemPrompt: str({ max: 50000 }),
  params: PARAMS_SCHEMA,
  keepAlive,
  context: obj({ mode: SETTINGS_SCHEMA.shape.context.shape.mode }),
  reasoning: obj({ think: thinkV }),
  tools: obj({ enabled: bool(), builtin: toolFlags }),
  compaction: obj({ enabled: bool() }),
  memory: obj({ enabled: bool() }),
  recall: obj({ enabled: bool() }),
});

export class SettingsStore {
  constructor(dataDir, bus) {
    this.file = path.join(dataDir, 'settings.json');
    this.bus = bus;
    this.value = clone(DEFAULT_SETTINGS);
  }

  async load() {
    const stored = await readJson(this.file, null);
    // Never trust the file blindly (older versions, hand edits, tampering): keep only valid branches.
    const { value, dropped } = sanitizeValue(SETTINGS_SCHEMA, stored ?? {});
    this.value = deepMerge(clone(DEFAULT_SETTINGS), value || {});
    if (stored && dropped.length) {
      log.warn(`settings.json: ignored invalid entries ${dropped.slice(0, 10).join(', ')}${dropped.length > 10 ? ' …' : ''}`);
      await writeJsonAtomic(this.file, this.value).catch(() => {});
    }
    return this;
  }

  get() { return this.value; }

  async patch(patch) {
    const err = validatePatch(SETTINGS_SCHEMA, patch);
    if (err) throw badRequest(err);
    this.value = deepMerge(this.value, patch);
    await writeJsonAtomic(this.file, this.value);
    this.bus?.publish('settings.updated', { settings: this.value });
    return this.value;
  }

  async replace(value) {
    this.value = deepMerge(clone(DEFAULT_SETTINGS), value || {});
    await writeJsonAtomic(this.file, this.value);
    this.bus?.publish('settings.updated', { settings: this.value });
    return this.value;
  }

  async reset() { return this.replace({}); }
}

export function validateChatSettings(patch) {
  const err = validatePatch(CHAT_SETTINGS_SCHEMA, patch);
  if (err) throw badRequest(err.replace('Unknown setting', 'Unknown chat setting'));
}
