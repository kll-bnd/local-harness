// The Ollama library (the dependable source), read from the ollama.com website pages — there is no API.
//   list:    GET /library?sort=popular|newest      (one page lists everything; Harness pages it itself)
//            GET /search?q=<text>                   (the site's first page of matches)
//   detail:  GET /library/<name> (description, README), GET /library/<name>/tags (sizes, context, inputs)
// Parsing is tolerant: a missing piece is null, never an exception. A page that yields no model at all where the
// site always lists some is reported as 502 catalog_unavailable ("the page layout changed") — never an empty list.
import { catalogGet, bases, CatalogUnavailable } from './net.mjs';
import { textOf, decodeEntities, htmlToText, elementAfter } from './html.mjs';
import { HttpError } from '../lib/errors.mjs';
import { textOnlyName } from '../providers/catalog.mjs';

export const OLLAMA_SORTS = { trending: 'popular', updated: 'newest' };
const CAPS = new Set(['vision', 'tools', 'thinking', 'embedding', 'audio', 'cloud', 'insert']);
const SIZE_CHIP = /^(?:e)?\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)?[mbk]$/i;
export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,80}(\/[a-z0-9][a-z0-9._-]{0,80})?$/i;
const TAG_RE = /^[a-z0-9][a-z0-9._-]{0,120}$/i;
const UNIT = { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
const GiB = 1024 ** 3;

function parseCount(s) {
  const m = /^([\d.,]+)\s*([KMB])?$/i.exec(String(s || '').trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1));
}

export function sizeChipToParams(chip) {
  const m = /^(?:e)?(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?([mbk])$/i.exec(String(chip || ''));
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? Number(m[2]) : 1);
  return n * { k: 1e3, m: 1e6, b: 1e9 }[m[3].toLowerCase()];
}

const spanClass = (cls) => new RegExp(`<span\\b[^>]*\\bclass="[^"]*${cls}[^"]*"[^>]*>([^<]{1,60})</span>`, 'gi');
const CAP_RE = () => spanClass('bg-indigo-50');
const SIZE_RE = () => spanClass('bg-\\[#ddf4ff\\]');
const PULLS_RE = /<span\s*>\s*([\d.,]+\s*[KMB]?)\s*<\/span>\s*<span\b[^>]*>(?:\s|&nbsp;)*Pulls/i;
const DOWNLOADS_RE = /title="([\d,]+)\s+downloads"/i;
const TAGS_RE = /<span\s*>\s*(\d+)\s*<\/span>\s*<span\b[^>]*>(?:\s|&nbsp;)*Tags|<span\s*>\s*(\d+)\s+tags?\s*<\/span>/i;
const UPDATED_TITLE_RE = /title="Updated ([^"]{4,80})"/i;
const UPDATED_SPAN_RE = /<span\b[^>]*\btitle="([^"]{4,80})"[^>]*>\s*(?:<svg\b[\s\S]*?(?:\/>|<\/svg>)\s*)?<span\b[^>]*>(?:\s|&nbsp;)*Updated/i;

/**
 * Items of a library or search page: [{ name, description, capabilities, sizes, downloads, tagCount, updatedAt }].
 * Parsed by the page's own anchors (docs: real markup of ollama.com, Nov 2026): capability chips are spans with
 * class bg-indigo-50, size chips spans with class bg-[#ddf4ff]; pulls = the span right before "Pulls" (library)
 * or title="<n> downloads" (search); updated = the title of the span holding "Updated" (or title="Updated …").
 */
