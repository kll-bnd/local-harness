// Overlay primitives: toasts, modal dialogs (native <dialog>), menus and popovers.
// All are keyboard-accessible: dialogs trap focus natively and restore it, menus support arrow keys,
// Home/End, type-ahead and Escape, popovers close on Escape / outside click and restore focus.
import { h, focusables, nextId, add } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

// ------------------------------------------------------------------------------------------------ toasts
let toastHost = null;
const toastsById = new Map();

function host() {
  if (!toastHost) {
    toastHost = h('div.toasts', { role: 'region', 'aria-label': 'Notifications' });
    add(document.body, toastHost);
  }
  return toastHost;
}

/**
 * toast({ message, detail?, kind: 'info'|'success'|'warn'|'error', action?: {label, run}, timeout?, id? })
 * Re-using an `id` updates the existing toast instead of stacking a new one.
 */
export function toast(opts) {
  if (typeof opts === 'string') opts = { message: opts };
  const { message, detail = null, kind = 'info', action = null, timeout = kind === 'error' ? 9000 : 4500, id = null, onDismiss = null } = opts;
  if (id && toastsById.has(id)) toastsById.get(id).dismiss(true, 'replaced');
  const iconName = { info: 'info', success: 'check', warn: 'warning', error: 'error' }[kind] || 'info';
  let timer = null;
  const el = h(`div.toast.toast-${kind}`, { role: kind === 'error' ? 'alert' : 'status' },
    h('span.toast-icon', icon(iconName)),
    h('div.toast-body', h('div.toast-msg', message), detail ? h('div.toast-detail', detail) : null),
    action ? h('button.btn.btn-small.toast-action', { type: 'button', on: { click: () => { dismiss(false, 'action'); action.run(); } } }, action.label) : null,
    h('button.icon-btn.toast-close', { type: 'button', 'aria-label': 'Dismiss', on: { click: () => dismiss(false, 'close') } }, icon('x', { size: 14 })),
  );
  let gone = false;
  /** reason: 'timeout' | 'close' | 'action' | 'replaced' | 'flush' (→ onDismiss, once). */
  const dismiss = (immediate = false, reason = 'close') => {
    clearTimeout(timer);
    if (id && toastsById.get(id) === handle) toastsById.delete(id);
    if (!gone) { gone = true; try { onDismiss?.(reason); } catch (e) { console.error(e); } }
    if (immediate) { el.remove(); return; }
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  };
  // The timer pauses while the pointer or focus is on the toast — also when it appeared under a resting pointer
  // (no mouseenter then), so it is checked again when the time is up.
  const arm = () => {
    if (timeout <= 0) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (el.matches(':hover') || el.contains(document.activeElement)) arm(); else dismiss(false, 'timeout'); }, timeout);
  };
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', arm);
  el.addEventListener('focusin', () => clearTimeout(timer));
  const handle = { dismiss, el };
  add(host(), el);
  arm();
  if (id) toastsById.set(id, handle);
  return handle;
}

/**
 * "Deleted — Undo": the change is committed when the toast goes away without Undo (its timeout, which pauses
 * while the pointer or focus is on it, the close button, or being replaced) — so Undo is never shown for
 * something already done. flush(unloading) commits at once (e.g. the page is going away).
 *   commit({ unloading }) · undo()
 */
export function undoToast({ message, detail = null, timeout = 6000, id = null, commit, undo }) {
  let state = 'pending';
  const done = (unloading = false) => { if (state !== 'pending') return; state = 'committed'; commit({ unloading }); };
  const t = toast({
    message, detail, timeout, id,
    action: { label: 'Undo', run: () => { if (state !== 'pending') return; state = 'undone'; undo?.(); } },
    onDismiss: (reason) => { if (reason !== 'action' && reason !== 'flush') done(false); },
  });
  return {
    get pending() { return state === 'pending'; },
    flush(unloading = false) { if (state !== 'pending') return; done(unloading); t.dismiss(true, 'flush'); },
  };
}

// ------------------------------------------------------------------------------------------------ dialogs
/**
 * openDialog({ title, body, actions: [{label, kind:'primary'|'danger'|'', run(close) → false keeps open, autofocus}], size, onClose, className })
 * Returns { close, el }. Uses <dialog>.showModal() so the rest of the page is inert while open.
 */
