// Proof that a running Harness holds this data folder's key — the check the command-line tools make before they
// send the owner's password to a Harness they did not start themselves (one found through <dataDir>/harness.lock).
//
//   const key = await openDataKeyWithPassword(vaultJson, password)   // null: wrong password (checked LOCALLY)
//   const proof = instanceProof(key, nonce)                           // what the instance must answer
//   POST /api/security/prove { nonce } → { proof }                    // docs/API.md §10.3
//
// TEMPORARY SHIM: the backend owns these helpers (a pure module under server/security/). Until it lands, this
// file implements the contract the backend agent was given, on top of server/security/crypto.mjs: the data key is
// unwrapped exactly like Vault._openPassword does; the proof is
//   HMAC-SHA256(K, "harness-instance-proof-v1" || 0x00 || nonce),  K = HKDF-SHA256(dataKey, "", "harness-instance-proof-v1")
// When the real module lands, re-export it here and delete the shim code (the HKDF salt/info must be the backend's).
import crypto from 'node:crypto';
import { deriveKey, unseal, hkdf } from '../../server/security/crypto.mjs';

const WRAP_AAD = 'harness-wrap-v1:password';
const PROOF_LABEL = 'harness-instance-proof-v1';

/**
 * Unwrap the data key with the password from a parsed vault.json — no side effects (no throttle counter, no file
 * written). The caller wipes the returned key. null when the password is wrong or the vault has no password wrap.
 * @returns {Promise<Buffer|null>}
 */
export async function openDataKeyWithPassword(vault, password) {
  const w = vault?.wraps?.password;
  if (!w || typeof password !== 'string' || !password) return null;
  const kek = await deriveKey(password, w.kdf);
  try {
    return unseal(kek, w, WRAP_AAD);
  } finally {
    kek.fill(0);
  }
}

/** HMAC-SHA256 proof over a nonce, under a subkey dedicated to this purpose. */
export function instanceProof(dataKey, nonce) {
  const k = hkdf(dataKey, Buffer.alloc(0), PROOF_LABEL);
  try {
    return crypto.createHmac('sha256', k).update(Buffer.concat([Buffer.from(PROOF_LABEL), Buffer.from([0]), Buffer.from(nonce)])).digest();
  } finally {
    k.fill(0);
  }
}
