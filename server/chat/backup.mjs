// Full backup → restore round trip in one zero-dependency JSON file:
//   { format: "harness.backup", version: 2, exportedAt, app, settings, presets, memories, chats,
//     attachments: [{...meta, base64}], images: [{...meta, base64}] }
// Restore merges into the current data (never overwrites silently): new ids for everything, references
// between chats, attachments and images remapped, memories/presets deduplicated, settings opt-in.
import { importPayload, exportJson } from './export.mjs';
import { sanitizeValue } from '../store/schema.mjs';
import { SETTINGS_SCHEMA, PARAMS_SCHEMA } from '../store/settings.mjs';
import { badRequest } from '../lib/errors.mjs';
import { nowIso, isPlainObject, clone } from '../lib/util.mjs';
import { sniffImageMime } from '../image/http.mjs';
import { MEMORY_CATEGORIES } from '../memory/memories.mjs';

export const BACKUP_VERSION = 2;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export async function buildBackup(app) {
  const chats = [];
  for (const c of app.chats.all()) chats.push((await exportJson(c)).chat);
  const attachments = [];
  for (const a of app.attachments.items.values()) {
    try { attachments.push({ ...a, base64: (await app.attachments.readOriginal(a.id)).toString('base64') }); } catch { /* file missing */ }
  }
  const images = [];
  for (const r of app.gallery.items.values()) {
    try { images.push({ ...r, base64: (await app.gallery.read(r.id)).toString('base64') }); } catch { /* file missing */ }
  }
  return {
    format: 'harness.backup', version: BACKUP_VERSION, exportedAt: nowIso(), app: { name: 'harness', version: app.version },
    settings: app.settings.get(), presets: app.presets.user, memories: app.memories.list({ limit: 1e7 }).items, chats, attachments, images,
  };
}

/** Settings a "safe" restore may bring back: never providers, network tools, origins or the Ollama launcher. */
function safeSettingsPatch(raw) {
  const { value } = sanitizeValue(SETTINGS_SCHEMA, raw);
  if (!value) return {};
  const v = clone(value);
  delete v.providers;
  delete v.security;
  delete v.version;
  if (v.ollama) { delete v.ollama.binaryPath; delete v.ollama.extraEnv; }
  if (v.image) { delete v.image.builtin; delete v.image.custom; delete v.image.providerId; }
  if (v.tools) { if (v.tools.builtin) delete v.tools.builtin.fetch_url; delete v.tools.fetchUrl; }
  for (const k of ['defaultModel']) if (v[k]?.providerId && v[k].providerId !== 'ollama') delete v[k];
  for (const k of ['compaction', 'memory', 'titles']) if (v[k]?.model?.providerId && v[k].model.providerId !== 'ollama') delete v[k].model;
  return v;
}

const decode = (b64) => {
  if (typeof b64 !== 'string') return null;
  const buf = Buffer.from(b64, 'base64');
  return buf.length && buf.length <= MAX_FILE_BYTES ? buf : null;
};

/**
 * @param {object} app
 * @param {object} backup  parsed backup (v1 or v2) or a harness.chat export
 * @param {object} opts    { chats=true, attachments=true, images=true, memories=true, presets=true, settings='skip'|'safe'|'full' }
 */
