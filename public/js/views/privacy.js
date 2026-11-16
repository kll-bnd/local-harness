// Settings → Privacy & security: how the data is protected (password / this Mac's Keychain / off), the password
// and recovery key, auto-lock, "Block all internet access" with its self-test, this window's session, and
// encrypted backups. Every change that lowers protection asks for the password (security-ui.confirmWithPassword).
import { h, mount, add, download, pickFiles } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { fmtFull, fmtRelative } from '../lib/format.js';
import * as api from '../api.js';
import { store, patchSettings, loadChats, loadSettings, loadPresets } from '../state.js';
import { openDialog, toast } from '../ui/overlays.js';
import { showError } from '../errors.js';
import { runAction, keyLabel, getAction } from '../actions.js';
import { confirmWithPassword, passwordField, strengthMeter, recoveryKeyPanel, migrationProgress, RECOVERY_WARNING, setSecurityContext, confirmationHeader } from '../security-ui.js';
import { networkState, scopeSentence, allowFor, blockNow, setBlocker, selfTest } from './network.js';
import { lockdown, holdLockdown } from '../lockdown.js';

const MODES = [
  { id: 'password', label: 'Ask for my password', recommended: true, text: 'Harness asks for your password when it opens. Only your password or recovery key can unlock the data.' },
  { id: 'keychain', label: "Don't ask on this Mac", text: 'Harness opens without asking: the key is also kept in your login Keychain, so other apps running as you could ask for it.' },
  { id: 'off', label: 'Off', text: 'Your data is stored as plain files that anyone who can read this Mac’s disk can read.' },
];

const IDLE = [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [0, 'Never']];

let lastTest = null; // the last self-test, kept across re-renders
/** After unlocking with the recovery key, a new password can be chosen without the old one for a while. */
const resetUntil = () => store.get('passwordResetUntil');
const inResetWindow = () => !!resetUntil() && new Date(resetUntil()).getTime() > Date.now();

async function refreshSecurity() {
  try {
    const s = await api.security.status();
    store.set('security', s);
    setSecurityContext({ mode: s.mode });
    if (s.offlineLock) store.set('network', { ...s.offlineLock, receivedAt: Date.now() });
    return s;
  } catch (e) { return store.get('security'); }
}

