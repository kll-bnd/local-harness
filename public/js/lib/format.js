// Formatting helpers for numbers, sizes, durations and dates. All locale-aware, all tabular-friendly.

const nf = new Intl.NumberFormat(undefined);
const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export const fmtInt = (n) => (n == null || !Number.isFinite(n) ? '—' : nf.format(Math.round(n)));
export const fmt1 = (n) => (n == null || !Number.isFinite(n) ? '—' : nf1.format(n));

/** 1536 → "1.5K", 65536 → "64K" (context window style, binary K for powers of two). */
export function fmtTokens(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n % 1024 === 0 && n >= 1024) return `${n / 1024}K`;
  if (n < 10000) return `${nf1.format(n / 1000)}K`;
  if (n < 1e6) return `${Math.round(n / 1000)}K`;
  return `${nf1.format(n / 1e6)}M`;
}

export function fmtBytes(b, { digits = 1 } = {}) {
  if (b == null || !Number.isFinite(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : digits)} ${u[i]}`;
}

export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  if (m < 60) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtPercent(p, digits = 0) {
  if (p == null || !Number.isFinite(p)) return '—';
  return `${(p * 100).toFixed(digits)}%`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dateYearFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

export const fmtTime = (iso) => (iso ? timeFmt.format(new Date(iso)) : '');
export const fmtFull = (iso) => (iso ? fullFmt.format(new Date(iso)) : '');

/** "14:02" today, "Yesterday", "Mar 3", "Mar 3, 2024". */
export function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const days = dayDiff(now, d);
  if (days === 0) return timeFmt.format(d);
  if (days === 1) return 'Yesterday';
  if (d.getFullYear() === now.getFullYear()) return dateFmt.format(d);
  return dateYearFmt.format(d);
}

export function fmtRelative(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtWhen(iso);
}

/** Time until an ISO date, e.g. model keep-alive expiry: "in 29 min". */
export function fmtUntil(iso) {
  if (!iso) return '';
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s > 3e8) return 'kept loaded';
  if (s <= 0) return 'expiring';
  if (s < 90) return `for ${Math.round(s)} s`;
  if (s < 5400) return `for ${Math.round(s / 60)} min`;
  return `for ${Math.round(s / 3600)} h`;
}

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function dayDiff(a, b) { return Math.round((startOfDay(a) - startOfDay(b)) / 86400000); }

/** Recency bucket for the chat list. */
export function recencyGroup(iso) {
  const d = new Date(iso);
  const days = dayDiff(new Date(), d);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';
  return monthFmt.format(d);
}

export function plural(n, one, many = `${one}s`) {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

/** Friendly display name for a model id: "hf.co/unsloth/X-GGUF:Q4_K_M" → "X-GGUF · Q4_K_M". */
export function modelLabel(name) {
  if (!name) return 'No model';
  let s = String(name);
  if (s.startsWith('hf.co/')) s = s.split('/').slice(2).join('/');
  const [base, tag] = s.split(':');
  return tag && tag !== 'latest' ? `${base} · ${tag}` : base;
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
