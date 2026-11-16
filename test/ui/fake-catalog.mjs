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

function libraryItem(m) {
  return `<li x-test-model class="flex">
  <a href="/library/${m.name}" class="group w-full">
    <div><h2><span x-test-search-response-title>${m.name}</span></h2>
    <p class="max-w-lg break-words text-neutral-800">${m.desc.replace(/'/g, '&#39;')}</p></div>
    <div class="flex">${m.caps.map((c) => `<span x-test-capability class="badge">${c}</span>`).join('')}${m.sizes.map((s) => `<span x-test-size class="badge">${s}</span>`).join('')}</div>
    <p class="flex"><span><span x-test-pull-count>${m.pulls}</span> <span>Pulls</span></span>
    <span><span x-test-updated title="Updated ${new Date(T0 - m.updated * DAY).toUTCString()}">${m.updated} days ago</span></span></p>
  </a>
</li>`;
}

function tagsFor(m) {
  const vision = m.caps.includes('vision');
  const sizes = m.sizes.length ? m.sizes : ['latest'];
  return sizes.map((s, i) => {
    const params = /^(\d+(?:\.\d+)?)([mb])$/.exec(s);
    const gb = params ? (Number(params[1]) * (params[2] === 'b' ? 1 : 0.001) * 0.62 + (vision ? 0.8 : 0.05)).toFixed(1) : '0.3';
    return { tag: s, digest: `${(i + 1).toString(16).padStart(2, '0')}c0ffee${'ab'.repeat(2)}`.slice(0, 12), size: `${gb}GB`, ctx: m.caps.includes('embedding') ? '2K' : '128K', inputs: vision ? 'Text, Image' : 'Text' };
  });
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
    // ---- ollama.com
    if (p === '/library' || p === '/search') {
      let list = [...OLLAMA_MODELS];
      if (url.searchParams.get('sort') === 'newest') list.sort((a, b) => a.updated - b.updated);
      const q = url.searchParams.get('q');
      if (p === '/search' && q) list = list.filter((x) => x.name.includes(q.toLowerCase()) || x.desc.toLowerCase().includes(q.toLowerCase()));
      return html(200, page('Library', `<ul role="list">${list.map(libraryItem).join('\n')}</ul>`));
    }
    m = /^\/library\/([^/:]+)(\/tags)?$/.exec(p);
    if (m) {
      const model = OLLAMA_MODELS.find((x) => x.name === decodeURIComponent(m[1]));
      if (!model) return html(404, page('Not found', '<h1>Not found</h1>'));
      if (m[2]) {
        const rows = tagsFor(model).map((t) => `<div class="row"><a href="/library/${model.name}:${t.tag}">${model.name}:${t.tag}</a> <span>${t.digest}</span> · <span>${t.size}</span> · <span>${t.ctx} context window</span> · <span>${t.inputs} input</span></div>`);
        return html(200, page(`${model.name} tags`, rows.join('\n')));
      }
      return html(200, `<!doctype html><html><head><meta name="description" content="${model.desc.replace(/"/g, '&quot;')}"></head><body>
        <div>${model.caps.map((c) => `<span class="badge">${c}</span>`).join('')}</div>
        <div id="readme"><div id="display"><h2>Readme</h2><p>${model.name} runs locally with Ollama. <img src="https://ollama.com/assets/${model.name}.png" alt="logo"></p><pre><code>ollama run ${model.name}</code></pre><ul><li>Small and fast</li><li>Tool calling</li></ul></div></div>
      </body></html>`);
    }
    json(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
