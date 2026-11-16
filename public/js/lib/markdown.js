// Markdown rendering for untrusted model output.
//
// Pipeline: marked (GFM) → DOMPurify with a strict allow-list and policy hooks → inert <template> →
// trusted DOM enhancements (code-block header + copy button, syntax highlighting, blocked-image links).
//
// Policy (enforced inside DOMPurify, i.e. before anything touches the live document):
//   * No scripts, styles, forms, frames, SVG/MathML, event handlers, ids/names, or class attributes
//     (except `language-*` on <code>).
//   * <img> only for same-origin Harness media (/api/images/…/file, /api/attachments/…/content) and
//     data:image/{png,jpeg,gif,webp}. Anything else becomes a plain link — a remote image URL is an
//     exfiltration channel (the model can encode chat contents into it), so it is never fetched.
//   * Links: http(s) and mailto open in a new window with rel="noopener noreferrer"; same-origin /api/
//     links are allowed; everything else loses its href.
// The page CSP (img-src 'self' data: blob:) is a second line of defence.
import { Marked } from '../../vendor/marked/marked.esm.js';
import DOMPurify from '../../vendor/dompurify/purify.es.mjs';
import hljs from '../../vendor/highlight/highlight.min.js';
import { h, mount, add } from './dom.js';
import { icon } from './icons.js';

const marked = new Marked({ gfm: true, breaks: false, async: false });
// What you type is shown as you typed it: markdown structure (code fences, lists) renders, but raw HTML is
// displayed as text and single newlines are kept.
const userMarked = new Marked({ gfm: true, breaks: true, async: false, renderer: { html({ text }) { return escapeHtml(text); } } });

const ALLOWED_TAGS = ['a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var'];
const ALLOWED_ATTR = ['href', 'title', 'alt', 'src', 'class', 'align', 'start', 'type', 'checked', 'disabled', 'colspan', 'rowspan', 'open', 'width', 'height', 'reversed'];

const SAFE_IMG = /^(\/api\/images\/[\w-]+\/file|\/api\/attachments\/[\w-]+\/content)(\?[\w=&%-]*)?$/;
const SAFE_DATA_IMG = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const EXTERNAL = /^(https?:|mailto:)/i;

const purify = DOMPurify(window);
let sanitizingHighlight = false; // highlight.js output: <span class="hljs-…"> only, classes allowed
purify.addHook('uponSanitizeAttribute', (node, data) => {
  if (sanitizingHighlight) { data.keepAttr = data.attrName === 'class' && /^(hljs-[\w-]+|language_|function_|class_)( [\w-]+)*$/.test(data.attrValue); return; }
  if (data.attrName === 'class') {
    data.keepAttr = node.nodeName === 'CODE' && /^language-[\w+#.-]{1,40}$/.test(data.attrValue);
  } else if ((data.attrName === 'width' || data.attrName === 'height') && !/^\d{1,4}$/.test(data.attrValue)) {
    data.keepAttr = false;
  }
});
purify.addHook('afterSanitizeAttributes', (node) => {
  const tag = node.nodeName;
  if (tag === 'A') {
    const href = (node.getAttribute('href') || '').trim();
    if (EXTERNAL.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
      node.setAttribute('data-external', '');
    } else if (href.startsWith('/api/')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    } else {
      node.removeAttribute('href');
    }
  } else if (tag === 'IMG') {
    const src = (node.getAttribute('src') || '').trim();
    if (!(SAFE_IMG.test(src) || SAFE_DATA_IMG.test(src))) {
      node.removeAttribute('src');
      node.setAttribute('data-blocked-src', src.slice(0, 2000));
    } else {
      node.setAttribute('loading', 'lazy');
      node.setAttribute('decoding', 'async');
      node.setAttribute('data-md-img', '');
    }
  } else if (tag === 'INPUT') {
    if (node.getAttribute('type') !== 'checkbox') node.remove();
    else node.setAttribute('disabled', '');
  }
});

const PURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR: [...ALLOWED_ATTR, 'target', 'rel', 'loading', 'decoding', 'data-external', 'data-blocked-src', 'data-md-img'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'svg', 'math', 'object', 'embed', 'link', 'meta', 'base', 'template', 'textarea', 'select', 'button', 'video', 'audio', 'source', 'picture'],
  FORBID_ATTR: ['style', 'id', 'name', 'srcset', 'action', 'formaction', 'xlink:href'],
  KEEP_CONTENT: true,
};

const HL_PURIFY = { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'], KEEP_CONTENT: true };

/** Sanitize an HTML string into an inert DocumentFragment (safe to adopt into the page). */
function toFragment(html) {
  const clean = purify.sanitize(html, PURIFY_CONFIG);
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  return tpl.content;
}

const MAX_HIGHLIGHT_CHARS = 300_000;
const DEFER_HIGHLIGHT_CHARS = 20_000; // bigger blocks show plain first and are highlighted when the page is idle

// requestIdleCallback is missing in Safari/WebKit: fall back to a short timeout.
const whenIdle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 60));

