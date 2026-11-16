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

console.log('## Hugging Face');
await json('trending GGUF', `${HF}/api/models?filter=gguf&sort=trendingScore&direction=-1&limit=3`, slim);
await json('most downloaded GGUF, full=true', `${HF}/api/models?filter=gguf&sort=downloads&direction=-1&limit=2&full=true`, slim);
await json('search nemotron', `${HF}/api/models?search=nemotron&filter=gguf&sort=downloads&direction=-1&limit=3`, slim);
await json('text-generation, most liked', `${HF}/api/models?filter=gguf&pipeline_tag=text-generation&sort=likes&direction=-1&limit=2`, slim);
await json('image-text-to-text (vision)', `${HF}/api/models?filter=gguf&pipeline_tag=image-text-to-text&sort=downloads&direction=-1&limit=2`, slim);
await json('feature-extraction (embeddings)', `${HF}/api/models?filter=gguf&pipeline_tag=feature-extraction&sort=downloads&direction=-1&limit=2`, slim);
await json('recently updated with expand[]', `${HF}/api/models?filter=gguf&sort=lastModified&direction=-1&limit=2&expand[]=gguf&expand[]=downloads&expand[]=likes&expand[]=lastModified&expand[]=pipeline_tag&expand[]=tags&expand[]=gated&expand[]=author&expand[]=trendingScore`, slim);
await json('apps=ollama', `${HF}/api/models?apps=ollama&sort=trendingScore&direction=-1&limit=2`, slim);
await json('author=unsloth', `${HF}/api/models?filter=gguf&author=unsloth&sort=downloads&direction=-1&limit=2`, slim);
await json('num_parameters range', `${HF}/api/models?filter=gguf&num_parameters=min:3B,max:6B&sort=downloads&direction=-1&limit=2`, slim);
await json('two filters (gguf + conversational)', `${HF}/api/models?filter=gguf&filter=conversational&sort=downloads&direction=-1&limit=2`, slim);
await json('repo detail ?blobs=true', `${HF}/api/models/${REPO}?blobs=true`, (m) => ({ ...slim(m), cardDataKeys: m.cardData ? Object.keys(m.cardData) : null, license: m.cardData?.license, base_model: m.cardData?.base_model, sha: m.sha, usedStorage: m.usedStorage, keys: Object.keys(m) }));
await json('repo tree', `${HF}/api/models/${REPO}/tree/main`, (f) => f);
{
  const r = await get(`${HF}/${REPO}/raw/main/README.md`);
  console.log(`\n# model card\nGET ${HF}/${REPO}/raw/main/README.md\n-> ${r.status} ${r.type} ${r.text.length} B\nhead: ${clip(r.text.replace(/\s+/g, ' '), 400)}`);
  const r2 = await get(`${HF}/${REPO}/resolve/main/README.md`);
  console.log(`resolve/main/README.md -> ${r2.status} ${r2.type} ${r2.text.length} B`);
}
await json('gated repo detail (meta-llama)', `${HF}/api/models/meta-llama/Llama-3.2-3B-Instruct`, (m) => ({ id: m.id, gated: m.gated, private: m.private, keys: Object.keys(m) }));
await json('unknown repo', `${HF}/api/models/no-such-owner-xyz/no-such-repo-xyz`);

console.log('\n\n## ollama.com');
await json('api/tags', 'https://ollama.com/api/tags', (j) => ({ count: j.models?.length, first: j.models?.slice(0, 2) }));
await json('registry _catalog', 'https://registry.ollama.ai/v2/_catalog');
await json('registry tags/list', 'https://registry.ollama.ai/v2/library/qwen3/tags/list', (j) => ({ name: j.name, count: j.tags?.length, tags: j.tags?.slice(0, 12) }));
await json('api/search', 'https://ollama.com/api/search?q=qwen');
await json('api/models', 'https://ollama.com/api/models');
await html('search page', 'https://ollama.com/search?q=qwen');
await html('search page, popular + capability', 'https://ollama.com/search?c=tools&o=popular');
await html('library page', 'https://ollama.com/library?sort=popular');
await html('model tags page', 'https://ollama.com/library/qwen3/tags');
await html('model page', 'https://ollama.com/library/qwen3');
