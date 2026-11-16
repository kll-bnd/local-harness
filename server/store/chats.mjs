// Chat persistence: one JSON file per chat (chats/<id>.json), all loaded in memory, debounced atomic writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic, ensureDir, removeFile } from '../lib/fsx.mjs';
import { newId } from '../lib/ids.mjs';
import { nowIso, truncateEnd } from '../lib/util.mjs';
import { notFound } from '../lib/errors.mjs';
import { activePath, children } from '../chat/tree.mjs';
import { log } from '../lib/log.mjs';

export const CHAT_VERSION = 1;

export function newChat({ title = null, settings = {}, incognito = false } = {}) {
  const now = nowIso();
  return {
    version: CHAT_VERSION,
    id: newId('chat'),
    title: title || 'New chat',
    titleSource: title ? 'user' : null,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    archived: false,
    incognito: !!incognito,
    settings: settings || {},
    messages: {},
    activeRootId: null,
    activeLeafId: null,
    summaries: [],
    compaction: { lastError: null, lastErrorAt: null },
    memoryCursor: null,
    recallCursor: null,
  };
}

export class ChatStore {
  constructor(dataDir, bus) {
    this.dir = path.join(dataDir, 'chats');
    this.bus = bus;
    this.chats = new Map();
    this.dirty = new Map();
  }

  async load() {
    await ensureDir(this.dir);
    const files = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const c = await readJson(path.join(this.dir, f), null);
      if (!c?.id || !c.messages) continue;
      // Generations interrupted by a crash/restart.
      let fixed = false;
      for (const m of Object.values(c.messages)) {
        if (m.status === 'streaming' || m.status === 'pending') { m.status = 'aborted'; m.error = m.error || 'Interrupted (server restarted)'; fixed = true; }
      }
      c.summaries ||= [];
      c.compaction ||= { lastError: null, lastErrorAt: null };
      this.chats.set(c.id, c);
      if (fixed) this.markDirty(c);
    }
    log.debug(`Loaded ${this.chats.size} chats`);
    return this;
  }

  file(id) { return path.join(this.dir, `${id}.json`); }

  get(id) {
    const c = this.chats.get(id);
    if (!c) throw notFound('Chat');
    return c;
  }

  has(id) { return this.chats.has(id); }

  all() { return [...this.chats.values()]; }

  async create(opts) {
    const c = newChat(opts);
    this.chats.set(c.id, c);
    await this.saveNow(c);
    this.bus?.publish('chat.created', { chat: chatSummary(c) });
    return c;
  }

  /** Insert a fully-formed chat (import / fork). */
  async insert(chat) {
    this.chats.set(chat.id, chat);
    await this.saveNow(chat);
    this.bus?.publish('chat.created', { chat: chatSummary(chat) });
    return chat;
  }

  touch(chat) {
    chat.updatedAt = nowIso();
    this.markDirty(chat);
  }

  markDirty(chat) {
    if (this.dirty.has(chat.id)) return;
    const t = setTimeout(() => {
      this.dirty.delete(chat.id);
      this.saveNow(chat).catch((e) => log.error('chat save failed', e));
    }, 150);
    t.unref?.();
    this.dirty.set(chat.id, t);
  }

  async saveNow(chat) {
    const t = this.dirty.get(chat.id);
    if (t) { clearTimeout(t); this.dirty.delete(chat.id); }
    if (!this.chats.has(chat.id)) return;
    await writeJsonAtomic(this.file(chat.id), chat, { pretty: false });
  }

  async flush() {
    const pending = [...this.dirty.keys()];
    await Promise.all(pending.map((id) => this.chats.get(id) && this.saveNow(this.chats.get(id))));
  }

  async delete(id) {
    const c = this.get(id);
    const t = this.dirty.get(id);
    if (t) { clearTimeout(t); this.dirty.delete(id); }
    this.chats.delete(id);
    await removeFile(this.file(id));
    this.bus?.publish('chat.deleted', { chatId: id });
    return c;
  }

  list({ archived = false, q = null, limit = 200, offset = 0 } = {}) {
    let arr = this.all();
    if (archived !== 'all') arr = arr.filter((c) => !!c.archived === !!archived);
    if (q) {
      const needle = q.toLowerCase();
      arr = arr.filter((c) => (c.title || '').toLowerCase().includes(needle));
    }
    arr.sort((a, b) => (b.pinned - a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
    return { total: arr.length, items: arr.slice(offset, offset + limit).map(chatSummary) };
  }
}

export function chatSummary(c, extra = {}) {
  const path = activePath(c);
  const last = [...path].reverse().find((m) => (m.role === 'user' || m.role === 'assistant') && m.content);
  const lastModel = [...path].reverse().find((m) => m.role === 'assistant' && m.model)?.model || null;
  return {
    id: c.id,
    title: c.title,
    titleSource: c.titleSource,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    pinned: !!c.pinned,
    archived: !!c.archived,
    incognito: !!c.incognito,
    messageCount: Object.keys(c.messages).length,
    preview: last ? truncateEnd(last.content.replace(/\s+/g, ' '), 140) : '',
    model: c.settings?.model || lastModel || null,
    ...extra,
  };
}

/** Serialize a message for the API (adds childIds / siblingIds). */
export function serializeMessages(chat) {
  const kids = new Map();
  for (const m of Object.values(chat.messages)) {
    const k = m.parentId ?? '__root__';
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(m);
  }
  for (const arr of kids.values()) arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return Object.values(chat.messages)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((m) => ({
      ...publicMessage(m),
      childIds: (kids.get(m.id) || []).map((x) => x.id),
      siblingIds: (kids.get(m.parentId ?? '__root__') || []).map((x) => x.id),
    }));
}

/** Strip internal fields from a stored message. */
export function publicMessage(m) {
  const { activeChildId, _tokens, ...rest } = m;
  return rest;
}

export { children };
