#!/usr/bin/env node
// CI-only fact-finding: the exact markup of one Ollama library list item, one search result and one
// tag row, so the catalogue's page reader and its test fixtures match the real site.
const get = async (url) => { const r = await fetch(url, { headers: { 'user-agent': 'harness-catalogue-probe', accept: 'text/html' }, signal: AbortSignal.timeout(30000) }); return r.text(); };
const squeeze = (s) => s.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/\s+/g, ' ').replace(/ class="[^"]*"/g, (m) => (m.length > 70 ? `${m.slice(0, 66)}…"` : m));
function item(html, anchorRe, open, close, max = 3600) {
  const m = anchorRe.exec(html); if (!m) return '(no match)';
  const start = html.lastIndexOf(open, m.index); const end = html.indexOf(close, m.index);
  return squeeze(html.slice(start, end + close.length)).slice(0, max);
}
const lib = await get('https://ollama.com/library?sort=popular');
console.log(`# library list item (first of ${[...lib.matchAll(/<a[^>]*href="\/library\/[a-z0-9._-]+"/g)].length})\n${item(lib, /<a[^>]*href="\/library\/[a-z0-9._-]+"/, '<li', '</li>')}`);
console.log(`\n# library list item for qwen3\n${item(lib, /<a[^>]*href="\/library\/qwen3"/, '<li', '</li>')}`);
const search = await get('https://ollama.com/search?q=qwen');
console.log(`\n# search result item\n${item(search, /<a[^>]*href="\/library\/[a-z0-9._-]+"/, '<li', '</li>')}`);
const opts = [...search.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)/g)].map((m) => `${m[1]}=${m[2].trim()}`);
console.log(`\n# search form options: ${JSON.stringify(opts).slice(0, 600)}`);
const inputs = [...search.matchAll(/<input[^>]*name="(c|s|o)"[^>]*value="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`);
console.log(`# search form inputs: ${JSON.stringify([...new Set(inputs)]).slice(0, 800)}`);
const more = [...search.matchAll(/<[^>]*hx-get="\/search\?[^"]*"[^>]*>/g)].map((m) => squeeze(m[0])).slice(0, 3);
console.log(`# search "load more" elements: ${JSON.stringify(more).slice(0, 900)}`);
const tags = await get('https://ollama.com/library/qwen3/tags');
const at = tags.search(/<a[^>]*href="\/library\/qwen3:0\.6b"/);
console.log(`\n# tag row for qwen3:0.6b (both markups)\n${squeeze(tags.slice(tags.lastIndexOf('<div class="group', at), at + 2600)).slice(0, 2600)}`);
