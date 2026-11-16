// Background long-term memory extraction after assistant turns.
import { activePath } from '../chat/tree.mjs';
import { memorySystemPrompt, memoryUserPrompt, MEMORY_SCHEMA } from '../chat/prompts.mjs';
import { parseJsonLoose } from '../chat/llm.mjs';
import { looksLikeSecret, MEMORY_CATEGORIES } from './memories.mjs';
import { truncateEnd } from '../lib/util.mjs';
import { estimateTextTokens } from '../context/tokens.mjs';

/**
 * Extract memories from the messages added since the chat's memory cursor.
 * @returns {{ added: object[], updated: object[], skipped: string[] }}
 */
export async function extractMemories(app, chat, { signal } = {}) {
  const res = { added: [], updated: [], skipped: [] };
  const s = app.engine.effectiveSettings(chat);
  if (chat.incognito || s.memory?.enabled === false || s.memory?.autoExtract === false) return res;
  const path = activePath(chat).filter((m) => m.status !== 'streaming');
  if (!path.length) return res;
  let start = 0;
  if (chat.memoryCursor) {
    const i = path.findIndex((m) => m.id === chat.memoryCursor);
    start = i >= 0 ? i + 1 : Math.max(0, path.length - 6);
  }
  const fresh = path.slice(start).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim() && m.kind !== 'image_request' && m.kind !== 'image_result');
  if (!fresh.some((m) => m.role === 'user')) { chat.memoryCursor = path[path.length - 1].id; return res; }
  // Keep the newest lines within ~40% of the model's window (the rest is prompt + existing memories + reply).
  const target = await app.llm.resolveFor(s.memory?.model || null, chat);
  const maxTokens = Math.max(256, Math.floor(target.numCtx * 0.4));
  const lines = [];
  let used = 0;
  for (const m of [...fresh].reverse()) {
    const line = m.role === 'user' ? `User: ${truncateEnd(m.content.trim(), 2000)}` : `Assistant: ${truncateEnd(m.content.trim(), 400)}`;
    const cost = estimateTextTokens(line) + 4;
    if (used + cost > maxTokens && lines.length) break;
    lines.unshift(line);
    used += cost;
  }
  const transcript = lines.join('\n\n');
  const userText = fresh.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const all = app.memories.list({ limit: 1000 }).items;
  let existing = all.length <= 30 ? all : app.memories.search(userText, { k: 12, minSimilarity: 0.3 }).map((r) => r.memory);
  existing = existing.slice(0, 30);

  const out = await app.llm.complete({
    chat,
    ref: s.memory?.model || null,
    messages: [{ role: 'system', content: memorySystemPrompt() }, { role: 'user', content: memoryUserPrompt(existing, transcript) }],
    maxTokens: 500,
    temperature: 0.1,
    format: MEMORY_SCHEMA,
    signal,
  });
  const parsed = parseJsonLoose(out);
  const ops = Array.isArray(parsed?.memories) ? parsed.memories : [];
  const lastId = path[path.length - 1].id;
  for (const op of ops.slice(0, 10)) {
    const content = typeof op?.content === 'string' ? op.content.trim() : '';
    if (content.length < 8 || content.length > 500) { res.skipped.push(content || '(empty)'); continue; }
    if (looksLikeSecret(content)) { res.skipped.push('(secret)'); continue; }
    const category = MEMORY_CATEGORIES.includes(op.category) ? op.category : 'other';
    const target = op.action === 'update' && op.id ? app.memories.items.get(op.id) : null;
    if (target && !target.pinned && target.origin !== 'manual') {
      const m = await app.memories.update(op.id, { content, category }, { source: { chatId: chat.id, messageId: lastId }, origin: 'auto' }).catch(() => null);
      if (m) res.updated.push(m); else res.skipped.push(content);
    } else {
      const r = await app.memories.add({ content, category, origin: 'auto', source: { chatId: chat.id, messageId: lastId } });
      if (r.action === 'added') res.added.push(r.memory);
      else if (r.action === 'updated') res.updated.push(r.memory);
    }
  }
  chat.memoryCursor = lastId;
  app.chats.markDirty(chat);
  if (res.added.length || res.updated.length) app.bus.publish('memory.extracted', { chatId: chat.id, added: res.added, updated: res.updated });
  return res;
}
