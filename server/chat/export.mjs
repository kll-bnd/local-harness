// Chat export (Markdown / JSON) and import (Harness JSON, OpenAI-style message arrays).
import { activePath } from './tree.mjs';
import { CHAT_VERSION } from '../store/chats.mjs';
import { sanitizeChat } from './sanitize.mjs';
import { nowIso } from '../lib/util.mjs';
import { badRequest } from '../lib/errors.mjs';

export function exportMarkdown(chat) {
  const lines = [`# ${chat.title || 'Chat'}`, '', `_Exported from Harness on ${new Date().toISOString().slice(0, 10)}_`, ''];
  const summ = chat.summaries?.length ? chat.summaries[chat.summaries.length - 1] : null;
  for (const m of activePath(chat)) {
    if (m.role === 'user') {
      lines.push('## User', '', m.kind === 'image_request' ? `*Image prompt:* ${m.content}` : m.content || '');
      if (m.attachments?.length) lines.push('', `_Attachments: ${m.attachments.map((a) => a.name || a.id).join(', ')}_`);
      lines.push('');
    } else if (m.role === 'assistant') {
      if (!m.content && !m.toolCalls?.length && !m.images?.length) continue;
      lines.push(`## Assistant${m.model?.model ? ` (${m.model.model})` : ''}`, '');
      if (m.content) lines.push(m.content, '');
      for (const tc of m.toolCalls || []) lines.push(`> Tool call: \`${tc.name}\` \`${JSON.stringify(tc.arguments)}\``, '');
      for (const img of m.images || []) lines.push(`![${(img.prompt || 'image').replace(/[[\]]/g, '')}](${img.url})`, '');
    } else if (m.role === 'tool') {
      lines.push(`> **${m.toolName}** → ${String(m.content || '').split('\n').join('\n> ')}`, '');
      for (const img of m.images || []) lines.push(`![${(img.prompt || 'image').replace(/[[\]]/g, '')}](${img.url})`, '');
    }
  }
  if (summ) lines.push('---', '', '<details><summary>Rolling summary (auto-compaction)</summary>', '', summ.content, '', '</details>', '');
  return lines.join('\n');
}

export async function exportJson(chat, { gallery, embedImages = false } = {}) {
  const { memoryCursor, recallCursor, ...rest } = chat;
  const messages = {};
  for (const [id, m] of Object.entries(rest.messages)) {
    const { _tokens, ...mm } = m;
    messages[id] = mm;
  }
  const out = { format: 'harness.chat', version: CHAT_VERSION, exportedAt: nowIso(), chat: { ...rest, messages } };
  if (embedImages && gallery) {
    out.images = {};
    for (const m of Object.values(messages)) {
      for (const ref of m.images || []) {
        const r = gallery.tryGet(ref.id);
        if (r) out.images[r.id] = { ...r, base64: (await gallery.read(r.id)).toString('base64') };
      }
    }
  }
  return out;
}

/**
 * Turn an import payload into sanitized chat objects. Every chat/message/summary id is newly minted (so an
 * imported id can never collide with or escape the data directory) and every field is validated/repaired.
 * Accepts {format:"harness.chat", chat}, {format:"harness.backup", chats:[...]} and {messages:[{role, content}]}.
 * @returns {{ chats: object[], maps: Array<{oldChatId, chat, idMap}>, skipped: number }}
 */
export function importPayload(body, { exists, refs = {} } = {}) {
  const raws = [];
  if (body?.format === 'harness.chat') raws.push(body.chat);
  else if (body?.format === 'harness.backup') {
    if (!Array.isArray(body.chats)) throw badRequest('harness.backup has no chats array');
    raws.push(...body.chats.slice(0, 100000));
  } else if (Array.isArray(body?.messages)) {
    const messages = {};
    let parent = null;
    let t = Date.now() - body.messages.length * 1000;
    body.messages.slice(0, 50000).forEach((raw, i) => {
      if (!raw || typeof raw !== 'object' || !['user', 'assistant'].includes(raw.role)) return;
      const content = typeof raw.content === 'string' ? raw.content : Array.isArray(raw.content) ? raw.content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n') : '';
      const id = `m${i}`;
      messages[id] = { id, parentId: parent, role: raw.role, content, createdAt: new Date((t += 1000)).toISOString(), status: 'complete' };
      parent = id;
    });
    raws.push({ title: typeof body.title === 'string' ? body.title : null, messages, activeLeafId: parent }); // no title → placeholder + auto-title
  } else throw badRequest('Unsupported import format: expected {format:"harness.chat"}, {format:"harness.backup"} or {messages:[...]}');
  const chats = [];
  const maps = [];
  let skipped = 0;
  const taken = new Set();
  for (const raw of raws) {
    const res = sanitizeChat(raw, { mintIds: true, exists: (id) => exists(id) || taken.has(id), refs });
    if (!res) { skipped++; continue; }
    taken.add(res.chat.id);
    chats.push(res.chat);
    maps.push({ oldChatId: raw?.id ?? null, chat: res.chat, idMap: res.idMap });
  }
  if (!chats.length) throw badRequest(raws.length === 1 ? 'Invalid chat in import (it needs a "messages" object)' : 'No valid chats in import');
  return { chats, maps, skipped };
}
