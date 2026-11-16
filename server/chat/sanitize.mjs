// Validation / repair of chat objects coming from outside (import, backup restore) or from disk (load).
//
// - Only whitelisted fields survive, with the right types; everything else is dropped.
// - Ids: with `mintIds` (import/restore) every chat, message and summary id is new and all references are
//   remapped, so an imported id can never collide with, or point outside of, the data directory.
//   Without it (load), ids are kept when well-formed and re-minted otherwise.
// - The message tree is repaired: dangling parents become roots, cycles are broken, the active leaf is valid.
// - Attachment / image references can be remapped (backup restore) via `refs`.
import { newId, isSafeId } from '../lib/ids.mjs';
import { isPlainObject, nowIso } from '../lib/util.mjs';
import { setActiveLeaf } from './tree.mjs';
import { CHAT_SETTINGS_SCHEMA } from '../store/settings.mjs';
import { sanitizeValue } from '../store/schema.mjs';

const CHAT_VERSION = 1;
const ROLES = new Set(['user', 'assistant', 'tool']);
const STATUSES = new Set(['complete', 'aborted', 'error', 'running']);
const KINDS = new Set(['image_request', 'image_result']);
// 'import': the title came with an imported chat — like 'user', it is never replaced by auto-titling.
const TITLE_SOURCES = new Set(['auto', 'user', 'provisional', 'import']);
const MAX_CONTENT = 5 * 1024 * 1024;
const MAX_MESSAGES = 50000;

const str = (v, max = 10000) => (typeof v === 'string' ? v.slice(0, max) : null);

function text(v) {
  if (typeof v === 'string') return v.slice(0, MAX_CONTENT);
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null; // objects/arrays: not repairable
}

function isoDate(v, fallback) {
  if (typeof v === 'string' && v.length <= 40) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return fallback;
}

function finiteOrNull(v) { return Number.isFinite(v) ? v : null; }

function modelRef(v) {
  if (!isPlainObject(v) || typeof v.model !== 'string' || !v.model || v.model.length > 300) return undefined;
  const out = { model: v.model };
  if (typeof v.providerId === 'string' && v.providerId.length <= 64) out.providerId = v.providerId;
  if (v.kind === 'image') out.kind = 'image';
  return out;
}

/** Tool-call arguments are stored (and replayed to Ollama) as an object; OpenAI-style JSON strings are parsed. */
function argsOf(a) {
  let v = a;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = { value: v.slice(0, 2000) }; } }
  return isPlainObject(v) ? (jsonSmall(v) ?? {}) : {};
}

function jsonSmall(v, max = 20000) {
  try { const s = JSON.stringify(v); return s !== undefined && s.length <= max ? JSON.parse(s) : undefined; } catch { return undefined; }
}

function mapRef(id, map) {
  if (map && map.has(id)) return map.get(id);
  return isSafeId(id) ? id : null;
}

function attachmentRefs(list, map) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, 20)) {
    if (!isPlainObject(a)) continue;
    const id = mapRef(a.id, map);
    if (!id) continue;
    out.push({ id, name: str(a.name, 300) || 'file', kind: str(a.kind, 20) || 'text', mime: str(a.mime, 200) || 'application/octet-stream', size: finiteOrNull(a.size) ?? 0 });
  }
  return out;
}

function imageRefs(list, map) {
  if (!Array.isArray(list)) return undefined;
  const out = [];
  for (const r of list.slice(0, 16)) {
    if (!isPlainObject(r)) continue;
    const id = mapRef(r.id, map);
    if (!id) continue;
    out.push({ id, url: `/api/images/${id}/file`, width: finiteOrNull(r.width), height: finiteOrNull(r.height), mime: str(r.mime, 50) || 'image/png', prompt: str(r.prompt, 4000) || '', seed: finiteOrNull(r.seed), model: str(r.model, 300), providerId: str(r.providerId, 64) });
  }
  return out;
}

function toolCalls(list) {
  if (!Array.isArray(list)) return undefined;
  const out = [];
  for (const c of list.slice(0, 32)) {
    if (!isPlainObject(c) || typeof c.name !== 'string') continue;
    out.push({ id: str(c.id, 100) || newId('call'), name: c.name.slice(0, 100), arguments: argsOf(c.arguments) });
  }
  return out.length ? out : undefined;
}

