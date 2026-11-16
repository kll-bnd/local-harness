// Cross-chat recall: indexes past user→assistant exchanges so relevant snippets from other chats can be retrieved.
import path from 'node:path';
import { HybridIndex } from './hybrid.mjs';
import { activePath } from '../chat/tree.mjs';
import { truncateEnd } from '../lib/util.mjs';

export class RecallIndex {
  constructor({ dataDir, embedder, chats }) {
    this.chats = chats;
    this.index = new HybridIndex({ file: path.join(dataDir, 'index', 'recall.json'), embedder });
  }

  async load() { await this.index.load(); return this; }

  /** Index exchanges on the chat's active path (idempotent). Returns number of new/changed chunks. */
  indexChat(chat) {
    if (chat.incognito) { this.removeChat(chat.id); return 0; }
    const p = activePath(chat);
    let n = 0;
    for (let i = 0; i < p.length; i++) {
      const u = p[i];
      if (u.role !== 'user' || !u.content?.trim() || u.kind === 'image_request') continue;
      // final assistant answer of this turn
      let a = null;
      for (let j = i + 1; j < p.length && p[j].role !== 'user'; j++) if (p[j].role === 'assistant' && p[j].content?.trim() && p[j].status === 'complete') a = p[j];
      if (!a) continue;
      const text = `User: ${truncateEnd(u.content.trim(), 1200)}\nAssistant: ${truncateEnd(a.content.trim(), 1200)}`;
      const existing = this.index.items.get(a.id);
      if (existing && existing.text === text) continue;
      this.index.upsert(a.id, text, { chatId: chat.id, userMessageId: u.id, assistantMessageId: a.id, createdAt: a.createdAt });
      n++;
    }
    return n;
  }

  removeChat(chatId) { return this.index.removeWhere((it) => it.meta?.chatId === chatId); }

  removeMessages(ids) {
    const set = new Set(ids);
    return this.index.removeWhere((it) => set.has(it.id) || set.has(it.meta?.userMessageId));
  }

  search(query, { k = 3, queryVector = null, excludeChatId = null, minSimilarity = 0.6 } = {}) {
    const hits = this.index.search(query, {
      k,
      queryVector,
      minSimilarity,
      minLexical: 0.3,
      filter: (it) => it && it.meta?.chatId !== excludeChatId && this.chats.has(it.meta?.chatId) && !this.chats.get(it.meta.chatId).incognito,
    });
    return hits.map((h) => {
      const chat = this.chats.has(h.item.meta.chatId) ? this.chats.get(h.item.meta.chatId) : null;
      return { id: h.id, chatId: h.item.meta.chatId, chatTitle: chat?.title || 'Untitled', date: (h.item.meta.createdAt || '').slice(0, 10), text: h.item.text, score: Math.round(h.score * 1000) / 1000 };
    });
  }
}
