export const GiB = 1024 ** 3;
export const MiB = 1024 ** 2;

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/** Deep merge: plain objects merge recursively, everything else (arrays, null, scalars) replaces. */
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : clone(patch);
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : clone(v);
  }
  return out;
}

export function clone(v) {
  return v === undefined ? undefined : structuredClone(v);
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? abortError());
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason ?? abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(message = 'Aborted') {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

/** Combine an optional signal with a timeout. */
export function withTimeout(signal, ms) {
  if (!ms) return signal;
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

export function truncateMiddle(text, maxChars, marker = '\n…[truncated]…\n') {
  if (!text || text.length <= maxChars) return text;
  const half = Math.max(0, Math.floor((maxChars - marker.length) / 2));
  return text.slice(0, half) + marker + text.slice(text.length - half);
}

export function truncateEnd(text, maxChars, marker = '…') {
  if (!text || text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}

export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '?';
  const gb = bytes / GiB;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / MiB)} MB`;
}

/** 65536 → "64K", 98304 → "96K", 2048 → "2K", 40000 → "39.1K". */
export function formatTokensK(n) {
  if (n == null) return '?';
  const k = n / 1024;
  return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export function nowIso() {
  return new Date().toISOString();
}

/** Simple async mutex keyed by string. */
export class KeyedMutex {
  constructor() { this.tails = new Map(); }
  async run(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    let release;
    const p = new Promise((r) => (release = r));
    const tail = prev.then(() => p);
    this.tails.set(key, tail);
    await prev;
    try { return await fn(); } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
