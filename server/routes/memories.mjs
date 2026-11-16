// Long-term memory CRUD + search + manual extraction; attachments upload/download.
import { HttpError, badRequest } from '../lib/errors.mjs';
import { readJson, readBody } from '../http/http.mjs';
import { MEMORY_CATEGORIES } from '../memory/memories.mjs';
import { extractMemories } from '../memory/extractor.mjs';
import { MAX_UPLOAD_BYTES, publicAttachment } from '../store/attachments.mjs';
import { qBool, qInt, created, requireString } from './common.mjs';

export function registerMemoryRoutes(r, app) {
  r.get('/api/memories', ({ query }) => {
    const pinnedQ = query.get('pinned');
    const { total, items } = app.memories.list({
      q: query.get('q') || null,
      category: query.get('category') || null,
      pinned: pinnedQ === null || pinnedQ === '' ? undefined : qBool(pinnedQ),
      limit: qInt(query.get('limit'), 500, { min: 1, max: 10000 }),
      offset: qInt(query.get('offset'), 0, { max: 1e7 }),
    });
    return { total, memories: items, enabled: app.settings.get().memory?.enabled !== false, categories: MEMORY_CATEGORIES };
  });

  r.post('/api/memories', async ({ req }) => {
    const body = await readJson(req);
    const content = requireString(body.content, 'content', { max: 2000 });
    if (body.category !== undefined && !MEMORY_CATEGORIES.includes(body.category)) throw badRequest(`category must be one of ${MEMORY_CATEGORIES.join(', ')}`);
    const res = await app.memories.add({ content, category: body.category || 'other', pinned: !!body.pinned, origin: 'manual', dedupe: body.dedupe !== false, allowSecret: body.allowSecret === true });
    return created(res);
  });

  r.post('/api/memories/search', async ({ req }) => {
    const body = await readJson(req);
    const q = requireString(body.query, 'query', { max: 5000 });
    const emb = await app.embedder.embed([q], { kind: 'query' }).catch(() => null);
    const results = app.memories.search(q, { k: Math.min(50, body.k || 10), queryVector: emb ? { model: emb.model, vec: emb.vectors[0] } : null, minSimilarity: body.minSimilarity ?? app.settings.get().memory?.minSimilarity ?? 0.5 });
    return { results, retrieval: emb ? 'hybrid' : 'bm25', embeddingModel: emb?.model || null };
  });

  r.post('/api/memories/extract', async ({ req }) => {
    const body = await readJson(req);
    const chat = app.chats.get(requireString(body.chatId, 'chatId'));
    const rec = app.engine.reserve(chat.id, 'memory_extraction');
    let lease = null;
    try {
      if (body.full) chat.memoryCursor = null;
      lease = await app.ram.acquire('llm', { owner: rec.generationId, signal: rec.controller.signal });
      const res = await extractMemories(app, chat, { signal: rec.controller.signal });
      return { added: res.added, updated: res.updated, skipped: res.skipped };
    } finally {
      lease?.release();
      app.engine.release(chat.id, rec);
    }
  });

  r.patch('/api/memories/:id', async ({ req, params }) => {
    const body = await readJson(req);
    for (const k of Object.keys(body)) if (!['content', 'category', 'pinned', 'needsReview', 'allowSecret'].includes(k)) throw badRequest(`Unknown field ${k}`);
    if (body.needsReview !== undefined && body.needsReview !== false) throw badRequest('needsReview can only be set to false (confirm the memory)');
    const { allowSecret, ...patch } = body;
    return { memory: await app.memories.update(params.id, patch, { origin: 'manual', allowSecret: allowSecret === true }) };
  });

  r.delete('/api/memories/:id', async ({ params }) => { await app.memories.delete(params.id); return { ok: true }; });

  r.delete('/api/memories', async ({ query }) => {
    if (query.get('confirm') !== 'true') throw badRequest('Pass ?confirm=true to delete all memories');
    return { deleted: await app.memories.clear() };
  });

  // ---- attachments ------------------------------------------------------------------------------
  r.post('/api/attachments', async ({ req, query }) => {
    let name = query.get('name');
    if (!name && req.headers['x-filename']) { try { name = decodeURIComponent(String(req.headers['x-filename'])); } catch { name = String(req.headers['x-filename']); } }
    name ||= 'file';
    const chatId = query.get('chatId') || null;
    if (chatId) app.chats.get(chatId);
    const buffer = await readBody(req, MAX_UPLOAD_BYTES);
    const a = await app.attachments.create({ name: String(name), mime: req.headers['content-type'] || null, buffer, chatId });
    return created({ attachment: publicAttachment(a) });
  });

  r.get('/api/attachments/:id', ({ params }) => ({ attachment: publicAttachment(app.attachments.get(params.id)) }));

  r.get('/api/attachments/:id/content', async ({ params, res }) => {
    const a = app.attachments.get(params.id);
    const { size, stream } = await app.attachments.openOriginal(a.id);
    // Only raster images are shown inline; everything else (HTML, SVG, PDF, text, …) is a sandboxed download,
    // so an uploaded file can never run as active content on the app's own origin.
    const inlineImage = a.kind === 'image' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(a.mime);
    const fname = encodeURIComponent(a.name).replace(/'/g, '%27');
    res.writeHead(200, {
      'content-type': inlineImage ? a.mime : 'application/octet-stream',
      'content-length': size,
      'cache-control': 'no-store',
      'content-disposition': `${inlineImage ? 'inline' : 'attachment'}; filename*=UTF-8''${fname}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': inlineImage ? "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" : "default-src 'none'; sandbox",
    });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });

  r.get('/api/attachments/:id/text', async ({ params, query }) => {
    const a = app.attachments.get(params.id);
    if (a.kind !== 'text') throw new HttpError(400, 'no_text', 'This attachment has no extracted text');
    const text = (await app.attachments.readText(a.id)) || '';
    const max = qInt(query.get('maxChars'), 200000, { min: 100, max: 50_000_000 });
    return { attachmentId: a.id, text: text.slice(0, max), truncated: text.length > max, chars: text.length };
  });

  r.delete('/api/attachments/:id', async ({ params }) => { await app.attachments.delete(params.id); return { ok: true }; });
}
