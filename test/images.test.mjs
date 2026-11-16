// Local image generation: providers (A1111/Draw Things, ComfyUI, OpenAI-images), direct generation,
// gallery, chat-linked generation, generate_image tool through the chat stream, abort, img2img,
// RAM coordination (unload chat model on 8 GB, lazy reload), background-task gating, feedback to vision models.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, newChat, send, byType, text, waitFor } from './helpers.mjs';
import { startFakeA1111 } from './fake-a1111.mjs';
import { startFakeComfyUI } from './fake-comfyui.mjs';
import { startFakeOpenAI } from './fake-openai.mjs';
import { A1111Provider } from '../server/image/a1111.mjs';
import { makePng } from './png.mjs';

A1111Provider.pollMs = 20;
const GiB = 1024 ** 3;

async function startImageFakes() {
  const a1111 = await startFakeA1111({ port: 0, stepMs: 4 });
  const comfy = await startFakeComfyUI({ port: 0, stepMs: 4 });
  const oai = await startFakeOpenAI({ port: 0 });
  const providers = [
    { id: 'dt', name: 'Draw Things (fake)', kind: 'a1111', baseUrl: a1111.url, enabled: true },
    { id: 'comfy', name: 'ComfyUI (fake)', kind: 'comfyui', baseUrl: comfy.url, enabled: true },
    { id: 'oai', name: 'Images API (fake)', kind: 'openai', baseUrl: oai.url, enabled: true },
  ];
  return { a1111, comfy, oai, providers, close: () => Promise.all([a1111.close(), comfy.close(), oai.close()]) };
}

