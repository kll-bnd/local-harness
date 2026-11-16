// Stand-ins for huggingface.co (+ hf.co's Ollama registry) and ollama.com for the model catalogue tests.
// Hugging Face: the request/response shapes verified against the real API (Nov 2026) — /api/models with
// filter/sort/direction/limit/search/author/pipeline_tag/expand[] and a Link rel="next" cursor; /api/models/<id>
// ?blobs=true; /<id>/raw/main/README.md; /v2/<id>/manifests/<tag>; unknown repos answer 401.
// ollama.com: the fixtures in test/fixtures/ollama/, built from the real markup.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures', 'ollama');
const MiB = 1024 ** 2;

export const NEMO = 'unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF';
const NEMO_FILES = [
  ['NVIDIA-Nemotron-3.5-Bolt-E4B-UD-IQ3_XXS.gguf', 3532 * MiB], ['NVIDIA-Nemotron-3.5-Bolt-E4B-UD-Q2_K_XL.gguf', 3569 * MiB],
  ['NVIDIA-Nemotron-3.5-Bolt-E4B-UD-Q3_K_XL.gguf', 4024 * MiB], ['NVIDIA-Nemotron-3.5-Bolt-E4B-UD-Q4_K_XL.gguf', 4826 * MiB],
  ['NVIDIA-Nemotron-3.5-Bolt-E4B-BF16.gguf', 14336 * MiB], ['mmproj-BF16.gguf', 946 * MiB], ['mmproj-F16.gguf', 946 * MiB], ['mmproj-Q8_0.gguf', 520 * MiB],
  ['dflash-NVIDIA-Nemotron-3.5-Bolt-E4B-Q8_0.gguf', 702 * MiB], ['imatrix_unsloth.gguf', 6 * MiB], ['README.md', 9000], ['config.json', 1000],
];

