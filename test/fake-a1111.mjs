#!/usr/bin/env node
// Fake AUTOMATIC1111-compatible image API (what Draw Things' HTTP API server, A1111 and Forge speak).
//   node test/fake-a1111.mjs --port 7860 [--step 150] [--drawthings true]
// Implements: GET /sdapi/v1/options, /sdapi/v1/sd-models, /sdapi/v1/samplers, /sdapi/v1/progress;
// POST /sdapi/v1/txt2img, /sdapi/v1/img2img, /sdapi/v1/interrupt, /sdapi/v1/options.
// `drawThings: true` hides sd-models/progress/samplers (404) to mimic a minimal API surface.
import http from 'node:http';
import { readBody, sendJson, sleep, parseArgs, isCli } from './fake-model.mjs';
import { makePng } from './png.mjs';

export async function startFakeA1111({ port = 0, host = '127.0.0.1', stepMs = 5, drawThings = false } = {}) {
  const fake = {
    requests: [],
    interrupts: 0,
    current: { model: 'sd_turbo.safetensors [a1b2c3]' },
    state: { active: false, step: 0, steps: 0, interrupted: false },
    stepMs,
  };
  const models = [
    { title: 'sd_turbo.safetensors [a1b2c3]', model_name: 'sd_turbo', hash: 'a1b2c3', filename: '/models/sd_turbo.safetensors' },
    { title: 'sdxl_base_1.0.safetensors [d4e5f6]', model_name: 'sdxl_base_1.0', hash: 'd4e5f6', filename: '/models/sdxl_base_1.0.safetensors' },
  ];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const raw = await readBody(req);
    let body = {};
    if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJson(res, 422, { detail: 'invalid JSON' }); } }
    fake.requests.push({ method: req.method, path: url.pathname, body });
    const p = url.pathname;
    if (req.method === 'GET' && p === '/sdapi/v1/options') return sendJson(res, 200, drawThings ? { model: fake.current.model } : { sd_model_checkpoint: fake.current.model, samples_format: 'png' });
    if (req.method === 'POST' && p === '/sdapi/v1/options') { if (body.sd_model_checkpoint) fake.current.model = body.sd_model_checkpoint; return sendJson(res, 200, null); }
    if (!drawThings && req.method === 'GET' && p === '/sdapi/v1/sd-models') return sendJson(res, 200, models);
    if (!drawThings && req.method === 'GET' && p === '/sdapi/v1/samplers') return sendJson(res, 200, [{ name: 'Euler a', aliases: ['k_euler_a'] }, { name: 'DPM++ 2M', aliases: [] }]);
    if (!drawThings && req.method === 'GET' && p === '/sdapi/v1/progress') {
      const s = fake.state;
      return sendJson(res, 200, { progress: s.active && s.steps ? s.step / s.steps : 0, eta_relative: s.active ? ((s.steps - s.step) * fake.stepMs) / 1000 : 0, state: { sampling_step: s.step, sampling_steps: s.steps, interrupted: s.interrupted, job_count: s.active ? 1 : 0 }, current_image: null });
    }
    if (req.method === 'POST' && p === '/sdapi/v1/interrupt') { fake.interrupts++; fake.state.interrupted = true; return sendJson(res, 200, null); }
    if (req.method === 'GET' && (p === '/sdapi/v1/txt2img' || p === '/sdapi/v1/img2img')) return sendJson(res, 405, { detail: 'Method Not Allowed' });
    if (req.method === 'POST' && (p === '/sdapi/v1/txt2img' || p === '/sdapi/v1/img2img')) {
      if (!body.prompt) return sendJson(res, 422, { detail: [{ loc: ['body', 'prompt'], msg: 'field required' }] });
      if (p.endsWith('img2img') && !body.init_images?.length) return sendJson(res, 422, { detail: 'init_images required' });
      const steps = body.steps || 20;
      // Real A1111: images = batch_size x n_iter, and with more than one image a grid is returned first.
      // Real Draw Things: images = batch_size x batch_count, no grid.
      const n = (body.batch_size || 1) * ((drawThings ? body.batch_count : body.n_iter) || 1);
      const seed = Number.isFinite(body.seed) && body.seed >= 0 ? body.seed : 1234;
      fake.state = { active: true, step: 0, steps, interrupted: false };
      for (let i = 1; i <= steps; i++) {
        if (fake.state.interrupted) break;
        await sleep(fake.stepMs);
        fake.state.step = i;
      }
      fake.state.active = false;
      const model = body.override_settings?.sd_model_checkpoint || body.model || fake.current.model;
      const imgs = Array.from({ length: n }, (_, i) => makePng(body.width || 512, body.height || 512, seed + i).toString('base64'));
      const grid = !drawThings && n > 1;
      const info = { prompt: body.prompt, seed, all_seeds: imgs.map((_, i) => seed + i), sd_model_name: model, steps, cfg_scale: body.cfg_scale, width: body.width, height: body.height };
      if (!drawThings) info.index_of_first_image = grid ? 1 : 0;
      fake.lastBody = body;
      if (grid) imgs.unshift(makePng(64, 64, 999999).toString('base64'));
      return sendJson(res, 200, { images: imgs, parameters: body, info: JSON.stringify(info) });
    }
    sendJson(res, 404, { detail: 'Not Found' });
  });
  await new Promise((r) => server.listen(port, host, r));
  fake.port = server.address().port;
  fake.url = `http://${host}:${fake.port}`;
  fake.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return fake;
}

if (isCli(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  const fake = await startFakeA1111({ port: Number(a.port || 7860), stepMs: Number(a.step ?? 150), drawThings: a.drawthings === 'true' });
  console.log(`fake A1111/Draw Things API listening on ${fake.url}`);
}
