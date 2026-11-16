// ComfyUI backend: queue an API-format workflow (built-in template or user-supplied with {{placeholders}}),
// track progress over the /ws WebSocket when available, poll /history, fetch outputs from /view.
import crypto from 'node:crypto';
import { egressBlocked } from '../security/egress.mjs';
import { imageJson, imageRequest, sniffImageMime, formatNodeErrors } from './http.mjs';
import { ProviderError } from '../lib/errors.mjs';
import { sleep } from '../lib/util.mjs';

export const DEFAULT_TXT2IMG_WORKFLOW = {
  3: { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: '{{steps}}', cfg: '{{cfg}}', sampler_name: '{{sampler}}', scheduler: '{{scheduler}}', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{model}}' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: '{{negative_prompt}}', clip: ['4', 1] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'harness', images: ['8', 0] } },
};

export const DEFAULT_IMG2IMG_WORKFLOW = {
  3: { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: '{{steps}}', cfg: '{{cfg}}', sampler_name: '{{sampler}}', scheduler: '{{scheduler}}', denoise: '{{denoise}}', model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['11', 0] } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{model}}' } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: '{{negative_prompt}}', clip: ['4', 1] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'harness', images: ['8', 0] } },
  10: { class_type: 'LoadImage', inputs: { image: '{{image}}' } },
  11: { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } },
};

const NUMERIC = new Set(['seed', 'steps', 'cfg', 'width', 'height', 'count', 'denoise']);

/** Replace "{{name}}" placeholders. Whole-string numeric placeholders become numbers. */
export function fillWorkflow(workflow, values) {
  const walk = (v) => {
    if (typeof v === 'string') {
      const whole = v.match(/^\{\{\s*(\w+)\s*\}\}$/);
      if (whole && whole[1] in values) {
        const x = values[whole[1]];
        return NUMERIC.has(whole[1]) ? Number(x) : x;
      }
      return v.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in values ? String(values[k]) : m));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(workflow);
}

function comboOptions(spec) {
  // Classic: [[...options], {...}]  Newer: ["COMBO", {options:[...]}]
  if (Array.isArray(spec?.[0])) return spec[0];
  if (spec?.[0] === 'COMBO' && Array.isArray(spec?.[1]?.options)) return spec[1].options;
  return [];
}