function repoList() {
  const rows = [];
  rows.push({ _id: 'n1', id: NEMO, author: 'unsloth', gated: false, lastModified: '2026-11-02T10:11:12.000Z', likes: 410, trendingScore: 900, downloads: 812345, pipeline_tag: 'image-text-to-text', tags: ['gguf', 'conversational', 'imatrix', 'license:apache-2.0', 'base_model:nvidia/x', 'en'], gguf: { total: 7518069290, architecture: 'gemma4', context_length: 131072, chat_template: '{% if tools %}…{% endif %}' } });
  for (let i = 0; i < 70; i++) {
    const noise = i % 7 === 3; // video / diffusion / speech GGUFs that must be dropped
    const noTag = i % 11 === 5; // no pipeline_tag, no conversational tag → dropped too
    rows.push({
      _id: `r${i}`, id: `org${i % 4}/Model-${i}-GGUF`, author: `org${i % 4}`, gated: i === 9 ? 'manual' : false, lastModified: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z`,
      likes: 300 - i, trendingScore: 800 - i, downloads: 100000 - i * 100,
      ...(noise ? { pipeline_tag: 'text-to-video', tags: ['gguf', 'text-to-video', 'diffusers'] } : noTag ? { tags: ['gguf'] } : i % 5 === 0 ? { tags: ['gguf', 'conversational'] } : { pipeline_tag: i % 6 === 0 ? 'feature-extraction' : 'text-generation', tags: ['gguf', 'conversational', `license:mit`] }),
      gguf: { total: (1 + (i % 9)) * 1e9, architecture: 'llama', context_length: 32768 },
    });
  }
  return rows;
}

export async function startFakeCatalog() {
  const requests = [];
  const rows = repoList();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: url.pathname, query: url.search, headers: { ...req.headers } });
    const send = (status, body, headers = {}) => { const b = typeof body === 'string' ? body : JSON.stringify(body); res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', ...headers }); res.end(b); };
    const base = `http://${req.headers.host}`;
    // ---------------------------------------------------------------- Hugging Face API
    if (url.pathname === '/api/models') {
      let list = rows.slice();
      const q = url.searchParams;
      if (q.get('filter') !== 'gguf') return send(400, { error: 'expected filter=gguf in this fake' });
      if (q.get('search')) list = list.filter((r) => r.id.toLowerCase().includes(q.get('search').toLowerCase()));
      if (q.get('author')) list = list.filter((r) => r.author === q.get('author'));
      if (q.get('pipeline_tag')) list = list.filter((r) => r.pipeline_tag === q.get('pipeline_tag'));
      const key = { trendingScore: 'trendingScore', downloads: 'downloads', likes: 'likes', lastModified: 'lastModified' }[q.get('sort')];
      if (!key) return send(400, { error: 'bad sort' });
      list.sort((a, b) => (a[key] < b[key] ? 1 : a[key] > b[key] ? -1 : 0));
      const limit = Number(q.get('limit') || 20);
      const off = q.get('cursor') ? Number(Buffer.from(q.get('cursor'), 'base64').toString()) : 0;
      const page = list.slice(off, off + limit);
      const headers = {};
      if (off + limit < list.length) {
        const next = new URL(url.pathname + url.search, base);
        next.searchParams.set('cursor', Buffer.from(String(off + limit)).toString('base64'));
        headers.link = `<${next.href}>; rel="next"`;
      }
      const expand = q.getAll('expand[]');
      return send(200, page.map((r) => (expand.length ? Object.fromEntries(Object.entries(r).filter(([k]) => k === '_id' || k === 'id' || expand.includes(k))) : { _id: r._id, id: r.id, likes: r.likes, private: false, downloads: r.downloads, tags: r.tags, ...(r.pipeline_tag ? { pipeline_tag: r.pipeline_tag } : {}), modelId: r.id })), headers);
    }
    const detail = /^\/api\/models\/([^/]+\/[^/]+)$/.exec(url.pathname);
    if (detail) {
      const id = detail[1];
      if (id === NEMO) {
        return send(200, {
          _id: 'n1', id, author: 'unsloth', gated: false, lastModified: '2026-11-02T10:11:12.000Z', likes: 410, downloads: 812345, pipeline_tag: 'image-text-to-text',
          tags: ['gguf', 'conversational', 'imatrix'], cardData: { license: 'apache-2.0', base_model: 'nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B', pipeline_tag: 'image-text-to-text', language: ['en'] },
          gguf: { total: 7518069290, architecture: 'gemma4', context_length: 131072, chat_template: 'tools here' },
          siblings: NEMO_FILES.map(([f, size]) => ({ rfilename: f, blobId: 'b', size, ...(f.endsWith('.gguf') ? { lfs: { sha256: 'x', size, pointerSize: 135 } } : {}) })),
        });
      }
      if (id === 'meta/Gated-GGUF') return send(200, { id, author: 'meta', gated: 'manual', siblings: [{ rfilename: 'Gated-Q4_K_M.gguf', size: 4e9 }], cardData: { license: 'other', license_name: 'custom', license_link: 'https://example/license' } });
      if (id === 'big/Huge-GGUF') return send(200, { id, author: 'big', gated: false, pipeline_tag: 'text-generation', siblings: [{ rfilename: 'Q4_K_M/Huge-Q4_K_M-00001-of-00002.gguf', lfs: { size: 30e9 } }, { rfilename: 'Q4_K_M/Huge-Q4_K_M-00002-of-00002.gguf', lfs: { size: 20e9 } }, { rfilename: 'Huge-Q2_K.gguf', size: 25e9 }] });
      if (id === 'odd/Sparse-GGUF') return send(200, { id }); // nearly nothing: must not throw
      return send(401, { error: 'Invalid username or password.' });
    }
    const readme = /^\/([^/]+\/[^/]+)\/raw\/main\/README\.md$/.exec(url.pathname);
    if (readme) {
      if (readme[1] !== NEMO) return send(404, 'Entry not found');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('---\nlicense: apache-2.0\ntags:\n- gguf\n---\n# Nemotron 3.5 Bolt E4B\n\nRun it with `ollama run hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL`.\n<script>alert(1)</script>\n');
    }
    const manifest = /^\/v2\/([^/]+\/[^/]+)\/manifests\/([^/]+)$/.exec(url.pathname);
    if (manifest) {
      const tag = decodeURIComponent(manifest[2]);
      if (manifest[1] === NEMO && tag !== 'BF16' && NEMO_FILES.some(([f]) => f.endsWith(`-${tag}.gguf`))) {
        const size = NEMO_FILES.find(([f]) => f.endsWith(`-${tag}.gguf`))[1];
        return send(200, { schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json', layers: [{ mediaType: 'application/vnd.ollama.image.model', size }, { mediaType: 'application/vnd.ollama.image.projector', size: 991952896 }] });
      }
      if (manifest[1] === 'big/Huge-GGUF') return send(200, { layers: [{ mediaType: 'application/vnd.ollama.image.model', size: 1 }] });
      return send(400, { errors: [{ code: 'MANIFEST_UNKNOWN' }] });
    }
    // ---------------------------------------------------------------- ollama.com
    const fixture = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
    if (url.pathname === '/search') {
      const page = Number(url.searchParams.get('page') || 1);
      if (url.searchParams.get('o') === 'popular') { res.writeHead(303, { location: '/search?' + url.searchParams.toString().replace(/&?o=popular/, '') }); return res.end(); }
      if (page > 1 && req.headers['hx-request'] !== 'true') { res.writeHead(303, { location: `/search?q=${encodeURIComponent(url.searchParams.get('q') || '')}` }); return res.end(); }
      if (page === 1) return send(200, fixture('search-qwen-page1.html'));
      if (page === 2) return send(200, fixture('search-qwen-page2.fragment.html'));
      return send(200, fixture('search-qwen-page3.fragment.html'));
    }
    if (url.pathname === '/library') return send(200, fixture('library-popular.html'));
    const lib = /^\/library\/([^/:]+)(\/tags)?$/.exec(url.pathname);
    if (lib) {
      const [, name, tags] = lib;
      const f = tags ? `tags-${name}.html` : `model-${name}.html`;
      if (!fs.existsSync(path.join(FIX, f))) return send(404, '<html>Not found</html>');
      return send(200, fixture(f));
    }
    send(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, requests, rows,
    env: { HARNESS_CATALOG_HF_BASE: url, HARNESS_CATALOG_HF_REGISTRY: url, HARNESS_CATALOG_OLLAMA_BASE: url },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
