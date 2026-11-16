// A fake of the two catalogue sites for UI tests: the Hugging Face API (model list with Link-header cursors, model
// details with file sizes, README, and the hf.co registry manifests Ollama pulls from) and the ollama.com library
// pages (HTML, as the backend reads them). Point the backend at it with HARNESS_CATALOG_HF_BASE,
// HARNESS_CATALOG_HF_REGISTRY and HARNESS_CATALOG_OLLAMA_BASE (all three = fake.url).
//
//   const fake = await startFakeCatalog();   fake.requests → ['GET /api/models?…', …]
import http from 'node:http';

const MiB = 1024 ** 2;
const DAY = 86400e3;
const T0 = Date.parse('2026-11-14T10:00:00Z');

const PUBLISHERS = ['unsloth', 'bartowski', 'lmstudio-community', 'ggml-org', 'Qwen', 'google'];
const BASES = [
  ['Qwen3-4B-Instruct-2507', 4.02e9, 'qwen3', 'text-generation'],
  ['gemma-3-12b-it', 12.2e9, 'gemma3', 'image-text-to-text'],
  ['Llama-3.2-3B-Instruct', 3.21e9, 'llama', 'text-generation'],
  ['Mistral-Small-3.2-24B-Instruct-2506', 23.6e9, 'llama', 'text-generation'],
  ['Phi-4-mini-instruct', 3.84e9, 'phi3', 'text-generation'],
  ['granite-4.0-h-tiny', 6.9e9, 'granitehybrid', 'text-generation'],
  ['SmolLM3-3B', 3.08e9, 'smollm3', 'text-generation'],
  ['DeepSeek-R1-Distill-Qwen-7B', 7.62e9, 'qwen2', 'text-generation'],
  ['Qwen2.5-VL-7B-Instruct', 8.29e9, 'qwen2vl', 'image-text-to-text'],
  ['nomic-embed-text-v2-moe', 0.475e9, 'nomic-bert-moe', 'feature-extraction'],
  ['gpt-oss-20b', 20.9e9, 'gpt-oss', 'text-generation'],
  ['Qwen3-30B-A3B-Instruct-2507', 30.5e9, 'qwen3moe', 'text-generation'],
];

/** 60 Hugging Face GGUF repositories, Nemotron first (the one the tests download). */
export function hfRepos() {
  const out = [{
    id: 'unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF', author: 'unsloth', downloads: 812345, likes: 410, trendingScore: 99,
    lastModified: new Date(T0 - DAY).toISOString(), pipeline_tag: 'image-text-to-text', tags: ['gguf', 'conversational', 'imatrix', 'license:apache-2.0'], gated: false,
    gguf: { total: 7518069290, architecture: 'gemma4', context_length: 131072, chat_template: '{% for message in messages %}…{% if tools %}…' },
    cardData: { license: 'apache-2.0', base_model: 'nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B' },
  }];
  for (let i = 0; i < 59; i++) {
    const [name, total, arch, pipeline] = BASES[i % BASES.length];
    const pub = PUBLISHERS[i % PUBLISHERS.length];
    const gen = Math.floor(i / BASES.length);
    out.push({
      id: `${pub}/${name}${gen ? `-v${gen + 1}` : ''}-GGUF`, author: pub, downloads: 700000 - i * 9000, likes: 900 - i * 13, trendingScore: 90 - i,
      lastModified: new Date(T0 - (i % 17) * DAY).toISOString(), pipeline_tag: pipeline, tags: ['gguf', 'conversational', `license:${i % 5 === 3 ? 'llama3.2' : 'apache-2.0'}`],
      gated: i === 7 ? 'auto' : false,
      gguf: { total, architecture: arch, context_length: 32768 << (i % 3), chat_template: i % 2 ? 'tools here' : 'plain' },
      cardData: { license: i % 5 === 3 ? 'llama3.2' : 'apache-2.0' },
    });
  }
  // Not chat models: dropped by the backend.
  out.push({ id: 'someone/Wan2.2-T2V-GGUF', author: 'someone', downloads: 5000, likes: 3, trendingScore: 1, lastModified: new Date(T0).toISOString(), pipeline_tag: 'text-to-video', tags: ['gguf', 'text-to-video'], gated: false, gguf: { total: 14e9 } });
  return out;
}

const SORT_KEYS = { trendingScore: 'trendingScore', downloads: 'downloads', likes: 'likes', lastModified: 'lastModified' };

