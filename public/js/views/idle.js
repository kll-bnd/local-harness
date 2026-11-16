// Auto-lock, seen from the page (docs/API.md 10.3). Harness locks itself after `idleLockMinutes` without the user
// doing anything; passive requests (the event stream, status reads) never count. So:
//   * while the user actually interacts (pointer, keys, wheel, touch) the page says so with
//     POST /api/security/activity — at most once a minute, never on a timer;
//   * a minute before the expected lock a quiet hint offers "Stay unlocked";
//   * the lock itself arrives like any other (the event stream's `locked` event, or a 423) and clears the page.
// The page keeps an estimate of the lock time without asking: the backend's last `idleLockAt`, moved forward by
// every request the user's actions caused. Only near the deadline does it read GET /api/security (passive) to
// confirm, so an idle page sends nothing at all.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import * as api from '../api.js';
import { store } from '../state.js';
import { isLockingDown } from '../lockdown.js';

const PASSIVE = /^GET \/api\/(events|security|health|auth\/status|network)(\?|$)/;
const BEAT_MS = 60_000;
/** Warn in the last minute (a third of the time for very short settings). */
const warnMs = () => Math.min(60_000, (minutes() * 60000) / 3);

let serverLockAt = null; // ms, from the backend (null = no auto-lock pending: off, never, or busy)
let lastActivity = Date.now();
let lastBeat = 0;
let confirmedAt = 0;
let hint = null;
let tick = null;

const minutes = () => {
  const s = store.get('settings')?.security?.idleLockMinutes;
  return typeof s === 'number' ? s : store.get('security')?.idleLockMinutes ?? 15;
};
const applies = () => {
  const sec = store.get('security');
  return sec && sec.mode === 'password' && minutes() > 0;
};

function setServerLockAt(iso) {
  serverLockAt = iso ? Date.parse(iso) : null;
  confirmedAt = Date.now();
}

/** When the lock is expected (ms), or null. */
function expected() {
  if (!applies()) return null;
  const local = lastActivity + minutes() * 60000;
  if (serverLockAt == null) return Date.now() - confirmedAt < 30000 ? null : local;
  return Math.max(serverLockAt, local);
}

async function beat() {
  lastBeat = Date.now();
  try {
    const r = await api.security.activity();
    if (r && 'idleLockAt' in r) setServerLockAt(r.idleLockAt);
  } catch { /* the lock flow handles 401/423 */ }
  hideHint();
}

function onInteract() {
  if (document.hidden || isLockingDown() || !applies()) return;
  if (Date.now() - lastBeat < BEAT_MS) { if (hint) beat(); return; }
  beat();
}

function showHint(at) {
  if (!hint) {
    const text = h('span.idle-text');
    const stay = h('button.btn.btn-small', { type: 'button', on: { click: () => beat() } }, 'Stay unlocked');
    hint = { el: h('div.idle-hint', { role: 'status' }, icon('lock', { size: 13 }), text, stay), text };
    document.body.append(hint.el);
  }
  const left = Math.max(0, Math.ceil((at - Date.now()) / 1000));
  hint.text.textContent = `Harness locks in ${left} s — nothing happened for ${minutes()} minute${minutes() === 1 ? '' : 's'}.`;
}

function hideHint() { hint?.el.remove(); hint = null; }

async function check() {
  if (isLockingDown()) return;
  const at = expected();
  if (at == null) { hideHint(); return; }
  const left = at - Date.now();
  if (left > warnMs()) { hideHint(); return; }
  // Near the deadline: ask the backend (a passive read) unless it told us very recently.
  if (Date.now() - confirmedAt > 15000) {
    try {
      const s = await api.security.status();
      if ('idleLockAt' in s) setServerLockAt(s.idleLockAt);
      else confirmedAt = Date.now();
      store.set('security', { ...(store.get('security') || {}), ...s });
    } catch { return; }
    return check();
  }
  showHint(at);
}

export function startIdleWatch(security) {
  if (security && 'idleLockAt' in security) setServerLockAt(security.idleLockAt);
  api.onApiRequest((method, path) => {
    if (!PASSIVE.test(`${method} ${path}`) && path !== '/api/security/activity') lastActivity = Date.now();
  });
  for (const t of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(t, onInteract, { capture: true, passive: true });
  clearInterval(tick);
  tick = setInterval(check, 1000); // local arithmetic only; requests happen solely near the deadline
}

export function stopIdleWatch() { clearInterval(tick); hideHint(); }
