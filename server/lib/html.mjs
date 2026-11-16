// HTML → readable plain text, dependency-free and linear-time (no backtracking regexes over the document:
// a hostile page must never be able to stall the server). Input is capped at MAX_HTML characters.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', laquo: '«', raquo: '»', euro: '€', pound: '£', yen: '¥', deg: '°' };

export const MAX_HTML = 1024 * 1024;

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'head', 'nav', 'footer', 'aside', 'object', 'embed', 'select']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'ul', 'ol', 'table', 'tr', 'blockquote', 'pre', 'header', 'form', 'figure', 'dl', 'dd', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function attr(tagText, name) {
  // tagText is bounded (one tag); a simple indexOf-based parse, no regex backtracking.
  const low = tagText.toLowerCase();
  let i = low.indexOf(`${name}=`);
  if (i < 0) return null;
  i += name.length + 1;
  const q = tagText[i];
  if (q === '"' || q === "'") {
    const j = tagText.indexOf(q, i + 1);
    return j < 0 ? null : tagText.slice(i + 1, j);
  }
  let j = i;
  while (j < tagText.length && !/[\s>]/.test(tagText[j])) j++;
  return tagText.slice(i, j);
}

/** @returns {{ title: string, text: string }} */
export function htmlToText(html) {
  const src = String(html).slice(0, MAX_HTML);
  const low = src.toLowerCase();
  const out = [];
  const mainOut = [];
  let inMain = 0;
  let title = '';
  const ts = low.indexOf('<title');
  if (ts >= 0) {
    const tgt = low.indexOf('>', ts);
    const te = tgt < 0 ? -1 : low.indexOf('</title', tgt);
    if (te > tgt) title = decodeEntities(src.slice(tgt + 1, Math.min(te, tgt + 2000))).replace(/\s+/g, ' ').trim().slice(0, 500);
  }
  let pendingHref = null;
  const push = (t) => { out.push(t); if (inMain) mainOut.push(t); };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { push(src.slice(i)); break; }
    if (lt > i) push(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    const gt = src.indexOf('>', lt + 1);
    if (gt < 0) { push(' '); break; } // unclosed tag: the rest is not text
    const tagText = src.slice(lt + 1, gt);
    i = gt + 1;
    if (!tagText || tagText[0] === '!' || tagText[0] === '?') continue;
    const closing = tagText[0] === '/';
    let k = closing ? 1 : 0;
    let name = '';
    while (k < tagText.length && /[a-zA-Z0-9]/.test(tagText[k]) && name.length < 20) name += tagText[k++];
    name = name.toLowerCase();
    if (!name) continue;
    if (!closing && name === 'title') {
      const end = low.indexOf('</title', i);
      i = end < 0 ? n : low.indexOf('>', end) + 1 || n;
      continue;
    }
    if (!closing && SKIP.has(name) && !tagText.endsWith('/')) {
      const end = low.indexOf(`</${name}`, i);
      i = end < 0 ? n : low.indexOf('>', end) + 1 || n;
      push(' ');
      continue;
    }
    if (name === 'main' || name === 'article') { inMain = Math.max(0, inMain + (closing ? -1 : 1)); push('\n\n'); continue; }
    if (name === 'br') { push('\n'); continue; }
    if (name === 'li' && !closing) { push('\n• '); continue; }
    if (/^h[1-6]$/.test(name) && !closing) { push(`\n\n${'#'.repeat(Number(name[1]))} `); continue; }
    if ((name === 'td' || name === 'th') && !closing) { push(' | '); continue; }
    if (name === 'a') {
      if (!closing) { const h = attr(tagText, 'href'); pendingHref = h && /^https?:/i.test(h) ? h.slice(0, 500) : null; }
      else if (pendingHref) { push(` (${pendingHref})`); pendingHref = null; }
      continue;
    }
    if (BLOCK.has(name)) { push(closing ? '\n\n' : '\n'); continue; }
    push(' ');
  }
  const tidy = (parts) => decodeEntities(parts.join('')).replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const main = tidy(mainOut);
  return { title, text: main.length > 500 ? main : tidy(out) };
}