export function parseListPage(html) {
  const out = [];
  const seen = new Set();
  const chunks = String(html || '').split(/<li\b/i).slice(1);
  for (const chunk of chunks) {
    const href = /href="\/library\/([^"?#:]+)"/i.exec(chunk);
    if (!href) continue;
    const name = decodeEntities(href[1]).trim();
    if (!NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(chunk);
    const chips = (re) => [...new Set([...chunk.matchAll(re)].map((m) => decodeEntities(m[1]).trim().toLowerCase()).filter(Boolean))];
    const capabilities = chips(CAP_RE()).filter((t) => /^[a-z][a-z-]{1,20}$/.test(t));
    const sizes = chips(SIZE_RE()).filter((t) => SIZE_CHIP.test(t));
    const dlExact = DOWNLOADS_RE.exec(chunk);
    const pulls = dlExact ? null : PULLS_RE.exec(chunk);
    const tags = TAGS_RE.exec(chunk);
    const upd = UPDATED_TITLE_RE.exec(chunk) || UPDATED_SPAN_RE.exec(chunk);
    const updatedMs = upd ? Date.parse(decodeEntities(upd[1])) : NaN;
    out.push({
      name,
      description: p ? textOf(p[1]).slice(0, 600) || null : null,
      capabilities,
      sizes,
      downloads: dlExact ? parseCount(dlExact[1]) : pulls ? parseCount(pulls[1]) : null,
      tagCount: tags ? Number(tags[1] || tags[2]) : null,
      updatedAt: Number.isFinite(updatedMs) ? new Date(updatedMs).toISOString() : null,
    });
  }
  return out;
}

/** The "load more" element of a search page: the next page number, or null. */
export function nextSearchPage(html) {
  const m = /hx-get="\/search\?([^"]*)"/i.exec(String(html || ''));
  if (!m) return null;
  const page = Number(new URLSearchParams(decodeEntities(m[1])).get('page'));
  return Number.isInteger(page) && page > 1 && page < 100 ? page : null;
}

/** Tags of /library/<name>/tags: [{ tag, digest, sizeBytes, contextLength, inputs }]. */
export function parseTagsPage(html, name) {
  const s = String(html || '');
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`href="/library/${esc}:([^"?#]+)"`, 'gi');
  const hits = [...s.matchAll(re)];
  const byTag = new Map();
  for (let k = 0; k < hits.length; k++) {
    const tag = decodeEntities(hits[k][1]).trim();
    if (!TAG_RE.test(tag)) continue;
    const end = k + 1 < hits.length ? hits[k + 1].index : Math.min(s.length, hits[k].index + 3000);
    const text = textOf(s.slice(hits[k].index, Math.min(end, hits[k].index + 3000)));
    const rec = byTag.get(tag) || { tag, digest: null, sizeBytes: null, contextLength: null, inputs: null };
    const dg = /\b([0-9a-f]{12})\b/.exec(text);
    const sz = /(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)\b/.exec(text);
    const cx = /(\d+(?:\.\d+)?)\s*([KM])\s*context window/i.exec(text);
    const inp = /((?:Text|Image|Audio|Video)(?:\s*,\s*(?:Text|Image|Audio|Video))*)\s+input/i.exec(text);
    rec.digest ||= dg ? dg[1] : null;
    rec.sizeBytes ??= sz ? Math.round(Number(sz[1]) * UNIT[sz[2]]) : null;
    rec.contextLength ??= cx ? Math.round(Number(cx[1]) * (cx[2].toUpperCase() === 'M' ? 1048576 : 1024)) : null;
    rec.inputs ||= inp ? inp[1].split(',').map((x) => x.trim().toLowerCase()) : null;
    byTag.set(tag, rec);
  }
  return [...byTag.values()];
}

/** The model page: { description, capabilities, readme: { text, truncated } | null }. */
export function parseModelPage(html) {
  const s = String(html || '');
  const meta = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(s) || /<meta\s+content="([^"]*)"\s+name="description"/i.exec(s);
  const cut = s.search(/id="readme"/i);
  const head = cut > 0 ? s.slice(0, cut) : s;
  const capabilities = [...new Set([...head.matchAll(CAP_RE())].map((m) => decodeEntities(m[1]).trim().toLowerCase()).filter((t) => /^[a-z][a-z-]{1,20}$/.test(t)))];
  const display = elementAfter(s, /<div\b[^>]*id="display"[^>]*>/i);
  const readme = display ? htmlToText(display) : null;
  return { description: meta ? decodeEntities(meta[1]).slice(0, 1000) : null, capabilities, readme: readme && readme.text ? readme : null };
}

const kindOf = (caps) => (caps.includes('embedding') ? 'embedding' : caps.includes('vision') ? 'vision' : 'chat');

