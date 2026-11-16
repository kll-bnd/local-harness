'use strict';
// Pure validation helpers for the main process (no Electron imports, unit-tested in electron/test).
const fs = require('node:fs');
const path = require('node:path');

const MAX_URL_LENGTH = 8192;

function parseUrl(u) {
  if (typeof u !== 'string' || !u || u.length > MAX_URL_LENGTH) return null;
  try { return new URL(u); } catch { return null; }
}

/** True when `u` is on exactly the local server's origin (scheme + host + port). */
function isAppUrl(u, appOrigin) {
  const p = parseUrl(u);
  return !!p && !!appOrigin && p.origin === appOrigin;
}

/** http(s) URL suitable for the system browser. Rejects everything else (file:, javascript:, data:, custom schemes, …). */
function isExternalHttpUrl(u) {
  const p = parseUrl(u);
  if (!p) return false;
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return false;
  if (!p.hostname) return false;
  return true;
}

/**
 * Decide what to do with a navigation of the main frame (will-navigate / will-redirect).
 * @returns {'allow'|'external'|'deny'}
 */
function navigationDecision(u, appOrigin) {
  if (isAppUrl(u, appOrigin)) return 'allow';
  if (isExternalHttpUrl(u)) return 'external';
  return 'deny';
}

/**
 * Decide what to do with window.open / target=_blank (setWindowOpenHandler). No child windows are
 * ever created: http(s) links (including links to the local server, e.g. an image file) open in the
 * system browser, everything else is denied.
 * @returns {'external'|'deny'}
 */
function windowOpenDecision(u) {
  return isExternalHttpUrl(u) ? 'external' : 'deny';
}

function realpathOrResolve(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

/**
 * Resolve `p` (absolute, or relative to `dataDir`) and return it only if it is inside `dataDir`
 * (after resolving symlinks) and exists; otherwise null.
 */
function resolveInsideDir(p, dataDir) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')) return null;
  if (typeof dataDir !== 'string' || !dataDir) return null;
  const root = realpathOrResolve(dataDir);
  const candidate = path.resolve(root, p);
  if (!fs.existsSync(candidate)) return null;
  const real = realpathOrResolve(candidate);
  const rel = path.relative(root, real);
  if (rel === '') return real; // the data dir itself
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return real;
}

/** Normalize a dock-badge value: '' clears; strings are trimmed, stripped of control chars, max 12 chars. */
function sanitizeBadge(v) {
  if (v === null || v === undefined || v === false) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return '';
    return v > 99999 ? '99999+' : String(Math.floor(v));
  }
  if (typeof v !== 'string') return null; // invalid
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return Array.from(s).slice(0, 12).join('');
}

// Permissions the page may use. Everything else (camera, microphone, geolocation, notifications,
// MIDI, HID, serial, …) is denied. clipboard-sanitized-write = navigator.clipboard.writeText for
// "Copy" buttons; fullscreen = element.requestFullscreen() (e.g. an image viewer).
const ALLOWED_PERMISSIONS = Object.freeze(['clipboard-sanitized-write', 'fullscreen']);

function isPermissionAllowed(permission, requestingUrl, appOrigin) {
  if (!ALLOWED_PERMISSIONS.includes(permission)) return false;
  return isAppUrl(requestingUrl, appOrigin);
}

module.exports = {
  isAppUrl, isExternalHttpUrl, navigationDecision, windowOpenDecision, resolveInsideDir, sanitizeBadge,
  ALLOWED_PERMISSIONS, isPermissionAllowed,
};
