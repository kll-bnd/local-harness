// Converting a data directory between plain and encrypted (and between two data keys), file by file.
//
// Crash-safe and resumable: each file is converted into a temporary file beside it, the temporary file is read back
// and compared (SHA-256 of the plaintext) before an atomic rename replaces the original, and a file that is already
// in the target form is skipped — so a run interrupted at any point simply continues at the next start, and the
// directory is readable at every point in between (fsx reads plain and encrypted files alike, under either key).
// Progress lives in vault.json (`migration`) and is reported to a callback.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isPlainFile, isLogFile, createDataReadStream, readFileData } from '../lib/fsx.mjs';
import fss from 'node:fs';
import { isHXC, isHXL, keyIdOf, hxcEncryptor, hxcDecryptor, encryptHXL, decryptHXL, HEADER_C } from './crypto.mjs';
import { log } from '../lib/log.mjs';

const TMP_SUFFIX = '.harness-migrate.tmp';

/**
 * What the backend owns in the data directory — an explicit allow-list, so files of the launchers (desktop.json,
 * native/, Electron/ …) or anything else are never encrypted, decrypted, chmod-ed or counted as user data.
 */
export const OWNED_FILES = new Set(['settings.json', 'presets.json', 'calibration.json', 'memories.json', 'model-copies.json', 'ui-state.json']);
export const OWNED_DIRS = new Set(['chats', 'attachments', 'images', 'index']);
export const OWNED_PLAIN = new Set(['launch.json', 'vault.json', 'vault.json.bak', 'vault-seq.json', 'harness.lock', 'measurements.json', 'api-token', '.dev-keychain']);

/** Is `file` (absolute, under dataDir) an encrypted-by-design file the backend owns? */
export function isDataFile(file, dataDir) {
  const b = path.basename(file);
  if (isPlainFile(file)) return false;
  if (b.endsWith('.tmp') || b.includes('.corrupt-') || b.startsWith('.')) return false;
  if (!dataDir) return true;
  const rel = path.relative(dataDir, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  return parts.length === 1 ? OWNED_FILES.has(parts[0]) : OWNED_DIRS.has(parts[0]);
}

async function walkFiles(root, out, { limit = 200000 } = {}) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= limit) return;
    const full = path.join(root, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await walkFiles(full, out, { limit });
    else if (e.isFile()) out.push(full);
  }
}

/** Every data file the backend owns under `dir` (sorted, so progress is stable); stale temporaries removed unless `clean: false`. */
export async function listDataFiles(dir, { clean = true } = {}) {
  const all = [];
  for (const f of OWNED_FILES) { try { if ((await fs.lstat(path.join(dir, f))).isFile()) all.push(path.join(dir, f)); } catch { /* absent */ } }
  for (const d of OWNED_DIRS) await walkFiles(path.join(dir, d), all);
  const out = [];
  for (const f of all) {
    if (f.endsWith(TMP_SUFFIX)) { if (clean) await fs.rm(f, { force: true }); continue; }
    if (isDataFile(f, dir)) out.push(f);
  }
  return out.sort();
}

/** Files under `dir` the backend does NOT own (launchers' files and anything else). */
export async function listForeignFiles(dir, { limit = 20000 } = {}) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (OWNED_FILES.has(e.name) || OWNED_DIRS.has(e.name) || OWNED_PLAIN.has(e.name) || e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkFiles(full, out, { limit });
    else if (e.isFile()) out.push(full);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Repair: an earlier 0.2 build encrypted files it did not own (desktop.json, native/, Electron/). Decrypt every
 * such file back in place (verified, atomic) with the keys the directory cipher knows. Returns how many.
 */
export async function repairForeignFiles(dir) {
  let fixed = 0;
  for (const f of await listForeignFiles(dir)) {
    const head = await readHead(f).catch(() => Buffer.alloc(0));
    if (!isHXC(head) && !isHXL(head)) continue;
    try { if ((await convertFile(f, null)) === 'converted') fixed++; } catch (e) { log.warn(`Could not decrypt a launcher file back (${path.relative(dir, f)}): ${e.code || e.message}`); }
  }
  return fixed;
}

/** True when any 0.1-style (plain) data file exists — an upgrade that needs a password to encrypt it. */
export async function hasPlainData(dir) {
  for (const f of await listDataFiles(dir, { clean: false })) {
    const head = await readHead(f);
    if (head.length && !isHXC(head) && !isHXL(head)) return true;
  }
  return false;
}

async function readHead(file, n = HEADER_C) {
  const fh = await fs.open(file, 'r');
  try { const b = Buffer.alloc(n); const { bytesRead } = await fh.read(b, 0, n, 0); return b.subarray(0, bytesRead); } finally { await fh.close(); }
}

/** True when any file under `dir` is encrypted (then the key store must exist: never offer a fresh setup). */
export async function hasEncryptedData(dir) {
  for (const f of await listDataFiles(dir, { clean: false })) {
    const head = await readHead(f).catch(() => Buffer.alloc(0));
    if (isHXC(head) || isHXL(head)) return true;
  }
  return false;
}

/** The key ids (hex) the encrypted data files are under — a read-only scan of their headers (HXC1 and HXL1 alike). */
export async function keyIdsInUse(dir) {
  const ids = new Map();
  for (const f of await listDataFiles(dir, { clean: false })) {
    const head = await readHead(f, 16).catch(() => Buffer.alloc(0));
    if (head.length >= 16 && (isHXC(head) || isHXL(head))) { const id = head.subarray(8, 16).toString('hex'); ids.set(id, (ids.get(id) || 0) + 1); }
  }
  return ids;
}

/** Fix permissions of what the backend owns: the data folder 0700; its own files 0600, its own folders 0700. */
export async function fixPermissions(dir) {
  await fs.chmod(dir, 0o700).catch(() => {});
  const walk = async (d) => {
    await fs.chmod(d, 0o700).catch(() => {});
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) await fs.chmod(full, 0o600).catch(() => {});
    }
  };
  for (const name of [...OWNED_FILES, ...OWNED_PLAIN]) {
    const f = path.join(dir, name);
    try { if ((await fs.lstat(f)).isFile()) await fs.chmod(f, 0o600); } catch { /* absent */ }
  }
  for (const d of OWNED_DIRS) { try { if ((await fs.lstat(path.join(dir, d))).isDirectory()) await walk(path.join(dir, d)); } catch { /* absent */ } }
}

