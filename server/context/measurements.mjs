// Real memory measurements of loaded models, persisted per model so context sizing can correct its
// architecture-based estimate (see fitMeasurements in sizing.mjs).
//
// Ground truth is what the machine experiences, read right after a request that (re)loaded the model:
//  - the resident size (RSS) of the Ollama runner process serving the model (macOS `ps`; see memory-probe.mjs);
//  - swap / compressor growth across the load: RSS under-reports once macOS compresses or swaps, so growth is
//    recorded as the "this did not fit" signal and such samples are never used as a size.
// Ollama's /api/ps `size` is NOT the resident footprint (it excludes the weights: Nemotron reports a flat ~90 MB
// at every context while its runner holds ~4.3 GB). It is used only as the non-weights part when no runner RSS
// can be attributed: total ≈ model file + size (size ≥ file → it already includes the weights, e.g. num_gpu 0).
// Remote backends and non-macOS machines are not measured (estimate only).
//
// measurements.json: { "<providerId>/<model>": { v: 2, digest, sizeBytes, samples: [Sample] } }
// Sample: { numCtx, sentNumCtx, reportedContext, totalBytes, source: 'rss'|'ps', rssBytes, psSizeBytes,
//           psVramBytes, vramBytes, cpuBytes, pressure: {swapDeltaBytes, compressedDeltaBytes, level, signal}|null,
//           loaded, kvCacheType, at }
// An entry is discarded when the model's digest or file size changes (re-pulled / different quant), and entries
// written by the older format (ps size taken as the total) are dropped on load.
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';
import { nowIso } from '../lib/util.mjs';
import { log } from '../lib/log.mjs';
import { isLocalUrl, pressureDelta } from '../system/memory-probe.mjs';

const MAX_PER_CTX = 5;
const MAX_SAMPLES = 40;
export const MEASUREMENT_VERSION = 2;

const norm = (n) => (n && !n.includes(':') ? `${n}:latest` : n);

export class MeasurementStore {
  constructor(dataDir, bus) {
    this.file = dataDir ? path.join(dataDir, 'measurements.json') : null;
    this.bus = bus;
    this.data = {};
    this._timer = null;
  }

  async load() {
    if (this.file) {
      const raw = (await readJson(this.file, {})) || {};
      // v1 entries took /api/ps `size` as the resident total, which real Ollama does not report: drop them.
      this.data = Object.fromEntries(Object.entries(raw).filter(([, e]) => e && e.v === MEASUREMENT_VERSION && Array.isArray(e.samples)));
    }
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
    if (!e || !this.matches(e, { digest, sizeBytes })) e = { v: MEASUREMENT_VERSION, digest, sizeBytes, samples: [] };
    e.v = MEASUREMENT_VERSION;
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
   * Measure what `model` occupies right now, after a request at `numCtx`.
   * @param {object} provider  Ollama provider (others → null)
   * @param {string} model
   * @param {object} o
   * @param {number} o.numCtx           num_ctx we sent
   * @param {string} o.kvCacheType
   * @param {string} [o.digest]         model digest (tags) — invalidates samples when the build changes
   * @param {number} [o.sizeBytes]      model file size (tags)
   * @param {string} [o.modelBlob]      weights blob digest (first FROM of the Modelfile) — matches the runner process
   * @param {object} [o.probe]          memory probe (memory-probe.mjs); null → estimate only
   * @param {object} [o.baseline]       pressure snapshot taken before the request
   * @param {boolean} [o.loaded]        this request (re)loaded the model (pressure growth is attributed to it)
   * @returns {Promise<object|null>} the sample, or null when nothing trustworthy could be measured
   */
  async measure(provider, model, { numCtx, kvCacheType, digest = null, sizeBytes = null, modelBlob = null, probe = null, baseline = null, loaded = false } = {}) {
    if (provider?.kind !== 'ollama' || typeof provider.ps !== 'function') return null;
    if (!probe || !isLocalUrl(provider.baseUrl)) return null; // remote backend / not macOS: estimate only
    let list;
    try { list = await provider.ps(); } catch (e) { log.debug('measure: ps failed', e.message); return null; }
    const entry = (list || []).find((m) => m.model === model || m.name === model || norm(m.model) === norm(model) || norm(m.name) === norm(model));
    if (!entry) return null;
    const [runners, after] = await Promise.all([probe.runners().catch(() => null), probe.pressure().catch(() => null)]);
    let runner = null;
    if (Array.isArray(runners)) {
      runner = (modelBlob && runners.find((r) => r.modelBlob === modelBlob)) || null;
      // One runner and one loaded model: it is ours even when the blob cannot be matched (older runner arguments).
      if (!runner && runners.length === 1 && list.length === 1) runner = runners[0];
    }
    const psSize = Number.isFinite(entry.sizeBytes) && entry.sizeBytes >= 0 ? entry.sizeBytes : null;
    const psVram = Number.isFinite(entry.vramBytes) && entry.vramBytes >= 0 ? entry.vramBytes : null;
    let totalBytes = null;
    let source = null;
    if (runner?.rssBytes > 0) { totalBytes = runner.rssBytes; source = 'rss'; } else if (psSize !== null && sizeBytes) {
      totalBytes = psSize >= sizeBytes ? psSize : sizeBytes + psSize;
      source = 'ps';
    }
    if (!totalBytes) return null;
    const cpuBytes = psSize !== null && psVram !== null && psVram < psSize ? psSize - psVram : psSize !== null && psVram !== null ? 0 : null;
    const reported = Number(entry.contextLength);
    const hasReported = Number.isFinite(reported) && reported >= 256;
    const pressure = loaded ? pressureDelta(baseline, after) : null;
    const sample = {
      numCtx: hasReported && reported < numCtx ? reported : numCtx,
      sentNumCtx: numCtx,
      reportedContext: hasReported ? reported : null,
      totalBytes,
      source,
      rssBytes: runner?.rssBytes ?? null,
      psSizeBytes: psSize,
      psVramBytes: psVram,
      cpuBytes,
      vramBytes: cpuBytes !== null ? Math.max(0, totalBytes - cpuBytes) : null,
      pressure,
      loaded: !!loaded,
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