function itemFor(m, { fits, installedNames, curated }) {
  const caps = m.capabilities.filter((c) => c !== 'cloud');
  const params = m.sizes.map(sizeChipToParams).filter(Boolean);
  const smallest = params.length ? Math.min(...params) : null;
  // the largest size that would still fit, for the list's at-a-glance answer
  const fitting = params.map((n) => ({ n, f: fits.listFit({ parameters: n, name: m.name, vision: caps.includes('vision') }) })).filter((x) => x.f);
  const best = fitting.filter((x) => x.f.verdict === 'fits').sort((a, b) => b.n - a.n)[0] || fitting.filter((x) => x.f.verdict === 'fits_smaller').sort((a, b) => b.n - a.n)[0] || fitting.sort((a, b) => a.n - b.n)[0];
  const lower = m.name.toLowerCase();
  return {
    source: 'ollama', id: m.name, name: m.name, publisher: m.name.includes('/') ? m.name.split('/')[0] : 'ollama', description: m.description,
    kind: kindOf(caps), capabilities: caps, parameters: smallest, architecture: null, contextLength: null,
    downloads: m.downloads, likes: null, trendingScore: null, updatedAt: m.updatedAt, gated: false, license: null,
    tags: m.sizes, sizes: m.sizes, tagCount: m.tagCount ?? null,
    fit: best ? { ...best.f, size: m.sizes[params.indexOf(best.n)] || null } : null,
    installed: [...installedNames].some((n) => n === lower || n.startsWith(`${lower}:`)),
    recommended: [...curated].some((n) => n === lower || n.startsWith(`${lower}:`)),
    url: `https://ollama.com/library/${m.name}`,
  };
}

