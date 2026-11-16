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

// @@CONTINUE@@
