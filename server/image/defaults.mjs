// Image-generation parameter defaults by model family + RAM tier, aspect presets and memory warnings.
import { GiB } from '../lib/util.mjs';
import { ramTier } from '../context/sizing.mjs';

/**
 * Families detected from the model/checkpoint name (first match wins).
 * `base` = native square resolution; `approxBytes` = rough resident memory while generating.
 * `comfy` = sampler/scheduler names for ComfyUI's KSampler.
 */
export const IMAGE_FAMILIES = [
  { id: 'flux-schnell', match: /flux.*schnell|schnell/i, label: 'FLUX.1 schnell (few-step)', steps: 4, cfg: 1, base: 1024, fewStep: true, approxBytes: 12 * GiB, comfy: { sampler: 'euler', scheduler: 'simple' } },
  { id: 'flux', match: /flux/i, label: 'FLUX.1', steps: 20, cfg: 3.5, base: 1024, approxBytes: 12 * GiB, comfy: { sampler: 'euler', scheduler: 'simple' } },
  { id: 'sd-turbo', match: /\bsd[-_ ]?turbo|sd2.*turbo/i, label: 'SD Turbo (few-step)', steps: 2, cfg: 1, base: 512, fewStep: true, approxBytes: 2.5 * GiB, comfy: { sampler: 'euler_ancestral', scheduler: 'normal' } },
  { id: 'sdxl-turbo', match: /turbo/i, label: 'SDXL Turbo (few-step)', steps: 4, cfg: 1, base: 512, fewStep: true, approxBytes: 7 * GiB, comfy: { sampler: 'euler_ancestral', scheduler: 'normal' } },
  { id: 'sdxl-lightning', match: /lightning|hyper[-_ ]?sd|\blcm\b|dmd2?/i, label: 'Lightning/Hyper/LCM (few-step)', steps: 6, cfg: 1.5, base: 1024, fewStep: true, approxBytes: 7 * GiB, comfy: { sampler: 'euler', scheduler: 'sgm_uniform' } },
  { id: 'sd3', match: /\bsd3|stable[-_ ]?diffusion[-_ ]?3/i, label: 'Stable Diffusion 3.x', steps: 28, cfg: 4.5, base: 1024, approxBytes: 8 * GiB, comfy: { sampler: 'dpmpp_2m', scheduler: 'sgm_uniform' } },
  { id: 'sdxl', match: /sdxl|\bxl\b|_xl|-xl|pony|illustrious|juggernaut|playground/i, label: 'SDXL', steps: 25, cfg: 6, base: 1024, approxBytes: 7 * GiB, comfy: { sampler: 'dpmpp_2m', scheduler: 'karras' } },
  { id: 'sd15', match: /1[._-]?5|v1-5|sd15|\bsd-?1\b|dreamshaper(?!.*xl)|realistic[-_ ]?vision/i, label: 'Stable Diffusion 1.5', steps: 25, cfg: 7, base: 512, approxBytes: 2.5 * GiB, comfy: { sampler: 'dpmpp_2m', scheduler: 'karras' } },
];

export const DEFAULT_FAMILY = { id: 'unknown', label: 'Unknown', steps: 20, cfg: 6, base: 768, approxBytes: 5 * GiB, comfy: { sampler: 'dpmpp_2m', scheduler: 'karras' } };

export function imageFamilyFor(model) {
  return IMAGE_FAMILIES.find((f) => f.match.test(model || '')) || DEFAULT_FAMILY;
}

export const ASPECTS = { square: 1, portrait: 2 / 3, landscape: 3 / 2, wide: 16 / 9, tall: 9 / 16 };

const floor64 = (n) => Math.max(64, Math.floor(n / 64) * 64);

/** Width/height for an aspect at a base square resolution (area ≤ base², multiples of 64). */
export function sizeForAspect(aspect, base) {
  const r = ASPECTS[aspect] ?? 1;
  return { width: floor64(base * Math.sqrt(r)), height: floor64(base / Math.sqrt(r)) };
}

/** Parse "768x512" / "768×512". */
export function parseSize(s) {
  const m = String(s || '').match(/^\s*(\d{2,4})\s*[x×*]\s*(\d{2,4})\s*$/i);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * Resolve final generation parameters: explicit request > user defaults (settings.image.defaults) >
 * family defaults, with the base resolution capped to 512 on ≤8 GB machines.
 * Returns `{ params, family, warnings }`.
 */
export function resolveImageParams(req, { settings, totalMem, model, providerKind }) {
  const d = settings.image?.defaults || {};
  const family = imageFamilyFor(model || req.model || '');
  const tier = ramTier(totalMem);
  const base = tier === 'low' ? Math.min(512, family.base) : family.base;
  let width = req.width ?? null;
  let height = req.height ?? null;
  if (req.size && (!width || !height)) {
    const ps = parseSize(req.size);
    if (ps) ({ width, height } = ps);
  }
  if ((!width || !height) && req.aspect) ({ width, height } = sizeForAspect(req.aspect, base));
  width ||= d.width || sizeForAspect('square', base).width;
  height ||= d.height || sizeForAspect('square', base).height;
  width = floor64(Math.min(4096, width));
  height = floor64(Math.min(4096, height));
  const steps = req.steps ?? d.steps ?? family.steps;
  const cfg = req.cfg ?? d.cfg ?? family.cfg;
  const count = Math.max(1, Math.min(8, req.count ?? d.count ?? 1));
  let seed = req.seed;
  if (seed === undefined || seed === null || seed < 0) seed = Math.floor(Math.random() * 2 ** 31);
  const negativePrompt = req.negativePrompt ?? d.negativePrompt ?? '';
  const sampler = req.sampler ?? d.sampler ?? null;
  const params = {
    prompt: String(req.prompt || '').trim(),
    negativePrompt,
    width, height, steps, cfg, seed, count, sampler,
    scheduler: req.scheduler ?? null,
    model: model || null,
    denoise: req.denoise ?? 0.6,
  };

  const warnings = [];
  const px = width * height;
  if (tier === 'low') {
    if (px > 768 * 768) warnings.push({ code: 'large_size_low_ram', message: `${width}×${height} may exhaust memory on an 8 GB Mac; 512×512-class sizes are recommended.` });
    if (family.approxBytes > 6 * GiB) warnings.push({ code: 'heavy_model_low_ram', message: `${family.label} models usually need more than 8 GB of RAM; expect heavy swapping. A few-step SD 1.5/SD-Turbo model is recommended.` });
    if (count > 1) warnings.push({ code: 'batch_low_ram', message: `Generating ${count} images at once multiplies memory use; consider 1 at a time on 8 GB.` });
  } else if (tier === 'medium') {
    if (px > 1280 * 1280) warnings.push({ code: 'large_size', message: `${width}×${height} is large for a 16 GB machine.` });
    if (count > 4) warnings.push({ code: 'large_batch', message: `A batch of ${count} images may run out of memory.` });
  }
  if (family.fewStep && steps > 12) warnings.push({ code: 'steps_high_for_family', message: `${family.label} is designed for ~${family.steps} steps; ${steps} steps is slower without improving quality.` });
  if (!family.fewStep && steps > 60) warnings.push({ code: 'steps_high', message: `${steps} steps is slow; 20–30 is usually enough.` });
  if (providerKind === 'openai' && req.initImage) warnings.push({ code: 'img2img_unsupported', message: 'This provider does not support image-to-image; the init image is ignored.' });
  return { params, family: { id: family.id, label: family.label, fewStep: !!family.fewStep, approxBytes: family.approxBytes, comfy: family.comfy }, warnings };
}