/** Build the section. `view` re-renders on store changes; this keeps its own small state (self-test, session). */
export function privacySection(view) {
  const sec = store.get('security') || {};
  const settings = store.get('settings') || {};
  const mode = sec.mode || 'password';
  const wrap = h('div.stack-lg.privacy');

  // ---- protection mode
  const modeList = h('div.mode-list', { role: 'radiogroup', attrs: { 'aria-label': 'How Harness protects your data' } }, MODES.map((m) => {
    const on = m.id === mode;
    return h('button.mode-card', { type: 'button', role: 'radio', 'aria-checked': String(on), dataset: { mode: m.id }, on: { click: () => { if (!on) changeMode(m.id, view); } } },
      h('span.mode-radio'),
      h('span.mode-body', h('span.mode-label', m.label, m.recommended ? h('span.badge.accent', 'Recommended') : null), h('span.mode-text', m.text)));
  }));
  const migEl = migrationProgress();
  migEl.update(sec.state === 'migrating' ? sec.migration : null);
  add(wrap, h('section.form-block',
    h('h3.h3', 'Protection'),
    modeList, migEl.el));

  // ---- password + recovery key (+ re-keying after the Keychain held the key)
  const rk = sec.recoveryKey;
  const noPassword = mode === 'off' && !rk; // off mode that never had a password (a recovery key comes with one)
  const encrypted = mode !== 'off';
  add(wrap, h('section.form-block',
    h('h3.h3', 'Password and recovery key'),
    noPassword
      ? h('p.field-help', 'Harness has no password yet. Choose “Ask for my password” above to set one and encrypt your data.')
      : [
        h('div.row-wrap',
          h('button.btn', { type: 'button', on: { click: () => changePasswordDialog() } }, icon('key', { size: 14 }), 'Change password…'),
          encrypted ? h('button.btn', { type: 'button', on: { click: () => newRecoveryKey(view) } }, icon('lock', { size: 14 }), rk ? 'Make a new recovery key…' : 'Make a recovery key…') : null),
        encrypted ? h('p.field-help', rk ? `Your recovery key was made ${fmtRelative(rk.createdAt)} (${fmtFull(rk.createdAt)}). It cannot be shown again; making a new one stops the old one from working.` : 'There is no recovery key. Without one, forgetting your password means your data cannot be opened.') : null,
      ],
    inResetWindow() ? h('p.field-help.warn-text', `You opened Harness with your recovery key: until ${new Date(resetUntil()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} you can choose a new password without the old one.`) : null,
    store.get('rekeyRecommended') && encrypted ? h('div.callout.accent.rekey-callout', icon('info'), h('div.grow',
      h('b', 'Consider a new data key. '),
      'While Harness opened without asking, its key sat in your Keychain, where other programs running as you could read it. A new key re-encrypts everything (this takes a little while) and comes with a new recovery key.',
      h('div.row', { style: { marginTop: '8px' } }, h('button.btn.btn-small.btn-primary', { type: 'button', on: { click: () => rekey(view) } }, 'Re-encrypt with a new key…')))) : null,
    encrypted && !store.get('rekeyRecommended') ? h('div.row', h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: () => rekey(view) } }, 'Re-encrypt everything with a new key…')) : null));

  // ---- auto-lock
  const cur = settings.security?.idleLockMinutes ?? sec.idleLockMinutes ?? 15;
  const idleSel = h('select.select', { attrs: { 'aria-label': 'Lock Harness after' }, on: { change: async () => {
    try { await patchSettings({ security: { idleLockMinutes: Number(idleSel.value) } }); view.flash?.({ path: 'security.idleLockMinutes' }); refreshSecurity(); } catch (e) { showError(e, 'change auto-lock'); }
  } } }, (IDLE.some(([v]) => v === cur) ? IDLE : [...IDLE, [cur, `${cur} minutes`]]).map(([v, l]) => h('option', { value: String(v), selected: v === cur }, l)));
  add(wrap, h('section.form-block',
    h('h3.h3', 'Locking'),
    h('div.form-row', { dataset: { path: 'security.idleLockMinutes' } },
      h('div.form-label', h('label.field-label', 'Lock Harness after'), h('div.field-help', 'Counted from the last thing you did in Harness. Locking stops replies that are running and unloads the models Harness started.')),
      h('div.form-control', idleSel)),
    mode !== 'off' ? h('div.row', h('button.btn', { type: 'button', on: { click: () => runAction('lock') } }, icon('lock', { size: 14 }), 'Lock now'), h('span.faint.small', keyLabel(getAction('lock')?.keys?.[0]))) : null,
  ));

  // ---- internet
  add(wrap, internetBlock(view));

  // ---- sessions
  const sessEl = h('div.session-line.faint', 'Checking…');
  api.auth.status().then((st) => {
    const via = { cookie: 'this browser’s Harness session', token: 'an access token', bridge: 'the Harness app (no network involved)' }[st.via] || 'no session';
    mount(sessEl, h('span', st.authenticated ? `Signed in through ${via}${st.expiresAt ? `, until ${fmtFull(st.expiresAt)}` : ''}.` : 'Not signed in.'));
  }).catch(() => { sessEl.textContent = ''; });
  const transport = sec.transport || store.get('system')?.app?.transport;
  add(wrap, h('section.form-block',
    h('h3.h3', 'Sessions'),
    sessEl,
    h('p.field-help', transport === 'bridge'
      ? 'This window talks to Harness directly inside the app; no other program can connect to it.'
      : 'Other programs on this Mac can reach Harness’s local address but cannot use it without a session. Locking Harness signs out every window and tool.'),
    transport !== 'bridge' ? h('div.row', h('button.btn', { type: 'button', on: { click: async () => { try { await api.auth.logout(); } catch { /* ignore */ } lockdown('signed_out'); } } }, 'Sign out this window')) : null));

  // ---- backups
  add(wrap, h('section.form-block',
    h('h3.h3', 'Backups'),
    h('p.field-help', 'A full backup holds every chat, memory, document and image. Protect it with a passphrase: without one, anyone who gets the file can read it.'),
    h('div.row-wrap',
      h('button.btn', { type: 'button', on: { click: () => backupDialog() } }, icon('download', { size: 14 }), 'Download backup…'),
      h('button.btn', { type: 'button', on: { click: () => restoreBackup() } }, icon('upload', { size: 14 }), 'Restore from backup…'))));
  return wrap;
}

