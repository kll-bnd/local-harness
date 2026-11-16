// The browsable model catalogue (docs/API.md §10.8) against fakes of Hugging Face and ollama.com; the ollama.com
// fixtures are built from the site's real markup.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, tmpDir, GiB } from './helpers.mjs';
import { startFakeCatalog, NEMO } from './fake-catalog.mjs';
import { startFakeOllama } from './fake-ollama.mjs';
import { startServer } from '../server/index.mjs';
import { parseListPage, parseTagsPage, parseModelPage, countCommunityItems, nextSearchPage, sizeBucket } from '../server/catalog/ollama-library.mjs';
import { isChatRepo, groupFiles, stripFrontMatter, nextCursorFromLink } from '../server/catalog/huggingface.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ollama');
const fx = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

let cat;
before(async () => { cat = await startFakeCatalog(); Object.assign(process.env, cat.env); });
after(async () => { for (const k of Object.keys(cat.env)) delete process.env[k]; await cat.close(); });

describe('ollama.com parsing (real markup)', () => {
  test('library page: chips by their class, pulls before "Pulls", updated from the span title — never "looks like a size"', () => {
    const items = parseListPage(fx('library-popular.html'));
    const llama = items.find((i) => i.name === 'llama3.1');
    assert.deepEqual(llama.capabilities, ['tools']);
    assert.deepEqual(llama.sizes, ['8b', '70b', '405b']);
    assert.equal(llama.downloads, 121100000);
    assert.equal(llama.tagCount, 93);
    assert.equal(llama.updatedAt, '2024-11-30T22:34:00.000Z');
    assert.match(llama.description, /^Llama 3\.1 is a new state-of-the-art model/);
    const qwen = items.find((i) => i.name === 'qwen3');
    assert.ok(!qwen.sizes.includes('12.4m'), 'the pull count is not a size');
    assert.deepEqual(qwen.sizes, ['0.6b', '1.7b', '4b', '8b', '14b', '30b', '32b', '235b']);
    assert.equal(qwen.downloads, 12400000);
    assert.deepEqual(items.find((i) => i.name === 'embeddinggemma').sizes, ['300m']);
    assert.deepEqual(items.find((i) => i.name === 'glm-4.6').capabilities, ['cloud']);
  });

  test('search page and its htmx fragments: exact downloads, official models only, the next page link', () => {
    const p1 = parseListPage(fx('search-qwen-page1.html'));
    assert.deepEqual(p1.map((i) => i.name), ['qwen3.8', 'qwen3', 'qwen2.5vl']);
    assert.equal(p1[0].downloads, 6654157);
    assert.deepEqual(p1[0].capabilities, ['vision', 'tools', 'thinking']);
    assert.deepEqual(p1[0].sizes, ['27b']);
    assert.equal(p1[0].tagCount, 13);
    assert.equal(p1[0].updatedAt, new Date(Date.parse('November 8, 2026')).toISOString());
    assert.equal(nextSearchPage(fx('search-qwen-page1.html')), 2);
    assert.equal(countCommunityItems(fx('search-qwen-page1.html')), 0);
    const p2 = fx('search-qwen-page2.fragment.html');
    assert.deepEqual(parseListPage(p2).map((i) => i.name), ['qwen2.5-coder'], 'community uploads (/<user>/<model>) are not offered');
    assert.equal(countCommunityItems(p2), 2);
    assert.equal(sizeBucket(5e9), '8');
    assert.equal(sizeBucket(11e9), '16');
    assert.equal(sizeBucket(90e9), 'over64');
  });

  test('tags page (each tag twice) and model page: sizes, context, inputs, digests; README as text without scripts', () => {
    const tags = parseTagsPage(fx('tags-qwen3.html'), 'qwen3');
    const t = Object.fromEntries(tags.map((x) => [x.tag, x]));
    assert.deepEqual(Object.keys(t), ['latest', '0.6b', '4b', '8b', '0.6b-q8_0', '235b', '480b-cloud']);
    assert.deepEqual(t['0.6b'], { tag: '0.6b', digest: '7df6b6e09427', sizeBytes: 523e6, contextLength: 40960, inputs: ['text'] });
    assert.equal(t['4b'].contextLength, 262144);
    assert.equal(t.latest.digest, t['8b'].digest);
    assert.deepEqual(parseTagsPage(fx('tags-gemma3.html'), 'gemma3')[0].inputs, ['text', 'image']);
    const m = parseModelPage(fx('model-qwen3.html'));
    assert.equal(m.description, 'Qwen3 is the latest generation of large language models in Qwen series & friends.');
    assert.deepEqual(m.capabilities, ['tools', 'thinking']);
    assert.match(m.readme.text, /^## Qwen3/);
    assert.match(m.readme.text, /- Agent capabilities/);
    assert.match(m.readme.text, /```\nollama run qwen3\n```/);
    assert.ok(!m.readme.text.includes('alert'));
    // odd markup never throws
    assert.deepEqual(parseListPage('<li><a href="/library/">x</a></li><li>'), []);
    assert.deepEqual(parseTagsPage('', 'x'), []);
    assert.equal(parseModelPage('<html>').readme, null);
  });
});

describe('Hugging Face helpers', () => {
  test('only chat / vision / embedding repositories; quantization tags from file names; shards summed; front matter stripped', () => {
    assert.ok(isChatRepo({ pipeline_tag: 'text-generation', tags: [] }));
    assert.ok(isChatRepo({ tags: ['gguf', 'conversational'] }));
    assert.ok(!isChatRepo({ tags: ['gguf'] }));
    assert.ok(!isChatRepo({ pipeline_tag: 'text-to-video', tags: ['gguf', 'text-to-video'] }));
    const g = groupFiles([{ rfilename: 'M-UD-Q3_K_XL.gguf', size: 4 }, { rfilename: 'mmproj-F16.gguf', size: 1 }, { rfilename: 'dflash-M-Q8_0.gguf', size: 1 }, { rfilename: 'imatrix_unsloth.gguf', size: 1 }, { rfilename: 'Q4_K_M/M-Q4_K_M-00001-of-00002.gguf', lfs: { size: 3 } }, { rfilename: 'Q4_K_M/M-Q4_K_M-00002-of-00002.gguf', lfs: { size: 2 } }, { rfilename: 'notes.txt' }, { rfilename: 'weird.gguf', size: 9 }]);
    assert.deepEqual(g.quants.map((q) => [q.tag, q.sizeBytes, q.files.length]), [['UD-Q3_K_XL', 4, 1], ['Q4_K_M', 5, 2]]);
    assert.deepEqual(g.projectors.map((p) => p.path), ['mmproj-F16.gguf']);
    assert.equal(stripFrontMatter('---\na: 1\n---\n# Title\n'), '# Title\n');
    assert.equal(nextCursorFromLink('<https://evil.example/api/models?cursor=abc>; rel="next"', 'https://huggingface.co'), null, 'a next link to another host is ignored');
    assert.equal(nextCursorFromLink('<https://huggingface.co/api/models?cursor=abc>; rel="next"', 'https://huggingface.co'), 'abc');
  });
});

describe('GET /api/catalog', () => {
  let h;
  before(async () => { h = await setup({ system: { totalMem: 16 * GiB, platform: 'darwin', arch: 'arm64' } }); });
  after(() => h.close());

  test('ollama source: browse through the site search (c=local, no o for popular, HX-Request for page 2), stop at community uploads', async () => {
    cat.requests.length = 0;
    const r = await h.c.get('/api/catalog?source=ollama');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.items.map((i) => i.id), ['qwen3.8', 'qwen3', 'qwen2.5vl']);
    assert.match(r.data.sourceNote, /ollama\.com/);
    const first = cat.requests.find((x) => x.path === '/search');
    const qs = new URLSearchParams(first.query);
    assert.deepEqual(qs.getAll('c'), ['local']);
    assert.equal(qs.get('o'), null, 'popular is the default and is not sent');
    const q3 = r.data.items.find((i) => i.id === 'qwen3');
    assert.deepEqual(q3.capabilities, ['tools', 'thinking']);
    assert.equal(q3.kind, 'chat');
    assert.ok(['comfortable', 'smaller_file', 'too_big'].includes(q3.fit.verdict));
    assert.equal(r.data.items[0].kind, 'vision');
    assert.ok(r.data.nextCursor);
    const r2 = await h.c.get(`/api/catalog?source=ollama&cursor=${encodeURIComponent(r.data.nextCursor)}`);
    assert.equal(r2.status, 200, JSON.stringify(r2.data));
    assert.deepEqual(r2.data.items.map((i) => i.id), ['qwen2.5-coder']);
    assert.equal(r2.data.nextCursor, null, 'paging stops once community uploads begin');
    assert.equal(cat.requests.filter((x) => x.path === '/search').at(-1).headers['hx-request'], 'true');
    cat.requests.length = 0;
    await h.c.get('/api/catalog?source=ollama&sort=updated&kind=vision&fits=true&q=qwen');
    const s2 = new URLSearchParams(cat.requests.find((x) => x.path === '/search').query);
    assert.deepEqual(s2.getAll('c'), ['local', 'vision']);
    assert.equal(s2.get('o'), 'newest');
    assert.equal(s2.get('s'), '16');
    assert.equal(s2.get('q'), 'qwen');
    assert.equal((await h.c.get('/api/catalog?source=ollama&sort=likes')).data.error.code, 'unsupported_sort');
    assert.equal((await h.c.get(`/api/catalog?source=huggingface&cursor=${encodeURIComponent(r.data.nextCursor)}`)).data.error.code, 'bad_cursor');
  });

  test('ollama detail: tags as files (cloud dropped, latest folded into its sized twin), recommended tag, README', async () => {
    const r = await h.c.get('/api/catalog/model?source=ollama&id=qwen3');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.files.map((f) => f.tag), ['0.6b', '0.6b-q8_0', '4b', '8b', '235b']);
    assert.ok(r.data.notes.some((n) => /"latest" is the same file as "8b"/.test(n)));
    const f8 = r.data.files.find((f) => f.tag === '8b');
    assert.equal(f8.model, 'qwen3:8b');
    assert.equal(f8.sizeBytes, 5.2e9);
    assert.equal(f8.pullable, true);
    assert.equal(r.data.files.find((f) => f.tag === '235b').fit.fits, false);
    assert.ok(r.data.recommendedTag && r.data.recommendedTag !== '235b');
    assert.equal(r.data.card.format, 'text');
    assert.deepEqual(r.data.capabilities, ['tools', 'thinking']);
    const g = await h.c.get('/api/catalog/model?source=ollama&id=gemma3');
    assert.equal(g.data.kind, 'vision');
    assert.ok(g.data.files.every((f) => f.textOnly?.model));
    assert.equal((await h.c.get('/api/catalog/model?source=ollama&id=nope-not-here')).data.error.code, 'catalog_not_found');
    assert.equal((await h.c.get('/api/catalog/model?source=ollama&id=../etc')).status, 400);
  });

  test('huggingface list: chat repositories only; paging to the end returns every match exactly once', async () => {
    const expected = cat.rows.filter((m) => isChatRepo(m)).map((m) => m.id);
    const seen = [];
    let cursor = null;
    for (let i = 0; i < 40; i++) {
      const r = await h.c.get(`/api/catalog?source=huggingface&limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.ok(r.data.items.length <= 7);
      seen.push(...r.data.items.map((x) => x.id));
      cursor = r.data.nextCursor;
      if (!cursor) break;
    }
    assert.equal(cursor, null, 'reached the end');
    assert.deepEqual(seen, expected, 'no row skipped or repeated');
    const first = (await h.c.get('/api/catalog?source=huggingface&limit=3')).data.items[0];
    assert.equal(first.id, NEMO);
    assert.equal(first.kind, 'vision');
    assert.equal(first.parameters, 7518069290);
    assert.equal(first.license, 'apache-2.0');
    assert.ok(!first.tags.some((t) => t.startsWith('license:') || t === 'gguf'));
    assert.equal(first.fit.basis, 'parameters_estimate');
    const emb = await h.c.get('/api/catalog?source=huggingface&kind=embedding');
    assert.ok(emb.data.items.length && emb.data.items.every((i) => i.kind === 'embedding'));
    const pub = await h.c.get('/api/catalog?source=huggingface&publisher=org1&limit=50');
    assert.ok(pub.data.items.every((i) => i.publisher === 'org1'));
    assert.equal((await h.c.get('/api/catalog?source=huggingface&publisher=a%20b')).status, 400);
  });

  test('huggingface detail: quantizations with sizes, projector, pullable from the registry, card without front matter', async () => {
    const r = await h.c.get(`/api/catalog/model?source=huggingface&id=${NEMO}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const d = r.data;
    assert.deepEqual(d.files.map((f) => f.tag), ['UD-IQ3_XXS', 'UD-Q2_K_XL', 'UD-Q3_K_XL', 'UD-Q4_K_XL', 'BF16']);
    const q3 = d.files.find((f) => f.tag === 'UD-Q3_K_XL');
    assert.equal(q3.model, `hf.co/${NEMO}:UD-Q3_K_XL`);
    assert.equal(q3.sizeBytes, 4024 * 1024 ** 2);
    assert.equal(q3.projectorBytes, 991952896, 'from the registry manifest');
    assert.equal(q3.downloadBytes, q3.sizeBytes + 991952896);
    assert.equal(q3.pullable, true);
    assert.equal(d.files.find((f) => f.tag === 'BF16').pullable, false);
    assert.equal(d.hasProjector, true);
    assert.deepEqual(d.projectors.map((p) => p.path), ['mmproj-BF16.gguf', 'mmproj-F16.gguf', 'mmproj-Q8_0.gguf']);
    assert.equal(d.kind, 'vision');
    assert.deepEqual(d.license, { id: 'apache-2.0', name: null, link: null });
    assert.deepEqual(d.baseModels, ['nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B']);
    assert.match(d.card.text, /^# Nemotron 3\.5 Bolt E4B/);
    assert.equal(d.card.format, 'markdown');
    assert.ok(d.recommendedTag);
    assert.ok(d.files.every((f) => !f.files.some((x) => /mmproj|dflash|imatrix/.test(x.path))));
    const gated = await h.c.get('/api/catalog/model?source=huggingface&id=meta/Gated-GGUF');
    assert.equal(gated.data.gated, true);
    assert.equal(gated.data.downloadable, false);
    assert.equal(gated.data.recommendedTag, null);
    assert.deepEqual(gated.data.license, { id: 'other', name: 'custom', link: 'https://example/license' });
    const huge = await h.c.get('/api/catalog/model?source=huggingface&id=big/Huge-GGUF');
    assert.deepEqual(huge.data.files.map((f) => [f.tag, f.sizeBytes]), [['Q2_K', 25e9], ['Q4_K_M', 50e9]]);
    assert.equal((await h.c.get('/api/catalog/model?source=huggingface&id=odd/Sparse-GGUF')).status, 200, 'missing fields are tolerated');
    const missing = await h.c.get('/api/catalog/model?source=huggingface&id=nobody/Private-GGUF');
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error.code, 'catalog_not_found');
  });

  test('privacy: a generic User-Agent, no cookie or credentials; answers are cached in memory', async () => {
    assert.ok(cat.requests.length > 0);
    for (const r of cat.requests) {
      assert.equal(r.headers['user-agent'], 'Harness/0.2 (model catalogue)');
      assert.equal(r.headers.cookie, undefined);
      assert.equal(r.headers.authorization, undefined);
    }
    cat.requests.length = 0;
    const a = await h.c.get('/api/catalog?source=huggingface&limit=5&sort=likes');
    const n = cat.requests.length;
    const b = await h.c.get('/api/catalog?source=huggingface&limit=5&sort=likes');
    assert.equal(a.data.cached, false);
    assert.equal(b.data.cached, true);
    assert.equal(cat.requests.length, n, 'no second request to the site');
  });

  test('local source: installed models and recommendations, no network', async () => {
    cat.requests.length = 0;
    const r = await h.c.get('/api/catalog?source=local');
    assert.equal(r.status, 200);
    assert.ok(r.data.items.some((i) => i.recommended && i.id === 'nemotron-3.5-bolt-e4b'));
    assert.ok(r.data.items.some((i) => i.installed));
    assert.equal(cat.requests.length, 0);
    const d = await h.c.get('/api/catalog/model?source=local&id=nemotron-3.5-bolt-e4b');
    assert.ok(d.data.files.length >= 4);
  });

  test('download: pull with textOnlyCopy makes the text-only copy right after', async () => {
    const r = await h.c.sse('/api/models/pull', { model: `hf.co/${NEMO}:UD-Q3_K_XL`, textOnlyCopy: true });
    const done = r.events.find((e) => e.type === 'done');
    assert.ok(done, JSON.stringify(r.events.slice(-2)));
    assert.ok(done.textOnlyCopy?.model || done.textOnlyCopyError, JSON.stringify(done));
    assert.equal(done.textOnlyCopy?.model, 'nvidia-nemotron-3.5-bolt-e4b-text:ud-q3_k_xl');
  });
});

describe('8 GB Mac: the list and the detail agree', () => {
  test('Nemotron E4B: the list says a smaller file fits (text-only), the detail recommends one as a text-only copy', async () => {
    const h = await setup({ system: { totalMem: 8 * GiB, platform: 'darwin', arch: 'arm64' } });
    try {
      const list = await h.c.get('/api/catalog?source=huggingface&limit=3');
      const item = list.data.items.find((i) => i.id === NEMO);
      assert.notEqual(item.fit.verdict, 'too_big', JSON.stringify(item.fit));
      assert.equal(item.fit.fits, true);
      assert.equal(item.fit.textOnly, true);
      const d = (await h.c.get(`/api/catalog/model?source=huggingface&id=${NEMO}`)).data;
      const rec = d.files.find((f) => f.recommended);
      assert.ok(rec, 'a recommended file');
      assert.equal(rec.fit.basis, 'text_only_copy');
      assert.equal(rec.textOnly.recommended, true);
      assert.ok(['UD-Q3_K_XL', 'UD-Q2_K_XL', 'UD-IQ3_XXS'].includes(rec.tag), rec.tag);
      assert.equal(d.files.find((f) => f.tag === 'BF16').fit.fits, false);
    } finally { await h.close(); }
  });
});

describe('the catalogue and the internet blocker', () => {
  test('blocked: local works, online sources answer 403 offline_lock with the allow hint; inside the window they work; block again', async () => {
    const fake = await startFakeOllama({ port: 0 });
    const dataDir = await tmpDir();
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ providers: { builtin: { ollama: { baseUrl: fake.url } } }, ollama: { autoStart: false }, embeddings: { model: 'off' } }));
    const srv = await startServer({ port: 0, dataDir, autodetect: false, logLevel: 'silent', processGuards: false, keychain: 'file', security: { mode: 'off', apiAuth: false }, offlineLock: true });
    const get = async (p, init) => { const r = await fetch(srv.url + p, init); return { status: r.status, data: await r.json() }; };
    try {
      assert.equal((await get('/api/catalog?source=local')).status, 200);
      for (const src of ['huggingface', 'ollama']) {
        const r = await get(`/api/catalog?source=${src}`);
        assert.equal(r.status, 403);
        assert.equal(r.data.error.code, 'offline_lock');
        assert.equal(r.data.error.details.what, 'model_catalog');
        assert.deepEqual(r.data.error.details.allow, { method: 'POST', path: '/api/network/allow', body: { minutes: 15 }, needsPassword: true, label: 'Allow internet for 15 minutes' });
      }
      const pull = await get('/api/models/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:4b' }) });
      assert.equal(pull.status, 403);
      assert.equal(pull.data.error.details.what, 'model_download');
      const allow = await get('/api/network/allow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes: 15 }) });
      assert.equal(allow.status, 200, JSON.stringify(allow.data));
      assert.equal(allow.data.offlineLock.blocked, false);
      assert.equal((await get('/api/catalog?source=ollama')).status, 200);
      assert.equal((await get('/api/network/block', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).data.offlineLock.blocked, true);
      assert.equal((await get('/api/catalog?source=ollama')).data.error.code, 'offline_lock');
    } finally { await srv.close(); await fake.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
});



