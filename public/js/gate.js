// What every page load meets first (docs/API.md 10.10): GET /api/security decides between the first-run
// password setup, the lock screen, a migration in progress, and the app. Nothing of the app (stores, views,
// the event stream) is loaded until Harness is unlocked and this window has a session.
import { h, mount, add, dragRegion } from './lib/dom.js';
import { icon } from './lib/icons.js';
import * as api from './api.js';
import { looksLikeRecoveryKey } from './lib/password.js';
import { passwordField, strengthMeter, recoveryKeyPanel, retryCountdown, migrationProgress, RECOVERY_WARNING } from './security-ui.js';

const root = () => document.getElementById('app');
let passwordReset = null; // { until } after unlocking with the recovery key

function screen(...children) {
  const card = h('div.gate-card', ...children);
  const el = h('div.gate', { role: 'main' },
    dragRegion(h('div.titlebar.gate-titlebar')),
    h('div.gate-center', card));
  mount(root(), el);
  document.documentElement.classList.add('ready');
  return card;
}

const brand = () => h('div.gate-brand', h('img.gate-icon', { src: 'icon.svg', alt: '' }));

/** Wait for the user to press a button: resolves when `fn` resolves true. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ launch code
/** Keychain/off modes: a launcher opens #launch=<code>; trade it for a session and drop it from the address. */
async function consumeLaunchCode() {
  const m = /(?:^#|[#&])launch=([^&]+)/.exec(location.hash);
  if (!m) return;
  const code = decodeURIComponent(m[1]);
  const rest = location.hash.replace(/(?:^#|&)launch=[^&]+/, '').replace(/^#?&/, '#');
  try { history.replaceState(null, '', `${location.pathname}${location.search}${rest && rest !== '#' ? rest : ''}`); } catch { /* ignore */ }
  try { await api.auth.session(code); } catch (e) { console.warn('[harness] launch code not accepted', e?.code); }
}

// ------------------------------------------------------------------------------------------------ main loop
/** Resolves with the security status once Harness is unlocked and this window has a session. */
export async function runGate() {
  await consumeLaunchCode();
  for (;;) {
    let sec;
    try { sec = await api.security.status(); } catch (e) {
      await cantReach(e);
      continue;
    }
    if (sec.state === 'needs_setup') { await setupFlow(sec); continue; }
    if (sec.state === 'migrating') { await migrationScreen(sec); continue; }
    if (sec.state === 'locked' || !sec.session?.authenticated) {
      await lockFlow(sec);
      continue;
    }
    return { security: sec, passwordReset };
  }
}

function cantReach(e) {
  return new Promise((resolve) => {
    screen(
      brand(),
      h('h1.gate-title', "Can't reach Harness"),
      h('p.gate-text', e?.status ? `Harness answered with an error (${e.code || e.status}).` : 'The Harness app may have stopped or is still starting.'),
      h('div.gate-actions', h('button.btn.btn-primary.btn-large', { type: 'button', autofocus: true, on: { click: () => resolve() } }, 'Try again')),
    );
    // Keep trying quietly as well: Harness may simply be starting.
    setTimeout(resolve, 4000);
  });
}

// ------------------------------------------------------------------------------------------------ lock screen
function lockFlow(sec) {
  const mode = sec.mode;
  const unlockable = mode === 'password' || sec.state === 'locked';
  return new Promise((resolve) => {
    let useKey = false;
    let cancelCountdown = null;
    const err = h('div.gate-error', { role: 'alert' });
    const waitLine = h('div.gate-wait', { role: 'status' });
    const pw = passwordField({ label: 'Password', autocomplete: 'current-password', placeholder: 'Password' });
    const keyInput = h('textarea.input.rk-input', { id: 'rk-input', rows: 2, placeholder: 'HRK1-XXXX-XXXX-…', attrs: { 'aria-label': 'Recovery key', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' } });
    const keychainFirst = mode === 'keychain' && sec.state === 'locked';
    const submitBtn = h(`button.btn${keychainFirst ? '' : '.btn-primary'}.btn-large.gate-submit`, { type: 'submit' }, keychainFirst ? 'Unlock with password' : 'Unlock');
    const fieldBox = h('div.gate-field');
    const switchLink = h('button.btn-link.gate-switch', { type: 'button', on: { click: () => { useKey = !useKey; render(); } } });
    const keyNote = h('p.gate-note', { hidden: true }, 'Your recovery key is the one Harness showed you once when you chose your password (it starts with HRK1). After unlocking with it you can choose a new password.');
    const keychainBtn = mode === 'keychain' && sec.state === 'locked'
      ? h('button.btn.btn-primary.btn-large', { type: 'button', on: { click: () => attempt({}) } }, icon('key', { size: 15 }), 'Open Harness')
      : null;

    const render = () => {
      err.textContent = '';
      mount(fieldBox, useKey
        ? [h('label.sr-only', { htmlFor: keyInput.id }, 'Recovery key'), keyInput]
        : [pw.el]);
      switchLink.textContent = useKey ? 'Use your password instead' : 'Use recovery key instead';
      keyNote.hidden = !useKey;
      if (keychainBtn && !useKey && !render.done) keychainBtn.focus();
      else (useKey ? keyInput : pw.input).focus();
      render.done = true;
    };

    const attempt = async (body) => {
      if (submitBtn.disabled) return;
      err.textContent = '';
      submitBtn.disabled = true;
      submitBtn.classList.add('busy');
      try {
        const r = await api.security.unlock(body);
        cancelCountdown?.();
        pw.input.value = '';
        keyInput.value = '';
        if (r.passwordReset?.until) { passwordReset = r.passwordReset; if (await passwordResetScreen(r.passwordReset.until)) passwordReset = null; }
        resolve();
      } catch (e) {
        submitBtn.classList.remove('busy');
        submitBtn.disabled = false;
        if (e?.code === 'wrong_password') err.textContent = "That's not the password.";
        else if (e?.code === 'wrong_recovery_key') err.textContent = "That recovery key doesn't open this Harness.";
        else if (e?.code === 'unlock_throttled') err.textContent = '';
        else if (e?.code === 'network') err.textContent = "Can't reach Harness right now.";
        else err.textContent = e?.message || 'That did not work.';
        const ms = e?.details?.retryAfterMs || 0;
        if (ms > 0) { cancelCountdown?.(); cancelCountdown = retryCountdown(ms, { button: submitBtn, line: waitLine, done: () => (useKey ? keyInput : pw.input).focus() }); }
        (useKey ? keyInput : pw.input).select();
      }
    };

    const form = h('form.gate-form', { on: { submit: (e) => {
      e.preventDefault();
      if (useKey) {
        if (!keyInput.value.trim()) { err.textContent = 'Paste or type your recovery key.'; return; }
        if (!looksLikeRecoveryKey(keyInput.value)) { err.textContent = 'That doesn’t look like a recovery key: it starts with HRK1 and has 13 groups of 4 letters and digits.'; return; }
        attempt({ recoveryKey: keyInput.value.trim() });
      } else {
        if (!pw.input.value) { err.textContent = 'Type your password.'; return; }
        attempt({ password: pw.input.value });
      }
    } } }, fieldBox, submitBtn, err, waitLine);

    const notLocked = sec.state !== 'locked';
    screen(
      brand(),
      h('h1.gate-title', notLocked && mode !== 'password' ? 'Open Harness from its launcher' : 'Harness is locked'),
      notLocked && mode !== 'password'
        ? h('p.gate-text', 'This window has not been signed in. Open Harness from the app or its launcher — or type your Harness password.')
        : h('p.gate-text', mode === 'keychain' ? 'Your data is encrypted. This Mac keeps the key in your Keychain.' : 'Your chats are encrypted on this Mac. Enter your password to open them.'),
      keychainBtn ? h('div.gate-actions', keychainBtn) : null,
      keychainBtn ? h('div.gate-or', 'or') : null,
      unlockable || notLocked ? form : null,
      h('div.gate-foot', switchLink),
      keyNote,
    );
    render();
    const pending = sec.unlock?.retryAfterMs || 0;
    if (pending > 0) cancelCountdown = retryCountdown(pending, { button: submitBtn, line: waitLine });
  });
}

function passwordResetScreen(until) {
  return new Promise((resolve) => {
    const pw = passwordField({ label: 'New password', autocomplete: 'new-password' });
    const again = passwordField({ label: 'New password again', autocomplete: 'new-password', name: 'password2' });
    const meter = strengthMeter(pw.input);
    const err = h('div.gate-error', { role: 'alert' });
    const btn = h('button.btn.btn-primary.btn-large', { type: 'submit' }, 'Save new password');
    const time = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const form = h('form.gate-form', { on: { submit: async (e) => {
      e.preventDefault();
      const r = meter.update();
      if (!r.ok) { err.textContent = r.detail; pw.focus(); return; }
      if (pw.input.value !== again.input.value) { err.textContent = "The two passwords don't match."; again.focus(); return; }
      btn.disabled = true;
      btn.classList.add('busy');
      try {
        await api.security.changePassword({ newPassword: pw.input.value });
        resolve(true);
      } catch (ex) {
        btn.disabled = false;
        btn.classList.remove('busy');
        err.textContent = ex?.code === 'weak_password' ? 'Use at least 8 characters.' : ex?.message || 'That did not work.';
      }
    } } },
    h('label.field-label', { htmlFor: pw.input.id }, 'New password'), pw.el, meter.el,
    h('label.field-label', { htmlFor: again.input.id }, 'Type it again'), again.el,
    btn, err);
    screen(
      brand(),
      h('h1.gate-title', 'Choose a new password'),
      h('p.gate-text', `You opened Harness with your recovery key. Choose a new password now — you can also do it in Settings → Privacy & security until ${time}. Your recovery key keeps working.`),
      form,
      h('div.gate-foot', h('button.btn-link', { type: 'button', on: { click: () => resolve(false) } }, 'Not now')),
    );
    pw.focus();
  });
}

// ------------------------------------------------------------------------------------------------ setup
function setupFlow(sec) {
  return new Promise((resolve) => {
    const pw = passwordField({ label: 'Password', autocomplete: 'new-password' });
    const again = passwordField({ label: 'Password again', autocomplete: 'new-password', name: 'password2' });
    const meter = strengthMeter(pw.input);
    const err = h('div.gate-error', { role: 'alert' });
    const btn = h('button.btn.btn-primary.btn-large', { type: 'submit' }, 'Continue');
    const form = h('form.gate-form', { on: { submit: async (e) => {
      e.preventDefault();
      const r = meter.update();
      if (!r.ok) { err.textContent = r.detail; pw.focus(); return; }
      if (pw.input.value !== again.input.value) { err.textContent = "The two passwords don't match."; again.focus(); return; }
      err.textContent = '';
      btn.disabled = true;
      btn.classList.add('busy');
      try {
        const res = await api.security.setup(pw.input.value);
        pw.input.value = '';
        again.input.value = '';
        await recoveryKeyScreen(res);
        resolve();
      } catch (ex) {
        btn.disabled = false;
        btn.classList.remove('busy');
        if (ex?.code === 'weak_password') err.textContent = 'Use at least 8 characters.';
        else if (ex?.status === 423 || ex?.status === 409) { resolve(); return; } // set up meanwhile (another window)
        else err.textContent = ex?.message || 'That did not work.';
      }
    } } },
    h('label.field-label', { htmlFor: pw.input.id }, 'Password'), pw.el, meter.el,
    h('label.field-label', { htmlFor: again.input.id }, 'Type it again'), again.el,
    btn, err);
    screen(
      brand(),
      h('h1.gate-title', sec.plainDataFound ? 'Protect your chats with a password' : 'Welcome to Harness'),
      h('p.gate-text', 'Harness keeps your chats, memories, documents and images encrypted on this Mac. Choose the password you will type to open it.'),
      sec.plainDataFound ? h('div.gate-callout', icon('lock', { size: 14 }), h('span', 'Your existing chats, memories and images from the earlier version will be encrypted with this password. It takes a moment and happens once.')) : null,
      form,
      h('p.gate-note', 'Any password of 8 or more characters works. A few random words are strong and easy to remember.'),
    );
    pw.focus();
  });
}

function recoveryKeyScreen(res) {
  return new Promise((resolve) => {
    const cont = h('button.btn.btn-primary.btn-large', { type: 'button', disabled: true, on: { click: () => { window.removeEventListener('beforeunload', guard); resolve(); } } }, 'Continue');
    const panel = recoveryKeyPanel(res.recoveryKey, { onStoredChange: (on) => { cont.disabled = !on; } });
    const mig = migrationProgress();
    // Leaving now would lose the only copy of the key.
    const guard = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    screen(
      brand(),
      h('h1.gate-title', 'Save your recovery key'),
      h('p.gate-text', 'If you ever forget your password, this key is the only other way to open Harness.'),
      panel.el,
      h('p.gate-warning', icon('warning', { size: 14 }), h('span', RECOVERY_WARNING)),
      panel.confirmEl,
      mig.el,
      h('div.gate-actions', cont),
    );
    mig.update(res.state === 'migrating' ? res.migration || { op: 'encrypt', done: 0, total: 0 } : null);
    if (res.state === 'migrating') {
      (async () => {
        for (;;) {
          await wait(600);
          if (!document.contains(mig.el)) return;
          let s;
          try { s = await api.security.status(); } catch { continue; }
          if (s.state !== 'migrating') { mig.update(null); return; }
          mig.update(s.migration);
        }
      })();
    }
    panel.focus();
  });
}

function migrationScreen(sec) {
  return new Promise((resolve) => {
    const mig = migrationProgress();
    screen(
      brand(),
      h('h1.gate-title', 'One moment'),
      h('p.gate-text', 'Harness is preparing your data. Keep it open until this finishes — if it is interrupted, it continues next time.'),
      mig.el,
    );
    mig.update(sec.migration || { op: 'encrypt', done: 0, total: 0 });
    (async () => {
      for (;;) {
        await wait(500);
        let s;
        try { s = await api.security.status(); } catch { continue; }
        if (s.state !== 'migrating') { resolve(); return; }
        mig.update(s.migration);
      }
    })();
  });
}

export { add };
