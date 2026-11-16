// Chat, message-tree, generation, summary, export/import and search routes.
import { HttpError, notFound, badRequest } from '../lib/errors.mjs';
import { openSse, readJson, sendJson } from '../http/http.mjs';
import { chatSummary, serializeMessages, publicMessage, newChat } from '../store/chats.mjs';
import { validateChatSettings } from '../store/settings.mjs';
import { activePath, pathTo, deepestLeaf, setActiveLeaf, deleteSubtree, turnUserMessage } from '../chat/tree.mjs';
import { activeSummary } from '../context/compaction.mjs';
import { exportMarkdown, exportJson, importPayload } from '../chat/export.mjs';
import { buildBackup, restoreBackup } from '../chat/backup.mjs';
import { regenerateImage } from './images.mjs';
import { generateTitle } from '../chat/titles.mjs';
import { newId } from '../lib/ids.mjs';
import { nowIso, deepMerge, isPlainObject } from '../lib/util.mjs';
import { qBool, qInt, created, modelRefFrom } from './common.mjs';

function pruneNulls(o) {
  if (!isPlainObject(o)) return o;
  for (const [k, v] of Object.entries(o)) {
    if (v === null) delete o[k];
    else if (isPlainObject(v)) { pruneNulls(v); if (!Object.keys(v).length) delete o[k]; }
  }
  return o;
}

function chatDetail(app, chat) {
  const path = activePath(chat);
  const summary = activeSummary(chat, path);
  const gen = app.engine.active.get(chat.id);
  return {
    chat: {
      ...chatSummary(chat),
      settings: chat.settings,
      activeLeafId: chat.activeLeafId,
      summary: summary || null,
      generating: gen ? { generationId: gen.generationId, assistantMessageId: gen.assistantMessageId, startedAt: gen.startedAt } : null,
    },
    messages: serializeMessages(chat),
    path: path.map((m) => m.id),
  };
}

function attachmentRefs(app, ids, chatId) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.length > 20) throw badRequest('attachments must be an array of up to 20 attachment ids');
  return ids.map((id) => {
    const a = app.attachments.tryGet(typeof id === 'object' ? id?.id : id);
    if (!a) throw new HttpError(400, 'attachment_not_found', `Attachment ${id} not found`);
    if (a.status === 'error') throw new HttpError(400, 'attachment_unusable', `Attachment ${a.name} could not be processed: ${a.error}`);
    app.attachments.assignChat(a.id, chatId).catch(() => {});
    return { id: a.id, name: a.name, kind: a.kind, mime: a.mime, size: a.size };
  });
}

/**
 * Stream a generation over SSE. The chat is reserved synchronously first (no await between the busy check and
 * the reservation), then setup runs (`target`, `prepare`) — setup errors are JSON responses (no SSE bytes yet)
 * and release the reservation.
 */
async function streamTurn(ctx, chat, { prepare, modelRef }) {
  const { app, req, res } = ctx;
  const reservation = app.engine.reserve(chat.id);
  let sse = null;
  try {
    const prepared = await app.engine.target(chat, modelRef);
    if (app.chats.chats.get(chat.id) !== chat) throw notFound('Chat');
    const { anchorId, userMessage } = prepare();
    if (!chat.messages[anchorId]) throw new HttpError(409, 'message_deleted', 'The message to answer no longer exists');
    sse = openSse(req, res);
    await app.engine.run({ chat, anchorId, userMessage, emit: (t, d) => sse.send(t, d), signal: sse.signal, modelRef, prepared, reservation });
  } catch (e) {
    app.engine.release(chat.id, reservation);
    if (!sse) throw e;
    sse.send('error', { code: e.code || 'internal_error', message: e.message });
  } finally {
    app.engine.release(chat.id, reservation);
    sse?.end();
  }
}

/**
 * Delete a chat's files unless another chat still references them (forks share attachments and images).
 * Returns { attachments, images, memories } counts removed.
 */
