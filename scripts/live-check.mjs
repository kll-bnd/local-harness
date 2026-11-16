#!/usr/bin/env node
// Harness live conformance checker: run next to REAL backends (Ollama, llama.cpp / LM Studio / MLX, Draw Things /
// AUTOMATIC1111 / Forge, ComfyUI, OpenAI-style image servers) and report which assumptions the Harness code makes
// about their APIs hold and which do not. Zero npm dependencies, Node >= 20. See docs/LIVE_CHECK.md.
//
//   node scripts/live-check.mjs                      # auto-detect backends on their default ports, safe & quick
//   node scripts/live-check.mjs --allow-pull --allow-images --json out.json --markdown out.md
//   node scripts/live-check.mjs --help
//
// Two layers, reported separately:
//   [raw] probes talk to each backend directly and assert the exact request/response shapes the provider code uses;
//   [e2e] starts the real Harness server in-process (temp data dir) wired to the same backends and drives product flows.
// Exit code: 0 = no FAIL, 1 = at least one FAIL, 2 = no backend reachable at all.
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOOL_VERSION = '1.0';
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

// =============================================================================================== options
const OPTIONS = [
  ['ollama-url', 'str', 'Ollama base URL (default: OLLAMA_HOST or http://127.0.0.1:11434)'],
  ['llamacpp-url', 'str', 'llama.cpp llama-server / MLX (OpenAI-compatible) URL (default port 8080)'],
  ['lmstudio-url', 'str', 'LM Studio URL (default port 1234)'],
  ['openai-url', 'list', 'other OpenAI-compatible chat server(s) (vLLM, LocalAI, …); repeatable'],
  ['openai-api-key', 'str', 'API key for OpenAI-compatible servers (or env HARNESS_LIVECHECK_API_KEY); never printed'],
  ['a1111-url', 'str', 'Draw Things / AUTOMATIC1111 / Forge API URL (default port 7860)'],
  ['comfyui-url', 'str', 'ComfyUI URL (default port 8188)'],
  ['openai-images-url', 'str', 'OpenAI-style image server (/v1/images/generations); no default port'],
  ['no-detect', 'bool', 'do not probe default ports; only use the URLs given above'],
  ['model', 'str', 'Ollama chat model (default: smallest installed model with tools, else smallest chat model)'],
  ['think-model', 'str', 'Ollama model with the "thinking" capability'],
  ['tool-model', 'str', 'Ollama model with the "tools" capability'],
  ['plain-model', 'str', 'Ollama chat model WITHOUT tools/thinking (to capture the "unsupported" error texts)'],
  ['embed-model', 'str', 'Ollama embedding model'],
  ['openai-model', 'str', 'model id for OpenAI-compatible chat checks'],
  ['openai-think-model', 'str', 'OpenAI-compatible model that emits reasoning'],
  ['openai-notools-model', 'str', 'OpenAI-compatible model/server that rejects tools'],
  ['only', 'list', 'run only these groups: env,ollama,openai,a1111,comfyui,openai-images,e2e'],
  ['skip', 'list', 'skip these groups'],
  ['allow-pull', 'bool', 'allow pulling (and later deleting) --pull-model; never deletes a model it did not pull'],
  ['pull-model', 'str', 'tiny model used for pull/delete checks (default all-minilm:22m, ~46 MB)'],
  ['allow-images', 'bool', 'allow generating images (tiny sizes, 1-2 steps) on the image backends'],
  ['keep-alive', 'str', 'keep_alive used by the probes (default "5m")'],
  ['timeout-scale', 'num', 'multiply every timeout (slow machines: 2 or 3)'],
  ['simulate-ram-gb', 'num', 'make the in-process Harness believe the machine has this much RAM'],
  ['data-dir', 'str', 'parent directory for the temporary Harness data dir (default: OS temp dir)'],
  ['keep-data', 'bool', 'keep the temporary Harness data dir'],
  ['no-unload', 'bool', 'leave models loaded at the end (default: unload what the run loaded)'],
  ['json', 'str', 'write the full machine-readable result (incl. raw response samples) to this file'],
  ['markdown', 'str', 'write a Markdown report (for an issue) to this file'],
  ['verbose', 'bool', 'print assumption + source location for every check, not only failures'],
  ['quiet', 'bool', 'print only the summary'],
  ['no-color', 'bool', 'no ANSI colours'],
  ['list', 'bool', 'list all check ids and exit'],
  ['help', 'bool', 'show this help'],
];
export const GROUPS = ['env', 'ollama', 'openai', 'a1111', 'comfyui', 'openai-images', 'e2e'];

export function parseOptions(argv) {
  const spec = new Map(OPTIONS.map(([k, t]) => [k, t]));
  const o = {};
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) { errors.push(`unexpected argument: ${a}`); continue; }
    a = a.slice(2);
    let v;
    const eq = a.indexOf('=');
    if (eq >= 0) { v = a.slice(eq + 1); a = a.slice(0, eq); }
    const t = spec.get(a);
    if (!t) { errors.push(`unknown option --${a}`); continue; }
    if (t === 'bool') { o[a] = v === undefined ? true : !/^(0|false|no)$/i.test(v); continue; }
    if (v === undefined) {
      if (i + 1 >= argv.length) { errors.push(`--${a} needs a value`); continue; }
      v = argv[++i];
    }
    if (t === 'num') {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) errors.push(`--${a} must be a positive number`);
      else o[a] = n;
    } else if (t === 'list') {
      o[a] = [...(o[a] || []), ...String(v).split(',').map((s) => s.trim()).filter(Boolean)];
    } else o[a] = v;
  }
  for (const g of [...(o.only || []), ...(o.skip || [])]) if (!GROUPS.includes(g)) errors.push(`unknown group "${g}" (groups: ${GROUPS.join(', ')})`);
  return {
    errors,
    ollamaUrl: o['ollama-url'] || null,
    llamacppUrl: o['llamacpp-url'] || null,
    lmstudioUrl: o['lmstudio-url'] || null,
    openaiUrls: o['openai-url'] || [],
    apiKey: o['openai-api-key'] || process.env.HARNESS_LIVECHECK_API_KEY || '',
    a1111Url: o['a1111-url'] || null,
    comfyuiUrl: o['comfyui-url'] || null,
    openaiImagesUrl: o['openai-images-url'] || null,
    detect: !o['no-detect'],
    model: o.model || null,
    thinkModel: o['think-model'] || null,
    toolModel: o['tool-model'] || null,
    plainModel: o['plain-model'] || null,
    embedModel: o['embed-model'] || null,
    openaiModel: o['openai-model'] || null,
    openaiThinkModel: o['openai-think-model'] || null,
    openaiNoToolsModel: o['openai-notools-model'] || null,
    only: o.only || null,
    skip: o.skip || [],
    allowPull: !!o['allow-pull'],
    pullModel: o['pull-model'] || 'all-minilm:22m',
    allowImages: !!o['allow-images'],
    keepAlive: o['keep-alive'] || '5m',
    timeoutScale: o['timeout-scale'] || 1,
    simulateRamGb: o['simulate-ram-gb'] || null,
    dataDir: o['data-dir'] || null,
    keepData: !!o['keep-data'],
    unloadAtEnd: !o['no-unload'],
    json: o.json || null,
    markdown: o.markdown || null,
    verbose: !!o.verbose,
    quiet: !!o.quiet,
    color: !o['no-color'] && !process.env.NO_COLOR && !!process.stdout.isTTY,
    list: !!o.list,
    help: !!o.help,
  };
}

function helpText() {
  const w = Math.max(...OPTIONS.map(([k, t]) => k.length + (t === 'bool' ? 0 : 6)));
  const lines = OPTIONS.map(([k, t, d]) => `  --${(k + (t === 'bool' ? '' : t === 'num' ? ' N' : ' VAL')).padEnd(w + 2)} ${d}`);
  return `Harness live conformance check (v${TOOL_VERSION})

Usage: node scripts/live-check.mjs [options]

Talks to the real local backends and checks every assumption Harness makes about their APIs.
Default run is safe: read-only probes plus tiny chats (no pulls, no deletes, no image generation).

Options:
${lines.join('\n')}

Exit code: 0 no FAIL, 1 at least one FAIL, 2 no backend reachable. Full docs: docs/LIVE_CHECK.md`;
}

