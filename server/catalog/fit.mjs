// "Fits this Mac?" for catalogue entries: the same context planner the rest of Harness uses, from what the site
// tells us (a file size, or only a parameter count).
import { computeContextPlan, ramTier } from '../context/sizing.mjs';
import { profileFor, RECOMMENDED_MODELS } from '../providers/catalog.mjs';
import { formatBytes } from '../lib/util.mjs';

export const BYTES_PER_PARAM_Q4 = 4.8 / 8; // ≈ Q4_K_M

export function fitContext(app) {
  const sys = app.system;
  const s = app.settings.get();
  const kv = app.registry.kvCacheType(s);
  const ctx = s.context || {};
  const lowRam = ramTier(sys.totalMem) === 'low';
  const estimate = ({ bytes, contextLength, name, arch }) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    const plan = computeContextPlan({ providerKind: 'ollama', modelMax: contextLength || 8192, modelMaxSource: 'catalog', modelBytes: bytes, arch: arch || {}, profile: profileFor(name || ''), mode: 'auto', system: sys, kvCacheType: kv, lowRamCap: ctx.lowRamCap ?? null, memoryFraction: ctx.memoryFraction ?? null });
    return { fits: !!plan.fits && !plan.warnings.some((w) => w.code === 'model_exceeds_budget'), numCtx: plan.numCtx, limitedBy: plan.limitedBy, estimatedTotalBytes: plan.memory?.estimatedTotalBytes ?? null, explanation: plan.explanation };
  };
  /** List view: from the parameter count (≈4.8 bits per weight) or a known size. */
  const listFit = ({ parameters, sizeBytes, contextLength, name }) => {
    const bytes = sizeBytes || (parameters ? parameters * BYTES_PER_PARAM_Q4 : null);
    const e = estimate({ bytes, contextLength, name });
    if (!e) return null;
    return { fits: e.fits, sizeBytes: Math.round(bytes), numCtx: e.numCtx, basis: sizeBytes ? 'tag_sizes' : 'parameters', note: sizeBytes ? `≈ ${formatBytes(bytes)}` : `≈ ${formatBytes(bytes)} at 4-bit` };
  };
  return { lowRam, estimate, listFit, totalMem: sys.totalMem };
}

/** Pullable names of the curated recommendations (Ollama tags and hf.co references). */
export function curatedModels() {
  const out = new Set();
  for (const r of RECOMMENDED_MODELS) for (const v of r.variants) out.add(String(v.model).toLowerCase());
  return out;
}

/** The largest file that fits with a useful window (≥ 8K, else ≥ 4K). */
export function pickRecommended(files) {
  const ok = (f, min) => f.fit?.fits && f.fit.numCtx >= min && f.pullable !== false;
  const by = (min) => files.filter((f) => ok(f, min)).sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0))[0];
  return by(8192) || by(4096) || null;
}
