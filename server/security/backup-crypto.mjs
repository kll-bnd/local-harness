// Passphrase-encrypted backups (docs/API.md §10.4): scrypt + AES-256-GCM over the whole harness.backup JSON.
import crypto from 'node:crypto';
import { deriveKey, newKdf, wipe, kdfWithinBounds } from './crypto.mjs';
import { HttpError } from '../lib/errors.mjs';

export const ENCRYPTED_FORMAT = 'harness.backup.encrypted';
const AAD = Buffer.from('harness.backup.encrypted v1');

export async function encryptBackup(json, passphrase, kdfParams) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) throw new HttpError(400, 'weak_passphrase', 'Choose a backup passphrase of at least 8 characters.');
  const kdf = newKdf(kdfParams || undefined);
  const key = await deriveKey(passphrase, kdf);
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(AAD);
  const data = Buffer.concat([c.update(Buffer.from(json)), c.final(), c.getAuthTag()]);
  wipe(key);
  const { keyLen, ...params } = kdf;
  return { format: ENCRYPTED_FORMAT, version: 1, kdf: params, cipher: 'aes-256-gcm', nonce: nonce.toString('base64'), data: data.toString('base64') };
}

/** The passphrase from the X-Harness-Backup-Passphrase header (base64url of UTF-8), or null. */
export function passphraseFromHeader(req) {
  const h = req.headers['x-harness-backup-passphrase'];
  if (typeof h !== 'string' || !h) return null;
  try { return Buffer.from(h, 'base64url').toString('utf8'); } catch { return null; }
}

/** Plain backups pass through; an encrypted one is opened with the header's passphrase. */
export async function openBackup(body, req) {
  if (body?.format !== ENCRYPTED_FORMAT) return body;
  const pass = passphraseFromHeader(req);
  if (!pass) throw new HttpError(400, 'encrypted_backup', 'This backup is encrypted: enter its passphrase.');
  if (body.version !== 1 || body.cipher !== 'aes-256-gcm' || body.kdf?.name !== 'scrypt') throw new HttpError(400, 'bad_backup', 'Unknown encrypted backup format.');
  const N = Number(body.kdf.N); const r = Number(body.kdf.r); const p = Number(body.kdf.p);
  if (!kdfWithinBounds({ name: 'scrypt', N, r, p, salt: body.kdf.salt })) throw new HttpError(400, 'bad_backup', 'Unsupported backup key parameters.');
  const key = await deriveKey(pass, { name: 'scrypt', N, r, p, salt: body.kdf.salt, keyLen: 32 });
  const data = Buffer.from(String(body.data || ''), 'base64');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(body.nonce || ''), 'base64'));
    d.setAAD(AAD);
    d.setAuthTag(data.subarray(data.length - 16));
    const json = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString('utf8');
    return JSON.parse(json);
  } catch {
    throw new HttpError(400, 'wrong_passphrase', 'That passphrase does not open this backup.');
  } finally { wipe(key); }
}