describe('image generation (16 GB machine)', () => {
  let h;
  let f;
  before(async () => {
    f = await startImageFakes();
    h = await setup({ system: { totalMem: 16 * GiB, platform: 'darwin', arch: 'arm64' }, settings: { image: { custom: f.providers }, memory: { enabled: false }, titles: { auto: false } } });
  });
  after(async () => { await h.close(); await f.close(); });

  test('providers + models are listed for all three backends', async () => {
    const ps = (await h.c.get('/api/images/providers')).data.providers;
    assert.deepEqual(ps.map((p) => [p.id, p.status]).sort(), [['comfy', 'running'], ['dt', 'running'], ['oai', 'running']]);
    assert.equal(ps.find((p) => p.id === 'dt').currentModel, 'sd_turbo.safetensors [a1b2c3]');
    assert.equal((await h.c.get('/api/images/models?providerId=dt')).data.models.length, 2);
    assert.deepEqual((await h.c.get('/api/images/models?providerId=comfy')).data.models.map((m) => m.id), ['sd15_dreamshaper_8.safetensors', 'sdxl_lightning_4step.safetensors']);
    assert.ok((await h.c.get('/api/images/models?providerId=oai')).data.models.length > 0);
    const sys = (await h.c.get('/api/system')).data;
    assert.equal(sys.imageProviders.length, 3);
  });

  test('A1111 / Draw Things: SSE progress, family defaults (turbo → few steps), gallery storage', async () => {
    f.a1111.stepMs = 15;
    const r = await h.c.sse('/api/images/generate', { providerId: 'dt', prompt: 'a lighthouse at dusk, oil painting', seed: 1234, negativePrompt: 'blurry' });
    f.a1111.stepMs = 4;
    const types = r.events.map((e) => e.type);
    assert.equal(types[0], 'image_job');
    assert.ok(byType(r.events, 'image_status').some((s) => s.phase === 'generating'));
    const img = byType(r.events, 'image')[0].image;
    assert.equal(types.at(-1), 'done');
    const done = byType(r.events, 'done')[0];
    assert.equal(done.job.status, 'done');
    assert.equal(done.job.params.steps, 2, 'sd_turbo current model → 2 steps');
    assert.equal(done.job.params.cfg, 1);
    assert.equal(img.seed, 1234);
    assert.equal(img.prompt, 'a lighthouse at dusk, oil painting');
    assert.equal(img.width, 512);
    const req = f.a1111.requests.find((x) => x.path === '/sdapi/v1/txt2img').body;
    assert.equal(req.negative_prompt, 'blurry');
    assert.equal(req.seed, 1234);
    assert.equal(req.cfg_scale, 1);
    const file = await fetch(h.url + img.url);
    assert.equal(file.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await file.arrayBuffer());
    assert.equal(buf.readUInt32BE(16), 512);
    const one = (await h.c.get(`/api/images/${img.id}`)).data.image;
    assert.equal(one.providerId, 'dt');
    // progress polling worked when the job took long enough
    const r2 = await h.c.sse('/api/images/generate', { providerId: 'dt', prompt: 'slow one', steps: 25, model: 'sdxl_base_1.0.safetensors [d4e5f6]' });
    assert.ok(byType(r2.events, 'done')[0]);
    assert.equal(f.a1111.requests.filter((x) => x.path === '/sdapi/v1/txt2img').at(-1).body.override_settings.sd_model_checkpoint, 'sdxl_base_1.0.safetensors [d4e5f6]');
    assert.equal(byType(r2.events, 'done')[0].job.params.width, 1024, 'SDXL base size on 16 GB');
  });

  test('A1111 progress events while sampling', async () => {
    f.a1111.stepMs = 20;
    const r = await h.c.sse('/api/images/generate', { providerId: 'dt', prompt: 'progress please', steps: 20 });
    f.a1111.stepMs = 4;
    const prog = byType(r.events, 'image_progress');
    assert.ok(prog.length >= 2, `progress events: ${prog.length}`);
    assert.ok(prog.every((p) => p.progress > 0 && p.progress < 1 && p.steps === 20));
  });

  test('ComfyUI: default workflow, WebSocket progress, first checkpoint, family defaults', async () => {
    const r = await h.c.sse('/api/images/generate', { providerId: 'comfy', prompt: 'a cozy cabin in the woods', seed: 77, aspect: 'landscape' });
    assert.ok(byType(r.events, 'done')[0], JSON.stringify(byType(r.events, 'error')));
    const prog = byType(r.events, 'image_progress');
    assert.ok(prog.length >= 2, `ws progress events ${prog.length}`);
    const wf = f.comfy.prompts.at(-1).workflow;
    assert.equal(wf[3].inputs.seed, 77);
    assert.equal(wf[4].inputs.ckpt_name, 'sd15_dreamshaper_8.safetensors');
    assert.equal(wf[6].inputs.text, 'a cozy cabin in the woods');
    const job = byType(r.events, 'done')[0].job;
    assert.equal(job.family.id, 'sd15', 'no model specified → first checkpoint decides the family');
    assert.equal(job.params.steps, 25);
    assert.deepEqual([job.params.width, job.params.height], [576, 384], 'landscape at SD1.5 base 512');
    const r2 = await h.c.sse('/api/images/generate', { providerId: 'comfy', prompt: 'fast', model: 'sdxl_lightning_4step.safetensors' });
    const j2 = byType(r2.events, 'done')[0].job;
    assert.equal(j2.params.steps, 6);
    assert.equal(f.comfy.prompts.at(-1).workflow[3].inputs.scheduler, 'sgm_uniform');
    // user-supplied workflow with placeholders
    await h.c.patch('/api/settings', { image: { comfyWorkflow: { 1: { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: '{{steps}}' } }, 2: { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 } }, 3: { class_type: 'SaveImage', inputs: { filename_prefix: 'custom: {{prompt}}' } } } } });
    const r3 = await h.c.sse('/api/images/generate', { providerId: 'comfy', prompt: 'custom flow', seed: 5, width: 256, height: 256 });
    assert.ok(byType(r3.events, 'done')[0], JSON.stringify(byType(r3.events, 'error')));
    const cw = f.comfy.prompts.at(-1).workflow;
    assert.equal(cw[1].inputs.seed, 5);
    assert.equal(cw[3].inputs.filename_prefix, 'custom: custom flow');
    await h.c.patch('/api/settings', { image: { comfyWorkflow: null } });
  });

  test('OpenAI-compatible images (non-streaming JSON)', async () => {
    const r = await h.c.post('/api/images/generate', { providerId: 'oai', prompt: 'a blue square', stream: false, width: 256, height: 256, count: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.data.images.length, 2);
    const req = f.oai.requests.find((x) => x.path === '/v1/images/generations').body;
    assert.equal(req.size, '256x256');
    assert.equal(req.response_format, 'b64_json');
    assert.equal(req.n, 2);
  });

  test('img2img from an attachment (A1111 + ComfyUI upload)', async () => {
    const png = makePng(64, 64, 9);
    const up = await (await fetch(`${h.url}/api/attachments?name=init.png`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png })).json();
    const r = await h.c.sse('/api/images/generate', { providerId: 'dt', prompt: 'make it snowy', initImage: { attachmentId: up.attachment.id }, denoise: 0.4 });
    assert.ok(byType(r.events, 'done')[0]);
    const req = f.a1111.requests.find((x) => x.path === '/sdapi/v1/img2img').body;
    assert.equal(req.init_images[0], png.toString('base64'));
    assert.equal(req.denoising_strength, 0.4);
    const img = byType(r.events, 'image')[0].image;
    assert.deepEqual(img.initImage, { kind: 'attachment', id: up.attachment.id });
    const r2 = await h.c.sse('/api/images/generate', { providerId: 'comfy', prompt: 'variation', initImage: { imageId: img.id } });
    assert.ok(byType(r2.events, 'done')[0], JSON.stringify(byType(r2.events, 'error')));
    assert.equal(f.comfy.uploads.length, 1);
    assert.equal(f.comfy.prompts.at(-1).workflow[10].class_type, 'LoadImage');
  });

  test('gallery: list/filter/delete', async () => {
    const all = (await h.c.get('/api/images')).data;
    assert.ok(all.total >= 5);
    assert.ok(all.images.every((i) => i.url.startsWith('/api/images/')));
    const one = all.images[0];
    assert.equal((await h.c.del(`/api/images/${one.id}`)).status, 200);
    assert.equal((await fetch(h.url + one.url)).status, 404);
    assert.equal((await h.c.get('/api/images?source=tool')).data.images.every((i) => i.source === 'tool'), true);
  });

  test('chat-linked direct generation stores the image on an assistant message', async () => {
    const chat = await newChat(h.c);
    const r = await h.c.sse('/api/images/generate', { providerId: 'dt', prompt: 'a paper boat', chatId: chat });
    const done = byType(r.events, 'done')[0];
    assert.equal(done.message.kind, 'image_result');
    assert.equal(done.message.images.length, 1);
    assert.equal(done.userMessage.kind, 'image_request');
    const d = (await h.c.get(`/api/chats/${chat}`)).data;
    assert.deepEqual(d.path, [done.userMessage.id, done.message.id]);
    assert.equal((await h.c.get(`/api/images?chatId=${chat}`)).data.total, 1);
    await send(h.c, chat, 'nice, now describe it');
    const msgs = h.fake.chatRequests().at(-1).messages;
    assert.match(msgs[1].content, /\[The user generated an image with the prompt: "a paper boat"\]/);
    assert.match(msgs[2].content, /\[Generated 1 image/);
  });

  test('generate_image tool: offered only when a provider is up; full chat SSE with inline image events', async () => {
    const chat = await newChat(h.c);
    const r = await send(h.c, chat, 'draw a red fox curled up in the snow');
    const types = r.events.map((e) => e.type);
    const call = byType(r.events, 'tool_call')[0];
    assert.equal(call.toolCall.name, 'generate_image');
    assert.equal(call.toolCall.arguments.prompt, 'a red fox curled up in the snow');
    assert.ok(types.indexOf('image_job') > types.indexOf('tool_call'));
    const imgEv = byType(r.events, 'image')[0];
    assert.equal(imgEv.toolCallId, call.toolCall.id);
    assert.equal(imgEv.messageId, call.messageId);
    const tr = byType(r.events, 'tool_result')[0];
    assert.equal(tr.images.length, 1);
    assert.equal(tr.images[0].id, imgEv.image.id);
    assert.match(tr.content, /^Generated 1 image \(512×512, seed \d+, model .+\)\. It is now shown to the user\.$/);
    assert.ok(!tr.content.includes('base64'));
    assert.match(byType(r.events, 'done')[0].message.content, /Tool generate_image returned: Generated 1 image/);
    const req = h.fake.chatRequests().filter((b) => b.tools).at(-2);
    const tool = req.tools.find((t) => t.function.name === 'generate_image');
    assert.ok(tool && /ONLY when the user asks/.test(tool.function.description));
    // the tool message persists the image ref; Markdown export links it
    const d = (await h.c.get(`/api/chats/${chat}`)).data;
    assert.equal(d.messages.find((m) => m.role === 'tool').images[0].id, imgEv.image.id);
    const md = await (await fetch(`${h.url}/api/chats/${chat}/export?format=markdown`)).text();
    assert.match(md, new RegExp(`!\\[a red fox curled up in the snow\\]\\(/api/images/${imgEv.image.id}/file\\)`));
    // the image is not fed back to the model by default
    assert.equal(h.fake.chatRequests().at(-1).messages.find((m) => m.role === 'tool').images, undefined);
    // disable flag hides the tool
    await h.c.patch('/api/settings', { tools: { builtin: { generate_image: false } } });
    await send(h.c, chat, 'hello');
    assert.ok(!h.fake.chatRequests().at(-1).tools.some((t) => t.function.name === 'generate_image'));
    await h.c.patch('/api/settings', { tools: { builtin: { generate_image: true } } });
  });

  test('feedback to a vision-capable chat model when enabled', async () => {
    await h.c.patch('/api/settings', { image: { feedbackToModel: true } });
    const chat = await newChat(h.c);
    await send(h.c, chat, 'draw a green apple');
    const toolMsg = h.fake.chatRequests().at(-1).messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.images.length, 1, 'nemotron is vision-capable → image fed back');
    await h.c.patch('/api/settings', { image: { feedbackToModel: false } });
  });

  test('abort: cancelling a job interrupts the backend', async () => {
    f.a1111.stepMs = 50;
    let jobId = null;
    const events = await h.c.sseStream('/api/images/generate', { providerId: 'dt', prompt: 'never finishes', steps: 100 }, async (ev) => {
      if (ev.type === 'image_job') jobId = ev.job.id;
      if (ev.type === 'image_status' && ev.phase === 'generating') await h.c.post(`/api/images/jobs/${jobId}/cancel`);
    });
    f.a1111.stepMs = 4;
    const err = byType(events, 'error')[0];
    assert.equal(err.code, 'aborted');
    assert.ok(f.a1111.interrupts >= 1);
    const jobs = (await h.c.get('/api/images/jobs')).data.jobs;
    assert.equal(jobs.find((j) => j.id === jobId).status, 'aborted');
  });

  test('16 GB auto mode keeps a small chat model loaded when it fits', async () => {
    const chat = await newChat(h.c);
    h.fake.loaded.clear(); // only the small model resident (the 7.9 GB official Nemotron would not leave room)
    await send(h.c, chat, 'hi', { model: { model: 'qwen3:4b' } });
    h.fake.unloads.length = 0;
    const r = await h.c.sse('/api/images/generate', { providerId: 'dt', prompt: 'x', model: 'sd_turbo.safetensors [a1b2c3]' });
    assert.ok(!byType(r.events, 'image_status').some((s) => s.phase === 'unloading'));
    assert.equal(byType(r.events, 'done')[0].job.memory.reason, 'fits');
    assert.equal(h.fake.unloads.length, 0);
  });
});

