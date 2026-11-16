// Desktop shell: window size/position persistence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ws = require('../lib/window-state.cjs');

const laptop = { workArea: { x: 0, y: 25, width: 1440, height: 875 } }; // MacBook menu bar at the top
const external = { workArea: { x: 1440, y: 0, width: 2560, height: 1415 } };

test('no saved state → default size centred on the primary display', () => {
  const b = ws.fitToDisplays(null, [laptop], laptop);
  assert.deepEqual(b, { x: 120, y: 63, width: 1200, height: 800, maximized: false });
});

test('a saved position on a visible display is kept', () => {
  const b = ws.fitToDisplays({ x: 100, y: 60, width: 1000, height: 700, maximized: true }, [laptop], laptop);
  assert.deepEqual(b, { x: 100, y: 60, width: 1000, height: 700, maximized: true });
  const e = ws.fitToDisplays({ x: 2000, y: 100, width: 1600, height: 1000 }, [laptop, external], laptop);
  assert.deepEqual(e, { x: 2000, y: 100, width: 1600, height: 1000, maximized: false });
});

test('a window on an unplugged monitor comes back to the primary display', () => {
  const b = ws.fitToDisplays({ x: 2000, y: 100, width: 1600, height: 1000 }, [laptop], laptop);
  assert.equal(b.width, 1440);
  assert.equal(b.height, 875);
  assert.equal(b.x, 0);
  assert.equal(b.y, 25);
});

test('oversized / partly off-screen windows are clamped into the work area', () => {
  const b = ws.fitToDisplays({ x: 1300, y: 25, width: 3000, height: 3000 }, [laptop], laptop);
  assert.deepEqual(b, { x: 0, y: 25, width: 1440, height: 875, maximized: false });
  const above = ws.fitToDisplays({ x: 100, y: -400, width: 800, height: 600 }, [laptop], laptop);
  assert.ok(above.y >= 25, 'title bar must not be above the menu bar');
  const tiny = ws.fitToDisplays({ x: 10, y: 30, width: 50, height: 50 }, [laptop], laptop);
  assert.deepEqual([tiny.width, tiny.height], [ws.MIN_SIZE.width, ws.MIN_SIZE.height]);
});

test('parseState rejects garbage; read/write round-trips atomically', () => {
  assert.equal(ws.parseState(null), null);
  assert.equal(ws.parseState({ width: 'a', height: 2 }), null);
  assert.equal(ws.parseState({ width: -5, height: 10 }), null);
  assert.deepEqual(ws.parseState({ width: 800, height: 600, x: 1.5, y: 2 }), { width: 800, height: 600, maximized: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ws-'));
  const file = path.join(dir, 'sub', 'window-state.json');
  assert.equal(ws.readState(file), null);
  assert.ok(ws.writeState(file, { x: 1, y: 2, width: 900, height: 700, maximized: false }));
  assert.deepEqual(ws.readState(file), { x: 1, y: 2, width: 900, height: 700, maximized: false });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['window-state.json']);
  fs.writeFileSync(file, '{oops');
  assert.equal(ws.readState(file), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('captureState uses normal bounds', () => {
  const win = { getNormalBounds: () => ({ x: 5, y: 6, width: 1000, height: 700 }), getBounds: () => ({ x: 0, y: 0, width: 1440, height: 875 }), isMaximized: () => true };
  assert.deepEqual(ws.captureState(win), { x: 5, y: 6, width: 1000, height: 700, maximized: true });
});
