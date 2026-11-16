'use strict';
// Preload for the Harness window. Runs sandboxed with context isolation: it can only use the
// `electron` renderer modules, so it is self-contained. It exposes a tiny, validated API:
//
//   window.harnessDesktop = { platform, appVersion, onMenuAction(cb), openExternal(url), showInFolder(path), setBadge(text) }
//
// and adds classes to <html>: `desktop`, `desktop-mac` on macOS, `desktop-fullscreen` while full-screen.
// Contract documented in docs/DESKTOP.md. All real checks happen again in the main process.
const { contextBridge, ipcRenderer } = require('electron');

const INIT_PREFIX = '--harness-desktop=';
let init = {};
try {
  const arg = (process.argv || []).find((a) => typeof a === 'string' && a.startsWith(INIT_PREFIX));
  if (arg) init = JSON.parse(decodeURIComponent(arg.slice(INIT_PREFIX.length)));
} catch { init = {}; }

const ACTIONS = new Set(Array.isArray(init.actions) ? init.actions : []);
const isMac = process.platform === 'darwin';
let fullscreen = init.fullscreen === true;

// ------------------------------------------------------------------------------------- <html> classes
function applyClasses() {
  const el = document.documentElement;
  if (!el) return false;
  if (!el.classList.contains('desktop')) el.classList.add('desktop');
  if (isMac && !el.classList.contains('desktop-mac')) el.classList.add('desktop-mac');
  if (el.classList.contains('desktop-fullscreen') !== fullscreen) el.classList.toggle('desktop-fullscreen', fullscreen);
  return true;
}

let classObserver = null;
function watchClasses() {
  // Re-apply if the page overwrites <html class="…"> (e.g. a theme switch assigning className).
  if (classObserver || !document.documentElement) return;
  classObserver = new MutationObserver(() => applyClasses());
  classObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}

if (applyClasses()) {
  watchClasses();
} else {
  const mo = new MutationObserver(() => {
    if (applyClasses()) { mo.disconnect(); watchClasses(); }
  });
  mo.observe(document, { childList: true, subtree: true });
}
document.addEventListener('DOMContentLoaded', () => { applyClasses(); watchClasses(); }, { once: true });

ipcRenderer.on('harness:fullscreen', (_e, value) => {
  fullscreen = value === true;
  applyClasses();
});

// --------------------------------------------------------------------------------------- menu actions
const listeners = new Set();
const pending = []; // actions that arrived before the page subscribed (e.g. Dock → New Chat at launch)

ipcRenderer.on('harness:menu-action', (_e, action) => {
  if (!ACTIONS.has(action)) return;
  if (listeners.size === 0) {
    pending.push({ action, at: Date.now() });
    if (pending.length > 10) pending.shift();
    return;
  }
  for (const cb of listeners) {
    try { cb(action); } catch (err) { console.error('harnessDesktop.onMenuAction listener failed:', err); }
  }
});

function onMenuAction(cb) {
  if (typeof cb !== 'function') throw new TypeError('harnessDesktop.onMenuAction(callback) expects a function');
  listeners.add(cb);
  if (listeners.size === 1 && pending.length) {
    const fresh = pending.splice(0).filter((p) => Date.now() - p.at < 10000);
    // Deliver after the caller's synchronous setup has finished.
    setTimeout(() => {
      for (const p of fresh) { try { cb(p.action); } catch (err) { console.error(err); } }
    }, 0);
  }
  return () => { listeners.delete(cb); };
}

// --------------------------------------------------------------------------------------------- API
const str = (v) => (typeof v === 'string' ? v : '');

const api = {
  platform: process.platform,
  appVersion: typeof init.appVersion === 'string' ? init.appVersion : '',
  onMenuAction,
  /** Open an http(s) URL in the default browser. Resolves true if it was opened. */
  openExternal: (url) => ipcRenderer.invoke('harness:open-external', str(url)),
  /** Reveal a file or folder inside the Harness data directory in Finder. Resolves true on success. */
  showInFolder: (p) => ipcRenderer.invoke('harness:show-in-folder', str(p)),
  /** Dock badge text ('' / null clears; numbers allowed). Resolves true if applied. */
  setBadge: (text) => ipcRenderer.invoke('harness:set-badge', typeof text === 'number' || typeof text === 'string' ? text : ''),
};

contextBridge.exposeInMainWorld('harnessDesktop', Object.freeze(api));
