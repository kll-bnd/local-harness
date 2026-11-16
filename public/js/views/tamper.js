// "Harness's security settings were changed from outside" (docs/API.md 10.2 `tamper`): while Harness was closed or
// locked, one of its plain start-up files claimed less protection than the owner set. Harness ignored it and put the
// files back. The owner should not miss it, nor be alarmed into anything rash: one persistent notice in the app
// (no timeout) and the same callout in Settings → Privacy & security, until "OK, got it" dismisses it.
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { fmtFull } from '../lib/format.js';
import * as api from '../api.js';
import { store } from '../state.js';
import { showError } from '../errors.js';

const PLAIN = {
  'launch.json: encryption': 'open without your password',
  'launch.json: offlineLock': 'switch off the internet blocker',
  'launch.json: offlineLockSuspendedUntil': 'allow internet access',
  'vault.json: encrypted': 'store your chats unencrypted',
  'vault.json: migration': 'store your chats unencrypted',
};

/** Field names → plain language, without repeats; unknown values are shown as they are. */
export function tamperItems(fields = []) {
  const out = [];
  for (const f of fields) {
    const s = PLAIN[f] || (/^vault\.json: security record/.test(f) ? 'an older or foreign copy of the key file' : f);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

const list = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

export const TAMPER_TITLE = 'Harness’s security settings were changed from outside';

/** `mode`: the protection now in force — in off mode (chosen with the password) the chats are plain by choice. */
export function tamperText(t, { mode = 'password' } = {}) {
  const items = tamperItems(t?.fields || []);
  const kept = mode === 'off' ? 'Harness ignored the change and restored your settings.' : 'Harness ignored the change and restored your settings; your chats stayed encrypted.';
  return `While Harness was closed, one of its start-up files was edited to weaken its protection${items.length ? ` (${list(items)})` : ''}. ${kept} If you did not restore an old copy of the Harness folder yourself, another program on this Mac may have tried to tamper with it.`;
}

export async function dismissTamper() {
  try {
    await api.security.dismissTamper();
    store.set('security', { ...(store.get('security') || {}), tamper: null });
  } catch (e) { showError(e, 'dismiss the notice'); }
}

/** The callout (Settings → Privacy & security, and the body of the notice). */
export function tamperCallout(t, { className = '' } = {}) {
  return h(`div.callout.warn.tamper-callout${className ? `.${className}` : ''}`, { role: 'alert' },
    icon('shield'),
    h('div.grow.stack',
      h('b.tamper-title', TAMPER_TITLE),
      h('div.tamper-body', tamperText(t, { mode: store.get('security')?.mode })),
      t?.at ? h('div.faint.small', `Noticed ${fmtFull(t.at)}.`) : null,
      h('div.row', h('button.btn.btn-small.tamper-ok', { type: 'button', on: { click: () => dismissTamper() } }, 'OK, got it'))));
}

/** The persistent notice in the app; shows itself whenever security.tamper is set. */
export function startTamperNotice() {
  let el = null;
  const render = () => {
    const t = store.get('security')?.tamper;
    if (!t) { el?.remove(); el = null; return; }
    if (!el) { el = h('div.tamper-notice'); document.body.append(el); }
    mount(el, tamperCallout(t));
  };
  store.on('security', render);
  render();
}