// ------------------------------------------------------------------------------------------------ internet
function internetBlock(view) {
  const ol = store.get('network');
  const s = networkState(ol);
  const sw = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': String(!!ol?.enabled), attrs: { 'aria-label': 'Block all internet access' }, on: { click: async () => {
    try { await setBlocker(!ol?.enabled); } catch (e) { showError(e, 'change internet blocking'); }
  } } });
  const until = ol?.allowedUntil ? new Date(ol.allowedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const status = s.state === 'blocked' ? 'Blocked. Chat, memory, documents and local image generation work as usual.'
    : s.state === 'allowed' ? (s.waitingFor ? 'Allowed until the running download finishes.' : `Allowed until ${until}, then blocked again by itself.`)
      : s.state === 'off' ? 'Not blocked: Harness and the models it starts can reach the internet.' : '—';
  const results = h('div.selftest', { attrs: { 'aria-live': 'polite' } });
  const show = () => {
    if (!lastTest) return;
    if (lastTest.running) { mount(results, h('div.faint', h('span.spinner.small'), ' Checking…')); return; }
    if (lastTest.error) { mount(results, h('div.field-error', lastTest.error)); return; }
    const r = lastTest.result;
    mount(results,
      h(`div.selftest-head${r.leaked ? '.bad' : r.unsure ? '.unsure' : '.ok'}`, icon(r.leaked || r.unsure ? 'warning' : 'shieldCheck', { size: 15 }),
        r.leaked ? 'Something could get out.' : r.open ? 'Internet access is allowed right now, as you chose.' : r.unsure ? 'Nothing got out, but part of the check could not tell.' : 'Nothing got out.'),
      h('ul.selftest-list', r.lines.map((l) => h(`li.selftest-item.${l.result}`, h('span.selftest-dot'), h('span', h('b', `${l.layer}: `), l.text, l.detail ? h('span.faint', ` ${l.detail}`) : null)))),
      h('div.faint.small', `Checked ${new Date(lastTest.at).toLocaleTimeString()}`));
  };
  const testBtn = h('button.btn', { type: 'button', disabled: !!lastTest?.running, on: { click: async () => {
    lastTest = { running: true };
    testBtn.disabled = true;
    show();
    try { lastTest = { result: await selfTest(), at: Date.now() }; } catch (e) { lastTest = { error: e.message, at: Date.now() }; }
    view.renderNow?.();
  } } }, icon('shield', { size: 14 }), 'Check that nothing can get out');
  show();
  return h('section.form-block',
    h('h3.h3', 'Internet access'),
    h('div.form-row',
      h('div.form-label', h('label.field-label', 'Block all internet access'), h('div.field-help', 'On by default. Harness only goes online when you allow it, for example to download a model, and blocks it again by itself.')),
      h('div.form-control', sw)),
    h('p.net-status', { dataset: { state: s.state } }, status),
    ol ? h('p.field-help', scopeSentence(ol)) : null,
    h('div.row-wrap',
      s.state === 'blocked' ? h('button.btn', { type: 'button', on: { click: () => allowFor(15) } }, icon('globe', { size: 14 }), 'Allow for 15 minutes…') : null,
      s.state === 'allowed' ? h('button.btn.btn-primary', { type: 'button', on: { click: () => blockNow() } }, 'Block now') : null,
      ol?.enabled ? testBtn : null),
    results);
}

// ------------------------------------------------------------------------------------------------ actions
/** Show a once-only recovery key in a dialog that cannot be dismissed until the user says it is stored. */
function showRecoveryKey(key, { title = 'Your new recovery key', createdAt } = {}) {
  return new Promise((resolve) => {
    let done = null;
    const panel = recoveryKeyPanel(key, { createdAt, onStoredChange: (on) => { if (done) done.disabled = !on; } });
    const dlg = openDialog({
      title,
      dismissible: false,
      className: 'rk-dialog',
      body: h('div.stack', panel.el, h('p.gate-warning', icon('warning', { size: 14 }), h('span', RECOVERY_WARNING)), panel.confirmEl),
      actions: [{ label: 'Done', kind: 'primary', disabled: true, run: () => { if (!panel.stored()) return false; resolve(); return true; } }],
    });
    done = dlg.el.querySelector('.dialog-actions .btn');
  });
}

