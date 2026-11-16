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
