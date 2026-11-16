// Command registry. Keyboard shortcuts, the command palette, the native (Electron) menu and buttons all
// call the same functions through runAction(id), so every entry point behaves identically.
import { isMac } from './lib/format.js';

const actions = new Map();
let lastRun = { id: null, at: 0 };

/**
 * defineAction(id, { title, run, keys?: ['Mod+K'], group?, when?: () => bool, hint?, palette?: true, icon? })
 * `Mod` is ⌘ on macOS and Ctrl elsewhere.
 */
export function defineAction(id, spec) {
  actions.set(id, { id, palette: true, group: 'General', ...spec });
}

export function getAction(id) { return actions.get(id); }
export function allActions() { return [...actions.values()]; }

export function runAction(id, ...args) {
  const a = actions.get(id);
  if (!a) { console.warn(`Unknown action ${id}`); return false; }
  if (a.when && !a.when()) return false;
  try { a.run(...args); } catch (e) { console.error(`Action ${id} failed`, e); }
  return true;
}

/**
 * Run an action triggered by a keystroke ('key') or the native menu ('menu'). In Electron one key press can
 * reach both (the page's keydown and the menu accelerator); the second delivery from the *other* source
 * within 150 ms is the same keystroke and is ignored.
 */
export function runActionFrom(source, id, ...args) {
  const now = performance.now();
  if (lastRun.id === id && lastRun.source !== source && now - lastRun.at < 150) return true;
  lastRun = { id, source, at: now };
  return runAction(id, ...args);
}

// ------------------------------------------------------------------------------------------------ keys
/** Normalise a KeyboardEvent to a chord string like "Mod+Shift+K". */
export function chordOf(e) {
  const parts = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (e.code?.startsWith('Key')) k = e.code.slice(3);
  else if (e.code?.startsWith('Digit')) k = e.code.slice(5);
  else if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  if (e.code === 'Slash') k = '/';
  if (e.code === 'Comma') k = ',';
  if (e.code === 'Period') k = '.';
  if (e.code === 'Backslash') k = '\\';
  parts.push(k);
  return parts.join('+');
}

const SYM = isMac
  ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↩', Escape: 'Esc', Backspace: '⌫', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space' }
  : { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Enter: 'Enter', Escape: 'Esc', Backspace: 'Backspace', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space' };

/** Human label for a chord: "Mod+Shift+K" → "⇧⌘K" on Mac, "Ctrl+Shift+K" elsewhere. */
export function keyLabel(chord) {
  if (!chord) return '';
  const parts = chord.split('+');
  const key = parts.pop();
  const k = SYM[key] || key;
  if (isMac) {
    const order = ['Ctrl', 'Alt', 'Shift', 'Mod'];
    return order.filter((m) => parts.includes(m)).map((m) => SYM[m]).join('') + k;
  }
  return [...parts.map((p) => SYM[p] || p), k].join('+');
}

/** Find the action bound to a chord (first match). */
export function actionForChord(chord) {
  for (const a of actions.values()) if (a.keys?.includes(chord)) return a;
  return null;
}
