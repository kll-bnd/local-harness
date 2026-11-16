// Proof that a running Harness holds this data folder's key — the check the command-line tools make before they
// send the owner's password to a Harness they did not start (one found through <dataDir>/harness.lock).
// The backend owns the helpers (server/security/instance-proof.mjs, docs/API.md §10.3); this file only re-exports
// them so the tools have one import:
//
//   const key = await openDataKeyWithPassword(vaultJson, password)   // null: wrong password (checked LOCALLY)
//   POST /api/security/prove { nonce } → { proof }
//   timingSafeEqual(proof, instanceProof(key, nonce, proofBinding({ port: <the port we connected to> })))
export { openDataKeyWithPassword, instanceProof, proofBinding } from '../../server/security/instance-proof.mjs';
export { validVault } from '../../server/security/vault.mjs';