// =============================================================================================== small utils
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => performance.now();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const fmtBytes = (b) => (b == null || !Number.isFinite(b) ? '?' : b >= GiB ? `${(b / GiB).toFixed(2)} GB` : b >= MiB ? `${Math.round(b / MiB)} MB` : `${Math.round(b / 1024)} KB`);
const fmtMs = (ms) => (ms == null ? '?' : ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const norm = (n) => (n && !String(n).includes(':') ? `${n}:latest` : n);
const sameModel = (a, b) => !!a && !!b && (a === b || norm(a) === norm(b));
const errText = (e) => (e?.cause?.code ? `${e.message} (${e.cause.code})` : e?.message || String(e));

const HOME = os.homedir();
/** Redact home-directory paths, user names in paths and anything that looks like a credential. */
export function redact(s) {
  if (typeof s !== 'string' || !s) return s;
  let t = s;
  if (HOME && HOME.length > 2) t = t.split(HOME).join('~');
  t = t.replace(/\/Users\/(?!<user>)[^/\s"'\\]+/g, '/Users/<user>').replace(/\/home\/(?!<user>)[^/\s"'\\]+/g, '/home/<user>');
  t = t.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 <redacted>');
  t = t.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, '<redacted-key>').replace(/\bhf_[A-Za-z0-9]{16,}/g, '<redacted-token>').replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '<redacted-token>');
  t = t.replace(/((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|password|passwd|secret|authorization)"?\s*[:=]\s*"?)([^"\s,}&]{4,})/gi, '$1<redacted>');
  return t;
}
const SECRET_KEYS = /^(api[_-]?key|apikey|authorization|password|secret|token|access[_-]?token)$/i;
export function redactDeep(v, depth = 0) {
  if (depth > 40) return v;
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  if (isObj(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) && typeof x === 'string' && x ? '<redacted>' : redactDeep(x, depth + 1);
    return out;
  }
  return v;
}
/** Truncated, redacted, single-line excerpt of a response for the report. */
export function excerpt(v, max = 500) {
  let s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  if (s === undefined) s = String(v);
  s = redact(s).replace(/\s*\n\s*/g, ' ⏎ ');
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
}
/** Shrink a captured sample: long arrays/strings/vectors are cut so the JSON report stays readable. */
function shrink(v, depth = 0) {
  if (depth > 12) return '…';
  if (typeof v === 'string') return v.length > 1500 ? `${v.slice(0, 1500)}…(+${v.length - 1500} chars)` : v;
  if (Array.isArray(v)) {
    if (v.length > 8 && v.every((x) => typeof x === 'number')) return [...v.slice(0, 8), `…(${v.length} numbers)`];
    const lim = 25;
    const head = v.slice(0, lim).map((x) => shrink(x, depth + 1));
    return v.length > lim ? [...head, `…(+${v.length - lim} more)`] : head;
  }
  if (isObj(v)) {
    const out = {};
    const keys = Object.keys(v);
    for (const k of keys.slice(0, 150)) out[k] = shrink(v[k], depth + 1);
    if (keys.length > 150) out['…'] = `+${keys.length - 150} more keys`;
    return out;
  }
  return v;
}
function base64Image(s) {
  const b = Buffer.from(String(s).replace(/^data:image\/\w+;base64,/, ''), 'base64');
  return b;
}

// =============================================================================================== Harness sources
let H = null; // Harness modules (loaded once)
async function loadHarness() {
  if (H) return H;
  const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
  const mods = await Promise.all([
    imp('server/providers/ollama.mjs'), imp('server/providers/openai.mjs'), imp('server/providers/model-info.mjs'),
    imp('server/context/sizing.mjs'), imp('server/context/tokens.mjs'), imp('server/providers/catalog.mjs'),
    imp('server/store/settings.mjs'), imp('server/image/comfyui.mjs'), imp('server/image/defaults.mjs'),
    imp('server/chat/prompts.mjs'), imp('server/chat/llm.mjs'), imp('server/providers/registry.mjs'),
    imp('server/docs/extract.mjs'), imp('server/tools/builtin.mjs'), imp('server/image/http.mjs'),
  ]);
  H = Object.assign({}, ...mods);
  H.normalizeKeepAlive ||= (v) => v; // older trees did not normalize
  return H;
}

/**
 * Source anchors: a file plus a code substring (or a list: find each after the previous). The line number is
 * resolved at run time so references stay right while server/ keeps changing; an anchor that no longer matches
 * falls back to the function name.
 */
const SRC = {
  ollamaRequest: ['server/providers/ollama.mjs', 'async request(path,', 'OllamaProvider.request'],
  ollamaStatus: ['server/providers/ollama.mjs', "'/api/version'", 'OllamaProvider.status'],
  ollamaList: ['server/providers/ollama.mjs', "'/api/tags'", 'OllamaProvider.listModels'],
  ollamaShow: ['server/providers/ollama.mjs', "'/api/show'", 'OllamaProvider.show'],
  normShow: ['server/providers/model-info.mjs', 'export function normalizeOllamaShow', 'normalizeOllamaShow'],
  normArch: ['server/providers/model-info.mjs', "g('block_count')", 'normalizeOllamaShow (arch fields)'],
  normCtx: ['server/providers/model-info.mjs', "g('context_length')", 'normalizeOllamaShow (context_length)'],
  normCaps: ['server/providers/model-info.mjs', 'Array.isArray(show.capabilities)', 'normalizeOllamaShow (capabilities)'],
  normDetails: ['server/providers/model-info.mjs', 'show.details?.parameter_size', 'normalizeOllamaShow (details)'],
  parseParams: ['server/providers/ollama.mjs', 'export function parseModelfileParameters', 'parseModelfileParameters'],
  kvModel: ['server/context/sizing.mjs', 'export function kvCacheModel', 'kvCacheModel'],
  kvPattern: ['server/context/sizing.mjs', 'Array.isArray(arch.slidingWindowPattern)', 'kvCacheModel (sliding-window pattern)'],
  kvHeads: ['server/context/sizing.mjs', 'function sumOrScalar', 'sumOrScalar (per-layer arrays)'],
  classify: ['server/providers/ollama.mjs', 'export function classifyOllamaError', 'classifyOllamaError'],
  classifyTools: ['server/providers/ollama.mjs', 'does not support tools', 'classifyOllamaError (tools_unsupported)'],
  classifyThink: ['server/providers/ollama.mjs', 'does not support thinking', 'classifyOllamaError (thinking_unsupported)'],
  classifyNotFound: ['server/providers/ollama.mjs', 'try pulling', 'classifyOllamaError (model_not_found)'],
  classifyNotChat: ['server/providers/ollama.mjs', 'does not support (chat', 'classifyOllamaError (not_chat_model)'],
  classifyOverflow: ['server/providers/ollama.mjs', "code = 'context_overflow'", 'classifyOllamaError (context_overflow)'],
  ollamaChat: ['server/providers/ollama.mjs', 'async *chat(', 'OllamaProvider.chat'],
  ollamaStreamErr: ['server/providers/ollama.mjs', 'if (obj.error) throw classifyOllamaError', 'OllamaProvider.chat (error line)'],
  ollamaDone: ['server/providers/ollama.mjs', 'obj.done_reason', 'OllamaProvider.chat (done)'],
  ollamaUsage: ['server/providers/ollama.mjs', 'obj.prompt_eval_count', 'OllamaProvider.chat (usage)'],
  ollamaNs: ['server/providers/ollama.mjs', 'const ns = ', 'ns() nanoseconds→ms'],
  ollamaThinking: ['server/providers/ollama.mjs', 'm.thinking', 'OllamaProvider.chat (thinking)'],
  ollamaToolCalls: ['server/providers/ollama.mjs', 'parseArgs(tc.function?.arguments)', 'OllamaProvider.chat (tool_calls)'],
  parseArgs: ['server/providers/ollama.mjs', 'export function parseArgs', 'parseArgs'],
  toOllamaMessage: ['server/providers/ollama.mjs', 'export function toOllamaMessage', 'toOllamaMessage'],
  ollamaKeepAlive: ['server/providers/ollama.mjs', ['async *chat(', 'body.keep_alive'], 'OllamaProvider.chat (keep_alive)'],
  normalizeKeepAlive: ['server/providers/ollama.mjs', 'export function normalizeKeepAlive', 'normalizeKeepAlive'],
  settingsKeepAlive: ['server/store/settings.mjs', 'const keepAlive = custom(', 'settings keepAlive validator'],
  defaultKeepAlive: ['server/store/settings.mjs', "keepAlive: '", 'DEFAULT_SETTINGS.keepAlive'],
  embedderKeepAlive: ['server/memory/embedder.mjs', 'keepAlive:', 'Embedder.embed (keep_alive)'],
  ollamaPs: ['server/providers/ollama.mjs', "'/api/ps'", 'OllamaProvider.ps'],
  psContext: ['server/providers/ollama.mjs', 'm.context_length', 'OllamaProvider.ps (context_length)'],
  psExpires: ['server/providers/ollama.mjs', 'm.expires_at', 'OllamaProvider.ps (expires_at)'],
  measure: ['server/context/measurements.mjs', 'async measure(provider, model', 'MeasurementStore.measure'],
  measureReported: ['server/context/measurements.mjs', 'entry.contextLength', 'MeasurementStore.measure (reported context)'],
  llmLoadedCtx: ['server/chat/llm.mjs', 'e?.contextLength', 'LLM.resolveFor (loaded context after restart)'],
  fit: ['server/context/sizing.mjs', 'export function fitMeasurements', 'fitMeasurements'],
  fitClamp: ['server/context/sizing.mjs', 'perToken * 0.25', 'fitMeasurements (slope clamp ¼–4×)'],
  cpuSplit: ['server/context/sizing.mjs', 'export function isCpuSplit', 'isCpuSplit'],
  kvType: ['server/providers/registry.mjs', 'OLLAMA_KV_CACHE_TYPE', 'ProviderRegistry.kvCacheType'],
  buildOptions: ['server/chat/engine.mjs', 'o.num_ctx = numCtx', 'buildOptions (num_ctx)'],
  unload: ['server/providers/ollama.mjs', 'async unload(model)', 'OllamaProvider.unload'],
  unloadEmbed: ['server/providers/ollama.mjs', "e.code === 'not_chat_model'", 'OllamaProvider.unload (embedding fallback)'],
  load: ['server/providers/ollama.mjs', 'async load(model', 'OllamaProvider.load'],
  imageUnload: ['server/image/service.mjs', 'ollama.unload(m.model)', 'ImageService._run (unload before generating)'],
  resolveThink: ['server/chat/engine.mjs', 'export function resolveThink', 'resolveThink'],
  retryThink: ['server/chat/engine.mjs', "'thinking_unsupported' && useThink", 'ChatEngine.streamOnce (retry without think)'],
  retryTools: ['server/chat/engine.mjs', "'tools_unsupported' && useTools", 'ChatEngine.streamOnce (retry without tools)'],
  llmThinkFalse: ['server/chat/llm.mjs', "includes('thinking') ? false", 'LLM.completeWith (think:false)'],
  llmFormat: ['server/chat/llm.mjs', 'format|schema|grammar', 'LLM.completeWith (format retry)'],
  extractor: ['server/memory/extractor.mjs', 'format: MEMORY_SCHEMA', 'extractMemories (format)'],
  parseJsonLoose: ['server/chat/llm.mjs', 'export function parseJsonLoose', 'parseJsonLoose'],
  toolsFor: ['server/chat/engine.mjs', 'async toolsFor(chat, t)', 'ChatEngine.toolsFor'],
  observe: ['server/context/tokens.mjs', 'observe(providerId, model', 'Calibrator.observe'],
  engineObserve: ['server/chat/engine.mjs', 'this.app.calibrator.observe(', 'ChatEngine.run (calibration)'],
  finalLength: ['server/chat/engine.mjs', "doneReason === 'length'", 'ChatEngine.run (finishReason length)'],
  ollamaEmbed: ['server/providers/ollama.mjs', "'/api/embed'", 'OllamaProvider.embed'],
  embedderBatch: ['server/memory/embedder.mjs', 'embedding count mismatch', 'Embedder.embed (count check)'],
  embedDims: ['server/providers/catalog.mjs', 'export const EMBEDDING_MODELS', 'EMBEDDING_MODELS'],
  ollamaPull: ['server/providers/ollama.mjs', "'/api/pull'", 'OllamaProvider.pull'],
  pullErr: ['server/providers/ollama.mjs', 'does not exist|manifest', 'OllamaProvider.pull (error classification)'],
  routePullPercent: ['server/routes/models.mjs', 'p.completed / p.total', 'POST /api/models/pull (percent)'],
  ollamaDelete: ['server/providers/ollama.mjs', "'/api/delete'", 'OllamaProvider.deleteModel'],
  engineStop: ['server/chat/engine.mjs', 'stop(chatId)', 'ChatEngine.stop (abort = close the connection)'],
  readNdjson: ['server/lib/streams.mjs', 'export async function* readNdjson', 'readNdjson'],
  readSse: ['server/lib/streams.mjs', 'export async function* readSse', 'readSse'],
  // OpenAI-compatible
  oaiStatus: ['server/providers/openai.mjs', 'async status()', 'OpenAICompatProvider.status'],
  oaiModels: ['server/providers/openai.mjs', 'async listModels()', 'OpenAICompatProvider.listModels'],
  oaiProps: ['server/providers/openai.mjs', 'default_generation_settings?.n_ctx', 'OpenAICompatProvider.serverInfo (/props)'],
  oaiLm: ['server/providers/openai.mjs', "'/api/v0/models'", 'OpenAICompatProvider.serverInfo (LM Studio)'],
  oaiNormalize: ['server/providers/model-info.mjs', 'export function normalizeOpenAIModel', 'normalizeOpenAIModel'],
  planServer: ['server/context/sizing.mjs', "providerKind !== 'ollama'", 'computeContextPlan (server-fixed context)'],
  oaiChat: ['server/providers/openai.mjs', 'include_usage: true', 'OpenAICompatProvider.chat'],
  oaiUsage: ['server/providers/openai.mjs', 'usage?.prompt_tokens', 'OpenAICompatProvider.chat (usage/timings)'],
  oaiReasoning: ['server/providers/openai.mjs', 'd.reasoning_content', 'OpenAICompatProvider.chat (reasoning)'],
  oaiToolDeltas: ['server/providers/openai.mjs', 'tc.index ?? calls.size', 'OpenAICompatProvider.chat (tool-call deltas)'],
  oaiFinish: ['server/providers/openai.mjs', "finish === 'length'", 'OpenAICompatProvider.chat (finish_reason)'],
  oaiKwargs: ['server/providers/openai.mjs', 'enable_thinking: false', 'OpenAICompatProvider.chat (chat_template_kwargs)'],
  toOpenAIMessage: ['server/providers/openai.mjs', 'export function toOpenAIMessage', 'toOpenAIMessage'],
  classifyOai: ['server/providers/openai.mjs', 'export function classifyOpenAIError', 'classifyOpenAIError'],
  oaiEmbed: ['server/providers/openai.mjs', "'/v1/embeddings'", 'OpenAICompatProvider.embed'],
  // A1111 / Draw Things
  a1Status: ['server/image/a1111.mjs', 'async status()', 'A1111Provider.status'],
  a1Models: ['server/image/a1111.mjs', "'/sdapi/v1/sd-models'", 'A1111Provider.listModels'],
  a1Current: ['server/image/a1111.mjs', 'm.title === current', 'A1111Provider.listModels (current flag)'],
  a1Body: ['server/image/a1111.mjs', 'guidance_scale: p.cfg', 'A1111Provider.generate (request body)'],
  a1Progress: ['server/image/a1111.mjs', '/sdapi/v1/progress', 'A1111Provider.generate (progress polling)'],
  a1Interrupt: ['server/image/a1111.mjs', "'/sdapi/v1/interrupt'", 'A1111Provider.interrupt'],
  a1Images: ['server/image/a1111.mjs', 'j.images || []', 'A1111Provider.generate (images)'],
  a1Info: ['server/image/a1111.mjs', "typeof j.info === 'string'", 'A1111Provider.generate (info)'],
  a1Grid: ['server/image/a1111.mjs', 'index_of_first_image', 'A1111Provider.generate (grid handling)'],
  a1Seeds: ['server/image/a1111.mjs', 'info?.all_seeds', 'A1111Provider.generate (seeds)'],
  a1Img2img: ['server/image/a1111.mjs', 'body.init_images', 'A1111Provider.generate (img2img)'],
  familyDefault: ['server/image/defaults.mjs', 'export const DEFAULT_FAMILY', 'DEFAULT_FAMILY'],
  imageFamilies: ['server/image/defaults.mjs', 'export const IMAGE_FAMILIES', 'IMAGE_FAMILIES (comfy sampler/scheduler)'],
  // ComfyUI
  cStatus: ['server/image/comfyui.mjs', "'/system_stats'", 'ComfyUIProvider.status'],
  cModels: ['server/image/comfyui.mjs', "'/object_info/CheckpointLoaderSimple'", 'ComfyUIProvider.listModels'],
  cCombo: ['server/image/comfyui.mjs', 'function comboOptions', 'comboOptions'],
  cWorkflow: ['server/image/comfyui.mjs', 'export const DEFAULT_TXT2IMG_WORKFLOW', 'DEFAULT_TXT2IMG_WORKFLOW'],
  cWorkflowI2I: ['server/image/comfyui.mjs', 'export const DEFAULT_IMG2IMG_WORKFLOW', 'DEFAULT_IMG2IMG_WORKFLOW'],
  cPrompt: ['server/image/comfyui.mjs', "'/prompt'", 'ComfyUIProvider.generate (POST /prompt)'],
  cNodeErrors: ['server/image/comfyui.mjs', 'q.node_errors', 'ComfyUIProvider.generate (node_errors)'],
  imgHttpErr: ['server/image/http.mjs', 'j.error?.message', 'imageRequest (error message)'],
  cHistory: ['server/image/comfyui.mjs', '/history/', 'ComfyUIProvider.generate (history polling)'],
  cHistoryErr: ['server/image/comfyui.mjs', "status_str === 'error'", 'ComfyUIProvider.generate (execution error)'],
  cView: ['server/image/comfyui.mjs', '/view?', 'ComfyUIProvider.generate (/view)'],
  cWs: ['server/image/comfyui.mjs', "m.type === 'progress'", 'ComfyUIProvider.openProgressSocket'],
  cWsAvail: ['server/image/comfyui.mjs', "typeof WebSocket !== 'function'", 'ComfyUIProvider.openProgressSocket (WebSocket)'],
  cInterrupt: ['server/image/comfyui.mjs', "'/interrupt'", 'ComfyUIProvider.interrupt'],
  cUpload: ['server/image/comfyui.mjs', "'/upload/image'", 'ComfyUIProvider.upload'],
  // OpenAI images
  oiModels: ['server/image/openai-images.mjs', "'/v1/models'", 'OpenAIImagesProvider.status/listModels'],
  oiGen: ['server/image/openai-images.mjs', "'/v1/images/generations'", 'OpenAIImagesProvider.generate'],
  // e2e
  startServer: ['server/index.mjs', 'export async function startServer', 'startServer'],
  routeProviders: ['server/routes/models.mjs', "r.get('/api/providers'", 'GET /api/providers'],
  routeModels: ['server/routes/models.mjs', "r.get('/api/models',", 'GET /api/models'],
  routeContext: ['server/routes/models.mjs', "'/api/models/context'", 'GET /api/models/context'],
  routeInfo: ['server/routes/models.mjs', "'/api/models/info'", 'GET /api/models/info'],
  planCompute: ['server/context/sizing.mjs', 'export function computeContextPlan', 'computeContextPlan'],
  engineRun: ['server/chat/engine.mjs', 'async run({', 'ChatEngine.run'],
  measureLoaded: ['server/chat/engine.mjs', 'async measureLoaded(', 'ChatEngine.measureLoaded'],
  routeMeasurements: ['server/routes/models.mjs', "'/api/models/measurements'", 'GET /api/models/measurements'],
  compactNow: ['server/chat/engine.mjs', 'async compactNow(', 'ChatEngine.compactNow'],
  autoCompact: ['server/chat/engine.mjs', 'asm.needsCompaction &&', 'ChatEngine.run (auto-compaction)'],
  extract: ['server/memory/extractor.mjs', 'export async function extractMemories', 'extractMemories'],
  embedder: ['server/memory/embedder.mjs', 'async embed(texts', 'Embedder.embed'],
  memSearch: ['server/routes/memories.mjs', "'/api/memories/search'", 'POST /api/memories/search'],
  routePull: ['server/routes/models.mjs', "'/api/models/pull'", 'POST /api/models/pull'],
  routeDelete: ['server/routes/models.mjs', "r.delete('/api/models'", 'DELETE /api/models'],
  imgRun: ['server/image/service.mjs', 'async _run(job', 'ImageService._run'],
  decideUnload: ['server/image/service.mjs', 'decideUnload({', 'ImageService.decideUnload'],
  reloadStatus: ['server/chat/engine.mjs', "reason: 'reload_after_image'", 'ChatEngine.run (model_status reload)'],
  imageTool: ['server/tools/builtin.mjs', "name: 'generate_image'", 'generate_image tool'],
  toolLoop: ['server/chat/engine.mjs', 'r.toolCalls.length && offerTools', 'ChatEngine.run (tool loop)'],
};

const fileCache = new Map();
const unresolvedAnchors = new Set();
function resolveAnchor(key) {
  const a = SRC[key];
  if (!a) return { file: '?', line: null, label: key };
  const [file, anchor, label] = a;
  let lines = fileCache.get(file);
  if (lines === undefined) {
    try { lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n'); } catch { lines = null; }
    fileCache.set(file, lines);
  }
  if (!lines) { unresolvedAnchors.add(key); return { file, line: null, label }; }
  const parts = Array.isArray(anchor) ? anchor : [anchor];
  let from = 0;
  let found = -1;
  for (const p of parts) {
    found = -1;
    for (let i = from; i < lines.length; i++) if (lines[i].includes(p)) { found = i; break; }
    if (found < 0) break;
    from = found + 1;
  }
  if (found < 0) unresolvedAnchors.add(key);
  return { file, line: found >= 0 ? found + 1 : null, label };
}
export function sourceRefs(keys) {
  return (keys || []).map(resolveAnchor).map((r) => `${r.file}${r.line ? `:${r.line}` : ''} (${r.label})`);
}

// =============================================================================================== check catalog
/**
 * Every check the tool can report. `{sid}` = one OpenAI-compatible server id, `{kind}` = image backend kind.
 * title = the assumption being tested; src = Harness code that depends on it.
 */
export const CATALOG = new Map();
function def(id, layer, title, src = [], extra = {}) { CATALOG.set(id, { id, layer, group: id.split('.')[0], title, src, ...extra }); }

def('env.machine', 'env', 'Machine facts (OS, chip, memory, Node) are collected for diagnosis');
def('env.ports', 'env', 'What is listening on the default backend ports');
def('env.ollama_env', 'env', 'OLLAMA_* settings visible to this process (and to launchd on macOS)', ['kvType']);
def('env.harness_sources', 'env', 'Harness server modules load and every source anchor of this tool resolves to a line');

def('ollama.version', 'raw', 'GET /api/version answers {version} within the 1.5 s timeout Harness uses for status()', ['ollamaStatus']);
def('ollama.tags.shape', 'raw', 'GET /api/tags lists models with name/model, size, digest, modified_at and details{family,parameter_size,quantization_level,format}', ['ollamaList']);
def('ollama.show.capabilities', 'raw', '/api/show returns a `capabilities` array (completion/tools/thinking/vision/embedding) for every installed model', ['normCaps', 'toolsFor', 'resolveThink']);
def('ollama.show.model_info', 'raw', "/api/show model_info has general.architecture and <arch>.context_length/block_count/embedding_length/attention.head_count[_kv] as numbers (or non-empty per-layer arrays) — the KV-cache estimate is built from them", ['normCtx', 'normArch', 'kvModel', 'kvPattern', 'kvHeads']);
def('ollama.show.details', 'raw', '/api/show details has family, parameter_size, quantization_level strings', ['normDetails']);
def('ollama.show.parameters', 'raw', '/api/show `parameters` is Modelfile text ("key value" per line, quoted stop strings) that parseModelfileParameters understands', ['parseParams']);
def('ollama.show.unknown_model', 'raw', '/api/show on an unknown model → HTTP 404 with {error} that classifies as model_not_found', ['ollamaRequest', 'classifyNotFound']);
def('ollama.chat.stream', 'raw', '/api/chat stream:true is NDJSON (one JSON object per line) with message.content deltas, done:false chunks and a final done:true line', ['ollamaChat', 'readNdjson', 'ollamaDone']);
def('ollama.chat.done_metrics', 'raw', 'The final chunk has prompt_eval_count, eval_count (integers) and total/load/prompt_eval/eval_duration in NANOseconds', ['ollamaUsage', 'ollamaNs']);
def('ollama.chat.prompt_eval_cached', 'raw', 'prompt_eval_count is the FULL prompt length even when the prompt prefix is cached (repeat + extended conversation); token calibration divides it by the full estimate', ['ollamaUsage', 'observe', 'engineObserve']);
def('ollama.chat.calibration_ratio', 'raw', "prompt_eval_count / Harness's raw token estimate lies in the 0.33–3 band the calibrator accepts", ['observe']);
def('ollama.chat.done_reason_length', 'raw', 'Hitting num_predict ends with done_reason "length"', ['ollamaDone', 'finalLength']);
def('ollama.chat.over_context', 'raw', 'A prompt longer than num_ctx is truncated (HTTP 200, prompt_eval_count ≤ num_ctx) or rejected with an error that classifies as context_overflow', ['classifyOverflow', 'observe']);
def('ollama.chat.abort', 'raw', 'Closing the connection mid-stream ends it cleanly and Ollama stops generating (Harness stop() only aborts the fetch)', ['engineStop']);
def('ollama.ps.shape', 'raw', 'GET /api/ps lists the loaded model with name/model, size, size_vram, expires_at, digest', ['ollamaPs']);
def('ollama.ps.context_length', 'raw', '/api/ps reports context_length = the num_ctx Harness sent (optional field; used after a restart and to detect server-side capping)', ['psContext', 'measureReported', 'llmLoadedCtx']);
def('ollama.ps.size_vram', 'raw', 'size_vram ≤ size; on Apple Silicon the whole model is on the GPU (size_vram == size)', ['cpuSplit']);
def('ollama.ps.expires_at', 'raw', 'expires_at is an ISO timestamp ≈ now + keep_alive', ['psExpires']);
def('ollama.load.generate_empty', 'raw', 'POST /api/generate {model, keep_alive, options:{num_ctx}} without a prompt loads the model (used by /api/models/load and eager reload after images)', ['load']);
def('ollama.ps.size_grows_with_num_ctx', 'raw', '/api/ps size grows with num_ctx (measured memory = fixed + per-token × num_ctx)', ['measure', 'fit']);
def('ollama.ps.measurement_fit', 'raw', "Real /api/ps samples pass fitMeasurements' sanity limits and give a slope within ¼–4× of the architecture estimate", ['fit', 'fitClamp', 'kvModel']);
def('ollama.ps.kv_cache_type', 'raw', "The measured per-token cost matches the KV cache precision Harness assumes (f16 unless OLLAMA_KV_CACHE_TYPE is visible to Harness)", ['kvType', 'kvModel']);
for (const [label] of keepAliveForms()) def(`ollama.keep_alive.${label}`, 'raw', `keep_alive ${label.replace(/^(number|string)_/, '$1 ')} (allowed by the settings validator) is accepted as Harness sends it and means what Harness intends`, ['ollamaKeepAlive', 'normalizeKeepAlive', 'settingsKeepAlive']);
def('ollama.unload.chat', 'raw', 'POST /api/generate {model, keep_alive:0} → done_reason "unload", and /api/ps stops listing the model quickly (the image service starts generating right after unload())', ['unload', 'imageUnload']);
def('ollama.think.on', 'raw', 'think:true on a thinking model streams message.thinking separately from message.content', ['ollamaThinking', 'resolveThink']);
def('ollama.think.off', 'raw', 'think:false on a thinking model suppresses thinking (internal tasks rely on it)', ['llmThinkFalse']);
def('ollama.think.level', 'raw', 'think:"low" (settings reasoning.think low/medium/high) is accepted, or rejected with a text the retry logic handles', ['resolveThink', 'retryThink', 'classifyThink']);
def('ollama.think.unsupported_error', 'raw', 'think:true on a model without thinking → HTTP 400 whose text matches /does not support thinking|think.*not supported/ (triggers the retry without think)', ['classifyThink', 'retryThink']);
def('ollama.tools.call', 'raw', 'A tool-capable model returns message.tool_calls[{function:{name, arguments}}] with arguments as a JSON object', ['ollamaToolCalls', 'parseArgs']);
def('ollama.tools.result_roundtrip', 'raw', 'Sending the call back (assistant tool_calls + role "tool" with tool_name) yields a final text answer', ['toOllamaMessage']);
def('ollama.tools.unsupported_error', 'raw', 'tools on a model without tool support → HTTP 400 whose text matches /does not support tools/ (triggers the retry without tools)', ['classifyTools', 'retryTools']);
def('ollama.format.json_schema', 'raw', "format = Harness's MEMORY_SCHEMA (with think:false) is accepted and the content is JSON matching it", ['extractor', 'llmFormat', 'llmThinkFalse', 'parseJsonLoose']);
def('ollama.embed.batch', 'raw', 'POST /api/embed {input:[a,b]} → embeddings: two equal-length number arrays', ['ollamaEmbed', 'embedderBatch', 'embedDims']);
def('ollama.embed.chat_rejected', 'raw', '/api/chat on an embedding model → 400 that classifies as not_chat_model', ['classifyNotChat']);
def('ollama.unload.embedding', 'raw', 'OllamaProvider.unload() on an embedding model works (generate→error→/api/embed keep_alive 0 fallback) and the model leaves /api/ps', ['unload', 'unloadEmbed']);
def('ollama.errors.chat_unknown_model', 'raw', '/api/chat on an unknown model → 404 {error} that classifies as model_not_found', ['ollamaRequest', 'classifyNotFound']);
def('ollama.errors.delete_unknown_model', 'raw', 'DELETE /api/delete on an unknown model → 404 {error}', ['ollamaDelete']);
def('ollama.errors.pull_unknown_model', 'raw', 'Pulling a non-existent model streams {status} lines then an {error} line (HTTP 200) that classifies as model_not_found', ['ollamaPull', 'pullErr']);
def('ollama.pull.new', 'raw', 'Pull progress lines carry status, digest, total, completed and end with status "success"', ['ollamaPull', 'routePullPercent']);
def('ollama.pull.already_present', 'raw', 'Pulling an already-present model still streams progress and ends with "success"', ['ollamaPull']);
def('ollama.delete.own_model', 'raw', 'DELETE /api/delete {model} removes the model pulled by this run', ['ollamaDelete']);

def('openai.{sid}.models', 'raw', 'GET /v1/models → {data:[{id, created, meta?}]}', ['oaiStatus', 'oaiModels']);
def('openai.{sid}.context_source', 'raw', 'The server exposes its context size where Harness looks (/props n_ctx for llama.cpp, loaded_context_length for LM Studio, meta.n_ctx_train)', ['oaiProps', 'oaiLm', 'oaiNormalize', 'planServer']);
def('openai.{sid}.chat.stream', 'raw', 'Streaming chat is SSE "data:" JSON chunks with choices[0].delta.content, a finish_reason and a final "data: [DONE]"', ['oaiChat', 'readSse', 'oaiFinish']);
def('openai.{sid}.chat.usage', 'raw', 'With stream_options.include_usage the stream carries usage.prompt_tokens/completion_tokens (or llama.cpp timings)', ['oaiUsage', 'engineObserve']);
def('openai.{sid}.chat.finish_length', 'raw', 'max_tokens reached → finish_reason "length"', ['oaiFinish']);
def('openai.{sid}.chat.reasoning', 'raw', 'Reasoning text arrives in delta.reasoning_content or delta.reasoning (or inline <think> tags)', ['oaiReasoning']);
def('openai.{sid}.chat.think_off', 'raw', 'llama.cpp accepts chat_template_kwargs {enable_thinking:false} (sent when reasoning is off)', ['oaiKwargs']);
def('openai.{sid}.tools.deltas', 'raw', 'Tool calls stream as delta.tool_calls[{index, id, function:{name, arguments(string pieces)}}] and finish_reason "tool_calls"', ['oaiToolDeltas', 'oaiFinish']);
def('openai.{sid}.tools.result_roundtrip', 'raw', 'Sending back assistant tool_calls (arguments as JSON string) + role "tool" with tool_call_id gives a final answer', ['toOpenAIMessage']);
def('openai.{sid}.tools.unsupported_error', 'raw', 'A server/model without tool support answers with a text classifyOpenAIError maps to tools_unsupported', ['classifyOai', 'retryTools']);
def('openai.{sid}.embeddings', 'raw', 'POST /v1/embeddings {input:[a,b]} → data[{index, embedding}] (2 items)', ['oaiEmbed']);
def('openai.{sid}.errors.unknown_model', 'raw', 'An unknown model id is rejected with a text classifyOpenAIError maps to model_not_found, or the server serves its loaded model', ['classifyOai']);

def('a1111.options', 'raw', 'GET /sdapi/v1/options → JSON object with sd_model_checkpoint (A1111/Forge) or model (Draw Things) = the current checkpoint', ['a1Status', 'familyDefault']);
def('a1111.detect_fallbacks', 'raw', "status() fallbacks: /sd-models or /samplers JSON arrays, GET txt2img → 405/422 JSON, or GET / → Draw Things config JSON", ['a1Status']);
def('a1111.sd_models', 'raw', 'GET /sdapi/v1/sd-models → [{title, model_name, filename}] and the current checkpoint matches one title/model_name', ['a1Models', 'a1Current']);
def('a1111.samplers', 'raw', 'GET /sdapi/v1/samplers → [{name, aliases}] (informational: Harness sends sampler names verbatim)', ['a1Body']);
def('a1111.progress', 'raw', 'GET /sdapi/v1/progress?skip_current_image=true → {progress, eta_relative, state{sampling_step, sampling_steps}}', ['a1Progress']);
def('a1111.interrupt', 'raw', 'POST /sdapi/v1/interrupt exists (Harness calls it on abort and on errors)', ['a1Interrupt']);
def('a1111.txt2img.min_size', 'raw', 'txt2img with the exact body Harness sends (duplicate A1111/Draw Things field names) succeeds at a tiny size/step count', ['a1Body', 'a1Images']);
def('a1111.txt2img.response', 'raw', 'txt2img → {images:[base64 PNG/JPEG], info: JSON string or object with seed/all_seeds}', ['a1Images', 'a1Info', 'a1Seeds']);
def('a1111.txt2img.count2', 'raw', 'count 2 (batch_size 1, n_iter 2, batch_count 2) → 2 real images; a leading grid is skipped via info.index_of_first_image', ['a1Body', 'a1Grid']);
def('a1111.txt2img.seeds', 'raw', 'info.all_seeds lists one seed per returned image (seed, seed+1)', ['a1Seeds']);
def('a1111.txt2img.unknown_fields', 'raw', 'The backend ignores the field names meant for the other dialect (guidance_scale, batch_count, sampler, strength / n_iter, cfg_scale, sampler_name)', ['a1Body']);
def('a1111.progress_during', 'raw', '/progress reports progress > 0 while a generation runs', ['a1Progress']);
def('a1111.interrupt_during', 'raw', 'POST /interrupt during a generation makes txt2img return early', ['a1Interrupt']);
def('a1111.img2img', 'raw', 'img2img with init_images [raw base64] + denoising_strength/strength returns an image of the requested size', ['a1Img2img']);

def('comfyui.system_stats', 'raw', 'GET /system_stats → {system:{comfyui_version}, devices}', ['cStatus']);
def('comfyui.checkpoints', 'raw', 'GET /object_info/CheckpointLoaderSimple lists ckpt_name options as [[...]] or ["COMBO",{options}]', ['cModels', 'cCombo']);
def('comfyui.nodes', 'raw', "Every node class used by Harness's default workflows exists (/object_info/<class>)", ['cWorkflow', 'cWorkflowI2I']);
def('comfyui.samplers', 'raw', 'KSampler accepts every sampler_name/scheduler Harness may send (euler/normal defaults + per-family values)', ['imageFamilies', 'cWorkflow']);
def('comfyui.queue_routes', 'raw', 'GET /queue and POST-only /interrupt exist', ['cInterrupt']);
def('comfyui.websocket', 'raw', '/ws?clientId= accepts a WebSocket and sends {type:"status"} JSON (progress messages need global WebSocket, Node ≥ 22)', ['cWsAvail', 'cWs']);
def('comfyui.validation_error', 'raw', 'An invalid workflow is rejected with node_errors that Harness surfaces to the user', ['cPrompt', 'cNodeErrors', 'imgHttpErr']);
def('comfyui.prompt', 'raw', 'POST /prompt {prompt: default workflow, client_id} → {prompt_id, number, node_errors:{}}', ['cPrompt', 'cWorkflow']);
def('comfyui.ws_progress', 'raw', 'During the run the WebSocket sends {type:"progress", data:{value, max}} messages', ['cWs']);
def('comfyui.history', 'raw', 'GET /history/{id} → {id:{status:{status_str, completed}, outputs:{node:{images:[{filename, subfolder, type}]}}}}', ['cHistory', 'cHistoryErr']);
def('comfyui.view', 'raw', 'GET /view?filename&subfolder&type returns the image bytes', ['cView']);
def('comfyui.interrupt_during', 'raw', 'POST /interrupt during a run ends it (history status error / interrupted)', ['cInterrupt', 'cHistoryErr']);

def('openai-images.models', 'raw', 'GET /v1/models answers (used as the reachability probe)', ['oiModels']);
def('openai-images.generate', 'raw', 'POST /v1/images/generations {n, size, response_format:"b64_json"} → data[{b64_json}] or same-host url', ['oiGen']);

def('e2e.server', 'e2e', 'The real Harness server starts in-process with a temp data dir wired to the detected backends', ['startServer']);
def('e2e.providers', 'e2e', 'GET /api/providers reports every detected chat backend as running', ['routeProviders']);
def('e2e.models', 'e2e', 'GET /api/models?details=1 lists the chosen model with the capabilities /api/show reported', ['routeModels', 'normCaps']);
def('e2e.context_plan', 'e2e', 'The context plan for the chosen model is sane (num_ctx ≥ 2K, per-token KV estimate from metadata) — printed with its explanation', ['routeContext', 'planCompute', 'kvModel']);
def('e2e.chat_stream', 'e2e', 'A chat turn streams start → context → token… → stats → done with real token counts', ['engineRun']);
def('e2e.measurement', 'e2e', 'After the first turn Harness records the real /api/ps footprint and the plan switches to basis "measured"', ['measureLoaded', 'measure', 'routeMeasurements']);
def('e2e.calibration', 'e2e', 'Token calibration converges: after a few turns the estimate is close to the real prompt_eval_count', ['engineObserve', 'observe']);
def('e2e.reasoning', 'e2e', 'A thinking model produces reasoning events in a chat turn', ['resolveThink', 'ollamaThinking']);
def('e2e.tool_turn', 'e2e', 'A tool-calling turn runs: tool_call → tool_result → final answer', ['toolLoop', 'toolsFor']);
def('e2e.compaction_forced', 'e2e', 'POST /api/chats/:id/compact summarizes the history with the real model', ['compactNow']);
def('e2e.compaction_auto', 'e2e', 'With a tiny context (1K) the auto-summarizer kicks in during a conversation', ['autoCompact']);
def('e2e.memory_extraction', 'e2e', 'Memory extraction (MEMORY_SCHEMA structured output) turns a self-introduction into memories', ['extract', 'extractor']);
def('e2e.embeddings', 'e2e', 'With an embedding model, memory search runs in hybrid mode and finds a semantically related memory', ['embedder', 'memSearch']);
def('e2e.openai_chat.{sid}', 'e2e', 'A chat turn through an OpenAI-compatible provider streams tokens and real usage; its plan uses the server context', ['engineRun', 'planServer']);
def('e2e.pull_delete', 'e2e', 'POST /api/models/pull streams progress→done and DELETE /api/models removes the model', ['routePull', 'routeDelete']);
def('e2e.image_direct.{kind}', 'e2e', 'POST /api/images/generate streams image_job → image_status… → image → image_done → done and stores a real image', ['imgRun']);
def('e2e.image_tool', 'e2e', 'The generate_image tool inside a chat produces an image, with unload → generate → reload of the chat model', ['imageTool', 'imgRun', 'decideUnload', 'imageUnload', 'reloadStatus']);

function catalogFor(id) {
  if (CATALOG.has(id)) return CATALOG.get(id);
  const t = id.replace(/^openai\.[^.]+\./, 'openai.{sid}.').replace(/^e2e\.openai_chat\..+$/, 'e2e.openai_chat.{sid}').replace(/^e2e\.image_direct\..+$/, 'e2e.image_direct.{kind}');
  return CATALOG.get(t) || null;
}

function keepAliveForms() {
  // [label, value as configured in settings, Harness's intended meaning in seconds (Infinity = forever)]
  return [
    ['number_300', 300, 300], ['number_-1', -1, Infinity],
    ['string_5m', '5m', 300], ['string_30m', '30m', 1800], ['string_1h30m', '1h30m', 5400], ['string_-1m', '-1m', Infinity],
    ['string_-1', '-1', Infinity], ['string_30', '30', 30],
  ];
}

// =============================================================================================== outcomes + runner
const PASS = (detail, x = {}) => ({ status: 'PASS', detail, ...x });
const WARN = (detail, x = {}) => ({ status: 'WARN', detail, ...x });
const FAIL = (detail, x = {}) => ({ status: 'FAIL', detail, ...x });
const SKIP = (detail, needText, x = {}) => ({ status: 'SKIP', detail, need: needText, ...x });
class SkipSignal extends Error { constructor(detail, needText) { super(detail); this.needText = needText; } }
const need = (cond, detail, needText) => { if (!cond) throw new SkipSignal(detail, needText); };

const ANSI = { PASS: '32', FAIL: '31', WARN: '33', SKIP: '90', head: '1', dim: '2', cyan: '36' };

class Run {
  constructor(opts, { out = (s) => process.stdout.write(s) } = {}) {
    this.opts = opts;
    this.out = out;
    this.results = [];
    this.samples = {};
    this.env = {};
    this.backends = {};
    this.picks = {};
    this.notes = [];
    this.startedAt = new Date().toISOString();
    this.t0 = Date.now();
  }

  c(code, s) { return this.opts.color ? `\x1b[${code}m${s}\x1b[0m` : s; }
  print(s = '') { if (!this.opts.quiet) this.out(`${redact(s)}\n`); }
  T(ms) { return Math.round(ms * (this.opts.timeoutScale || 1)); }

  section(layer, title) {
    this.print('');
    this.print(this.c(ANSI.head, `${layer === 'e2e' ? '[e2e] ' : layer === 'raw' ? '[raw] ' : ''}${title}`));
  }

  sample(key, value) {
    this.samples[key] = shrink(redactDeep(value));
  }

  /** Run one check. `fn(ctx)` returns an outcome (PASS/WARN/FAIL/SKIP) — exceptions and timeouts become FAIL. */
  async check(id, fn, { timeoutMs = 60000 } = {}) {
    const meta = catalogFor(id);
    if (!meta) throw new Error(`live-check: check id ${id} is not in the catalog`);
    const started = Date.now();
    const ac = new AbortController();
    const limit = this.T(timeoutMs);
    let timer;
    let outcome;
    try {
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(new Error('timeout')); rej(Object.assign(new Error(`no result within ${fmtMs(limit)}`), { isCheckTimeout: true })); }, limit); });
      outcome = await Promise.race([Promise.resolve().then(() => fn({ signal: ac.signal, sample: (k, v) => this.sample(k, v) })), timeout]);
    } catch (e) {
      if (e instanceof SkipSignal) outcome = SKIP(e.message, e.needText);
      else if (e?.isCheckTimeout) outcome = FAIL(`timed out: ${e.message}`, { fix: 'If the machine is just slow, rerun with --timeout-scale 3; otherwise the backend hangs on this request.' });
      else outcome = FAIL(`check crashed: ${errText(e)}`, { actual: excerpt(e?.stack || String(e), 800) });
    } finally {
      clearTimeout(timer);
    }
    if (!outcome || !outcome.status) outcome = FAIL('check returned no outcome');
    const r = {
      id, layer: meta.layer, group: meta.group, status: outcome.status, assumption: meta.title,
      source: sourceRefs([...(meta.src || []), ...(outcome.src || [])]),
      detail: redact(outcome.detail || ''),
      expected: outcome.expected ? redact(String(outcome.expected)) : undefined,
      actual: outcome.actual !== undefined ? excerpt(outcome.actual, 900) : undefined,
      fix: outcome.fix ? redact(outcome.fix) : undefined,
      need: outcome.need ? redact(outcome.need) : undefined,
      info: outcome.info?.length ? outcome.info.map((x) => redact(String(x))) : undefined,
      observed: outcome.observed !== undefined ? shrink(redactDeep(outcome.observed)) : undefined,
      durationMs: Date.now() - started,
    };
    this.results.push(r);
    this.printResult(r);
    return { ...r, data: outcome.data };
  }

  printResult(r) {
    if (this.opts.quiet) return;
    const st = this.c(ANSI[r.status], r.status.padEnd(4));
    this.print(`  ${st}  ${r.id}  ${this.c(ANSI.dim, `(${fmtMs(r.durationMs)})`)}`);
    if (r.detail) this.print(`        ${r.detail}`);
    const showAll = this.opts.verbose || r.status === 'FAIL' || r.status === 'WARN';
    for (const l of r.info || []) this.print(`        ${this.c(ANSI.cyan, '│')} ${l}`);
    if (showAll) {
      this.print(`        ${this.c(ANSI.dim, 'assumes ')} ${r.assumption}`);
      if (r.source.length) this.print(`        ${this.c(ANSI.dim, 'code    ')} ${r.source.join('; ')}`);
    }
    if (r.expected) this.print(`        ${this.c(ANSI.dim, 'expected')} ${r.expected}`);
    if (r.actual) this.print(`        ${this.c(ANSI.dim, 'actual  ')} ${r.actual}`);
    if (r.fix) this.print(`        ${this.c(ANSI.dim, 'fix     ')} ${r.fix}`);
    if (r.need) this.print(`        ${this.c(ANSI.dim, 'needs   ')} ${r.need}`);
  }

  summary() {
    const count = (list) => Object.fromEntries(['PASS', 'FAIL', 'WARN', 'SKIP'].map((s) => [s, list.filter((r) => r.status === s).length]));
    return {
      total: this.results.length,
      ...count(this.results),
      byLayer: Object.fromEntries(['env', 'raw', 'e2e'].map((l) => [l, count(this.results.filter((r) => r.layer === l))])),
      byGroup: Object.fromEntries([...new Set(this.results.map((r) => r.group))].map((g) => [g, count(this.results.filter((r) => r.group === g))])),
    };
  }
}

// =============================================================================================== HTTP helpers
function anySignal(signal, timeoutMs) {
  const list = [];
  if (signal) list.push(signal);
  if (timeoutMs) list.push(AbortSignal.timeout(timeoutMs));
  return list.length ? (list.length === 1 ? list[0] : AbortSignal.any(list)) : undefined;
}
function headersOf(res) {
  const out = {};
  for (const k of ['content-type', 'content-length', 'transfer-encoding', 'server']) { const v = res.headers.get(k); if (v) out[k] = v; }
  return out;
}

/** One HTTP request; never throws. → { ok, status, headers, text, json, ms, error, timeout } */
async function http(base, p, { method = 'GET', body, headers = {}, timeoutMs = 10000, signal, apiKey, binary = false } = {}) {
  const t0 = nowMs();
  const h = { ...headers };
  if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  try {
    const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), signal: anySignal(signal, timeoutMs) });
    let text = null;
    let buf = null;
    if (binary) buf = Buffer.from(await res.arrayBuffer());
    else text = await res.text();
    let json;
    if (text) { try { json = JSON.parse(text); } catch { json = undefined; } }
    return { ok: res.ok, status: res.status, headers: headersOf(res), text, json, buf, ms: nowMs() - t0 };
  } catch (e) {
    return { ok: false, status: 0, error: errText(e), timeout: e?.name === 'TimeoutError', ms: nowMs() - t0 };
  }
}
const errorOf = (r) => (r.json && (typeof r.json.error === 'string' ? r.json.error : r.json.error?.message || r.json.detail || r.json.message)) || r.text || r.error || `HTTP ${r.status}`;
const httpSummary = (r) => (r.status ? `HTTP ${r.status} ${excerpt(r.text ?? '', 300)}` : `no response: ${r.error}`);

