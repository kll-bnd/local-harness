// HTML → readable plain text (no dependencies). Good enough for articles/docs pages.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', laquo: '«', raquo: '»', euro: '€', pound: '£', yen: '¥', deg: '°' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  let s = String(html);
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = s.match(/<(main|article)\b[\s\S]*?<\/\1>/i);
  if (main && main[0].length > 500) s = main[0];
  s = s.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<h([1-6])\b[^>]*>/gi, (m, n) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/(p|div|section|article|h[1-6]|ul|ol|table|tr|blockquote|pre|header)>/gi, '\n\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, txt) => (txt.trim() && /^https?:/.test(href) ? `${txt} (${href})` : txt))
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: decodeEntities(title), text: s };
}
