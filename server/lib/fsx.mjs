// File-system helpers: atomic JSON writes (write tmp + fsync + rename), serialized per path.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from './log.mjs';

const queues = new Map();

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/** Read a JSON file. Missing → fallback. Corrupt → moved aside, fallback returned. */
export async function readJson(file, fallback = null) {
  let txt;
  try {
    txt = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return JSON.parse(txt);
  } catch {
    const bak = `${file}.corrupt-${Date.now()}`;
    await fs.rename(file, bak).catch(() => {});
    log.warn(`Corrupt JSON in ${file}; moved to ${bak}`);
    return fallback;
  }
}

async function doWrite(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

/** Atomically replace `file` with `data`. Writes to the same path are serialized in call order. */
export function writeFileAtomic(file, data) {
  const prev = queues.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => doWrite(file, data));
  queues.set(file, next);
  const cleanup = () => { if (queues.get(file) === next) queues.delete(file); };
  next.then(cleanup, cleanup);
  return next;
}

export function writeJsonAtomic(file, obj, { pretty = true } = {}) {
  return writeFileAtomic(file, JSON.stringify(obj, null, pretty ? 2 : 0) + '\n');
}

/** Wait for all queued writes to settle. */
export async function flushWrites() {
  while (queues.size) await Promise.allSettled([...queues.values()]);
}

export async function removeFile(p) {
  await fs.rm(p, { force: true, recursive: true });
}