function siblingsFor(repo) {
  const stem = repo.id.split('/')[1].replace(/-GGUF$/, '');
  const total = repo.gguf?.total || 4e9;
  const bpw = { 'UD-Q2_K_XL': 3.4, 'UD-Q3_K_XL': 4.3, 'Q4_K_M': 4.85, 'UD-Q4_K_XL': 5.1, Q8_0: 8.5 };
  const files = Object.entries(bpw).map(([tag, b]) => ({ rfilename: `${stem}-${tag}.gguf`, lfs: { size: Math.round((total * b) / 8) } }));
  if (repo.id.startsWith('unsloth/NVIDIA-Nemotron')) {
    // the sizes Ollama's registry reports for the real Nemotron quants
    files[0].lfs.size = 3569 * MiB; files[1].lfs.size = 4024 * MiB; files[2].lfs.size = 4826 * MiB; files[3].lfs.size = 4826 * MiB + 1; files[4].lfs.size = 8000 * MiB;
    files.push({ rfilename: 'mmproj-BF16.gguf', lfs: { size: 946 * MiB } });
    files.push({ rfilename: 'imatrix_unsloth.gguf_file', lfs: { size: 4 * MiB } });
  } else if (repo.pipeline_tag === 'image-text-to-text') files.push({ rfilename: 'mmproj-F16.gguf', lfs: { size: 850 * MiB } });
  return [...files, { rfilename: 'README.md' }, { rfilename: '.gitattributes' }];
}

const CARD = (repo) => `---
license: apache-2.0
base_model: ${repo.cardData?.base_model || 'unknown'}
tags: [gguf]
---
# ${repo.id.split('/')[1]}

![badge](https://img.shields.io/badge/license-apache--2.0-blue) <img src="https://example.com/banner.png" alt="Banner" onerror="alert(1)">

A GGUF build for local inference. **Runs well** on laptops with ${repo.id.includes('Nemotron') ? '8 GB' : 'enough'} memory.

## How to run

\`\`\`bash
ollama run hf.co/${repo.id}:UD-Q3_K_XL
\`\`\`

| Quant | Use |
|---|---|
| UD-Q3_K_XL | best for 8 GB |
| Q8_0 | near lossless |

See [the release notes](https://huggingface.co/${repo.id}/discussions) and [our license](./LICENSE). <script>alert(2)</script>
`;

// ---------------------------------------------------------------------------------------------- ollama.com
export const OLLAMA_MODELS = [
  { name: 'qwen3', desc: 'Qwen3 is the latest generation of large language models in the Qwen series.', caps: ['tools', 'thinking'], sizes: ['0.6b', '1.7b', '4b', '8b', '14b', '30b'], pulls: '12.4M', updated: 3 },
  { name: 'gemma3', desc: 'The current, most capable model that runs on a single GPU.', caps: ['vision'], sizes: ['1b', '4b', '12b', '27b'], pulls: '9.1M', updated: 30 },
  { name: 'llama3.2', desc: "Meta's Llama 3.2 goes small with 1B and 3B models.", caps: ['tools'], sizes: ['1b', '3b'], pulls: '30.2M', updated: 300 },
  { name: 'nomic-embed-text', desc: 'A high-performing open embedding model with a large token context window.', caps: ['embedding'], sizes: [], pulls: '40.1M', updated: 500 },
  { name: 'deepseek-r1', desc: 'DeepSeek-R1 is a family of open reasoning models.', caps: ['tools', 'thinking'], sizes: ['1.5b', '7b', '8b', '14b', '32b', '70b', '671b'], pulls: '60.3M', updated: 90 },
  { name: 'mistral-small3.2', desc: 'An update to Mistral Small 3.1 with better instruction following.', caps: ['vision', 'tools'], sizes: ['24b'], pulls: '1.1M', updated: 120 },
  { name: 'phi4-mini', desc: 'Phi-4-mini brings significant enhancements in multilingual support, reasoning and mathematics.', caps: ['tools'], sizes: ['3.8b'], pulls: '800K', updated: 200 },
  { name: 'qwen2.5vl', desc: 'Flagship vision-language model of Qwen.', caps: ['vision'], sizes: ['3b', '7b', '32b', '72b'], pulls: '2.0M', updated: 150 },
  { name: 'granite4', desc: 'Granite 4 features improved instruction following and tool-calling.', caps: ['tools'], sizes: ['350m', '1b', '3b'], pulls: '400K', updated: 20 },
  { name: 'smollm2', desc: 'SmolLM2 is a family of compact language models.', caps: ['tools'], sizes: ['135m', '360m', '1.7b'], pulls: '1.5M', updated: 400 },
  { name: 'gpt-oss', desc: "OpenAI's open-weight models designed for powerful reasoning.", caps: ['tools', 'thinking'], sizes: ['20b', '120b'], pulls: '5.0M', updated: 60 },
  { name: 'kimi-k2', desc: 'A state-of-the-art mixture-of-experts model (cloud only).', caps: ['tools', 'cloud'], sizes: [], pulls: '100K', updated: 10 },
];
// More library entries so the list pages (24 per page in the backend).
for (let i = 0; i < 30; i++) OLLAMA_MODELS.push({ name: `community-model-${i}`, desc: `A smaller community model number ${i}.`, caps: i % 3 ? ['tools'] : [], sizes: [`${(i % 7) + 1}b`], pulls: `${100 - i}K`, updated: i + 1 });

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const pullsOf = (m) => { const x = /^([\d.]+)([KM])$/.exec(m.pulls); return x ? Math.round(Number(x[1]) * (x[2] === 'M' ? 1e6 : 1e3)) : 0; };
const smallestGB = (m) => Math.min(...m.sizes.map((z) => { const x = /^([\d.]+)([mb])$/.exec(z); return x ? Number(x[1]) * (x[2] === 'b' ? 0.62 : 0.00062) : 0.3; }), m.sizes.length ? Infinity : 0.3);