describe('image generation on an 8 GB Mac: RAM coordination', () => {
  // the automatic default on 8 GB: the installed model that fits (the 7.9 GB official Nemotron does not)
  const CHAT8 = 'qwen3:4b';
  let h;
  let f;
  before(async () => {
    f = await startImageFakes();
    h = await setup({ system: { totalMem: 8 * GiB, platform: 'darwin', arch: 'arm64' }, settings: { image: { custom: f.providers.slice(0, 1) }, titles: { auto: false }, memory: { extractDelayMs: 0 } } });
  });
  after(async () => { await h.close(); await f.close(); });

  test('auto → unload the chat model first, lazy reload on the next chat request, background work waits', async () => {
    const chat = await newChat(h.c);
    await send(h.c, chat, 'warm up the model please');
    await h.app.background.idle();
    assert.ok(h.fake.loaded.has(CHAT8));
    const r = await h.c.sse('/api/images/generate', { providerId: 'dt', prompt: 'a small cottage', chatId: chat });
    const phases = byType(r.events, 'image_status').map((s) => s.phase);
    assert.deepEqual(phases.slice(0, 4), ['starting', 'unloading', 'unloaded', 'generating']);
    const unloading = byType(r.events, 'image_status').find((s) => s.phase === 'unloading');
    assert.deepEqual(unloading.models, [CHAT8]);
    assert.equal(unloading.reason, 'low_ram');
    assert.ok(h.fake.unloads.includes(CHAT8));
    const done = byType(r.events, 'done')[0];
    assert.equal(done.job.params.width, 512);
    assert.equal(byType(r.events, 'image_done')[0].reload, 'lazy');
    assert.equal(h.app.modelState.unloadedForImage, true);
    assert.equal(h.fake.loaded.has(CHAT8), false, 'not eagerly reloaded');

    // Background LLM work is held while the chat model is unloaded for an image job.
    let ran = false;
    h.app.background.schedule('test:llm-task', async () => { ran = true; }, { needsModel: true });
    await new Promise((r2) => setTimeout(r2, 50));
    assert.equal(ran, false);
    assert.equal(h.app.background.status().pending.find((p) => p.key === 'test:llm-task').blockedBy, 'model_unloaded_for_image');

    const r2 = await send(h.c, chat, 'thanks! what next?');
    const ms = byType(r2.events, 'model_status').map((e) => e.phase);
    assert.deepEqual(ms, ['loading', 'ready']);
    assert.equal(h.app.modelState.unloadedForImage, false);
    await h.app.background.idle();
    assert.equal(ran, true, 'background work resumed after the lazy reload');
  });

  test('tool-triggered generation mid-turn also unloads, then the loop reloads the model to answer', async () => {
    const chat = await newChat(h.c);
    await send(h.c, chat, 'hello');
    h.fake.unloads.length = 0;
    const r = await send(h.c, chat, 'draw a tiny robot');
    const types = r.events.map((e) => e.type);
    assert.ok(byType(r.events, 'image_status').some((s) => s.phase === 'unloading'));
    assert.ok(h.fake.unloads.includes(CHAT8));
    const iLoad = types.indexOf('model_status');
    assert.ok(iLoad > types.indexOf('tool_result'), 'reload announced after the tool result, before the final answer');
    assert.match(byType(r.events, 'done')[0].message.content, /Tool generate_image returned/);
    assert.equal(h.app.modelState.unloadedForImage, false);
  });

  test("unloadChatModel: 'never' keeps the model; warnings surface for heavy settings", async () => {
    await h.c.patch('/api/settings', { image: { unloadChatModel: 'never' } });
    const chat = await newChat(h.c);
    await send(h.c, chat, 'hello');
    h.fake.unloads.length = 0;
    const r = await h.c.sse('/api/images/generate', { providerId: 'dt', prompt: 'big', width: 1024, height: 1024, model: 'sdxl_base_1.0.safetensors [d4e5f6]' });
    assert.equal(h.fake.unloads.length, 0);
    const start = byType(r.events, 'image_status').find((s) => s.phase === 'starting');
    const codes = start.warnings.map((w) => w.code);
    assert.ok(codes.includes('large_size_low_ram') && codes.includes('heavy_model_low_ram'), codes.join(','));
    assert.ok(byType(r.events, 'done')[0], 'warned, not blocked');
    await h.c.patch('/api/settings', { image: { unloadChatModel: 'auto' } });
  });
});

