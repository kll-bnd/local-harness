// File-system helpers: atomic writes (tmp + fsync + rename), serialized per path, and transparent encryption.
//
// Encryption: a data directory registers its cipher (`setDirCipher`). Every read through these helpers accepts a
// plain or an encrypted file (so a half-migrated directory is always readable); every write encrypts when a cipher
// is registered (`HXC1` for whole files, `HXL1` record logs for the append-only index logs). Files in
// PLAIN_FILES never are. While a directory is locked, reading an encrypted file or writing anything throws 423.
// Files are created 0600 and directories 0700.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { log } from './log.mjs';
import { HttpError } from './errors.mjs';
import { isHXC, isHXL, decryptHXC, decryptHXL, hxcEncryptor, hxcDecryptor, hxlHeader, hxlRecord, encryptHXL, HEADER_C, hxcPlainSize, keyIdOf } from '../security/crypto.mjs';

const queues = new Map();

/** Never encrypted: needed before the data is open, or not sensitive (docs/API.md §10.4). */
export const PLAIN_FILES = new Set(['launch.json', 'vault.json', 'harness.lock', 'measurements.json', 'api-token', '.dev-keychain']);
const LOCKED = Symbol('locked');
const ciphers = new Map(); // dir → { key, oldKeys? } | { key: null, oldKeys } (decrypting) | LOCKED

/**
 * Register the cipher for everything under `dir`: `{ key }` writes encrypted with `key`; `{ key: null, oldKeys }`
 * writes plain but can still read files encrypted with `oldKeys` (decrypting); `oldKeys` also lets a re-keyed
 * directory read files still under the previous key. `null` = plain, `'locked'` = refuse.
 */
export function setDirCipher(dir, cipher) {
  const d = path.resolve(dir);
  if (cipher === null || cipher === undefined) ciphers.delete(d);
  else ciphers.set(d, cipher === 'locked' ? LOCKED : cipher);
}

export const isPlainFile = (file) => PLAIN_FILES.has(path.basename(file)) || /\.log$/.test(file);
export const isLogFile = (file) => /\.items\.jsonl$|\.vectors\.bin$/.test(file);

function entryFor(file) {
  const f = path.resolve(file);
  let best = null;
  let bestLen = -1;
  for (const [d, c] of ciphers) if ((f === d || f.startsWith(d + path.sep)) && d.length > bestLen) { best = c; bestLen = d.length; }
  return best;
}

/** The cipher to WRITE `file` with: { key } | null (plain); throws while locked. */
export function writeCipherFor(file) {
  if (isPlainFile(file)) return null;
  const e = entryFor(file);
  if (e === LOCKED) throw new HttpError(423, 'locked', 'Harness is locked.');
  return e?.key ? { key: e.key } : null;
}