/**
 * Convert one file to the target form. `toKey` null = plain. Reading uses the directory's registered cipher
 * (which must know every key the file may be under). Returns 'converted' | 'skipped'.
 */
export async function convertFile(file, toKey) {
  const head = await readHead(file);
  const encrypted = isHXC(head) || isHXL(head);
  if (!toKey && !encrypted) return 'skipped';
  if (toKey && encrypted && head.length >= 16 && head.subarray(8, 16).equals(keyIdOf(toKey))) return 'skipped';
  const tmp = file + TMP_SUFFIX;
  const fh = await fs.open(tmp, 'w', 0o600);
  const srcHash = crypto.createHash('sha256');
  try {
    if (toKey && isLogFile(file)) {
      const plain = await readFileData(file);
      srcHash.update(plain);
      await fh.writeFile(encryptHXL(toKey, plain));
    } else if (toKey) {
      const enc = hxcEncryptor(toKey);
      await fh.write(enc.header);
      for await (const chunk of createDataReadStream(file)) {
        srcHash.update(chunk);
        for (const part of enc.push(chunk)) await fh.write(part);
      }
      await fh.write(enc.finish());
    } else {
      for await (const chunk of createDataReadStream(file)) { srcHash.update(chunk); await fh.write(chunk); }
    }
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    throw e;
  }
  await fh.close();
  // Verify: the temporary file must give back exactly the plaintext we read.
  const back = crypto.createHash('sha256');
  if (toKey && isLogFile(file)) {
    back.update(decryptHXL(toKey, await fs.readFile(tmp)));
  } else if (toKey) {
    const rh = await fs.open(tmp, 'r');
    try {
      const h = Buffer.alloc(HEADER_C);
      await rh.read(h, 0, HEADER_C, 0);
      const dec = hxcDecryptor(toKey, h);
      let pos = HEADER_C;
      const b = Buffer.alloc(256 * 1024);
      for (;;) {
        const { bytesRead } = await rh.read(b, 0, b.length, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        for (const p of dec.push(b.subarray(0, bytesRead))) back.update(p);
      }
      back.update(dec.finish());
    } finally { await rh.close(); }
  } else {
    for await (const chunk of fss.createReadStream(tmp)) back.update(chunk);
  }
  if (!back.digest().equals(srcHash.digest())) {
    await fs.rm(tmp, { force: true });
    const e = new Error('verification failed');
    e.code = 'migration_verify_failed';
    throw e;
  }
  await fs.rename(tmp, file);
  return 'converted';
}

/**
 * Run a migration over `dataDir`. `op`: 'encrypt' | 'decrypt' | 'reencrypt'; `toKey`: the target key (null for
 * decrypt). `onProgress({ op, done, total })` is called after every file (throttled persistence is the caller's).
 */
export async function migrateDir(dataDir, { op, toKey, onProgress, shouldStop = () => false }) {
  const files = await listDataFiles(dataDir);
  let done = 0;
  let converted = 0;
  onProgress?.({ op, done, total: files.length });
  for (const f of files) {
    if (shouldStop()) { const e = new Error('stopped'); e.code = 'migration_stopped'; throw e; }
    try {
      if ((await convertFile(f, toKey)) === 'converted') converted++;
    } catch (e) {
      if (e.code === 'ENOENT') { /* vanished meanwhile */ } else {
        log.error(`Migration (${op}) failed on a file in ${path.relative(dataDir, path.dirname(f)) || '.'}: ${e.code || e.message}`);
        throw e;
      }
    }
    done++;
    onProgress?.({ op, done, total: files.length });
  }
  await fixPermissions(dataDir);
  return { total: files.length, converted };
}
