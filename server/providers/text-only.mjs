// Text-only copies of multimodal Ollama models: the same weights blob without the vision/audio projector, created
// with POST /api/create {files} in a couple of seconds (no download, the blob is shared). On an 8 GB Mac this saves
// the projector's ~1 GB of RAM, and it avoids projector start-up crashes (Nemotron's BF16 projector on GPUs
// without bfloat support). Recipe verified against Ollama 0.40.13 with Nemotron 3.5 Bolt E4B:
//   files:      {"model.gguf": "sha256:<digest of the FIRST `FROM …/blobs/sha256-…` line of show.modelfile>"}
//   template:   the `TEMPLATE "…"` block of show.modelfile (NOT show.template, which can hold the GGUF's jinja
//               template — create rejects that), or none when the modelfile has no TEMPLATE block
//   parameters: parsed from show.parameters (repeated keys → arrays)
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';
import { HttpError } from '../lib/errors.mjs';
import { nowIso } from '../lib/util.mjs';
import { modelfileBlobs } from './ollama.mjs';
import { textOnlyName } from './catalog.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,150}(:[a-z0-9._-]{1,80})?$/;

/** The TEMPLATE block of a Modelfile ("…" possibly spanning lines, or """…"""), unescaped; null when absent. */
export function parseModelfileTemplate(modelfile) {
  const src = String(modelfile || '');
  const m = /^TEMPLATE[ \t]+/m.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  if (src.startsWith('"""', i)) {
    const end = src.indexOf('"""', i + 3);
    return end < 0 ? null : src.slice(i + 3, end);
  }
  if (src[i] !== '"') {
    const eol = src.indexOf('\n', i);
    return src.slice(i, eol < 0 ? src.length : eol).trim() || null;
  }
  let out = '';
  for (i += 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length && (src[i + 1] === '"' || src[i + 1] === '\\')) { out += src[++i]; continue; }
    if (c === '"') return out;
    out += c;
  }
  return null; // unterminated
}

/**
 * The one place that decides the copy's chat template (isolated on purpose: this is model-format sensitive).
 * Never `show.template` — for GGUF-native models it is the jinja template, which /api/create rejects.
 * @returns {{ template: string|undefined, source: 'modelfile'|'none' }}
 */
export function textOnlyTemplate(show) {
  const t = parseModelfileTemplate(show?.modelfile);
  return t ? { template: t, source: 'modelfile' } : { template: undefined, source: 'none' };
}

/** show.parameters text → /api/create `parameters` object (repeated keys → arrays; stop is always an array). */
export function parametersForCreate(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(.+)$/);
    if (!m) continue;
    const k = m[1];
    let v = m[2].trim();
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } } else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    if (k === 'stop' || k in out) out[k] = [...(out[k] === undefined ? [] : [].concat(out[k])), v];
    else out[k] = v;
  }
  return out;
}

export function isMultimodal(show) {
  const caps = Array.isArray(show?.capabilities) ? show.capabilities : [];
  return modelfileBlobs(show?.modelfile).length >= 2 || caps.includes('vision') || caps.includes('audio') || !!show?.projector_info;
}

/** Copies Harness created, so only those can be deleted through this API: { "<providerId>/<name>": {...} }. */
export class ModelCopies {
  constructor(dataDir) { this.file = dataDir ? path.join(dataDir, 'model-copies.json') : null; this.data = {}; }
  async load() { if (this.file) this.data = (await readJson(this.file, {})) || {}; return this; }
  key(providerId, model) { return `${providerId}/${model}`; }
  get(providerId, model) { return this.data[this.key(providerId, model)] || null; }
  list() { return Object.entries(this.data).map(([k, v]) => ({ key: k, ...v })); }
  async set(providerId, model, rec) { this.data[this.key(providerId, model)] = rec; if (this.file) await writeJsonAtomic(this.file, this.data); }
  async remove(providerId, model) { delete this.data[this.key(providerId, model)]; if (this.file) await writeJsonAtomic(this.file, this.data); }
}

/**
 * Create (or return the existing) text-only copy of an installed multimodal Ollama model.
 * @returns {Promise<{ model, providerId, source, created, digest, template, capabilities, sizeBytes, sourceSizeBytes, note }>}
 */
export async function createTextOnlyCopy(app, provider, source, { name } = {}) {
  if (provider.kind !== 'ollama' || typeof provider.create !== 'function') throw new HttpError(400, 'unsupported', 'Text-only copies need an Ollama provider');
  const target = name || textOnlyName(source);
  if (!NAME_RE.test(target)) throw new HttpError(400, 'bad_request', 'name must be a lower-case Ollama model name like "my-model-text:q3"');
  const show = await provider.show(source);
  if (!isMultimodal(show)) throw new HttpError(400, 'not_multimodal', `${source} has no vision/audio part; it is already text-only.`);
  const digest = modelfileBlobs(show.modelfile)[0];
  if (!digest) throw new HttpError(422, 'no_model_blob', `Could not find the weights file of ${source} in its Modelfile.`);
  const sourceTag = await app.registry.findModel(source, provider.id).catch(() => null);
  const existing = await app.registry.findModel(target, provider.id).catch(() => null);
  if (existing) {
    const exShow = await provider.show(target).catch(() => null);
    if (modelfileBlobs(exShow?.modelfile)[0] !== digest) throw new HttpError(409, 'name_taken', `A different model named ${target} already exists.`);
    return { model: target, providerId: provider.id, source, created: false, digest: `sha256:${digest}`, capabilities: exShow?.capabilities || null, sizeBytes: existing.sizeBytes ?? null, sourceSizeBytes: sourceTag?.sizeBytes ?? null, note: 'The text-only copy already exists.' };
  }
  const { template, source: templateSource } = textOnlyTemplate(show);
  const parameters = parametersForCreate(show.parameters);
  await provider.create({ model: target, files: { 'model.gguf': `sha256:${digest}` }, template, parameters });
  await app.modelCopies.set(provider.id, target, { source, digest: `sha256:${digest}`, templateSource, createdAt: nowIso() });
  app.registry.invalidate?.();
  const info = await provider.show(target).catch(() => null);
  const tag = await app.registry.findModel(target, provider.id).catch(() => null);
  app.bus.publish('models.changed', { providerId: provider.id, model: target, reason: 'text_only_copy' });
  return {
    model: target, providerId: provider.id, source, created: true, digest: `sha256:${digest}`, template: templateSource,
    capabilities: info?.capabilities || null, sizeBytes: tag?.sizeBytes ?? null, sourceSizeBytes: sourceTag?.sizeBytes ?? null,
    note: `Created ${target}: the same weights without image/audio input (no download). It needs less RAM than ${source}. Deleting ${source} afterwards frees its projector's disk space; the copy keeps the weights.`,
  };
}