export function openDialog({ title, description = null, body = null, actions = [], size = 'medium', onClose = null, className = '', dismissible = true }) {
  const returnFocus = document.activeElement;
  const titleId = nextId('dlg-title');
  const dlg = h(`dialog.dialog.dialog-${size}`, { class: className, attrs: { 'aria-labelledby': titleId } });
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    dlg.close();
    dlg.remove();
    onClose?.(result);
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus?.();
  };
  const footer = actions.length ? h('footer.dialog-actions', actions.map((a) => h(`button.btn${a.kind ? `.btn-${a.kind}` : ''}`, {
    type: 'button', disabled: !!a.disabled, dataset: { autofocus: a.autofocus ? '1' : null },
    on: { click: async (e) => { const r = await a.run?.(close, e); if (r !== false) close(a.result ?? a.label); } },
  }, a.label))) : null;
  add(dlg, 
    h('header.dialog-head',
      h('h2.dialog-title', { id: titleId }, title),
      dismissible ? h('button.icon-btn.dialog-x', { type: 'button', 'aria-label': 'Close', on: { click: () => close(null) } }, icon('x')) : null),
    description ? h('p.dialog-desc', description) : null,
    body ? h('div.dialog-body', body) : null,
    footer,
  );
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (dismissible) close(null); });
  dlg.addEventListener('mousedown', (e) => { if (e.target === dlg && dismissible) close(null); });
  add(document.body, dlg);
  dlg.showModal();
  const auto = dlg.querySelector('[data-autofocus="1"]') || dlg.querySelector('[autofocus]') || focusables(dlg.querySelector('.dialog-body') || dlg)[0];
  auto?.focus();
  return { close, el: dlg };
}

export function confirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    openDialog({
      title, description: message, size: 'small',
      actions: [
        { label: cancelLabel, run: () => resolve(false) },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', autofocus: true, run: () => resolve(true) },
      ],
      onClose: (r) => { if (r === null) resolve(false); },
    });
  });
}

export function promptDialog({ title, label = '', value = '', placeholder = '', confirmLabel = 'Save', multiline = false, validate = null }) {
  return new Promise((resolve) => {
    const input = multiline
      ? h('textarea.input.textarea', { value, placeholder, rows: 6, attrs: { 'aria-label': label || title } })
      : h('input.input', { type: 'text', value, placeholder, attrs: { 'aria-label': label || title } });
    const err = h('div.field-error', { hidden: true });
    let done = false;
    const submit = (close) => {
      const v = input.value;
      const msg = validate?.(v);
      if (msg) { err.textContent = msg; err.hidden = false; return false; }
      done = true;
      resolve(v);
      close?.(v);
      return true;
    };
    const d = openDialog({
      title, size: 'small',
      body: h('div.stack', label ? h('label.field-label', label) : null, input, err),
      actions: [{ label: 'Cancel', run: () => { done = true; resolve(null); } }, { label: confirmLabel, kind: 'primary', run: (close) => submit(close) }],
      onClose: () => { if (!done) resolve(null); },
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); submit(d.close); }
    });
    input.focus();
    if (!multiline) input.select();
  });
}

// ------------------------------------------------------------------------------------------------ positioning
function place(el, anchor, { placement = 'bottom-start', offset = 6 } = {}) {
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
  el.style.left = '0px';
  el.style.top = '0px';
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const [side, align] = placement.split('-');
  let x;
  let y;
  if (side === 'top' || side === 'bottom') {
    x = align === 'end' ? r.right - w : align === 'center' ? r.left + r.width / 2 - w / 2 : r.left;
    y = side === 'bottom' ? r.bottom + offset : r.top - hgt - offset;
    if (side === 'bottom' && y + hgt > vh - 8 && r.top - hgt - offset > 8) y = r.top - hgt - offset;
    if (side === 'top' && y < 8 && r.bottom + offset + hgt < vh - 8) y = r.bottom + offset;
  } else {
    y = align === 'end' ? r.bottom - hgt : r.top;
    x = side === 'right' ? r.right + offset : r.left - w - offset;
  }
  x = Math.max(8, Math.min(x, vw - w - 8));
  y = Math.max(8, Math.min(y, vh - hgt - 8));
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
}

const openStack = [];

function trackOutside(el, anchor, close) {
  const onDown = (e) => {
    if (el.contains(e.target)) return;
    if (anchor instanceof Element && anchor.contains(e.target)) { e.stopPropagation(); close(); return; }
    close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && openStack[openStack.length - 1] === el) { e.preventDefault(); e.stopPropagation(); close(true); }
  };
  const onResize = () => close();
  setTimeout(() => { document.addEventListener('pointerdown', onDown, true); }, 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  return () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
  };
}