/**
 * Streamed request, line by line. `onLine(line, state)` may return 'stop' to abort the request (the reason
 * observed by the reader is recorded). → { status, ok, contentType, lines:[{t,text}], firstByteMs, totalMs, error, aborted, abortErrorName, bodyText }
 */
async function streamLines(url, { method = 'POST', body, headers = {}, timeoutMs = 120000, signal, onLine, apiKey } = {}) {
  const t0 = nowMs();
  const out = { status: 0, ok: false, contentType: null, lines: [], firstByteMs: null, totalMs: null, error: null, aborted: false, abortErrorName: null, bodyText: null };
  const ac = new AbortController();
  const sig = AbortSignal.any([ac.signal, ...(signal ? [signal] : []), ...(timeoutMs ? [AbortSignal.timeout(timeoutMs)] : [])]);
  const h = { 'content-type': 'application/json', ...headers };
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  let res;
  try {
    res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: sig });
  } catch (e) {
    out.error = errText(e);
    out.timeout = e?.name === 'TimeoutError';
    out.totalMs = nowMs() - t0;
    return out;
  }
  out.status = res.status;
  out.ok = res.ok;
  out.contentType = res.headers.get('content-type');
  if (!res.ok) {
    out.bodyText = await res.text().catch(() => '');
    try { out.json = JSON.parse(out.bodyText); } catch { /* not JSON */ }
    out.totalMs = nowMs() - t0;
    return out;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let stop = false;
  try {
    while (!stop) {
      const { done, value } = await reader.read();
      if (done) break;
      if (out.firstByteMs == null) out.firstByteMs = nowMs() - t0;
      buf += dec.decode(value, { stream: true });
      let i;
      while (!stop && (i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        out.lines.push({ t: nowMs() - t0, text: line });
        if (onLine && (await onLine(line, out)) === 'stop') stop = true;
      }
    }
    if (!stop) {
      buf += dec.decode();
      if (buf.length) out.lines.push({ t: nowMs() - t0, text: buf });
    }
  } catch (e) {
    out.error = errText(e);
    out.timeout = e?.name === 'TimeoutError';
  }
  if (stop) {
    out.aborted = true;
    ac.abort();
    try { await reader.read(); } catch (e) { out.abortErrorName = e?.name || 'Error'; }
    if (!out.abortErrorName) out.abortErrorName = 'closed';
  }
  out.totalMs = nowMs() - t0;
  return out;
}

/** Parse SSE lines (from streamLines) into [{event, data, t}]. */
function sseEvents(lines) {
  const evs = [];
  let ev = null;
  let data = [];
  let t = 0;
  for (const l of lines) {
    if (l.text === '') { if (data.length) evs.push({ event: ev, data: data.join('\n'), t }); ev = null; data = []; continue; }
    if (l.text.startsWith(':')) continue;
    const i = l.text.indexOf(':');
    const f = i < 0 ? l.text : l.text.slice(0, i);
    let v = i < 0 ? '' : l.text.slice(i + 1);
    if (v.startsWith(' ')) v = v.slice(1);
    if (f === 'data') { data.push(v); t = l.t; } else if (f === 'event') ev = v;
  }
  if (data.length) evs.push({ event: ev, data: data.join('\n'), t });
  return evs;
}

// =============================================================================================== environment
function sh(cmd, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * MiB }, (err, stdout) => resolve(err && !stdout ? null : String(stdout || '').trim()));
    } catch { resolve(null); }
  });
}
function tcpOpen(host, port, ms = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
const DEFAULT_PORTS = [[11434, 'Ollama'], [8080, 'llama.cpp / MLX'], [1234, 'LM Studio'], [7860, 'Draw Things / A1111 / Forge'], [8188, 'ComfyUI'], [4747, 'Harness']];
const OLLAMA_ENV_KEYS = ['OLLAMA_HOST', 'OLLAMA_FLASH_ATTENTION', 'OLLAMA_KV_CACHE_TYPE', 'OLLAMA_NUM_PARALLEL', 'OLLAMA_MAX_LOADED_MODELS', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_CONTEXT_LENGTH', 'OLLAMA_MODELS', 'OLLAMA_ORIGINS', 'OLLAMA_NEW_ENGINE', 'OLLAMA_GPU_OVERHEAD', 'OLLAMA_LOAD_TIMEOUT', 'OLLAMA_MAX_QUEUE', 'OLLAMA_SCHED_SPREAD', 'OLLAMA_DEBUG'];

async function envGroup(run, B) {
  run.section('env', 'Environment');
  await run.check('env.machine', async () => {
    const info = [];
    const darwin = process.platform === 'darwin';
    const osName = darwin ? `macOS ${await sh('sw_vers', ['-productVersion']) || '?'}` : `${os.type()} ${os.release()}`;
    const chip = (darwin ? await sh('sysctl', ['-n', 'machdep.cpu.brand_string']) : null) || os.cpus()[0]?.model?.trim() || 'unknown';
    let free = os.freemem();
    let freeNote = 'os.freemem()';
    if (darwin) {
      const vm = await sh('vm_stat', []);
      const page = Number((vm || '').match(/page size of (\d+)/)?.[1]) || 16384;
      const pages = (k) => Number((vm || '').match(new RegExp(`${k}:\\s+(\\d+)`))?.[1]) || 0;
      if (vm) { free = (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * page; freeNote = 'free+inactive+speculative pages (vm_stat)'; }
    }
    const swap = darwin ? await sh('sysctl', ['-n', 'vm.swapusage']) : null;
    let harnessVersion = '?';
    try { harnessVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { /* ignore */ }
    const m = { os: osName, arch: process.arch, chip, cpus: os.cpus().length, totalMemBytes: os.totalmem(), freeMemBytes: free, freeMemSource: freeNote, swap, node: process.version, harnessVersion };
    run.env.machine = m;
    info.push(`OS      ${osName} (${process.platform}/${process.arch}), ${chip}, ${m.cpus} cores`);
    info.push(`Memory  ${fmtBytes(m.totalMemBytes)} total, ${fmtBytes(free)} free (${freeNote})${swap ? `, swap: ${swap}` : ''}`);
    info.push(`Node    ${process.version}   Harness ${harnessVersion}   live-check ${TOOL_VERSION}`);
    if (run.opts.simulateRamGb) info.push(`Harness (e2e) will be told the machine has ${run.opts.simulateRamGb} GB RAM (--simulate-ram-gb)`);
    const [maj] = process.versions.node.split('.').map(Number);
    if (maj < 20) return FAIL(`Node ${process.version} is too old`, { expected: 'Node >= 20', fix: 'Install Node 20+ (22 recommended: global WebSocket for ComfyUI progress).', info });
    return PASS('', { info, observed: m });
  });

  await run.check('env.ports', async () => {
    const lsof = await sh('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], 4000);
    const byPort = new Map();
    for (const l of (lsof || '').split('\n').slice(1)) {
      const cols = l.trim().split(/\s+/);
      const port = Number(cols[8]?.match(/:(\d+)$/)?.[1]);
      if (port) byPort.set(port, `${cols[0]} (pid ${cols[1]})`);
    }
    const info = [];
    const ports = [];
    for (const [port, what] of DEFAULT_PORTS) {
      const open = await tcpOpen('127.0.0.1', port);
      const found = B.tried.find((t) => { try { return Number(new URL(t.url).port) === port && new URL(t.url).hostname.match(/^(127\.0\.0\.1|localhost)$/); } catch { return false; } });
      const ident = found ? (found.ok ? `${found.kind}${found.info ? ` ${found.info}` : ''}` : `not ${found.kind}: ${found.error || 'no answer'}`) : (run.opts.detect ? '' : 'not probed (--no-detect)');
      ports.push({ port, expected: what, open, process: byPort.get(port) || null, identified: ident || null });
      info.push(`${String(port).padEnd(6)} ${(open ? 'open  ' : 'closed')} ${what.padEnd(28)} ${open ? [byPort.get(port), ident].filter(Boolean).join(' — ') : ''}`);
    }
    for (const t of B.tried.filter((x) => !DEFAULT_PORTS.some(([p]) => { try { return Number(new URL(x.url).port) === p; } catch { return false; } }))) {
      info.push(`${t.url.padEnd(35)} ${t.ok ? `${t.kind}${t.info ? ` ${t.info}` : ''}` : `not reachable as ${t.kind}: ${t.error || 'no answer'}`} (explicit)`);
    }
    run.env.ports = ports;
    return PASS(lsof ? '' : 'lsof not available: process names unknown', { info, observed: { ports, tried: B.tried } });
  });

  await run.check('env.ollama_env', async () => {
    const info = [];
    const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('OLLAMA_')));
    info.push(`this process: ${Object.keys(own).length ? Object.entries(own).map(([k, v]) => `${k}=${v}`).join(' ') : '(no OLLAMA_* variables)'}`);
    const launchd = {};
    if (process.platform === 'darwin') {
      for (const k of OLLAMA_ENV_KEYS) { const v = await sh('launchctl', ['getenv', k], 1500); if (v) launchd[k] = v; }
      info.push(`launchctl (Ollama.app reads these): ${Object.keys(launchd).length ? Object.entries(launchd).map(([k, v]) => `${k}=${v}`).join(' ') : '(none set)'}`);
    }
    const bin = await sh(process.platform === 'win32' ? 'where' : 'which', ['ollama']);
    const cli = bin ? await sh('ollama', ['--version'], 4000) : null;
    if (bin) info.push(`ollama binary: ${bin}${cli ? ` — ${cli.replace(/\n/g, '; ')}` : ''}`);
    if (B.ollama) info.push(`server version (API): ${B.ollama.version || '?'}`);
    const kvSeen = own.OLLAMA_KV_CACHE_TYPE || null;
    const kvServer = launchd.OLLAMA_KV_CACHE_TYPE || null;
    info.push(`Harness assumes KV cache ${H.ProviderRegistry.prototype.kvCacheType.call({ ollamaProcess: null }, H.DEFAULT_SETTINGS)} for an Ollama it did not start (reads only its own OLLAMA_KV_CACHE_TYPE)`);
    run.env.ollamaEnv = { process: own, launchd, binary: bin, cliVersion: cli };
    if (kvServer && kvServer !== kvSeen) {
      return WARN(`Ollama.app is configured with OLLAMA_KV_CACHE_TYPE=${kvServer} via launchctl, which Harness cannot see — its KV estimate assumes ${kvSeen || 'f16'} until measurements correct it`, { info, fix: 'Read the KV type from launchctl on macOS in ProviderRegistry.kvCacheType, or rely on measurements (ollama.ps.kv_cache_type below shows what the server really uses).' });
    }
    return PASS('', { info, observed: run.env.ollamaEnv });
  });

  await run.check('env.harness_sources', async () => {
    for (const k of Object.keys(SRC)) resolveAnchor(k);
    const bad = [...unresolvedAnchors];
    const info = [`${Object.keys(SRC).length} source anchors checked against the current server/ tree`];
    if (bad.length) return WARN(`${bad.length} source anchor(s) no longer match the code; those checks cite only the function name`, { info: [...info, ...bad.map((k) => `${k}: ${SRC[k][0]} "${[].concat(SRC[k][1]).join(' … ')}"`)], fix: 'Update the SRC table in scripts/live-check.mjs.' });
    return PASS('', { info });
  });
}

// =============================================================================================== detection
const stripV1 = (u) => String(u).replace(/\/+$/, '').replace(/\/v1$/, '');

async function detectBackends(run) {
  const o = run.opts;
  const T = (ms) => run.T(ms);
  const B = { ollama: null, openai: [], a1111: null, comfyui: null, openaiImages: null, tried: [] };
  const note = (kind, url, explicit, ok, info, error) => B.tried.push({ kind, url, explicit, ok, info: info || null, error: error || null });

  const ollamaUrl = o.ollamaUrl || (o.detect ? H.defaultOllamaUrl() : null);
  if (ollamaUrl) {
    const url = stripV1(ollamaUrl);
    const r = await http(url, '/api/version', { timeoutMs: T(3000) });
    const ok = r.ok && typeof r.json?.version === 'string';
    note('ollama', url, !!o.ollamaUrl, ok, ok ? r.json.version : null, ok ? null : (r.error || `HTTP ${r.status}`));
    if (ok) B.ollama = { url, version: r.json.version, explicit: !!o.ollamaUrl };
  }
  const oaiCandidates = [];
  if (o.llamacppUrl || o.detect) oaiCandidates.push({ sid: 'llamacpp', url: stripV1(o.llamacppUrl || 'http://127.0.0.1:8080'), flavor: 'generic', builtin: 'llamacpp', explicit: !!o.llamacppUrl });
  if (o.lmstudioUrl || o.detect) oaiCandidates.push({ sid: 'lmstudio', url: stripV1(o.lmstudioUrl || 'http://127.0.0.1:1234'), flavor: 'lmstudio', builtin: 'lmstudio', explicit: !!o.lmstudioUrl });
  o.openaiUrls.forEach((u, i) => oaiCandidates.push({ sid: `oai${i + 1}`, url: stripV1(u), flavor: 'generic', builtin: null, explicit: true }));
  for (const c of oaiCandidates) {
    const r = await http(c.url, '/v1/models', { timeoutMs: T(3000), apiKey: o.apiKey });
    const ok = r.ok && Array.isArray(r.json?.data);
    if (ok && c.flavor === 'generic') {
      const props = await http(c.url, '/props', { timeoutMs: T(2000), apiKey: o.apiKey });
      if (props.ok && isObj(props.json) && (props.json.default_generation_settings || props.json.total_slots !== undefined)) c.flavor = 'llamacpp';
    }
    note(c.sid, c.url, c.explicit, ok, ok ? `${c.flavor}, ${r.json.data.length} model(s)` : null, ok ? null : (r.error || `HTTP ${r.status}`));
    if (ok) B.openai.push({ ...c, models: r.json.data.map((m) => m.id).filter(Boolean) });
  }
  const a1111Url = o.a1111Url || (o.detect ? 'http://127.0.0.1:7860' : null);
  if (a1111Url) {
    const url = stripV1(a1111Url);
    const how = await a1111Detect(url, T);
    note('a1111', url, !!o.a1111Url, !!how.ok, how.ok ? how.via : null, how.ok ? null : how.error);
    if (how.ok) B.a1111 = { url, via: how.via, currentModel: how.currentModel, explicit: !!o.a1111Url };
  }
  const comfyUrl = o.comfyuiUrl || (o.detect ? 'http://127.0.0.1:8188' : null);
  if (comfyUrl) {
    const url = stripV1(comfyUrl);
    const r = await http(url, '/system_stats', { timeoutMs: T(3000) });
    const ok = r.ok && isObj(r.json?.system);
    note('comfyui', url, !!o.comfyuiUrl, ok, ok ? r.json.system.comfyui_version || 'version ?' : null, ok ? null : (r.error || `HTTP ${r.status}`));
    if (ok) B.comfyui = { url, version: r.json.system.comfyui_version || null, explicit: !!o.comfyuiUrl };
  }
  if (o.openaiImagesUrl) {
    const url = stripV1(o.openaiImagesUrl);
    const r = await http(url, '/v1/models', { timeoutMs: T(3000), apiKey: o.apiKey });
    note('openai-images', url, true, r.ok, r.ok ? 'models answered' : null, r.ok ? null : (r.error || `HTTP ${r.status}`));
    if (r.ok) B.openaiImages = { url, models: (r.json?.data || []).map((m) => m.id) };
  }
  return B;
}

/** Mirrors A1111Provider.status(): options object → sd-models/samplers arrays → txt2img GET 405/422 JSON → GET / config JSON. */
async function a1111Detect(url, T) {
  const opt = await http(url, '/sdapi/v1/options', { timeoutMs: T(3000) });
  if (opt.status === 0) return { ok: false, error: opt.error };
  if (opt.status === 200 && isObj(opt.json)) return { ok: true, via: '/sdapi/v1/options', currentModel: opt.json.sd_model_checkpoint || opt.json.model || null, opt };
  for (const p of ['/sdapi/v1/sd-models', '/sdapi/v1/samplers']) {
    const r = await http(url, p, { timeoutMs: T(3000) });
    if (r.status === 200 && Array.isArray(r.json)) return { ok: true, via: p, currentModel: null, opt };
  }
  const t = await http(url, '/sdapi/v1/txt2img', { timeoutMs: T(3000) });
  if ([405, 422].includes(t.status) && isObj(t.json) && ('detail' in t.json || 'error' in t.json)) return { ok: true, via: `GET /sdapi/v1/txt2img → ${t.status}`, currentModel: null, opt };
  const root = await http(url, '/', { timeoutMs: T(3000) });
  if (root.status === 200 && isObj(root.json) && 'steps' in root.json) return { ok: true, via: 'GET / (Draw Things config)', currentModel: typeof root.json.model === 'string' ? root.json.model : null, opt };
  return { ok: false, error: `no A1111-compatible API (options → HTTP ${opt.status})` };
}

// =============================================================================================== Ollama helpers
function parseOllamaStream(r) {
  const objs = [];
  const bad = [];
  for (const l of r.lines || []) {
    const t = l.text.trim();
    if (!t) continue;
    try { objs.push({ t: l.t, o: JSON.parse(t) }); } catch { bad.push(t); }
  }
  const p = { objs: objs.map((x) => x.o), bad, content: '', thinking: '', toolCalls: [], toolCallChunks: [], final: null, finalIndex: -1, errorLine: null, firstContentMs: null, firstThinkingMs: null, status: r.status, errorText: null };
  objs.forEach(({ t, o }, i) => {
    if (o.error) p.errorLine = typeof o.error === 'string' ? o.error : JSON.stringify(o.error);
    const m = o.message || {};
    if (typeof m.content === 'string' && m.content) { p.content += m.content; if (p.firstContentMs == null) p.firstContentMs = t; }
    if (typeof m.thinking === 'string' && m.thinking) { p.thinking += m.thinking; if (p.firstThinkingMs == null) p.firstThinkingMs = t; }
    if (Array.isArray(m.tool_calls)) { p.toolCalls.push(...m.tool_calls); p.toolCallChunks.push({ index: i, done: !!o.done }); }
    if (o.done && !p.final) { p.final = o; p.finalIndex = i; }
  });
  if (!r.ok) p.errorText = (typeof r.json?.error === 'string' ? r.json.error : r.json?.error?.message) || r.bodyText || r.error || `HTTP ${r.status}`;
  return p;
}
function streamSample(body, r, p) {
  const objs = p.objs;
  const lines = objs.length > 7 ? [...objs.slice(0, 4), `…(${objs.length - 6} more lines)…`, ...objs.slice(-2)] : objs;
  const req = { ...body, messages: (body.messages || []).map((m) => ({ ...m, content: typeof m.content === 'string' && m.content.length > 400 ? `${m.content.slice(0, 400)}…(${m.content.length} chars)` : m.content })) };
  return { request: req, status: r.status, contentType: r.contentType, ...(r.ok ? { lines } : { body: r.json ?? r.bodyText }), error: r.error || undefined };
}
const ollamaSys = "You are Harness, a friendly assistant that runs locally on the user's own computer. Answer briefly and precisely. If you are unsure about something, say so instead of guessing. Use plain language, avoid jargon, and keep every answer under two sentences unless the user explicitly asks for more detail.";
const toolsSchema = () => H.toolSchemas(H.BUILTIN_TOOLS.filter((t) => t.name === 'calculate'), { compact: true });
const rawEstimate = (msgs) => msgs.reduce((a, m) => a + H.estimateMessageTokensRaw({ role: m.role, content: m.content }), 0) + H.PROMPT_OVERHEAD;
const classifyCode = (status, msg) => { try { return H.classifyOllamaError(status, msg).code; } catch { return '?'; } };

async function psList(O, run) {
  const r = await http(O.url, '/api/ps', { timeoutMs: run.T(10000) });
  return { r, models: Array.isArray(r.json?.models) ? r.json.models : null };
}
const psFind = (models, m) => (models || []).find((x) => sameModel(x.model, m) || sameModel(x.name, m)) || null;
async function waitGone(O, run, model, maxMs) {
  const t0 = nowMs();
  let polls = 0;
  for (;;) {
    const { models } = await psList(O, run);
    polls++;
    if (models && !psFind(models, model)) return { gone: true, ms: nowMs() - t0, polls };
    if (nowMs() - t0 > maxMs) return { gone: false, ms: nowMs() - t0, polls };
    await sleep(200);
  }
}
function expiresDelta(entry) {
  const at = Date.parse(entry?.expires_at || '');
  return Number.isFinite(at) ? (at - Date.now()) / 1000 : null;
}
function intendedSeconds(v) {
  if (typeof v === 'number') return v < 0 ? Infinity : v;
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s) < 0 ? Infinity : Number(s);
  if (s.startsWith('-')) return Infinity;
  let total = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) total += Number(m[1]) * { ns: 1e-9, us: 1e-6, 'µs': 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600 }[m[2]];
  return total;
}
const describeSeconds = (s) => (s === Infinity ? 'forever' : s == null ? '?' : s >= 3600 * 24 * 365 ? `${Math.round(s / (3600 * 24 * 365))} years` : `${Math.round(s)} s`);
function expiryMatches(delta, intended) {
  if (delta == null) return false;
  if (intended === Infinity) return delta > 3600 * 24 * 365;
  return Math.abs(delta - intended) <= Math.max(20, intended * 0.12);
}

/** Choose models from the inventory; returns {chat, tool, think, plain, noThink, embed} entries {name,size,caps,why}. */
export function pickOllamaModels(opts, inv) {
  const has = (m, c) => (m.caps || []).includes(c);
  const sorted = (pred) => inv.filter(pred).sort((a, b) => (a.size ?? Infinity) - (b.size ?? Infinity));
  const chatty = (m) => has(m, 'completion');
  const explicit = (name, flag) => {
    if (!name) return null;
    const m = inv.find((x) => sameModel(x.name, name));
    return m ? { ...m, why: `chosen with --${flag}` } : { name, size: null, caps: [], missing: true, why: `--${flag}, but it is NOT installed` };
  };
  const first = (list, why) => (list[0] ? { ...list[0], why } : null);
  const withTools = sorted((m) => chatty(m) && has(m, 'tools'));
  const chats = sorted(chatty);
  const picks = {};
  picks.chat = explicit(opts.model, 'model') || first(withTools, 'smallest installed model with "tools" (one model for chat + tool checks keeps reloads down)') || first(chats, 'smallest installed chat model (none has "tools")');
  const reuse = (cap, why) => (picks.chat && !picks.chat.missing && has(picks.chat, cap) ? { ...picks.chat, why } : null);
  picks.tool = explicit(opts.toolModel, 'tool-model') || reuse('tools', 'same as the chat model (has "tools")') || first(withTools, 'smallest installed model with "tools"');
  picks.think = explicit(opts.thinkModel, 'think-model') || reuse('thinking', 'same as the chat model (has "thinking")') || first(sorted((m) => chatty(m) && has(m, 'thinking')), 'smallest installed model with "thinking"');
  const plainExplicit = explicit(opts.plainModel, 'plain-model');
  picks.plain = (plainExplicit && !has(plainExplicit, 'tools') ? plainExplicit : null) || first(sorted((m) => chatty(m) && !has(m, 'tools')), 'smallest chat model WITHOUT "tools" (for the tools error text)');
  picks.noThink = (plainExplicit && !has(plainExplicit, 'thinking') ? plainExplicit : null) || first(sorted((m) => chatty(m) && !has(m, 'thinking')), 'smallest chat model WITHOUT "thinking" (for the thinking error text)');
  picks.embed = explicit(opts.embedModel, 'embed-model') || first(sorted((m) => has(m, 'embedding') && !has(m, 'completion')), 'smallest installed embedding model');
  for (const k of Object.keys(picks)) if (picks[k]?.missing) picks[k] = { ...picks[k], unusable: true };
  return picks;
}
const usable = (p) => (p && !p.unusable ? p : null);

// =============================================================================================== Ollama probes
async function ollamaGroup(run, B) {
  const O = { url: B.ollama.url, version: B.ollama.version, used: new Set(), pulledByUs: new Set(), installedBefore: new Set(), initiallyLoaded: new Set(), inventory: [], shows: new Map(), tags: [], ctx: 2048, keepAlive: H.normalizeKeepAlive(run.opts.keepAlive) };
  run.ollama = O;
  run.section('raw', `Ollama ${O.url}`);
  const T = (ms) => run.T(ms);
  const opts = { num_ctx: 2048, num_predict: 32, temperature: 0, seed: 7 };
  const chatBody = (model, messages, extra = {}) => ({ model, messages, stream: true, keep_alive: O.keepAlive, ...extra, options: { ...opts, ...(extra.options || {}) } });
  const capsOf = (name) => O.inventory.find((m) => sameModel(m.name, name))?.caps || [];
  const thinkOffFor = (name) => (capsOf(name).includes('thinking') ? { think: false } : {});
  const chat = async (body, { timeoutMs = 300000, onLine } = {}) => {
    const r = await streamLines(`${O.url}/api/chat`, { body, timeoutMs: T(timeoutMs), onLine });
    const p = parseOllamaStream(r);
    if (r.ok) O.used.add(body.model);
    return { r, p, body };
  };
  { const { models } = await psList(O, run); for (const m of models || []) O.initiallyLoaded.add(m.model || m.name); }

  await run.check('ollama.version', async ({ sample }) => {
    const r = await http(O.url, '/api/version', { timeoutMs: T(10000) });
    sample('ollama GET /api/version', { status: r.status, body: r.json ?? r.text ?? r.error });
    if (!r.ok) return FAIL(`/api/version failed: ${httpSummary(r)}`, { expected: 'HTTP 200 {"version":"x.y.z"}', actual: r.text ?? r.error, fix: 'Harness reports Ollama as unreachable when /api/version fails (OllamaProvider.status).' });
    const v = r.json?.version;
    if (typeof v !== 'string' || !v) return FAIL('answer has no version string', { expected: '{"version":"<string>"}', actual: r.text, fix: 'OllamaProvider.status() would report version null (cosmetic).' });
    if (r.ms > 1500) return WARN(`version ${v}, but the answer took ${fmtMs(r.ms)} — status() gives up after 1.5 s and Harness would show Ollama as not running`, { fix: 'Raise the /api/version timeout in OllamaProvider.status for slow/busy machines.' });
    return PASS(`version ${v} (${fmtMs(r.ms)})`);
  });

  const tags = await run.check('ollama.tags.shape', async ({ sample }) => {
    const r = await http(O.url, '/api/tags', { timeoutMs: T(15000) });
    sample('ollama GET /api/tags', { status: r.status, body: r.json ?? r.text ?? r.error });
    if (!r.ok || !Array.isArray(r.json?.models)) return FAIL(`/api/tags did not return {models:[]}: ${httpSummary(r)}`, { expected: 'HTTP 200 {"models":[…]}', actual: r.text ?? r.error, fix: 'OllamaProvider.listModels reads j.models; nothing would be listed.' });
    const models = r.json.models;
    const problems = [];
    let fatal = false;
    for (const m of models) {
      const name = m.model || m.name;
      if (typeof name !== 'string' || !name) { problems.push(`entry without name/model: ${excerpt(m, 120)}`); fatal = true; continue; }
      if (!isNum(m.size)) problems.push(`${name}: size=${JSON.stringify(m.size)}`);
      if (typeof m.digest !== 'string') problems.push(`${name}: digest missing`);
      if (typeof m.modified_at !== 'string') problems.push(`${name}: modified_at missing`);
      if (!isObj(m.details)) problems.push(`${name}: details missing`);
      else for (const k of ['family', 'parameter_size', 'quantization_level', 'format']) if (typeof m.details[k] !== 'string') problems.push(`${name}: details.${k}=${JSON.stringify(m.details[k])}`);
    }
    O.tags = models;
    for (const m of models) O.installedBefore.add(m.model || m.name);
    const list = models.map((m) => `${m.model || m.name} (${fmtBytes(m.size)})`).join(', ');
    if (fatal) return FAIL('model entries without a name', { actual: problems.join('; '), expected: 'name or model on every entry', fix: 'listModels() would produce entries with model undefined.' });
    if (problems.length) return WARN(`${models.length} model(s); some fields Harness shows are missing (it tolerates that)`, { actual: problems.slice(0, 12).join('; '), expected: 'size, digest, modified_at and details strings on every entry', info: [list] });
    if (!models.length) return WARN('no models installed — most checks below will be skipped', { fix: 'Pull a small model first, e.g. `ollama pull qwen3:0.6b` (has tools + thinking) and `ollama pull all-minilm`.' });
    return PASS(`${models.length} model(s): ${list}`);
  }, { timeoutMs: 30000 });

  await run.check('ollama.show.capabilities', async ({ sample }) => {
    need(O.tags.length, 'no installed models', 'at least one installed model');
    const missing = [];
    const failed = [];
    for (const m of O.tags.slice(0, 40)) {
      const name = m.model || m.name;
      const r = await http(O.url, '/api/show', { method: 'POST', body: { model: name }, timeoutMs: T(15000) });
      if (!r.ok || !isObj(r.json)) { failed.push(`${name}: ${httpSummary(r)}`); continue; }
      O.shows.set(name, r.json);
      if (!sample.done) { sample(`ollama POST /api/show (${name})`, { request: { model: name }, status: r.status, body: r.json }); sample.done = true; }
      let caps = r.json.capabilities;
      let source = 'show';
      if (!Array.isArray(caps)) { caps = H.normalizeOllamaShow(name, r.json, null).capabilities; source = 'heuristic'; missing.push(name); }
      O.inventory.push({ name, size: m.size ?? null, caps, capsSource: source, family: m.details?.family || null, digest: m.digest || null, show: r.json, tag: m });
      if (r.ms > 10000) failed.push(`${name}: /api/show took ${fmtMs(r.ms)} (> Harness's 10 s timeout)`);
    }
    const info = O.inventory.map((m) => `${m.name}: [${m.caps.join(', ')}]${m.capsSource === 'heuristic' ? ' (guessed from template — no capabilities field)' : ''}`);
    if (failed.length) return FAIL(`/api/show failed for ${failed.length} model(s)`, { actual: failed.join('; '), expected: 'HTTP 200 JSON for every installed model', info, fix: 'registry.modelInfo() throws for these models, so chats with them fail.' });
    if (missing.length) return WARN(`${missing.length} model(s) without a capabilities array — Harness guesses from the template (.Tools/.Think) instead`, { info, expected: '"capabilities": ["completion", …]', actual: missing.join(', '), fix: 'Expected only on Ollama < 0.6; update Ollama or keep the template heuristic in normalizeOllamaShow.' });
    return PASS(`${O.inventory.length} model(s), all with capabilities`, { info });
  }, { timeoutMs: 600000 });

  // ---- model picks
  const picks = pickOllamaModels(run.opts, O.inventory);
  run.picks.ollama = Object.fromEntries(Object.entries(picks).map(([k, v]) => [k, v ? { model: v.name, sizeBytes: v.size, caps: v.caps, why: v.why, usable: !v.unusable } : null]));
  run.print('');
  run.print(run.c(ANSI.head, '  Models picked'));
  const NEED = { chat: 'pull a chat model, e.g. qwen3:0.6b', tool: 'a model with "tools" (e.g. qwen3:0.6b) or --tool-model', think: 'a model with "thinking" (e.g. qwen3:0.6b) or --think-model', plain: 'a chat model without tools (e.g. gemma3:270m) or --plain-model', noThink: 'a chat model without thinking (e.g. gemma3:270m) or --plain-model', embed: 'an embedding model (e.g. all-minilm) or --embed-model' };
  for (const [k, v] of Object.entries(picks)) run.print(`    ${k.padEnd(8)} ${v ? `${v.name}${v.size ? ` (${fmtBytes(v.size)})` : ''} — ${v.why}` : `— none: ${NEED[k]}`}`);
  const C = usable(picks.chat)?.name;
  const show = C ? O.shows.get(C) || (await http(O.url, '/api/show', { method: 'POST', body: { model: C }, timeoutMs: T(15000) })).json : null;
  const tagOf = (name) => O.tags.find((t) => sameModel(t.model || t.name, name)) || null;
  const infoOf = (name, s = O.shows.get(name)) => H.normalizeOllamaShow(name, s || {}, tagOf(name) ? { sizeBytes: tagOf(name).size, digest: tagOf(name).digest } : null);

  await run.check('ollama.show.model_info', async ({ sample }) => {
    need(C && isObj(show), 'no usable chat model', NEED.chat);
    const evaluate = (name, s) => {
      const mi = s?.model_info || {};
      const arch = mi['general.architecture'];
      const issues = [];
      const empties = [];
      if (!arch) issues.push('general.architecture missing');
      for (const k of ['context_length', 'block_count', 'embedding_length', 'attention.head_count']) {
        const key = `${arch}.${k}`;
        const v = mi[key];
        if (v === undefined) issues.push(`${key} missing`);
        else if (Array.isArray(v) ? !v.length : !isNum(v)) { issues.push(`${key}=${excerpt(v, 60)}`); if (Array.isArray(v)) empties.push(key); }
      }
      for (const k of ['attention.head_count_kv', 'attention.key_length', 'attention.value_length', 'attention.sliding_window', 'attention.sliding_window_pattern', 'attention.shared_kv_layers']) {
        const v = mi[`${arch}.${k}`];
        if (Array.isArray(v) && !v.length) { issues.push(`${arch}.${k}=[] (empty array)`); empties.push(`${arch}.${k}`); }
      }
      const info = infoOf(name, s);
      const kv = H.kvCacheModel(info.arch, info.profile, 'f16');
      return { arch, issues, empties, info, kv, hasKv: mi[`${arch}.attention.head_count_kv`] !== undefined };
    };
    const main = evaluate(C, show);
    sample(`ollama /api/show model_info keys (${C})`, Object.fromEntries(Object.entries(show.model_info || {}).filter(([k]) => !/tokenizer/.test(k))));
    const a = main.info.arch;
    const info = [
      `${C}: arch ${main.arch}, context_length ${main.info.advertisedContextLength}, blocks ${a.blockCount}, heads ${excerpt(a.headCount, 40)}/${excerpt(a.headCountKv, 40)} kv, key/value ${a.keyLength}/${a.valueLength}, sliding window ${a.slidingWindow ?? '-'}${a.slidingWindowPattern != null ? ` pattern ${excerpt(a.slidingWindowPattern, 40)}` : ''}`,
      `→ Harness KV estimate (f16): ${fmtBytes(main.kv.perToken)}/token, source ${main.kv.source}, layers full ${main.kv.fullLayers} / sliding ${main.kv.swaLayers}`,
    ];
    const others = [];
    for (const m of O.inventory) {
      if (sameModel(m.name, C) || !m.caps.includes('completion')) continue;
      const e = evaluate(m.name, m.show);
      if (e.issues.length || e.kv.source === 'heuristic' || e.kv.perToken <= 0) others.push(`${m.name}: ${e.issues.join(', ') || `KV estimate ${e.kv.source}, ${e.kv.perToken} B/token`}`);
    }
    if (others.length) info.push(`other installed models with gaps: ${others.join(' | ')}`);
    if (main.empties.length) {
      const v = await http(O.url, '/api/show', { method: 'POST', body: { model: C, verbose: true }, timeoutMs: T(30000) });
      const lens = main.empties.map((k) => `${k}: ${Array.isArray(v.json?.model_info?.[k]) ? `${v.json.model_info[k].length} entries` : 'still missing'}`);
      info.push(`with verbose:true → ${lens.join(', ')}`);
      return FAIL(`per-layer metadata arrives as EMPTY arrays (${main.empties.join(', ')}) — the KV estimate treats them as 0`, { expected: 'numbers or full per-layer arrays', actual: main.issues.join('; '), info, fix: 'Request /api/show with verbose:true in OllamaProvider.show (or treat [] as "unknown" in normalizeOllamaShow/kvCacheModel instead of zero layers).' });
    }
    if (main.kv.perToken <= 0 || main.kv.source === 'heuristic') return FAIL(`Harness could not derive a per-token KV cost from this metadata (source ${main.kv.source}, ${main.kv.perToken} B/token)`, { actual: main.issues.join('; ') || 'see info', expected: 'block_count + head_count(+_kv) + key/value_length or embedding_length', info, fix: 'Extend normalizeOllamaShow to read the keys this architecture uses.' });
    if (main.issues.length || !main.hasKv) return WARN(`metadata gaps: ${main.issues.join(', ') || `${main.arch}.attention.head_count_kv missing (estimate assumes no GQA → too large)`}`, { info, actual: main.issues.join('; ') });
    if (others.length) return WARN(`chat model fine; ${others.length} other model(s) have metadata gaps`, { info });
    return PASS(`${main.arch}: all keys the sizing code reads are present`, { info, observed: { arch: main.info.arch, perTokenF16: main.kv.perToken, kvSource: main.kv.source } });
  });

  await run.check('ollama.show.details', async () => {
    need(C && isObj(show), 'no usable chat model', NEED.chat);
    const d = show.details;
    const bad = isObj(d) ? ['family', 'parameter_size', 'quantization_level'].filter((k) => typeof d[k] !== 'string' || !d[k]) : ['details'];
    if (bad.length) return WARN(`missing: ${bad.join(', ')} (the model card shows "?")`, { actual: d, expected: 'details.family / parameter_size / quantization_level strings' });
    return PASS(`${d.family}, ${d.parameter_size}, ${d.quantization_level}${d.families ? `, families ${JSON.stringify(d.families)}` : ''}`);
  });

  await run.check('ollama.show.parameters', async ({ sample }) => {
    need(C && isObj(show), 'no usable chat model', NEED.chat);
    const text = show.parameters;
    sample(`ollama /api/show parameters (${C})`, text ?? null);
    if (text === undefined || text === null || text === '') return PASS('model has no Modelfile parameters (nothing to parse)');
    if (typeof text !== 'string') return FAIL(`parameters is ${typeof text}, not text`, { actual: text, expected: 'string "key value\\n…"', fix: 'parseModelfileParameters ignores non-strings → model defaults (stop tokens, temperature) would be unknown.' });
    const parsed = H.parseModelfileParameters(text);
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const parsedCount = Object.entries(parsed).reduce((a, [k, v]) => a + (k === 'stop' ? v.length : 1), 0);
    const odd = Object.entries(parsed).filter(([k, v]) => /\s/.test(k) || (typeof v === 'string' && /^".*"$/.test(v)) || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)));
    const info = [`raw: ${excerpt(text, 300)}`, `parsed: ${excerpt(parsed, 300)}`];
    if (parsedCount !== lines.length || odd.length) return WARN(`parsed ${parsedCount} of ${lines.length} lines${odd.length ? `; odd values: ${odd.map(([k]) => k).join(', ')}` : ''}`, { info, actual: text, fix: 'Adjust parseModelfileParameters to this format.' });
    return PASS(`${lines.length} parameter line(s) parsed: ${Object.keys(parsed).join(', ')}`, { info });
  });

  await run.check('ollama.show.unknown_model', async ({ sample }) => {
    const r = await http(O.url, '/api/show', { method: 'POST', body: { model: 'livecheck-no-such-model:latest' }, timeoutMs: T(10000) });
    sample('ollama POST /api/show (unknown model)', { status: r.status, body: r.json ?? r.text ?? r.error });
    const msg = errorOf(r);
    const code = classifyCode(r.status, msg);
    if (r.status === 404 && code === 'model_not_found') return PASS(`HTTP 404 "${excerpt(msg, 120)}" → model_not_found`);
    return FAIL(`HTTP ${r.status} "${excerpt(msg, 160)}" → classified as ${code}`, { expected: 'HTTP 404 {"error":"model … not found"} → model_not_found', actual: r.text ?? r.error, fix: 'Adjust classifyOllamaError to this answer.' });
  });

  // ---- chat with the chat model at num_ctx 2048
  const msgsA = [{ role: 'system', content: ollamaSys }, { role: 'user', content: 'In one short sentence: what colour is the sky on a clear day?' }];
  let A = null;
  await run.check('ollama.chat.stream', async ({ sample }) => {
    need(C, 'no usable chat model', NEED.chat);
    A = await chat(chatBody(C, msgsA, thinkOffFor(C)));
    const { r, p } = A;
    sample(`ollama POST /api/chat stream (${C})`, streamSample(A.body, r, p));
    if (!r.ok) return FAIL(`HTTP ${r.status}: ${excerpt(p.errorText, 300)}`, { expected: 'HTTP 200 NDJSON stream', actual: p.errorText, fix: 'Every chat turn would fail with this error.' });
    const problems = [];
    if (r.error) problems.push(`stream broke: ${r.error}`);
    if (p.bad.length) problems.push(`${p.bad.length} line(s) are not JSON (readNdjson silently drops them): ${excerpt(p.bad[0], 120)}`);
    if (!p.final) problems.push('no line with done:true');
    else if (p.finalIndex !== p.objs.length - 1) problems.push(`${p.objs.length - 1 - p.finalIndex} line(s) after the done:true line (ignored by Harness)`);
    if (p.objs.slice(0, p.finalIndex >= 0 ? p.finalIndex : undefined).some((o) => o.done !== false)) problems.push('a non-final line lacks done:false');
    if (p.errorLine) problems.push(`error line: ${p.errorLine}`);
    if (!p.content) problems.push('no message.content text');
    if (p.final && p.final.message?.role && p.final.message.role !== 'assistant') problems.push(`role ${p.final.message.role}`);
    const ct = r.contentType || '';
    const info = [`${p.objs.length} lines, ${p.content.length} chars, first token after ${fmtMs(p.firstContentMs)}, done_reason ${p.final?.done_reason}`, `content-type: ${ct || '(none)'}`, `reply: ${excerpt(p.content, 160)}`];
    if (p.thinking) info.push(`thinking text present although think:false was sent (${p.thinking.length} chars)`);
    if (problems.length) return FAIL(problems[0], { actual: problems.join('; '), expected: 'JSON per line, done:false chunks with message.content, one final done:true line', info, fix: 'Adapt OllamaProvider.chat / readNdjson to this framing.' });
    if (!['stop', 'length'].includes(p.final.done_reason)) return WARN(`unexpected done_reason "${p.final.done_reason}"`, { info, expected: '"stop" or "length"', fix: 'ChatEngine only distinguishes "length"; other reasons are reported as stop.' });
    if (!/ndjson|json/i.test(ct)) return WARN(`content-type "${ct}" (Harness does not check it)`, { info });
    return PASS(info[0], { info: info.slice(1), data: A });
  }, { timeoutMs: 360000 });

  await run.check('ollama.chat.done_metrics', async () => {
    need(A?.r.ok && A.p.final, 'no successful chat stream', 'ollama.chat.stream to pass');
    const f = A.p.final;
    const missing = ['prompt_eval_count', 'eval_count'].filter((k) => !isInt(f[k]) || f[k] <= 0);
    const missingDur = ['total_duration', 'load_duration', 'prompt_eval_duration', 'eval_duration'].filter((k) => !isNum(f[k]));
    const ratio = isNum(f.total_duration) ? f.total_duration / 1e6 / Math.max(1, A.r.totalMs) : null;
    const tps = isNum(f.eval_duration) && f.eval_duration > 0 ? f.eval_count / (f.eval_duration / 1e9) : null;
    const ptps = isNum(f.prompt_eval_duration) && f.prompt_eval_duration > 0 ? f.prompt_eval_count / (f.prompt_eval_duration / 1e9) : null;
    const info = [`prompt_eval_count ${f.prompt_eval_count}, eval_count ${f.eval_count}, total ${fmtMs(f.total_duration / 1e6)} (client saw ${fmtMs(A.r.totalMs)}), load ${fmtMs(f.load_duration / 1e6)}, prompt ${ptps ? `${ptps.toFixed(0)} tok/s` : '?'}, generation ${tps ? `${tps.toFixed(1)} tok/s` : '?'}`];
    O.evalTps = tps;
    if (missing.length) return FAIL(`${missing.join(', ')} missing or zero in the final chunk`, { actual: excerpt({ ...f, message: undefined }, 600), expected: 'integers > 0', info, fix: 'Without prompt_eval_count the calibrator never learns (engine.mjs observes only when promptTokens is truthy) and the context meter has no "actual"; reconstruct it (e.g. /api/tokenize) or accept the estimate.' });
    if (missingDur.length) return WARN(`${missingDur.join(', ')} missing (speed stats show "?")`, { info, actual: excerpt({ ...f, message: undefined }, 600) });
    if (ratio !== null && (ratio < 1e-3 || ratio > 1e3)) return FAIL(`total_duration is not in nanoseconds (server ${f.total_duration} vs ${Math.round(A.r.totalMs)} ms wall clock)`, { info, fix: 'Fix the ns() conversion in OllamaProvider.chat.' });
    if (ratio !== null && (ratio > 3 || ratio < 0.05)) return WARN(`durations implausible against the wall clock (server total ${fmtMs(f.total_duration / 1e6)} vs client ${fmtMs(A.r.totalMs)})`, { info });
    return PASS(info[0]);
  });

  await run.check('ollama.chat.calibration_ratio', async () => {
    need(A?.p.final?.prompt_eval_count, 'no prompt_eval_count', 'ollama.chat.done_metrics to pass');
    const est = rawEstimate(msgsA);
    const ratio = A.p.final.prompt_eval_count / est;
    const info = [`Harness raw estimate ${est} tokens vs prompt_eval_count ${A.p.final.prompt_eval_count} → ratio ${ratio.toFixed(3)}`];
    if (est < 48) return WARN(`raw estimate ${est} < 48: the calibrator ignores such small prompts`, { info });
    if (ratio < 0.33 || ratio > 3) return WARN(`ratio ${ratio.toFixed(2)} is outside 0.33–3, so Calibrator.observe() throws the sample away`, { info, fix: 'Check whether prompt_eval_count includes the chat template (it should) or whether the estimator is far off for this tokenizer.' });
    return PASS(info[0]);
  });

  await run.check('ollama.chat.prompt_eval_cached', async ({ sample }) => {
    need(A?.p.final?.prompt_eval_count, 'no prompt_eval_count on the first request', 'ollama.chat.done_metrics to pass');
    const Bq = await chat(chatBody(C, msgsA, thinkOffFor(C)));
    const msgsC = [...msgsA, { role: 'assistant', content: A.p.content || 'Blue.' }, { role: 'user', content: 'And at sunset? One short sentence.' }];
    const Cq = await chat(chatBody(C, msgsC, thinkOffFor(C)));
    sample('ollama /api/chat final chunks: first, repeat, extended', { first: { ...A.p.final, message: undefined }, repeat: Bq.p.final ? { ...Bq.p.final, message: undefined } : Bq.p.errorText, extended: Cq.p.final ? { ...Cq.p.final, message: undefined } : Cq.p.errorText });
    O.baselineTtft = Bq.p.firstContentMs ?? Bq.r.totalMs;
    const a = A.p.final.prompt_eval_count;
    const b = Bq.p.final?.prompt_eval_count;
    const c = Cq.p.final?.prompt_eval_count;
    const d = (q) => (isNum(q.p.final?.prompt_eval_duration) ? fmtMs(q.p.final.prompt_eval_duration / 1e6) : '?');
    const info = [`first ${a} tokens (prompt ${d(A)}), identical repeat ${b ?? 'MISSING'} (prompt ${d(Bq)}), extended conversation ${c ?? 'MISSING'} (prompt ${d(Cq)}; estimate ${rawEstimate(msgsC)})`];
    if (!Bq.r.ok || !Cq.r.ok) return FAIL(`follow-up request failed: ${Bq.p.errorText || Cq.p.errorText}`, { info });
    if (!isInt(b) || b <= 0) return FAIL('prompt_eval_count is MISSING on a fully cached repeat', { info, expected: `≈ ${a} (the full prompt)`, actual: excerpt({ ...Bq.p.final, message: undefined }), fix: 'engine.mjs only calibrates when promptTokens is truthy, so cached turns are never observed; fall back to the previous count + estimated delta, or tokenize.' });
    if (b < a * 0.8) return FAIL(`repeat reports ${b} instead of ~${a}: only the uncached tokens are counted`, { info, expected: `≈ ${a}`, fix: 'Calibrator.observe() would learn a far too small ratio (or reject it): treat prompt_eval_count as "evaluated" tokens and track the cached part separately.' });
    if (!isInt(c) || c <= a) return FAIL(`extended conversation reports ${c} ≤ first prompt ${a}: counts exclude the cached prefix`, { info, expected: `> ${a}`, fix: 'Same as above: the context meter and calibration need the full prompt length.' });
    return PASS(info[0]);
  }, { timeoutMs: 360000 });

  await run.check('ollama.chat.done_reason_length', async ({ sample }) => {
    need(C, 'no usable chat model', NEED.chat);
    const q = await chat(chatBody(C, [{ role: 'user', content: 'Write a long story about a dragon who learns to bake bread.' }], { ...thinkOffFor(C), options: { num_predict: 3 } }));
    sample('ollama /api/chat num_predict 3 (final chunk)', q.p.final ? { ...q.p.final } : q.p.errorText);
    if (!q.r.ok) return FAIL(`HTTP ${q.r.status}: ${q.p.errorText}`);
    if (q.p.final?.done_reason === 'length') return PASS(`done_reason "length" after ${q.p.final.eval_count} tokens`);
    return FAIL(`done_reason "${q.p.final?.done_reason}"`, { expected: '"length"', actual: excerpt({ ...q.p.final, message: undefined }), fix: 'ChatEngine marks truncated answers via doneReason === "length"; map this value in OllamaProvider.chat.' });
  }, { timeoutMs: 300000 });

  let ps1 = null;
  let entry1 = null;
  await run.check('ollama.ps.shape', async ({ sample }) => {
    need(A?.r.ok, 'chat model was not loaded', 'ollama.chat.stream to pass');
    ps1 = await psList(O, run);
    sample('ollama GET /api/ps (after chat at num_ctx 2048)', { status: ps1.r.status, body: ps1.r.json ?? ps1.r.text ?? ps1.r.error });
    if (!ps1.models) return FAIL(`/api/ps: ${httpSummary(ps1.r)}`, { expected: '{"models":[…]}' });
    if (ps1.r.ms > 3000) return WARN(`/api/ps took ${fmtMs(ps1.r.ms)} — OllamaProvider.ps() times out after 3 s`, { fix: 'Raise the ps() timeout.' });
    entry1 = psFind(ps1.models, C);
    if (!entry1) return FAIL(`${C} is not listed right after a chat`, { actual: ps1.r.text, expected: `an entry with model "${C}"`, fix: 'measure() finds no entry → no measurements; the image service would not unload it.' });
    const bad = [];
    if (!isNum(entry1.size) || entry1.size <= 0) bad.push(`size=${entry1.size}`);
    if (!isNum(entry1.size_vram)) bad.push(`size_vram=${entry1.size_vram}`);
    if (typeof entry1.expires_at !== 'string') bad.push('expires_at missing');
    if (typeof entry1.digest !== 'string') bad.push('digest missing');
    if (!(entry1.model || entry1.name)) bad.push('model/name missing');
    if (bad.length) return FAIL(`entry fields: ${bad.join(', ')}`, { actual: excerpt(entry1), expected: 'size (bytes) > 0, size_vram, expires_at, digest', fix: 'MeasurementStore.measure needs size; isCpuSplit needs size_vram.' });
    return PASS(`${entry1.model || entry1.name}: size ${fmtBytes(entry1.size)}, size_vram ${fmtBytes(entry1.size_vram)}, context_length ${entry1.context_length ?? 'absent'}, expires ${entry1.expires_at}`);
  });

  await run.check('ollama.ps.context_length', async () => {
    need(entry1, 'no /api/ps entry', 'ollama.ps.shape to pass');
    const v = entry1.context_length;
    if (v === undefined || v === null) return WARN('context_length is absent from /api/ps', { expected: 'context_length: 2048', fix: 'Measurements fall back to the num_ctx Harness sent (fine); after a Harness restart LLM.resolveFor cannot learn the loaded context, so background tasks may reload the model with the plan num_ctx.' });
    if (v === 2048) return PASS('context_length 2048 = options.num_ctx sent with the chat');
    if (v < 2048) return WARN(`context_length ${v} < 2048 sent: the server capped it (Harness then records the reported value)`, { info: ['check OLLAMA_CONTEXT_LENGTH / model limits'] });
    return WARN(`context_length ${v} ≠ 2048 sent`, { expected: '2048', actual: v, fix: 'measure() keeps the sent value when the reported one is larger (e.g. num_ctx × OLLAMA_NUM_PARALLEL); verify which one the memory scales with.' });
  });

  await run.check('ollama.ps.size_vram', async () => {
    need(entry1, 'no /api/ps entry', 'ollama.ps.shape to pass');
    const split = H.isCpuSplit({ totalBytes: entry1.size, vramBytes: entry1.size_vram });
    const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
    if (entry1.size_vram > entry1.size * 1.05) return WARN(`size_vram ${fmtBytes(entry1.size_vram)} > size ${fmtBytes(entry1.size)} (Harness ignores vram > 1.05 × size)`);
    if (split) {
      const pct = Math.round((1 - entry1.size_vram / entry1.size) * 100);
      return WARN(`${pct}% of the model is on the CPU (size_vram ${fmtBytes(entry1.size_vram)} of ${fmtBytes(entry1.size)})${appleSilicon ? ' — unexpected on Apple Silicon' : ' — expected on a machine without a usable GPU'}; Harness will warn "cpu_offload" and cap the context to what fits on the GPU`, { info: [`isCpuSplit() = true`] });
    }
    return PASS(`fully on the GPU (size_vram ${fmtBytes(entry1.size_vram)} = size)`);
  });

  await run.check('ollama.ps.expires_at', async () => {
    need(entry1, 'no /api/ps entry', 'ollama.ps.shape to pass');
    const d = expiresDelta(entry1);
    if (d === null) return FAIL(`expires_at "${entry1.expires_at}" is not a timestamp`, { fix: 'OllamaProvider.ps passes it through as expiresAt; the UI countdown would break.' });
    const want = intendedSeconds(O.keepAlive);
    if (!expiryMatches(d, want)) return WARN(`expires in ${describeSeconds(d)}, but keep_alive ${JSON.stringify(O.keepAlive)} means ${describeSeconds(want)}`, { info: [`expires_at ${entry1.expires_at}`] });
    return PASS(`expires in ${describeSeconds(d)} for keep_alive ${JSON.stringify(O.keepAlive)}`);
  });

  await run.check('ollama.chat.over_context', async ({ sample }) => {
    need(C && A?.r.ok, 'no working chat model', 'ollama.chat.stream to pass');
    const long = `${'The quick brown fox jumps over the lazy dog. '.repeat(380)}Reply with OK.`;
    const q = await chat(chatBody(C, [{ role: 'user', content: long }], { ...thinkOffFor(C), options: { num_predict: 2 } }), { timeoutMs: 600000 });
    sample('ollama /api/chat prompt > num_ctx (final chunk or error)', q.r.ok ? { ...q.p.final, message: undefined } : { status: q.r.status, body: q.p.errorText });
    const est = rawEstimate([{ role: 'user', content: long }]);
    if (!q.r.ok || q.p.errorLine) {
      const msg = q.p.errorText || q.p.errorLine;
      const code = classifyCode(q.r.status || 500, msg);
      if (code === 'context_overflow') return PASS(`rejected: "${excerpt(msg, 150)}" → context_overflow`);
      return FAIL(`rejected with "${excerpt(msg, 200)}" → classified as ${code}`, { expected: 'HTTP 200 with truncation, or an error classified as context_overflow', fix: 'Extend the context_overflow pattern in classifyOllamaError.' });
    }
    const n = q.p.final?.prompt_eval_count;
    if (isInt(n) && n <= 2048) return PASS(`HTTP 200, silently truncated: prompt_eval_count ${n} ≤ num_ctx 2048 (≈${est} tokens sent); the calibrator skips samples ≥ 98 % of num_ctx`);
    return WARN(`HTTP 200 but prompt_eval_count ${n} (> num_ctx 2048?)`, { info: [`estimated prompt ${est} tokens`], fix: 'Check that options.num_ctx is honoured.' });
  }, { timeoutMs: 660000 });

  await run.check('ollama.chat.abort', async ({ sample }) => {
    need(C && A?.r.ok, 'no working chat model', 'ollama.chat.stream to pass');
    let chunks = 0;
    const longBody = chatBody(C, [{ role: 'user', content: 'Count from 1 to 300, separated by spaces, with no other text. long answer 300' }], { ...thinkOffFor(C), options: { num_predict: 400 } });
    const q = await chat(longBody, { onLine: (line) => { try { if (JSON.parse(line).message?.content) chunks++; } catch { /* ignore */ } return chunks >= 5 ? 'stop' : undefined; } });
    const abortedAt = q.r.totalMs;
    const next = await chat(chatBody(C, [{ role: 'user', content: 'Say OK.' }], { ...thinkOffFor(C), options: { num_predict: 1 } }));
    const ttft = next.p.firstContentMs ?? next.r.totalMs;
    const perTok = O.evalTps ? 1000 / O.evalTps : null;
    const remaining = perTok ? (400 - chunks) * perTok : null;
    const base = O.baselineTtft ?? null;
    sample('ollama /api/chat abort experiment', { abortedAfterChunks: chunks, abortErrorName: q.r.abortErrorName, readerError: q.r.error, nextRequestMs: ttft, baselineTtftMs: base, estimatedRemainingGenerationMs: remaining });
    const info = [`aborted after ${chunks} chunks (${fmtMs(abortedAt)}); next request answered after ${fmtMs(ttft)} (warm baseline ${fmtMs(base)}; finishing the 400-token answer would take ~${fmtMs(remaining)})`];
    if (!q.r.aborted && q.p.final) return WARN('the stream finished before 5 content chunks arrived (answer too short to test)', { info });
    if (!next.r.ok) return FAIL(`the request after the abort failed: ${next.p.errorText}`, { info, fix: 'Ollama is left in a bad state by client disconnects.' });
    if (q.r.abortErrorName && !['AbortError', 'closed'].includes(q.r.abortErrorName)) return WARN(`client abort surfaced as ${q.r.abortErrorName} (Harness treats only AbortError as a clean stop)`, { info });
    if (remaining && base != null && remaining > 1500 && ttft > base + remaining * 0.6) return WARN('the next request waited about as long as the aborted answer needed: Ollama kept generating after the client disconnected', { info, fix: 'ChatEngine.stop() only closes the connection; with OLLAMA_NUM_PARALLEL=1 a stopped turn still occupies the model.' });
    return PASS('connection closed cleanly and the model was free right away', { info });
  }, { timeoutMs: 420000 });

  await run.check('ollama.format.json_schema', async ({ sample }) => {
    need(C, 'no usable chat model', NEED.chat);
    const transcript = 'User: Hi! My name is Ada and I live in Lisbon. I prefer short answers.\n\nAssistant: Nice to meet you, Ada!';
    const body = chatBody(C, [{ role: 'system', content: H.memorySystemPrompt() }, { role: 'user', content: H.memoryUserPrompt([], transcript) }], { ...thinkOffFor(C), format: H.MEMORY_SCHEMA, options: { num_predict: 300, temperature: 0.1 } });
    const q = await chat(body);
    sample(`ollama /api/chat format=MEMORY_SCHEMA (${C})`, streamSample(q.body, q.r, q.p));
    if (!q.r.ok) {
      const retried = /format|schema|grammar/i.test(q.p.errorText || '');
      return FAIL(`HTTP ${q.r.status}: ${excerpt(q.p.errorText, 200)}`, { info: [retried ? 'LLM.completeWith would retry without format' : 'LLM.completeWith would NOT retry (text does not match /format|schema|grammar/) → memory extraction fails'], fix: 'Structured output is rejected; adjust MEMORY_SCHEMA or the retry pattern.' });
    }
    let strict = null;
    try { strict = JSON.parse(q.p.content); } catch { /* not strict JSON */ }
    const loose = strict || H.parseJsonLoose(q.p.content);
    const okShape = (j) => isObj(j) && Array.isArray(j.memories) && j.memories.every((m) => isObj(m) && ['add', 'update'].includes(m.action) && typeof m.content === 'string');
    const info = [`content: ${excerpt(q.p.content, 300)}`];
    if (q.p.thinking) info.push(`thinking produced despite think:false (${q.p.thinking.length} chars)`);
    if (!loose) return FAIL('content is not JSON', { info, expected: 'JSON matching MEMORY_SCHEMA', actual: q.p.content, fix: 'format may be ignored by this model/server; extraction would always find nothing.' });
    if (!okShape(loose)) return WARN('JSON does not match MEMORY_SCHEMA', { info, actual: q.p.content });
    if (!strict) return WARN('only the lenient parser could read it (extra text around the JSON)', { info });
    return PASS(`schema-valid JSON with ${loose.memories.length} memor${loose.memories.length === 1 ? 'y' : 'ies'}`, { info });
  }, { timeoutMs: 360000 });

  // ---- num_ctx 4096: does the memory grow, do the samples fit the sizing model?
  let entry2 = null;
  await run.check('ollama.load.generate_empty', async ({ sample }) => {
    need(entry1, 'no /api/ps entry at num_ctx 2048', 'ollama.ps.shape to pass');
    const r = await http(O.url, '/api/generate', { method: 'POST', body: { model: C, keep_alive: O.keepAlive, options: { num_ctx: 4096 } }, timeoutMs: T(300000) });
    const last = (r.text || '').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).at(-1);
    sample('ollama POST /api/generate (load, no prompt)', { request: { model: C, keep_alive: O.keepAlive, options: { num_ctx: 4096 } }, status: r.status, body: last ?? r.text ?? r.error });
    if (!r.ok) return FAIL(`HTTP ${r.status}: ${errorOf(r)}`, { fix: 'OllamaProvider.load() (used by POST /api/models/load and eager reload after images) would fail.' });
    const ps = await psList(O, run);
    entry2 = psFind(ps.models, C);
    sample('ollama GET /api/ps (after load at num_ctx 4096)', ps.r.json ?? ps.r.text);
    if (!entry2) return FAIL('model not listed after the load request');
    if (entry2.context_length != null && entry2.context_length !== 4096) return FAIL(`ps context_length is ${entry2.context_length} after loading with options.num_ctx 4096`, { fix: 'options.num_ctx in /api/generate is not honoured; eager reload would use the wrong window.' });
    return PASS(`done_reason "${last?.done_reason ?? '?'}", reloaded with context_length ${entry2.context_length ?? '(absent)'}, size ${fmtBytes(entry2.size)}`);
  }, { timeoutMs: 360000 });

  await run.check('ollama.ps.size_grows_with_num_ctx', async () => {
    need(entry1 && entry2, 'need /api/ps at num_ctx 2048 and 4096', 'ollama.load.generate_empty to pass');
    const dSize = entry2.size - entry1.size;
    const perTok = dSize / 2048;
    if (dSize <= 0) return FAIL(`size did not grow: ${fmtBytes(entry1.size)} at 2048 → ${fmtBytes(entry2.size)} at 4096`, { expected: 'size(4096) > size(2048)', fix: 'fitMeasurements assumes size = fixed + perToken·num_ctx; with a flat size the fitted slope is clamped to ¼ of the estimate.' });
    O.measuredPerToken = perTok;
    return PASS(`${fmtBytes(entry1.size)} → ${fmtBytes(entry2.size)}: ${fmtBytes(perTok)} per token`);
  });

  await run.check('ollama.ps.measurement_fit', async () => {
    need(entry1 && entry2, 'need two /api/ps samples', 'ollama.ps.size_grows_with_num_ctx');
    const info = infoOf(C);
    const kvType = H.ProviderRegistry.prototype.kvCacheType.call({ ollamaProcess: null }, H.DEFAULT_SETTINGS);
    const kv = H.kvCacheModel(info.arch, info.profile, kvType);
    const modelBytes = tagOf(C)?.size || 0;
    const overhead = H.overheadBytes(modelBytes);
    const estModelOnly = (ctx) => modelBytes + overhead + kv.perToken * ctx + kv.fixedFor(ctx);
    const samples = [{ numCtx: 2048, totalBytes: entry1.size, vramBytes: entry1.size_vram, at: '1' }, { numCtx: 4096, totalBytes: entry2.size, vramBytes: entry2.size_vram, at: '2' }];
    const fit = H.fitMeasurements(samples, { estModelOnly, perToken: kv.perToken, modelBytes });
    const lines = [`estimate (${kvType}): ${fmtBytes(estModelOnly(2048))} at 2K, ${fmtBytes(estModelOnly(4096))} at 4K, ${fmtBytes(kv.perToken)}/token; measured ${fmtBytes(entry1.size)} / ${fmtBytes(entry2.size)}`];
    if (fit) lines.push(`fit: usable ${fit.usable}, method ${fit.method}, rejected ${fit.rejected}, fixed ${fmtBytes(fit.fixedBytes)}, per-token ${fmtBytes(fit.perTokenBytes)}`);
    if (!fit?.usable) return FAIL(`both real samples are rejected by fitMeasurements' sanity limits (0.4–3× the estimate) — Harness would ignore real measurements of this model`, { info: lines, fix: 'The architecture estimate is far off for this model; widen the sanity band or fix kvCacheModel for this architecture.' });
    if (fit.method === 'linear-clamped') return WARN(`measured slope ${fmtBytes(O.measuredPerToken)}/token is outside ¼–4× of the estimate ${fmtBytes(kv.perToken)}/token, so the fit is clamped`, { info: lines, fix: 'kvCacheModel misjudges this architecture (sliding window? KV precision?); see ollama.ps.kv_cache_type.' });
    return PASS(`usable linear fit (${fit.method})`, { info: lines });
  });

  await run.check('ollama.ps.kv_cache_type', async () => {
    need(O.measuredPerToken > 0, 'no measured per-token cost', 'ollama.ps.size_grows_with_num_ctx');
    const info = infoOf(C);
    const assumed = H.ProviderRegistry.prototype.kvCacheType.call({ ollamaProcess: null }, H.DEFAULT_SETTINGS);
    const est = Object.fromEntries(['f16', 'q8_0', 'q4_0'].map((t) => [t, H.kvCacheModel(info.arch, info.profile, t).perToken]));
    const best = Object.entries(est).sort((a, b) => Math.abs(Math.log(O.measuredPerToken / a[1])) - Math.abs(Math.log(O.measuredPerToken / b[1])))[0][0];
    const lines = [`measured ${fmtBytes(O.measuredPerToken)}/token; estimates: ${Object.entries(est).map(([t, v]) => `${t} ${fmtBytes(v)}`).join(', ')} → closest: ${best}; Harness assumes ${assumed}`, 'Note: the slope also contains compute-graph growth, so this is a hint, not proof.'];
    const off = O.measuredPerToken / est[assumed];
    if (best !== assumed && (off < 0.67 || off > 1.5)) return WARN(`measured per-token cost looks like KV cache ${best}, Harness assumes ${assumed}`, { info: lines, fix: 'Harness only sees OLLAMA_KV_CACHE_TYPE in its own environment; for an Ollama it did not start (Ollama.app) it should rely on measurements or ask the user.' });
    return PASS(`consistent with ${assumed}`, { info: lines });
  });

  // ---- keep_alive forms (model is loaded at num_ctx 4096)
  for (const [label, value, intended] of keepAliveForms()) {
    await run.check(`ollama.keep_alive.${label}`, async ({ sample }) => {
      need(entry2 || entry1, 'chat model not loaded', 'ollama.chat.stream to pass');
      const ctx = entry2 ? 4096 : 2048;
      const sent = H.normalizeKeepAlive(value);
      const send = (ka) => http(O.url, '/api/chat', { method: 'POST', body: { model: C, messages: [], stream: false, keep_alive: ka, options: { num_ctx: ctx } }, timeoutMs: T(120000) });
      const r = await send(sent);
      const info = [`Harness sends ${JSON.stringify(sent)}${sent !== value ? ` for the setting ${JSON.stringify(value)} (normalizeKeepAlive)` : ''} → HTTP ${r.status}${r.ok ? '' : ` ${excerpt(errorOf(r), 160)}`}`];
      let raw = null;
      if (sent !== value) {
        raw = await send(value);
        info.push(`raw ${JSON.stringify(value)} straight to Ollama → HTTP ${raw.status}${raw.ok ? '' : ` "${excerpt(errorOf(raw), 160)}"`}`);
      }
      sample(`ollama keep_alive ${JSON.stringify(value)}`, { sent, status: r.status, body: r.json ?? r.text, ...(raw ? { raw: { value, status: raw.status, body: raw.json ?? raw.text } } : {}) });
      if (!r.ok) return FAIL(`keep_alive ${JSON.stringify(sent)} rejected: HTTP ${r.status} "${excerpt(errorOf(r), 200)}"`, { info, expected: 'HTTP 200', actual: r.text ?? r.error, fix: `Every chat with keepAlive ${JSON.stringify(value)} fails. Convert this form before sending (normalizeKeepAlive in ollama.mjs) or reject it in the settings validator (settings.mjs keepAlive).` });
      const ps = await psList(O, run);
      const e = psFind(ps.models, C);
      const d = expiresDelta(e);
      info.push(`ps expires_at ${e?.expires_at ?? '(not listed)'} → ${describeSeconds(d)} from now; intended ${describeSeconds(intended)}`);
      if (!e) return intended < 60 ? PASS('accepted; model already expired (short keep_alive)', { info }) : WARN('accepted, but the model is no longer listed in /api/ps', { info });
      if (!expiryMatches(d, intended)) return WARN(`accepted, but Ollama keeps the model ${describeSeconds(d)} instead of ${describeSeconds(intended)}`, { info, expected: describeSeconds(intended), actual: e.expires_at, fix: 'The setting does not mean what the settings UI says; adjust normalizeKeepAlive or the validator message.' });
      return PASS(`accepted; expires in ${describeSeconds(d)} as intended`, { info });
    }, { timeoutMs: 240000 });
  }
  if (C && (entry1 || entry2)) await http(O.url, '/api/chat', { method: 'POST', body: { model: C, messages: [], stream: false, keep_alive: O.keepAlive, options: { num_ctx: entry2 ? 4096 : 2048 } }, timeoutMs: T(60000) });

  await run.check('ollama.unload.chat', async ({ sample }) => {
    need(C && (entry1 || entry2), 'chat model not loaded', 'ollama.chat.stream to pass');
    const t0 = nowMs();
    const r = await http(O.url, '/api/generate', { method: 'POST', body: { model: C, keep_alive: 0 }, timeoutMs: T(60000) });
    sample('ollama POST /api/generate keep_alive 0 (unload)', { status: r.status, body: r.json ?? r.text ?? r.error, ms: Math.round(r.ms) });
    if (!r.ok) return FAIL(`unload request failed: HTTP ${r.status} ${errorOf(r)}`, { fix: 'OllamaProvider.unload throws; the image service would generate next to the resident LLM.' });
    const w = await waitGone(O, run, C, T(30000));
    const info = [`unload answered after ${fmtMs(r.ms)} (done_reason ${r.json?.done_reason ?? '?'}); /api/ps stopped listing it after ${fmtMs(nowMs() - t0)} (${w.polls} polls)`];
    O.unloadMs = w.ms + r.ms;
    if (r.ms > 15000) return FAIL(`the unload request took ${fmtMs(r.ms)} (> 15 s timeout of OllamaProvider.unload)`, { info });
    if (!w.gone) return FAIL(`still listed in /api/ps after ${fmtMs(w.ms)}`, { info, fix: 'keep_alive:0 does not unload; use another unload path.' });
    if (r.json?.done_reason && r.json.done_reason !== 'unload') return WARN(`done_reason "${r.json.done_reason}" (expected "unload")`, { info });
    if (nowMs() - t0 > 1000) return WARN(`unloading is asynchronous: the model stayed in /api/ps for ${fmtMs(nowMs() - t0)} after the request`, { info, fix: 'ImageService starts the diffusion job right after unload() resolves; on 8 GB both models are briefly resident. Poll /api/ps until the model is gone (with a timeout) before generating.' });
    return PASS(`gone from /api/ps after ${fmtMs(nowMs() - t0)}`, { info });
  }, { timeoutMs: 180000 });

  // ---- thinking
  const TH = usable(picks.think)?.name;
  await run.check('ollama.think.on', async ({ sample }) => {
    need(TH, 'no model with "thinking" installed', NEED.think);
    const q = await chat(chatBody(TH, [{ role: 'user', content: 'What is 12 + 30? Answer with just the number.' }], { think: true, options: { num_predict: 400 } }));
    sample(`ollama /api/chat think:true (${TH})`, streamSample(q.body, q.r, q.p));
    if (!q.r.ok) return FAIL(`HTTP ${q.r.status}: ${q.p.errorText}`, { fix: `resolveThink sends think:true to this model (capabilities include thinking); the turn would fail${/think/i.test(q.p.errorText || '') ? ', or retry without thinking' : ''}.` });
    const info = [`thinking ${q.p.thinking.length} chars (first after ${fmtMs(q.p.firstThinkingMs)}), content ${excerpt(q.p.content, 80)}`];
    if (q.p.thinking) return PASS(`message.thinking streamed separately (${q.p.thinking.length} chars)`, { info });
    if (/<think>/i.test(q.p.content)) return WARN('reasoning came inline as <think> tags in content, not in message.thinking (ThinkTagParser copes)', { info });
    return WARN('no thinking text at all', { info, fix: 'The model may not think for trivial prompts; Harness shows no reasoning then.' });
  }, { timeoutMs: 360000 });

  await run.check('ollama.think.off', async ({ sample }) => {
    need(TH, 'no model with "thinking" installed', NEED.think);
    const q = await chat(chatBody(TH, [{ role: 'user', content: 'What is 12 + 30? Answer with just the number.' }], { think: false, options: { num_predict: 64 } }));
    sample(`ollama /api/chat think:false (${TH})`, streamSample(q.body, q.r, q.p));
    if (!q.r.ok) return FAIL(`HTTP ${q.r.status}: ${q.p.errorText}`, { fix: 'LLM.completeWith sends think:false for internal tasks; they would all fail.' });
    if (q.p.thinking) return WARN(`thinking still produced (${q.p.thinking.length} chars) with think:false — internal tasks pay for it in tokens/time`, { info: [`content: ${excerpt(q.p.content, 100)}`] });
    if (/<think>/i.test(q.p.content)) return WARN('content contains <think> tags with think:false (stripThinking removes them)', { info: [excerpt(q.p.content, 160)] });
    return PASS(`no thinking; content "${excerpt(q.p.content, 60)}"`);
  }, { timeoutMs: 300000 });

  await run.check('ollama.think.level', async ({ sample }) => {
    need(TH, 'no model with "thinking" installed', NEED.think);
    const q = await chat(chatBody(TH, [{ role: 'user', content: 'What is 2 + 2?' }], { think: 'low', options: { num_predict: 200 } }));
    sample(`ollama /api/chat think:"low" (${TH})`, streamSample(q.body, q.r, q.p));
    if (q.r.ok) return PASS(`accepted (thinking ${q.p.thinking.length} chars)`);
    const code = classifyCode(q.r.status, q.p.errorText);
    if (code === 'thinking_unsupported') return WARN(`rejected: "${excerpt(q.p.errorText, 160)}" → thinking_unsupported, so Harness retries with think omitted and loses the reasoning level`, { fix: 'For reasoning.think low/medium/high on non-gpt-oss models, retry with think:true (not undefined) or only send levels to models that support them.', actual: q.p.errorText });
    return FAIL(`rejected: "${excerpt(q.p.errorText, 160)}" → ${code}: the turn fails for reasoning.think "${'low'}"`, { actual: q.p.errorText, fix: 'Map this error to thinking_unsupported (classifyOllamaError) or send booleans only.' });
  }, { timeoutMs: 300000 });

  const NT = usable(picks.noThink)?.name;
  await run.check('ollama.think.unsupported_error', async ({ sample }) => {
    need(NT, 'every installed chat model has "thinking"', NEED.noThink);
    const q = await chat(chatBody(NT, [{ role: 'user', content: 'hi' }], { think: true, options: { num_predict: 1 } }));
    sample(`ollama /api/chat think:true on ${NT} (no thinking)`, { status: q.r.status, body: q.r.ok ? q.p.objs.slice(-1) : (q.r.json ?? q.r.bodyText) });
    if (q.r.ok) return WARN(`accepted silently (HTTP 200) — harmless because resolveThink only sends think to models whose capabilities include "thinking"`, { info: [`model ${NT}`] });
    const code = classifyCode(q.r.status, q.p.errorText);
    if (code === 'thinking_unsupported') return PASS(`HTTP ${q.r.status} "${excerpt(q.p.errorText, 160)}" → thinking_unsupported (retry path works)`);
    return FAIL(`HTTP ${q.r.status} "${excerpt(q.p.errorText, 160)}" → ${code}`, { expected: 'text matching /does not support thinking|think.*not supported/', actual: q.p.errorText, fix: 'Update the thinking_unsupported pattern in classifyOllamaError to this exact text.' });
  }, { timeoutMs: 300000 });

  // ---- tools
  const TM = usable(picks.tool)?.name;
  let toolCall = null;
  const toolMsgs = [{ role: 'system', content: 'You are a helpful assistant. Use the provided tools when they help.' }, { role: 'user', content: 'Use a tool to calculate 17*23' }];
  await run.check('ollama.tools.call', async ({ sample }) => {
    need(TM, 'no model with "tools" installed', NEED.tool);
    const q = await chat(chatBody(TM, toolMsgs, { ...thinkOffFor(TM), tools: toolsSchema(), options: { num_predict: 256 } }));
    sample(`ollama /api/chat tools (${TM})`, streamSample(q.body, q.r, q.p));
    if (!q.r.ok) return FAIL(`HTTP ${q.r.status}: ${q.p.errorText}`, { fix: 'The capability says "tools", but the request fails.' });
    const info = [];
    if (!q.p.toolCalls.length) {
      const textual = /"name"\s*:\s*"calculate"|<tool_call>|\bcalculate\s*\(/i.test(q.p.content);
      if (textual) return FAIL('the tool call came back as TEXT in message.content, not in message.tool_calls', { actual: q.p.content, fix: "Ollama's template did not parse this model's tool-call format; Harness would show raw JSON instead of running the tool." });
      return WARN('the model answered without calling the tool (model behaviour, not an API mismatch)', { info: [`content: ${excerpt(q.p.content, 200)}`] });
    }
    const tc = q.p.toolCalls[0];
    toolCall = tc;
    const fn = tc.function || {};
    info.push(`tool_calls arrived in line(s) ${q.p.toolCallChunks.map((c) => `${c.index}${c.done ? ' (final)' : ''}`).join(', ')} of ${q.p.objs.length}; id ${tc.id ? `"${tc.id}"` : 'absent'}; function.index ${fn.index ?? 'absent'}`);
    info.push(`call: ${excerpt(tc, 300)}`);
    if (fn.name !== 'calculate') return WARN(`called "${fn.name}" instead of "calculate"`, { info });
    if (typeof fn.arguments === 'string') {
      let parsed = null;
      try { parsed = JSON.parse(fn.arguments); } catch { /* not JSON */ }
      return WARN(`function.arguments is a STRING (${parsed ? 'valid JSON' : 'not even JSON'}) — parseArgs() ${parsed ? 'parses it, so Harness copes' : 'wraps it as {_raw}, the tool gets no expression'}; the fakes send an object`, { info, expected: 'arguments as a JSON object', actual: fn.arguments, fix: 'Make test/fake-ollama.mjs (and docs) reflect string arguments if this is real.' });
    }
    if (!isObj(fn.arguments)) return FAIL(`function.arguments is ${JSON.stringify(fn.arguments)}`, { info, expected: 'an object', fix: 'parseArgs() returns {} → the tool runs without arguments.' });
    if (typeof fn.arguments.expression !== 'string') return WARN(`arguments ${JSON.stringify(fn.arguments)} lack "expression"`, { info });
    return PASS(`calculate(${JSON.stringify(fn.arguments)}), arguments as an object`, { info });
  }, { timeoutMs: 360000 });

  await run.check('ollama.tools.result_roundtrip', async ({ sample }) => {
    need(TM && toolCall, 'no tool call to answer', 'ollama.tools.call to produce a call');
    const args = H.parseArgs(toolCall.function?.arguments);
    const msgs = [...toolMsgs, { role: 'assistant', content: '', tool_calls: [{ function: { name: toolCall.function.name, arguments: args } }] }, { role: 'tool', content: '17*23 = 391', tool_name: toolCall.function.name }];
    const q = await chat(chatBody(TM, msgs, { ...thinkOffFor(TM), tools: toolsSchema(), options: { num_predict: 128 } }));
    sample(`ollama /api/chat tool result round trip (${TM})`, streamSample(q.body, q.r, q.p));
    if (!q.r.ok) return FAIL(`HTTP ${q.r.status}: ${q.p.errorText}`, { fix: 'toOllamaMessage() output (tool_calls + role "tool" + tool_name) is rejected.' });
    if (!q.p.content && q.p.toolCalls.length) return WARN('the model called a tool again instead of answering', { info: [excerpt(q.p.toolCalls, 200)] });
    if (!q.p.content) return FAIL('empty answer after the tool result', { actual: excerpt(q.p.final), fix: 'Check that tool_name / role "tool" are understood by this Ollama version.' });
    if (!q.p.content.includes('391')) return WARN(`answer does not mention 391: "${excerpt(q.p.content, 160)}"`);
    return PASS(`final answer uses the result: "${excerpt(q.p.content, 100)}"`);
  }, { timeoutMs: 300000 });

  const PL = usable(picks.plain)?.name;
  await run.check('ollama.tools.unsupported_error', async ({ sample }) => {
    need(PL, 'every installed chat model has "tools"', NEED.plain);
    const q = await chat(chatBody(PL, [{ role: 'user', content: 'hi' }], { tools: toolsSchema(), options: { num_predict: 1 } }));
    sample(`ollama /api/chat tools on ${PL} (no tools)`, { status: q.r.status, body: q.r.ok ? q.p.objs.slice(-1) : (q.r.json ?? q.r.bodyText) });
    if (q.r.ok) return WARN('accepted silently (HTTP 200): Harness would never notice — harmless because toolsFor() offers tools only to models whose capabilities include "tools"');
    const code = classifyCode(q.r.status, q.p.errorText);
    if (code === 'tools_unsupported') return PASS(`HTTP ${q.r.status} "${excerpt(q.p.errorText, 160)}" → tools_unsupported`);
    return FAIL(`HTTP ${q.r.status} "${excerpt(q.p.errorText, 160)}" → ${code}`, { expected: 'text matching /does not support tools/', actual: q.p.errorText, fix: 'Update the tools_unsupported pattern in classifyOllamaError.' });
  }, { timeoutMs: 300000 });

  // ---- embeddings
  const E = usable(picks.embed)?.name;
  let embedLoaded = false;
  await run.check('ollama.embed.batch', async ({ sample }) => {
    need(E, 'no embedding model installed', NEED.embed);
    const input = ['The cat sat on the mat.', 'A dog runs in the park.'];
    const r = await http(O.url, '/api/embed', { method: 'POST', body: { model: E, input, keep_alive: H.normalizeKeepAlive('10m') }, timeoutMs: T(180000) });
    sample(`ollama POST /api/embed (${E})`, { request: { model: E, input }, status: r.status, body: r.json ?? r.text ?? r.error });
    if (!r.ok) return FAIL(`HTTP ${r.status}: ${errorOf(r)}`, { fix: 'Embedder.embed falls back to BM25 for 30 s after every failure.' });
    O.used.add(E);
    embedLoaded = true;
    const em = r.json?.embeddings;
    if (!Array.isArray(em) || em.length !== 2) return FAIL(`embeddings has ${Array.isArray(em) ? em.length : 'no'} entries for 2 inputs`, { actual: excerpt(r.json, 300), fix: 'Embedder.embed throws "embedding count mismatch".' });
    if (!em.every((v) => Array.isArray(v) && v.length && v.every(isNum))) return FAIL('vectors are not number arrays', { actual: excerpt(em, 200) });
    if (em[0].length !== em[1].length) return FAIL(`different dimensions ${em[0].length} vs ${em[1].length}`);
    const cat = H.embeddingProfileFor(E);
    const note = cat.dims && cat.dims !== em[0].length ? ` (catalog says ${cat.dims}; informational, Harness does not use it)` : '';
    if (r.ms > 120000) return FAIL(`took ${fmtMs(r.ms)} (> 120 s timeout)`);
    return PASS(`2 × ${em[0].length} dims in ${fmtMs(r.ms)}${note}`);
  }, { timeoutMs: 240000 });

  await run.check('ollama.embed.chat_rejected', async ({ sample }) => {
    need(E, 'no embedding model installed', NEED.embed);
    const q = await chat({ model: E, messages: [{ role: 'user', content: 'hi' }], stream: true, options: { num_predict: 1 } }, { timeoutMs: 60000 });
    sample(`ollama /api/chat on embedding model ${E}`, { status: q.r.status, body: q.r.ok ? q.p.objs.slice(-1) : (q.r.json ?? q.r.bodyText) });
    if (q.r.ok) return WARN('an embedding model accepted a chat request', { info: [excerpt(q.p.content, 100)] });
    const code = classifyCode(q.r.status, q.p.errorText);
    if (code === 'not_chat_model') return PASS(`HTTP ${q.r.status} "${excerpt(q.p.errorText, 120)}" → not_chat_model`);
    return WARN(`HTTP ${q.r.status} "${excerpt(q.p.errorText, 160)}" → ${code} (Harness checks capabilities first, so only the message shown differs)`);
  }, { timeoutMs: 90000 });

  await run.check('ollama.unload.embedding', async ({ sample }) => {
    need(E && embedLoaded, 'embedding model not loaded', 'ollama.embed.batch to pass');
    const before = await psList(O, run);
    if (!psFind(before.models, E)) return WARN(`${E} is not listed in /api/ps after /api/embed (keep_alive 10m) — cannot test unloading`, { info: [excerpt(before.r.json, 200)] });
    const t0 = nowMs();
    const g = await http(O.url, '/api/generate', { method: 'POST', body: { model: E, keep_alive: 0 }, timeoutMs: T(30000) });
    const gMsg = g.ok ? null : errorOf(g);
    const gCode = g.ok ? null : classifyCode(g.status, gMsg);
    sample(`ollama POST /api/generate keep_alive 0 on embedding model ${E}`, { status: g.status, body: g.json ?? g.text ?? g.error });
    const info = [`/api/generate keep_alive 0 → HTTP ${g.status}${g.ok ? ` done_reason ${g.json?.done_reason ?? '?'}` : ` "${excerpt(gMsg, 140)}" → ${gCode}`}`];
    const fallbackWouldRun = !g.ok && (gCode === 'not_chat_model' || /embed/i.test(gMsg || ''));
    if (!g.ok && !fallbackWouldRun) return FAIL(`OllamaProvider.unload() would throw: the generate error "${excerpt(gMsg, 160)}" does not trigger the /api/embed fallback`, { info, fix: 'Match this text in OllamaProvider.unload (or check capabilities and go straight to /api/embed for embedding models).' });
    let w = await waitGone(O, run, E, T(3000));
    if (!w.gone) {
      const prov = new H.OllamaProvider({ baseUrl: O.url });
      let err = null;
      try { await prov.unload(E); } catch (e) { err = e; }
      info.push(`OllamaProvider.unload() ${err ? `threw: ${err.message}` : 'returned'}`);
      if (err) return FAIL(`OllamaProvider.unload() threw: ${err.message}`, { info });
      w = await waitGone(O, run, E, T(30000));
    } else info.push('the generate call alone unloaded it');
    info.push(`gone from /api/ps after ${fmtMs(nowMs() - t0)}`);
    if (!w.gone) return FAIL(`${E} is still loaded ${fmtMs(nowMs() - t0)} after unloading`, { info, fix: 'Neither path unloads embedding models; on 8 GB they stay next to the diffusion model.' });
    return PASS(`unloaded in ${fmtMs(nowMs() - t0)}${fallbackWouldRun ? ' via the /api/embed fallback' : ''}`, { info });
  }, { timeoutMs: 120000 });

  // ---- errors
  await run.check('ollama.errors.chat_unknown_model', async ({ sample }) => {
    const q = await chat({ model: 'livecheck-no-such-model:latest', messages: [{ role: 'user', content: 'hi' }], stream: true }, { timeoutMs: 30000 });
    sample('ollama /api/chat unknown model', { status: q.r.status, body: q.r.json ?? q.r.bodyText ?? q.r.error });
    const code = classifyCode(q.r.status, q.p.errorText);
    if (q.r.status === 404 && code === 'model_not_found') return PASS(`HTTP 404 "${excerpt(q.p.errorText, 120)}" → model_not_found`);
    return FAIL(`HTTP ${q.r.status} "${excerpt(q.p.errorText, 160)}" → ${code}`, { expected: 'HTTP 404 → model_not_found', fix: 'Adjust classifyOllamaError.' });
  });

  await run.check('ollama.errors.delete_unknown_model', async ({ sample }) => {
    const r = await http(O.url, '/api/delete', { method: 'DELETE', body: { model: 'livecheck-no-such-model:latest' }, timeoutMs: T(15000) });
    sample('ollama DELETE /api/delete unknown model', { status: r.status, body: r.json ?? r.text ?? r.error });
    if (r.status === 404) return PASS(`HTTP 404 "${excerpt(errorOf(r), 120)}"`);
    return WARN(`HTTP ${r.status} "${excerpt(errorOf(r), 160)}"`, { expected: 'HTTP 404', fix: 'DELETE /api/models would report this status for a vanished model.' });
  });

  await run.check('ollama.errors.pull_unknown_model', async ({ sample }) => {
    const r = await streamLines(`${O.url}/api/pull`, { body: { model: 'livecheck-no-such-model-0:latest', stream: true }, timeoutMs: T(60000) });
    const p = parseOllamaStream(r);
    sample('ollama POST /api/pull unknown model', r.ok ? { status: r.status, lines: p.objs } : { status: r.status, body: r.json ?? r.bodyText ?? r.error });
    const msg = r.ok ? p.errorLine : p.errorText;
    if (!msg) return FAIL(`no error for a non-existent model (${r.ok ? `${p.objs.length} lines, last ${excerpt(p.objs.at(-1))}` : r.error})`, { fix: 'OllamaProvider.pull only fails on an {error} line.' });
    const code = r.ok ? (/not found|does not exist|manifest/i.test(msg) ? 'model_not_found' : 'provider_error') : classifyCode(r.status, msg);
    const offline = /dial tcp|lookup|no such host|connection refused|i\/o timeout|tls|certificate|network is unreachable|EOF/i.test(msg);
    const info = [`${r.ok ? `HTTP 200 stream, error line after ${p.objs.length - 1} status line(s)` : `HTTP ${r.status}`}: "${excerpt(msg, 200)}" → ${code}`];
    if (offline) return WARN('the registry is unreachable from here, so the real "not found" text could not be captured', { info, fix: code === 'model_not_found' ? 'Note: this network error is classified as model_not_found because it contains "manifest" — the UI would say the model does not exist when the machine is offline. Match network errors first in OllamaProvider.pull.' : undefined });
    if (code === 'model_not_found') return PASS(info[0]);
    return FAIL(`error "${excerpt(msg, 160)}" is classified as ${code}`, { info, expected: 'model_not_found', fix: 'Extend the pattern in OllamaProvider.pull.' });
  }, { timeoutMs: 90000 });

  // ---- pulls (side effects; opt-in)
  const PM = run.opts.pullModel;
  await run.check('ollama.pull.new', async ({ sample }) => {
    need(run.opts.allowPull, 'pulling is off by default', `--allow-pull (downloads ${PM}, deleted again at the end)`);
    if ([...O.installedBefore].some((m) => sameModel(m, PM))) return SKIP(`${PM} is already installed — not pulled (and it will not be deleted)`, 'a --pull-model that is not installed');
    const r = await streamLines(`${O.url}/api/pull`, { body: { model: PM, stream: true }, timeoutMs: T(1800000) });
    const p = parseOllamaStream(r);
    sample(`ollama POST /api/pull ${PM}`, { status: r.status, lines: p.objs.length > 12 ? [...p.objs.slice(0, 6), `…(${p.objs.length - 9} more)…`, ...p.objs.slice(-3)] : p.objs });
    if (!r.ok || p.errorLine) return FAIL(`pull failed: ${p.errorLine || p.errorText}`);
    const prog = p.objs.filter((o) => o.digest || isNum(o.total));
    const bad = prog.filter((o) => !isNum(o.total) || (o.completed !== undefined && !isNum(o.completed)) || (isNum(o.completed) && o.completed > o.total));
    const last = p.objs.at(-1)?.status;
    const tags2 = await http(O.url, '/api/tags', { timeoutMs: T(15000) });
    const present = (tags2.json?.models || []).some((m) => sameModel(m.model || m.name, PM));
    if (present) O.pulledByUs.add(PM);
    const info = [`${p.objs.length} lines, ${prog.length} with digest/total/completed, statuses: ${[...new Set(p.objs.map((o) => String(o.status).replace(/[0-9a-f]{12}/, '<digest>')))].join(' → ')}`];
    if (last !== 'success') return FAIL(`last status "${last}"`, { info, expected: '"success"' });
    if (!present) return FAIL('pull said success but the model is not in /api/tags', { info });
    if (!prog.length) return WARN('no progress lines with total/completed (the progress bar would stay empty)', { info });
    if (bad.length) return WARN(`${bad.length} progress line(s) with odd total/completed`, { info, actual: excerpt(bad[0]) });
    return PASS(`downloaded in ${fmtMs(r.totalMs)}`, { info });
  }, { timeoutMs: 1900000 });

  await run.check('ollama.pull.already_present', async ({ sample }) => {
    need(run.opts.allowPull, 'pulling is off by default', '--allow-pull');
    need(O.pulledByUs.has(PM), `${PM} was not pulled by this run (re-pulling a model the user installed could download an update)`, 'a --pull-model that is not installed yet');
    const r = await streamLines(`${O.url}/api/pull`, { body: { model: PM, stream: true }, timeoutMs: T(600000) });
    const p = parseOllamaStream(r);
    sample(`ollama POST /api/pull ${PM} (already present)`, { status: r.status, lines: p.objs.length > 12 ? [...p.objs.slice(0, 6), '…', ...p.objs.slice(-3)] : p.objs });
    if (!r.ok || p.errorLine) return FAIL(`pull failed: ${p.errorLine || p.errorText}`);
    const prog = p.objs.filter((o) => isNum(o.total));
    const full = prog.filter((o) => o.completed === o.total).length;
    const info = [`${p.objs.length} lines, ${prog.length} with total (${full} already complete), took ${fmtMs(r.totalMs)}`];
    if (p.objs.at(-1)?.status !== 'success') return FAIL(`last status "${p.objs.at(-1)?.status}"`, { info });
    return PASS(info[0]);
  }, { timeoutMs: 700000 });
}

