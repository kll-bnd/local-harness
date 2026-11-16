#!/usr/bin/env node
// CI-only fact-finding: how paging, sorting and the size/capability filters of ollama.com/search behave.
const names = (html) => [...new Set([...html.matchAll(/<a[^>]*href="\/library\/([a-z0-9._-]+)"/g)].map((m) => m[1]))];
async function get(label, url, headers = {}) {
  const r = await fetch(url, { headers: { 'user-agent': 'harness-catalogue-probe', accept: 'text/html', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  const text = r.status >= 300 && r.status < 400 ? '' : await r.text();
  const n = names(text);
  const next = text.match(/hx-get="(\/search\?[^"]*)"[^>]*hx-trigger="revealed"/)?.[1]?.replace(/&amp;/g, '&') ?? null;
  console.log(`${label}\n  GET ${url} ${JSON.stringify(headers)}\n  -> ${r.status}${r.headers.get('location') ? ` location=${r.headers.get('location')}` : ''} ${text.length} B, ${n.length} models, full page: ${/<html/i.test(text)}, next: ${next}\n  first: ${n.slice(0, 6).join(', ')}`);
  return { n, next, text };
}
const S = 'https://ollama.com/search';
const p1 = await get('page 1', `${S}?q=qwen`);
await get('page 2, plain', `${S}?page=2&q=qwen`);
const p2 = await get('page 2, HX-Request', `${S}?page=2&q=qwen`, { 'HX-Request': 'true' });
console.log(`  overlap with page 1: ${p2.n.filter((x) => p1.n.includes(x)).length} of ${p2.n.length}`);
if (p2.next) await get('page 3 via the next link, HX-Request', `https://ollama.com${p2.next}`, { 'HX-Request': 'true' });
await get('no query, default sort', `${S}`);
await get('local only', `${S}?c=local`);
await get('local, sort newest', `${S}?c=local&o=newest`);
await get('local, sort popular', `${S}?c=local&o=popular`);
await get('up to 8 GB', `${S}?s=8`);
await get('local, up to 8 GB, tools', `${S}?c=local&c=tools&s=8`);
await get('embedding', `${S}?c=embedding`);
await get('vision, up to 8 GB', `${S}?c=vision&s=8`);
const big = await get('last page probe (page 99, HX-Request)', `${S}?page=99&q=qwen`, { 'HX-Request': 'true' });
console.log(`  page 99 body: ${JSON.stringify(big.text.slice(0, 200))}`);
