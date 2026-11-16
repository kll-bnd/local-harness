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
    const res = await app.memories.add({ content, category: body.category || 'other', pinned: !!body.pinned, origin: 'manual', dedupe: body.dedupe !== false });
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
    if (app.engine.busy(chat.id)) throw new HttpError(409, 'chat_busy', 'A generation is in progress for this chat');
    if (body.full) chat.memoryCursor = null;
    app.foreground++;
    try {
      const res = await extractMemories(app, chat);
      return { added: res.added, updated: res.updated, skipped: res.skipped };
    } finally {
      app.foreground--;
      app.background.kick();
    }
  });

  r.patch('/api/memories/:id', async ({ req, params }) => {
    const body = await readJson(req);
    for (const k of Object.keys(body)) if (!['content', 'category', 'pinned'].includes(k)) throw badRequest(`Unknown field ${k}`);
    return { memory: await app.memories.update(params.id, body) };
  });

  r.delete('/api/memories/:id', async ({ params }) => { await app.memories.delete(params.id); return { ok: true }; });

  r.delete('/api/memories', async ({ query }) => {
    if (query.get('confirm') !== 'true') throw badRequest('Pass ?confirm=true to delete all memories');
    return { deleted: await app.memories.clear() };
  });

  // ---- attachments ------------------------------------------------------------------------------
  r.post('/api/attachments', async ({ req, query }) => {
    const name = query.get('name') || req.headers['x-filename'] || 'file';
    const chatId = query.get('chatId') || null;
    if (chatId) app.chats.get(chatId);
    const buffer = await readBody(req, MAX_UPLOAD_BYTES);
    const a = await app.attachments.create({ name: decodeURIComponent(String(name)), mime: req.headers['content-type'] || null, buffer, chatId });
    return created({ attachment: publicAttachment(a) });
  });

  r.get('/api/attachments/:id', ({ params }) => ({ attachment: publicAttachment(app.attachments.get(params.id)) }));

  r.get('/api/attachments/:id/content', async ({ params, res }) => {
    const a = app.attachments.get(params.id);
    const buf = await app.attachments.readOriginal(a.id);
    res.writeHead(200, { 'content-type': a.mime || 'application/octet-stream', 'content-length': buf.length, 'cache-control': 'private, max-age=3600', 'content-disposition': `inline; filename="${encodeURIComponent(a.name)}"`, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" });
    res.end(buf);
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