/** Off mode without any password: turning encryption on needs a new password (and yields a recovery key). */
function choosePassword() {
  return new Promise((resolve) => {
    const pw = passwordField({ label: 'New password', autocomplete: 'new-password' });
    const again = passwordField({ label: 'New password again', autocomplete: 'new-password', name: 'password2' });
    const meter = strengthMeter(pw.input);
    const err = h('div.field-error', { role: 'alert' });
    let got = null;
    openDialog({
      title: 'Choose a password', size: 'small',
      body: h('form.stack', { on: { submit: (e) => e.preventDefault() } },
        h('p.field-help', 'Harness encrypts your chats, memories and images with it and asks for it when it opens.'),
        h('label.field-label', { htmlFor: pw.input.id }, 'Password'), pw.el, meter.el,
        h('label.field-label', { htmlFor: again.input.id }, 'Type it again'), again.el, err),
      actions: [{ label: 'Cancel' }, { label: 'Continue', kind: 'primary', run: () => {
        const r = meter.update();
        if (!r.ok) { err.textContent = r.detail; return false; }
        if (pw.input.value !== again.input.value) { err.textContent = "The two passwords don't match."; return false; }
        got = pw.input.value;
        return true;
      } }],
      onClose: () => resolve(got),
    });
    pw.focus();
  });
}

async function changeMode(next, view) {
  const m = MODES.find((x) => x.id === next);
  const sec = store.get('security') || {};
  // A conversion may start with this request; keep the page (and a new recovery key) until the key is saved.
  const release = holdLockdown();
  try {
    let r;
    if (sec.mode === 'off' && !sec.recoveryKey && next !== 'off') {
      const newPassword = await choosePassword();
      if (!newPassword) return;
      try { r = await api.security.setMode({ mode: next, newPassword }); } catch (e) { showError(e, 'turn encryption on'); return; }
    } else {
      r = await confirmWithPassword({
        title: next === 'password' ? 'Ask for the password again?' : next === 'keychain' ? 'Open Harness without asking on this Mac?' : 'Turn encryption off?',
        message: next === 'off' ? 'Harness decrypts every file. Your chats, memories and images will be readable by anyone who can read this Mac’s disk.' : m.text,
        confirmLabel: next === 'off' ? 'Turn off encryption' : 'Change',
        danger: next === 'off',
        run: (password) => api.security.setMode({ password, mode: next }),
      }).catch((e) => { showError(e, 'change protection'); return null; });
    }
    if (!r) return;
    setSecurityContext({ mode: r.mode });
    if (r.rekeyRecommended) store.set('rekeyRecommended', true);
    if (r.recoveryKey) await showRecoveryKey(r.recoveryKey, { title: 'Your recovery key' });
    toast({ kind: 'success', message: r.state === 'migrating' ? 'Changing how your data is stored…' : 'Protection changed', id: 'mode' });
    await refreshSecurity();
    view.renderNow?.();
  } finally { release(); }
}

/** A new data key: everything is re-encrypted and a new recovery key replaces the old one (shown once). */
async function rekey(view) {
  const release = holdLockdown();
  try {
    const r = await confirmWithPassword({
      title: 'Re-encrypt everything with a new key?',
      message: 'Harness makes a new data key and re-encrypts all your files with it; this takes a little while and Harness is unavailable meanwhile. Your password stays the same; your recovery key is replaced by a new one, shown once.',
      confirmLabel: 'Re-encrypt',
      run: (password) => api.security.rekey(password),
    }).catch((e) => { showError(e, 're-encrypt the data'); return null; });
    if (!r) return;
    store.set('rekeyRecommended', false);
    if (r.recoveryKey) await showRecoveryKey(r.recoveryKey, { title: 'Your new recovery key' });
    await refreshSecurity();
    view.renderNow?.();
  } finally { release(); }
}

function changePasswordDialog() {
  const reset = inResetWindow();
  const cur = passwordField({ label: 'Current password' });
  const next = passwordField({ label: 'New password', autocomplete: 'new-password' });
  const again = passwordField({ label: 'New password again', autocomplete: 'new-password', name: 'password2' });
  const meter = strengthMeter(next.input);
  const err = h('div.field-error', { role: 'alert' });
  const body = h('form.stack', { on: { submit: (e) => e.preventDefault() } },
    reset ? h('p.field-help', 'You opened Harness with your recovery key, so the current password is not needed.') : [h('label.field-label', { htmlFor: cur.input.id }, 'Current password'), cur.el],
    h('label.field-label', { htmlFor: next.input.id }, 'New password'), next.el, meter.el,
    h('label.field-label', { htmlFor: again.input.id }, 'Type it again'), again.el,
    h('p.field-help', 'Nothing is re-encrypted: the new password simply opens the same key. Your recovery key keeps working.'),
    err);
  openDialog({
    title: 'Change password', body, size: 'small',
    actions: [{ label: 'Cancel' }, { label: 'Change password', kind: 'primary', run: async () => {
      const s = meter.update();
      if (!s.ok) { err.textContent = s.detail; return false; }
      if (next.input.value !== again.input.value) { err.textContent = "The two new passwords don't match."; return false; }
      if (!reset && !cur.input.value) { err.textContent = 'Type your current password.'; return false; }
      try {
        await api.security.changePassword({ password: reset ? undefined : cur.input.value, newPassword: next.input.value });
        store.set('passwordResetUntil', null);
        toast({ kind: 'success', message: 'Password changed' });
        return true;
      } catch (e) {
        err.textContent = e.code === 'wrong_password' ? "That's not your current password." : e.code === 'unlock_throttled' ? `Too many tries. Try again in ${Math.ceil((e.details?.retryAfterMs || 0) / 1000)} s.` : e.message;
        return false;
      }
    } }],
  });
  (reset ? next : cur).focus();
}

