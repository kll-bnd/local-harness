// The single outbound choke point. Every request Harness makes (lib/http-client.mjs, the ComfyUI progress socket,
// fetch_url, the model catalogue) asks `assertEgress` first; while internet access is blocked, a destination that is
// not this Mac is refused BEFORE any name resolution is attempted.
//
// Guards are registered per running server (normally one per process; tests may run several): a request is refused
// when any registered guard is blocking.
import net from 'node:net';
import { HttpError } from '../lib/errors.mjs';

const guards = new Set();
export function registerGuard(g) { guards.add(g); }
export function unregisterGuard(g) { guards.delete(g); }

/** Loopback only: `localhost` (and *.localhost), 127.0.0.0/8, ::1. Anything else is "the internet". */
export function isLoopbackHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIPv4(h)) return h.startsWith('127.');
  if (net.isIPv6(h)) return h === '::1' || /^::ffff:127\./.test(h) || /^(0+:){7}0*1$/.test(h);
  return false;
}

export const ALLOW_HINT = Object.freeze({ method: 'POST', path: '/api/network/allow', body: { minutes: 15 }, needsPassword: true, label: 'Allow internet for 15 minutes' });

export class OfflineLockError extends HttpError {
  constructor(what, host) {
    super(403, 'offline_lock', `Internet access is blocked in Harness${host ? ` (${what.replace(/_/g, ' ')} would contact ${host})` : ''}. Allow it for a few minutes to continue.`, { what, host: host || null, allow: { ...ALLOW_HINT } });
    this.offlineLock = true;
  }
}

function hostOf(target) {
  if (!target) return '';
  if (target instanceof URL) return target.hostname;
  const s = String(target);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) { try { return new URL(s).hostname; } catch { return s; } }
  return s.split(':')[0];
}

/** Throws OfflineLockError when a non-local destination is blocked. `what` names the feature (see docs §10.6). */
export function assertEgress(target, what = 'other') {
  const host = hostOf(target);
  if (isLoopbackHost(host)) return;
  for (const g of guards) if (g.blocked) throw new OfflineLockError(what, host);
}

/** True when a non-local destination would be refused right now. */
export function egressBlocked(target) {
  try { assertEgress(target); return false; } catch { return true; }
}

/** Any guard blocking (used to stop offering fetch_url). */
export function anyBlocking() {
  for (const g of guards) if (g.blocked) return true;
  return false;
}