/**
 * One entry of ollama.com/search in the real markup (as in test/fixtures/ollama/search-*.html, captured live):
 * no x-test-* attributes; capability chips bg-indigo-50, size chips bg-[#ddf4ff], exact downloads in a title.
 */
function searchItem(m) {
  const updated = new Date(T0 - m.updated * DAY).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const caps = m.caps.map((c) => `<span class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-[2px] text-xs font-medium text-indigo-600">${c}</span>`).join('');
  const sizes = m.sizes.map((z) => `<span class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2 py-[2px] text-[13px] font-medium text-blue-600">${z}</span>`).join(' ');
  return `<li class="border-t-[0.5px] border-line first:border-t-0"> <a href="/library/${m.name}" class="group grid grid-cols-1 gap-y-1 px-1 py-4"> <div class="flex min-w-0 items-baseline gap-2.5"> <h2 class="truncate text-[17px] font-medium text-ink group-hover:underline" title="${m.name}"> <span >${m.name}</span> </h2> <span class="flex-none text-[15px] tabular-nums text-muted" title="Updated ${updated}">${m.updated}d</span> </div> <div class="order-last flex flex-wrap gap-1.5">${caps} </div> <p class="mt-1 line-clamp-2 text-[15px] text-muted">${esc(m.desc)}</p> <div class="mt-3 flex flex-wrap items-center gap-2 text-[13px]"> <span class="inline-flex items-center gap-1.5 tabular-nums text-ink sm:mr-1" title="${pullsOf(m).toLocaleString('en-US')} downloads"><svg/><span >${m.pulls}</span></span> <span class="inline-flex items-center gap-1.5 tabular-nums text-ink sm:mr-1"><svg/><span >${m.sizes.length + 1} tags</span></span> ${sizes} </div> </a> </li>`;
}

/** The tag rows of /library/<name>/tags, as on the site (tag link, digest • size • context window • inputs). */
function tagsFor(m) {
  const vision = m.caps.includes('vision');
  const sizes = m.sizes.length ? m.sizes : ['latest'];
  return sizes.map((z, i) => {
    const params = /^(\d+(?:\.\d+)?)([mb])$/.exec(z);
    const gb = params ? (Number(params[1]) * (params[2] === 'b' ? 1 : 0.001) * 0.62 + (vision ? 0.8 : 0.05)) : 0.3;
    const size = gb >= 1 ? `${gb.toFixed(1)}GB` : `${Math.round(gb * 1000)}MB`;
    return { tag: z, digest: `${(i + 1).toString(16).padStart(2, '0')}c0ffee${'ab'.repeat(2)}`.slice(0, 12), size, ctx: m.caps.includes('embedding') ? '2K' : '128K', inputs: vision ? 'Text, Image' : 'Text' };
  });
}