export async function restoreBackup(app, backup, opts = {}) {
  const o = { chats: true, attachments: true, images: true, memories: true, presets: true, settings: 'skip', ...opts };
  if (!isPlainObject(backup) || backup.format !== 'harness.backup') throw badRequest('Not a Harness backup (expected format "harness.backup")');
  if (!(backup.version === 1 || backup.version === BACKUP_VERSION)) throw badRequest(`Unsupported backup version ${backup.version}`);
  const report = { restored: { chats: 0, attachments: 0, images: 0, memories: 0, presets: 0, settings: 'skipped' }, skipped: { chats: 0, attachments: 0, images: 0, memories: 0, presets: 0 }, warnings: [], chats: [] };

  // 1. files first, so chats can point at the new ids
  const attMap = new Map();
  const attOld = new Map();
  if (o.attachments && Array.isArray(backup.attachments)) {
    for (const a of backup.attachments) {
      const buf = isPlainObject(a) ? decode(a.base64) : null;
      if (!buf) { report.skipped.attachments++; continue; }
      try {
        const rec = await app.attachments.create({ name: typeof a.name === 'string' ? a.name : 'file', mime: typeof a.mime === 'string' ? a.mime : null, buffer: buf });
        attMap.set(a.id, rec.id);
        attOld.set(rec.id, a);
        report.restored.attachments++;
      } catch { report.skipped.attachments++; }
    }
  }
  const imgMap = new Map();
  const imgOld = new Map();
  if (o.images && Array.isArray(backup.images)) {
    for (const r of backup.images) {
      const buf = isPlainObject(r) ? decode(r.base64) : null;
      const mime = buf ? sniffImageMime(buf) : null;
      if (!buf || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) { report.skipped.images++; continue; }
      const s = (v, n = 4000) => (typeof v === 'string' ? v.slice(0, n) : null);
      const n = (v) => (Number.isFinite(v) ? v : null);
      const meta = {
        prompt: s(r.prompt) || '', negativePrompt: s(r.negativePrompt) || '', seed: n(r.seed),
        params: isPlainObject(r.params) ? Object.fromEntries(Object.entries(r.params).filter(([, v]) => v === null || Number.isFinite(v) || typeof v === 'string').slice(0, 20)) : {},
        model: s(r.model, 300), providerId: s(r.providerId, 64), providerKind: s(r.providerKind, 20), family: s(r.family, 40),
        chatId: null, messageId: null, toolCallId: null, source: r.source === 'tool' ? 'tool' : 'user', jobId: null, initImage: null, restoredFrom: s(r.id, 80),
      };
      const rec = await app.gallery.add({ buffer: buf, mime, meta });
      imgMap.set(r.id, rec.id);
      imgOld.set(rec.id, r);
      report.restored.images++;
    }
  }

  // 2. chats (sanitized, new ids, file references remapped)
  if (o.chats && Array.isArray(backup.chats) && backup.chats.length) {
    let res;
    try {
      res = importPayload({ format: 'harness.backup', chats: backup.chats }, { exists: (id) => app.chats.has(id), refs: { attachments: attMap, images: imgMap } });
    } catch (e) {
      res = { chats: [], maps: [], skipped: backup.chats.length };
      report.warnings.push(e.message);
    }
    report.skipped.chats += res.skipped;
    const chatMap = new Map();
    for (const { oldChatId, chat, idMap } of res.maps) {
      await app.chats.insert(chat);
      chatMap.set(oldChatId, { id: chat.id, idMap });
      report.restored.chats++;
      report.chats.push(chat.id);
    }
    // re-link restored files to their restored chats/messages
    for (const [newId, old] of imgOld) {
      const c = chatMap.get(old.chatId);
      if (!c) continue;
      await app.gallery.update(newId, { chatId: c.id, messageId: c.idMap.get(old.messageId) || null });
    }
    for (const [newId, old] of attOld) {
      const c = chatMap.get(old.chatId);
      if (c) await app.attachments.assignChat(newId, c.id);
    }
  }

  // 3. memories: merged through the guarded path (secrets skipped, exact duplicates skipped, nothing overwritten)
  if (o.memories && Array.isArray(backup.memories)) {
    for (const m of backup.memories.slice(0, 100000)) {
      if (!isPlainObject(m) || typeof m.content !== 'string' || !m.content.trim()) { report.skipped.memories++; continue; }
      try {
        const r = await app.memories.add({ content: m.content, category: MEMORY_CATEGORIES.includes(m.category) ? m.category : 'other', pinned: m.pinned === true, origin: 'restore', dedupe: 'exact', needsReview: m.needsReview === true });
        if (r.action === 'added') report.restored.memories++; else report.skipped.memories++;
      } catch { report.skipped.memories++; }
    }
  }

  // 4. presets: added as new user presets unless an identical one exists
  if (o.presets && Array.isArray(backup.presets)) {
    const existing = app.presets.list();
    for (const p of backup.presets.slice(0, 1000)) {
      if (!isPlainObject(p) || typeof p.name !== 'string' || typeof p.systemPrompt !== 'string') { report.skipped.presets++; continue; }
      if (existing.some((e) => e.name === p.name && e.systemPrompt === p.systemPrompt)) { report.skipped.presets++; continue; }
      try {
        const params = sanitizeValue(PARAMS_SCHEMA, isPlainObject(p.params) ? p.params : {}).value || {};
        await app.presets.create({ name: p.name.slice(0, 100), systemPrompt: p.systemPrompt.slice(0, 50000), description: typeof p.description === 'string' ? p.description.slice(0, 500) : '', params });
        report.restored.presets++;
      } catch { report.skipped.presets++; }
    }
  }

  // 5. settings: only when asked; "safe" never restores providers / network tools / origins
  if (o.settings !== 'skip' && isPlainObject(backup.settings)) {
    if (o.settings === 'full') {
      const { value, dropped } = sanitizeValue(SETTINGS_SCHEMA, backup.settings);
      if (value) { delete value.version; await app.settings.patch(value); }
      if (dropped.length) report.warnings.push(`Ignored invalid settings: ${dropped.slice(0, 10).join(', ')}`);
      report.restored.settings = 'full';
    } else {
      await app.settings.patch(safeSettingsPatch(backup.settings));
      report.restored.settings = 'safe';
    }
    app.registry.sync();
    app.imageProviders.sync();
  }
  if (!o.memories && Array.isArray(backup.memories) && backup.memories.length) report.warnings.push('Memories were not restored (not requested).');
  return report;
}
