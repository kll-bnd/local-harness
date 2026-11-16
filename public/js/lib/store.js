// A deliberately small state layer: named slices with change subscriptions, plus a plain emitter.
//
//   store.get('settings')                    → current value
//   store.set('settings', value)             → notifies subscribers of 'settings' (and '*')
//   store.update('chats', (list) => …)       → functional update
//   store.on('settings', (value, prev) => …) → returns an unsubscribe function
//   store.watch(['a', 'b'], fn)              → fn() on any change of a or b (coalesced to one call per microtask)
//
// Values are treated as immutable: replace slices rather than mutating them, so `prev` stays meaningful.

export class Emitter {
  constructor() { this.map = new Map(); }
  on(type, fn) {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type).add(fn);
    return () => this.map.get(type)?.delete(fn);
  }
  once(type, fn) {
    const off = this.on(type, (...a) => { off(); fn(...a); });
    return off;
  }
  emit(type, ...args) {
    for (const fn of [...(this.map.get(type) || [])]) {
      try { fn(...args); } catch (e) { console.error(`[emitter] ${type} handler failed`, e); }
    }
    if (type !== '*') for (const fn of [...(this.map.get('*') || [])]) { try { fn(type, ...args); } catch (e) { console.error(e); } }
  }
}

export function createStore(initial = {}) {
  const state = { ...initial };
  const em = new Emitter();
  return {
    get: (k) => state[k],
    snapshot: () => ({ ...state }),
    set(k, v) {
      const prev = state[k];
      if (Object.is(prev, v)) return;
      state[k] = v;
      em.emit(k, v, prev);
    },
    /** Shallow-merge an object slice. */
    merge(k, patch) {
      const prev = state[k] || {};
      const next = { ...prev, ...patch };
      state[k] = next;
      em.emit(k, next, prev);
    },
    update(k, fn) { this.set(k, fn(state[k])); },
    /** Forget every value except `keep` (e.g. the route), without notifying anyone (Harness is locking). */
    clear(keep = []) { for (const k of Object.keys(state)) if (!keep.includes(k)) state[k] = null; },
    on: (k, fn) => em.on(k, fn),
    watch(keys, fn) {
      let queued = false;
      const run = () => { queued = false; fn(); };
      const offs = keys.map((k) => em.on(k, () => { if (!queued) { queued = true; queueMicrotask(run); } }));
      return () => offs.forEach((o) => o());
    },
  };
}
