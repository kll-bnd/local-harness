// RAM lease: on low-RAM machines (or with image.unloadChatModel = "always") the chat model and a diffusion
// model must never be resident at the same time. Chat turns and background model work take an "llm" lease,
// image jobs an "image" lease; the two kinds exclude each other, FIFO, abortable while queued. An image job
// started by the chat model's own tool call is re-entrant (same owner) — the turn waits for it anyway.
// On bigger machines the lease is a no-op (everything is granted immediately).
import { ramTier } from '../context/sizing.mjs';
import { abortError } from '../lib/util.mjs';

let seq = 0;

export class RamLease {
  constructor(app) {
    this.app = app;
    this.holders = new Map(); // id -> { id, kind, owner, since }
    this.queue = []; // waiters { id, kind, owner, resolve, reject, onAbort, signal }
  }

  exclusive() {
    const img = this.app.settings.get().image || {};
    return ramTier(this.app.system.totalMem) === 'low' || img.unloadChatModel === 'always';
  }

  _conflict(kind, owner) {
    if (!this.exclusive()) return null;
    for (const h of this.holders.values()) {
      if (owner && h.owner === owner) continue;
      if (h.kind !== kind || kind === 'image') return h;
    }
    return null;
  }

  _grant(w, waited) {
    const rec = { id: w.id, kind: w.kind, owner: w.owner, since: Date.now() };
    this.holders.set(rec.id, rec);
    let released = false;
    return {
      id: rec.id,
      kind: rec.kind,
      waited,
      release: () => {
        if (released) return;
        released = true;
        this.holders.delete(rec.id);
        this._pump();
      },
    };
  }

  _pump() {
    while (this.queue.length) {
      const w = this.queue[0];
      if (this._conflict(w.kind, w.owner)) return;
      this.queue.shift();
      w.signal?.removeEventListener('abort', w.onAbort);
      w.resolve(this._grant(w, true));
    }
  }

  /**
   * @param {'llm'|'image'} kind
   * @param {{ owner?: string, signal?: AbortSignal, onWait?: (info) => void }} [o]
   * @returns {Promise<{ id, kind, waited: boolean, release() }>}
   */
  acquire(kind, { owner = null, signal, onWait } = {}) {
    const w = { id: `lease_${++seq}`, kind, owner };
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
    const reentrant = owner && [...this.holders.values()].some((h) => h.owner === owner);
    const blocker = this._conflict(kind, owner);
    if (!blocker && (reentrant || !this.queue.length)) return Promise.resolve(this._grant(w, false));
    return new Promise((resolve, reject) => {
      Object.assign(w, { resolve, reject, signal });
      w.onAbort = () => {
        const i = this.queue.indexOf(w);
        if (i >= 0) this.queue.splice(i, 1);
        reject(signal.reason ?? abortError());
        this._pump();
      };
      signal?.addEventListener('abort', w.onAbort, { once: true });
      this.queue.push(w);
      const b = blocker || [...this.holders.values()][0];
      const reason = b?.kind === 'image' ? 'image_job' : 'model_in_use';
      onWait?.({
        reason,
        message: reason === 'image_job' ? 'Waiting for the image generation to finish (not enough RAM for both models)…' : 'Waiting for the chat model to finish (not enough RAM for both models)…',
      });
    });
  }

  status() {
    return { exclusive: this.exclusive(), holders: [...this.holders.values()].map((h) => ({ kind: h.kind, since: new Date(h.since).toISOString() })), waiting: this.queue.map((w) => w.kind) };
  }
}
