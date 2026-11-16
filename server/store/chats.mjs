// Chat persistence: one JSON file per chat (chats/<id>.json), all loaded in memory, debounced atomic writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeFileAtomic, waitForWrites, ensureDir, removeFile } from '../lib/fsx.mjs';
import { newId, assertSafeId, isSafeId } from '../lib/ids.mjs';
import { nowIso, truncateEnd, isPlainObject } from '../lib/util.mjs';
import { notFound } from '../lib/errors.mjs';
import { activePath, children } from '../chat/tree.mjs';
import { log } from '../lib/log.mjs';
import { sanitizeChat } from '../chat/sanitize.mjs';

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
    this.deleted = new Set(); // tombstones: a queued/in-flight write must never resurrect a deleted chat
  }

  async load() {
    await ensureDir(this.dir);
    const files = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const full = path.join(this.dir, f);
      const raw = await readJson(full, null);
      if (raw && isPlainObject(raw.messages)) {
        // Generations interrupted by a crash/restart.
        for (const m of Object.values(raw.messages)) {
          if (isPlainObject(m) && (m.status === 'streaming' || m.status === 'pending')) { m.status = 'aborted'; m.error = m.error || 'Interrupted (server restarted)'; }
        }
      }
      // Validate/repair: a single bad file must never poison the chat list (or the search) for good.
      const fileId = f.slice(0, -5);
      const res = raw ? sanitizeChat({ ...raw, id: isSafeId(raw.id, 'chat') ? raw.id : fileId }, { exists: (id) => this.chats.has(id) }) : null;
      if (!res) {
        const bad = `${full}.invalid-${Date.now()}`;
        await fs.rename(full, bad).catch(() => {});
        log.warn(`Ignored unreadable chat file ${f} (moved to ${path.basename(bad)})`);
        continue;
      }
      const c = res.chat;
      this.chats.set(c.id, c);
      if (`${c.id}.json` !== f) {
        await this.saveNow(c);
        await removeFile(full);
        log.warn(`Chat file ${f} had an invalid id; saved as ${c.id}.json`);
      } else if (res.report.droppedMessages || res.report.reparented || res.report.changedIds || JSON.stringify(raw) !== JSON.stringify(c)) {
        this.markDirty(c);
      }
    }
    log.debug(`Loaded ${this.chats.size} chats`);
    return this;
  }

  file(id) {
    assertSafeId(id, 'chat');
    return path.join(this.dir, `${id}.json`);
  }

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

  /** Insert a fully-formed chat (import / fork). The caller must have sanitized it (fresh, safe id). */
  async insert(chat) {
    assertSafeId(chat.id, 'chat');
    if (this.chats.has(chat.id)) throw new Error(`chat ${chat.id} already exists`);
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
    if (this.dirty.has(chat.id) || this.deleted.has(chat.id)) return;
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
    if (!this.chats.has(chat.id) || this.deleted.has(chat.id)) return;
    const id = chat.id;
    // Serialized at write time (latest state); skipped if the chat is deleted before the rename.
    await writeFileAtomic(this.file(id), () => JSON.stringify(chat) + '\n', { abortIf: () => this.deleted.has(id) || this.chats.get(id) !== chat });
  }

  async flush() {
    const pending = [...this.dirty.keys()];
    await Promise.all(pending.map((id) => this.chats.get(id) && this.saveNow(this.chats.get(id))));
  }

  async delete(id) {
    const c = this.get(id);
    const t = this.dirty.get(id);
    if (t) { clearTimeout(t); this.dirty.delete(id); }
    this.deleted.add(id);
    this.chats.delete(id);
    const file = this.file(id);
    await waitForWrites(file); // drain in-flight writes (they see the tombstone and skip the rename)
    await removeFile(file);
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
    const items = [];
    for (const c of arr.slice(offset, offset + limit)) {
      try { items.push(chatSummary(c)); } catch (e) { log.warn(`chat ${c.id} could not be summarized: ${e.message}`); }
    }
    return { total: arr.length, items };
  }
}

export function chatSummary(c, extra = {}) {
  const path = activePath(c);
  const last = [...path].reverse().find((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content);
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
