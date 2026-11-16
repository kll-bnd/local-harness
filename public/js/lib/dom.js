// Tiny DOM toolkit: hyperscript-style element builder plus a few helpers.
// Everything is built with createElement/textContent — never innerHTML with untrusted strings.
// (Sanitized markdown goes through lib/markdown.js, which is the only place HTML strings are parsed.)

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('div.card.is-open', { attrs, dataset, on: { click }, ...props }, ...children)
 * - tag may carry classes after dots ("button.btn.primary") and an id after '#'.
 * - props: class (string|array|object), text, title, attrs, dataset, on, style (object), ref (fn)
 *   plus any DOM property (value, checked, disabled, type, tabIndex, hidden, …).
 * - children: nodes, strings, numbers, arrays, null/false (skipped).
 */
export function h(tag, props, ...children) {
  if (props instanceof Node || typeof props === 'string' || Array.isArray(props) || props == null || typeof props === 'number') {
    if (props != null) children.unshift(props);
    props = {};
  }
  const [base, ...rest] = tag.split('.');
  const [name, id] = base.split('#');
  const el = document.createElement(name || 'div');
  if (id) el.id = id;
  if (rest.length) el.classList.add(...rest);
  applyProps(el, props);
  append(el, children);
  return el;
}

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}

function applyProps(el, props) {
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    switch (k) {
      case 'class': addClasses(el, v); break;
      case 'text': el.textContent = v == null ? '' : String(v); break;
      case 'attrs': for (const [a, av] of Object.entries(v)) { if (av === false || av == null) el.removeAttribute(a); else el.setAttribute(a, av === true ? '' : String(av)); } break;
      case 'dataset': for (const [a, av] of Object.entries(v)) if (av != null) el.dataset[a] = String(av); break;
      case 'on': for (const [ev, fn] of Object.entries(v)) if (fn) el.addEventListener(ev, fn); break;
      case 'style': for (const [p, pv] of Object.entries(v)) { if (pv == null) continue; if (p.startsWith('--')) el.style.setProperty(p, String(pv)); else el.style[p] = pv; } break;
      case 'ref': v(el); break;
      case 'aria': for (const [a, av] of Object.entries(v)) { if (av == null) el.removeAttribute(`aria-${a}`); else el.setAttribute(`aria-${a}`, String(av)); } break;
      case 'role': el.setAttribute('role', v); break;
      case 'for': el.htmlFor = v; break;
      default:
        if (k.startsWith('aria-') || k.startsWith('data-')) { if (v === null || v === false) el.removeAttribute(k); else el.setAttribute(k, String(v)); }
        else el[k] = v;
    }
  }
}

function addClasses(el, v) {
  if (!v) return;
  if (typeof v === 'string') { for (const c of v.split(/\s+/)) if (c) el.classList.add(c); return; }
  if (Array.isArray(v)) { for (const c of v) addClasses(el, c); return; }
  for (const [c, on] of Object.entries(v)) if (on) el.classList.add(c);
}

export function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.append(c);
    else el.append(document.createTextNode(String(c)));
  }
  return el;
}

/** Replace all children of `el`. */
export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

/** Delegated listener: on(root, 'click', '[data-action]', (e, el) => …) */
export function delegate(root, type, selector, fn, opts) {
  const handler = (e) => {
    const el = e.target instanceof Element ? e.target.closest(selector) : null;
    if (el && root.contains(el)) fn(e, el);
  };
  root.addEventListener(type, handler, opts);
  return () => root.removeEventListener(type, handler, opts);
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
  d.cancel = () => { clearTimeout(t); t = null; };
  d.flush = (...args) => { if (t) { clearTimeout(t); t = null; fn(...args); } };
  return d;
}

/** Calls fn at most once per animation frame with the latest arguments. */
export function rafThrottle(fn) {
  let scheduled = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; fn(...lastArgs); });
  };
}

let uid = 0;
export const nextId = (prefix = 'h') => `${prefix}-${++uid}`;

export function isTypingTarget(el) {
  if (!el || !(el instanceof Element)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(el.type);
  return false;
}

export function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Focusable descendants (for focus traps). */
export function focusables(root) {
  return $$('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]', root)
    .filter((el) => !el.closest('[hidden]') && !el.closest('[inert]') && el.getClientRects().length > 0);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const ta = h('textarea', { value: text, attrs: { readonly: true }, style: { position: 'fixed', opacity: '0', top: '0', left: '0' } });
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

/** Trigger a browser download of a same-origin URL or a Blob. */
export function download(urlOrBlob, filename) {
  const url = urlOrBlob instanceof Blob ? URL.createObjectURL(urlOrBlob) : urlOrBlob;
  const a = h('a', { href: url, attrs: { download: filename || '' }, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  if (urlOrBlob instanceof Blob) setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function pickFiles({ accept = '', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, hidden: true });
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); }, { once: true });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); }, { once: true });
    document.body.append(input);
    input.click();
  });
}

/** Autosize a textarea to its content (bounded by CSS max-height). */
export function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}
