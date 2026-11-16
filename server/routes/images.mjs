// Image generation: providers, models, direct generation (SSE), gallery, jobs.
import { HttpError, badRequest, notFound } from '../lib/errors.mjs';
import { openSse, readJson, sendJson } from '../http/http.mjs';
import { newId } from '../lib/ids.mjs';
import { nowIso } from '../lib/util.mjs';
import { addMessage, setActiveLeaf } from '../chat/tree.mjs';
import { publicMessage, chatSummary } from '../store/chats.mjs';
import { publicImage, imageRef } from '../image/gallery.mjs';
import { resolveImageParams, ASPECTS, IMAGE_FAMILIES } from '../image/defaults.mjs';
import { qBool, qInt, created, requireString } from './common.mjs';

const NUM_FIELDS = { width: [64, 4096], height: [64, 4096], steps: [1, 200], cfg: [0, 50], seed: [-1, 2 ** 32], count: [1, 8], denoise: [0, 1] };

export function validateImageRequest(body) {
  const req = {};
  req.prompt = requireString(body.prompt, 'prompt', { max: 4000 });
  if (body.negativePrompt !== undefined && body.negativePrompt !== null) req.negativePrompt = String(body.negativePrompt).slice(0, 4000);
  for (const [k, [lo, hi]] of Object.entries(NUM_FIELDS)) {
    if (body[k] === undefined || body[k] === null) continue;
    const v = Number(body[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) throw badRequest(`${k} must be a number between ${lo} and ${hi}`);
    req[k] = ['width', 'height', 'steps', 'seed', 'count'].includes(k) ? Math.floor(v) : v;
  }
  if (body.aspect !== undefined) { if (!ASPECTS[body.aspect]) throw badRequest(`aspect must be one of ${Object.keys(ASPECTS).join(', ')}`); req.aspect = body.aspect; }
  if (body.size !== undefined) req.size = String(body.size);
  for (const k of ['sampler', 'scheduler', 'model', 'providerId']) if (typeof body[k] === 'string' && body[k]) req[k] = body[k];
  if (body.initImage) {
    if (typeof body.initImage !== 'object' || (!body.initImage.attachmentId && !body.initImage.imageId)) throw badRequest('initImage must be {attachmentId} or {imageId}');
    req.initImage = { attachmentId: body.initImage.attachmentId, imageId: body.initImage.imageId };
  }
  return req;
}

export function registerImageRoutes(r, app) {
  r.get('/api/images/providers', async ({ query }) => ({ providers: await app.imageProviders.listStatus({ refresh: qBool(query.get('refresh')) }), enabled: app.settings.get().image?.enabled !== false }));

  r.post('/api/images/providers', async ({ req }) => {
    const body = await readJson(req);
    const kind = ['a1111', 'comfyui', 'openai'].includes(body.kind) ? body.kind : null;
    if (!kind) throw badRequest("kind must be 'a1111', 'comfyui' or 'openai'");
    const entry = { id: newId('imgprov'), name: requireString(body.name, 'name', { max: 100 }), kind, baseUrl: requireString(body.baseUrl, 'baseUrl', { max: 500 }), apiKey: typeof body.apiKey === 'string' ? body.apiKey : '', enabled: body.enabled !== false };
    if (body.workflow !== undefined) entry.workflow = body.workflow;
    await app.settings.patch({ image: { custom: [...(app.settings.get().image.custom || []), entry] } });
    app.imageProviders.sync();
    const list = await app.imageProviders.listStatus({ refresh: true });
    return created({ provider: list.find((p) => p.id === entry.id) || entry });
  });

  r.patch('/api/images/providers/:id', async ({ req, params }) => {
    const body = await readJson(req);
    if (params.id === 'a1111' || params.id === 'comfyui') {
      const patch = {};
      if (body.baseUrl !== undefined) patch.baseUrl = body.baseUrl;
      if (body.enabled !== undefined) patch.enabled = !!body.enabled;
      await app.settings.patch({ image: { builtin: { [params.id]: patch } } });
    } else {
      const list = app.settings.get().image.custom || [];
      if (!list.some((p) => p.id === params.id)) throw notFound('Image provider');
      const next = list.map((p) => (p.id === params.id ? { ...p, ...Object.fromEntries(Object.entries(body).filter(([k]) => ['name', 'baseUrl', 'apiKey', 'enabled', 'workflow'].includes(k))) } : p));
      await app.settings.patch({ image: { custom: next } });
    }
    app.imageProviders.sync();
    return { providers: await app.imageProviders.listStatus({ refresh: true }) };
  });

  r.delete('/api/images/providers/:id', async ({ params }) => {
    const list = app.settings.get().image.custom || [];
    if (!list.some((p) => p.id === params.id)) throw badRequest('Only custom image providers can be deleted');
    await app.settings.patch({ image: { custom: list.filter((p) => p.id !== params.id) } });
    app.imageProviders.sync();
    return { ok: true };
  });

  r.get('/api/images/models', async ({ query }) => {
    const p = await app.imageProviders.resolve(query.get('providerId') || null);
    return { providerId: p.id, models: await p.listModels() };
  });

  r.get('/api/images/defaults', async ({ query }) => {
    const model = query.get('model') || app.settings.get().image.model || '';
    const req = { prompt: 'preview' };
    if (query.get('aspect')) req.aspect = query.get('aspect');
    const { params, family, warnings } = resolveImageParams(req, { settings: app.settings.get(), totalMem: app.system.totalMem, model, providerKind: null });
    delete params.prompt;
    delete params.seed;
    return { params, family, warnings, aspects: Object.keys(ASPECTS), families: IMAGE_FAMILIES.map((f) => ({ id: f.id, label: f.label, steps: f.steps, cfg: f.cfg, base: f.base, fewStep: !!f.fewStep })) };
  });

  r.get('/api/images/jobs', () => ({ jobs: app.images.listJobs() }));
  r.post('/api/images/jobs/:id/cancel', ({ params }) => ({ job: app.images.cancel(params.id) }));

  r.post('/api/images/generate', async ({ req, res }) => {
    const body = await readJson(req, { limit: 1024 * 1024 });
    const ireq = validateImageRequest(body);
    const stream = body.stream !== false;
    let chat = null;
    let reservation = null;
    if (body.chatId) {
      chat = app.chats.get(body.chatId);
      if (body.parentId && !chat.messages[body.parentId]) throw new HttpError(400, 'bad_parent', 'parentId not found in this chat');
      reservation = app.engine.reserve(chat.id, 'image'); // synchronous: no await between check and reservation
    }
    try {
      // Fail fast (before SSE) when no provider is reachable.
      const provider = await app.imageProviders.resolve(ireq.providerId);
      ireq.providerId = provider.id;
      if (chat && app.chats.chats.get(chat.id) !== chat) throw new HttpError(404, 'not_found', 'Chat not found');
      if (chat && body.parentId && !chat.messages[body.parentId]) throw new HttpError(400, 'bad_parent', 'parentId not found in this chat');
      await runImageTurn({ app, req, res, chat, reservation, ireq, provider, stream, parentId: chat ? (body.parentId === undefined ? chat.activeLeafId : body.parentId) : null });
    } finally {
      if (reservation) app.engine.release(chat.id, reservation);
    }
  });

  r.get('/api/images', ({ query }) => {
    const { total, items } = app.gallery.list({ chatId: query.get('chatId') || null, source: query.get('source') || null, q: query.get('q') || null, limit: qInt(query.get('limit'), 100, { min: 1, max: 1000 }), offset: qInt(query.get('offset'), 0, { max: 1e7 }) });
    return { total, images: items };
  });

  r.get('/api/images/:id', ({ params }) => ({ image: publicImage(app.gallery.get(params.id)) }));

  r.get('/api/images/:id/file', async ({ params, res, query }) => {
    const rec = app.gallery.get(params.id);
    const buf = await app.gallery.read(rec.id);
    const headers = { 'content-type': rec.mime, 'content-length': buf.length, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' };
    if (qBool(query.get('download'))) headers['content-disposition'] = `attachment; filename="${rec.id}.${rec.file.split('.').pop()}"`;
    res.writeHead(200, headers);
    res.end(buf);
  });

  r.delete('/api/images/:id', async ({ params }) => { await app.gallery.delete(params.id); return { ok: true }; });
}

/**
 * One image generation, optionally linked to a chat (adds an image_request user message — unless `userMessage`
 * is given, e.g. for regenerate — and an image_result assistant message). Streams SSE unless `stream` is false.
 */
export async function runImageTurn({ app, req, res, chat, reservation, ireq, provider, stream = true, parentId = null, userMessage = null, chatStyle = false }) {
  const sse = stream ? openSse(req, res) : null;
  const emit = (t, d) => sse?.send(t, d);
  const controller = reservation?.controller || new AbortController();
  if (sse) sse.signal.addEventListener('abort', () => controller.abort(), { once: true });
  else req.on('close', () => { if (!res.writableEnded) controller.abort(); });
  let um = userMessage;
  let am = null;
  if (chat) {
    if (!um) {
      um = { id: newId('msg'), parentId: parentId ?? null, role: 'user', kind: 'image_request', content: ireq.prompt, imageRequest: { ...ireq }, createdAt: nowIso(), status: 'complete' };
      addMessage(chat, um);
    }
    am = { id: newId('msg'), parentId: um.id, role: 'assistant', kind: 'image_result', content: '', images: [], status: 'streaming', model: { providerId: provider.id, model: ireq.model || null, kind: 'image' }, createdAt: nowIso() };
    addMessage(chat, am);
    setActiveLeaf(chat, am.id);
    if (reservation) reservation.assistantMessageId = am.id;
    if (!chat.titleSource) { chat.title = ireq.prompt.slice(0, 60); chat.titleSource = 'provisional'; }
    app.chats.touch(chat);
    if (chatStyle) emit('start', { generationId: reservation?.generationId || null, chatId: chat.id, userMessage: null, assistantMessage: publicMessage(am), model: { providerId: provider.id, model: ireq.model || null, kind: 'image' } });
    if (!userMessage) emit('message', { message: publicMessage(um) });
    emit('message', { message: publicMessage(am) });
  }
  try {
    const { job, images } = await app.images.generate(ireq, { signal: controller.signal, emit, chatId: chat?.id || null, messageId: am?.id || null, source: 'user' });
    if (am) {
      am.images = images.map(imageRef);
      am.status = 'complete';
      am.model.model = images[0]?.model || am.model.model;
      am.imageJobId = job.id;
      am.updatedAt = nowIso();
    }
    // Release the chat and persist the turn BEFORE `done`: after `done` the client may send again immediately.
    if (chat) {
      if (reservation) app.engine.release(chat.id, reservation);
      app.chats.touch(chat);
      await app.chats.saveNow(chat).catch(() => {});
    }
    const payload = { job, images: images.map(publicImage), ...(am ? { message: publicMessage(am), userMessage: publicMessage(um), chat: chatSummary(chat) } : {}) };
    if (chatStyle) Object.assign(payload, { generationId: reservation?.generationId || null, reason: 'stop', createdMessageIds: [am.id] });
    if (sse) sse.send('done', payload); else sendJson(res, 200, payload);
  } catch (e) {
    const aborted = controller.signal.aborted || e.name === 'AbortError';
    if (am) { am.status = aborted ? 'aborted' : 'error'; am.error = aborted ? null : e.message; am.updatedAt = nowIso(); }
    if (chat) {
      if (reservation) app.engine.release(chat.id, reservation);
      app.chats.touch(chat);
      await app.chats.saveNow(chat).catch(() => {});
    }
    if (sse) sse.send('error', { code: aborted ? 'aborted' : e.code || 'image_error', message: e.message, ...(am ? { messageId: am.id } : {}) });
    else if (!res.headersSent) throw e;
  } finally {
    if (chat) {
      if (reservation) app.engine.release(chat.id, reservation);
      app.chats.touch(chat);
      await app.chats.saveNow(chat).catch(() => {});
    }
    sse?.end();
  }
}

/** `POST /api/chats/:id/messages/:mid/regenerate` on an image turn: a new image result under the same request. */
export async function regenerateImage(ctx, chat, anchor) {
  const { app, req, res } = ctx;
  const reservation = app.engine.reserve(chat.id, 'image');
  try {
    const ireq = validateImageRequest({ ...(anchor.imageRequest || {}), prompt: anchor.imageRequest?.prompt || anchor.content });
    if (!anchor.imageRequest?.seed && anchor.imageRequest?.seed !== 0) delete ireq.seed; // a new random seed
    const provider = await app.imageProviders.resolve(ireq.providerId);
    ireq.providerId = provider.id;
    if (!chat.messages[anchor.id]) throw new HttpError(409, 'message_deleted', 'The message to answer no longer exists');
    await runImageTurn({ app, req, res, chat, reservation, ireq, provider, stream: true, userMessage: anchor, chatStyle: true });
  } finally {
    app.engine.release(chat.id, reservation);
  }
}