/** The key that opens an encrypted file whose header is `head` (the key id sits at bytes 8–16 of both formats). */
function readKeyFor(file, head) {
  const e = entryFor(file);
  if (e === LOCKED || !e) throw new HttpError(423, 'locked', 'Harness is locked (this file is encrypted).');
  const keys = [e.key, ...(e.oldKeys || [])].filter(Boolean);
  if (head && head.length >= 16) {
    const kid = head.subarray(8, 16);
    const k = keys.find((x) => keyIdOf(x).equals(kid));
    if (k) return k;
  }
  if (!keys.length) throw new HttpError(423, 'locked', 'Harness is locked (this file is encrypted).');
  return keys[0]; // decrypt reports wrong_key
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/** Decode raw bytes read from `file` (plain stays plain). */
export function decodeData(file, raw) {
  if (isHXC(raw)) return decryptHXC(readKeyFor(file, raw), raw);
  if (isHXL(raw)) return decryptHXL(readKeyFor(file, raw), raw);
  return raw;
}

/** Read a file's plaintext (encrypted or not). Throws ENOENT like fs.readFile. */
export async function readFileData(file) {
  return decodeData(file, await fs.readFile(file));
}

export async function readTextData(file) {
  return (await readFileData(file)).toString('utf8');
}

/** Read a JSON file. Missing → fallback. Corrupt → moved aside, fallback returned. */
export async function readJson(file, fallback = null) {
  let raw;
  try {
    raw = await fs.readFile(file);
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  let txt;
  try { txt = decodeData(file, raw).toString('utf8'); } catch (e) {
    if (e.status === 423) throw e;
    // Another key's file is never "corrupt": leave it exactly as it is and fail clearly.
    if (e.code === 'wrong_key') throw new HttpError(500, 'wrong_key', 'A data file was encrypted with a different key; nothing was changed.');
    const bak = `${file}.corrupt-${Date.now()}`;
    await fs.rename(file, bak).catch(() => {});
    log.warn(`Unreadable encrypted file ${path.basename(file)} (${e.code || 'error'}); moved aside`);
    return fallback;
  }
  try {
    return JSON.parse(txt);
  } catch {
    const bak = `${file}.corrupt-${Date.now()}`;
    await fs.rename(file, bak).catch(() => {});
    log.warn(`Corrupt JSON in ${path.basename(file)}; moved aside`);
    return fallback;
  }
}

/** Write `data` (string/Buffer) into an open handle, encrypting chunk by chunk (bounded memory for big files). */
async function writeEncoded(fh, file, data, cipher) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  if (!cipher) { await fh.writeFile(buf); return; }
  if (isLogFile(file)) { await fh.writeFile(encryptHXL(cipher.key, buf)); return; }
  const e = hxcEncryptor(cipher.key);
  await fh.write(e.header);
  const SLICE = 1024 * 1024;
  for (let off = 0; off < buf.length; off += SLICE) for (const part of e.push(buf.subarray(off, off + SLICE))) await fh.write(part);
  await fh.write(e.finish());
}

async function doWrite(file, data, abortIf, { cipherOverride } = {}) {
  if (abortIf?.()) return false;
  const cipher = cipherOverride !== undefined ? cipherOverride : writeCipherFor(file);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fs.open(tmp, 'w', 0o600);
  try {
    await writeEncoded(fh, file, typeof data === 'function' ? data() : data, cipher);
    await fh.sync();
  } finally {
    await fh.close();
  }
  // Checked again right before the rename: a delete that happened meanwhile must not be undone.
  if (abortIf?.()) { await fs.rm(tmp, { force: true }); return false; }
  await fs.rename(tmp, file);
  return true;
}

function enqueue(file, fn) {
  const prev = queues.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(file, next);
  const cleanup = () => { if (queues.get(file) === next) queues.delete(file); };
  next.then(cleanup, cleanup);
  return next;
}

/**
 * Atomically replace `file` with `data` (a string/Buffer, or a function producing it at write time).
 * Writes to the same path are serialized in call order. `abortIf()` is checked before writing and again
 * just before the rename (tombstones for deleted records). Encrypted when the directory has a cipher.
 */
export function writeFileAtomic(file, data, { abortIf, cipher } = {}) {
  return enqueue(file, () => doWrite(file, data, abortIf, { cipherOverride: cipher }));
}

export function writeJsonAtomic(file, obj, { pretty = true, abortIf } = {}) {
  return writeFileAtomic(file, () => JSON.stringify(obj, null, pretty ? 2 : 0) + '\n', { abortIf });
}

/**
 * Append to a log file (index logs). Encrypted directories get one sealed HXL1 record per append, so an append
 * never re-encrypts the file; a plain file found in an encrypted directory is converted first.
 */
export function appendData(file, data) {
  return enqueue(file, async () => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const cipher = writeCipherFor(file);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let head = null;
    try { const fh = await fs.open(file, 'r'); try { const b = Buffer.alloc(16); const { bytesRead } = await fh.read(b, 0, 16, 0); head = b.subarray(0, bytesRead); } finally { await fh.close(); } } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!cipher) {
      if (head && (isHXC(head) || isHXL(head))) { // an encrypted log in a plain directory: rewrite plain
        const plain = decodeData(file, await fs.readFile(file));
        await doWrite(file, Buffer.concat([plain, buf]), null, { cipherOverride: null });
        return;
      }
      await fs.appendFile(file, buf, { mode: 0o600 });
      return;
    }
    if (head && isHXL(head) && head.subarray(8, 16).equals(hxlHeader(cipher.key).subarray(8, 16))) {
      await fs.appendFile(file, hxlRecord(cipher.key, buf));
      return;
    }
    // missing, empty, plain (half-migrated) or under the previous key (re-keying): (re)write as an encrypted log
    const prev = head && head.length ? decodeData(file, await fs.readFile(file)) : Buffer.alloc(0);
    await doWrite(file, Buffer.concat([prev, buf]), null, { cipherOverride: { key: cipher.key } });
  });
}

/** Plaintext size of a stored file (encrypted or not). */
export async function dataFileSize(file) {
  const st = await fs.stat(file);
  const fh = await fs.open(file, 'r');
  try {
    const b = Buffer.alloc(4);
    await fh.read(b, 0, 4, 0);
    if (isHXC(b)) { const h = Buffer.alloc(HEADER_C); await fh.read(h, 0, HEADER_C, 0); return hxcPlainSize(st.size, h[5]); }
    if (isHXL(b)) return (await readFileData(file)).length;
    return st.size;
  } finally { await fh.close(); }
}

/** A readable stream of a stored file's plaintext; HXC1 files are decrypted chunk by chunk (bounded memory). */
export function createDataReadStream(file) {
  let fh = null;
  let dec = null;
  let pos = 0;
  let plainMode = false;
  const READ = 256 * 1024;
  return new Readable({
    async read() {
      try {
        if (!fh) {
          fh = await fs.open(file, 'r');
          const h = Buffer.alloc(HEADER_C);
          const { bytesRead } = await fh.read(h, 0, HEADER_C, 0);
          if (bytesRead >= 4 && isHXC(h)) { dec = hxcDecryptor(readKeyFor(file, h), h.subarray(0, bytesRead)); pos = HEADER_C; } else if (bytesRead >= 4 && isHXL(h)) {
            const all = await readFileData(file);
            this.push(all);
            this.push(null);
            await fh.close();
            return;
          } else { plainMode = true; pos = 0; }
        }
        for (;;) {
          const b = Buffer.alloc(READ);
          const { bytesRead } = await fh.read(b, 0, READ, pos);
          pos += bytesRead;
          if (!bytesRead) {
            if (dec) { const last = dec.finish(); if (last.length) this.push(last); }
            await fh.close();
            fh = null;
            this.push(null);
            return;
          }
          if (plainMode) { this.push(b.subarray(0, bytesRead)); return; }
          const parts = dec.push(b.subarray(0, bytesRead));
          if (parts.length) { this.push(Buffer.concat(parts)); return; }
        }
      } catch (e) {
        await fh?.close().catch(() => {});
        this.destroy(e);
      }
    },
  });
}

/** Resolve once every write queued so far for `file` has settled. */
export async function waitForWrites(file) {
  while (queues.has(file)) await queues.get(file).catch(() => {});
}

/** Wait for all queued writes to settle. */
export async function flushWrites() {
  while (queues.size) await Promise.allSettled([...queues.values()]);
}

export async function removeFile(p) {
  await fs.rm(p, { force: true, recursive: true });
}

/** Synchronous plaintext read (small files at start-up). */
export function readFileDataSync(file) {
  return decodeData(file, fss.readFileSync(file));
}