function cleanMessage(raw, fallbackDate) {
  if (!isPlainObject(raw) || !ROLES.has(raw.role)) return null;
  const content = text(raw.content);
  if (content === null) return null;
  const m = {
    id: raw.id,
    parentId: raw.parentId ?? null,
    role: raw.role,
    content,
    createdAt: isoDate(raw.createdAt, fallbackDate),
    status: raw.status === 'streaming' || raw.status === 'pending' ? 'aborted' : STATUSES.has(raw.status) ? raw.status : 'complete',
  };
  const upd = isoDate(raw.updatedAt, null);
  if (upd) m.updatedAt = upd;
  if (KINDS.has(raw.kind)) m.kind = raw.kind;
  if (raw.activeChildId) m.activeChildId = raw.activeChildId;
  if (raw.editedFrom) m.editedFrom = raw.editedFrom;
  if (raw.edited === true) m.edited = true;
  if (m.role === 'user') {
    m.attachments = raw.attachments;
    if (m.kind === 'image_request' && isPlainObject(raw.imageRequest)) m.imageRequest = jsonSmall(raw.imageRequest, 10000);
  }
  if (m.role === 'assistant') {
    m.reasoning = typeof raw.reasoning === 'string' ? raw.reasoning.slice(0, MAX_CONTENT) : '';
    const mr = modelRef(raw.model);
    if (mr) m.model = mr;
    const tc = toolCalls(raw.toolCalls);
    if (tc) m.toolCalls = tc;
    if (['length', 'tool_limit', 'aborted'].includes(raw.finishReason)) m.finishReason = raw.finishReason;
    if (typeof raw.error === 'string') m.error = raw.error.slice(0, 2000);
    if (typeof raw.errorCode === 'string' && /^[a-z_]{1,40}$/.test(raw.errorCode)) m.errorCode = raw.errorCode;
    if (Array.isArray(raw.nextSteps)) { const ns = jsonSmall(raw.nextSteps.slice(0, 5), 4000); if (ns) m.nextSteps = ns; }
    if (['image', 'tool_summary'].includes(raw.fallback)) m.fallback = raw.fallback;
    if (m.kind === 'image_result') m.images = raw.images;
    for (const k of ['usage', 'stats', 'context']) { const v = isPlainObject(raw[k]) ? jsonSmall(raw[k], 20000) : undefined; if (v) m[k] = v; }
  }
  if (m.role === 'tool') {
    m.toolCallId = str(raw.toolCallId, 100) || '';
    m.toolName = str(raw.toolName, 100) || 'tool';
    m.isError = raw.isError === true;
    if (raw.images) m.images = raw.images;
    const d = raw.data !== undefined ? jsonSmall(raw.data) : undefined;
    if (d !== undefined) m.data = d;
    if (Number.isFinite(raw.durationMs)) m.durationMs = raw.durationMs;
  }
  return m;
}

/**
 * @param {any} raw chat-like object
 * @param {object} o
 * @param {boolean} [o.mintIds=false] always assign new ids (import/restore)
 * @param {(id:string)=>boolean} [o.exists] chat id already taken
 * @param {{attachments?: Map, images?: Map}} [o.refs] old → new ids for referenced files
 * @returns {{ chat: object, report: { droppedMessages: number, reparented: number, changedIds: number } } | null}
 */
/** An imported chat that brings its own title keeps it ('import'); only untitled / provisional ones get auto-titled. */
function titleSourceOf(raw, imported) {
  const src = TITLE_SOURCES.has(raw.titleSource) ? raw.titleSource : null;
  if (!imported || src === 'user' || src === 'auto' || src === 'import' || src === 'provisional') return src;
  return typeof raw.title === 'string' && raw.title.trim() ? 'import' : null;
}

