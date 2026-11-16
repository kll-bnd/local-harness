// Hugging Face GGUF repositories (the wide source). docs/API.md §10.8.
//   list:   GET /api/models?filter=gguf&sort=…&direction=-1&limit=…&expand[]=… (cursor from the Link header)
//   detail: GET /api/models/<id>?blobs=true, GET /<id>/raw/main/README.md, GET hf.co/v2/<id>/manifests/<tag>
// Every field is untrusted text and may be missing.
import { catalogGet, bases, CatalogUnavailable } from './net.mjs';
import { HttpError } from '../lib/errors.mjs';
import { textOnlyName } from '../providers/catalog.mjs';

export const HF_SORTS = { trending: 'trendingScore', downloads: 'downloads', likes: 'likes', updated: 'lastModified' };
const KIND_PIPELINE = { chat: 'text-generation', vision: 'image-text-to-text', embedding: 'feature-extraction' };
const CHAT_PIPELINES = new Set(['text-generation', 'image-text-to-text', 'feature-extraction', 'sentence-similarity', 'text2text-generation']);
const NOISE_TAGS = /^(gguf|license:|region:|base_model:|arxiv:|dataset:|doi:|endpoints_compatible|autotrain_compatible|text-generation-inference|transformers|safetensors|deploy:|template:|custom_code$|.{0,1}$)/i;
const NOT_CHAT_TAGS = new Set(['text-to-image', 'text-to-video', 'image-to-video', 'text-to-speech', 'text-to-audio', 'automatic-speech-recognition', 'diffusers', 'image-to-image', 'audio-to-audio', 'video-text-to-text']);
const EXPAND = ['gguf', 'downloads', 'likes', 'lastModified', 'pipeline_tag', 'tags', 'gated', 'author', 'trendingScore'];
export const ID_RE = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;
const QUANT_RE = /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|TQ\d_\d|MXFP4(?:_MOE)?))$/i;
const SHARD_RE = /-(\d{5})-of-(\d{5})$/;
const CARD_MAX = 200 * 1024;

const str = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : null);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