async function newRecoveryKey(view) {
  const r = await confirmWithPassword({
    title: 'Make a new recovery key?',
    message: 'Your current recovery key stops working. The new one is shown once — have a safe place ready.',
    confirmLabel: 'Make new key',
    run: (password) => api.security.newRecoveryKey(password),
  }).catch((e) => { showError(e, 'make a recovery key'); return null; });
  if (!r?.recoveryKey) return;
  await showRecoveryKey(r.recoveryKey, { createdAt: r.createdAt });
  await refreshSecurity();
  view.renderNow?.();
}

// ------------------------------------------------------------------------------------------------ backups
export function backupDialog() {
  const protect = h('input', { type: 'checkbox', checked: true, id: 'bk-protect' });
  const pass = passwordField({ label: 'Passphrase', autocomplete: 'new-password', name: 'passphrase' });
  const again = passwordField({ label: 'Passphrase again', autocomplete: 'new-password', name: 'passphrase2' });
  const meter = strengthMeter(pass.input);
  const fields = h('div.stack', h('label.field-label', { htmlFor: pass.input.id }, 'Passphrase'), pass.el, meter.el, h('label.field-label', { htmlFor: again.input.id }, 'Type it again'), again.el,
    h('p.field-help', 'You need this passphrase to restore the backup. It can differ from your Harness password; write it down with the backup’s location.'));
  const plainNote = h('p.field-help.warn-text', { hidden: true }, 'Without a passphrase the backup is a plain file: anyone who gets it can read your chats.');
  protect.addEventListener('change', () => { fields.hidden = !protect.checked; plainNote.hidden = protect.checked; });
  const err = h('div.field-error', { role: 'alert' });
  openDialog({
    title: 'Download a full backup',
    body: h('div.stack',
      h('p.field-help', 'Every chat (all branches and summaries), memories, presets, settings, attachments and generated images, in one file.'),
      h('label.row.check-row', { htmlFor: protect.id }, protect, h('span', 'Protect the backup with a passphrase')),
      fields, plainNote, err),
    actions: [{ label: 'Cancel' }, { label: 'Download…', kind: 'primary', run: async (close) => {
      let passphrase = null;
      if (protect.checked) {
        if (!pass.input.value) { err.textContent = 'Choose a passphrase, or untick the box for a plain backup.'; return false; }
        if (pass.input.value !== again.input.value) { err.textContent = "The two passphrases don't match."; return false; }
        passphrase = pass.input.value;
      }
      close();
      const res = await confirmWithPassword({
        title: 'Download the backup?',
        message: passphrase ? 'The file is encrypted with your passphrase.' : 'The file is not encrypted.',
        confirmLabel: 'Download',
        run: (password) => api.backup.create({ password, passphrase }),
      }).catch((e) => { showError(e, 'make the backup'); return null; });
      if (!res) return true;
      const day = new Date().toISOString().slice(0, 10);
      download(res.blob, res.filename || `harness-backup-${day}${passphrase ? '.encrypted' : ''}.json`);
      toast({ kind: 'success', message: 'Backup downloaded', detail: passphrase ? 'Encrypted with your passphrase.' : 'Not encrypted — keep it somewhere private.' });
      return true;
    } }],
  });
  pass.focus();
}

/** Ask for an encrypted backup's passphrase. → string | null */
export function askPassphrase({ title = 'This backup is encrypted', label = 'Open' } = {}) {
  return new Promise((resolve) => {
    const pass = passwordField({ label: 'Passphrase', autocomplete: 'off', name: 'passphrase' });
    let got = null;
    openDialog({
      title, size: 'small',
      body: h('form.stack', { on: { submit: (e) => e.preventDefault() } }, h('p.field-help', 'Type the passphrase it was saved with.'), pass.el),
      actions: [{ label: 'Cancel' }, { label, kind: 'primary', run: () => { if (!pass.input.value) return false; got = pass.input.value; return true; } }],
      onClose: () => resolve(got),
    });
    pass.focus();
  });
}

