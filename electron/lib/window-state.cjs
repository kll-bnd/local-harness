'use strict';
// Remember the main window's size/position across launches (pure logic + tiny file I/O).
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SIZE = Object.freeze({ width: 1200, height: 800 });
const MIN_SIZE = Object.freeze({ width: 720, height: 480 });

const isInt = (v) => Number.isInteger(v) && Math.abs(v) < 100000;

/** Parse a stored state; returns null when absent or malformed. */
function parseState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, width, height, maximized } = raw;
  if (!isInt(width) || !isInt(height) || width <= 0 || height <= 0) return null;
  const s = { width, height, maximized: maximized === true };
  if (isInt(x) && isInt(y)) { s.x = x; s.y = y; }
  return s;
}

function readState(file) {
  try { return parseState(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; }
}

function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function intersection(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/**
 * Turn a stored state into BrowserWindow bounds that are guaranteed to be usable on the current
 * displays: size clamped to the work area, and the window must overlap a display enough to be
 * grabbed (otherwise it is centred on the primary display — e.g. after unplugging a monitor).
 * @param {object|null} state  parsed state
 * @param {{workArea:{x,y,width,height}}[]} displays  screen.getAllDisplays()
 * @param {{workArea:{x,y,width,height}}} primary     screen.getPrimaryDisplay()
 * @returns {{x?:number,y?:number,width:number,height:number,maximized:boolean}}
 */
function fitToDisplays(state, displays, primary) {
  const pa = primary?.workArea || { x: 0, y: 0, width: 1440, height: 900 };
  const clampSize = (w, h, area) => ({
    width: Math.max(MIN_SIZE.width, Math.min(w, area.width)),
    height: Math.max(MIN_SIZE.height, Math.min(h, area.height)),
  });
  const centred = (w, h) => {
    const s = clampSize(w, h, pa);
    return { x: Math.round(pa.x + (pa.width - s.width) / 2), y: Math.round(pa.y + (pa.height - s.height) / 2), ...s };
  };
  if (!state) return { ...centred(DEFAULT_SIZE.width, DEFAULT_SIZE.height), maximized: false };
  if (state.x === undefined) return { ...centred(state.width, state.height), maximized: state.maximized };
  const rect = { x: state.x, y: state.y, width: state.width, height: state.height };
  let best = null;
  for (const d of displays || []) {
    const i = intersection(rect, d.workArea);
    if (i && (!best || i.width * i.height > best.area)) best = { area: i.width * i.height, i, d };
  }
  // Visible enough: at least 120×60 px of the window (incl. its title bar region) on some display.
  if (!best || best.i.width < 120 || best.i.height < 60 || state.y < best.d.workArea.y - 10) {
    return { ...centred(state.width, state.height), maximized: state.maximized };
  }
  const area = best.d.workArea;
  const s = clampSize(state.width, state.height, area);
  // Keep the window inside the work area of the display it is mostly on.
  const x = Math.min(Math.max(state.x, area.x), area.x + area.width - s.width);
  const y = Math.min(Math.max(state.y, area.y), area.y + area.height - s.height);
  return { x, y, ...s, maximized: state.maximized };
}

/** Snapshot of a BrowserWindow worth persisting (normal bounds, so a maximized window restores sensibly). */
function captureState(win) {
  const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
}

module.exports = { DEFAULT_SIZE, MIN_SIZE, parseState, readState, writeState, fitToDisplays, captureState };
