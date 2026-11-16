// Fast token estimator + per-model self-calibration from real prompt token counts.
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';
import { clamp } from '../lib/util.mjs';

const PIECE_RE = /(\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Thai})|(\p{L}[\p{L}\p{M}'’]*)|(\p{N}+)|(\s+)|([^\s\p{L}\p{N}]+)/gu;

/**
 * Heuristic token count for modern large-vocabulary tokenizers (Llama 3 / Gemma / Qwen).
 * Deliberately simple and fast (~50MB/s); per-model calibration corrects systematic bias.
 */
export function estimateTextTokens(text) {
  if (!text) return 0;
  let n = 0;
  PIECE_RE.lastIndex = 0;
  let m;
  while ((m = PIECE_RE.exec(text))) {
    if (m[1]) n += 1; // CJK / Thai char
    else if (m[2]) n += Math.max(1, Math.ceil(m[2].length / 7));
    else if (m[3]) n += Math.ceil(m[3].length / 3);
    else if (m[4]) {
      const ws = m[4];
      const nl = (ws.match(/\n/g) || []).length;
      if (nl) n += Math.ceil(nl / 2);
      else if (ws.length > 1) n += Math.ceil((ws.length - 1) / 4);
    } else if (m[5]) n += Math.ceil(m[5].length / 2);
  }
  return n;
}

export const MESSAGE_OVERHEAD = 4; // role markers / separators per message
export const PROMPT_OVERHEAD = 3; // BOS + generation prompt

/**
 * Raw (uncalibrated) estimate for a neutral message `{ role, content, images, toolCalls }`.
 */
export function estimateMessageTokensRaw(msg, { imageTokens = 300 } = {}) {
  let n = MESSAGE_OVERHEAD + estimateTextTokens(msg.content || '');
  if (msg.toolCalls?.length) n += estimateTextTokens(JSON.stringify(msg.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })))) + 4;
  if (msg.images?.length) n += msg.images.length * imageTokens;
  return n;
}

export function estimateToolsTokensRaw(tools) {
  if (!tools?.length) return 0;
  return estimateTextTokens(JSON.stringify(tools)) + 10;
}

/**
 * Per-model calibration store. ratio = actual prompt tokens / raw estimate, smoothed by EMA.
 * Persisted to `<dataDir>/calibration.json`.
 */
export class Calibrator {
  constructor(dataDir) {
    this.file = dataDir ? path.join(dataDir, 'calibration.json') : null;
    this.data = {};
    this._saveTimer = null;
  }

  async load() {
    if (this.file) this.data = (await readJson(this.file, {})) || {};
    return this;
  }

  key(providerId, model) {
    return `${providerId}/${model}`;
  }

  get(providerId, model) {
    return this.data[this.key(providerId, model)] || null;
  }

  factor(providerId, model) {
    return this.get(providerId, model)?.ratio ?? 1;
  }

  /**
   * Feed one observation. Ignored when the sample is unreliable: tiny prompts, prompts that hit
   * the context limit (backend truncated), or implausible ratios (cache artifacts).
   * Returns the updated entry, or null if ignored.
   */
  observe(providerId, model, { estimatedRaw, actual, numCtx, hasImages = false }) {
    if (!Number.isFinite(actual) || !Number.isFinite(estimatedRaw)) return null;
    if (hasImages || estimatedRaw < 48 || actual < 16) return null;
    if (numCtx && actual >= numCtx * 0.98) return null;
    const sample = actual / estimatedRaw;
    if (sample < 0.33 || sample > 3) return null;
    const k = this.key(providerId, model);
    const prev = this.data[k];
    const samples = (prev?.samples || 0) + 1;
    const alpha = Math.max(0.2, 1 / samples);
    const ratio = prev ? prev.ratio * (1 - alpha) + sample * alpha : sample;
    this.data[k] = { ratio: Math.round(clamp(ratio, 0.33, 3) * 10000) / 10000, samples, lastSample: Math.round(sample * 10000) / 10000, updatedAt: new Date().toISOString() };
    this.scheduleSave();
    return this.data[k];
  }

  scheduleSave() {
    if (!this.file || this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.save(); }, 250);
    this._saveTimer.unref?.();
  }

  async save() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this.file) await writeJsonAtomic(this.file, this.data);
  }

  /** A counter bound to a model: estimates scaled by that model's calibration factor. */
  counter(providerId, model, { imageTokens = 300 } = {}) {
    const factor = this.factor(providerId, model);
    return makeCounter(factor, imageTokens);
  }
}

export function makeCounter(factor = 1, imageTokens = 300) {
  return {
    factor,
    imageTokens,
    rawText: (t) => estimateTextTokens(t),
    text: (t) => Math.ceil(estimateTextTokens(t) * factor),
    messageRaw: (m) => estimateMessageTokensRaw(m, { imageTokens }),
    message: (m) => Math.ceil(estimateMessageTokensRaw(m, { imageTokens }) * factor),
    toolsRaw: (tools) => estimateToolsTokensRaw(tools),
    tools: (tools) => Math.ceil(estimateToolsTokensRaw(tools) * factor),
  };
}
