// Chat export (Markdown / JSON) and import (Harness JSON, OpenAI-style message arrays).
import { activePath, setActiveLeaf } from './tree.mjs';
import { newChat, CHAT_VERSION } from '../store/chats.mjs';
import { newId } from '../lib/ids.mjs';
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

/** Turn an import payload into one or more chat objects (ids regenerated where they collide). */
export function importPayload(body, { exists }) {
  const chats = [];
  const fromHarness = (c) => {
    if (!c || typeof c !== 'object' || !c.messages || typeof c.messages !== 'object') throw badRequest('Invalid chat in import');
    const chat = { ...newChat(), ...c };
    if (!chat.id || exists(chat.id)) chat.id = newId('chat');
    chat.summaries ||= [];
    chat.compaction ||= { lastError: null, lastErrorAt: null };
    for (const m of Object.values(chat.messages)) if (m.status === 'streaming') m.status = 'aborted';
    if (!chat.activeLeafId || !chat.messages[chat.activeLeafId]) {
      const last = Object.values(chat.messages).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (last) setActiveLeaf(chat, last.id);
    }
    chat.memoryCursor = null;
    chat.recallCursor = null;
    chat.updatedAt = nowIso();
    return chat;
  };
  if (body.format === 'harness.chat') chats.push(fromHarness(body.chat));
  else if (body.format === 'harness.backup') for (const c of body.chats || []) chats.push(fromHarness(c));
  else if (Array.isArray(body.messages)) {
    const chat = newChat({ title: typeof body.title === 'string' ? body.title.slice(0, 200) : 'Imported chat' });
    let parent = null;
    let t = Date.now() - body.messages.length * 1000;
    for (const raw of body.messages) {
      if (!raw || typeof raw !== 'object') continue;
      const role = ['user', 'assistant', 'system'].includes(raw.role) ? raw.role : null;
      if (!role || role === 'system') continue;
      const content = typeof raw.content === 'string' ? raw.content : Array.isArray(raw.content) ? raw.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : '';
      const m = { id: newId('msg'), parentId: parent, role, content, createdAt: new Date(t += 1000).toISOString(), status: 'complete' };
      chat.messages[m.id] = m;
      parent = m.id;
    }
    if (parent) setActiveLeaf(chat, parent);
    chats.push(chat);
  } else throw badRequest('Unsupported import format: expected {format:"harness.chat"}, {format:"harness.backup"} or {messages:[...]}');
  return chats;
}
