// Tolerant, linear-time helpers for reading the ollama.com pages (which have no API). Never throw on odd markup.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™' };

export function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Text content of an HTML fragment (tags removed, entities decoded, whitespace collapsed). */
export function textOf(html) {
  return decodeEntities(String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const BLOCK = /^(p|div|section|article|header|footer|h[1-6]|ul|ol|li|pre|blockquote|table|tr|br|hr)$/i;

/**
 * README HTML → readable text with line breaks and light markdown (headings, list bullets, code fences), in one
 * pass over the tags. Script/style content is dropped; links keep their text only.
 */
export function htmlToText(html, { maxChars = 200000 } = {}) {
  const s = String(html || '');
  let out = '';
  let i = 0;
  let pre = 0;
  let skip = null;
  while (i < s.length && out.length < maxChars + 1000) {
    const lt = s.indexOf('<', i);
    const chunk = lt < 0 ? s.slice(i) : s.slice(i, lt);
    if (!skip && chunk) out += pre ? decodeEntities(chunk) : decodeEntities(chunk).replace(/\s+/g, ' ');
    if (lt < 0) break;
    const gt = s.indexOf('>', lt);
    if (gt < 0) break;
    const tag = s.slice(lt + 1, gt);
    i = gt + 1;
    const m = /^(\/?)([a-zA-Z][\w-]*)/.exec(tag);
    if (!m) continue;
    const closing = !!m[1];
    const name = m[2].toLowerCase();
    if (skip) { if (closing && name === skip) skip = null; continue; }
    if (!closing && (name === 'script' || name === 'style' || name === 'svg')) { skip = name; continue; }
    if (name === 'pre') { out += closing ? '\n```\n' : '\n```\n'; pre += closing ? -1 : 1; if (pre < 0) pre = 0; continue; }
    if (!closing && /^h[1-6]$/.test(name)) { out += `\n\n${'#'.repeat(Number(name[1]))} `; continue; }
    if (!closing && name === 'li') { out += '\n- '; continue; }
    if (!closing && name === 'code' && !pre) { out += '`'; continue; }
    if (closing && name === 'code' && !pre) { out += '`'; continue; }
    if (BLOCK.test(name)) out += name === 'br' ? '\n' : '\n\n';
  }
  const text = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
}

/** The HTML between the element that `startRe` matches and its matching close tag (same tag name, nesting-aware). */
export function elementAfter(html, startRe) {
  const m = startRe.exec(html);
  if (!m) return null;
  const tagName = (/^<([a-zA-Z][\w-]*)/.exec(m[0]) || [])[1]?.toLowerCase();
  if (!tagName) return null;
  const re = new RegExp(`<(/?)${tagName}\\b[^>]*>`, 'gi');
  re.lastIndex = m.index + m[0].length;
  let depth = 1;
  let x;
  while ((x = re.exec(html))) {
    depth += x[1] ? -1 : 1;
    if (depth === 0) return html.slice(m.index + m[0].length, x.index);
  }
  return html.slice(m.index + m[0].length);
}