const isEncrypted = (p) => p?.format === 'harness.backup.encrypted';

export async function restoreBackup() {
  const [file] = await pickFiles({ accept: '.json,application/json', multiple: false });
  if (!file) return;
  let payload;
  try { payload = JSON.parse(await file.text()); } catch { toast({ kind: 'error', message: `${file.name} isn't valid JSON` }); return; }
  const encrypted = isEncrypted(payload);
  if (!encrypted && payload.format !== 'harness.backup') {
    try { const r = await api.chats.import(payload); await loadChats(); toast({ kind: 'success', message: `Imported ${r.chats.length} chat${r.chats.length === 1 ? '' : 's'}` }); } catch (e) { showError(e, 'import the file'); }
    return;
  }
  const n = (k) => (encrypted ? null : Array.isArray(payload[k]) ? payload[k].length : 0);
  const part = (key, label, count) => {
    const cb = h('input', { type: 'checkbox', checked: count == null || count > 0, disabled: count === 0, dataset: { part: key } });
    return h('label.row.restore-part', cb, h('span.grow', label), count == null ? null : h('span.faint.num', String(count)));
  };
  const settingsSel = h('select.select', { attrs: { 'aria-label': 'Settings' } },
    h('option', { value: 'skip' }, 'Keep my current settings'),
    h('option', { value: 'safe' }, 'Restore settings, but keep this Mac’s paths and servers'),
    h('option', { value: 'full' }, 'Restore all settings exactly'));
  const pass = encrypted ? passwordField({ label: 'Backup passphrase', autocomplete: 'off', name: 'passphrase' }) : null;
  const err = h('div.field-error', { role: 'alert' });
  const body = h('div.stack',
    h('p.field-help', encrypted ? 'This backup is encrypted. Everything is added next to what you have — nothing is overwritten, and restored items get new ids.' : `Backup from ${fmtFull(payload.exportedAt)}${payload.app?.version ? ` (Harness ${payload.app.version})` : ''}. Everything is added next to what you have — nothing is overwritten, and restored items get new ids.`),
    encrypted ? [h('label.field-label', { htmlFor: pass.input.id }, 'Passphrase of the backup'), pass.el] : null,
    part('chats', 'Chats (all branches and summaries)', n('chats')),
    part('memories', 'Memories (duplicates are skipped)', n('memories')),
    part('presets', 'Presets', n('presets')),
    part('attachments', 'Attachments', n('attachments')),
    part('images', 'Generated images', n('images')),
    h('label.field-label', 'Settings'), settingsSel, err);
  openDialog({
    title: 'Restore from backup',
    body,
    actions: [{ label: 'Cancel' }, { label: 'Restore…', kind: 'primary', run: async (close) => {
      if (encrypted && !pass.input.value) { err.textContent = 'Type the passphrase of the backup.'; return false; }
      const parts = Object.fromEntries([...body.querySelectorAll('input[data-part]')].map((cb) => [cb.dataset.part, cb.checked]));
      const passphrase = pass?.input.value || undefined;
      close();
      const r = await confirmWithPassword({
        title: 'Restore this backup?',
        message: 'Restored chats, memories and images are added to this Harness.',
        confirmLabel: 'Restore',
        run: async (password) => api.restore(payload, { ...parts, settings: settingsSel.value, passphrase, confirmation: await confirmationHeader(password) }),
      }).catch((e) => { showError(e, 'restore the backup'); return null; });
      if (!r) return true;
      await Promise.allSettled([loadChats(), loadSettings(), loadPresets()]);
      const got = r.restored || {};
      const bits = ['chats', 'memories', 'presets', 'attachments', 'images'].filter((k) => got[k]).map((k) => `${got[k]} ${k}`);
      toast({ kind: 'success', message: 'Backup restored', detail: `${bits.join(', ') || 'Nothing new'}${got.settings && got.settings !== 'skipped' ? ` · settings ${got.settings}` : ''}${(r.warnings || []).length ? `\n${r.warnings.slice(0, 3).map((w) => w.message || w).join('\n')}` : ''}`, timeout: 7000 });
      return true;
    } }],
  });
  (pass || body.querySelector('input'))?.focus?.();
}
