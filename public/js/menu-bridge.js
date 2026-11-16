// The desktop shell's menu commands (window.harnessDesktop.onMenuAction) are received from the very first moment
// the page runs — also on the lock screen — so that nothing queued by the shell is replayed into the app at the
// wrong time (a "Lock Harness" pressed on the lock screen must not lock again right after unlocking). While the
// app is not running, commands are held briefly; once it starts, recent ones (except `lock`) are handed over.
const held = [];
let handler = null;

export function initMenuBridge() {
  const desktop = window.harnessDesktop;
  if (!desktop?.onMenuAction) return;
  try {
    desktop.onMenuAction((name, ...args) => {
      if (handler) { handler(name, ...args); return; }
      if (name === 'lock') return; // already locked
      held.push({ name, args, at: Date.now() });
      if (held.length > 5) held.shift();
    });
  } catch (e) { console.warn('desktop bridge', e); }
}

/** The app is running: deliver menu commands to `fn` from now on (and the ones from the last few seconds). */
export function setMenuHandler(fn) {
  handler = fn;
  const fresh = held.splice(0).filter((x) => Date.now() - x.at < 10000);
  if (fresh.length) setTimeout(() => { for (const x of fresh) fn(x.name, ...x.args); }, 0);
}