// =============================================================================================== OpenAI-compatible
function parseOaiStream(r) {
  const out = { events: 0, chunks: [], bad: [], done: false, afterDone: 0, content: '', reasoning: '', reasoningKeys: new Set(), otherReasoningKeys: new Set(), deltaKeys: new Set(), finish: null, usage: null, timings: null, toolDeltas: [], errorObj: null, errorText: null };
  const evs = sseEvents(r.lines || []);
  out.events = evs.length;
  for (const e of evs) {
    if (out.done) { out.afterDone++; continue; }
    if (e.data === '[DONE]') { out.done = true; continue; }
    let j;
    try { j = JSON.parse(e.data); } catch { out.bad.push(e.data); continue; }
    out.chunks.push(j);
    if (j.error) out.errorObj = j.error;
    if (j.usage) out.usage = j.usage;
    if (j.timings) out.timings = j.timings;
    const ch = j.choices?.[0];
    if (!ch) continue;
    const d = ch.delta || ch.message || {};
    for (const k of Object.keys(d)) out.deltaKeys.add(k);
    if (typeof d.content === 'string') out.content += d.content;
    for (const k of ['reasoning_content', 'reasoning']) if (typeof d[k] === 'string' && d[k]) { out.reasoning += d[k]; out.reasoningKeys.add(k); }
    for (const k of Object.keys(d)) if (/reason|think/i.test(k) && !['reasoning_content', 'reasoning'].includes(k) && d[k]) out.otherReasoningKeys.add(k);
    for (const tc of d.tool_calls || []) out.toolDeltas.push(tc);
    if (ch.finish_reason) out.finish = ch.finish_reason;
  }
  if (!r.ok) {
    const j = r.json;
    const m = j?.error?.message || j?.error || j?.message || r.bodyText || r.error || `HTTP ${r.status}`;
    out.errorText = typeof m === 'string' ? m : JSON.stringify(m);
  }
  return out;
}
/** Assemble tool-call deltas exactly like OpenAICompatProvider.chat. */
function assembleToolCalls(deltas) {
  const calls = new Map();
  for (const tc of deltas) {
    const idx = tc.index ?? calls.size;
    const cur = calls.get(idx) || { id: null, name: '', args: '' };
    if (tc.id) cur.id = tc.id;
    if (tc.function?.name) cur.name += tc.function.name;
    if (tc.function?.arguments) cur.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
    calls.set(idx, cur);
  }
  return [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => {
    let args = {};
    let parsed = true;
    if (c.args.trim()) { try { args = JSON.parse(c.args); } catch { args = { _raw: c.args }; parsed = false; } }
    return { ...c, arguments: args, parsed };
  });
}
function oaiSample(body, r, s) {
  const chunks = s.chunks.length > 8 ? [...s.chunks.slice(0, 4), `…(${s.chunks.length - 6} more chunks)…`, ...s.chunks.slice(-2)] : s.chunks;
  return { request: body, status: r.status, contentType: r.contentType, ...(r.ok ? { chunks, done: s.done } : { body: r.json ?? r.bodyText }), error: r.error || undefined };
}

