import { EventEmitter } from 'node:events';

/**
 * Global event bus for background events, fanned out to `GET /api/events` subscribers.
 * Each event: `{ type, data, ts }`.
 */
export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(1000);
  }
  publish(type, data = {}) {
    this.emit('event', { type, data, ts: new Date().toISOString() });
  }
}
