// Encryption primitives (AES-256-GCM via node:crypto, no dependencies).
//
// Two on-disk formats, both starting with a 4-byte magic so a reader can tell plain from encrypted files:
//
// HXC1 — a whole file, encrypted in chunks (STREAM construction):
//   header (32 bytes): "HXC1" | version 1 (u8) | chunk size log2 (u8) | 2 reserved | key id (8) | nonce prefix (7) |
//                      9 reserved
//   chunks: ciphertext (≤ chunk size) + 16-byte tag each; nonce = prefix(7) ‖ counter(u32 BE) ‖ last-chunk flag (u8);
//   AAD = the header. Truncation, reordering and appending are detected (the last chunk is marked).
//
// HXL1 — an append-only log of independently sealed records (indexes that grow by appends):
//   header (16 bytes): "HXL1" | version 1 (u8) | 3 reserved | key id (8)
//   record: u32 BE length of what follows | nonce (12) | ciphertext | tag (16); AAD = key id ‖ "rec".
//   Reading concatenates the plaintexts. A torn last record (crash mid-append) is ignored.
import crypto from 'node:crypto';

export const MAGIC_C = Buffer.from('HXC1');
export const MAGIC_L = Buffer.from('HXL1');
export const HEADER_C = 32;
export const HEADER_L = 16;
export const CHUNK_LOG2 = 16; // 64 KiB
const TAG = 16;

export class CryptoError extends Error {
  constructor(message, code = 'decrypt_failed') { super(message); this.code = code; }
}

/** 8-byte public identifier of a data key (lets a reader tell "wrong key" from "corrupt"). */
export function keyIdOf(key) {
  return crypto.createHmac('sha256', key).update('harness key id v1').digest().subarray(0, 8);
}

export const isHXC = (buf) => buf && buf.length >= 4 && buf.subarray(0, 4).equals(MAGIC_C);
export const isHXL = (buf) => buf && buf.length >= 4 && buf.subarray(0, 4).equals(MAGIC_L);
export const isEncrypted = (buf) => isHXC(buf) || isHXL(buf);

function chunkNonce(prefix, i, last) {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0, 0, 7);
  n.writeUInt32BE(i >>> 0, 7);
  n[11] = last ? 1 : 0;
  return n;
}

export function hxcHeader(key, { chunkLog2 = CHUNK_LOG2, prefix = crypto.randomBytes(7) } = {}) {
  const h = Buffer.alloc(HEADER_C);
  MAGIC_C.copy(h, 0);
  h[4] = 1;
  h[5] = chunkLog2;
  keyIdOf(key).copy(h, 8);
  prefix.copy(h, 16);
  return h;
}

/** Incremental HXC1 encryptor: push plaintext, get ciphertext pieces; finish() seals the last chunk. */
export function hxcEncryptor(key, opts) {
  const header = hxcHeader(key, opts);
  const size = 1 << header[5];
  const prefix = header.subarray(16, 23);
  let pending = Buffer.alloc(0);
  let i = 0;
  const seal = (pt, last) => {
    const c = crypto.createCipheriv('aes-256-gcm', key, chunkNonce(prefix, i++, last));
    c.setAAD(header);
    const out = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    return out;
  };
  return {
    header,
    push(buf) {
      pending = pending.length ? Buffer.concat([pending, buf]) : buf;
      const out = [];
      // keep at least one byte pending so the last chunk is always sealed by finish()
      while (pending.length > size) { out.push(seal(pending.subarray(0, size), false)); pending = pending.subarray(size); }
      return out;
    },
    finish() { const out = seal(pending, true); pending = Buffer.alloc(0); return out; },
  };
}

export function encryptHXC(key, plaintext) {
  const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext));
  const e = hxcEncryptor(key);
  return Buffer.concat([e.header, ...e.push(pt), e.finish()]);
}

function checkHeader(key, header) {
  if (!isHXC(header) || header[4] !== 1) throw new CryptoError('Not an HXC1 file', 'bad_format');
  if (!header.subarray(8, 16).equals(keyIdOf(key))) throw new CryptoError('This file was encrypted with a different key', 'wrong_key');
}

/** Incremental HXC1 decryptor: push ciphertext bytes (after the header), get plaintext pieces. */
export function hxcDecryptor(key, header) {
  checkHeader(key, header);
  const size = 1 << header[5];
  const prefix = header.subarray(16, 23);
  const unit = size + TAG;
  let pending = Buffer.alloc(0);
  let i = 0;
  let done = false;
  const open = (ct, last) => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, chunkNonce(prefix, i++, last));
    d.setAAD(header);
    d.setAuthTag(ct.subarray(ct.length - TAG));
    try { return Buffer.concat([d.update(ct.subarray(0, ct.length - TAG)), d.final()]); } catch { throw new CryptoError('Encrypted data failed authentication (corrupt or tampered)'); }
  };
  return {
    push(buf) {
      if (done) throw new CryptoError('Data after the last chunk');
      pending = pending.length ? Buffer.concat([pending, buf]) : buf;
      const out = [];
      // a full unit is a non-final chunk only if more bytes follow it
      while (pending.length > unit) { out.push(open(pending.subarray(0, unit), false)); pending = pending.subarray(unit); }
      return out;
    },
    finish() {
      if (done) return Buffer.alloc(0);
      if (pending.length < TAG) throw new CryptoError('Truncated encrypted file');
      done = true;
      return open(pending, true);
    },
  };
}