function pickOaiModel(run, S, models, lm) {
  const ids = models.map((m) => m.id).filter((x) => typeof x === 'string');
  const chatIds = ids.filter((x) => !H.EMBEDDING_NAME_RE.test(x));
  if (run.opts.openaiModel) return { model: run.opts.openaiModel, why: `--openai-model${ids.includes(run.opts.openaiModel) ? '' : ' (not listed by /v1/models!)'}` };
  if (S.flavor === 'lmstudio') {
    const loaded = (lm?.data || []).filter((m) => ['llm', 'vlm'].includes(m.type) && m.state === 'loaded');
    if (loaded[0]) return { model: loaded[0].id, why: 'the LLM currently loaded in LM Studio' };
    return { model: null, why: 'no LLM is loaded in LM Studio (asking for one would JIT-load it: pass --openai-model to allow that)' };
  }
  if (S.flavor === 'llamacpp' && chatIds[0]) return { model: chatIds[0], why: 'the model llama-server serves' };
  if (chatIds.length === 1) return { model: chatIds[0], why: 'the only model listed' };
  return { model: null, why: `${chatIds.length} models listed and the server may load on demand — pass --openai-model` };
}

async function openaiGroup(run, S) {
  const T = (ms) => run.T(ms);
  const key = run.opts.apiKey;
  const id = (s) => `openai.${S.sid}.${s}`;
  run.section('raw', `OpenAI-compatible "${S.sid}" (${S.flavor}) ${S.url}`);
  const oaiChat = async (body, { timeoutMs = 300000 } = {}) => {
    const r = await streamLines(`${S.url}/v1/chat/completions`, { body, timeoutMs: T(timeoutMs), apiKey: key });
    return { r, s: parseOaiStream(r), body };
  };
  let models = [];
  await run.check(id('models'), async ({ sample }) => {
    const r = await http(S.url, '/v1/models', { timeoutMs: T(10000), apiKey: key });
    sample(`${S.sid} GET /v1/models`, { status: r.status, body: r.json ?? r.text ?? r.error });
    if (!r.ok || !Array.isArray(r.json?.data)) return FAIL(`/v1/models: ${httpSummary(r)}`, { expected: '{"data":[{"id":…}]}', fix: 'OpenAICompatProvider.status() treats this server as down.' });
    models = r.json.data;
    if (models.some((m) => typeof m.id !== 'string')) return FAIL('entries without a string id', { actual: excerpt(models, 300) });
    const info = models.slice(0, 6).map((m) => `${m.id}${m.meta ? ` meta ${excerpt(m.meta, 160)}` : ''}`);
    if (r.ms > 1500) return WARN(`answered after ${fmtMs(r.ms)}; status() gives up after 1.5 s`, { info });
    return PASS(`${models.length} model(s)`, { info });
  });
  const lmr = S.flavor === 'lmstudio' ? await http(S.url, '/api/v0/models', { timeoutMs: T(5000), apiKey: key }) : null;
  const pick = pickOaiModel(run, S, models, lmr?.json);
  (run.picks.openai ||= {})[S.sid] = pick;
  run.print(`    picked: ${pick.model || '—'} (${pick.why})`);
  const M = pick.model;

  await run.check(id('context_source'), async ({ sample }) => {
    need(models.length, 'no models listed', `${id('models')} to pass`);
    const props = await http(S.url, '/props', { timeoutMs: T(5000), apiKey: key });
    sample(`${S.sid} GET /props`, { status: props.status, body: props.json ? shrink({ ...props.json, chat_template: props.json.chat_template ? `${String(props.json.chat_template).slice(0, 200)}…` : undefined }) : props.text ?? props.error });
    if (lmr) sample(`${S.sid} GET /api/v0/models`, { status: lmr.status, body: lmr.json ?? lmr.text });
    const prov = new H.OpenAICompatProvider({ id: S.sid, name: S.sid, baseUrl: S.url, apiKey: key, flavor: S.flavor });
    await prov.status().catch(() => null);
    const si = await prov.serverInfo({ refresh: true }).catch((e) => ({ error: e.message, models: {} }));
    const list = await prov.listModels().catch(() => []);
    const entry = list.find((m) => m.model === M) || list[0] || { model: M };
    const info = H.normalizeOpenAIModel(prov, entry, si);
    const plan = H.computeContextPlan({ providerKind: 'openai', serverCtx: info.serverContext, modelMax: info.contextLength, modelMaxSource: info.contextLengthSource, advertisedMax: info.advertisedContextLength, modelBytes: info.sizeBytes || 0, system: { totalMem: os.totalmem(), platform: process.platform, arch: process.arch } });
    const lines = [`flavor after status(): ${prov.flavor}; /props → HTTP ${props.status}${props.json?.default_generation_settings?.n_ctx ? ` n_ctx ${props.json.default_generation_settings.n_ctx}` : ''}${props.json?.n_ctx ? ` top-level n_ctx ${props.json.n_ctx}` : ''}`,
      `Harness: serverContext ${info.serverContext ?? 'unknown'}, model max ${info.contextLength ?? 'unknown'} (${info.contextLengthSource}), plan num_ctx ${plan.numCtx} — "${plan.explanation}"`];
    if (lmr) lines.push(`LM Studio /api/v0/models → HTTP ${lmr.status}${lmr.json?.data ? `: ${lmr.json.data.slice(0, 4).map((m) => `${m.id} ${m.type} ${m.state} max ${m.max_context_length} loaded ${m.loaded_context_length ?? 'absent'}`).join(' | ')}` : ''}`);
    if (info.serverContext) return PASS(`server context ${info.serverContext} tokens`, { info: lines });
    if (info.contextLength) return WARN(`no loaded-context figure; Harness plans with the trained maximum ${info.contextLength} (requests beyond the real -c / load setting fail with a context error)`, { info: lines, fix: S.flavor === 'lmstudio' ? 'LM Studio did not report loaded_context_length for the model; read it from another field.' : 'Read the server context from /props (llama.cpp) or ask the user.' });
    return FAIL('neither the server context nor the model maximum is exposed — Harness assumes 8K', { info: lines, fix: 'Add a source for the context size of this server.' });
  });

  const chatBody = (extra = {}) => ({ model: M, messages: [{ role: 'user', content: 'In one short sentence: what colour is the sky on a clear day?' }], stream: true, stream_options: { include_usage: true }, max_tokens: 48, temperature: 0, ...extra });
  let base = null;
  await run.check(id('chat.stream'), async ({ sample }) => {
    need(M, 'no model to chat with', pick.why);
    base = await oaiChat(chatBody());
    const { r, s } = base;
    sample(`${S.sid} POST /v1/chat/completions stream`, oaiSample(base.body, r, s));
    if (!r.ok) return FAIL(`HTTP ${r.status}: ${excerpt(s.errorText, 300)}`, { fix: 'Every chat turn through this provider would fail.' });
    const problems = [];
    if (r.error) problems.push(`stream broke: ${r.error}`);
    if (s.bad.length) problems.push(`${s.bad.length} data line(s) are not JSON`);
    if (s.errorObj) problems.push(`error chunk: ${excerpt(s.errorObj, 200)}`);
    if (!s.content && !s.reasoning) problems.push('no delta.content');
    const info = [`${s.chunks.length} chunks, delta keys {${[...s.deltaKeys].join(', ')}}, finish_reason ${s.finish}, [DONE] ${s.done ? 'yes' : 'NO'}, content-type ${r.contentType}`, `reply: ${excerpt(s.content, 160)}`];
    if (problems.length) return FAIL(problems[0], { info, actual: problems.join('; ') });
    if (!s.done) return WARN('no "data: [DONE]" terminator (Harness also stops at end of stream, so this is harmless)', { info });
    if (!s.finish) return WARN('no finish_reason in any chunk (truncation would be reported as "stop")', { info });
    return PASS(info[0], { info: info.slice(1) });
  }, { timeoutMs: 360000 });

  await run.check(id('chat.usage'), async () => {
    need(base?.r.ok, 'no successful stream', `${id('chat.stream')} to pass`);
    const { usage, timings } = base.s;
    const info = [`usage ${usage ? excerpt(usage, 200) : 'absent'}; timings ${timings ? excerpt(timings, 200) : 'absent'}`];
    if (isInt(usage?.prompt_tokens) && usage.prompt_tokens > 0) return PASS(`usage.prompt_tokens ${usage.prompt_tokens}, completion_tokens ${usage.completion_tokens}`, { info });
    if (isInt(timings?.prompt_n) && timings.prompt_n > 0) return PASS(`no usage, but llama.cpp timings.prompt_n ${timings.prompt_n} (Harness falls back to it)`, { info });
    return FAIL('no prompt token count in the stream (neither usage nor timings)', { info, expected: 'stream_options.include_usage → a chunk with usage{prompt_tokens}', fix: 'Calibration and the context meter never get real numbers for this provider.' });
  });

  await run.check(id('chat.finish_length'), async ({ sample }) => {
    need(M, 'no model to chat with', pick.why);
    const q = await oaiChat(chatBody({ messages: [{ role: 'user', content: 'Write a long story about a dragon who bakes bread.' }], max_tokens: 3 }));
    sample(`${S.sid} chat max_tokens 3 (last chunks)`, { status: q.r.status, chunks: q.s.chunks.slice(-2), body: q.r.ok ? undefined : q.r.json ?? q.r.bodyText });
    if (!q.r.ok) return FAIL(`HTTP ${q.r.status}: ${q.s.errorText}`);
    if (q.s.finish === 'length') return PASS('finish_reason "length"');
    return FAIL(`finish_reason "${q.s.finish}"`, { expected: '"length"', fix: 'Truncated answers would not be marked (finishReason "length").' });
  }, { timeoutMs: 300000 });

  await run.check(id('chat.reasoning'), async ({ sample }) => {
    const R = run.opts.openaiThinkModel || M;
    need(R, 'no model to chat with', pick.why);
    let s = base?.s;
    let q = null;
    if (R !== M || !s || (!s.reasoning && !/<think>/i.test(s.content))) {
      q = await oaiChat(chatBody({ model: R, messages: [{ role: 'user', content: 'What is 12 + 30? Think step by step, then answer.' }], max_tokens: 400 }));
      s = q.s;
      sample(`${S.sid} chat reasoning (${R})`, oaiSample(q.body, q.r, s));
      if (!q.r.ok) return FAIL(`HTTP ${q.r.status}: ${s.errorText}`);
    }
    const info = [`delta keys {${[...s.deltaKeys].join(', ')}}`];
    if (s.otherReasoningKeys.size) return FAIL(`reasoning arrives in delta.${[...s.otherReasoningKeys].join('/')}, which Harness ignores`, { info, expected: 'reasoning_content or reasoning', fix: 'Read this field in OpenAICompatProvider.chat.' });
    if (s.reasoning) return PASS(`reasoning in delta.${[...s.reasoningKeys].join('/')} (${s.reasoning.length} chars)`, { info });
    if (/<think>/i.test(s.content)) return PASS('reasoning arrives inline as <think>…</think> in content (ThinkTagParser handles it)', { info });
    return SKIP(`${R} produced no reasoning`, 'a reasoning model via --openai-think-model', { info });
  }, { timeoutMs: 360000 });

  await run.check(id('chat.think_off'), async ({ sample }) => {
    need(S.flavor === 'llamacpp', `only sent to llama.cpp (flavor here: ${S.flavor})`, 'a llama.cpp server');
    need(M, 'no model to chat with', pick.why);
    const q = await oaiChat(chatBody({ chat_template_kwargs: { enable_thinking: false }, max_tokens: 16 }));
    sample(`${S.sid} chat chat_template_kwargs enable_thinking:false`, oaiSample(q.body, q.r, q.s));
    if (!q.r.ok) return FAIL(`rejected: HTTP ${q.r.status} ${excerpt(q.s.errorText, 200)}`, { fix: 'Every turn with reasoning "off" would fail on llama.cpp; drop chat_template_kwargs.' });
    return PASS(`accepted${q.s.reasoning ? ` (but ${q.s.reasoning.length} chars of reasoning still came)` : ''}`);
  }, { timeoutMs: 300000 });

  let oaiCall = null;
  let toolsRejected = null;
  const toolMsgs = [{ role: 'system', content: 'You are a helpful assistant. Use the provided tools when they help.' }, { role: 'user', content: 'Use a tool to calculate 17*23' }];
  await run.check(id('tools.deltas'), async ({ sample }) => {
    need(M, 'no model to chat with', pick.why);
    const q = await oaiChat(chatBody({ messages: toolMsgs, tools: toolsSchema(), tool_choice: 'auto', max_tokens: 300 }));
    sample(`${S.sid} chat with tools`, oaiSample(q.body, q.r, q.s));
    if (!q.r.ok) {
      toolsRejected = { status: q.r.status, text: q.s.errorText };
      return SKIP(`the server rejected tools: HTTP ${q.r.status} "${excerpt(q.s.errorText, 160)}" (classification in ${id('tools.unsupported_error')})`, 'a server started with tool support (llama.cpp: --jinja)');
    }
    const calls = assembleToolCalls(q.s.toolDeltas);
    const info = [`${q.s.toolDeltas.length} tool_call delta(s); finish_reason ${q.s.finish}; first delta ${excerpt(q.s.toolDeltas[0], 200)}`];
    if (!calls.length) {
      if (/"name"\s*:\s*"calculate"|<tool_call>/i.test(q.s.content)) return FAIL('the tool call came back as TEXT in content, not as delta.tool_calls', { actual: q.s.content, fix: 'The server does not parse tool calls for this model (llama.cpp: --jinja / a tool-capable chat template).' });
      return WARN('the model answered without calling the tool (model behaviour)', { info: [...info, `content: ${excerpt(q.s.content, 160)}`] });
    }
    const c = calls[0];
    oaiCall = c;
    info.push(`assembled: ${c.name}(${c.parsed ? JSON.stringify(c.arguments) : c.args}) id ${c.id ?? 'absent'}`);
    if (q.s.toolDeltas.some((d) => d.index === undefined)) info.push('some deltas lack "index" (Harness then uses arrival order)');
    if (!c.parsed) return FAIL('concatenated arguments are not valid JSON', { info, actual: c.args, fix: 'Harness passes {_raw} to the tool.' });
    if (c.name !== 'calculate') return WARN(`called "${c.name}"`, { info });
    if (q.s.finish !== 'tool_calls') return WARN(`finish_reason "${q.s.finish}" instead of "tool_calls" (Harness does not depend on it)`, { info });
    return PASS(`calculate(${JSON.stringify(c.arguments)})`, { info });
  }, { timeoutMs: 360000 });

  await run.check(id('tools.result_roundtrip'), async ({ sample }) => {
    need(oaiCall, 'no tool call to answer', `${id('tools.deltas')} to produce a call`);
    const msgs = [...toolMsgs, H.toOpenAIMessage({ role: 'assistant', content: '', toolCalls: [{ id: oaiCall.id || 'call_0', name: oaiCall.name, arguments: oaiCall.arguments }] }), H.toOpenAIMessage({ role: 'tool', toolCallId: oaiCall.id || 'call_0', content: '17*23 = 391' })];
    const q = await oaiChat(chatBody({ messages: msgs, tools: toolsSchema(), tool_choice: 'auto', max_tokens: 160 }));
    sample(`${S.sid} chat tool result round trip`, oaiSample(q.body, q.r, q.s));
    if (!q.r.ok) return FAIL(`HTTP ${q.r.status}: ${excerpt(q.s.errorText, 200)}`, { fix: 'toOpenAIMessage() output is rejected (content null with tool_calls? tool_call_id?).' });
    if (!q.s.content) return WARN(`no text answer (finish ${q.s.finish}, ${q.s.toolDeltas.length} new tool deltas)`);
    return q.s.content.includes('391') ? PASS(`"${excerpt(q.s.content, 100)}"`) : WARN(`answer ignores the result: "${excerpt(q.s.content, 140)}"`);
  }, { timeoutMs: 300000 });

  await run.check(id('tools.unsupported_error'), async ({ sample }) => {
    let rej = toolsRejected;
    if (run.opts.openaiNoToolsModel) {
      const q = await oaiChat(chatBody({ model: run.opts.openaiNoToolsModel, messages: [{ role: 'user', content: 'hi' }], tools: toolsSchema(), max_tokens: 1 }));
      sample(`${S.sid} tools on ${run.opts.openaiNoToolsModel}`, { status: q.r.status, body: q.r.ok ? q.s.chunks.slice(-1) : q.r.json ?? q.r.bodyText });
      if (q.r.ok) return WARN(`${run.opts.openaiNoToolsModel} accepted tools silently — Harness cannot detect missing tool support here`, { fix: 'Tool calls may come back as plain text; nothing retries.' });
      rej = { status: q.r.status, text: q.s.errorText };
    }
    need(rej, 'tools were accepted', '--openai-notools-model NAME (a model/server that rejects tools)');
    const code = H.classifyOpenAIError(rej.status, rej.text).code;
    if (code === 'tools_unsupported') return PASS(`HTTP ${rej.status} "${excerpt(rej.text, 160)}" → tools_unsupported`);
    return FAIL(`HTTP ${rej.status} "${excerpt(rej.text, 160)}" → ${code}`, { expected: 'tools_unsupported (retry without tools)', fix: 'Extend the pattern in classifyOpenAIError to this text.' });
  }, { timeoutMs: 120000 });

  await run.check(id('embeddings'), async ({ sample }) => {
    need(M || models.length, 'no model', pick.why);
    const em = models.map((m) => m.id).find((x) => H.EMBEDDING_NAME_RE.test(x)) || M;
    const r = await http(S.url, '/v1/embeddings', { method: 'POST', body: { model: em, input: ['The cat sat on the mat.', 'A dog runs in the park.'] }, timeoutMs: T(120000), apiKey: key });
    sample(`${S.sid} POST /v1/embeddings (${em})`, { status: r.status, body: r.json ?? r.text ?? r.error });
    if (!r.ok) return WARN(`not available for ${em}: HTTP ${r.status} "${excerpt(errorOf(r), 160)}"`, { info: ['Harness uses this provider for embeddings only when configured (settings.embeddings.model)'], fix: S.flavor === 'llamacpp' ? 'llama-server needs --embeddings (and an embedding model) for this.' : undefined });
    const data = r.json?.data;
    if (!Array.isArray(data) || data.length !== 2 || !data.every((d) => Array.isArray(d.embedding))) return FAIL('unexpected shape', { actual: excerpt(r.json, 300), expected: 'data:[{index, embedding:[…]}×2]' });
    return PASS(`2 × ${data[0].embedding.length} dims (model ${em})${data.some((d) => d.index === undefined) ? '; no index fields (order assumed)' : ''}`);
  }, { timeoutMs: 180000 });

  await run.check(id('errors.unknown_model'), async ({ sample }) => {
    need(S.flavor !== 'generic', 'skipped for generic servers (MLX/vLLM may try to download an unknown model)', 'a llama.cpp or LM Studio server');
    const q = await oaiChat(chatBody({ model: 'livecheck-no-such-model', max_tokens: 1 }), { timeoutMs: 120000 });
    sample(`${S.sid} chat unknown model`, { status: q.r.status, body: q.r.ok ? q.s.chunks.slice(-1) : q.r.json ?? q.r.bodyText });
    if (q.r.ok) return PASS('the server ignores the model name and serves its loaded model');
    const code = H.classifyOpenAIError(q.r.status, q.s.errorText).code;
    if (code === 'model_not_found') return PASS(`HTTP ${q.r.status} "${excerpt(q.s.errorText, 120)}" → model_not_found`);
    return WARN(`HTTP ${q.r.status} "${excerpt(q.s.errorText, 160)}" → ${code}`, { fix: 'The UI would show a generic provider error instead of "model not found".' });
  }, { timeoutMs: 150000 });
}

