// "The model failed to load" — Ollama answers HTTP 500 {"error":"llama-server process has terminated: signal:
// abort trap"} when its runner dies during start-up (seen with Nemotron's vision/audio projector on Apple's
// virtual GPU). This module turns that into a specific, human message with next steps, and remembers the failure
// so background work (titles, memory extraction, summaries) does not keep re-triggering a slow, failing load.
import { ProviderError } from '../lib/errors.mjs';
import { formatBytes } from '../lib/util.mjs';
import { smallerVariantFor } from './catalog.mjs';

const REMEMBER_MS = 10 * 60 * 1000;

export class LoadFailures {
  constructor() { this.map = new Map(); }
  key(providerId, model) { return `${providerId}/${model}`; }
  record(providerId, model, info) { this.map.set(this.key(providerId, model), { ...info, at: Date.now() }); }
  clear(providerId, model) { this.map.delete(this.key(providerId, model)); }
  /** A recent failure (within 10 min) or null. A successful chat request clears it. */
  get(providerId, model) {
    const f = this.map.get(this.key(providerId, model));
    if (!f) return null;
    if (Date.now() - f.at > REMEMBER_MS) { this.map.delete(this.key(providerId, model)); return null; }
    return f;
  }
}

/**
 * Build the user-facing explanation for a load failure.
 * @param {{ model: string, providerId: string, info?: object, totalMem?: number, raw: string }} o
 * @returns {{ message: string, nextSteps: Array<{action: string, label: string, method?: string, path?: string, body?: object}> }}
 */
export function describeLoadFailure({ model, providerId, info = {}, totalMem = 0, raw }) {
  const caps = info.capabilities || [];
  const multimodal = caps.includes('vision') || caps.includes('audio') || info.hasProjector;
  const nextSteps = [];
  let why = '';
  if (multimodal && providerId) {
    why = ' This happens when the image/audio part of a model (its projector) cannot start on this Mac\'s GPU.';
    nextSteps.push({ action: 'create_text_only_copy', label: 'Create a text-only copy (no image/audio input, about 1 GB less RAM, nothing to download)', method: 'POST', path: '/api/models/text-only', body: { model, providerId } });
  }
  const smaller = smallerVariantFor(model, { totalMem });
  if (smaller) nextSteps.push({ action: 'use_smaller_file', label: `Use a smaller file: ${smaller.model} (${formatBytes(smaller.approxSizeBytes)})`, model: smaller.model });
  nextSteps.push({ action: 'retry', label: 'Try again (after closing other apps if memory is tight)' });
  const message = `${model} could not be loaded: Ollama's model runner stopped while starting it (${String(raw).slice(0, 200)}).${why} ${nextSteps.length > 1 ? `Next step: ${nextSteps[0].label.charAt(0).toLowerCase()}${nextSteps[0].label.slice(1)}.` : 'Try again, or pick a smaller model.'}`;
  return { message, nextSteps };
}

export function loadFailureError(e, ctx) {
  const d = describeLoadFailure({ ...ctx, raw: e.message });
  return Object.assign(new ProviderError(d.message, { status: 502, code: 'model_load_failed', providerId: ctx.providerId, cause: e }), { nextSteps: d.nextSteps });
}