function tagRow(name, t) {
  return `<div class="group px-4 py-3"> <a href="/library/${name}:${t.tag}" class="md:hidden flex flex-col space-y-[6px] group"> <div class="flex items-center justify-between"> <span class="group-hover:underline">${name}:${t.tag}</span> </div> <div class="flex flex-col text-neutral-500 text-[13px]"> <span> <span class="font-mono"> ${t.digest}</span> • ${t.size} • ${t.ctx} context window • <span class="hidden sm:inline"> ${t.inputs} input • 3 weeks ago </span> </span> </div> </a> <div class="hidden md:flex flex-col space-y-[6px]"> <div class="grid grid-cols-12 items-center"> <span class="flex items-center font-medium col-span-6 group text-sm"> <a href="/library/${name}:${t.tag}" class="group-hover:underline">${name}:${t.tag}</a> <input class="command hidden" value="${name}:${t.tag}" /> </span> <p class="col-span-2 text-neutral-500 text-[13px]">${t.size}</p> <p class="col-span-2 text-neutral-500 text-[13px]">${t.ctx}</p> <div class="col-span-2 text-neutral-500 text-[13px]">${t.inputs.replace(', ', ', ')}</div> </div> <div class="flex text-neutral-500 text-xs items-center space-x-1"><span class="font-mono">${t.digest}</span> · 3 weeks ago</div> </div> </div>`;
}

function page(title, body) { return `<!doctype html><html><head><title>${title}</title><meta name="description" content="${title}"></head><body>${body}</body></html>`; }