// =============================================================================================== recording proxy
/** Local pass-through proxy that records every exchange, so the real provider code can be exercised and the raw answers captured. */
async function startRecordingProxy(target) {
  const httpMod = await import('node:http');
  const log = [];
  const server = httpMod.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const reqBuf = Buffer.concat(chunks);
    const entry = { method: req.method, path: req.url, at: Date.now() };
    try { entry.reqBody = reqBuf.length ? JSON.parse(reqBuf.toString('utf8')) : null; } catch { entry.reqBody = `(${reqBuf.length} bytes)`; }
    log.push(entry);
    try {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!['host', 'content-length', 'connection'].includes(k)) headers[k] = v;
      const r = await fetch(target + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : reqBuf });
      const buf = Buffer.from(await r.arrayBuffer());
      entry.status = r.status;
      entry.ms = Date.now() - entry.at;
      entry.resBuf = buf;
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'content-length': buf.length });
      res.end(buf);
    } catch (e) {
      entry.error = errText(e);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: entry.error }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, log, json: (e) => { try { return JSON.parse(e.resBuf.toString('utf8')); } catch { return null; } }, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
function decodeImage(b64OrBuf) {
  const buf = Buffer.isBuffer(b64OrBuf) ? b64OrBuf : base64Image(b64OrBuf);
  const mime = H.sniffImageMime(buf);
  const real = buf[0] === 0x89 && buf[1] === 0x50 ? 'png' : buf[0] === 0xff && buf[1] === 0xd8 ? 'jpeg' : buf.subarray(0, 4).toString('latin1') === 'RIFF' ? 'webp' : null;
  const dims = H.imageSize(buf, mime);
  return { buf, mime, recognized: !!real, width: dims.width, height: dims.height, bytes: buf.length };
}

