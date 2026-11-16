// When Harness locks (Lock now, the idle timer, the Mac going to sleep in the native app, or any request
// answered 401 auth_required / 423 locked), nothing of the session may stay on screen or in memory behind the
// lock screen. So the page does not hide the app: it stops what is running, empties the DOM and reloads, which
// throws away every store, cache and model in memory. The address (#/chat/<id>, #/settings/…) is kept, so
// after unlocking the user is back where they were.

const hooks = new Set();
let locking = false;

export const isLockingDown = () => locking;

/** Run fn (synchronously) just before the page is cleared — stop streams, drop timers. */
export function onLockdown(fn) { hooks.add(fn); return () => hooks.delete(fn); }

/** Responses that mean "this page no longer has an open Harness behind it". */
export function isLockError(e) {
  if (!e || typeof e.status !== 'number') return false;
  if (e.status === 401 && e.code === 'auth_required') return true;
  return e.status === 423 && ['locked', 'needs_setup', 'migrating'].includes(e.code);
}

export function lockdown(reason = 'locked') {
  if (locking) return;
  locking = true;
  for (const fn of hooks) { try { fn(reason); } catch { /* keep going */ } }
  // Clear the screen first, synchronously: dialogs, popovers, toasts and the app itself.
  for (const d of document.querySelectorAll('dialog')) { try { d.close(); } catch { /* ignore */ } }
  const root = document.createElement('div');
  root.id = 'app';
  root.className = 'app-root';
  const splash = document.createElement('div');
  splash.className = 'boot-splash';
  splash.innerHTML = '<span class="spinner"></span>';
  root.append(splash);
  document.body.replaceChildren(root);
  document.documentElement.classList.remove('ready');
  document.title = 'Harness';
  // A page that is told it is locked right after opening the app, again and again, would reload in a loop (a
  // backend that says "unlocked" but answers 423): count only such early lockdowns and stop after three.
  const st = history.state && typeof history.state === 'object' ? history.state : {};
  const early = performance.now() < 3000;
  const recent = early ? (Array.isArray(st.harnessLockdowns) ? st.harnessLockdowns : []).filter((t) => Date.now() - t < 30000) : [];
  if (recent.length >= 3) {
    splash.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = 'Harness was locked.';
    const b = document.createElement('button');
    b.className = 'btn';
    b.type = 'button';
    b.textContent = 'Open again';
    b.addEventListener('click', () => { history.replaceState({ ...st, harnessLockdowns: [] }, ''); location.reload(); });
    splash.append(p, b);
    return;
  }
  try { history.replaceState({ ...st, harnessLockdowns: early ? [...recent, Date.now()] : [] }, ''); } catch { /* ignore */ }
  location.reload();
}
