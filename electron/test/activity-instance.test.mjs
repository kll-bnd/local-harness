// Desktop shell: App Nap guard and "already running" detection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../../server/index.mjs';

process.env.HARNESS_NO_OLLAMA_AUTOSTART = '1';
const require = createRequire(import.meta.url);
const { createActivityGuard, backendBusy, ACTIVITY_EVENTS } = require('../lib/activity.cjs');
const { findRunningHarness, findAppHarness, portRange } = require('../lib/instance.cjs');

function fakeBlocker() {
  const b = { started: [], stopped: [], next: 1, start(type) { const id = b.next++; b.started.push([id, type]); return id; }, stop(id) { b.stopped.push(id); } };
  return b;
}
function fakeTimers() {
  const t = { queue: [], set: (fn) => { const h = { fn }; t.queue.push(h); return h; }, clear: (h) => { t.queue = t.queue.filter((x) => x !== h); }, tick() { const q = t.queue; t.queue = []; q.forEach((h) => h.fn()); } };
  return t;
}

test('App Nap is prevented only while the backend is busy', () => {
  const state = { engine: { active: new Map() }, images: { active: 0 } };
  const blocker = fakeBlocker();
  const timers = fakeTimers();
  const changes = [];
  const g = createActivityGuard({ isBusy: backendBusy(state), blocker, setTimer: timers.set, clearTimer: timers.clear, onChange: (b) => changes.push(b) });
  g.update();
  assert.equal(g.active, false);
  assert.equal(timers.queue.length, 0, 'no polling while idle');
  state.engine.active.set('chat_1', {});
  g.update();
  g.update(); // idempotent
  assert.deepEqual(blocker.started, [[1, 'prevent-app-suspension']]);
  assert.equal(timers.queue.length, 1);
  // generation.finished arrives before the engine forgets the chat: still busy, keep polling
  timers.tick();
  assert.equal(g.active, true);
  state.engine.active.clear();
  state.images.active = 1; // an image job right after
  timers.tick();
  assert.equal(g.active, true);
  state.images.active = 0;
  timers.tick();
  assert.equal(g.active, false);
  assert.deepEqual(blocker.stopped, [1]);
  assert.equal(timers.queue.length, 0, 'polling stops when idle');
  assert.deepEqual(changes, [true, false]);
  state.engine.active.set('x', {});
  g.update();
  g.dispose();
  assert.deepEqual(blocker.stopped, [1, 2]);
  assert.equal(timers.queue.length, 0);
  assert.ok(ACTIVITY_EVENTS.has('generation.started') && ACTIVITY_EVENTS.has('image.job'));
});

test('a throwing busy predicate counts as idle', () => {
  const blocker = fakeBlocker();
  const g = createActivityGuard({ isBusy: () => { throw new Error('x'); }, blocker });
  g.update();
  assert.equal(g.active, false);
});

test('findRunningHarness finds a server with the same data dir only', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-inst-'));
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-inst-other-'));
  const srv = await startServer({ port: 0, dataDir: dir, autodetect: false, logLevel: 'silent' });
  try {
    const found = await findRunningHarness({ dataDir: dir, ports: [srv.port] });
    assert.equal(found?.url, srv.url);
    assert.equal(found.pid, process.pid);
    assert.equal(await findRunningHarness({ dataDir: other, ports: [srv.port] }), null);
    // The data-dir lock names the running URL, so the instance is found even outside the probed ports
    // (e.g. after the server fell back to a random port); a port with nothing listening is just skipped.
    assert.equal((await findRunningHarness({ dataDir: dir, ports: [1] }))?.url, srv.url);
  } finally {
    await srv.close();
    // Lock released on close: nothing is found any more.
    assert.equal(await findRunningHarness({ dataDir: dir, ports: [1] }), null);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(other, { recursive: true, force: true });
  }
  assert.deepEqual(portRange(4747), [4747, 4748, 4749, 4750, 4751, 4752, 4753, 4754, 4755, 4756, 4757]);
});

test('findAppHarness: the native app holds the folder without a local address', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-inst-app-'));
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-inst-app-'));
  const lock = (o) => fs.writeFile(path.join(dir, 'harness.lock'), JSON.stringify(o));
  try {
    assert.equal(findAppHarness({ dataDir: dir }), null, 'no lock file');
    // A live process (this one) holding the folder in bridge mode: found, and never mistaken for a server with a URL.
    await lock({ pid: process.pid, url: null, port: null, startedAt: '2026-01-01T00:00:00.000Z', dataDir: dir, transport: 'bridge' });
    assert.deepEqual(findAppHarness({ dataDir: dir }), { pid: process.pid, transport: 'bridge', startedAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(await findRunningHarness({ dataDir: dir }), null);
    // The lock names another folder (a copied data folder): not ours.
    await lock({ pid: process.pid, url: null, port: null, dataDir: other, transport: 'bridge' });
    assert.equal(findAppHarness({ dataDir: dir }), null);
    // The app has quit and left its lock behind.
    await lock({ pid: 2 ** 22 + 12345, url: null, port: null, dataDir: dir, transport: 'bridge' });
    assert.equal(findAppHarness({ dataDir: dir }), null);
    // A listener-mode server that is still starting (no URL yet) is not "the app".
    await lock({ pid: process.pid, url: null, port: null, dataDir: dir });
    assert.equal(findAppHarness({ dataDir: dir }), null);
    await fs.writeFile(path.join(dir, 'harness.lock'), '{ not json');
    assert.equal(findAppHarness({ dataDir: dir }), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(other, { recursive: true, force: true });
  }
});