export function decryptHXC(key, buf) {
  if (buf.length < HEADER_C + TAG) throw new CryptoError('Truncated encrypted file');
  const d = hxcDecryptor(key, buf.subarray(0, HEADER_C));
  return Buffer.concat([...d.push(buf.subarray(HEADER_C)), d.finish()]);
}

/** Plaintext size of an HXC1 file from its total size. */
export function hxcPlainSize(totalSize, chunkLog2 = CHUNK_LOG2) {
  const body = totalSize - HEADER_C;
  const unit = (1 << chunkLog2) + TAG;
  const chunks = Math.max(1, Math.ceil(body / unit));
  return body - chunks * TAG;
}

// ---------------------------------------------------------------------------------------------- HXL1
export function hxlHeader(key) {
  const h = Buffer.alloc(HEADER_L);
  MAGIC_L.copy(h, 0);
  h[4] = 1;
  keyIdOf(key).copy(h, 8);
  return h;
}

export function hxlRecord(key, plaintext) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.concat([keyIdOf(key), Buffer.from('rec')]));
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(12 + ct.length);
  return Buffer.concat([len, nonce, ct]);
}

/** Decrypt an HXL1 log to its concatenated plaintext. */
export function decryptHXL(key, buf) {
  if (buf.length < HEADER_L || !isHXL(buf)) throw new CryptoError('Not an HXL1 file', 'bad_format');
  const kid = keyIdOf(key);
  if (!buf.subarray(8, 16).equals(kid)) throw new CryptoError('This file was encrypted with a different key', 'wrong_key');
  const aad = Buffer.concat([kid, Buffer.from('rec')]);
  const parts = [];
  let off = HEADER_L;
  while (off + 4 <= buf.length) {
    const n = buf.readUInt32BE(off);
    if (n < 12 + TAG || off + 4 + n > buf.length) break; // torn tail from a crash mid-append: ignored
    const rec = buf.subarray(off + 4, off + 4 + n);
    const d = crypto.createDecipheriv('aes-256-gcm', key, rec.subarray(0, 12));
    d.setAAD(aad);
    d.setAuthTag(rec.subarray(rec.length - TAG));
    try { parts.push(Buffer.concat([d.update(rec.subarray(12, rec.length - TAG)), d.final()])); } catch { throw new CryptoError('Encrypted record failed authentication (corrupt or tampered)'); }
    off += 4 + n;
  }
  return Buffer.concat(parts);
}

export function encryptHXL(key, plaintext) {
  return plaintext.length ? Buffer.concat([hxlHeader(key), hxlRecord(key, plaintext)]) : hxlHeader(key);
}

// ---------------------------------------------------------------------------------------------- small sealed values
/** Seal a small secret (key wraps, verifiers): { nonce, data } base64. */
export function seal(key, plaintext, aad = '') {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  if (aad) c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  return { nonce: nonce.toString('base64'), data: data.toString('base64') };
}

/** Open a sealed value; null when the key is wrong or the data was altered. */
export function unseal(key, sealed, aad = '') {
  try {
    const data = Buffer.from(sealed.data, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64'));
    if (aad) d.setAAD(Buffer.from(aad));
    d.setAuthTag(data.subarray(data.length - TAG));
    return Buffer.concat([d.update(data.subarray(0, data.length - TAG)), d.final()]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------- key derivation
/**
 * Password → key-encryption key. Production: N = 2^17, r = 8, p = 1 = 128 MiB and about half a second on an M1:
 * the memory cost is what makes large-scale guessing expensive, and 128 MiB is transient and safe on 8 GB.
 * Tests inject smaller parameters (setKdfDefaults / startServer({ security: { kdf } })).
 */
export const KDF_PRODUCTION = Object.freeze({ name: 'scrypt', N: 2 ** 17, r: 8, p: 1, keyLen: 32 });
let kdfDefaults = { ...KDF_PRODUCTION };
export function setKdfDefaults(p) { kdfDefaults = { ...KDF_PRODUCTION, ...(p || {}) }; }
export function kdfDefaultsNow() { return { ...kdfDefaults }; }

export function deriveKey(password, kdf) {
  const salt = Buffer.from(kdf.salt, 'base64');
  const maxmem = 128 * kdf.N * kdf.r * 2 + 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(String(password).normalize('NFC'), 'utf8'), salt, kdf.keyLen || 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export function newKdf(params = kdfDefaults) {
  return { name: 'scrypt', N: params.N, r: params.r, p: params.p, keyLen: 32, salt: crypto.randomBytes(16).toString('base64') };
}

export function hkdf(ikm, salt, info) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), 32));
}

// ---------------------------------------------------------------------------------------------- recovery keys
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 32 random bytes as "HRK1-XXXX-…" (13 groups of 4 Crockford base32 characters). */
export function formatRecoveryKey(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += CROCKFORD[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return `HRK1-${out.match(/.{1,4}/g).join('-')}`;
}

/** Parse a typed recovery key (case, spaces and dashes ignored; I/L → 1, O → 0). null when malformed. */
export function parseRecoveryKey(text) {
  let s = String(text || '').toUpperCase().replace(/[\s-]/g, '');
  if (!s.startsWith('HRK1')) return null;
  s = s.slice(4).replace(/[IL]/g, '1').replace(/O/g, '0');
  if (s.length !== 52) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return out.length >= 32 ? Buffer.from(out.slice(0, 32)) : null;
}

/** Overwrite a key buffer (best effort: copies made by V8 internals cannot be reached). */
export function wipe(buf) {
  if (Buffer.isBuffer(buf)) buf.fill(0);
}