function highlightCode(codeEl) {
  const m = /language-([\w+#.-]+)/.exec(codeEl.className || '');
  const lang = m ? m[1].toLowerCase() : '';
  const text = codeEl.textContent;
  if (!lang || !hljs.getLanguage(lang) || text.length > MAX_HIGHLIGHT_CHARS) return lang;
  try {
    const out = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    const tpl = document.createElement('template');
    sanitizingHighlight = true;
    try { tpl.innerHTML = purify.sanitize(out, HL_PURIFY); } finally { sanitizingHighlight = false; }
    mount(codeEl, tpl.content);
    codeEl.classList.add('hljs');
  } catch { /* leave plain */ }
  return lang;
}

const LANG_LABELS = { js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript', py: 'Python', python: 'Python', sh: 'Shell', bash: 'Bash', zsh: 'Shell', shell: 'Shell', json: 'JSON', html: 'HTML', xml: 'XML', css: 'CSS', md: 'Markdown', markdown: 'Markdown', yaml: 'YAML', yml: 'YAML', sql: 'SQL', rust: 'Rust', rs: 'Rust', go: 'Go', swift: 'Swift', c: 'C', cpp: 'C++', 'c++': 'C++', java: 'Java', kotlin: 'Kotlin', ruby: 'Ruby', rb: 'Ruby', php: 'PHP', diff: 'Diff', csharp: 'C#', cs: 'C#', lua: 'Lua', r: 'R', toml: 'TOML', ini: 'INI', dockerfile: 'Dockerfile', makefile: 'Makefile', text: 'Text', plaintext: 'Text' };

export function codeBlockShell(pre, lang, { streaming = false } = {}) {
  const label = lang ? (LANG_LABELS[lang] || lang) : 'Code';
  const wrap = h('div.code-block', { dataset: { lang: lang || '' } },
    h('div.code-head', h('span.code-lang', label),
      h('button.code-copy', { type: 'button', title: 'Copy code', dataset: { action: 'copy-code' }, disabled: streaming, 'aria-label': `Copy ${label} code` }, icon('copy', { size: 14 }), h('span', 'Copy'))),
  );
  pre.replaceWith(wrap);
  add(wrap, pre);
  return wrap;
}

function enhance(frag, { highlight = true, quietImages = false } = {}) {
  for (const code of frag.querySelectorAll('pre > code')) {
    const lang = /language-([\w+#.-]+)/.exec(code.className || '')?.[1]?.toLowerCase() || '';
    if (highlight && code.textContent.length <= DEFER_HIGHLIGHT_CHARS) highlightCode(code);
    codeBlockShell(code.parentElement, lang);
  }
  for (const img of frag.querySelectorAll('img[data-blocked-src]')) {
    const src = img.getAttribute('data-blocked-src');
    const alt = img.getAttribute('alt') || '';
    if (quietImages) {
      // Documents from the internet (model cards): a quiet placeholder, no link to the picture.
      img.replaceWith(h('span.img-placeholder', { title: 'Pictures from the internet are not loaded' }, icon('image', { size: 12 }), alt ? h('span', alt.slice(0, 80)) : null));
      continue;
    }
    let host = '';
    try { host = new URL(src).host; } catch { /* not a URL */ }
    const label = h('span.blocked-img-label', `Remote image not loaded${host ? ` (${host})` : ''}${alt ? `: ${alt}` : ''}`);
    const repl = /^https?:/i.test(src)
      ? h('a.blocked-img', { href: src, target: '_blank', rel: 'noopener noreferrer', title: src, dataset: { external: '' } }, icon('image', { size: 14 }), label)
      : h('span.blocked-img', { title: src }, icon('image', { size: 14 }), label);
    img.replaceWith(repl);
  }
  for (const t of frag.querySelectorAll('table')) {
    const wrap = h('div.table-wrap');
    t.replaceWith(wrap);
    add(wrap, t);
  }
  return frag;
}

// Small LRU of finished renders: switching chats or re-rendering a turn never re-parses old messages.
const cache = new Map();
const CACHE_MAX = 400;

/** Big code blocks are highlighted after first paint, when the page is idle, if still on screen by then. */
function deferHighlights(frag) {
  for (const code of frag.querySelectorAll('.code-block code:not(.hljs)')) {
    if (code.textContent.length > DEFER_HIGHLIGHT_CHARS) whenIdle(() => { if (code.isConnected && !code.classList.contains('hljs')) highlightCode(code); });
  }
  return frag;
}

/** Render complete markdown to a DocumentFragment. */
export function renderMarkdown(text, { cacheKey = null, quietImages = false } = {}) {
  text = String(text ?? '');
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && hit.text === text) {
      cache.delete(cacheKey);
      cache.set(cacheKey, hit);
      return deferHighlights(hit.tpl.content.cloneNode(true));
    }
  }
  let html;
  try { html = marked.parse(text); } catch { html = `<p>${escapeHtml(text)}</p>`; }
  const frag = enhance(toFragment(html), { quietImages });
  if (cacheKey) {
    const tpl = document.createElement('template');
    add(tpl.content, frag.cloneNode(true));
    cache.set(cacheKey, { text, tpl });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return deferHighlights(frag);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const FENCE = /^\s{0,12}(`{3,}|~{3,})(.*)$/;

/**
 * Incremental renderer for a streaming message. Text is split at "safe" block boundaries (blank lines and
 * closing code fences outside of fences); everything before the last boundary is rendered once and never
 * touched again, only the tail is re-rendered per frame. An unterminated code fence in the tail is
 * rendered as plain text and grown by appending to a text node, so long code blocks stay O(delta).
 * Call finish(text) at the end for one authoritative full render.
 */
export class StreamingMarkdown {
  constructor(el, { cacheKey = null } = {}) {
    this.el = el;
    this.cacheKey = cacheKey;
    this.reset();
  }

  reset() {
    this.stable = h('div.md-stable');
    this.tail = h('div.md-tail');
    mount(this.el, this.stable, this.tail);
    this.stableLen = 0;
    this.scanPos = 0;
    this.fence = null; // { char, len, start, bodyStart }
    this.safe = 0;
    this.open = null; // incremental open-fence render state
    this.text = '';
    this.finished = false;
  }

  _scan(text) {
    while (this.scanPos < text.length) {
      const nl = text.indexOf('\n', this.scanPos);
      if (nl < 0) break;
      const line = text.slice(this.scanPos, nl);
      const m = FENCE.exec(line);
      if (this.fence) {
        if (m && m[1][0] === this.fence.char && m[1].length >= this.fence.len && !m[2].trim()) {
          this.fence = null;
          this.safe = nl + 1;
        }
      } else if (m) {
        this.fence = { char: m[1][0], len: m[1].length, start: this.scanPos, bodyStart: nl + 1, info: m[2].trim() };
      } else if (!line.trim()) {
        this.safe = nl + 1;
      }
      this.scanPos = nl + 1;
    }
  }

  update(text) {
    if (this.finished || !text.startsWith(this.text)) this.reset();
    this.text = text;
    this._scan(text);
    if (this.safe > this.stableLen) {
      add(this.stable, renderMarkdown(text.slice(this.stableLen, this.safe)));
      this.stableLen = this.safe;
      this.open = null;
      mount(this.tail);
    }
    const tail = text.slice(this.stableLen);
    if (this.fence && this.fence.start >= this.stableLen) {
      const pre = text.slice(this.stableLen, this.fence.start);
      const body = text.slice(Math.min(this.fence.bodyStart, text.length));
      if (this.open && this.open.start === this.fence.start && this.open.pre === pre && body.startsWith(this.open.body)) {
        if (body.length > this.open.body.length) this.open.node.appendData(body.slice(this.open.body.length));
        this.open.body = body;
        return;
      }
      const frag = document.createDocumentFragment();
      if (pre.trim()) add(frag, renderMarkdown(pre));
      const lang = (this.fence.info || '').split(/\s+/)[0].toLowerCase();
      const node = document.createTextNode(body);
      const pre2 = h('pre', h('code', node));
      add(frag, pre2);
      mount(this.tail, frag);
      codeBlockShell(pre2, lang, { streaming: true });
      this.open = { start: this.fence.start, pre, body, node };
      return;
    }
    this.open = null;
    mount(this.tail, tail ? renderMarkdown(tail) : '');
  }

  finish(text) {
    this.text = text;
    this.finished = true;
    mount(this.el, renderMarkdown(text, { cacheKey: this.cacheKey }));
  }
}

/** Render a user's message (markdown structure, raw HTML shown literally). */
export function renderUserMarkdown(text, { cacheKey = null } = {}) {
  text = String(text ?? '');
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && hit.text === text) return hit.tpl.content.cloneNode(true);
  }
  let html;
  try { html = userMarked.parse(text); } catch { html = `<p>${escapeHtml(text)}</p>`; }
  const frag = enhance(toFragment(html));
  if (cacheKey) {
    const tpl = document.createElement('template');
    add(tpl.content, frag.cloneNode(true));
    cache.set(cacheKey, { text, tpl });
  }
  return frag;
}

/** Plain text → paragraphs (for user messages: no markdown interpretation, preserves whitespace). */
export function renderPlain(text) {
  return h('div.plain', String(text ?? ''));
}
