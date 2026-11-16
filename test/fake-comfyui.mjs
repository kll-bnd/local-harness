#!/usr/bin/env node
// Fake ComfyUI server.
//   node test/fake-comfyui.mjs --port 8188 [--step 150]
// Implements: GET /system_stats, /object_info/CheckpointLoaderSimple, /history/{id}, /view, /queue;
// POST /prompt, /upload/image (multipart), /interrupt, /queue; WebSocket /ws?clientId= with
// "progress" / "executing" messages.
import http from 'node:http';
import crypto from 'node:crypto';
import { readBody, sendJson, sleep, parseArgs, isCli } from './fake-model.mjs';
import { makePng } from './png.mjs';

function wsFrame(text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([header, payload]);
}

export async function startFakeComfyUI({ port = 0, host = '127.0.0.1', stepMs = 5, checkpoints = ['sd15_dreamshaper_8.safetensors', 'sdxl_lightning_4step.safetensors'] } = {}) {
  const fake = { requests: [], prompts: [], interrupts: 0, uploads: [], history: {}, clients: new Map(), stepMs, outputs: new Map() };
  const send = (clientId, obj) => {
    const s = fake.clients.get(clientId);
    if (s && !s.destroyed) s.write(wsFrame(JSON.stringify(obj)));
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const raw = await readBody(req);
    const ct = req.headers['content-type'] || '';
    let body = {};
    if (raw.length && ct.includes('json')) { try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJson(res, 400, { error: 'bad json' }); } }
    fake.requests.push({ method: req.method, path: url.pathname, body: ct.includes('json') ? body : null });
    const p = url.pathname;
    if (req.method === 'GET' && p === '/system_stats') return sendJson(res, 200, { system: { os: 'posix', comfyui_version: '0.3.60-fake', python_version: '3.12', ram_total: 8 * 1024 ** 3, ram_free: 4 * 1024 ** 3 }, devices: [{ name: 'mps', type: 'mps', index: 0, vram_total: 8 * 1024 ** 3, vram_free: 4 * 1024 ** 3 }] });
    if (req.method === 'GET' && p === '/object_info/CheckpointLoaderSimple') return sendJson(res, 200, { CheckpointLoaderSimple: { input: { required: { ckpt_name: [checkpoints, {}] } }, output: ['MODEL', 'CLIP', 'VAE'], name: 'CheckpointLoaderSimple' } });
    if (req.method === 'GET' && p === '/queue') return sendJson(res, 200, { queue_running: [], queue_pending: [] });
    if (req.method === 'POST' && p === '/queue') { for (const id of body.delete || []) delete fake.history[id]; return sendJson(res, 200, {}); }
    if (req.method === 'POST' && p === '/interrupt') { fake.interrupts++; fake.interrupted = true; return sendJson(res, 200, {}); }
    if (req.method === 'POST' && p === '/upload/image') {
      const s = raw.toString('latin1');
      const name = (s.match(/filename="([^"]+)"/) || [])[1] || 'upload.png';
      fake.uploads.push(name);
      return sendJson(res, 200, { name, subfolder: '', type: 'input' });
    }
    if (req.method === 'GET' && p.startsWith('/history/')) {
      const id = decodeURIComponent(p.slice('/history/'.length));
      return sendJson(res, 200, fake.history[id] ? { [id]: fake.history[id] } : {});
    }
    if (req.method === 'GET' && p === '/view') {
      const png = fake.outputs.get(url.searchParams.get('filename'));
      if (!png) return sendJson(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
      return res.end(png);
    }
    if (req.method === 'POST' && p === '/prompt') {
      const wf = body.prompt || {};
      const nodes = Object.entries(wf);
      const sampler = nodes.find(([, n]) => n.class_type === 'KSampler');
      const save = nodes.find(([, n]) => n.class_type === 'SaveImage');
      if (!sampler || !save) return sendJson(res, 400, { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { missing: 'SaveImage/KSampler' } });
      const ckpt = nodes.find(([, n]) => n.class_type === 'CheckpointLoaderSimple')?.[1].inputs.ckpt_name;
      if (ckpt !== undefined && !checkpoints.includes(ckpt)) return sendJson(res, 400, { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { 4: { errors: [{ message: `Value not in list: ckpt_name: '${ckpt}'` }] } } });
      const promptId = crypto.randomUUID();
      fake.prompts.push({ promptId, workflow: wf, clientId: body.client_id });
      const steps = Number(sampler[1].inputs.steps) || 20;
      const seed = Number(sampler[1].inputs.seed) || 0;
      const latent = nodes.find(([, n]) => n.class_type === 'EmptyLatentImage')?.[1].inputs || { width: 512, height: 512, batch_size: 1 };
      fake.interrupted = false;
      (async () => {
        send(body.client_id, { type: 'execution_start', data: { prompt_id: promptId } });
        for (let i = 1; i <= steps; i++) {
          if (fake.interrupted) break;
          await sleep(fake.stepMs);
          send(body.client_id, { type: 'progress', data: { value: i, max: steps, prompt_id: promptId, node: sampler[0] } });
        }
        if (fake.interrupted) {
          fake.history[promptId] = { prompt: [], outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_interrupted', { prompt_id: promptId }]] } };
          return;
        }
        const images = [];
        for (let b = 0; b < (Number(latent.batch_size) || 1); b++) {
          const filename = `harness_${String(fake.outputs.size + 1).padStart(5, '0')}_.png`;
          fake.outputs.set(filename, makePng(Number(latent.width) || 512, Number(latent.height) || 512, seed + b));
          images.push({ filename, subfolder: '', type: 'output' });
        }
        fake.history[promptId] = { prompt: [0, promptId, wf, {}, [save[0]]], outputs: { [save[0]]: { images } }, status: { status_str: 'success', completed: true, messages: [] } };
        send(body.client_id, { type: 'executing', data: { node: null, prompt_id: promptId } });
      })();
      return sendJson(res, 200, { prompt_id: promptId, number: fake.prompts.length, node_errors: {} });
    }
    sendJson(res, 404, { error: 'not found' });
  });
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const clientId = url.searchParams.get('clientId') || crypto.randomUUID();
    fake.clients.set(clientId, socket);
    socket.on('data', (d) => { if ((d[0] & 0x0f) === 8) { try { socket.end(Buffer.from([0x88, 0])); } catch { /* ignore */ } } });
    socket.on('error', () => {});
    socket.on('close', () => fake.clients.delete(clientId));
    socket.write(wsFrame(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } }, sid: clientId } })));
  });
  await new Promise((r) => server.listen(port, host, r));
  fake.port = server.address().port;
  fake.url = `http://${host}:${fake.port}`;
  fake.close = () => new Promise((r) => { for (const s of fake.clients.values()) s.destroy(); server.closeAllConnections?.(); server.close(() => r()); });
  return fake;
}

if (isCli(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  const fake = await startFakeComfyUI({ port: Number(a.port || 8188), stepMs: Number(a.step ?? 150) });
  console.log(`fake ComfyUI listening on ${fake.url}`);
}
