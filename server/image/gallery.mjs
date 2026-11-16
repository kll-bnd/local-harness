// Generated-image gallery: files under images/, metadata in images/index.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic, writeFileAtomic, ensureDir, removeFile } from '../lib/fsx.mjs';
import { newId, isSafeId } from '../lib/ids.mjs';
import { nowIso } from '../lib/util.mjs';
import { notFound } from '../lib/errors.mjs';
import { imageSize } from '../docs/extract.mjs';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const FILE_RE = /^img_[0-9a-z]{8,64}\.(png|jpg|webp)$/;

export class Gallery {
  constructor({ dataDir, bus }) {
    this.dir = path.join(dataDir, 'images');
    this.indexFile = path.join(this.dir, 'index.json');
    this.bus = bus;
    this.items = new Map();
  }

  async load() {
    await ensureDir(this.dir);
    const j = await readJson(this.indexFile, { version: 1, items: [] });
    for (const it of j.items || []) if (it && isSafeId(it.id, 'img') && FILE_RE.test(it.file || '')) this.items.set(it.id, it);
    return this;
  }

  async saveIndex() { await writeJsonAtomic(this.indexFile, { version: 1, items: [...this.items.values()] }); }

  filePath(rec) {
    if (!isSafeId(rec?.id, 'img') || !FILE_RE.test(rec.file || '') || !rec.file.startsWith(`${rec.id}.`)) throw new Error('Unsafe image file name');
    return path.join(this.dir, rec.file);
  }

  async add({ buffer, mime, meta }) {
    const id = newId('img');
    const file = `${id}.${EXT[mime] || 'png'}`;
    await writeFileAtomic(path.join(this.dir, file), buffer);
    const dims = imageSize(buffer, mime);
    const rec = { id, file, mime, bytes: buffer.length, width: dims.width ?? meta.params?.width ?? null, height: dims.height ?? meta.params?.height ?? null, createdAt: nowIso(), ...meta };
    this.items.set(id, rec);
    await this.saveIndex();
    this.bus?.publish('image.added', { image: publicImage(rec) });
    return rec;
  }

  get(id) {
    const r = this.items.get(id);
    if (!r) throw notFound('Image');
    return r;
  }

  tryGet(id) { return this.items.get(id) || null; }

  async read(id) { return fs.readFile(this.filePath(this.get(id))); }

  list({ chatId, source, limit = 100, offset = 0, q } = {}) {
    let arr = [...this.items.values()];
    if (chatId) arr = arr.filter((r) => r.chatId === chatId);
    if (source) arr = arr.filter((r) => r.source === source);
    if (q) { const n = q.toLowerCase(); arr = arr.filter((r) => (r.prompt || '').toLowerCase().includes(n)); }
    arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { total: arr.length, items: arr.slice(offset, offset + limit).map(publicImage) };
  }

  async update(id, patch) {
    const r = this.get(id);
    const { id: _i, file: _f, ...safe } = patch || {};
    Object.assign(r, safe);
    await this.saveIndex();
    return r;
  }

  async delete(id) {
    const r = this.get(id);
    this.items.delete(id);
    await removeFile(this.filePath(r));
    await this.saveIndex();
    this.bus?.publish('image.deleted', { imageId: id });
    return r;
  }
}

export function publicImage(r) {
  return { ...r, url: `/api/images/${r.id}/file` };
}

/** Compact reference stored on chat messages. */
export function imageRef(r) {
  return { id: r.id, url: `/api/images/${r.id}/file`, width: r.width, height: r.height, mime: r.mime, prompt: r.prompt, seed: r.seed, model: r.model, providerId: r.providerId };
}