// =============================================================================================== A1111 / Draw Things
async function a1111Group(run, B) {
  const url = B.a1111.url;
  const T = (ms) => run.T(ms);
  const A = run.a1111 = { url, minSize: null };
  run.section('raw', `A1111-compatible image API ${url} (detected via ${B.a1111.via})`);
  let current = null;
  await run.check('a1111.options', async ({ sample }) => {
    const r = await http(url, '/sdapi/v1/options', { timeoutMs: T(10000) });
    sample('a1111 GET /sdapi/v1/options (selected keys)', { status: r.status, keys: isObj(r.json) ? Object.keys(r.json).length : null, sd_model_checkpoint: r.json?.sd_model_checkpoint, model: r.json?.model, samples_format: r.json?.samples_format, body: isObj(r.json) ? undefined : r.text ?? r.error });
    if (r.status === 200 && isObj(r.json)) {
      current = r.json.sd_model_checkpoint || r.json.model || null;
      if (current) return PASS(`current checkpoint "${current}" (from ${r.json.sd_model_checkpoint ? 'sd_model_checkpoint' : 'model'})`);
      return WARN('options has neither sd_model_checkpoint nor model', { info: [`keys: ${Object.keys(r.json).slice(0, 20).join(', ')}`], fix: 'currentModel stays null → image family "unknown" defaults (20 steps, cfg 6, 768 px base) unless settings.image.model is set.' });
    }
    if (r.status === 404) return WARN('GET /sdapi/v1/options → 404: Harness cannot learn the current checkpoint', { expected: 'HTTP 200 JSON object', actual: r.text, fix: 'status() falls back to other probes (see a1111.detect_fallbacks); without a current model the family defaults are "unknown" (20 steps, cfg 6, 768 px) — set settings.image.model, or read the model from Draw Things\' GET / config.' });
    return WARN(`GET /sdapi/v1/options → ${httpSummary(r)}`, { fix: 'status() then relies on the fallback probes.' });
  });

  await run.check('a1111.detect_fallbacks', async ({ sample }) => {
    const res = {};
    for (const p of ['/sdapi/v1/sd-models', '/sdapi/v1/samplers', '/sdapi/v1/txt2img', '/']) {
      const r = await http(url, p, { timeoutMs: T(5000) });
      res[p] = { status: r.status, json: r.json === undefined ? 'not JSON' : Array.isArray(r.json) ? `array(${r.json.length})` : isObj(r.json) ? `object{${Object.keys(r.json).slice(0, 8).join(',')}}` : typeof r.json };
    }
    sample('a1111 detection probes', res);
    const info = Object.entries(res).map(([p, v]) => `GET ${p} → ${v.status} ${v.json}`);
    const via = [];
    if (res['/sdapi/v1/sd-models'].status === 200 && res['/sdapi/v1/sd-models'].json.startsWith('array')) via.push('sd-models');
    if (res['/sdapi/v1/samplers'].status === 200 && res['/sdapi/v1/samplers'].json.startsWith('array')) via.push('samplers');
    if ([405, 422].includes(res['/sdapi/v1/txt2img'].status) && res['/sdapi/v1/txt2img'].json.startsWith('object')) via.push('txt2img GET');
    if (res['/'].status === 200 && res['/'].json.startsWith('object')) via.push('GET / (only counts if it has "steps")');
    return PASS(`detected via ${B.a1111.via}; other probes that would also work: ${via.join(', ') || 'none'}`, { info });
  });

  await run.check('a1111.sd_models', async ({ sample }) => {
    const r = await http(url, '/sdapi/v1/sd-models', { timeoutMs: T(10000) });
    sample('a1111 GET /sdapi/v1/sd-models', { status: r.status, body: r.json ?? r.text ?? r.error });
    if (r.status === 404) return WARN('no /sdapi/v1/sd-models: the model picker shows only the current checkpoint', { info: [`current: ${current ?? 'unknown'}`] });
    if (!r.ok || !Array.isArray(r.json)) return WARN(`GET /sdapi/v1/sd-models → ${httpSummary(r)}`);
    const bad = r.json.filter((m) => !(m.title || m.model_name || m.filename));
    const match = current && r.json.some((m) => m.title === current || m.model_name === current);
    const info = [r.json.slice(0, 6).map((m) => m.title || m.model_name).join(', ')];
    if (bad.length) return FAIL(`${bad.length} entries without title/model_name/filename`, { info });
    if (current && !match) return WARN(`current checkpoint "${current}" matches no title/model_name → no model is marked current`, { info, fix: 'Compare against filename too, or strip the [hash] suffix.' });
    return PASS(`${r.json.length} checkpoint(s)${current ? '; current one matched' : ''}`, { info });
  });

  await run.check('a1111.samplers', async ({ sample }) => {
    const r = await http(url, '/sdapi/v1/samplers', { timeoutMs: T(10000) });
    sample('a1111 GET /sdapi/v1/samplers', { status: r.status, body: r.json ?? r.text ?? r.error });
    if (!r.ok || !Array.isArray(r.json)) return WARN(`GET /sdapi/v1/samplers → ${httpSummary(r)} (informational: Harness sends sampler names verbatim)`);
    return PASS(`${r.json.length} sampler(s): ${r.json.slice(0, 8).map((s) => s.name).join(', ')}`);
  });

  await run.check('a1111.progress', async ({ sample }) => {
    const r = await http(url, '/sdapi/v1/progress?skip_current_image=true', { timeoutMs: T(5000) });
    sample('a1111 GET /sdapi/v1/progress (idle)', { status: r.status, body: r.json ?? r.text ?? r.error });
    if (r.status === 404) return WARN('no /sdapi/v1/progress: no progress bar during generation (polling stops after 3 misses)');
    if (!r.ok || !isObj(r.json)) return WARN(`→ ${httpSummary(r)}`);
    const bad = [];
    if (!isNum(r.json.progress)) bad.push('progress');
    if (!isObj(r.json.state)) bad.push('state');
    if (bad.length) return WARN(`fields missing: ${bad.join(', ')}`, { actual: r.text });
    return PASS(`progress ${r.json.progress}, eta_relative ${r.json.eta_relative}, state {${Object.keys(r.json.state).join(', ')}}`);
  });

  let interruptGet = null;
  { const r = await http(url, '/sdapi/v1/interrupt', { timeoutMs: T(5000) }); interruptGet = r.status; }

  const genChecks = ['a1111.txt2img.min_size', 'a1111.txt2img.response', 'a1111.txt2img.count2', 'a1111.txt2img.seeds', 'a1111.txt2img.unknown_fields', 'a1111.progress_during', 'a1111.interrupt_during', 'a1111.img2img'];
  let interruptPost = null;
  if (!run.opts.allowImages) {
    for (const id of genChecks) await run.check(id, async () => SKIP('image generation is off by default', '--allow-images (a few tiny 1-step images)'));
  } else {
    const proxy = await startRecordingProxy(url);
    const prov = new H.A1111Provider({ id: 'a1111', name: 'A1111 (live-check)', baseUrl: proxy.url });
    const baseP = { prompt: 'a red circle on a white background', negativePrompt: '', steps: 1, cfg: 1.5, seed: 4242, count: 1, sampler: null, model: null, denoise: 0.6 };
    const gen = async (p, signal) => {
      const from = proxy.log.length;
      const t0 = nowMs();
      try {
        const result = await p.__raw ? null : await prov.generate(p, { signal: anySignal(signal, T(600000)) });
        return { ok: true, result, ms: nowMs() - t0, calls: proxy.log.slice(from) };
      } catch (e) { return { ok: false, error: e.message, ms: nowMs() - t0, calls: proxy.log.slice(from) }; }
    };
    const genCall = (g) => g.calls.find((c) => c.method === 'POST' && /\/sdapi\/v1\/(txt2img|img2img)/.test(c.path));
    let first = null;
    try {
      await run.check('a1111.txt2img.min_size', async ({ sample }) => {
        const tries = [];
        for (const size of [64, 128, 256, 512]) {
          const g = await gen({ ...baseP, width: size, height: size });
          tries.push(`${size}×${size}: ${g.ok ? `ok in ${fmtMs(g.ms)}` : `failed (${excerpt(g.error, 120)})`}`);
          if (g.ok) { first = { ...g, size }; break; }
        }
        const c = first ? genCall(first) : null;
        if (c) sample('a1111 POST /sdapi/v1/txt2img — exact Harness request body', c.reqBody);
        if (!first) return FAIL('no tiny txt2img succeeded with the body Harness sends', { info: tries, fix: 'See a1111.txt2img.unknown_fields for whether the extra field names are the problem.' });
        A.minSize = first.size;
        A.perImageMs = first.ms;
        const img = first.result.images[0];
        const d = decodeImage(img.buffer);
        return PASS(`smallest accepted: ${first.size}×${first.size}, 1 step, in ${fmtMs(first.ms)} → ${d.width}×${d.height} ${d.mime}`, { info: tries, observed: { minSize: first.size, ms: Math.round(first.ms) } });
      }, { timeoutMs: 1200000 });

      await run.check('a1111.txt2img.response', async ({ sample }) => {
        need(first, 'no successful txt2img', 'a1111.txt2img.min_size');
        const c = genCall(first);
        const j = proxy.json(c);
        sample('a1111 txt2img response (images shortened)', j ? { ...j, images: (j.images || []).map((s) => `${String(s).slice(0, 40)}…(${String(s).length} chars)`) } : c?.resBuf?.toString('utf8').slice(0, 500));
        if (!isObj(j) || !Array.isArray(j.images)) return FAIL('no images array', { actual: c?.resBuf?.toString('utf8').slice(0, 300) });
        const imgs = j.images.map(decodeImage);
        const problems = [];
        if (j.images.some((s) => typeof s !== 'string')) problems.push('images are not base64 strings');
        if (imgs.some((d) => !d.recognized)) problems.push('an image is neither PNG, JPEG nor WebP');
        if (j.images.some((s) => /^data:/.test(s))) problems.push('data: URL prefix (Harness strips it)');
        let info = j.info;
        const infoType = typeof info;
        if (typeof info === 'string') { try { info = JSON.parse(info); } catch { problems.push('info is a string but not JSON'); info = null; } }
        const lines = [`${j.images.length} image(s): ${imgs.map((d) => `${d.width}×${d.height} ${d.mime} ${fmtBytes(d.bytes)}`).join(', ')}; info is ${infoType}${isObj(info) ? ` with {${Object.keys(info).slice(0, 14).join(', ')}}` : ''}; parameters ${j.parameters ? 'echoed' : 'absent'}`];
        if (problems.some((p) => !p.startsWith('data:'))) return FAIL(problems.join('; '), { info: lines });
        if (!isObj(info)) return WARN('no usable info object: Harness assumes seeds seed, seed+1 … and the image count it asked for', { info: lines });
        if (!Number.isFinite(info.seed) && !Array.isArray(info.all_seeds)) return WARN('info has neither seed nor all_seeds', { info: lines });
        return PASS(lines[0]);
      });

      let c2 = null;
      await run.check('a1111.txt2img.count2', async ({ sample }) => {
        need(first, 'no successful txt2img', 'a1111.txt2img.min_size');
        const g = await gen({ ...baseP, width: first.size, height: first.size, count: 2, seed: 5000 });
        c2 = g;
        const c = genCall(g);
        const j = c ? proxy.json(c) : null;
        const raw = (j?.images || []).map(decodeImage);
        let info = j?.info;
        if (typeof info === 'string') { try { info = JSON.parse(info); } catch { info = null; } }
        sample('a1111 txt2img count 2 (request + response summary)', { request: c?.reqBody, images: raw.map((d) => `${d.width}×${d.height} ${d.mime}`), info });
        if (!g.ok) return FAIL(`generation failed: ${g.error}`);
        const want = decodeImage(first.result.images[0].buffer);
        const got = g.result.images.map((x) => decodeImage(x.buffer));
        const gridIdx = raw.findIndex((d) => d.width !== want.width || d.height !== want.height);
        const lines = [`backend returned ${raw.length} image(s) [${raw.map((d) => `${d.width}×${d.height}`).join(', ')}], index_of_first_image ${info?.index_of_first_image ?? 'absent'}; Harness kept ${got.length} [${got.map((d) => `${d.width}×${d.height}`).join(', ')}]`];
        if (got.length < 2) return FAIL(`only ${got.length} image(s) for count 2: the backend ignored n_iter/batch_count`, { info: lines, fix: 'Find the batch-count field this backend honours and set it in A1111Provider.generate.' });
        if (got.some((d) => d.width !== want.width || d.height !== want.height)) return FAIL('Harness kept the contact-sheet grid instead of a real image', { info: lines, fix: 'The grid is not where A1111Provider.generate expects it (index_of_first_image / last `count` images).' });
        if (gridIdx >= 0 && !Number.isInteger(info?.index_of_first_image)) return WARN(`a grid was returned (position ${gridIdx}) without info.index_of_first_image; Harness got it right only through the "last count images" fallback`, { info: lines });
        return PASS(`${gridIdx >= 0 ? `grid at ${gridIdx} skipped via index_of_first_image; ` : 'no grid; '}2 real images kept`, { info: lines });
      }, { timeoutMs: 1200000 });

      await run.check('a1111.txt2img.seeds', async () => {
        need(c2?.ok, 'count-2 generation did not succeed', 'a1111.txt2img.count2');
        const j = proxy.json(genCall(c2));
        let info = j?.info;
        if (typeof info === 'string') { try { info = JSON.parse(info); } catch { info = null; } }
        const seeds = c2.result.seeds;
        const lines = [`info.seed ${info?.seed ?? 'absent'}, all_seeds ${JSON.stringify(info?.all_seeds ?? null)}; Harness stores ${JSON.stringify(seeds)}`];
        if (!Array.isArray(info?.all_seeds)) return WARN('no all_seeds: Harness assumes seed+i, which may not be what the backend used', { info: lines });
        if (info.all_seeds.length < 2) return WARN(`all_seeds has ${info.all_seeds.length} entr(y/ies) for 2 images`, { info: lines });
        if (seeds[0] !== 5000 || seeds[1] !== 5001) return WARN(`seeds ${JSON.stringify(seeds)} instead of [5000, 5001] (reproducing an image from the gallery would use these)`, { info: lines });
        return PASS(`seeds ${JSON.stringify(seeds)}`, { info: lines });
      });

      await run.check('a1111.txt2img.unknown_fields', async ({ sample }) => {
        need(A.minSize || true, '', '');
        const s = A.minSize || 64;
        const common = { prompt: 'a red circle on a white background', negative_prompt: '', width: s, height: s, steps: 1, seed: 77 };
        const variants = { a1111Only: { ...common, cfg_scale: 1.5, batch_size: 1, n_iter: 1 }, drawThingsOnly: { ...common, guidance_scale: 1.5, batch_size: 1, batch_count: 1 } };
        const res = {};
        for (const [k, body] of Object.entries(variants)) {
          const r = await http(url, '/sdapi/v1/txt2img', { method: 'POST', body, timeoutMs: T(600000) });
          res[k] = { status: r.status, images: Array.isArray(r.json?.images) ? r.json.images.length : 0, error: r.ok ? null : excerpt(errorOf(r), 160) };
        }
        res.harnessBody = first ? { status: 200, images: first.result.images.length } : { status: 'failed' };
        sample('a1111 txt2img field-name variants', res);
        const lines = Object.entries(res).map(([k, v]) => `${k}: HTTP ${v.status}${v.images ? `, ${v.images} image(s)` : ''}${v.error ? ` "${v.error}"` : ''}`);
        if (!first && (res.a1111Only.status === 200 || res.drawThingsOnly.status === 200)) return FAIL('the canonical body works but the body Harness sends does not — the extra field names break this backend', { info: lines, fix: 'Send only the fields of the detected dialect in A1111Provider.generate.' });
        if (!first) return FAIL('no variant works', { info: lines });
        return PASS('unknown/duplicate field names are ignored', { info: lines });
      }, { timeoutMs: 1300000 });

      let longJob = null;
      await run.check('a1111.progress_during', async ({ sample }) => {
        need(first, 'no successful txt2img', 'a1111.txt2img.min_size');
        const s = Math.max(first.size, 256);
        const body = { prompt: 'a detailed landscape with mountains and a lake', negative_prompt: '', width: s, height: s, steps: 30, cfg_scale: 5, guidance_scale: 5, seed: 99, batch_size: 1, n_iter: 1, batch_count: 1 };
        const t0 = nowMs();
        const job = http(url, '/sdapi/v1/txt2img', { method: 'POST', body, timeoutMs: T(900000) }).then((r) => ({ r, endMs: nowMs() - t0 }));
        let finished = null;
        job.then((x) => { finished = x; });
        const polls = [];
        let seen = null;
        while (!finished && nowMs() - t0 < T(120000)) {
          await sleep(150);
          const p = await http(url, '/sdapi/v1/progress?skip_current_image=true', { timeoutMs: T(3000) });
          polls.push({ t: Math.round(nowMs() - t0), status: p.status, progress: p.json?.progress, step: p.json?.state?.sampling_step });
          if (isNum(p.json?.progress) && p.json.progress > 0) { seen = { t: nowMs() - t0, ...p.json }; break; }
          if (p.status === 404) break;
        }
        let interrupt = null;
        if (!finished) {
          const ir = await http(url, '/sdapi/v1/interrupt', { method: 'POST', timeoutMs: T(5000) });
          interrupt = { status: ir.status, at: nowMs() - t0 };
          interruptPost = ir.status;
          for (let i = 0; i < 5 && !finished; i++) {
            const p = await http(url, '/sdapi/v1/progress?skip_current_image=true', { timeoutMs: T(3000) });
            if (p.json?.state?.interrupted) { interrupt.flag = true; break; }
            await sleep(100);
          }
        }
        const done = await job;
        longJob = { done, interrupt, seen, steps: 30 };
        sample('a1111 progress polls during a 30-step job', { polls: polls.slice(0, 20), interrupt, endMs: Math.round(done.endMs) });
        if (seen) return PASS(`progress ${seen.progress.toFixed(2)} at step ${seen.state?.sampling_step}/${seen.state?.sampling_steps} after ${fmtMs(seen.t)}`);
        if (polls.some((p) => p.status === 404)) return WARN('/progress is 404 during generation: no progress bar');
        return WARN(`no progress > 0 observed in ${polls.length} polls (job took ${fmtMs(done.endMs)})`, { info: [excerpt(polls.slice(-3))] });
      }, { timeoutMs: 1000000 });

      await run.check('a1111.interrupt_during', async () => {
        need(longJob, 'no long job ran', 'a1111.progress_during');
        const { done, interrupt } = longJob;
        if (!interrupt) return WARN(`the 30-step job finished (${fmtMs(done.endMs)}) before an interrupt could be sent`);
        const after = done.endMs - interrupt.at;
        const lines = [`POST /interrupt → HTTP ${interrupt.status} at ${fmtMs(interrupt.at)}; txt2img returned HTTP ${done.r.status} ${fmtMs(after)} later${interrupt.flag ? '; /progress showed state.interrupted' : ''}`];
        if (![200, 204].includes(interrupt.status)) return FAIL(`POST /sdapi/v1/interrupt → HTTP ${interrupt.status}`, { info: lines, fix: 'A1111Provider.interrupt ignores errors, so cancelling would not stop the backend.' });
        if (after > T(15000) && !interrupt.flag) return WARN('the job kept running after the interrupt', { info: lines });
        return PASS(`stopped ${fmtMs(after)} after the interrupt`, { info: lines });
      }, { timeoutMs: 60000 });

      await run.check('a1111.img2img', async ({ sample }) => {
        need(first, 'no successful txt2img', 'a1111.txt2img.min_size');
        const src = first.result.images[0];
        const g = await gen({ ...baseP, width: first.size, height: first.size, initImage: { buffer: src.buffer, mime: src.mime }, denoise: 0.5 });
        const c = genCall(g);
        sample('a1111 POST /sdapi/v1/img2img request (init image shortened)', c ? { ...c.reqBody, init_images: (c.reqBody?.init_images || []).map((s) => `${String(s).slice(0, 30)}…(${String(s).length} chars)`) } : null);
        if (!g.ok) return FAIL(`img2img failed: ${g.error}`, { fix: 'Check init_images (raw base64, no data: prefix) and denoising_strength/strength.' });
        const d = decodeImage(g.result.images[0].buffer);
        return PASS(`${d.width}×${d.height} ${d.mime} in ${fmtMs(g.ms)} via ${c?.path}`);
      }, { timeoutMs: 900000 });
    } finally {
      await proxy.close();
    }
  }

  await run.check('a1111.interrupt', async () => {
    if (interruptPost != null) {
      if ([200, 204].includes(interruptPost)) return PASS(`POST /sdapi/v1/interrupt → HTTP ${interruptPost} (sent during this run's own job)`);
      return FAIL(`POST /sdapi/v1/interrupt → HTTP ${interruptPost}`, { fix: 'Aborting an image job would not stop the backend.' });
    }
    if ([405, 422].includes(interruptGet)) return PASS(`GET → HTTP ${interruptGet}: the POST-only route exists`);
    if (interruptGet === 200) return PASS('GET → HTTP 200 (route exists)');
    return WARN(`GET /sdapi/v1/interrupt → HTTP ${interruptGet}; not verified with POST (that could cancel someone's running job)`, { need: '--allow-images (then it is POSTed during this run\'s own job)' });
  });
}