export function sanitizeChat(raw, { mintIds = false, exists = () => false, refs = {} } = {}) {
  if (!isPlainObject(raw) || !isPlainObject(raw.messages)) return null;
  const report = { droppedMessages: 0, reparented: 0, changedIds: 0 };
  const now = nowIso();
  const entries = Object.entries(raw.messages).slice(0, MAX_MESSAGES);
  const base = Date.now() - entries.length * 1000;
  const msgs = [];
  entries.forEach(([key, v], i) => {
    const m = cleanMessage(v, new Date(base + i * 1000).toISOString());
    if (!m) { report.droppedMessages++; return; }
    if (typeof m.id !== 'string') m.id = key;
    msgs.push(m);
  });
  // id map (old → new)
  const idMap = new Map();
  const seen = new Set();
  for (const m of msgs) {
    const old = m.id;
    let id = old;
    if (mintIds || !isSafeId(old, 'msg') || seen.has(old)) { id = newId('msg'); if (id !== old) report.changedIds++; }
    seen.add(id);
    if (!idMap.has(old)) idMap.set(old, id);
    m.id = id;
    m._old = old;
  }
  const byOld = new Map(msgs.map((m) => [m._old, m]));
  // dropped messages: children are re-attached to the dropped message's parent when possible
  const rawById = new Map(entries.map(([k, v]) => [isPlainObject(v) && typeof v.id === 'string' ? v.id : k, v]));
  const resolveParent = (pid) => {
    const guard = new Set();
    while (pid != null && !byOld.has(pid)) {
      if (guard.has(pid)) return null;
      guard.add(pid);
      const r = rawById.get(pid);
      pid = isPlainObject(r) ? r.parentId ?? null : null;
      report.reparented++;
    }
    return pid == null ? null : byOld.get(pid).id;
  };
  const messages = {};
  for (const m of msgs) {
    m.parentId = m.parentId == null ? null : resolveParent(m.parentId);
    if (m.activeChildId) m.activeChildId = idMap.get(m.activeChildId) || undefined;
    if (!m.activeChildId) delete m.activeChildId;
    if (m.editedFrom) m.editedFrom = idMap.get(m.editedFrom) || undefined;
    if (!m.editedFrom) delete m.editedFrom;
    if (m.role === 'user') m.attachments = attachmentRefs(m.attachments, refs.attachments);
    if (m.images !== undefined) { const im = imageRefs(m.images, refs.images); if (im) m.images = im; else delete m.images; }
    delete m._old;
    messages[m.id] = m;
  }
  // break cycles
  for (const m of Object.values(messages)) {
    const path = new Set([m.id]);
    let cur = m.parentId ? messages[m.parentId] : null;
    while (cur) {
      if (path.has(cur.id)) { cur.parentId = null; report.reparented++; break; }
      path.add(cur.id);
      cur = cur.parentId ? messages[cur.parentId] : null;
    }
  }
  let chatId = raw.id;
  if (mintIds || !isSafeId(chatId, 'chat') || exists(chatId)) chatId = newId('chat');
  const settingsIn = isPlainObject(raw.settings) ? sanitizeValue(CHAT_SETTINGS_SCHEMA, raw.settings).value : undefined;
  const chat = {
    version: CHAT_VERSION,
    id: chatId,
    title: (typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'Imported chat').slice(0, 200),
    titleSource: titleSourceOf(raw, mintIds),
    createdAt: isoDate(raw.createdAt, now),
    updatedAt: isoDate(raw.updatedAt, now),
    pinned: raw.pinned === true,
    archived: raw.archived === true,
    incognito: raw.incognito === true,
    settings: settingsIn || {},
    messages,
    activeRootId: null,
    activeLeafId: null,
    summaries: [],
    compaction: { lastError: null, lastErrorAt: null },
    memoryCursor: mintIds ? null : idMap.get(raw.memoryCursor) || null,
    recallCursor: null,
  };
  if (!mintIds && isPlainObject(raw.compaction)) chat.compaction = { lastError: str(raw.compaction.lastError, 2000), lastErrorAt: isoDate(raw.compaction.lastErrorAt, null) };
  // summaries
  const sumMap = new Map();
  for (const s of Array.isArray(raw.summaries) ? raw.summaries.slice(0, 500) : []) {
    if (!isPlainObject(s) || typeof s.content !== 'string') continue;
    const up = idMap.get(s.upToMessageId);
    if (!up || !messages[up]) continue;
    const id = !mintIds && isSafeId(s.id, 'sum') ? s.id : newId('sum');
    sumMap.set(s.id, id);
    chat.summaries.push({
      id, upToMessageId: up, previousSummaryId: s.previousSummaryId ?? null, content: s.content.slice(0, 200000),
      tokens: finiteOrNull(s.tokens) ?? 0, messagesCovered: finiteOrNull(s.messagesCovered) ?? 0, method: str(s.method, 40) || 'imported',
      model: str(s.model, 300), editedByUser: s.editedByUser === true, createdAt: isoDate(s.createdAt, now), updatedAt: isoDate(s.updatedAt, now),
    });
  }
  for (const s of chat.summaries) s.previousSummaryId = sumMap.get(s.previousSummaryId) || null;
  // active branch
  const leaf = idMap.get(raw.activeLeafId);
  if (leaf && messages[leaf]) setActiveLeaf(chat, leaf);
  else {
    const newest = Object.values(messages).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (newest) setActiveLeaf(chat, newest.id);
  }
  return { chat, report, idMap };
}
