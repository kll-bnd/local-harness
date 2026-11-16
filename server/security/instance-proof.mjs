// Proof that a running Harness holds this data folder's key (docs/API.md §10.3) — for the command-line tools, which
// must not send the owner's password to whatever program wrote <dataDir>/harness.lock and answers on its port:
//
//   const key = await openDataKeyWithPassword(vaultJson, password)  // null: wrong password — checked LOCALLY
//   const nonce = crypto.randomBytes(32)
//   POST /api/security/prove { "nonce": "<base64url>" }   → { "proof": "<base64url>" }
//   ok = timingSafeEqual(proof, instanceProof(key, nonce, proofBinding({ address: '127.0.0.1', port })));
//   key.fill(0)          // address and port: exactly what the tool connected to (an IP literal, never a name)
//
// proof = HMAC-SHA256(K, "harness-instance-proof-v1" || 0x00 || nonce || 0x00 || binding), with
// K = HKDF-SHA256(data key, empty salt, info "harness-instance-proof-v1") — a subkey used for nothing else, so a
// proof reveals nothing about the data key and is worthless anywhere else. `binding` is where the instance received
// the request — its own local address and port, "addr:127.0.0.1:4747" ("addr:[::1]:4747" for IPv6), or "bridge"
// over the bridge. It defeats a relay: a program at any other address or port that forwards the nonce to the real
// Harness gets a proof for the real Harness's address and port, which do not match what the tool talked to.
//
// Both helpers are PURE: no throttle bookkeeping, no file written, nothing logged. The callers own the data key
// openDataKeyWithPassword returns and must wipe it.
import crypto from 'node:crypto';
import net from 'node:net';
import { hkdf, wipe } from './crypto.mjs';
export { openDataKeyWithPassword } from './vault.mjs';

export const PROOF_LABEL = 'harness-instance-proof-v1';
export const NONCE_MIN_BYTES = 16;
export const NONCE_MAX_BYTES = 64;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** A nonce as sent in the request body (base64url of 16–64 bytes, nothing else), or null. */
export function parseNonce(text) {
  if (typeof text !== 'string' || !B64URL.test(text) || text.length > 90) return null;
  const b = Buffer.from(text, 'base64url');
  if (b.length < NONCE_MIN_BYTES || b.length > NONCE_MAX_BYTES || b.toString('base64url') !== text) return null;
  return b;
}

/**
 * The binding of a request: "addr:<address>:<port>" — the IP literal and port the request arrived on (the server
 * passes its socket's localAddress/localPort; a tool passes what it connected to) — or "bridge". IPv4-mapped IPv6
 * addresses become plain IPv4, IPv6 is written canonically in brackets; host names are refused.
 */
export function proofBinding({ address, port, bridge = false } = {}) {
  if (bridge) return 'bridge';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('instance proof: a port 1–65535 is needed');
  let a = String(address ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) a = mapped[1];
  if (net.isIPv4(a)) return `addr:${a}:${port}`;
  if (net.isIPv6(a)) {
    let c = a;
    try { c = new URL(`http://[${a}]/`).hostname.slice(1, -1); } catch { throw new TypeError('instance proof: not an IP address'); }
    const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(c); // the mapped form in hex → IPv4
    if (m) { const v = (parseInt(m[1], 16) << 16) | parseInt(m[2], 16); return `addr:${[24, 16, 8, 0].map((sh) => (v >>> sh) & 255).join('.')}:${port}`; }
    return `addr:[${c}]:${port}`;
  }
  throw new TypeError('instance proof: the address must be an IP literal (connect to 127.0.0.1, not a name)');
}

/**
 * HMAC-SHA256 over the nonce and the binding, under the proof subkey of `dataKey` (32 bytes). Throws on a nonce
 * outside 16–64 bytes or a missing binding.
 * @param {Buffer} dataKey
 * @param {Buffer|Uint8Array} nonce
 * @param {string} binding  "addr:<ip>:<port>" or "bridge" (proofBinding)
 * @returns {Buffer}
 */
export function instanceProof(dataKey, nonce, binding) {
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) throw new TypeError('instance proof: the data key must be 32 bytes');
  const n = Buffer.from(nonce);
  if (n.length < NONCE_MIN_BYTES || n.length > NONCE_MAX_BYTES) throw new RangeError(`instance proof: the nonce must be ${NONCE_MIN_BYTES}–${NONCE_MAX_BYTES} bytes`);
  if (typeof binding !== 'string' || !/^(addr:(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\]):\d{1,5}|bridge)$/.test(binding)) throw new TypeError('instance proof: binding must be "addr:<ip>:<port>" (proofBinding) or "bridge"');
  const k = hkdf(dataKey, Buffer.alloc(0), PROOF_LABEL);
  try {
    return crypto.createHmac('sha256', k).update(Buffer.concat([Buffer.from(PROOF_LABEL), Buffer.from([0]), n, Buffer.from([0]), Buffer.from(binding)])).digest();
  } finally { wipe(k); }
}