const encodeCursor = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const decodeCursor = (c) => { try { return JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8')); } catch { return null; } };

/** Result items on a search page that are NOT official library models (community uploads: href="/<user>/<model>"). */
export function countCommunityItems(html) {
  let n = 0;
  for (const chunk of String(html || '').split(/<li\b/i).slice(1)) {
    if (/hx-get=/i.test(chunk.slice(0, 300))) continue; // the "load more" element
    if (/href="\/library\//i.test(chunk)) continue;
    if (/href="\/[\w.-]+\/[\w.-]+"/i.test(chunk)) n++;
  }
  return n;
}

/**
 * Lists come from the site's search (ollama.com/search — verified Nov 2026): 20 per page; `c=local` always (never
 * cloud-only models), `c=vision|embedding` for kind, `o=newest` for "updated" (popular is the default and must be
 * omitted), `s=8|16|32|64` ("up to N GB", the bucket at or above this Mac's budget) for fits=true; page N > 1 is
 * the htmx fragment that only answers with `HX-Request: true`. Only official library models (/library/…) are
 * offered; paging stops at the first page with none (community uploads follow the official ones). The one-page
 * /library?sort=… listing is the fallback when the search page cannot be read.
 */
export async function ollamaList(q, { fits, installedNames, curated, cache }) {
  const B = bases();
  const siteSort = OLLAMA_SORTS[q.sort || 'trending'];
  if (!siteSort) throw new HttpError(400, 'unsupported_sort', 'The Ollama library sorts by trending (its "popular") or updated (its "newest").');
  const notes = [];
  if (q.publisher || q.minParams || q.maxParams) notes.push('publisher and parameter filters apply to Hugging Face only');
  const filterKey = JSON.stringify([q.sort, q.kind, q.q, q.fits]);
  let page = 1;
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (!c || c.s !== 'ol' || c.f !== filterKey || !Number.isInteger(c.p) || c.p < 2 || c.p > 99) throw new HttpError(400, 'bad_cursor', 'This cursor belongs to another listing; start again without it.');
    page = c.p;
  }
  const keep = (list) => {
    // Cloud-only entries (no local size) cannot be downloaded.
    let items = list.filter((m) => !(m.capabilities.includes('cloud') && !m.sizes.length)).map((m) => itemFor(m, { fits, installedNames, curated }));
    if (q.kind) items = items.filter((i) => i.kind === q.kind);
    if (q.fits) items = items.filter((i) => i.fit?.fits);
    return items;
  };
  const u = new URL(`${B.ollama}/search`);
  if (q.q) u.searchParams.set('q', q.q.slice(0, 100));
  u.searchParams.append('c', 'local');
  if (q.kind === 'vision' || q.kind === 'embedding') u.searchParams.append('c', q.kind);
  if (siteSort === 'newest') u.searchParams.set('o', 'newest');
  if (q.fits) u.searchParams.set('s', sizeBucket(fits.budgetBytes));
  if (page > 1) u.searchParams.set('page', String(page));
  const key = `ol:search:${u.href}`;
  let res = cache.get(key);
  const cached = !!res;
  if (!res) {
    let r;
    try {
      r = await catalogGet(u.href, { source: 'ollama', accept: 'text/html', maxBytes: 4 * 1024 * 1024, headers: page > 1 ? { 'hx-request': 'true' } : {} });
    } catch (e) {
      if (e?.code === 'offline_lock' || q.q || page > 1) throw e;
      return libraryFallback(q, { keep, cache, notes, B });
    }
    if (r.status !== 200) {
      if (!q.q && page === 1) return libraryFallback(q, { keep, cache, notes, B });
      throw new CatalogUnavailable('ollama', `ollama.com answered ${r.status}.`);
    }
    const models = parseListPage(r.text);
    const community = countCommunityItems(r.text);
    if (!models.length && !community && page === 1 && !q.q && !(q.kind || q.fits)) {
      // a 200 page with content but nothing we can read: the layout changed
      if (r.text.length > 2000) return libraryFallback(q, { keep, cache, notes, B, why: 'search' });
    }
    res = { models, community, next: models.length && !community && nextSearchPage(r.text) ? page + 1 : null, fetchedAt: new Date().toISOString() };
    cache.set(key, res, r.text.length / 4);
  }
  const next = res.next && res.next <= 99 ? encodeCursor({ s: 'ol', f: filterKey, p: res.next }) : null;
  return { items: keep(res.models), nextCursor: next, sourceNote: ['read from the ollama.com website', ...notes].join('; '), fetchedAt: res.fetchedAt, cached };
}

/** The one-page library listing (fallback for browsing). Zero items from it → 502 "the page has changed". */
async function libraryFallback(q, { keep, cache, notes, B }) {
  const url = `${B.ollama}/library?sort=${OLLAMA_SORTS[q.sort || 'trending']}`;
  const key = `ol:list:${url}`;
  let page = cache.get(key);
  const cached = !!page;
  if (!page) {
    const r = await catalogGet(url, { source: 'ollama', accept: 'text/html', maxBytes: 6 * 1024 * 1024 });
    if (r.status !== 200) throw new CatalogUnavailable('ollama', `ollama.com answered ${r.status}.`);
    const models = parseListPage(r.text);
    if (!models.length) throw new CatalogUnavailable('ollama', 'The Ollama library page has changed: Harness could not read its model list.');
    page = { models, fetchedAt: new Date().toISOString() };
    cache.set(key, page, r.text.length / 4);
  }
  // the fallback lists everything on one page: hand out the first `limit` (no cursor: the search is the pager)
  return { items: keep(page.models).slice(0, q.limit), nextCursor: null, sourceNote: ['read from the ollama.com library page', ...notes].join('; '), fetchedAt: page.fetchedAt, cached };
}

/** The site's size filter value ("up to N GB") for a memory budget. */
export function sizeBucket(budgetBytes) {
  const gb = (budgetBytes || 0) / 1e9;
  for (const v of [8, 16, 32, 64]) if (gb <= v) return String(v);
  return 'over64';
}

export async function ollamaDetail(name, { fits, installedNames, curated, cache }) {
  if (!NAME_RE.test(String(name || ''))) throw new HttpError(400, 'bad_request', 'id must be an Ollama library name like "qwen3"');
  const B = bases();
  const key = `ol:detail:${name}`;
  let d = cache.get(key);
  if (!d) {
    const page = await catalogGet(`${B.ollama}/library/${name}`, { source: 'ollama', accept: 'text/html', maxBytes: 6 * 1024 * 1024 });
    if (page.status === 404) throw new HttpError(404, 'catalog_not_found', 'The Ollama library has no model with that name.');
    if (page.status !== 200) throw new CatalogUnavailable('ollama', `ollama.com answered ${page.status}.`);
    const tagsPage = await catalogGet(`${B.ollama}/library/${name}/tags`, { source: 'ollama', accept: 'text/html', maxBytes: 6 * 1024 * 1024 });
    const tags = tagsPage.status === 200 ? parseTagsPage(tagsPage.text, name) : [];
    d = { model: parseModelPage(page.text), tags, tagsStatus: tagsPage.status, fetchedAt: new Date().toISOString() };
    cache.set(key, d, page.text.length / 4 + tagsPage.text.length / 4);
  }
  const notes = [];
  if (!d.tags.length) notes.push(d.tagsStatus === 200 ? 'Could not read the tag list on ollama.com (the page layout may have changed); see the model page there.' : `The tag list was not available (ollama.com answered ${d.tagsStatus}).`);
  const caps = d.model.capabilities.filter((c) => c !== 'cloud');
  const local = d.tags.filter((t) => !/cloud/i.test(t.tag));
  // `latest`: the same file as a sized tag → offer that one; otherwise only above 8 GB and never recommended over a sized tag.
  const latest = local.find((t) => t.tag === 'latest');
  let tags = local.filter((t) => t.tag !== 'latest');
  if (latest) {
    const same = latest.digest && tags.find((t) => t.digest === latest.digest);
    if (same) notes.push(`"latest" is the same file as "${same.tag}".`);
    else if (fits.totalMem > 8 * GiB || !tags.length) tags = [...tags, latest];
  }
  const lowerName = name.toLowerCase();
  const files = tags.map((t) => {
    const model = `${name}:${t.tag}`;
    const est = fits.estimate({ bytes: t.sizeBytes, contextLength: t.contextLength, name: model });
    const vision = !!t.inputs?.includes('image');
    const copy = vision ? textOnlyName(model) : null;
    return {
      tag: t.tag, model, files: [], sizeBytes: t.sizeBytes, projectorBytes: null, downloadBytes: t.sizeBytes,
      contextLength: t.contextLength, inputs: t.inputs, pullable: true,
      fit: est ? { ...est, basis: 'as_pulled' } : null,
      textOnly: copy ? { model: copy, sizeBytes: null, recommended: fits.lowRam } : null,
      installed: installedNames.has(model.toLowerCase()) || (copy ? installedNames.has(copy) : false),
      recommended: false,
    };
  }).sort((a, b) => (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity));
  const { pickRecommended } = await import('./fit.mjs');
  const rec = pickRecommended(files.filter((f) => f.tag !== 'latest')) || pickRecommended(files);
  if (rec) rec.recommended = true;
  const kind = kindOf(caps.length ? caps : files.some((f) => f.inputs?.includes('image')) ? ['vision'] : []);
  return {
    source: 'ollama', id: name, name, publisher: name.includes('/') ? name.split('/')[0] : 'ollama', url: `https://ollama.com/library/${name}`,
    description: d.model.description, license: null, gated: false, downloads: null, likes: null, updatedAt: null,
    kind, capabilities: caps, parameters: null, architecture: null, contextLength: Math.max(0, ...files.map((f) => f.contextLength || 0)) || null,
    baseModels: [], tags: caps,
    card: d.model.readme ? { format: 'text', text: d.model.readme.text, truncated: d.model.readme.truncated } : null,
    files, projectors: [], hasProjector: files.some((f) => f.inputs?.includes('image')), recommendedTag: rec?.tag || null,
    downloadable: files.length > 0,
    installed: [...installedNames].some((n) => n === lowerName || n.startsWith(`${lowerName}:`)),
    recommended: [...curated].some((n) => n.startsWith(`${lowerName}:`)),
    sourceNote: 'read from the ollama.com website', notes, fetchedAt: d.fetchedAt,
  };
}
