// Automatic chat titles.
import { activePath } from './tree.mjs';
import { titlePrompt } from './prompts.mjs';
import { stripThinking } from './reasoning.mjs';
import { truncateEnd } from '../lib/util.mjs';
import { chatSummary } from '../store/chats.mjs';

export function provisionalTitle(text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (!line) return 'New chat';
  const words = line.split(' ').slice(0, 8).join(' ');
  return truncateEnd(words, 60);
}

export function cleanTitle(raw) {
  let t = stripThinking(raw || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  t = t.replace(/^(title|chat title)\s*[:\-–]\s*/i, '').replace(/^["'“”‘’*#\s]+|["'“”‘’*\s]+$/g, '').replace(/[.。!]+$/, '').trim();
  return truncateEnd(t, 80);
}

export async function generateTitle(app, chat, { signal } = {}) {
  if (chat.titleSource === 'user') return null;
  const path = activePath(chat);
  const u = path.find((m) => m.role === 'user' && m.content?.trim());
  if (!u) return null;
  const a = path.find((m) => m.role === 'assistant' && m.content?.trim() && m.status === 'complete');
  const s = app.engine.effectiveSettings(chat);
  const out = await app.llm.complete({
    chat,
    ref: s.titles?.model || null,
    messages: [{ role: 'user', content: titlePrompt(truncateEnd(u.content.trim(), 1000), a ? truncateEnd(stripThinking(a.content).trim(), 400) : '') }],
    maxTokens: 24,
    temperature: 0.3,
    signal,
  });
  const title = cleanTitle(out);
  if (!title || chat.titleSource === 'user' || !app.chats.has(chat.id)) return null;
  chat.title = title;
  chat.titleSource = 'auto';
  app.chats.markDirty(chat);
  app.bus.publish('chat.updated', { chat: chatSummary(chat) });
  return title;
}