describe('no image provider', () => {
  let h;
  before(async () => { h = await setup(); });
  after(() => h.close());
  test('direct generation fails fast with a helpful error; the tool is not offered', async () => {
    const r = await h.c.post('/api/images/generate', { prompt: 'x' });
    assert.equal(r.status, 503);
    assert.equal(r.data.error.code, 'no_image_provider');
    assert.match(r.data.error.message, /Draw Things/);
    const chat = await newChat(h.c);
    const s = await send(h.c, chat, 'draw a cat');
    assert.equal(byType(s.events, 'tool_call').length, 0);
    assert.ok(!h.fake.chatRequests().at(-1).tools.some((t) => t.function.name === 'generate_image'));
    assert.match(text(s.events), /You said: draw a cat/);
    await waitFor(() => !h.app.engine.busy(chat));
  });
});

describe('A1111-compatible batches', () => {
  const params = { prompt: 'three apples', negativePrompt: '', width: 64, height: 64, steps: 1, cfg: 1, seed: 7, count: 3 };

  test('real A1111 puts a grid first: it is dropped, and batches run one image at a time', async () => {
    const fake = await startFakeA1111({ port: 0, stepMs: 1 });
    try {
      const p = new A1111Provider({ id: 'a', name: 'A1111', kind: 'a1111', baseUrl: fake.url });
      const r = await p.generate(params);
      assert.equal(r.images.length, 3);
      assert.deepEqual(r.seeds, [7, 8, 9]);
      assert.deepEqual(r.images[0].buffer, makePng(64, 64, 7), 'first returned image is the first real image, not the grid');
      assert.equal(fake.lastBody.batch_size, 1, 'never a parallel batch (peak memory)');
      assert.equal(fake.lastBody.n_iter, 3);
    } finally { await fake.close(); }
  });

  test('Draw Things naming (batch_count, no grid, no info index) yields exactly `count` images', async () => {
    const fake = await startFakeA1111({ port: 0, stepMs: 1, drawThings: true });
    try {
      const p = new A1111Provider({ id: 'd', name: 'Draw Things', kind: 'a1111', baseUrl: fake.url });
      const r = await p.generate(params);
      assert.equal(r.images.length, 3);
      assert.deepEqual(r.images[2].buffer, makePng(64, 64, 9));
      assert.equal(fake.lastBody.batch_count, 3);
    } finally { await fake.close(); }
  });
});
