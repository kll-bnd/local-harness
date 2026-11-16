// Tests for scripts/live-check.mjs: it must pass against the repo's fakes, and it must notice when a backend
// deviates from what Harness assumes (deviant proxies below wrap the fakes and change single behaviours).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeOllama } from './fake-ollama.mjs';
import { startFakeOpenAI } from './fake-openai.mjs';
import { startFakeA1111 } from './fake-a1111.mjs';
import { startFakeComfyUI } from './fake-comfyui.mjs';
import { runLiveCheck, redact, parseOptions, CATALOG, sourceRefs, harnessAssumes } from '../scripts/live-check.mjs';
import { A1111Provider } from '../server/image/a1111.mjs';

process.env.HARNESS_NO_OLLAMA_AUTOSTART = '1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'live-check.mjs');

function runCli(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, NO_COLOR: '1' };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

/**
 * Pass-through proxy in front of a fake. `rules(req)` may return a response {status, json} to answer directly;
 * `transform(req, status, text)` may rewrite the forwarded answer.
 */
async function deviant(target, { rules = () => null, transform = (req, status, text) => text } = {}) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body = null;
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { body = null; }
    const r = { method: req.method, path: new URL(req.url, 'http://x').pathname, url: req.url, body };
    const direct = rules(r);
    if (direct) {
      const s = JSON.stringify(direct.json);
      res.writeHead(direct.status, { 'content-type': 'application/json' });
      return res.end(s);
    }
    const up = await fetch(target + req.url, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json' }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw });
    const ct = up.headers.get('content-type') || 'application/json';
    const buf = Buffer.from(await up.arrayBuffer());
    const out = /json|ndjson|event-stream/.test(ct) ? Buffer.from(transform(r, up.status, buf.toString('utf8'))) : buf;
    res.writeHead(up.status, { 'content-type': ct });
    res.end(out);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

/**
 * Only while server/context/measurements.mjs records /api/ps `size` as the model's whole footprint (the old design;
 * the `measureTotal` anchor): make the fake report that. Harness now measures the runner's RSS on macOS and uses
 * model file + ps size otherwise, matching the fake's real-Ollama-0.40 semantics, so this is a no-op.
 */
function pinPsToTotalFootprint(fake, model = 'qwen3:4b', perTokenBytes = 147456) {
  if (!harnessAssumes('measureTotal')) return;
  const m = fake.installed.get(model);
  const weights = m.weightBytes ?? m.size;
  fake.setPsProfile(model, { baseBytes: 'weightBytes' in m ? 2 * weights + 300 * 1024 ** 2 : weights, perTokenBytes });
}

const byId = (result, id) => {
  const c = result.checks.find((x) => x.id === id);
  assert.ok(c, `check ${id} was not reported`);
  return c;
};
const quiet = () => { const buf = []; return { out: (s) => buf.push(s), text: () => buf.join('') }; };
/** LIVECHECK_TEST_OUT=<dir> keeps the terminal output of every in-process run (handy when a deviant case changes). */
async function keep(name, q) {
  if (!process.env.LIVECHECK_TEST_OUT) return;
  await fs.mkdir(process.env.LIVECHECK_TEST_OUT, { recursive: true });
  await fs.writeFile(path.join(process.env.LIVECHECK_TEST_OUT, `${name}.txt`), q.text());
}

/** Every test gets its own fakes: runs execute concurrently and pull/delete/load models. */
async function withFakes(which, fn) {
  const make = { ollama: () => startFakeOllama({ port: 0, delayMs: 2, pullStepMs: 2 }), openai: () => startFakeOpenAI({ port: 0, delayMs: 1 }), a1111: () => startFakeA1111({ port: 0, stepMs: 10 }), comfy: () => startFakeComfyUI({ port: 0, stepMs: 10 }) };
  const fakes = Object.fromEntries(await Promise.all(which.map(async (k) => [k, await make[k]()])));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-livecheck-test-'));
  try { return await fn(fakes, tmp); } finally {
    await Promise.all(Object.values(fakes).map((f) => f.close()));
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

describe('live-check against the repo fakes', { concurrency: true }, () => {
  test('full run (raw + e2e, pulls and images allowed) passes, writes valid JSON and Markdown, exits 0', () => withFakes(['ollama', 'openai', 'a1111', 'comfy'], async (fakes, tmp) => {
    pinPsToTotalFootprint(fakes.ollama);
    const json = path.join(tmp, 'out.json');
    const md = path.join(tmp, 'out.md');
    const { code, out } = await runCli([
      '--no-detect', '--ollama-url', fakes.ollama.url, '--llamacpp-url', fakes.openai.url, '--a1111-url', fakes.a1111.url,
      '--comfyui-url', fakes.comfy.url, '--openai-images-url', fakes.openai.url, '--openai-think-model', 'fake-reasoner',
      '--openai-notools-model', 'fake-notools', '--allow-pull', '--pull-model', 'llama3.2:3b', '--allow-images',
      '--data-dir', tmp, '--json', json, '--markdown', md,
    ]);
    const result = JSON.parse(await fs.readFile(json, 'utf8'));
    const failed = result.checks.filter((c) => c.status === 'FAIL').map((c) => `${c.id}: ${c.detail}`);
    assert.deepEqual(failed, [], `unexpected FAILs against the fakes:\n${failed.join('\n')}\n\n${out.slice(-3000)}`);
    assert.equal(code, 0, out.slice(-2000));
    assert.equal(result.exitCode, 0);
    assert.ok(result.checks.length >= 100, `only ${result.checks.length} checks`);
    assert.ok(!result.checks.some((c) => /check crashed/.test(c.detail) || c.id === 'env.group_crash'), 'a check crashed');
    for (const layer of ['env', 'raw', 'e2e']) assert.ok(result.summary.byLayer[layer].PASS > 0, `no PASS in layer ${layer}`);
    // e2e.measurement needs macOS (Harness reads the runner's RSS and swap growth there; elsewhere it is estimate-only).
    for (const id of ['e2e.chat_stream', 'e2e.tool_turn', 'e2e.compaction_auto', ...(process.platform === 'darwin' ? ['e2e.measurement'] : []), 'e2e.image_tool', 'e2e.pull_delete', 'a1111.txt2img.count2', 'comfyui.history', 'ollama.tools.call', 'openai.llamacpp.tools.deltas']) {
      assert.notEqual(byId(result, id).status, 'SKIP', `${id} skipped`);
    }
    assert.equal(byId(result, 'e2e.memory_extraction').status, 'PASS');
    assert.ok(result.samples['ollama POST /api/chat stream (qwen3:4b)']?.lines?.length > 0, 'raw NDJSON sample missing');
    assert.ok(result.samples['a1111 POST /sdapi/v1/txt2img — exact Harness request body']?.batch_count === 1);
    assert.ok(byId(result, 'ollama.chat.stream').source.some((s) => /server\/providers\/ollama\.mjs:\d+/.test(s)), 'source line missing');
    const mdText = await fs.readFile(md, 'utf8');
    assert.match(mdText, /^# Harness live check/);
    assert.match(mdText, /## All checks/);
    assert.match(out, /\[raw\] Ollama/);
    assert.match(out, /\[e2e\] Harness end-to-end/);
    assert.match(out, /Models picked/);
  }));

  test('deviant Ollama: string tool arguments, uncached prompt_eval_count, no ps context_length, flat ps size, negative keep_alive rejected, different thinking error, slow unload', () => withFakes(['ollama'], async (fakes) => {
    pinPsToTotalFootprint(fakes.ollama);
    const lastKeepAlive = new Map();
    const lastPs = new Map();
    const unloadedAt = new Map();
    let prevChat = null;
    const proxy = await deviant(fakes.ollama.url, {
      rules(r) {
        if (r.method === 'POST' && ['/api/chat', '/api/generate'].includes(r.path)) {
          const ka = r.body?.keep_alive;
          if (typeof ka === 'number' && ka < 0) return { status: 400, json: { error: 'keep_alive must not be negative' } };
          if (typeof ka === 'string' && /^-?\d+(\.\d+)?$/.test(ka)) return { status: 400, json: { error: `time: missing unit in duration "${ka}"` } };
          if (r.path === '/api/chat' && r.body?.think === true && r.body.model === 'deepseek-r1:1.5b') return { status: 400, json: { error: 'thinking is not enabled for this model' } };
          if (ka === 0) unloadedAt.set(r.body.model, Date.now());
          else if (ka !== undefined) lastKeepAlive.set(r.body.model, ka);
        }
        return null;
      },
      transform(r, status, text) {
        if (r.path === '/api/chat' && status === 200) {
          const key = JSON.stringify(r.body);
          const cached = key === prevChat;
          prevChat = key;
          return text.split('\n').map((l) => {
            if (!l.trim()) return l;
            const o = JSON.parse(l);
            for (const tc of o.message?.tool_calls || []) tc.function.arguments = JSON.stringify(tc.function.arguments);
            if (o.done && cached) delete o.prompt_eval_count;
            return JSON.stringify(o);
          }).join('\n');
        }
        if (r.path === '/api/ps') {
          const j = JSON.parse(text);
          for (const m of j.models) {
            delete m.context_length;
            m.size = 2.5e9;
            m.size_vram = 2.5e9;
            const ka = lastKeepAlive.get(m.model) ?? '5m';
            const secs = typeof ka === 'number' ? ka : String(ka).startsWith('-') ? -1 : [...String(ka).matchAll(/(\d+)(h|m|s)/g)].reduce((a, x) => a + Number(x[1]) * { h: 3600, m: 60, s: 1 }[x[2]], 0);
            m.expires_at = new Date(secs < 0 ? Date.parse('2318-01-01T00:00:00Z') : Date.now() + secs * 1000).toISOString();
            lastPs.set(m.model, m);
          }
          for (const [name, at] of unloadedAt) if (Date.now() - at < 1300 && !j.models.some((m) => m.model === name) && lastPs.has(name)) j.models.push(lastPs.get(name));
          return JSON.stringify(j);
        }
        return text;
      },
    });
    try {
      const q = quiet();
      const { exitCode, result } = await runLiveCheck(['--no-detect', '--ollama-url', proxy.url, '--only', 'ollama', '--no-color'], q);
      await keep('deviant-ollama', q);
      const s = (id) => byId(result, id);
      assert.equal(exitCode, 1, q.text().slice(-1500));
      assert.equal(s('ollama.tools.call').status, 'WARN');
      assert.match(s('ollama.tools.call').detail, /arguments is a STRING/);
      assert.equal(s('ollama.tools.result_roundtrip').status, 'PASS', 'parseArgs must cope with string arguments');
      assert.equal(s('ollama.chat.done_metrics').status, 'PASS');
      assert.equal(s('ollama.chat.prompt_eval_cached').status, 'FAIL');
      assert.match(s('ollama.chat.prompt_eval_cached').detail, /MISSING on a fully cached repeat/);
      assert.match(s('ollama.chat.prompt_eval_cached').fix, /calibrates only when promptTokens is truthy|only calibrates/);
      assert.equal(s('ollama.ps.context_length').status, 'WARN');
      assert.match(s('ollama.ps.context_length').detail, /absent/);
      // A flat ps size only mattered while Harness took ps size as the footprint; it now measures the runner (macOS).
      assert.equal(s('ollama.ps.size_grows_with_num_ctx').status, harnessAssumes('measureTotal') ? 'FAIL' : 'WARN');
      assert.match(s('ollama.ps.size_grows_with_num_ctx').detail, /did not grow/);
      assert.equal(s('ollama.keep_alive.number_-1').status, 'FAIL');
      assert.match(s('ollama.keep_alive.number_-1').detail, /rejected: HTTP 400 "keep_alive must not be negative"/);
      assert.equal(s('ollama.keep_alive.string_-1').status, 'FAIL', 'Harness sends "-1" as the number -1, which this server rejects');
      // unit-less strings are rejected by this server (as by Go's time.ParseDuration): Harness converts them, so the check passes and records the raw answer
      assert.equal(s('ollama.keep_alive.string_30').status, 'PASS');
      assert.ok(s('ollama.keep_alive.string_30').info.some((l) => /raw "30" straight to Ollama → HTTP 400/.test(l)));
      assert.equal(s('ollama.keep_alive.string_5m').status, 'PASS');
      assert.equal(s('ollama.think.unsupported_error').status, 'FAIL');
      assert.match(s('ollama.think.unsupported_error').detail, /thinking is not enabled for this model/);
      assert.match(s('ollama.think.unsupported_error').fix, /classifyOllamaError/);
      // slow unload (1.3 s): Harness waits for /api/ps (ImageService._waitUnloaded), so this passes but says so
      assert.equal(s('ollama.unload.chat').status, 'PASS');
      assert.match(s('ollama.unload.chat').detail, /asynchronous; ImageService waits up to/);
      assert.equal(s('ollama.think.on').status, 'PASS');
    } finally {
      await proxy.close();
    }
  }));

  test('KV-only /api/ps size (weights excluded, as on Ollama 0.40): measurements are diagnosed as unusable', () => withFakes(['ollama'], async (fakes) => {
    pinPsToTotalFootprint(fakes.ollama);
    const proxy = await deviant(fakes.ollama.url, {
      transform(r, status, text) {
        if (r.path !== '/api/ps') return text;
        const j = JSON.parse(text);
        for (const m of j.models) { m.size = 64 * 1024 ** 2 + 50000 * (m.context_length || 2048); m.size_vram = m.size; }
        return JSON.stringify(j);
      },
    });
    try {
      const q = quiet();
      const { result } = await runLiveCheck(['--no-detect', '--ollama-url', proxy.url, '--only', 'ollama', '--no-color'], q);
      await keep('deviant-ollama-kv-only-ps', q);
      const s = (id) => byId(result, id);
      assert.equal(s('ollama.ps.shape').status, 'WARN');
      assert.match(s('ollama.ps.shape').detail, /does not include the weights/);
      assert.equal(s('ollama.ps.size_grows_with_num_ctx').status, 'PASS');
      if (harnessAssumes('measureTotal')) {
        assert.equal(s('ollama.ps.measurement_fit').status, 'FAIL');
        assert.match(s('ollama.ps.measurement_fit').detail, /does not include the weights .* rejects every sample/);
        assert.match(s('ollama.ps.measurement_fit').fix, /MeasurementStore\.measure/);
      } else {
        // Harness records model file + ps size (or the runner RSS on macOS), which fits the estimate.
        assert.equal(s('ollama.ps.measurement_fit').status, 'PASS', s('ollama.ps.measurement_fit').detail);
      }
    } finally {
      await proxy.close();
    }
  }));

  test('deviant A1111: options 404, minimum size 128, grid first without index_of_first_image → WARN; grid last → FAIL', () => withFakes(['a1111'], async (fakes) => {
    const savedPoll = A1111Provider.pollMs;
    A1111Provider.pollMs = 20;
    const reshape = (mode) => (r, status, text) => {
      if (!/\/sdapi\/v1\/(txt2img|img2img)$/.test(r.path) || status !== 200) return text;
      const j = JSON.parse(text);
      const info = JSON.parse(j.info);
      if (j.images.length > 1) {
        delete info.index_of_first_image;
        if (mode === 'grid-last') j.images.push(j.images.shift());
      }
      j.info = JSON.stringify(info);
      return JSON.stringify(j);
    };
    const tooSmall = (r) => (r.method === 'POST' && /txt2img|img2img/.test(r.path) && r.body?.width < 128 ? { status: 422, json: { detail: [{ loc: ['body', 'width'], msg: 'ensure this value is greater than or equal to 128' }] } } : null);
    const devA = await deviant(fakes.a1111.url, { rules: (r) => (r.path === '/sdapi/v1/options' && r.method === 'GET' ? { status: 404, json: { detail: 'Not Found' } } : tooSmall(r)), transform: reshape('grid-first') });
    const devB = await deviant(fakes.a1111.url, { rules: tooSmall, transform: reshape('grid-last') });
    try {
      const qa = quiet();
      const qb = quiet();
      const [a, b] = await Promise.all([[devA, qa], [devB, qb]].map(([d, q]) => runLiveCheck(['--no-detect', '--a1111-url', d.url, '--only', 'a1111', '--allow-images', '--no-color'], q)));
      await keep('deviant-a1111-grid-first', qa);
      await keep('deviant-a1111-grid-last', qb);
      const sa = (id) => byId(a.result, id);
      assert.equal(sa('a1111.options').status, 'WARN');
      assert.match(sa('a1111.options').detail, /404/);
      assert.match(sa('a1111.options').fix, /unknown/);
      assert.equal(sa('a1111.detect_fallbacks').status, 'PASS');
      assert.match(sa('a1111.txt2img.min_size').detail, /128×128/);
      assert.ok(sa('a1111.txt2img.min_size').info.some((l) => /64×64: failed/.test(l)));
      assert.equal(sa('a1111.txt2img.count2').status, 'WARN');
      assert.match(sa('a1111.txt2img.count2').detail, /without info\.index_of_first_image.*fallback/);
      assert.equal(a.exitCode, 0);
      const cb = byId(b.result, 'a1111.txt2img.count2');
      assert.equal(cb.status, 'FAIL');
      assert.match(cb.detail, /kept the contact-sheet grid/);
      assert.ok(cb.source.some((s) => /server\/image\/a1111\.mjs:\d+ \(A1111Provider\.generate \(grid handling\)\)/.test(s)));
      assert.equal(b.exitCode, 1);
    } finally {
      A1111Provider.pollMs = savedPoll;
      await Promise.all([devA.close(), devB.close()]);
    }
  }));

  test('deviant OpenAI-compatible server: no usage/timings, reasoning in an unknown field', () => withFakes(['openai'], async (fakes) => {
    const proxy = await deviant(fakes.openai.url, {
      transform(r, status, text) {
        if (r.path !== '/v1/chat/completions' || status !== 200) return text;
        return text.split('\n').map((l) => {
          if (!l.startsWith('data: {')) return l;
          const j = JSON.parse(l.slice(6));
          delete j.usage;
          delete j.timings;
          const d = j.choices?.[0]?.delta;
          if (d?.reasoning_content) { d.thinking = d.reasoning_content; delete d.reasoning_content; }
          return `data: ${JSON.stringify(j)}`;
        }).join('\n');
      },
    });
    try {
      const q = quiet();
      const { exitCode, result } = await runLiveCheck(['--no-detect', '--llamacpp-url', proxy.url, '--only', 'openai', '--openai-think-model', 'fake-reasoner', '--no-color'], q);
      await keep('deviant-openai', q);
      assert.equal(byId(result, 'openai.llamacpp.chat.usage').status, 'FAIL');
      assert.match(byId(result, 'openai.llamacpp.chat.usage').detail, /no prompt token count/);
      assert.equal(byId(result, 'openai.llamacpp.chat.reasoning').status, 'FAIL');
      assert.match(byId(result, 'openai.llamacpp.chat.reasoning').detail, /delta\.thinking/);
      assert.equal(byId(result, 'openai.llamacpp.chat.stream').status, 'PASS');
      assert.equal(exitCode, 1);
    } finally {
      await proxy.close();
    }
  }));

  test('default run is safe: without --allow-pull / --allow-images nothing is pulled or generated and the skips say what is needed', () => withFakes(['a1111', 'ollama'], async (fakes) => {
    const { result } = await runLiveCheck(['--no-detect', '--a1111-url', fakes.a1111.url, '--ollama-url', fakes.ollama.url, '--only', 'a1111,ollama', '--no-color'], quiet());
    assert.deepEqual(fakes.a1111.requests.filter((r) => r.method === 'POST'), [], 'a default run must not POST to the image backend');
    assert.deepEqual(fakes.ollama.requests.filter((r) => ['/api/pull', '/api/delete'].includes(r.path) && !/livecheck-no-such-model/.test(r.body?.model)), [], 'a default run must not pull or delete real models');
    const sk = byId(result, 'a1111.txt2img.count2');
    assert.equal(sk.status, 'SKIP');
    assert.match(sk.need, /--allow-images/);
    assert.match(byId(result, 'ollama.pull.new').need, /--allow-pull/);
  }));
});

test('exit code 2 when no backend is reachable', async () => {
  const { code, out } = await runCli(['--no-detect', '--ollama-url', 'http://127.0.0.1:1', '--a1111-url', 'http://127.0.0.1:1'], { timeoutMs: 30000 });
  assert.equal(code, 2, out);
  assert.match(out, /No backend is reachable/);
});

test('redaction, option parsing, catalog and source anchors', () => {
  const home = os.homedir();
  const r = redact(`path ${home}/models/x.gguf /Users/alice/Library/x Authorization: Bearer abcdefghijklmnop "api_key":"sk-1234567890abcdefXYZ" hf_abcdefghijklmnopqrstu`);
  assert.ok(!r.includes(home) || home === '/', r);
  assert.ok(!r.includes('alice'), r);
  assert.ok(!r.includes('abcdefghijklmnop'), r);
  assert.ok(!r.includes('sk-1234567890'), r);
  assert.ok(!r.includes('hf_abcdefghijklmnopqrstu'), r);
  assert.match(redact('sha256:0123456789abcdef0123456789abcdef'), /sha256:0123456789abcdef/, 'digests are not secrets');
  assert.deepEqual(parseOptions(['--bogus']).errors, ['unknown option --bogus']);
  assert.deepEqual(parseOptions(['--only', 'ollama,nope']).errors, ['unknown group "nope" (groups: env, ollama, openai, a1111, comfyui, openai-images, e2e)']);
  const o = parseOptions(['--timeout-scale=2.5', '--allow-images', '--openai-url', 'http://a', '--openai-url', 'http://b']);
  assert.equal(o.timeoutScale, 2.5);
  assert.equal(o.allowImages, true);
  assert.equal(o.allowPull, false, 'pulls are off by default');
  assert.deepEqual(o.openaiUrls, ['http://a', 'http://b']);
  assert.ok(CATALOG.size > 100);
  for (const c of CATALOG.values()) {
    assert.ok(['env', 'raw', 'e2e'].includes(c.layer), c.id);
    for (const ref of sourceRefs(c.src)) assert.match(ref, /^server\/\S+\.mjs/, `${c.id}: ${ref}`);
  }
});
