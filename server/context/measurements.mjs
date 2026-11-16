// Real memory measurements of loaded models (Ollama /api/ps), persisted per model so context sizing
// can correct its architecture-based estimate (see fitMeasurements in sizing.mjs).
//
// measurements.json: { "<providerId>/<model>": { digest, sizeBytes, samples: [Sample] } }
// Sample: { numCtx, sentNumCtx, reportedContext, totalBytes, vramBytes, kvCacheType, at }
// An entry is discarded when the model's digest or file size changes (re-pulled / different quant).
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';
import { nowIso } from '../lib/util.mjs';
import { log } from '../lib/log.mjs';

const MAX_PER_CTX = 5;
const MAX_SAMPLES = 40;

const norm = (n) => (n && !n.includes(':') ? `${n}:latest` : n);

export class MeasurementStore {
  constructor(dataDir, bus) {
    this.file = dataDir ? path.join(dataDir, 'measurements.json') : null;
    this.bus = bus;
    this.data = {};
    this._timer = null;
  }

  async load() {
    if (this.file) this.data = (await readJson(this.file, {})) || {};
    return this;
  }

  key(providerId, model) { return `${providerId}/${model}`; }

  /** Raw entry (or null). */
  get(providerId, model) { return this.data[this.key(providerId, model)] || null; }

  /** Samples valid for this model build and KV cache type (stale entries are ignored, not returned). */
  samplesFor(providerId, model, { digest = null, sizeBytes = null, kvCacheType = null } = {}) {
    const e = this.get(providerId, model);
    if (!e || !this.matches(e, { digest, sizeBytes })) return [];
    return e.samples.filter((s) => !kvCacheType || s.kvCacheType === kvCacheType);
  }

  matches(e, { digest, sizeBytes }) {
    if (digest && e.digest && digest !== e.digest) return false;
    if (sizeBytes && e.sizeBytes && sizeBytes !== e.sizeBytes) return false;
    return true;
  }

  /** Add a sample; resets the entry when the model build changed. */
  record(providerId, model, { digest = null, sizeBytes = null }, sample) {
    const k = this.key(providerId, model);
    let e = this.data[k];
    if (!e || !this.matches(e, { digest, sizeBytes })) e = { digest, sizeBytes, samples: [] };
    e.digest = digest || e.digest || null;
    e.sizeBytes = sizeBytes || e.sizeBytes || null;
    e.samples.push(sample);
    // keep the latest few per (context, KV type) and a bounded total
    const seen = new Map();
    const kept = [];
    for (const s of [...e.samples].reverse()) {
      const g = `${s.numCtx}|${s.kvCacheType}`;
      const n = seen.get(g) || 0;
      if (n >= MAX_PER_CTX) continue;
      seen.set(g, n + 1);
      kept.unshift(s);
    }
    e.samples = kept.slice(-MAX_SAMPLES);
    this.data[k] = e;
    this.scheduleSave();
    return e;
  }

  reset(providerId, model) {
    const k = this.key(providerId, model);
    const had = !!this.data[k];
    delete this.data[k];
    this.scheduleSave();
    return had;
  }

  /**
   * Read Ollama /api/ps for `model` and record what it actually occupies at the num_ctx we sent.
   * `context_length` is optional in /api/ps (not in the published API reference); when present and smaller
   * than what we sent (the server capped it), it is used as the sample's context. Returns the sample or null.
   */
  async measure(provider, model, { numCtx, kvCacheType, digest = null, sizeBytes = null } = {}) {
    if (provider?.kind !== 'ollama' || typeof provider.ps !== 'function') return null;
    let list;
    try { list = await provider.ps(); } catch (e) { log.debug('measure: ps failed', e.message); return null; }
    const entry = (list || []).find((m) => m.model === model || m.name === model || norm(m.model) === norm(model) || norm(m.name) === norm(model));
    if (!entry || !Number.isFinite(entry.sizeBytes) || entry.sizeBytes <= 0) return null;
    const reported = Number(entry.contextLength);
    const hasReported = Number.isFinite(reported) && reported >= 256;
    const sample = {
      numCtx: hasReported && reported < numCtx ? reported : numCtx,
      sentNumCtx: numCtx,
      reportedContext: hasReported ? reported : null,
      totalBytes: entry.sizeBytes,
      vramBytes: Number.isFinite(entry.vramBytes) ? entry.vramBytes : null,
      kvCacheType,
      at: nowIso(),
    };
    this.record(provider.id, model, { digest: digest || entry.digest || null, sizeBytes }, sample);
    this.bus?.publish('model.measured', { providerId: provider.id, model, sample });
    return sample;
  }

  scheduleSave() {
    if (!this.file || this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.save().catch(() => {}); }, 200);
    this._timer.unref?.();
  }

  async save() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this.file) await writeJsonAtomic(this.file, this.data);
  }
}