export async function deleteChatAssets(app, chat, { deleteMemories = false } = {}) {
  const usedAtt = new Set();
  const usedImg = new Set();
  for (const c of app.chats.all()) {
    if (c.id === chat.id) continue;
    for (const m of Object.values(c.messages)) {
      for (const a of m.attachments || []) usedAtt.add(a.id);
      for (const i of m.images || []) usedImg.add(i.id);
    }
  }
  const mine = new Set();
  const mineImg = new Set();
  for (const m of Object.values(chat.messages)) {
    for (const a of m.attachments || []) mine.add(a.id);
    for (const i of m.images || []) mineImg.add(i.id);
  }
  for (const a of app.attachments.items.values()) if (a.chatId === chat.id) mine.add(a.id);
  for (const r of app.gallery.items.values()) if (r.chatId === chat.id) mineImg.add(r.id);
  const out = { attachments: 0, images: 0, memories: 0 };
  for (const id of mine) {
    const a = app.attachments.tryGet(id);
    if (!a) continue;
    if (usedAtt.has(id)) {
      // still used by another chat (e.g. a fork): keep it and move ownership
      const owner = app.chats.all().find((c) => c.id !== chat.id && Object.values(c.messages).some((m) => (m.attachments || []).some((x) => x.id === id)));
      if (owner && a.chatId === chat.id) await app.attachments.assignChat(id, owner.id);
      continue;
    }
    await app.attachments.delete(id).catch(() => {});
    out.attachments++;
  }
  for (const id of mineImg) {
    const r = app.gallery.tryGet(id);
    if (!r) continue;
    if (usedImg.has(id)) {
      const owner = app.chats.all().find((c) => c.id !== chat.id && Object.values(c.messages).some((m) => (m.images || []).some((x) => x.id === id)));
      if (owner && r.chatId === chat.id) await app.gallery.update(id, { chatId: owner.id });
      continue;
    }
    await app.gallery.delete(id).catch(() => {});
    out.images++;
  }
  if (deleteMemories) {
    for (const m of [...app.memories.items.values()]) {
      if (m.source?.chatId === chat.id) { await app.memories.delete(m.id).catch(() => {}); out.memories++; }
    }
  }
  return out;
}