// =============================================================================================== ComfyUI
function openWs(url, clientId, firstMsgTimeoutMs) {
  return new Promise((resolve) => {
    if (typeof WebSocket !== 'function') return resolve({ unavailable: true, msgs: [] });
    const msgs = [];
    let ws;
    try { ws = new WebSocket(`${url.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`); } catch (e) { return resolve({ error: e.message, msgs }); }
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    const t = setTimeout(() => settle({ ws, msgs, timeout: true }), firstMsgTimeoutMs);
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') { try { msgs.push({ t: Date.now(), m: JSON.parse(ev.data) }); } catch { msgs.push({ t: Date.now(), raw: ev.data.slice(0, 200) }); } } else msgs.push({ t: Date.now(), binary: true });
      clearTimeout(t);
      settle({ ws, msgs });
    };
    ws.onerror = (e) => { clearTimeout(t); settle({ error: e?.message || 'WebSocket error', msgs }); };
  });
}
function comboOptions(spec) {
  if (Array.isArray(spec?.[0])) return spec[0];
  if (spec?.[0] === 'COMBO' && Array.isArray(spec?.[1]?.options)) return spec[1].options;
  return null;
}
async function waitHistory(url, promptId, run, { maxMs }) {
  const t0 = nowMs();
  let last = null;
  while (nowMs() - t0 < maxMs) {
    const r = await http(url, `/history/${encodeURIComponent(promptId)}`, { timeoutMs: run.T(10000) });
    last = r;
    const e = r.json?.[promptId];
    if (e && (e.status?.completed || e.status?.status_str === 'error' || Object.keys(e.outputs || {}).length)) return { entry: e, r, ms: nowMs() - t0 };
    await sleep(300);
  }
  return { entry: null, r: last, ms: nowMs() - t0 };
}

async function comfyGroup(run, B) {
  const url = B.comfyui.url;
  const T = (ms) => run.T(ms);
  run.section('raw', `ComfyUI ${url} (${B.comfyui.version || 'version ?'})`);
  let ckpts = null;
  await run.check('comfyui.system_stats', async ({ sample }) => {
    const r = await http(url, '/system_stats', { timeoutMs: T(10000) });
    sample('comfyui GET /system_stats', { status: r.status, body: r.json ?? r.text ?? r.error });
    if (!r.ok || !isObj(r.json?.system)) return FAIL(`→ ${httpSummary(r)}`, { fix: 'ComfyUIProvider.status() would report it unreachable.' });
    const dev = (r.json.devices || []).map((d) => `${d.name} (${d.type}) vram ${fmtBytes(d.vram_total)} free ${fmtBytes(d.vram_free)}`).join('; ');
    if (!r.json.system.comfyui_version) return WARN('no system.comfyui_version (version shows as null)', { info: [dev] });
    return PASS(`ComfyUI ${r.json.system.comfyui_version}, python ${r.json.system.python_version ?? '?'}; ${dev}`);
  });
  await run.check('comfyui.checkpoints', async ({ sample }) => {
    const r = await http(url, '/object_info/CheckpointLoaderSimple', { timeoutMs: T(15000) });
    sample('comfyui GET /object_info/CheckpointLoaderSimple', { status: r.status, body: r.json ?? r.text ?? r.error });
    const spec = r.json?.CheckpointLoaderSimple?.input?.required?.ckpt_name;
    const opts = comboOptions(spec);
    if (!r.ok || !opts) return FAIL(`ckpt_name options not found (${httpSummary(r)})`, { actual: excerpt(spec ?? r.json, 300), expected: '[[…names], {…}] or ["COMBO", {options:[…]}]', fix: 'comboOptions() would return [] → "no checkpoints found".' });
    ckpts = opts;
    const fmt = Array.isArray(spec[0]) ? 'classic [[…]]' : 'COMBO';
    if (!opts.length) return WARN('no checkpoints installed → Harness cannot generate (default workflow needs one)', { fix: 'Put a model in ComfyUI/models/checkpoints.' });
    return PASS(`${opts.length} checkpoint(s) (${fmt} format): ${opts.slice(0, 5).join(', ')}`);
  });
  await run.check('comfyui.nodes', async ({ sample }) => {
    const classes = [...new Set([...Object.values(H.DEFAULT_TXT2IMG_WORKFLOW), ...Object.values(H.DEFAULT_IMG2IMG_WORKFLOW)].map((n) => n.class_type))];
    const res = {};
    for (const c of classes) {
      const r = await http(url, `/object_info/${c}`, { timeoutMs: T(15000) });
      res[c] = r.status === 200 && isObj(r.json) ? (r.json[c] ? 'present' : 'MISSING') : `HTTP ${r.status}`;
    }
    sample('comfyui node classes used by the default workflows', res);
    const missing = Object.entries(res).filter(([, v]) => v === 'MISSING').map(([k]) => k);
    const unverifiable = Object.entries(res).filter(([, v]) => v.startsWith('HTTP')).map(([k, v]) => `${k} (${v})`);
    if (missing.length) return FAIL(`node class(es) missing: ${missing.join(', ')}`, { fix: 'The built-in workflow cannot run on this ComfyUI; adjust DEFAULT_*_WORKFLOW.' });
    if (unverifiable.length) return WARN(`could not verify: ${unverifiable.join(', ')} (/object_info/<class> did not answer with JSON)`);
    return PASS(`all ${classes.length} present: ${classes.join(', ')}`);
  });
  await run.check('comfyui.samplers', async ({ sample }) => {
    const r = await http(url, '/object_info/KSampler', { timeoutMs: T(15000) });
    const req = r.json?.KSampler?.input?.required;
    const samplers = comboOptions(req?.sampler_name);
    const scheds = comboOptions(req?.scheduler);
    sample('comfyui KSampler sampler/scheduler options', { status: r.status, samplers, schedulers: scheds });
    if (!samplers || !scheds) return WARN(`could not read KSampler options (${httpSummary(r)})`);
    const wantS = new Set(['euler', ...H.IMAGE_FAMILIES.map((f) => f.comfy?.sampler), H.DEFAULT_FAMILY.comfy?.sampler].filter(Boolean));
    const wantK = new Set(['normal', ...H.IMAGE_FAMILIES.map((f) => f.comfy?.scheduler), H.DEFAULT_FAMILY.comfy?.scheduler].filter(Boolean));
    const ms = [...wantS].filter((x) => !samplers.includes(x));
    const mk = [...wantK].filter((x) => !scheds.includes(x));
    if (ms.length || mk.length) return FAIL(`unknown to this ComfyUI: ${[...ms.map((x) => `sampler ${x}`), ...mk.map((x) => `scheduler ${x}`)].join(', ')}`, { fix: 'Prompts for the affected model families fail validation; update IMAGE_FAMILIES[].comfy in defaults.mjs.' });
    return PASS(`all ${wantS.size} samplers and ${wantK.size} schedulers Harness may send exist`);
  });
  let interruptGet = null;
  await run.check('comfyui.queue_routes', async ({ sample }) => {
    const q = await http(url, '/queue', { timeoutMs: T(10000) });
    const i = await http(url, '/interrupt', { timeoutMs: T(10000) });
    interruptGet = i.status;
    sample('comfyui GET /queue and GET /interrupt', { queue: { status: q.status, body: q.json ?? q.text }, interruptGet: { status: i.status, body: i.json ?? i.text } });
    const lines = [`GET /queue → ${q.status} ${isObj(q.json) ? `{${Object.keys(q.json).join(', ')}}` : ''}; GET /interrupt → ${i.status}`];
    if (!q.ok || !Array.isArray(q.json?.queue_running)) return WARN('GET /queue does not answer {queue_running, queue_pending}', { info: lines });
    if (i.status === 404) return WARN('GET /interrupt → 404 (a POST-only route usually answers 405); not verified with POST without --allow-images', { info: lines });
    return PASS(lines[0]);
  });
  await run.check('comfyui.websocket', async ({ sample }) => {
    if (typeof WebSocket !== 'function') return WARN(`Node ${process.version} has no global WebSocket: Harness shows no ComfyUI progress`, { fix: 'Run Harness on Node ≥ 22 (or the Electron app) for progress.' });
    const s = await openWs(url, `livecheck-${crypto.randomUUID()}`, T(8000));
    try { s.ws?.close(); } catch { /* ignore */ }
    sample('comfyui WebSocket first message', s.msgs[0] || s.error || 'none');
    if (s.error) return FAIL(`WebSocket failed: ${s.error}`, { fix: 'No progress events for ComfyUI jobs.' });
    const m = s.msgs[0]?.m;
    if (!m) return WARN('connected, but no message within 8 s');
    if (m.type !== 'status') return WARN(`first message type "${m.type}" (expected "status")`, { actual: excerpt(m) });
    return PASS(`status message received (sid ${m.data?.sid ?? '?'})`);
  });
  await run.check('comfyui.validation_error', async ({ sample }) => {
    const wf = H.fillWorkflow(H.DEFAULT_TXT2IMG_WORKFLOW, { prompt: 'x', negative_prompt: '', seed: 1, steps: 1, cfg: 1, width: 64, height: 64, count: 1, denoise: 1, model: 'livecheck-no-such-checkpoint.safetensors', sampler: 'euler', scheduler: 'normal', image: '' });
    const raw = await http(url, '/prompt', { method: 'POST', body: { prompt: wf, client_id: 'livecheck' }, timeoutMs: T(30000) });
    sample('comfyui POST /prompt with an invalid checkpoint', { status: raw.status, body: raw.json ?? raw.text ?? raw.error });
    let harnessMsg = null;
    try { await H.imageJson({ baseUrl: url, name: 'ComfyUI', id: 'comfyui', apiKey: '' }, '/prompt', { method: 'POST', body: { prompt: wf, client_id: 'livecheck' }, timeoutMs: T(30000) }); } catch (e) { harnessMsg = e.message; }
    const detail = JSON.stringify(raw.json?.node_errors || {});
    const lines = [`HTTP ${raw.status}; node_errors ${excerpt(raw.json?.node_errors ?? 'absent', 250)}`, `Harness would show: ${harnessMsg ? `"${excerpt(harnessMsg, 200)}"` : '(no error from imageJson — then comfyui.mjs checks node_errors itself)'}`];
    if (raw.ok && raw.json?.prompt_id && !Object.keys(raw.json?.node_errors || {}).length) return FAIL('an invalid checkpoint was accepted and queued', { info: lines });
    if (raw.ok) return PASS('HTTP 200 with node_errors (Harness throws "workflow error …" with the details)', { info: lines });
    const hasDetail = harnessMsg && /ckpt_name|not in list|livecheck-no-such/i.test(harnessMsg);
    if (!hasDetail && detail.length > 2) return WARN('rejected with HTTP 400; Harness keeps only error.message, so the user does not see which input is wrong', { info: lines, fix: 'In imageRequest (image/http.mjs) or ComfyUIProvider.generate, append node_errors[*].errors[*].message/details for POST /prompt failures.' });
    return PASS('rejected; the reason reaches the user', { info: lines });
  });

  const genIds = ['comfyui.prompt', 'comfyui.ws_progress', 'comfyui.history', 'comfyui.view', 'comfyui.interrupt_during'];
  if (!run.opts.allowImages) {
    for (const id of genIds) await run.check(id, async () => SKIP('image generation is off by default', '--allow-images'));
    return;
  }
  const ckpt = ckpts?.[0];
  const clientId = `livecheck-${crypto.randomUUID()}`;
  const sock = await openWs(url, clientId, T(8000));
  const fill = (over) => H.fillWorkflow(H.DEFAULT_TXT2IMG_WORKFLOW, { prompt: 'a red circle on a white background', negative_prompt: '', seed: Math.floor(Math.random() * 2 ** 31), steps: 2, cfg: 1.5, width: 64, height: 64, count: 1, denoise: 1, model: ckpt, sampler: 'euler', scheduler: 'normal', image: '', ...over });
  let promptId = null;
  let tSubmit = 0;
  try {
    await run.check('comfyui.prompt', async ({ sample }) => {
      need(ckpt, 'no checkpoint installed', 'a checkpoint in ComfyUI/models/checkpoints');
      const wf = fill({});
      tSubmit = Date.now();
      const r = await http(url, '/prompt', { method: 'POST', body: { prompt: wf, client_id: clientId }, timeoutMs: T(30000) });
      sample('comfyui POST /prompt (Harness default workflow, 64×64, 2 steps)', { request: { prompt: wf, client_id: clientId }, status: r.status, body: r.json ?? r.text ?? r.error });
      if (!r.ok) return FAIL(`HTTP ${r.status}: ${excerpt(r.json ?? r.text, 300)}`, { fix: 'The built-in workflow is rejected by this ComfyUI.' });
      if (!r.json?.prompt_id) return FAIL('no prompt_id', { actual: r.text });
      promptId = r.json.prompt_id;
      return PASS(`prompt_id ${promptId}, number ${r.json.number}, node_errors ${JSON.stringify(r.json.node_errors ?? null)}`);
    });
    let hist = null;
    await run.check('comfyui.history', async ({ sample }) => {
      need(promptId, 'nothing queued', 'comfyui.prompt');
      hist = await waitHistory(url, promptId, run, { maxMs: T(600000) });
      sample('comfyui GET /history/{id}', hist.r?.json ?? hist.r?.text);
      const e = hist.entry;
      if (!e) return FAIL(`no finished history entry after ${fmtMs(hist.ms)}`, { actual: hist.r?.text?.slice(0, 300) });
      const imgs = Object.values(e.outputs || {}).flatMap((o) => o.images || []);
      const lines = [`status ${excerpt(e.status, 200)}; outputs ${Object.keys(e.outputs || {}).join(', ')}; images ${excerpt(imgs, 200)}; took ${fmtMs(Date.now() - tSubmit)}`];
      if (e.status?.status_str === 'error') return FAIL(`execution failed: ${excerpt(e.status.messages, 300)}`, { info: lines });
      if (!imgs.length) return FAIL('no images in outputs', { info: lines });
      if (!imgs.every((i) => typeof i.filename === 'string' && 'type' in i)) return FAIL('image entries lack filename/type', { info: lines });
      if (!e.status?.completed) return WARN('outputs present but status.completed is not true', { info: lines });
      return PASS(`completed, ${imgs.length} image(s) in ${fmtMs(Date.now() - tSubmit)}`, { info: lines, data: imgs });
    }, { timeoutMs: 700000 });
    await run.check('comfyui.ws_progress', async ({ sample }) => {
      need(promptId, 'nothing queued', 'comfyui.prompt');
      if (sock.unavailable) return SKIP('no global WebSocket in this Node', 'Node ≥ 22');
      if (sock.error) return FAIL(`WebSocket failed: ${sock.error}`);
      const mine = sock.msgs.filter((x) => x.m && (!x.m.data?.prompt_id || x.m.data.prompt_id === promptId));
      const types = [...new Set(mine.map((x) => x.m.type))];
      const prog = mine.filter((x) => x.m.type === 'progress');
      sample('comfyui WebSocket messages during the run', mine.slice(0, 20).map((x) => x.m));
      const lines = [`types: ${types.join(', ')}; ${prog.length} progress message(s)${prog[0] ? `, e.g. ${excerpt(prog[0].m.data, 120)}` : ''}; ${sock.msgs.filter((x) => x.binary).length} binary preview frame(s)`];
      if (!prog.length) return WARN('no "progress" messages (Harness shows no progress bar)', { info: lines });
      if (!prog.every((x) => isNum(x.m.data?.value) && isNum(x.m.data?.max))) return FAIL('progress messages without numeric value/max', { info: lines });
      return PASS(lines[0]);
    });
    await run.check('comfyui.view', async ({ sample }) => {
      const imgs = Object.values(hist?.entry?.outputs || {}).flatMap((o) => o.images || []);
      need(imgs.length, 'no output image', 'comfyui.history');
      const f = imgs.find((i) => i.type !== 'temp') || imgs[0];
      const qs = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' });
      const r = await http(url, `/view?${qs}`, { timeoutMs: T(60000), binary: true });
      const d = r.buf ? decodeImage(r.buf) : null;
      sample('comfyui GET /view', { status: r.status, headers: r.headers, image: d && { mime: d.mime, width: d.width, height: d.height, bytes: d.bytes } });
      if (!r.ok || !d?.recognized) return FAIL(`→ HTTP ${r.status}, ${d ? `${d.bytes} bytes, not an image` : r.error}`);
      return PASS(`${d.width}×${d.height} ${d.mime} (${fmtBytes(d.bytes)})`);
    });
    await run.check('comfyui.interrupt_during', async ({ sample }) => {
      need(ckpt, 'no checkpoint installed', 'a checkpoint');
      const from = sock.msgs.length;
      const r = await http(url, '/prompt', { method: 'POST', body: { prompt: fill({ steps: 40, width: 256, height: 256 }), client_id: clientId }, timeoutMs: T(30000) });
      if (!r.ok || !r.json?.prompt_id) return FAIL(`could not queue: HTTP ${r.status}`);
      const id = r.json.prompt_id;
      const t0 = nowMs();
      while (nowMs() - t0 < T(60000)) {
        if (sock.msgs.slice(from).some((x) => x.m?.type === 'progress' && x.m.data?.prompt_id === id)) break;
        const h = await http(url, `/history/${encodeURIComponent(id)}`, { timeoutMs: T(5000) });
        if (h.json?.[id]) break;
        if (sock.unavailable && nowMs() - t0 > 1500) break;
        await sleep(100);
      }
      const ir = await http(url, '/interrupt', { method: 'POST', body: {}, timeoutMs: T(10000) });
      const h = await waitHistory(url, id, run, { maxMs: T(300000) });
      sample('comfyui interrupt during a job', { interrupt: { status: ir.status, body: ir.json ?? ir.text }, history: h.entry?.status });
      const lines = [`POST /interrupt → HTTP ${ir.status} after ${fmtMs(nowMs() - t0)}; history status ${excerpt(h.entry?.status, 200)}`];
      if (!ir.ok) return FAIL(`POST /interrupt → HTTP ${ir.status}`, { info: lines, fix: 'Cancelling a ComfyUI job would not stop it.' });
      const msgs = JSON.stringify(h.entry?.status?.messages || []);
      if (h.entry?.status?.status_str === 'error' || /interrupt/i.test(msgs)) return PASS('the run was interrupted', { info: lines });
      return WARN('the job finished normally (too fast to interrupt, or interrupt ignored)', { info: lines });
    }, { timeoutMs: 420000 });
  } finally {
    try { sock.ws?.close(); } catch { /* ignore */ }
  }
}

// =============================================================================================== OpenAI-style images
async function openaiImagesGroup(run, B) {
  const url = B.openaiImages.url;
  const T = (ms) => run.T(ms);
  run.section('raw', `OpenAI-style image server ${url}`);
  await run.check('openai-images.models', async ({ sample }) => {
    const r = await http(url, '/v1/models', { timeoutMs: T(10000), apiKey: run.opts.apiKey });
    sample('openai-images GET /v1/models', { status: r.status, body: r.json ?? r.text ?? r.error });
    if (!r.ok) return FAIL(`→ ${httpSummary(r)}`, { fix: 'OpenAIImagesProvider.status() would report it unreachable.' });
    return PASS(`${(r.json?.data || []).length} model(s): ${(r.json?.data || []).slice(0, 5).map((m) => m.id).join(', ')}`);
  });
  await run.check('openai-images.generate', async ({ sample }) => {
    need(run.opts.allowImages, 'image generation is off by default', '--allow-images');
    const proxy = await startRecordingProxy(url);
    try {
      const prov = new H.OpenAIImagesProvider({ id: 'oimg', name: 'images (live-check)', baseUrl: proxy.url, apiKey: run.opts.apiKey });
      let res = null;
      let err = null;
      const t0 = nowMs();
      try { res = await prov.generate({ prompt: 'a red circle on a white background', width: 256, height: 256, count: 1, seed: 42, steps: 2, cfg: 1.5 }, { signal: AbortSignal.timeout(T(600000)) }); } catch (e) { err = e; }
      const c = proxy.log.find((x) => x.path.startsWith('/v1/images/generations'));
      const j = c ? proxy.json(c) : null;
      sample('openai-images POST /v1/images/generations', { request: c?.reqBody, status: c?.status, body: j ? { ...j, data: (j.data || []).map((d) => ({ ...d, b64_json: d.b64_json ? `${d.b64_json.slice(0, 30)}…(${d.b64_json.length} chars)` : undefined })) } : c?.resBuf?.toString('utf8').slice(0, 400) });
      if (err) return FAIL(`Harness provider failed: ${err.message}`, { actual: c?.resBuf?.toString('utf8').slice(0, 300) });
      const d = decodeImage(res.images[0].buffer);
      return PASS(`${res.images.length} image(s), ${d.width}×${d.height} ${d.mime} via ${j?.data?.[0]?.b64_json ? 'b64_json' : 'url'} in ${fmtMs(nowMs() - t0)}`);
    } finally {
      await proxy.close();
    }
  }, { timeoutMs: 700000 });
}

// @@CONTINUE@@
