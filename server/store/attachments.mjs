// Attachment storage: attachments/<id>/original (+ text.txt), metadata in attachments/index.json,
// document chunks in a shared hybrid index (index/documents.json) for per-chat document RAG.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic, writeFileAtomic, ensureDir, removeFile } from '../lib/fsx.mjs';
import { newId, sha1, assertSafeId, isSafeId } from '../lib/ids.mjs';
import { Worker } from 'node:worker_threads';
import { nowIso } from '../lib/util.mjs';
import { notFound, badRequest } from '../lib/errors.mjs';
import { processUpload, chunkText } from '../docs/extract.mjs';
import { estimateTextTokens } from '../context/tokens.mjs';
import { HybridIndex } from '../memory/hybrid.mjs';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const INLINE_EXTRACT_MAX = 256 * 1024; // larger files are extracted/chunked in a worker thread
const TEXT_CACHE_MAX_ENTRIES = 50;
const TEXT_CACHE_MAX_CHARS = 32 * 1024 * 1024;

/** Run extract-worker.mjs with memory limits and a timeout; resolves { result, chunks } or rejects. */
export function runExtractWorker(data, { timeoutMs = 30000, maxOldGenerationSizeMb = 384 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../docs/extract-worker.mjs', import.meta.url), {
      workerData: data,
      resourceLimits: { maxOldGenerationSizeMb, maxYoungGenerationSizeMb: 48, stackSizeMb: 8 },
    });
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); worker.terminate().catch(() => {}); fn(v); };
    const timer = setTimeout(() => finish(reject, new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    worker.once('message', (m) => (m?.ok ? finish(resolve, { result: m.result, chunks: m.chunks || [] }) : finish(reject, new Error(m?.error || 'extraction failed'))));
    worker.once('error', (e) => finish(reject, new Error(e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'file is too complex (memory limit)' : e?.message || 'extraction failed')));
    worker.once('exit', (code) => finish(reject, new Error(`extraction worker exited (${code})`)));
  });
}

export class AttachmentStore {
  constructor({ dataDir, embedder, bus, settings }) {
    this.dir = path.join(dataDir, 'attachments');
    this.indexFile = path.join(this.dir, 'index.json');
    this.bus = bus;
    this.settingsStore = settings;
    this.items = new Map();
    this.docIndex = new HybridIndex({ file: path.join(dataDir, 'index', 'documents.json'), embedder });
    this._textCache = new Map();
    this._textCacheChars = 0;
  }

  /** Wall-clock limit for one extraction worker. */
  static extractTimeoutMs = 30000;

  async load() {
    await ensureDir(this.dir);
    const j = await readJson(this.indexFile, { version: 1, items: [] });
    for (const a of j.items || []) if (a && isSafeId(a.id, 'att')) this.items.set(a.id, a);
    await this.docIndex.load();
    return this;
  }

  async saveIndex() { await writeJsonAtomic(this.indexFile, { version: 1, items: [...this.items.values()] }); }

  folder(id) {
    assertSafeId(id, 'att');
    return path.join(this.dir, id);
  }

  get(id) {
    const a = this.items.get(id);
    if (!a) throw notFound('Attachment');
    return a;
  }

  tryGet(id) { return this.items.get(id) || null; }

  /** Bounded text cache (entries and total characters). */
  _cacheText(id, text) {
    if (typeof text !== 'string' || text.length > TEXT_CACHE_MAX_CHARS / 2) return;
    this._textCache.delete(id);
    this._textCache.set(id, text);
    this._textCacheChars += text.length;
    while (this._textCache.size > TEXT_CACHE_MAX_ENTRIES || this._textCacheChars > TEXT_CACHE_MAX_CHARS) {
      const [k, v] = this._textCache.entries().next().value;
      this._textCache.delete(k);
      this._textCacheChars -= v.length;
    }
  }

  _uncacheText(id) {
    const v = this._textCache.get(id);
    if (v !== undefined) { this._textCache.delete(id); this._textCacheChars -= v.length; }
  }

  /**
   * Classify + extract + chunk. PDFs and large files run in a worker thread with memory limits and a timeout;
   * a failed/timed-out extraction degrades to "could not extract text" for this attachment (the upload succeeds).
   */
  async extract(name, mime, buffer) {
    const chunkTokens = this.settingsStore?.get().documents?.chunkTokens || 400;
    const head = buffer.subarray(0, 5).toString('latin1');
    const heavy = head.startsWith('%PDF') || /pdf/i.test(mime || '') || /\.pdf$/i.test(name) || buffer.length > INLINE_EXTRACT_MAX;
    if (!heavy) {
      const result = processUpload(name, mime, buffer);
      const chunks = result.kind === 'text' ? chunkText(result.text, { targetTokens: chunkTokens, overlapTokens: Math.round(chunkTokens / 8) }) : [];
      return { result, chunks };
    }
    try {
      return await runExtractWorker({ name, mime, buffer, chunkTokens }, { timeoutMs: AttachmentStore.extractTimeoutMs });
    } catch (e) {
      const isPdf = head.startsWith('%PDF');
      return { result: { kind: 'binary', mime: isPdf ? 'application/pdf' : mime || 'application/octet-stream', warnings: [], error: `Could not extract text from this file (${e.message}).` }, chunks: [] };
    }
  }

  async create({ name, mime, buffer, chatId = null }) {
    if (!buffer?.length) throw badRequest('Empty upload');
    if (buffer.length > MAX_UPLOAD_BYTES) throw badRequest(`File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
    name = String(name || 'file').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200) || 'file';
    const { result: r, chunks } = await this.extract(name, mime, buffer);
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
      a.tokens = chunks.length > 1 ? chunks.reduce((n, c) => n + c.tokens, 0) : estimateTextTokens(r.text);
      a.chars = r.text.length;
      this._cacheText(id, r.text);
      a.chunks = chunks.length;
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        this.docIndex.upsert(`${id}:${c.n}`, c.text, { attachmentId: id, n: c.n, total: chunks.length, tokens: c.tokens });
        if (i % 200 === 199) await new Promise((res) => setImmediate(res)); // stay responsive on huge documents
      }
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
    if (t !== null) this._cacheText(id, t);
    return t;
  }

  async delete(id) {
    const a = this.get(id);
    this.items.delete(id);
    this._uncacheText(id);
    this.docIndex.removeWhere((it) => it.meta?.attachmentId === id);
    await removeFile(this.folder(id));
    await this.saveIndex();
    return a;
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
