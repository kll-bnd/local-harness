// The single outbound choke point. Every request Harness makes (lib/http-client.mjs, the ComfyUI progress socket,
// fetch_url, the model catalogue) asks `assertEgress` first; while internet access is blocked, a destination that is
// not this Mac is refused BEFORE any name resolution is attempted.
//
// Guards are registered per running server (normally one per process; tests may run several): a request is refused
// when any registered guard is blocking.
import net from 'node:net';
import dns from 'node:dns';
import { HttpError } from '../lib/errors.mjs';

const guards = new Set();
export function registerGuard(g) { guards.add(g); }
export function unregisterGuard(g) { guards.delete(g); }

const normHost = (host) => {
  let h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (h.endsWith('.') && !net.isIP(h)) h = h.slice(0, -1);
  return h;
};

/** A loopback address literal: 127.0.0.0/8, ::1, ::ffff:127.x.x.x. */
export function isLoopbackAddress(addr) {
  const h = normHost(addr);
  if (net.isIPv4(h)) return h.startsWith('127.');
  if (net.isIPv6(h)) return h === '::1' || /^::ffff:127\./.test(h) || /^(0+:){7}0*1$/.test(h);
  return false;
}

/** The exact name `localhost` (any case, with or without the trailing dot) — NOT `*.localhost`. */
export const isLocalhostName = (host) => normHost(host) === 'localhost';

/**
 * This Mac: the name `localhost` or a loopback address literal. Anything else is "the internet" — including
 * `*.localhost` names, which a hosts file or a resolver may map anywhere. (What `localhost` itself resolves to
 * is pinned at connect time: loopbackOnlyLookup.)
 */
export function isLoopbackHost(host) {
  return isLocalhostName(host) || isLoopbackAddress(host);
}

/** A dns.lookup replacement for the name `localhost`: refuses unless EVERY address it resolves to is loopback. */
export function loopbackOnlyLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'object' && options ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const bad = (addresses || []).filter((a) => !isLoopbackAddress(a.address));
    if (!addresses?.length || bad.length) {
      const e = new Error(`"${hostname}" resolves to ${bad.map((a) => a.address).join(', ') || 'nothing'}, not to this Mac; refused`);
      e.code = 'ELOCALHOST_NOT_LOOPBACK';
      return cb(e);
    }
    if (opts.all) return cb(null, addresses);
    return cb(null, addresses[0].address, addresses[0].family);
  });
}

/** Async check for clients that cannot take a lookup function (WebSocket): throws when `localhost` is not loopback. */
export async function vetLocalhost(hostname) {
  if (!isLocalhostName(hostname)) return;
  await new Promise((resolve, reject) => loopbackOnlyLookup(normHost(hostname), {}, (e) => (e ? reject(e) : resolve())));
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

// Long-lived connections to a destination that is not this Mac (the ComfyUI progress WebSocket of a remote
// ComfyUI): opened while access was allowed, they are closed as soon as it is blocked again.
const live = new Set();
export function trackConnection(target, close) {
  if (isLoopbackHost(hostOf(target))) return () => {};
  const e = { close };
  live.add(e);
  return () => live.delete(e);
}

/** Called when a guard becomes blocking: closes every tracked non-local connection. Returns how many. */
export function closeBlockedConnections() {
  if (!anyBlocking()) return 0;
  const n = live.size;
  for (const e of [...live]) { live.delete(e); try { e.close(); } catch { /* already closed */ } }
  return n;
}
