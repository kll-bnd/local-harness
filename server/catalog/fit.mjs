// "Fits this Mac?" for catalogue entries: the same context planner the rest of Harness uses, from what the site
// tells us (a file size, or only a parameter count).
import { computeContextPlan, ramTier, memoryBudget } from '../context/sizing.mjs';
import { profileFor, RECOMMENDED_MODELS } from '../providers/catalog.mjs';
import { formatBytes } from '../lib/util.mjs';

export const BYTES_PER_PARAM_Q4 = 4.8 / 8; // ≈ Q4_K_M
// Realistic GGUF file sizes per parameter (the Nemotron 3.5 Bolt E4B repository: UD-IQ3_XXS ≈ 4.0 bits per weight,
// UD-Q3_K_XL ≈ 4.6, UD-Q4_K_XL ≈ 5.5).
export const BPW = Object.freeze({ small: 4.0, typical: 4.6, large: 5.5 });
const USEFUL_CTX = 8192;
const MIN_CTX = 4096;

/** The curated recommendation a catalogue entry is (for its measured architecture hints), or null. */
export function curatedFor(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return null;
  return RECOMMENDED_MODELS.find((r) => r.variants.some((v) => {
    const m = String(v.model).toLowerCase();
    return m === n || m.startsWith(`hf.co/${n}:`) || m.split(':')[0] === n || m.startsWith(`${n}:`);
  })) || null;
}

export function fitContext(app) {
  const sys = app.system;
  const s = app.settings.get();
  const kv = app.registry.kvCacheType(s);
  const ctx = s.context || {};
  const lowRam = ramTier(sys.totalMem) === 'low';
  const budgetBytes = memoryBudget({ totalMem: sys.totalMem, platform: sys.platform, arch: sys.arch, memoryFraction: ctx.memoryFraction }).budgetBytes;
  const estimate = ({ bytes, contextLength, name, arch }) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    const rec = curatedFor(name);
    const plan = computeContextPlan({ providerKind: 'ollama', modelMax: contextLength || rec?.contextLength || 8192, modelMaxSource: 'catalog', modelBytes: bytes, arch: arch || rec?.archHint || {}, profile: profileFor(name || '', rec?.family), mode: 'auto', system: sys, kvCacheType: kv, lowRamCap: ctx.lowRamCap ?? null, memoryFraction: ctx.memoryFraction ?? null });
    return { fits: !!plan.fits && !plan.warnings.some((w) => w.code === 'model_exceeds_budget'), numCtx: plan.numCtx, limitedBy: plan.limitedBy, estimatedTotalBytes: plan.memory?.estimatedTotalBytes ?? null, explanation: plan.explanation };
  };
  const ok = (e, min) => !!(e && e.fits && e.numCtx >= min);
  /**
   * The list's at-a-glance answer: `verdict` 'comfortable' (a typical-to-large file fits with a useful window),
   * 'smaller_file' (only a smaller quantization fits), 'too_big'. From a known size (Ollama tag sizes) or, for a
   * parameter count, over the realistic range of file sizes; a vision repository is assumed to run as a
   * text-only copy on a low-RAM Mac (what the detail recommends there). The detail view stays the authority.
   */
  const listFit = ({ parameters, sizeBytes, contextLength, name, vision = false }) => {
    if (sizeBytes) {
      const e = estimate({ bytes: sizeBytes, contextLength, name });
      if (!e) return null;
      const verdict = ok(e, USEFUL_CTX) ? 'comfortable' : ok(e, MIN_CTX) ? 'smaller_file' : 'too_big';
      return { fits: verdict !== 'too_big', verdict, sizeBytes: Math.round(sizeBytes), numCtx: e.numCtx, basis: 'tag_sizes', note: `≈ ${formatBytes(sizeBytes)}` };
    }
    if (!parameters) return null;
    const textOnly = !!(vision && lowRam);
    const projector = vision && !lowRam ? Math.min(1.1e9, parameters * 0.13) : 0;
    const bytesAt = (bpw) => parameters * bpw / 8 + projector;
    const large = estimate({ bytes: bytesAt(BPW.large), contextLength, name });
    const typical = estimate({ bytes: bytesAt(BPW.typical), contextLength, name });
    const small = estimate({ bytes: bytesAt(BPW.small), contextLength, name });
    const verdict = ok(large, USEFUL_CTX) || ok(typical, USEFUL_CTX) ? 'comfortable' : ok(small, MIN_CTX) || ok(typical, MIN_CTX) ? 'smaller_file' : 'too_big';
    const shown = verdict === 'comfortable' ? (ok(large, USEFUL_CTX) ? large : typical) : small;
    const range = `${formatBytes(bytesAt(BPW.small))}–${formatBytes(bytesAt(BPW.large))}`;
    return {
      fits: verdict !== 'too_big', verdict, sizeBytes: Math.round(bytesAt(BPW.typical)), sizeRange: [Math.round(bytesAt(BPW.small)), Math.round(bytesAt(BPW.large))],
      numCtx: shown?.numCtx ?? null, basis: 'parameters_estimate', textOnly,
      note: `Estimate from the parameter count: files of about ${range}${textOnly ? ' as a text-only copy' : ''}; ${verdict === 'comfortable' ? 'fits this Mac' : verdict === 'smaller_file' ? 'a smaller file fits this Mac' : 'too big for this Mac'}. The model page sizes every file.`,
    };
  };
  return { lowRam, estimate, listFit, totalMem: sys.totalMem, budgetBytes };
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
