import crypto from 'node:crypto';

let lastMs = 0;
let seq = 0;

/**
 * Time-sortable id: `<prefix>_<ms base36, 9 chars><seq base36, 2 chars><8 hex random>`.
 * Ids created later in the same process always sort after earlier ones (even within one millisecond).
 */
export function newId(prefix) {
  const now = Date.now();
  if (now === lastMs) seq++;
  else { lastMs = now; seq = 0; }
  const t = now.toString(36).padStart(9, '0');
  const s = Math.min(seq, 1295).toString(36).padStart(2, '0');
  return `${prefix}_${t}${s}${crypto.randomBytes(4).toString('hex')}`;
}

export function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

/** Ids minted by newId(): `<prefix>_<base36 time+seq><hex>`. Anything else must never reach the filesystem. */
export const SAFE_ID_RE = /^[a-z]{2,12}_[0-9a-z]{8,64}$/;

export function isSafeId(id, prefix) {
  return typeof id === 'string' && SAFE_ID_RE.test(id) && (!prefix || id.startsWith(`${prefix}_`));
}

/** Throw unless `id` is a well-formed id (optionally with the given prefix). Used before every path join. */
export function assertSafeId(id, prefix) {
  if (!isSafeId(id, prefix)) {
    const e = new Error(`Unsafe ${prefix || ''} id: ${String(id).slice(0, 80)}`);
    e.code = 'unsafe_id';
    throw e;
  }
  return id;
}