function searchChats(app, q, { limit = 50 } = {}) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return [];
  const results = [];
  for (const chat of app.chats.all()) {
    const onPath = new Set(activePath(chat).map((m) => m.id));
    const titleHit = terms.every((t) => String(chat.title || '').toLowerCase().includes(t));
    let any = false;
    for (const m of Object.values(chat.messages)) {
      if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content) continue;
      const low = m.content.toLowerCase();
      if (!terms.every((t) => low.includes(t))) continue;
      any = true;
      const i = low.indexOf(terms[0]);
      const s = Math.max(0, i - 60);
      const e = Math.min(m.content.length, i + terms[0].length + 100);
      const snippet = (s > 0 ? '…' : '') + m.content.slice(s, e).replace(/\s+/g, ' ') + (e < m.content.length ? '…' : '');
      const lowSnip = snippet.toLowerCase();
      const highlights = [];
      for (const t of terms) { let k = lowSnip.indexOf(t); while (k >= 0 && highlights.length < 20) { highlights.push([k, k + t.length]); k = lowSnip.indexOf(t, k + t.length); } }
      results.push({ chatId: chat.id, chatTitle: chat.title, messageId: m.id, role: m.role, snippet, highlights: highlights.sort((a, b) => a[0] - b[0]), createdAt: m.createdAt, onActivePath: onPath.has(m.id) });
    }
    if (titleHit && !any) results.push({ chatId: chat.id, chatTitle: chat.title, messageId: null, role: null, snippet: chat.title, highlights: [], createdAt: chat.updatedAt, onActivePath: true });
  }
  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export function registerChatRoutes(r, app) {
  r.get('/api/chats', ({ query }) => {
    const archived = query.get('archived') === 'all' ? 'all' : qBool(query.get('archived'), false);
    const { total, items } = app.chats.list({ archived, q: query.get('q') || null, limit: qInt(query.get('limit'), 200, { min: 1, max: 1000 }), offset: qInt(query.get('offset'), 0, { max: 1e6 }) });
    return { total, chats: items.map((c) => ({ ...c, generating: app.engine.busy(c.id) })) };
  });

  r.post('/api/chats', async ({ req }) => {
    const body = await readJson(req, { optional: true });
    if (body.settings !== undefined) validateChatSettings(body.settings);
    if (body.title !== undefined && body.title !== null && (typeof body.title !== 'string' || body.title.length > 200)) throw badRequest('title must be a string (max 200) or null');
    const chat = await app.chats.create({ title: body.title || null, settings: body.settings || {}, incognito: !!body.incognito });
    return created(chatDetail(app, chat));
  });

  r.post('/api/chats/import', async ({ req }) => {
    const body = await readJson(req, { limit: 512 * 1024 * 1024 });
    if (body?.format === 'harness.backup') {
      // A full backup imported here restores its chats with their files; memories/presets/settings are left out
      // (use POST /api/restore for those) and listed in `ignored` so nothing is skipped silently.
      const rep = await restoreBackup(app, body, { memories: false, presets: false, settings: 'skip' });
      if (!rep.chats.length) throw badRequest('No valid chats in this backup');
      const ignored = ['memories', 'presets', 'settings'].filter((k) => (k === 'settings' ? !!body.settings : Array.isArray(body[k]) && body[k].length));
      return created({ chats: rep.chats.map((id) => chatSummary(app.chats.get(id))), ignored, restored: rep.restored, skipped: rep.skipped });
    }
    const { chats, skipped } = importPayload(body, { exists: (id) => app.chats.has(id) });
    for (const c of chats) await app.chats.insert(c);
    return created({ chats: chats.map((c) => chatSummary(c)), ...(skipped ? { skipped: { chats: skipped } } : {}) });
  });

  r.post('/api/restore', async ({ req, query }) => {
    const body = await readJson(req, { limit: 512 * 1024 * 1024 });
    const settingsMode = query.get('settings') || 'skip';
    if (!['skip', 'safe', 'full'].includes(settingsMode)) throw badRequest("settings must be 'skip', 'safe' or 'full'");
    const flag = (k) => qBool(query.get(k), true);
    const report = await restoreBackup(app, body, { chats: flag('chats'), attachments: flag('attachments'), images: flag('images'), memories: flag('memories'), presets: flag('presets'), settings: settingsMode });
    return created(report);
  });

  r.get('/api/chats/:id', ({ params }) => chatDetail(app, app.chats.get(params.id)));

  r.patch('/api/chats/:id', async ({ req, params }) => {
    const chat = app.chats.get(params.id);
    const body = await readJson(req);
    for (const k of Object.keys(body)) if (!['title', 'pinned', 'archived', 'incognito', 'settings'].includes(k)) throw badRequest(`Unknown field ${k}`);
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) throw badRequest('title must be a non-empty string (max 200)');
      chat.title = body.title.trim();
      chat.titleSource = 'user';
    }
    if (body.pinned !== undefined) chat.pinned = !!body.pinned;
    if (body.archived !== undefined) chat.archived = !!body.archived;
    if (body.incognito !== undefined) {
      chat.incognito = !!body.incognito;
      if (chat.incognito) { app.recall.removeChat(chat.id); app.background.cancel(`memory:${chat.id}`); }
    }
    if (body.settings !== undefined) {
      if (body.settings === null) chat.settings = {};
      else {
        if (!isPlainObject(body.settings)) throw badRequest('settings must be an object');
        // null values clear an override (fall back to preset / global settings)
        validateChatSettings(pruneNulls(structuredClone(body.settings)));
        chat.settings = pruneNulls(deepMerge(chat.settings || {}, body.settings));
      }
    }
    app.chats.touch(chat);
    await app.chats.saveNow(chat);
    app.bus.publish('chat.updated', { chat: chatSummary(chat) });
    return chatDetail(app, chat);
  });

  r.delete('/api/chats/:id', async ({ params, query }) => {
    const chat = app.chats.get(params.id);
    app.engine.stop(chat.id);
    app.background.cancel(`memory:${chat.id}`);
    app.background.cancel(`title:${chat.id}`);
    app.background.cancel(`recall:${chat.id}`);
    await app.chats.delete(chat.id);
    app.recall.removeChat(chat.id);
    const removed = await deleteChatAssets(app, chat, { deleteMemories: qBool(query.get('deleteMemories')) });
    return { ok: true, removed };
  });

  // ---- generation -------------------------------------------------------------------------
  r.post('/api/chats/:id/messages', async (ctx) => {
    const chat = app.chats.get(ctx.params.id);
    const body = await readJson(ctx.req, { limit: 8 * 1024 * 1024 });
    const content = typeof body.content === 'string' ? body.content : '';
    if (content.length > 1_000_000) throw badRequest('content too long');
    const parentId = body.parentId === undefined ? chat.activeLeafId : body.parentId;
    if (parentId && !chat.messages[parentId]) throw new HttpError(400, 'bad_parent', 'parentId not found in this chat');
    const atts = attachmentRefs(app, body.attachments, chat.id);
    if (!content.trim() && !atts.length) throw badRequest('content or attachments required');
    const modelRef = modelRefFrom(body.model);
    await streamTurn(ctx, chat, {
      modelRef,
      prepare: () => {
        const um = app.engine.createUserMessage(chat, { content, attachments: atts, parentId });
        return { anchorId: um.id, userMessage: um };
      },
    });
  });

  r.post('/api/chats/:id/messages/:mid/regenerate', async (ctx) => {
    const chat = app.chats.get(ctx.params.id);
    const m = chat.messages[ctx.params.mid];
    if (!m) throw notFound('Message');
    const body = await readJson(ctx.req, { optional: true });
    const anchor = m.role === 'user' ? m : turnUserMessage(chat, m.id);
    if (!anchor) throw badRequest('No user message to regenerate from');
    if (anchor.kind === 'image_request') {
      // Regenerating an image turn makes a new image (new seed unless one was fixed), not a text reply.
      await regenerateImage(ctx, chat, anchor);
      return;
    }
    await streamTurn(ctx, chat, { modelRef: modelRefFrom(body.model), prepare: () => ({ anchorId: anchor.id, userMessage: null }) });
  });

  r.post('/api/chats/:id/messages/:mid/edit', async (ctx) => {
    const chat = app.chats.get(ctx.params.id);
    const m = chat.messages[ctx.params.mid];
    if (!m) throw notFound('Message');
    const body = await readJson(ctx.req, { limit: 8 * 1024 * 1024 });
    if (typeof body.content !== 'string') throw badRequest('content must be a string');
    if (m.role === 'user') {
      const atts = body.attachments === undefined ? (m.attachments || []) : attachmentRefs(app, body.attachments, chat.id);
      if (!body.content.trim() && !atts.length) throw badRequest('content or attachments required');
      if (body.generate === false) {
        const um = app.engine.createUserMessage(chat, { content: body.content, attachments: atts, parentId: m.parentId ?? null });
        um.editedFrom = m.id;
        await app.chats.saveNow(chat);
        return { message: publicMessage(um), path: activePath(chat).map((x) => x.id) };
      }
      await streamTurn(ctx, chat, {
        modelRef: modelRefFrom(body.model),
        prepare: () => {
          const um = app.engine.createUserMessage(chat, { content: body.content, attachments: atts, parentId: m.parentId ?? null });
          um.editedFrom = m.id;
          return { anchorId: um.id, userMessage: um };
        },
      });
      return;
    }
    if (m.role === 'assistant') {
      if (app.engine.busy(chat.id)) throw new HttpError(409, 'chat_busy', 'A generation is in progress for this chat');
      const nm = { ...m, id: newId('msg'), content: body.content, reasoning: '', toolCalls: undefined, editedFrom: m.id, edited: true, status: 'complete', createdAt: nowIso(), updatedAt: nowIso() };
      delete nm.activeChildId;
      delete nm.toolCalls;
      chat.messages[nm.id] = nm;
      setActiveLeaf(chat, nm.id);
      app.chats.touch(chat);
      await app.chats.saveNow(chat);
      return { message: publicMessage(nm), path: activePath(chat).map((x) => x.id) };
    }
    throw badRequest('Only user and assistant messages can be edited');
  });

  r.delete('/api/chats/:id/messages/:mid', async ({ params }) => {
    const chat = app.chats.get(params.id);
    if (!chat.messages[params.mid]) throw notFound('Message');
    if (app.engine.busy(chat.id)) throw new HttpError(409, 'chat_busy', 'A generation is in progress for this chat');
    const deleted = deleteSubtree(chat, params.mid);
    const set = new Set(deleted);
    chat.summaries = (chat.summaries || []).filter((s) => !set.has(s.upToMessageId));
    app.recall.removeMessages(deleted);
    app.chats.touch(chat);
    await app.chats.saveNow(chat);
    return { deleted, activeLeafId: chat.activeLeafId, path: activePath(chat).map((m) => m.id) };
  });

  r.post('/api/chats/:id/branch', async ({ req, params }) => {
    const chat = app.chats.get(params.id);
    const body = await readJson(req);
    if (!chat.messages[body.messageId]) throw notFound('Message');
    if (app.engine.busy(chat.id)) throw new HttpError(409, 'chat_busy', 'A generation is in progress for this chat');
    setActiveLeaf(chat, deepestLeaf(chat, body.messageId));
    app.chats.touch(chat);
    return { activeLeafId: chat.activeLeafId, path: activePath(chat).map((m) => m.id), summary: activeSummary(chat, activePath(chat)) || null };
  });

  r.post('/api/chats/:id/stop', ({ params }) => ({ stopped: app.engine.stop(app.chats.get(params.id).id) }));

  r.get('/api/chats/:id/context', async ({ params, query }) => app.engine.preview(app.chats.get(params.id), { draft: query.get('draft') || '' }));

  // ---- summary / compaction -----------------------------------------------------------------
  r.get('/api/chats/:id/summary', ({ params }) => {
    const chat = app.chats.get(params.id);
    const path = activePath(chat);
    const pos = new Map(path.map((m, i) => [m.id, i]));
    const onPath = (chat.summaries || []).filter((s) => pos.has(s.upToMessageId)).sort((a, b) => pos.get(a.upToMessageId) - pos.get(b.upToMessageId));
    const active = activeSummary(chat, path);
    return { summary: active || null, history: onPath, compactedMessageCount: active ? pos.get(active.upToMessageId) + 1 : 0, enabled: app.engine.effectiveSettings(chat).compaction?.enabled !== false, lastError: chat.compaction?.lastError || null };
  });

  r.put('/api/chats/:id/summary', async ({ req, params }) => {
    const chat = app.chats.get(params.id);
    const body = await readJson(req);
    if (typeof body.content !== 'string' || !body.content.trim()) throw badRequest('content must be a non-empty string');
    const s = activeSummary(chat, activePath(chat));
    if (!s) throw new HttpError(404, 'no_summary', 'This chat has no summary on the active branch yet');
    s.content = body.content.trim();
    s.editedByUser = true;
    s.updatedAt = nowIso();
    s.tokens = app.calibrator.counter('_', '_').text(s.content);
    app.chats.touch(chat);
    await app.chats.saveNow(chat);
    return { summary: s };
  });

  r.delete('/api/chats/:id/summary', async ({ params }) => {
    const chat = app.chats.get(params.id);
    const s = activeSummary(chat, activePath(chat));
    if (!s) throw new HttpError(404, 'no_summary', 'No summary on the active branch');
    chat.summaries = chat.summaries.filter((x) => x.id !== s.id);
    app.chats.touch(chat);
    await app.chats.saveNow(chat);
    return { removed: s.id, summary: activeSummary(chat, activePath(chat)) || null };
  });

  r.post('/api/chats/:id/compact', async ({ req, params }) => {
    const chat = app.chats.get(params.id);
    const body = await readJson(req, { optional: true });
    const r2 = await app.engine.compactNow(chat, { keepRecentMessages: body.keepRecentMessages });
    await app.chats.saveNow(chat);
    return r2;
  });

  r.post('/api/chats/:id/title', async ({ params }) => {
    const chat = app.chats.get(params.id);
    if (chat.titleSource === 'user') chat.titleSource = 'provisional';
    const title = await generateTitle(app, chat);
    return { title: title || chat.title, chat: chatSummary(chat) };
  });

  r.post('/api/chats/:id/fork', async ({ req, params }) => {
    const src = app.chats.get(params.id);
    const body = await readJson(req, { optional: true });
    const leafId = body.messageId || src.activeLeafId;
    if (!src.messages[leafId]) throw notFound('Message');
    const c = newChat({ title: `${src.title} (fork)`, settings: structuredClone(src.settings || {}), incognito: src.incognito });
    const idMap = new Map();
    let parent = null;
    for (const m of pathTo(src, leafId)) {
      const nm = { ...structuredClone(m), id: newId('msg'), parentId: parent, forkedFrom: m.id };
      delete nm.activeChildId;
      idMap.set(m.id, nm.id);
      c.messages[nm.id] = nm;
      parent = nm.id;
    }
    for (const s of src.summaries || []) if (idMap.has(s.upToMessageId)) c.summaries.push({ ...structuredClone(s), id: newId('sum'), upToMessageId: idMap.get(s.upToMessageId), previousSummaryId: null });
    c.titleSource = 'user';
    if (parent) setActiveLeaf(c, parent);
    await app.chats.insert(c);
    return created(chatDetail(app, c));
  });

  r.get('/api/chats/:id/export', async ({ params, query, res }) => {
    const chat = app.chats.get(params.id);
    const format = (query.get('format') || 'markdown').toLowerCase();
    const safe = (chat.title || 'chat').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'chat';
    if (format === 'json') {
      const body = await exportJson(chat, { gallery: app.gallery, embedImages: qBool(query.get('embedImages')) });
      sendJson(res, 200, body, { 'content-disposition': `attachment; filename="${safe}.json"` });
      return;
    }
    if (format !== 'markdown' && format !== 'md') throw badRequest('format must be markdown or json');
    const md = exportMarkdown(chat, { gallery: app.gallery });
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${safe}.md"`, 'cache-control': 'no-store' });
    res.end(md);
  });

  r.get('/api/search', ({ query }) => {
    const q = (query.get('q') || '').trim();
    if (!q) throw badRequest('q is required');
    return { query: q, results: searchChats(app, q, { limit: qInt(query.get('limit'), 50, { min: 1, max: 500 }) }) };
  });

  r.get('/api/export', async ({ res }) => {
    const body = await buildBackup(app);
    sendJson(res, 200, body, { 'content-disposition': `attachment; filename="harness-backup-${nowIso().slice(0, 10)}.json"` });
  });

}
