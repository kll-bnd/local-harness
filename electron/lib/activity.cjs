'use strict';
// Keep macOS App Nap from throttling Harness while a chat generation or image job is running,
// and only then. Event-driven start (backend bus events), cheap polling only while busy to notice
// the end (the backend decrements its counters after publishing the final event).

/**
 * @param {object} o
 * @param {() => boolean} o.isBusy
 * @param {{ start(type: string): number, stop(id: number): void }} o.blocker  Electron powerSaveBlocker
 * @param {number} [o.pollMs=2000]
 * @param {(busy: boolean) => void} [o.onChange]
 */
function createActivityGuard({ isBusy, blocker, pollMs = 2000, onChange, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let id = null;
  let timer = null;
  let disposed = false;

  const update = () => {
    if (disposed) return;
    let busy = false;
    try { busy = !!isBusy(); } catch { busy = false; }
    if (busy && id === null) {
      id = blocker.start('prevent-app-suspension');
      onChange?.(true);
    } else if (!busy && id !== null) {
      blocker.stop(id);
      id = null;
      onChange?.(false);
    }
    if (busy && !timer) {
      timer = setTimer(() => { timer = null; update(); }, pollMs);
      timer?.unref?.();
    }
  };

  const dispose = () => {
    disposed = true;
    if (timer) { clearTimer(timer); timer = null; }
    if (id !== null) { blocker.stop(id); id = null; }
  };

  return { update, dispose, get active() { return id !== null; } };
}

/** Busy predicate for an in-process backend `app` (from startServer().app). */
function backendBusy(app) {
  return () => (app?.engine?.active?.size || 0) > 0 || (app?.images?.active || 0) > 0;
}

/** Bus event types that can start or end work. */
const ACTIVITY_EVENTS = new Set(['generation.started', 'generation.finished', 'image.job', 'image.done', 'image.error']);

module.exports = { createActivityGuard, backendBusy, ACTIVITY_EVENTS };
