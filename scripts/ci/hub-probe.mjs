#!/usr/bin/env node
// CI-only fact-finding: which catalogue endpoints of Hugging Face and ollama.com really exist and
// what they return. Prints one compact block per request. Not part of the app.
const clip = (s, n = 300) => { const t = typeof s === 'string' ? s : JSON.stringify(s); return t && t.length > n ? `${t.slice(0, n)}…(+${t.length - n})` : t; };
const UA = 'harness-catalogue-probe';

async function get(url, { accept } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, ...(accept ? { accept } : {}) }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type') || '', link: res.headers.get('link'), text, ms: Date.now() - t0, finalUrl: res.url };
  } catch (e) { return { status: 0, type: '', text: '', error: `${e.name}: ${e.message}`, ms: Date.now() - t0 }; }
}

async function json(label, url, pick) {
  const r = await get(url);
  console.log(`\n# ${label}\nGET ${url}\n-> ${r.status} ${r.type} ${r.ms} ms ${r.text.length} B${r.error ? ` ${r.error}` : ''}`);
  if (r.link) console.log(`link: ${clip(r.link, 260)}`);
  let j = null;
  try { j = JSON.parse(r.text); } catch { console.log(`body: ${clip(r.text, 240)}`); return null; }
  if (Array.isArray(j)) {
    console.log(`array of ${j.length}; keys of [0]: ${j[0] ? Object.keys(j[0]).join(',') : '-'}`);
    for (const item of j.slice(0, 2)) console.log(`item: ${clip(pick ? pick(item) : item, 700)}`);
  } else {
    console.log(`object keys: ${Object.keys(j).join(',')}`);
    console.log(`value: ${clip(pick ? pick(j) : j, 1100)}`);
  }
  return j;
}

async function html(label, url) {
  const r = await get(url, { accept: 'text/html' });
  console.log(`\n# ${label}\nGET ${url}\n-> ${r.status} ${r.type} ${r.ms} ms ${r.text.length} B${r.finalUrl && r.finalUrl !== url ? ` (redirected to ${r.finalUrl})` : ''}${r.error ? ` ${r.error}` : ''}`);
  if (!r.text) return;
  if (!/html/.test(r.type)) { console.log(`body: ${clip(r.text, 500)}`); return; }
  console.log(`title: ${clip(r.text.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim() || '-', 120)}`);
  const attrs = {};
  for (const m of r.text.matchAll(/\s(x-test-[a-z0-9-]+)/g)) attrs[m[1]] = (attrs[m[1]] || 0) + 1;
  console.log(`x-test attributes: ${clip(attrs, 500)}`);
  const sample = (attr) => [...r.text.matchAll(new RegExp(`${attr}[^>]*>\\s*([^<]{1,80})`, 'g'))].slice(0, 6).map((m) => m[1].trim());
  for (const a of Object.keys(attrs).slice(0, 12)) console.log(`  ${a}: ${clip(sample(a), 300)}`);
  const hrefs = [...new Set([...r.text.matchAll(/href="(\/library\/[^"?#]+)"/g)].map((m) => m[1]))];
  console.log(`/library/ links: ${hrefs.length}: ${clip(hrefs.slice(0, 12), 400)}`);
  const i = r.text.search(/<li[^>]*x-test-(model|search-response)/);
  if (i >= 0) console.log(`first item html: ${clip(r.text.slice(i, i + 1500).replace(/\s+/g, ' '), 1500)}`);
  const next = r.text.match(/hx-get="([^"]+)"/g);
  if (next) console.log(`hx-get (pagination?): ${clip(next.slice(0, 4), 300)}`);
}

const HF = 'https://huggingface.co';
const REPO = 'unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF';
const slim = (m) => ({ id: m.id, modelId: m.modelId, author: m.author, downloads: m.downloads, likes: m.likes, trendingScore: m.trendingScore, lastModified: m.lastModified, createdAt: m.createdAt, pipeline_tag: m.pipeline_tag, library_name: m.library_name, gated: m.gated, private: m.private, tags: (m.tags || []).slice(0, 14), gguf: m.gguf ? Object.fromEntries(Object.entries(m.gguf).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 40) : v])) : undefined, siblings: m.siblings ? `${m.siblings.length}: ${JSON.stringify(m.siblings.slice(0, 3))}` : undefined });

console.log('## ollama.com page structure');
async function structure(label, url, linkRe, n = 2, span = 1500) {
  const r = await get(url, { accept: 'text/html' });
  console.log(`\n# ${label}\nGET ${url}\n-> ${r.status} ${r.text.length} B${r.finalUrl && r.finalUrl !== url ? ` (redirected to ${r.finalUrl})` : ''}`);
  const idx = [...r.text.matchAll(linkRe)].map((m) => m.index);
  console.log(`matching links: ${idx.length}`);
  for (const at of idx.slice(0, n)) console.log(`html: ${r.text.slice(Math.max(0, at - 120), at + span).replace(/\s+/g, ' ')}`);
  const forms = [...r.text.matchAll(/<(?:select|input|a)[^>]*(?:name|href)="[^"]*(?:sort|o=|c=|page|p=)[^"]*"[^>]*>/g)].map((m) => m[0].replace(/\s+/g, ' ')).slice(0, 10);
  console.log(`sort/filter/pagination controls: ${JSON.stringify(forms).slice(0, 1400)}`);
  const hx = [...r.text.matchAll(/<[^>]*hx-get="[^"]*"[^>]*>/g)].map((m) => m[0].replace(/\s+/g, ' ')).slice(0, 4);
  console.log(`hx elements: ${JSON.stringify(hx).slice(0, 1200)}`);
}
await structure('library, popular', 'https://ollama.com/library?sort=popular', /<a[^>]*href="\/library\/[a-z0-9._-]+"/g, 2, 1700);
await structure('library, newest', 'https://ollama.com/library?sort=newest', /<a[^>]*href="\/library\/[a-z0-9._-]+"/g, 1, 500);
await structure('search qwen', 'https://ollama.com/search?q=qwen', /<a[^>]*href="\/library\/[a-z0-9._-]+"/g, 1, 1700);
await structure('search page 2', 'https://ollama.com/search?q=qwen&page=2', /<a[^>]*href="\/library\/[a-z0-9._-]+"/g, 1, 300);
await structure('tags of qwen3', 'https://ollama.com/library/qwen3/tags', /<a[^>]*href="\/library\/qwen3:[^"]+"/g, 3, 900);
await structure('model page qwen3', 'https://ollama.com/library/qwen3', /<a[^>]*href="\/library\/qwen3:[^"]+"/g, 1, 900);
{
  const r = await get('https://ollama.com/library/qwen3', { accept: 'text/html' });
  const meta = [...r.text.matchAll(/<meta[^>]*(?:name|property)="(?:description|og:description|og:title)"[^>]*>/g)].map((m) => m[0].replace(/\s+/g, ' '));
  console.log(`meta: ${JSON.stringify(meta).slice(0, 900)}`);
  const readme = r.text.search(/id="readme"|id="display"|class="[^"]*prose/);
  console.log(`readme marker at ${readme}: ${readme >= 0 ? r.text.slice(readme, readme + 500).replace(/\s+/g, ' ') : '-'}`);
}
