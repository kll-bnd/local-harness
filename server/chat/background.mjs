// Background work queue (memory extraction, titles, recall indexing, embeddings).
// - One task at a time; tasks with the same key are debounced (latest wins).
// - Never runs while a foreground generation or an image job is active.
// - Tasks that need a model wait while an image job has unloaded the chat model (it reloads lazily on the
//   next chat request), so background work never drags a model back into RAM next to a diffusion model.
import { log } from '../lib/log.mjs';

export class BackgroundQueue {
  constructor(app) {
    this.app = app;
    this.tasks = new Map();
    this.running = null;
    this.timer = null;
    this.waiters = [];
    this.stopped = false;
    this.history = [];
  }

  schedule(key, fn, { delayMs = 0, priority = 5, needsModel = true, label = key } = {}) {
    if (this.stopped) return;
    this.tasks.set(key, { key, fn, priority, needsModel, label, runAt: Date.now() + delayMs, queuedAt: Date.now() });
    this.kick();
  }

  cancel(prefix) {
    for (const k of [...this.tasks.keys()]) if (k.startsWith(prefix)) this.tasks.delete(k);
  }

  blockedReason(task) {
    if (this.app.foreground > 0) return 'foreground_generation';
    if (this.app.images?.active > 0) return 'image_job';
    if (task.needsModel && this.app.modelState?.unloadedForImage) return 'model_unloaded_for_image';
    return null;
  }

  status() {
    const now = Date.now();
    return {
      running: this.running ? { key: this.running.key, label: this.running.label } : null,
      pending: [...this.tasks.values()].map((t) => ({ key: t.key, label: t.label, dueInMs: Math.max(0, t.runAt - now), blockedBy: this.blockedReason(t) })),
    };
  }

  kick() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running) return;
    const now = Date.now();
    let nextAt = Infinity;
    let pick = null;
    for (const t of this.tasks.values()) {
      if (this.blockedReason(t)) continue;
      if (t.runAt <= now) {
        if (!pick || t.priority < pick.priority || (t.priority === pick.priority && t.runAt < pick.runAt)) pick = t;
      } else nextAt = Math.min(nextAt, t.runAt);
    }
    if (pick) {
      this.timer = setTimeout(() => this._run(pick), 0);
      this.timer.unref?.();
      return;
    }
    if (nextAt < Infinity) {
      this.timer = setTimeout(() => this.kick(), Math.max(5, nextAt - now));
      this.timer.unref?.();
      return;
    }
    if (!this.tasks.size) this._resolveIdle();
  }

  async _run(task) {
    this.timer = null;
    if (this.running || this.stopped) return;
    if (this.tasks.get(task.key) !== task) return this.kick();
    if (this.blockedReason(task)) return this.kick();
    this.tasks.delete(task.key);
    this.running = task;
    task.controller = new AbortController();
    task.preempted = false;
    const t0 = Date.now();
    let lease = null;
    try {
      if (task.needsModel && this.app.ram) lease = await this.app.ram.acquire('llm', { signal: task.controller.signal });
      await task.fn({ signal: task.controller.signal });
      this.history.push({ key: task.key, ok: true, ms: Date.now() - t0, at: new Date().toISOString() });
    } catch (e) {
      if (task.preempted) {
        // The user started something: give the backend back immediately and try again later.
        this.history.push({ key: task.key, ok: false, preempted: true, ms: Date.now() - t0, at: new Date().toISOString() });
        task.preemptions = (task.preemptions || 0) + 1;
        if (!this.tasks.has(task.key) && task.preemptions <= 20) this.tasks.set(task.key, { ...task, controller: null, runAt: Date.now() + 1000 });
      } else {
        log.warn(`Background task ${task.key} failed: ${e.message}`);
        this.history.push({ key: task.key, ok: false, error: e.message, ms: Date.now() - t0, at: new Date().toISOString() });
      }
    } finally {
      lease?.release();
      if (this.history.length > 50) this.history.splice(0, this.history.length - 50);
      this.running = null;
      this.kick();
    }
  }

  /** Abort the running task if it uses a model (a foreground turn / image job needs the backend now). */
  preempt() {
    const t = this.running;
    if (!t || !t.needsModel || !t.controller || t.controller.signal.aborted) return false;
    t.preempted = true;
    t.controller.abort(Object.assign(new Error('Pre-empted by a foreground request'), { name: 'AbortError' }));
    return true;
  }

  _resolveIdle() {
    if (this.running || this.tasks.size) return;
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  /** Resolves when the queue is empty and nothing is running (tests / shutdown). */
  idle() {
    if (!this.running && !this.tasks.size) return Promise.resolve();
    return new Promise((r) => { this.waiters.push(r); this.kick(); });
  }

  stop() {
    this.stopped = true;
    this.running?.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.tasks.clear();
    this._resolveIdle();
  }
}

/** Tracks models unloaded to make room for image generation (reloaded lazily on next chat request). */
export class ModelState {
  constructor(app) {
    this.app = app;
    this.unloadedForImage = false;
    this.models = [];
    this.at = null;
  }

  markUnloaded(models) {
    this.unloadedForImage = true;
    this.models = [...new Set([...this.models, ...models])];
    this.at = new Date().toISOString();
    this.app.bus.publish('model.status', { phase: 'unloaded', models: this.models, reason: 'image_generation' });
  }

  markReloaded() {
    if (!this.unloadedForImage) return;
    this.unloadedForImage = false;
    const models = this.models;
    this.models = [];
    this.at = null;
    this.app.bus.publish('model.status', { phase: 'ready', models });
    this.app.background?.kick();
  }

  status() {
    return { unloadedForImage: this.unloadedForImage, models: this.models, since: this.at };
  }
}
