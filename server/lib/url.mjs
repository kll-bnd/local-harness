export const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

/** Canonical form used to compare URLs (no fragment, no trailing "/" on a bare origin). */
export function normalizeUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
    x.hash = '';
    let h = x.href;
    if (x.pathname === '/' && !x.search) h = h.replace(/\/$/, '');
    return h;
  } catch {
    return null;
  }
}
