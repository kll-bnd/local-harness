// Attachment storage: attachments/<id>/original (+ text.txt), metadata in attachments/index.json,
// document chunks in a shared hybrid index (index/documents.json) for per-chat document RAG.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic, writeFileAtomic, ensureDir, removeFile } from '../lib/fsx.mjs';
import { newId, sha1 } from '../lib/ids.mjs';
import { nowIso } from '../lib/util.mjs';
import { notFound, badRequest } from '../lib/errors.mjs';
import { processUpload, chunkText } from '../docs/extract.mjs';
import { estimateTextTokens } from '../context/tokens.mjs';
import { HybridIndex } from '../memory/hybrid.mjs';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export class AttachmentStore {
  constructor({ dataDir, embedder, bus, settings }) {
    this.dir = path.join(dataDir, 'attachments');
    this.indexFile = path.join(this.dir, 'index.json');
    this.bus = bus;
    this.settingsStore = settings;
    this.items = new Map();
    this.docIndex = new HybridIndex({ file: path.join(dataDir, 'index', 'documents.json'), embedder });
    this._textCache = new Map();
  }

  async load() {
    await ensureDir(this.dir);
    const j = await readJson(this.indexFile, { version: 1, items: [] });
    for (const a of j.items || []) this.items.set(a.id, a);
    await this.docIndex.load();
    return this;
  }

  async saveIndex() { await writeJsonAtomic(this.indexFile, { version: 1, items: [...this.items.values()] }); }

  folder(id) { return path.join(this.dir, id); }

  get(id) {
    const a = this.items.get(id);
    if (!a) throw notFound('Attachment');
    return a;
  }

  tryGet(id) { return this.items.get(id) || null; }

  async create({ name, mime, buffer, chatId = null }) {
    if (!buffer?.length) throw badRequest('Empty upload');
    if (buffer.length > MAX_UPLOAD_BYTES) throw badRequest(`File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
    name = String(name || 'file').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200) || 'file';
    const r = processUpload(name, mime, buffer);
    const id = newId('att');
    await ensureDir(this.folder(id));
    await writeFileAtomic(path.join(this.folder(id), 'original'), buffer);
    const a = {
      id, name, mime: r.mime, size: buffer.length, kind: r.kind, status: r.kind === 'binary' ? 'error' : 'ready', error: r.error || null, warnings: r.warnings || [],
      chatId, createdAt: nowIso(), sha1: sha1(buffer.toString('base64')),
      width: r.width ?? null, height: r.height ?? null, pages: r.pages ?? null, source: r.source || null,
      tokens: null, chars: null, chunks: 0,
    };
    if (r.kind === 'text') {
      await writeFileAtomic(path.join(this.folder(id), 'text.txt'), r.text);
      a.tokens = estimateTextTokens(r.text);
      a.chars = r.text.length;
      this._textCache.set(id, r.text);
      const chunkTokens = this.settingsStore?.get().documents?.chunkTokens || 400;
      const chunks = chunkText(r.text, { targetTokens: chunkTokens, overlapTokens: Math.round(chunkTokens / 8) });
      a.chunks = chunks.length;
      for (const c of chunks) this.docIndex.upsert(`${id}:${c.n}`, c.text, { attachmentId: id, n: c.n, total: chunks.length, tokens: c.tokens });
      this.docIndex.ensureEmbeddings({ filter: (it) => it.meta.attachmentId === id }).then((n) => {
        if (n) this.bus?.publish('attachment.indexed', { attachmentId: id, embedded: n });
      }).catch(() => {});
    }
    this.items.set(id, a);
    await this.saveIndex();
    return a;
  }

  async assignChat(id, chatId) {
    const a = this.items.get(id);
    if (a && a.chatId !== chatId) { a.chatId = chatId; await this.saveIndex(); }
  }

  async readOriginal(id) {
    this.get(id);
    return fs.readFile(path.join(this.folder(id), 'original'));
  }

  async readText(id) {
    if (this._textCache.has(id)) return this._textCache.get(id);
    const a = this.get(id);
    if (a.kind !== 'text') return null;
    const t = await fs.readFile(path.join(this.folder(id), 'text.txt'), 'utf8').catch(() => null);
    if (t !== null) {
      this._textCache.set(id, t);
      if (this._textCache.size > 50) this._textCache.delete(this._textCache.keys().next().value);
    }
    return t;
  }

  async delete(id) {
    const a = this.get(id);
    this.items.delete(id);
    this._textCache.delete(id);
    this.docIndex.removeWhere((it) => it.meta?.attachmentId === id);
    await removeFile(this.folder(id));
    await this.saveIndex();
    return a;
  }

  async deleteForChat(chatId) {
    for (const a of [...this.items.values()]) if (a.chatId === chatId) await this.delete(a.id);
  }

  /** Retrieve document chunks for `attachmentIds` relevant to `query`. */
  searchDocuments(query, attachmentIds, { k = 6, queryVector = null, minSimilarity = 0.35 } = {}) {
    const set = new Set(attachmentIds);
    return this.docIndex.search(query, { k, queryVector, minSimilarity, minLexical: 0.08, filter: (it) => it && set.has(it.meta?.attachmentId) });
  }
}

/** Public JSON for an attachment record. */
export function publicAttachment(a) {
  return { ...a, url: `/api/attachments/${a.id}/content` };
}
