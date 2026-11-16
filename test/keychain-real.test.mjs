// OPT-IN, macOS only: the real login Keychain through /usr/bin/security, with a random THROW-AWAY service name
// (never Harness's own `local.harness` item), removed afterwards even on failure. Run on a Mac with
//   HARNESS_TEST_REAL_KEYCHAIN=1 node --test test/keychain-real.test.mjs
// It prints what `security` really answered (key values masked) for: item missing, item present, and an item
// whose access list trusts no application (a prompt in a GUI session; "interaction not allowed" headless).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { macKeychain, runSecurity, KeychainError } from '../server/security/keychain.mjs';

const enabled = process.env.HARNESS_TEST_REAL_KEYCHAIN === '1' && process.platform === 'darwin';
const BIN = '/usr/bin/security';
const SVC = `local.harness.selftest-${crypto.randomBytes(6).toString('hex')}`;
const SVC_LOCKED = `${SVC}-noacl`;
const ACCOUNT = 'data-key';
const mask = (s) => String(s).replace(/[A-Za-z0-9+/]{43}=/g, '<base64 key>');
const show = (label, r) => console.log(`# ${label}: exit ${r.code}${r.timedOut ? ' (timed out)' : ''}\n#   stdout: ${JSON.stringify(mask(r.out)).slice(0, 400)}\n#   stderr: ${JSON.stringify(mask(r.err)).slice(0, 400)}`);

after(async () => {
  if (!enabled) return;
  for (const svc of [SVC, SVC_LOCKED]) await runSecurity(BIN, [`delete-generic-password -s "${svc}" -a "${ACCOUNT}"`], { timeoutMs: 15000 }).catch(() => {});
  const left = await runSecurity(BIN, [`find-generic-password -s "${SVC}" -a "${ACCOUNT}"`], { timeoutMs: 15000 });
  console.log(`# cleanup: ${/could not be found/i.test(left.err) ? 'throw-away items removed' : `CHECK: ${mask(left.err || left.out).slice(0, 200)}`}`);
});

test('real Keychain: missing → null, set → get round trip over stdin, delete; error strings as security prints them', { skip: !enabled && 'set HARNESS_TEST_REAL_KEYCHAIN=1 on a Mac to run against the real Keychain' }, async () => {
  const kc = macKeychain({ securityBin: BIN, service: SVC, account: ACCOUNT, label: 'Harness self-test (safe to delete)', timeoutMs: 20000 });
  // 1. item missing
  const missing = await runSecurity(BIN, [`find-generic-password -s "${SVC}" -a "${ACCOUNT}" -w`], { timeoutMs: 15000 });
  show('item missing (raw)', missing);
  assert.equal(await kc.get(), null, 'a missing item reads as null, not as an error');
  // 2. item present
  const key = crypto.randomBytes(32);
  await kc.set(key);
  const present = await runSecurity(BIN, [`find-generic-password -s "${SVC}" -a "${ACCOUNT}" -w`], { timeoutMs: 15000 });
  show('item present (raw)', present);
  assert.ok(present.out.includes(key.toString('base64')), 'security -i printed the stored value');
  assert.deepEqual(await kc.get(), key);
  const k2 = crypto.randomBytes(32);
  await kc.set(k2); // -U updates in place
  assert.deepEqual(await kc.get(), k2);
  await kc.delete();
  assert.equal(await kc.get(), null);
  await kc.delete(); // deleting a missing item is not an error
});

test('real Keychain: an item no application is trusted for (the prompt / non-interactive case) ends with a clear answer, never a hang', { skip: !enabled && 'set HARNESS_TEST_REAL_KEYCHAIN=1 on a Mac' }, async () => {
  const value = crypto.randomBytes(32).toString('base64');
  // -T "" = trust no application, not even security itself → reading needs the user's permission
  const add = await runSecurity(BIN, [`add-generic-password -U -s "${SVC_LOCKED}" -a "${ACCOUNT}" -l "Harness self-test (safe to delete)" -T "" -w ${value}`], { timeoutMs: 15000 });
  show('add with an empty access list (raw)', add);
  const raw = await runSecurity(BIN, [`find-generic-password -s "${SVC_LOCKED}" -a "${ACCOUNT}" -w`], { timeoutMs: 20000 });
  show('read it without being trusted (raw)', raw);
  const kc = macKeychain({ securityBin: BIN, service: SVC_LOCKED, account: ACCOUNT, timeoutMs: 20000 });
  const t0 = Date.now();
  let outcome;
  try { const v = await kc.get(); outcome = v ? 'read (no prompt was needed here)' : 'null (treated as missing)'; } catch (e) { outcome = e instanceof KeychainError ? `KeychainError ${e.reason}: ${e.message}` : `other error: ${e.message}`; }
  console.log(`# macKeychain.get() on it → ${outcome} after ${Date.now() - t0} ms`);
  assert.ok(Date.now() - t0 < 25000, 'bounded');
  assert.ok(!/other error/.test(outcome), outcome);
});