// ---------------------------------------------------------------------------------------------- server
export async function startFakeCatalog({ port = 0, delayMs = 40 } = {}) {
  const repos = hfRepos();
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const json = (status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    const html = (status, text) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(text); };
    const p = url.pathname;
    // ---- Hugging Face list
    if (p === '/api/models') {
      let rows = repos.filter((r) => r.tags.includes('gguf'));
      const q = url.searchParams.get('search');
      if (q) rows = rows.filter((r) => r.id.toLowerCase().includes(q.toLowerCase()));
      const author = url.searchParams.get('author');
      if (author) rows = rows.filter((r) => r.author.toLowerCase() === author.toLowerCase());
      const pipe = url.searchParams.get('pipeline_tag');
      if (pipe) rows = rows.filter((r) => r.pipeline_tag === pipe);
      const np = url.searchParams.get('num_parameters');
      if (np) {
        const min = /min:([\d.]+)B/.exec(np);
        const max = /max:([\d.]+)B/.exec(np);
        rows = rows.filter((r) => (!min || r.gguf.total >= Number(min[1]) * 1e9) && (!max || r.gguf.total <= Number(max[1]) * 1e9));
      }
      const key = SORT_KEYS[url.searchParams.get('sort')] || 'trendingScore';
      rows = [...rows].sort((a, b) => (key === 'lastModified' ? Date.parse(b[key]) - Date.parse(a[key]) : b[key] - a[key]));
      const limit = Number(url.searchParams.get('limit') || 20);
      const start = Number(url.searchParams.get('cursor') || 0);
      const slice = rows.slice(start, start + limit).map(({ cardData, ...r }) => ({ ...r, _id: r.id, modelId: r.id }));
      const headers = {};
      if (start + limit < rows.length) {
        const next = new URL(`http://${req.headers.host}${req.url}`);
        next.searchParams.set('cursor', String(start + limit));
        headers.link = `<${next.href}>; rel="next"`;
      }
      return json(200, slice, headers);
    }
    // ---- Hugging Face detail / README
    let m = /^\/api\/models\/([^/]+\/[^/]+)$/.exec(p);
    if (m) {
      const repo = repos.find((r) => r.id === decodeURIComponent(m[1]));
      if (!repo) return json(401, { error: 'Repository not found' });
      return json(200, { ...repo, siblings: siblingsFor(repo) });
    }
    m = /^\/([^/]+\/[^/]+)\/raw\/main\/README\.md$/.exec(p);
    if (m) {
      const repo = repos.find((r) => r.id === decodeURIComponent(m[1]));
      if (!repo) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(CARD(repo));
    }
    // ---- hf.co registry (what Ollama pulls from)
    m = /^\/v2\/([^/]+\/[^/]+)\/manifests\/(.+)$/.exec(p);
    if (m) {
      const repo = repos.find((r) => r.id === decodeURIComponent(m[1]));
      const tag = decodeURIComponent(m[2]);
      const file = repo && siblingsFor(repo).find((f) => f.rfilename.endsWith(`-${tag}.gguf`));
      if (!file || tag === 'Q8_0') return json(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] });
      const proj = siblingsFor(repo).find((f) => /^mmproj/.test(f.rfilename));
      return json(200, { schemaVersion: 2, layers: [{ mediaType: 'application/vnd.ollama.image.model', size: file.lfs.size }, ...(proj ? [{ mediaType: 'application/vnd.ollama.image.projector', size: proj.lfs.size }] : [])] });
    }
    // ---- ollama.com: the search page (20 per page; later pages are HTMX fragments ending in a "load more" item)
    if (p === '/search' || p === '/library') {
      let list = [...OLLAMA_MODELS];
      const cs = url.searchParams.getAll('c');
      if (p === '/search') {
        if (cs.includes('local')) list = list.filter((x) => !x.caps.includes('cloud'));
        for (const c of cs.filter((x) => x !== 'local')) list = list.filter((x) => x.caps.includes(c));
        const sz = url.searchParams.get('s');
        if (sz) list = list.filter((x) => (sz === 'over64' ? smallestGB(x) > 64 : smallestGB(x) <= Number(sz)));
      }
      const order = url.searchParams.get('o') || url.searchParams.get('sort');
      list.sort((a, b2) => (order === 'newest' ? a.updated - b2.updated : pullsOf(b2) - pullsOf(a)));
      const q = url.searchParams.get('q');
      if (q) list = list.filter((x) => x.name.includes(q.toLowerCase()) || x.desc.toLowerCase().includes(q.toLowerCase()));
      if (p === '/library') return html(200, page('Library', `<ul role="list">${list.map(searchItem).join('\n')}</ul>`));
      const n = Number(url.searchParams.get('page') || 1);
      const slice = list.slice((n - 1) * 20, n * 20);
      const more = n * 20 < list.length;
      const nextQs = new URLSearchParams(url.searchParams);
      nextQs.set('page', String(n + 1));
      const items = slice.map(searchItem).join('\n') + (more ? `<li hx-get="/search?${esc(nextQs.toString())}" hx-trigger="revealed" hx-swap="outerHTML" hx-target="this" hx-include="[name=c], [name=o], [name=s]" class="py-4 text-center text-muted">Loading more…</li>` : '');
      if (n > 1) return html(200, items);
      return html(200, `<!doctype html><html><body><form><input name="q" value="${esc(q || '')}"><select name="o"><option value="popular">Popular</option><option value="newest">Newest</option></select><select name="s"><option value="">Any size</option><option value="8">Up to 8 GB</option><option value="16">Up to 16 GB</option></select><select name="c"><option value="local">Local</option><option value="vision">Vision</option><option value="embedding">Embedding</option></select></form><ul role="list">${items}</ul></body></html>`);
    }
    m = /^\/library\/([^/:]+)(\/tags)?$/.exec(p);
    if (m) {
      const model = OLLAMA_MODELS.find((x) => x.name === decodeURIComponent(m[1]));
      if (!model) return html(404, page('Not found', '<h1>Not found</h1>'));
      if (m[2]) return html(200, `<!doctype html><html><body><section>${tagsFor(model).map((t) => tagRow(model.name, t)).join('\n')}</section></body></html>`);
      return html(200, `<!doctype html><html><head><meta name="description" content="${esc(model.desc)}"></head><body>
<div class="flex flex-wrap space-x-2">${model.caps.map((c) => `<span class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-[2px] text-xs font-medium text-indigo-600">${c}</span>`).join('')}${model.sizes.map((z) => `<span class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2 py-[2px]">${z}</span>`).join('')}</div>
<section id="readme"><div id="editor"></div><div id="display" class="prose max-w-none"><h2>${model.name}</h2><p>${model.name} runs locally with Ollama &mdash; small and <strong>fast</strong>. <img src="https://ollama.com/assets/${model.name}.png" alt="logo"></p><ul><li>Small and fast</li><li>Tool calling</li></ul><pre><code>ollama run ${model.name}</code></pre><script>alert(1)</script><p>See <a href="https://ollama.com/blog">the blog</a>.</p></div></section>
</body></html>`);
    }
    json(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
