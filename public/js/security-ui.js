// Building blocks for everything password-related, shared by the lock/setup screens (gate.js) and the app:
// a password field with an honest strength line, the one-time recovery-key panel, retry countdowns and the
// reusable "confirm with your password" dialog used by every action that lowers protection (docs/API.md 10.3).
import { h, add, download, nextId } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { openDialog } from './ui/overlays.js';
import * as api from './api.js';
import { passwordStrength, recoveryKeyGroups } from './lib/password.js';

// ------------------------------------------------------------------------------------------------ context
/** What the app knows about protection (set by main.js from GET /api/security). */
let ctx = { mode: 'password' };
export function setSecurityContext(c) { ctx = { ...ctx, ...c }; }
export const securityMode = () => ctx.mode;

// ------------------------------------------------------------------------------------------------ fields
/** A password input with a show/hide toggle. → { el, input, focus() } */
export function passwordField({ label = 'Password', autocomplete = 'current-password', placeholder = '', id = nextId('pw'), name = 'password' } = {}) {
  const input = h('input.input.pw-input', { type: 'password', id, name, placeholder, attrs: { autocomplete, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': label } });
  const toggle = h('button.icon-btn.pw-reveal', { type: 'button', title: 'Show password', 'aria-label': 'Show password', 'aria-pressed': 'false', on: { click: () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.title = show ? 'Hide password' : 'Show password';
    toggle.setAttribute('aria-label', toggle.title);
    input.focus();
  } } }, icon('eye', { size: 14 }));
  const el = h('div.pw-field', input, toggle);
  return { el, input, focus: () => input.focus() };
}

/** A strength line under a new-password field. → { el, update(): result } */
export function strengthMeter(input) {
  const bar = h('div.pw-meter', { attrs: { 'aria-hidden': 'true' } }, [0, 1, 2, 3].map(() => h('span')));
  const label = h('span.pw-label');
  const detail = h('span.pw-detail');
  const el = h('div.pw-strength', { attrs: { 'aria-live': 'polite' } }, bar, h('div.pw-text', label, detail));
  const update = () => {
    const r = passwordStrength(input.value);
    el.dataset.score = input.value ? String(r.score) : '';
    el.dataset.ok = String(r.ok);
    [...bar.children].forEach((s, i) => s.classList.toggle('on', !!input.value && r.ok && i < Math.max(1, r.score)));
    label.textContent = r.label;
    detail.textContent = r.detail;
    return r;
  };
  input.addEventListener('input', update);
  update();
  return { el, update };
}

/**
 * An error line about some fields goes away as soon as the user edits one of them (a retry countdown is a
 * separate line and stays).
 */
export function clearOnEdit(errEl, ...inputs) {
  for (const i of inputs) i?.addEventListener('input', () => { errEl.textContent = ''; });
  return errEl;
}

// ------------------------------------------------------------------------------------------------ countdown
export function fmtWait(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Disable `button` and show "Try again in …" in `line` until `ms` have passed. → cancel() */
export function retryCountdown(ms, { button, line, done } = {}) {
  const until = Date.now() + ms;
  let timer = null;
  const tick = () => {
    const left = until - Date.now();
    if (left <= 0) {
      clearInterval(timer);
      if (button) button.disabled = false;
      if (line) line.textContent = '';
      done?.();
      return;
    }
    if (button) button.disabled = true;
    if (line) line.textContent = `Too many tries. You can try again in ${fmtWait(left)}.`;
  };
  tick();
  timer = setInterval(tick, 250);
  return () => clearInterval(timer);
}

// ------------------------------------------------------------------------------------------------ recovery key
/**
 * The recovery key, shown exactly once: readable groups, Copy, Save as a file and an explicit
 * "I have stored it" step. → { el, stored(): boolean }
 */
export function recoveryKeyPanel(key, { createdAt = new Date().toISOString(), onStoredChange = () => {} } = {}) {
  const groups = recoveryKeyGroups(key);
  const keyEl = h('div.rk-key', { attrs: { 'aria-label': 'Recovery key', role: 'textbox', 'aria-readonly': 'true', tabindex: '0' } }, groups.map((g, i) => h(`span.rk-group${i === 0 ? '.rk-prefix' : ''}`, g)));
  const status = h('span.rk-status', { role: 'status' });
  const copyBtn = h('button.btn', { type: 'button', on: { click: async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(key); ok = true; } catch { ok = false; }
    status.textContent = ok ? 'Copied. Paste it into your password manager, then clear your clipboard.' : 'Copying is not allowed here. Select the key and copy it, or save it as a file.';
  } } }, icon('copy', { size: 14 }), 'Copy');
  const saveBtn = h('button.btn', { type: 'button', on: { click: () => {
    const text = [
      'Harness recovery key',
      '',
      key,
      '',
      `Created ${new Date(createdAt).toLocaleString()}.`,
      'If you forget your Harness password, this key opens your data. Harness does not keep a copy.',
      'Without your password and this key, nobody can open your data, including you.',
      'Keep it somewhere safe and private: a password manager, or printed and put away.',
      '',
    ].join('\n');
    download(new Blob([text], { type: 'text/plain' }), 'Harness Recovery Key.txt');
    status.textContent = 'Saved to your downloads. Move it somewhere safe — not only on this Mac.';
  } } }, icon('download', { size: 14 }), 'Save as file…');
  const check = h('input', { type: 'checkbox', id: nextId('rk'), on: { change: () => onStoredChange(check.checked) } });
  const el = h('div.rk-panel',
    keyEl,
    h('div.row.rk-actions', copyBtn, saveBtn, status),
  );
  // The explicit "I have stored it" step; the caller places it after the warning, next to Continue.
  const confirmEl = h('label.rk-confirm', { htmlFor: check.id }, check, h('span', 'I have stored my recovery key somewhere safe'));
  return { el, confirmEl, stored: () => check.checked, focus: () => keyEl.focus() };
}

export const RECOVERY_WARNING = 'This key is shown only now: Harness does not keep a copy and cannot show it again. If you lose both your password and this key, your data is gone for good — nobody can recover it.';

// ------------------------------------------------------------------------------------------------ the Keychain
/** Lock screen: the Keychain's key opened the data, but this data is not set to open without the password. */
export const KEYCHAIN_NOT_ENABLED_GATE = 'This Harness is not set to open without your password, so the key in the Keychain was not used. Enter your password.';

/**
 * Settings, after an unlock: why "Don't ask on this Mac" is not in force (`unlock.keychainError`), in plain words.
 * → { text, detail } — `detail` is the backend's own message where the sentence is general.
 */
export function keychainErrorText(err) {
  if (!err) return null;
  if (err.code === 'keychain_item_exists') {
    return { text: 'The Keychain already holds a different Harness key, so “Don’t ask on this Mac” was not switched on. Choosing it again replaces that key (Harness asks for your password first).', detail: null };
  }
  if (err.code === 'keychain_not_enabled') {
    return { text: 'This data is not set to open without your password, so Harness did not use the key in the Keychain. Choose “Don’t ask on this Mac” if you want that.', detail: null };
  }
  return { text: 'Harness could not get its key from the Keychain, so it asks for your password when it opens.', detail: err.message || null };
}

// ------------------------------------------------------------------------------------------------ confirm
/**
 * Ask for the password before an action that lowers protection, then run it.
 *   run(password|null) → result. ApiError wrong_password / unlock_throttled keep the dialog open with the
 *   reason and the wait; other errors are shown in the dialog too.
 * In "off" mode (no password, development) the action is tried first without one; only if the backend
 * answers confirmation_required is the password asked.
 * → result, or null when cancelled.
 */
export async function confirmWithPassword({ title, message = null, confirmLabel = 'Continue', danger = false, body = null, run, validate = null }) {
  // Off mode: no password ever set (passwordSet false) → nothing to ask; unknown (older backend) → try first.
  if (ctx.mode === 'off' && !validate && ctx.passwordSet !== true) {
    try { return await run(null); } catch (e) {
      if (!(e instanceof api.ApiError) || e.code !== 'confirmation_required') throw e;
    }
  }
  return new Promise((resolve) => {
    const pw = passwordField({ label: 'Harness password' });
    const err = h('div.field-error', { role: 'alert' });
    const wait = h('div.field-help.pw-wait');
    let busy = false;
    let cancelCountdown = null;
    let confirmBtn = null;
    const submit = async (close) => {
      if (busy || confirmBtn?.disabled) return false;
      const extra = validate?.();
      if (extra) { err.textContent = extra; return false; }
      if (!pw.input.value) { err.textContent = 'Type your Harness password.'; pw.focus(); return false; }
      busy = true;
      err.textContent = '';
      confirmBtn.classList.add('busy');
      confirmBtn.disabled = true;
      try {
        const r = await run(pw.input.value);
        busy = false;
        resolve(r);
        close();
        return true;
      } catch (e) {
        busy = false;
        confirmBtn.classList.remove('busy');
        confirmBtn.disabled = false;
        if (e instanceof api.ApiError && (e.code === 'wrong_password' || e.code === 'unlock_throttled')) {
          err.textContent = e.code === 'wrong_password' ? "That's not your Harness password." : '';
          pw.input.select();
          const ms = e.details?.retryAfterMs || 0;
          if (ms > 0) { cancelCountdown?.(); cancelCountdown = retryCountdown(ms, { button: confirmBtn, line: wait }); }
        } else {
          err.textContent = e?.message || 'That did not work.';
        }
        return false;
      }
    };
    clearOnEdit(err, pw.input);
    const form = h('form.pw-confirm', { on: { submit: (e) => { e.preventDefault(); submit(dlg.close); } } },
      message ? h('p.dialog-text', message) : null,
      body,
      h('label.field-label', { htmlFor: pw.input.id }, 'Your Harness password'),
      pw.el, err, wait,
      h('button', { type: 'submit', hidden: true }));
    const dlg = openDialog({
      title, body: form, size: 'small', className: 'confirm-pw',
      actions: [
        { label: 'Cancel', run: () => { resolve(null); } },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', run: (close) => submit(close).then(() => false) },
      ],
      onClose: (r) => { cancelCountdown?.(); if (r === null) resolve(null); },
    });
    confirmBtn = dlg.el.querySelector('.dialog-actions .btn:last-child');
    pw.focus();
  });
}

/** Get a single-use X-Harness-Confirm value (for requests whose body is not ours, e.g. restore). */
export async function confirmationHeader(password) {
  if (!password) return undefined;
  const r = await api.security.confirm(password);
  return r.confirmation;
}

// ------------------------------------------------------------------------------------------------ migration
const OP_TEXT = { encrypt: 'Encrypting your data', decrypt: 'Decrypting your data', reencrypt: 'Re-encrypting your data' };
/** A progress block for migration {op, done, total, error}. → { el, update(m) } */
export function migrationProgress() {
  const title = h('div.mig-title');
  const bar = h('div.progress', h('span'));
  const line = h('div.mig-line.faint');
  const el = h('div.mig', title, bar, line);
  const update = (m) => {
    if (!m) { el.hidden = true; return; }
    el.hidden = false;
    title.textContent = `${OP_TEXT[m.op] || 'Preparing your data'}…`;
    const pct = m.total ? Math.min(100, Math.round((m.done / m.total) * 100)) : null;
    bar.classList.toggle('indeterminate', pct == null);
    bar.firstChild.style.width = pct == null ? '' : `${pct}%`;
    line.textContent = m.error ? `Stopped: ${m.error}` : m.total ? `${m.done.toLocaleString()} of ${m.total.toLocaleString()} files · ${pct}%` : 'Starting…';
  };
  return { el, update };
}