function multipart(fields, file) {
  const boundary = `----harness${crypto.randomBytes(8).toString('hex')}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`));
  parts.push(file.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export class ComfyUIProvider {
  constructor({ id, name, baseUrl, apiKey = '', builtin = false, workflow = null, getWorkflow = null }) {
    this.id = id;
    this.kind = 'comfyui';
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.builtin = builtin;
    this.workflow = workflow;
    this.getWorkflow = getWorkflow;
    this.capabilities = { img2img: true, progress: true, models: true, negativePrompt: true, seed: true, steps: true, cfg: true, sampler: true };
  }

  async status() {
    try {
      const j = await imageJson(this, '/system_stats', { timeoutMs: 1500 });
      return { ok: true, version: j?.system?.comfyui_version || null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async listModels() {
    const j = await imageJson(this, '/object_info/CheckpointLoaderSimple', { timeoutMs: 5000 });
    const opts = comboOptions(j?.CheckpointLoaderSimple?.input?.required?.ckpt_name);
    return opts.map((x) => ({ id: x, name: x, current: false }));
  }

  async interrupt(promptId) {
    await imageRequest(this, '/interrupt', { method: 'POST', body: {}, timeoutMs: 3000 }).catch(() => {});
    if (promptId) await imageRequest(this, '/queue', { method: 'POST', body: { delete: [promptId] }, timeoutMs: 3000 }).catch(() => {});
  }

  async upload(initImage) {
    const ext = initImage.mime === 'image/jpeg' ? 'jpg' : initImage.mime === 'image/webp' ? 'webp' : 'png';
    const mp = multipart({ overwrite: 'true', type: 'input' }, { name: `harness-${crypto.randomBytes(4).toString('hex')}.${ext}`, mime: initImage.mime, buffer: initImage.buffer });
    const res = await imageRequest(this, '/upload/image', { method: 'POST', rawBody: mp.body, headers: { 'content-type': mp.contentType }, timeoutMs: 60000 });
    const j = await res.json();
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }

  openProgressSocket(clientId, onProgress) {
    if (typeof WebSocket !== 'function') return null;
    try {
      const wsUrl = this.baseUrl.replace(/^http/, 'ws') + `/ws?clientId=${clientId}`;
      if (egressBlocked(wsUrl)) return null; // progress only; the job itself is refused with offline_lock
      const ws = new WebSocket(wsUrl);
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return; // binary preview frames
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'progress' && m.data?.max) onProgress?.({ progress: Math.min(0.99, m.data.value / m.data.max), step: m.data.value, steps: m.data.max, etaSeconds: null });
        } catch { /* ignore */ }
      };
      ws.onerror = () => {};
      return ws;
    } catch {
      return null;
    }
  }

  /**
   * One queued prompt per image (batch size 1, seed + i), like the A1111 path: a parallel batch multiplies peak
   * memory, which an 8 GB Mac cannot afford. `{{count}}` in a custom workflow is therefore always 1.
   */
  async generate(p, { signal, onProgress } = {}) {
    let model = p.model;
    const custom = this.getWorkflow?.() || this.workflow;
    if (!model && !custom) {
      const models = await this.listModels().catch(() => []);
      model = models[0]?.id;
      if (!model) throw new ProviderError(`${this.name}: no checkpoints found (put a model in ComfyUI/models/checkpoints)`, { status: 400, code: 'no_image_model', providerId: this.id });
    }
    let image = '';
    if (p.initImage) image = await this.upload(p.initImage);
    const template = custom || (p.initImage ? DEFAULT_IMG2IMG_WORKFLOW : DEFAULT_TXT2IMG_WORKFLOW);
    const count = Math.max(1, p.count || 1);
    const clientId = crypto.randomUUID();
    let current = 0;
    const ws = this.openProgressSocket(clientId, (pr) => onProgress?.({ ...pr, progress: Math.min(0.99, (current + pr.progress) / count), image: current + 1, images: count }));
    let promptId = null;
    const onAbort = () => { this.interrupt(promptId); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const images = [];
    const seeds = [];
    try {
      for (current = 0; current < count; current++) {
        const seed = p.seed + current;
        const workflow = fillWorkflow(template, {
          prompt: p.prompt, negative_prompt: p.negativePrompt || '', seed, steps: p.steps, cfg: p.cfg, width: p.width, height: p.height,
          count: 1, denoise: p.denoise ?? 0.6, model: model || '', sampler: p.sampler || p.comfy?.sampler || 'euler', scheduler: p.scheduler || p.comfy?.scheduler || 'normal', image,
        });
        const q = await imageJson(this, '/prompt', { method: 'POST', body: { prompt: workflow, client_id: clientId }, signal, timeoutMs: 30000 });
        if (q.node_errors && Object.keys(q.node_errors).length) throw Object.assign(new ProviderError(`${this.name}: workflow error: ${formatNodeErrors(q.node_errors)}`, { status: 400, code: 'workflow_invalid', providerId: this.id }), { nodeErrors: q.node_errors });
        promptId = q.prompt_id;
        if (!promptId) throw new ProviderError(`${this.name}: no prompt_id returned`, { providerId: this.id });
        let entry = null;
        for (;;) {
          if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
          const h = await imageJson(this, `/history/${encodeURIComponent(promptId)}`, { signal, timeoutMs: 10000 });
          entry = h?.[promptId];
          if (entry?.status?.status_str === 'error') {
            const msg = entry.status.messages?.find((m) => m[0] === 'execution_error')?.[1]?.exception_message;
            throw new ProviderError(`${this.name}: generation failed${msg ? `: ${msg}` : ''}`, { providerId: this.id });
          }
          if (entry && (entry.status?.completed || Object.keys(entry.outputs || {}).length)) break;
          await sleep(400, signal);
        }
        const files = [];
        for (const out of Object.values(entry.outputs || {})) for (const img of out.images || []) if (img.type !== 'temp') files.push(img);
        if (!files.length) for (const out of Object.values(entry.outputs || {})) for (const img of out.images || []) files.push(img);
        if (!files.length) throw new ProviderError(`${this.name} produced no images (does the workflow end in a SaveImage node?)`, { providerId: this.id });
        // one image per prompt (a custom workflow with a larger batch still yields `count` images in total)
        const f = files[0];
        const qs = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' });
        const res = await imageRequest(this, `/view?${qs}`, { signal, timeoutMs: 60000 });
        const buffer = await res.buffer();
        images.push({ buffer, mime: sniffImageMime(buffer) });
        seeds.push(seed);
        promptId = null;
      }
      return { images, seeds, model };
    } catch (e) {
      if (!signal?.aborted) this.interrupt(promptId);
      throw e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      try { ws?.close(); } catch { /* ignore */ }
    }
  }
}