/**
 * openPopover(anchor, content, { placement, className, onClose, label }) → { close, el, reposition }
 * A non-modal floating panel. Escape and outside clicks close it; focus returns to the anchor.
 */
export function openPopover(anchor, content, { placement = 'bottom-start', className = '', onClose = null, label = null, focus = true } = {}) {
  const el = h('div.popover', { class: className, role: 'dialog', attrs: { 'aria-label': label } }, content);
  add(document.body, el);
  place(el, anchor, { placement });
  openStack.push(el);
  if (anchor instanceof Element) anchor.setAttribute('aria-expanded', 'true');
  let closed = false;
  const untrack = trackOutside(el, anchor, (viaKey) => close(viaKey));
  function close(restore = false) {
    if (closed) return;
    closed = true;
    untrack();
    openStack.splice(openStack.indexOf(el), 1);
    el.remove();
    if (anchor instanceof Element) anchor.setAttribute('aria-expanded', 'false');
    if ((restore || el.contains(document.activeElement) || document.activeElement === document.body) && anchor instanceof Element && document.contains(anchor)) anchor.focus();
    onClose?.();
  }
  if (focus) (el.querySelector('[autofocus], input, [role="menuitem"], [role="option"], button') || el).focus?.();
  return { close, el, reposition: () => place(el, anchor, { placement }) };
}

/**
 * openMenu(anchor, items, opts) — items: { label, icon?, hint?, shortcut?, run, danger?, disabled?, checked? } |
 * { separator: true } | { heading: 'text' }. Returns { close }.
 */
export function openMenu(anchor, items, { placement = 'bottom-start', label = 'Menu', onClose = null } = {}) {
  const list = h('div.menu', { role: 'menu', attrs: { 'aria-label': label }, tabIndex: -1 });
  const entries = [];
  let pop = null;
  for (const it of items) {
    if (!it) continue;
    if (it.separator) { add(list, h('div.menu-sep', { role: 'separator' })); continue; }
    if (it.heading) { add(list, h('div.menu-heading', { role: 'presentation' }, it.heading)); continue; }
    const role = it.checked === undefined ? 'menuitem' : 'menuitemcheckbox';
    const btn = h(`button.menu-item${it.danger ? '.danger' : ''}`, {
      type: 'button', role, tabIndex: -1, disabled: !!it.disabled,
      attrs: { 'aria-checked': it.checked === undefined ? null : String(!!it.checked) },
      dataset: { menuId: it.id || null },
      on: { click: () => { pop.close(true); it.run?.(); } },
    },
    h('span.menu-check', it.checked ? icon('check', { size: 14 }) : null),
    it.icon ? h('span.menu-icon', icon(it.icon, { size: 15 })) : null,
    h('span.menu-label', it.label, it.hint ? h('span.menu-hint', it.hint) : null),
    it.shortcut ? h('kbd.menu-kbd', it.shortcut) : null);
    entries.push(btn);
    add(list, btn);
  }
  let typed = '';
  let typedTimer = null;
  const focusAt = (i) => { const en = entries.filter((e) => !e.disabled); if (!en.length) return; en[(i + en.length) % en.length].focus(); };
  const idx = () => entries.filter((e) => !e.disabled).indexOf(document.activeElement);
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(idx() + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(idx() < 0 ? -1 : idx() - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(-1); }
    else if (e.key === 'Tab') { e.preventDefault(); pop.close(true); }
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey) {
      typed += e.key.toLowerCase();
      clearTimeout(typedTimer);
      typedTimer = setTimeout(() => { typed = ''; }, 600);
      const en = entries.filter((x) => !x.disabled);
      const hit = en.find((x) => x.textContent.trim().toLowerCase().startsWith(typed));
      hit?.focus();
    }
  });
  pop = openPopover(anchor, list, { placement, className: 'menu-pop', onClose, label, focus: false });
  focusAt(0);
  return pop;
}

/** Context-menu helper: bind right-click / long-press on el to openMenu at the pointer. */
export function bindContextMenu(el, itemsFn) {
  el.addEventListener('contextmenu', (e) => {
    const items = itemsFn(e);
    if (!items) return;
    e.preventDefault();
    openMenu({ x: e.clientX, y: e.clientY }, items);
  });
}