function paramsArg(v) {
  if (v === null || v === undefined || v === '') return null;
  const m = /^(\d+(?:\.\d+)?)\s*([kmbt]?)$/i.exec(String(v).trim());
  if (!m) throw new HttpError(400, 'bad_request', 'minParams/maxParams must be a number like 3000000000 or 3B');
  const mult = { '': 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}
const asB = (n) => `${Math.max(0, Math.round((n / 1e9) * 100) / 100)}B`;

/** Is this a repository Ollama can chat with or embed? (video / speech / diffusion GGUFs are dropped) */
export function isChatRepo(m) {
  const tags = Array.isArray(m?.tags) ? m.tags : [];
  if (tags.some((t) => NOT_CHAT_TAGS.has(String(t)))) return false;
  if (m?.pipeline_tag) return CHAT_PIPELINES.has(m.pipeline_tag);
  return tags.includes('conversational');
}

export function kindOf(m, { hasProjector = false } = {}) {
  const p = m?.pipeline_tag || m?.cardData?.pipeline_tag;
  if (p === 'feature-extraction' || p === 'sentence-similarity') return 'embedding';
  if (p === 'image-text-to-text' || hasProjector) return 'vision';
  return 'chat';
}

function licenseOf(m) {
  const fromCard = m?.cardData?.license;
  if (typeof fromCard === 'string') return fromCard.slice(0, 80);
  const t = (m?.tags || []).find((x) => typeof x === 'string' && x.startsWith('license:'));
  return t ? t.slice(8, 88) : null;
}

const capsFor = (kind, template) => {
  const caps = [];
  if (kind === 'vision') caps.push('vision');
  if (kind === 'embedding') caps.push('embedding');
  if (typeof template === 'string' && /tool/i.test(template)) caps.push('tools');
  if (typeof template === 'string' && /think/i.test(template)) caps.push('thinking');
  return caps;
};

function encodeCursor(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
function decodeCursor(c) {
  try { const o = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8')); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

/** The next page's cursor from HF's Link header — only from HF's own /api/models URL. */
export function nextCursorFromLink(link, hfBase) {
  if (!link) return null;
  const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(link);
  if (!m) return null;
  try {
    const u = new URL(m[1]);
    const base = new URL(hfBase);
    if (u.protocol !== base.protocol || u.host !== base.host || u.pathname !== '/api/models') return null;
    const c = u.searchParams.get('cursor');
    return c && c.length < 2000 ? c : null;
  } catch { return null; }
}

export function mapListItem(m, { fits, installedNames, curated }) {
  const id = str(m?.id || m?.modelId, 200);
  if (!id || !ID_RE.test(id)) return null;
  const [owner, repo] = id.split('/');
  const kind = kindOf(m);
  const parameters = num(m?.gguf?.total);
  const contextLength = num(m?.gguf?.context_length);
  const lower = id.toLowerCase();
  const installed = [...installedNames].some((n) => n.startsWith(`hf.co/${lower}:`) || n === `hf.co/${lower}`);
  const recommended = [...curated].some((n) => n.startsWith(`hf.co/${lower}:`));
  return {
    source: 'huggingface', id, name: repo, publisher: str(m?.author, 100) || owner, description: null,
    kind, capabilities: capsFor(kind, m?.gguf?.chat_template),
    parameters, architecture: str(m?.gguf?.architecture, 60), contextLength,
    downloads: num(m?.downloads), likes: num(m?.likes), trendingScore: num(m?.trendingScore),
    updatedAt: str(m?.lastModified, 40), gated: !!m?.gated && m.gated !== 'false', license: licenseOf(m),
    tags: (Array.isArray(m?.tags) ? m.tags : []).filter((t) => typeof t === 'string' && !NOISE_TAGS.test(t) && !/^[a-z]{2}$/.test(t)).slice(0, 12).map((t) => t.slice(0, 60)),
    fit: fits.listFit({ parameters, contextLength, name: id }),
    installed, recommended, url: `https://huggingface.co/${id}`,
  };
}

export async function hfList(q, { fits, installedNames, curated, cache }) {
  const B = bases();
  const sortKey = HF_SORTS[q.sort || 'trending'];
  if (!sortKey) throw new HttpError(400, 'unsupported_sort', `sort must be one of ${Object.keys(HF_SORTS).join(', ')}`);
  const minP = paramsArg(q.minParams);
  const maxP = paramsArg(q.maxParams);
  const filterKey = JSON.stringify([q.sort, q.kind, q.q, q.publisher, minP, maxP]);
  let hfCursor = null;
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (!c || c.s !== 'hf' || c.f !== filterKey || typeof c.c !== 'string') throw new HttpError(400, 'bad_cursor', 'This cursor belongs to another listing; start again without it.');
    hfCursor = c.c;
  }
  const u = new URL(`${B.hf}/api/models`);
  u.searchParams.set('filter', 'gguf');
  u.searchParams.set('sort', sortKey);
  u.searchParams.set('direction', '-1');
  u.searchParams.set('limit', String(Math.min(100, Math.max(q.limit * 2, 20))));
  for (const e of EXPAND) u.searchParams.append('expand[]', e);
  if (q.q) u.searchParams.set('search', q.q.slice(0, 100));
  if (q.publisher) u.searchParams.set('author', q.publisher.slice(0, 100));
  if (q.kind && KIND_PIPELINE[q.kind]) u.searchParams.set('pipeline_tag', KIND_PIPELINE[q.kind]);
  if (minP || maxP) u.searchParams.set('num_parameters', [minP ? `min:${asB(minP)}` : null, maxP ? `max:${asB(maxP)}` : null].filter(Boolean).join(','));
  if (hfCursor) u.searchParams.set('cursor', hfCursor);
  const key = `hf:list:${u.href}`;
  let page = cache.get(key);
  let cached = !!page;
  if (!page) {
    const r = await catalogGet(u.href, { source: 'huggingface' });
    if (r.status !== 200) throw new CatalogUnavailable('huggingface', `Hugging Face answered ${r.status}.`);
    let rows;
    try { rows = JSON.parse(r.text); } catch { throw new CatalogUnavailable('huggingface', 'Hugging Face sent something that is not a model list.'); }
    if (!Array.isArray(rows)) throw new CatalogUnavailable('huggingface', 'Hugging Face sent something that is not a model list.');
    page = { rows, next: nextCursorFromLink(r.headers.get('link'), B.hf), fetchedAt: new Date().toISOString() };
    cache.set(key, page, r.text.length);
    cached = false;
  }
  let items = page.rows.filter(isChatRepo).map((m) => mapListItem(m, { fits, installedNames, curated })).filter(Boolean);
  if (q.kind) items = items.filter((i) => i.kind === q.kind);
  if (q.fits) items = items.filter((i) => i.fit?.fits);
  items = items.slice(0, q.limit);
  return { items, nextCursor: page.next ? encodeCursor({ s: 'hf', f: filterKey, c: page.next }) : null, sourceNote: null, fetchedAt: page.fetchedAt, cached };
}

// ---------------------------------------------------------------------------------------------- detail
/** GGUF files → quantizations (tag = the file name's quantization suffix; shards summed), projectors. */
export function groupFiles(siblings) {
  const quants = new Map();
  const projectors = [];
  for (const s of Array.isArray(siblings) ? siblings : []) {
    const p = str(s?.rfilename, 400);
    if (!p || !/\.gguf$/i.test(p)) continue;
    const size = num(s?.lfs?.size) ?? num(s?.size);
    const base = p.split('/').pop();
    if (/^mmproj/i.test(base)) { projectors.push({ path: p, size }); continue; }
    if (/^(imatrix|dflash)/i.test(base)) continue;
    let stem = base.replace(/\.gguf$/i, '');
    stem = stem.replace(SHARD_RE, '');
    const m = QUANT_RE.exec(stem);
    if (!m) continue;
    const tag = m[1];
    const q = quants.get(tag.toUpperCase()) || { tag, files: [], sizeBytes: 0, sizeKnown: true };
    q.files.push({ path: p, size });
    if (size === null) q.sizeKnown = false; else q.sizeBytes += size;
    quants.set(tag.toUpperCase(), q);
  }
  return { quants: [...quants.values()].map((q) => ({ tag: q.tag, files: q.files, sizeBytes: q.sizeKnown ? q.sizeBytes : null })), projectors };
}

export function stripFrontMatter(md) {
  const s = String(md || '').replace(/^﻿/, '');
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/.exec(s);
  return m ? s.slice(m[0].length) : s;
}

/** Ollama's registry for hf.co: does it know exactly this tag? true / false / null (could not check). */
async function manifest(id, tag, cache) {
  const B = bases();
  const key = `hf:manifest:${id}:${tag}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let out = { pullable: null, layers: null };
  try {
    const r = await catalogGet(`${B.hfRegistry}/v2/${id}/manifests/${encodeURIComponent(tag)}`, { source: 'huggingface', accept: 'application/vnd.docker.distribution.manifest.v2+json', timeoutMs: 8000, maxBytes: 256 * 1024 });
    if (r.status === 200) {
      let j = null;
      try { j = JSON.parse(r.text); } catch { /* not JSON */ }
      out = { pullable: !!j, layers: Array.isArray(j?.layers) ? j.layers.map((l) => ({ mediaType: str(l?.mediaType, 120), size: num(l?.size) })) : null };
    } else if (r.status >= 400 && r.status < 500) out = { pullable: false, layers: null };
  } catch (e) { if (e?.code === 'offline_lock') throw e; }
  cache.set(key, out, 2048);
  return out;
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

export async function hfDetail(id, { fits, installedNames, curated, cache }) {
  if (!ID_RE.test(String(id || ''))) throw new HttpError(400, 'bad_request', 'id must look like "owner/repository"');
  const B = bases();
  const key = `hf:detail:${id}`;
  const hit = cache.get(key);
  let meta; let card; let manifests; let fetchedAt;
  if (hit) ({ meta, card, manifests, fetchedAt } = hit);
  else {
    const r = await catalogGet(`${B.hf}/api/models/${id}?blobs=true`, { source: 'huggingface' });
    if (r.status === 401 || r.status === 404) throw new HttpError(404, 'catalog_not_found', 'No public Hugging Face repository with that name.');
    if (r.status !== 200) throw new CatalogUnavailable('huggingface', `Hugging Face answered ${r.status}.`);
    try { meta = JSON.parse(r.text); } catch { throw new CatalogUnavailable('huggingface', 'Hugging Face sent something that is not a model description.'); }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new CatalogUnavailable('huggingface', 'Hugging Face sent something that is not a model description.');
    card = null;
    try {
      const c = await catalogGet(`${B.hf}/${id}/raw/main/README.md`, { source: 'huggingface', accept: 'text/plain, text/markdown', maxBytes: 2 * 1024 * 1024 });
      if (c.status === 200) {
        const body = stripFrontMatter(c.text);
        card = { format: 'markdown', text: body.slice(0, CARD_MAX), truncated: body.length > CARD_MAX };
      }
    } catch (e) { if (e?.code === 'offline_lock') throw e; }
    const { quants } = groupFiles(meta.siblings);
    const gated = !!meta.gated && meta.gated !== 'false';
    manifests = gated ? {} : Object.fromEntries(await mapLimit(quants.slice(0, 16), 4, async (q) => [q.tag, await manifest(id, q.tag, cache)]));
    fetchedAt = new Date().toISOString();
    cache.set(key, { meta, card, manifests, fetchedAt }, r.text.length + (card?.text.length || 0));
  }
  const { quants, projectors } = groupFiles(meta.siblings);
  const hasProjector = projectors.length > 0;
  const kind = kindOf(meta, { hasProjector });
  const gated = !!meta.gated && meta.gated !== 'false';
  const contextLength = num(meta?.gguf?.context_length) || num(meta?.cardData?.context_length);
  const lower = id.toLowerCase();
  const projectorFallback = (projectors.find((p) => /f16/i.test(p.path) && !/bf16/i.test(p.path)) || projectors[0])?.size ?? null;
  const files = quants.map((q, idx) => {
    const m = manifests?.[q.tag] || { pullable: null, layers: null };
    const projLayer = m.layers?.find((l) => /projector/i.test(l.mediaType || ''));
    const projectorBytes = hasProjector ? projLayer?.size ?? projectorFallback : null;
    const model = `hf.co/${id}:${q.tag}`;
    const downloadBytes = q.sizeBytes !== null ? q.sizeBytes + (projectorBytes || 0) : null;
    const asText = hasProjector && fits.lowRam;
    const est = fits.estimate({ bytes: asText ? q.sizeBytes : downloadBytes, contextLength, name: id });
    const copy = hasProjector ? textOnlyName(model) : null;
    return {
      tag: q.tag, model, files: q.files, sizeBytes: q.sizeBytes, projectorBytes, downloadBytes,
      contextLength: null, inputs: null, pullable: idx < 16 ? (gated ? false : m.pullable) : null,
      fit: est ? { ...est, basis: asText ? 'text_only_copy' : 'as_pulled' } : null,
      textOnly: copy ? { model: copy, sizeBytes: q.sizeBytes, recommended: fits.lowRam } : null,
      installed: installedNames.has(model.toLowerCase()) || (copy ? installedNames.has(copy) : false),
      recommended: false,
    };
  }).sort((a, b) => (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity));
  const { pickRecommended } = await import('./fit.mjs');
  const rec = gated ? null : pickRecommended(files);
  if (rec) rec.recommended = true;
  const notes = [];
  if (gated) notes.push('This repository is gated: accept its terms on huggingface.co first. Harness does not download gated models.');
  if (hasProjector && fits.lowRam) notes.push('This Mac has 8 GB or less: Harness recommends a text-only copy (no image input) right after the download.');
  if (!files.length) notes.push('No GGUF file with a recognisable quantization name was found; nothing to download here.');
  if (files.some((f) => f.pullable === false && !gated)) notes.push('Files marked not pullable are not served by the hf.co registry Ollama downloads from.');
  const baseModels = [].concat(meta?.cardData?.base_model || []).filter((x) => typeof x === 'string').slice(0, 10).map((x) => x.slice(0, 200));
  const lic = meta?.cardData?.license ?? licenseOf(meta);
  return {
    source: 'huggingface', id, name: id.split('/')[1], publisher: str(meta.author, 100) || id.split('/')[0], url: `https://huggingface.co/${id}`,
    description: null,
    license: lic ? { id: str(lic, 80), name: str(meta?.cardData?.license_name, 120), link: str(meta?.cardData?.license_link, 400) } : null,
    gated, downloads: num(meta.downloads), likes: num(meta.likes), updatedAt: str(meta.lastModified, 40),
    kind, capabilities: capsFor(kind, meta?.gguf?.chat_template), parameters: num(meta?.gguf?.total), architecture: str(meta?.gguf?.architecture, 60),
    contextLength, baseModels, tags: (meta.tags || []).filter((t) => typeof t === 'string' && !NOISE_TAGS.test(t)).slice(0, 20).map((t) => t.slice(0, 60)),
    card,
    files, projectors, hasProjector, recommendedTag: rec?.tag || null,
    downloadable: !gated && files.some((f) => f.pullable !== false),
    installed: [...installedNames].some((n) => n.startsWith(`hf.co/${lower}:`)), recommended: [...curated].some((n) => n.startsWith(`hf.co/${lower}:`)),
    sourceNote: null, notes, fetchedAt,
  };
}
