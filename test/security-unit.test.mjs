// 0.2 security primitives: file formats, key store, recovery keys, throttle, migration engine, egress guard.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tmpDir } from './helpers.mjs';
import {
  encryptHXC, decryptHXC, hxcEncryptor, hxcPlainSize, encryptHXL, decryptHXL, hxlRecord, isHXC, isHXL, formatRecoveryKey, parseRecoveryKey,
  deriveKey, newKdf, KDF_PRODUCTION, HEADER_C, CryptoError,
} from '../server/security/crypto.mjs';
import { Vault, throttleDelay, validVault } from '../server/security/vault.mjs';
import { setDirCipher, writeFileAtomic, readFileData, appendData, readJson, createDataReadStream, dataFileSize, writeJsonAtomic } from '../server/lib/fsx.mjs';
import { migrateDir, listDataFiles, hasPlainData, hasEncryptedData } from '../server/security/migrate.mjs';
import { assertEgress, isLoopbackHost, registerGuard, unregisterGuard, OfflineLockError } from '../server/security/egress.mjs';
import { encryptBackup, openBackup } from '../server/security/backup-crypto.mjs';
import { macKeychain, KeychainError, chooseKeychain, keychainAccountFor, isDefaultDataDir, KEYCHAIN_ACCOUNT } from '../server/security/keychain.mjs';

const FAST = { N: 1024, r: 8, p: 1 };
const key = () => crypto.randomBytes(32);

describe('file formats', () => {
  test('HXC1 round-trips any size, authenticates the header, detects truncation, reordering and the wrong key', () => {
    const k = key();
    for (const n of [0, 1, 65535, 65536, 65537, 300000]) {
      const pt = crypto.randomBytes(n);
      const ct = encryptHXC(k, pt);
      assert.ok(isHXC(ct));
      assert.equal(hxcPlainSize(ct.length), n);
      assert.deepEqual(decryptHXC(k, ct), pt);
    }
    const pt = crypto.randomBytes(200000);
    const ct = encryptHXC(k, pt);
    assert.throws(() => decryptHXC(k, ct.subarray(0, ct.length - 70000)), CryptoError, 'truncated at a chunk boundary');
    const bad = Buffer.from(ct); bad[HEADER_C + 10] ^= 1;
    assert.throws(() => decryptHXC(k, bad), CryptoError);
    const hdr = Buffer.from(ct); hdr[20] ^= 1; // nonce prefix is authenticated
    assert.throws(() => decryptHXC(k, hdr), CryptoError);
    assert.throws(() => decryptHXC(key(), ct), (e) => e.code === 'wrong_key');
    // streaming encryptor = one-shot
    const e = hxcEncryptor(k);
    const parts = [e.header];
    for (let off = 0; off < pt.length; off += 7777) parts.push(...e.push(pt.subarray(off, off + 7777)));
    parts.push(e.finish());
    assert.deepEqual(decryptHXC(k, Buffer.concat(parts)), pt);
  });

  test('HXL1: append-only sealed records; a torn last record is ignored, a tampered one is not', () => {
    const k = key();
    let buf = encryptHXL(k, Buffer.from('one\n'));
    buf = Buffer.concat([buf, hxlRecord(k, Buffer.from('two\n'))]);
    assert.ok(isHXL(buf));
    assert.equal(decryptHXL(k, buf).toString(), 'one\ntwo\n');
    const torn = Buffer.concat([buf, hxlRecord(k, Buffer.from('three\n')).subarray(0, 9)]);
    assert.equal(decryptHXL(k, torn).toString(), 'one\ntwo\n');
    const bad = Buffer.from(buf); bad[bad.length - 3] ^= 1;
    assert.throws(() => decryptHXL(k, bad), CryptoError);
    assert.throws(() => decryptHXL(key(), buf), (e) => e.code === 'wrong_key');
  });

  test('recovery keys: HRK1 + 13 groups of 4 Crockford base32; typing slack accepted; garbage refused', () => {
    const rk = crypto.randomBytes(32);
    const text = formatRecoveryKey(rk);
    assert.match(text, /^HRK1(-[0-9A-HJKMNP-TV-Z]{4}){13}$/);
    assert.deepEqual(parseRecoveryKey(text), rk);
    assert.deepEqual(parseRecoveryKey(` ${text.toLowerCase().replace(/-/g, ' ')} `), rk);
    assert.deepEqual(parseRecoveryKey(text.replace(/1/g, 'I').replace(/0/g, 'O')), rk);
    assert.equal(parseRecoveryKey('HRK1-XXXX'), null);
    assert.equal(parseRecoveryKey('nonsense'), null);
  });

  test('production KDF: scrypt N=2^17 r=8 p=1 (128 MiB) takes a measurable fraction of a second and fits in memory', async () => {
    const kdf = newKdf(KDF_PRODUCTION);
    assert.equal(kdf.N, 131072);
    const before = process.resourceUsage().maxRSS * 1024; // peak RSS so far
    const t0 = process.hrtime.bigint();
    const k = await deriveKey('correct horse battery staple', kdf);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const peak = process.resourceUsage().maxRSS * 1024;
    const grew = Math.max(0, peak - before);
    console.log(`# production scrypt: ${ms.toFixed(0)} ms, peak RSS ${Math.round(peak / 1048576)} MiB (+${Math.round(grew / 1048576)} MiB; the 128 MiB work area is transient)`);
    assert.equal(k.length, 32);
    assert.ok(ms > 20, `suspiciously fast (${ms} ms): is the cost really N=2^17?`);
    assert.ok(ms < 15000, `too slow for an unlock (${ms} ms)`);
    assert.ok(grew < 400 * 1048576, `RSS grew by ${grew} bytes`);
    assert.deepEqual(await deriveKey('correct horse battery staple', kdf), k);
  });
});

describe('key store (vault.json)', () => {
  test('create → unlock with password or recovery key; wrong ones fail; throttle 3 free then doubling, persisted', async () => {
    const dir = await tmpDir();
    const v = new Vault(dir, { kdf: FAST });
    const rk = await v.create('correct horse');
    const dek = Buffer.from(v.dek);
    assert.ok(validVault(JSON.parse(fss.readFileSync(path.join(dir, 'vault.json'), 'utf8'))));
    assert.equal((fss.statSync(path.join(dir, 'vault.json')).mode & 0o777), 0o600);
    const raw = fss.readFileSync(path.join(dir, 'vault.json'), 'utf8');
    assert.ok(!raw.includes(dek.toString('base64')) && !raw.includes(dek.toString('hex')), 'the data key never appears in the key store');
    v.lock();
    assert.equal(v.dek, null);
    const v2 = new Vault(dir).load();
    assert.deepEqual(await v2.unlockWithPassword('correct horse'), dek);
    v2.lock();
    assert.deepEqual(await v2.unlockWithRecoveryKey(rk), dek);
    v2.lock();
    for (let i = 1; i <= 2; i++) await assert.rejects(v2.unlockWithPassword(`wrong ${i}`), (e) => e.code === 'wrong_password' && e.status === 401 && e.details.retryAfterMs === 0);
    await assert.rejects(v2.unlockWithPassword('wrong 3'), (e) => e.code === 'wrong_password' && e.details.retryAfterMs === 1000, 'the 3rd free attempt; the 4th must wait 1 s');
    await assert.rejects(v2.unlockWithPassword('correct horse'), (e) => e.code === 'unlock_throttled' && e.status === 429 && e.details.retryAfterMs > 0);
    const v3 = new Vault(dir).load(); // a restart keeps the count
    assert.ok(v3.retryAfterMs() > 0);
    assert.equal(throttleDelay(2), 0);
    assert.equal(throttleDelay(3), 1000);
    assert.equal(throttleDelay(4), 2000);
    assert.equal(throttleDelay(40), 300000);
  });

  test('the security record (review 01): sealed under the data key; edited, forged, older or orphaned copies are told apart', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'vault.json');
    const base = { mode: 'password', encrypted: true, offlineLock: true, allowedUntil: null, allowFrom: null, migration: null };
    const v = new Vault(dir, { kdf: FAST });
    await v.create('correct horse', { state: base });
    assert.equal(v.readState().status, 'ok');
    const first = fss.readFileSync(file);
    assert.ok(!first.includes('"mode"') && !first.includes('offlineLock'), 'the record is not readable in vault.json');
    v.commit({ offlineLock: false });
    v.lock();
    const open = async () => { const w = new Vault(dir, { kdf: FAST }).load(); await w.unlockWithPassword('correct horse'); return w; };
    let w = await open();
    let r = w.readState();
    assert.equal(r.status, 'ok');
    assert.equal(r.record.offlineLock, false);
    assert.equal(r.record.seq, 2);
    // an older vault.json put back on its own: vault-seq.json is ahead → stale (authentic, but not current)
    const second = fss.readFileSync(file);
    fss.writeFileSync(file, first);
    w = await open();
    r = w.readState();
    assert.equal(r.status, 'stale');
    assert.equal(r.record.offlineLock, true);
    // the plain fields can be edited, the record cannot: a byte changed, or one sealed under another key → invalid
    fss.writeFileSync(file, second);
    const m = JSON.parse(second);
    const data = Buffer.from(m.state.data, 'base64');
    data[3] ^= 1;
    fss.writeFileSync(file, JSON.stringify({ ...m, state: { ...m.state, data: data.toString('base64') } }));
    assert.equal((await open()).readState().status, 'invalid');
    const { seal } = await import('../server/security/crypto.mjs');
    const forged = seal(key(), Buffer.from(JSON.stringify({ v: 1, seq: 99, keyId: m.keyId, ...base, offlineLock: false, tamper: null, prevKeyId: null })), `harness-state-v1:${m.keyId}`);
    fss.writeFileSync(file, JSON.stringify({ ...m, state: { seq: 99, ...forged } }));
    assert.equal((await open()).readState().status, 'invalid');
    // no record (a 0.2.0 key store) → missing; the counter file removed while the record is past its first write → stale
    fss.writeFileSync(file, JSON.stringify({ ...m, state: undefined }));
    assert.equal((await open()).readState().status, 'missing');
    fss.writeFileSync(file, second);
    fss.rmSync(path.join(dir, 'vault-seq.json'));
    assert.equal((await open()).readState().status, 'stale');
    // a new data key: the record moves to it; a counter file still under the old key (crash in between) is accepted
    w = await open();
    w.readState();
    w.commit({});
    const oldSeq = fss.readFileSync(path.join(dir, 'vault-seq.json'));
    await w.replaceKey(crypto.randomBytes(32), 'correct horse', { state: { migration: null } });
    assert.equal(w.readState().status, 'ok');
    fss.writeFileSync(path.join(dir, 'vault-seq.json'), oldSeq);
    r = (await open()).readState();
    assert.equal(r.status, 'ok');
    assert.equal(r.record.prevKeyId, m.keyId);
    // the record key is not the data key, and off mode keeps only it
    w = await open();
    assert.ok(w.stateKey && !w.stateKey.equals(w.dek));
    w.lock({ keepStateKey: true });
    assert.equal(w.dek, null);
    assert.ok(w.stateKey);
    w.lock();
    assert.equal(w.stateKey, null);
  });

  test('password change re-wraps only; a new recovery key replaces the old one', async () => {
    const dir = await tmpDir();
    const v = new Vault(dir, { kdf: FAST });
    const rk1 = await v.create('first password');
    const dek = Buffer.from(v.dek);
    await v.changePassword('second password');
    const rk2 = v.newRecoveryKey().recoveryKey;
    v.lock();
    const w = new Vault(dir).load();
    await assert.rejects(w.unlockWithPassword('first password'), (e) => e.code === 'wrong_password');
    assert.deepEqual(await w.unlockWithPassword('second password'), dek);
    w.lock();
    await assert.rejects(w.unlockWithRecoveryKey(rk1), (e) => e.code === 'wrong_recovery_key');
    assert.deepEqual(await w.unlockWithRecoveryKey(rk2), dek);
  });

  test('a damaged vault.json falls back to its verified copy; both damaged → vault_corrupt (never "missing")', async () => {
    const dir = await tmpDir();
    const v = new Vault(dir, { kdf: FAST });
    await v.create('correct horse');
    const good = fss.readFileSync(path.join(dir, 'vault.json'), 'utf8');
    assert.equal(fss.readFileSync(path.join(dir, 'vault.json.bak'), 'utf8'), good);
    fss.writeFileSync(path.join(dir, 'vault.json'), '{oops');
    const r = new Vault(dir).load();
    assert.ok(r.restoredFromBackup);
    assert.equal(fss.readFileSync(path.join(dir, 'vault.json'), 'utf8'), good);
    fss.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify({ version: 1, wraps: {} }));
    fss.writeFileSync(path.join(dir, 'vault.json.bak'), good.slice(0, 40));
    assert.throws(() => new Vault(dir).load(), (e) => e.code === 'vault_corrupt' && e.status === 503);
    fss.rmSync(path.join(dir, 'vault.json'));
    assert.throws(() => new Vault(dir).load(), (e) => e.code === 'vault_corrupt', 'a damaged copy with no main file is corruption, not a fresh install');
  });
});

describe('encrypted data directory (fsx)', () => {
  test('writes encrypt, reads accept plain and encrypted (mixed), logs append sealed records, streams are bounded', async () => {
    const dir = await tmpDir();
    const k = key();
    await fs.writeFile(path.join(dir, 'old.json'), '{"plain":true}');
    setDirCipher(dir, { key: k });
    try {
      await writeJsonAtomic(path.join(dir, 'new.json'), { secret: 'MARKER-123' });
      const raw = await fs.readFile(path.join(dir, 'new.json'));
      assert.ok(isHXC(raw) && !raw.includes('MARKER-123'));
      assert.equal((fss.statSync(path.join(dir, 'new.json')).mode & 0o777), 0o600);
      assert.deepEqual(await readJson(path.join(dir, 'new.json')), { secret: 'MARKER-123' });
      assert.deepEqual(await readJson(path.join(dir, 'old.json')), { plain: true }, 'a plain file in an encrypted dir still reads');
      const log = path.join(dir, 'x.items.jsonl');
      await appendData(log, 'a\n');
      const size1 = (await fs.stat(log)).size;
      await appendData(log, 'b\n');
      assert.ok(isHXL(await fs.readFile(log)));
      assert.ok((await fs.stat(log)).size > size1, 'appended, not rewritten');
      assert.equal((await readFileData(log)).toString(), 'a\nb\n');
      const big = crypto.randomBytes(3 * 1024 * 1024 + 17);
      await writeFileAtomic(path.join(dir, 'big.bin'), big);
      assert.equal(await dataFileSize(path.join(dir, 'big.bin')), big.length);
      const parts = [];
      for await (const c of createDataReadStream(path.join(dir, 'big.bin'))) { assert.ok(c.length <= 512 * 1024); parts.push(c); }
      assert.deepEqual(Buffer.concat(parts), big);
      // locked: encrypted files cannot be read, nothing can be written
      setDirCipher(dir, 'locked');
      await assert.rejects(readJson(path.join(dir, 'new.json')), (e) => e.status === 423);
      await assert.rejects(writeJsonAtomic(path.join(dir, 'n2.json'), {}), (e) => e.status === 423);
      // another key: a clear error, the file is NOT moved aside or changed
      setDirCipher(dir, { key: key() });
      await assert.rejects(readJson(path.join(dir, 'new.json')), (e) => e.code === 'wrong_key');
      assert.deepEqual(await fs.readFile(path.join(dir, 'new.json')), raw);
    } finally { setDirCipher(dir, null); }
  });

  test('migration: interrupted halfway the directory is mixed and fully readable; resuming finishes; decrypting reverses it', async () => {
    const dir = await tmpDir();
    const files = {};
    for (let i = 0; i < 12; i++) {
      const p = path.join(dir, 'chats', `c${i}.json`);
      await fs.mkdir(path.dirname(p), { recursive: true });
      files[p] = JSON.stringify({ i, text: `secret ${i}` });
      await fs.writeFile(p, files[p]);
    }
    await fs.writeFile(path.join(dir, 'launch.json'), '{}');
    await fs.writeFile(path.join(dir, 'index', 'x').replace('/x', '.log'), 'log line').catch(() => {});
    assert.ok(await hasPlainData(dir));
    const k = key();
    setDirCipher(dir, { key: k });
    try {
      let n = 0;
      await assert.rejects(migrateDir(dir, { op: 'encrypt', toKey: k, shouldStop: () => ++n > 5 }), (e) => e.code === 'migration_stopped');
      let enc = 0;
      for (const p of Object.keys(files)) { if (isHXC(await fs.readFile(p))) enc++; assert.equal((await readFileData(p)).toString(), files[p]); }
      assert.equal(enc, 5);
      const progress = [];
      const r = await migrateDir(dir, { op: 'encrypt', toKey: k, onProgress: (x) => progress.push(x.done) });
      assert.equal(r.converted, 7);
      assert.equal(progress.at(-1), 12);
      for (const p of Object.keys(files)) { const raw = await fs.readFile(p); assert.ok(isHXC(raw) && !raw.includes('secret')); }
      assert.equal((await fs.readFile(path.join(dir, 'launch.json'), 'utf8')), '{}', 'plain-by-design files stay plain');
      assert.ok(await hasEncryptedData(dir));
      setDirCipher(dir, { key: null, oldKeys: [k] });
      await migrateDir(dir, { op: 'decrypt', toKey: null });
      for (const p of Object.keys(files)) assert.equal(await fs.readFile(p, 'utf8'), files[p]);
      assert.equal((await listDataFiles(dir)).filter((f) => f.endsWith('.tmp')).length, 0);
    } finally { setDirCipher(dir, null); }
  });
});

describe('internet blocker (code layer)', () => {
  test('non-loopback destinations are refused before any name lookup; loopback always passes', async () => {
    assert.ok(isLoopbackHost('localhost') && isLoopbackHost('127.0.0.1') && isLoopbackHost('[::1]') && !isLoopbackHost('a.localhost'));
    assert.ok(!isLoopbackHost('huggingface.co') && !isLoopbackHost('10.0.0.1') && !isLoopbackHost('127.example.com'));
    const g = { blocked: true };
    registerGuard(g);
    try {
      assert.throws(() => assertEgress('https://huggingface.co/api/models', 'model_catalog'), (e) => e instanceof OfflineLockError && e.status === 403 && e.details.what === 'model_catalog' && e.details.host === 'huggingface.co' && e.details.allow.path === '/api/network/allow' && e.details.allow.needsPassword === true && e.details.allow.label === 'Allow internet for 15 minutes');
      assertEgress('http://127.0.0.1:11434/api/tags');
      const { httpRequest } = await import('../server/lib/http-client.mjs');
      const dns = (await import('node:dns')).default;
      const orig = dns.lookup;
      let lookups = 0;
      dns.lookup = (...a) => { lookups++; return orig(...a); };
      try {
        await assert.rejects(httpRequest('https://does-not-resolve.example.invalid/'), (e) => e.code === 'offline_lock');
        assert.equal(lookups, 0, 'refused before name resolution');
      } finally { dns.lookup = orig; }
    } finally { unregisterGuard(g); }
  });
});

describe('backups and keychain helpers', () => {
  test('passphrase backups: scrypt + AES-256-GCM; the header passphrase opens it; wrong or missing ones are refused', async () => {
    const json = JSON.stringify({ format: 'harness.backup', chats: [{ id: 'c1', title: 'MARKER-B' }] });
    const env = await encryptBackup(json, 'backup passphrase', FAST);
    assert.equal(env.format, 'harness.backup.encrypted');
    assert.equal(env.kdf.name, 'scrypt');
    assert.ok(!JSON.stringify(env).includes('MARKER-B'));
    const req = (p) => ({ headers: p === undefined ? {} : { 'x-harness-backup-passphrase': Buffer.from(p).toString('base64url') } });
    assert.deepEqual(await openBackup(env, req('backup passphrase')), JSON.parse(json));
    await assert.rejects(openBackup(env, req()), (e) => e.code === 'encrypted_backup');
    await assert.rejects(openBackup(env, req('nope nope nope')), (e) => e.code === 'wrong_passphrase');
    assert.deepEqual(await openBackup({ format: 'harness.backup', chats: [] }, req()), { format: 'harness.backup', chats: [] });
  });

  test('macOS Keychain driver: key only on stdin (never argv/env); denial and silence end with a clear error, not a hang', async () => {
    const dir = await tmpDir();
    const log = path.join(dir, 'calls.jsonl');
    const fake = path.join(dir, 'security');
    // A stand-in for /usr/bin/security -i: records argv, env and stdin; behaviour from FAKE_MODE.
    await fs.writeFile(fake, `#!${process.execPath}
const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), keyInEnv: Object.values(process.env).some((v) => /^[A-Za-z0-9+/]{43}=$/.test(v)), stdin: input }) + '\\n');
  const mode = process.env.FAKE_MODE || 'ok';
  if (mode === 'hang') return setTimeout(() => {}, 60000);
  if (mode === 'deny') { process.stderr.write('security: SecKeychainSearchCopyNext: User canceled the operation. (-128)\\n'); process.exit(0); }
  const m = /-w ([A-Za-z0-9+/=]{44})/.exec(input);
  if (m) fs.writeFileSync(${JSON.stringify(path.join(dir, 'stored'))}, m[1]);
  if (/find-generic-password/.test(input)) { try { process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(dir, 'stored'))}, 'utf8') + '\\n'); } catch { process.stderr.write('security: The specified item could not be found in the keychain.\\n'); } }
});
`, { mode: 0o755 });
    const kc = macKeychain({ securityBin: fake });
    assert.equal(await kc.get(), null, 'no item yet');
    const k = key();
    await kc.set(k);
    assert.deepEqual(await kc.get(), k);
    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const b64 = k.toString('base64');
    for (const c of calls) {
      assert.deepEqual(c.argv, ['-i']);
      assert.ok(!JSON.stringify(c.argv).includes(b64) && !c.keyInEnv);
    }
    assert.ok(calls.some((c) => c.stdin.includes(`-w ${b64}`) && c.stdin.includes('-s "local.harness"') && c.stdin.includes('-a "data-key"') && c.stdin.includes('-l "Harness data key"')));
    process.env.FAKE_MODE = 'deny';
    try { await assert.rejects(kc.get(), (e) => e instanceof KeychainError && e.reason === 'denied'); } finally { delete process.env.FAKE_MODE; }
    process.env.FAKE_MODE = 'hang';
    try {
      const t0 = Date.now();
      await assert.rejects(macKeychain({ securityBin: fake, timeoutMs: 400 }).get(), (e) => e instanceof KeychainError && e.reason === 'timeout' && /did not answer/.test(e.message));
      assert.ok(Date.now() - t0 < 5000);
    } finally { delete process.env.FAKE_MODE; }
  });
});

describe('which Keychain store (never the real one by accident)', () => {
  test('the real Keychain only for the default folder outside test runs, or with HARNESS_KEYCHAIN=mac; items scoped per folder', async () => {
    const def = await tmpDir('harness-default-');
    const other = await tmpDir('harness-other-');
    // a temp / test / custom folder: refused unless opted in — and a refused store never deletes anything
    const refused = chooseKeychain(other, { platform: 'darwin', testRun: false, kind: null, defaultDir: def });
    assert.equal(refused.kind, 'refused');
    await assert.rejects(refused.get(), (e) => e instanceof KeychainError && e.reason === 'not_allowed');
    await assert.rejects(refused.set(Buffer.alloc(32)), (e) => e.reason === 'not_allowed');
    await refused.delete();
    // the default folder in a test run: refused too
    assert.equal(chooseKeychain(def, { platform: 'darwin', testRun: true, kind: null, defaultDir: def }).kind, 'refused');
    // the default folder outside tests: the agreed item name (the native app uses it)
    const real = chooseKeychain(def, { platform: 'darwin', testRun: false, kind: null, defaultDir: def });
    assert.equal(real.kind, 'keychain');
    assert.equal(real.service, 'local.harness');
    assert.equal(real.account, KEYCHAIN_ACCOUNT);
    // explicit opt-in for another folder: a derived account, so installations never clobber each other
    const optIn = chooseKeychain(other, { platform: 'darwin', testRun: true, kind: 'mac', defaultDir: def });
    assert.equal(optIn.kind, 'keychain');
    assert.match(optIn.account, /^data-key-[0-9a-f]{16}$/);
    assert.notEqual(keychainAccountFor(other, { defaultDir: def }), keychainAccountFor(await tmpDir(), { defaultDir: def }));
    assert.equal(isDefaultDataDir(def, { defaultDir: def }), true);
    // the development stand-in, explicitly or outside macOS
    assert.equal(chooseKeychain(def, { platform: 'darwin', testRun: false, kind: 'file', defaultDir: def }).kind, 'file');
    assert.equal(chooseKeychain(other, { platform: 'linux', testRun: false, kind: null }).kind, 'file');
    // this very test process: the default choice is never the real Keychain
    assert.notEqual(chooseKeychain(other).kind, 'keychain');
  });
});


describe('the managed Ollama listens on this Mac only', () => {
  test('OLLAMA_HOST is always a loopback address (extraEnv cannot change it); a non-local address is never started', async () => {
    const { managedOllamaEnv, OllamaProcess } = await import('../server/providers/ollama-process.mjs');
    assert.equal(managedOllamaEnv({ ollama: {} }, { baseUrl: 'http://127.0.0.1:11555', totalMem: 16 * 1024 ** 3 }).OLLAMA_HOST, '127.0.0.1:11555');
    assert.equal(managedOllamaEnv({ ollama: {} }, { baseUrl: 'http://localhost:11434', totalMem: 16 * 1024 ** 3 }).OLLAMA_HOST, '127.0.0.1:11434');
    assert.equal(managedOllamaEnv({ ollama: {} }, { baseUrl: 'http://0.0.0.0:11434', totalMem: 16 * 1024 ** 3 }).OLLAMA_HOST, '127.0.0.1:11434');
    assert.equal(managedOllamaEnv({ ollama: { extraEnv: { OLLAMA_HOST: '0.0.0.0:11434', OLLAMA_DEBUG: '1' } } }, { baseUrl: 'http://127.0.0.1:11434', totalMem: 16 * 1024 ** 3 }).OLLAMA_HOST, '127.0.0.1:11434');
    const p = new OllamaProcess({ getSettings: () => ({ ollama: { binaryPath: process.execPath } }), getProvider: () => ({ baseUrl: 'http://192.168.1.20:11434', status: async () => ({ ok: false }) }), totalMem: 8 * 1024 ** 3 });
    const r = await p.start();
    assert.equal(r.code, 'not_loopback');
    assert.equal(p.managed, false);
  });
});

describe('key buffers handed out are copies', () => {
  test('every Keychain store returns a fresh Buffer from get(): wiping it never damages the stored key', async () => {
    const { appKeychain, fileKeychain } = await import('../server/security/keychain.mjs');
    const k = crypto.randomBytes(32);
    const events = [];
    const app = appKeychain({ initialKey: k, emit: (e) => events.push(e) });
    const got = await app.get();
    got.fill(0);
    assert.deepEqual(await app.get(), k, 'the app store keeps its key');
    await app.set(Buffer.alloc(32, 3));
    const g2 = await app.get(); g2.fill(0);
    assert.deepEqual(await app.get(), Buffer.alloc(32, 3));
    const dir = await tmpDir();
    const file = fileKeychain(dir);
    await file.set(k);
    (await file.get()).fill(0);
    assert.deepEqual(await file.get(), k);
  });
});

describe('what counts as this Mac (review 03)', () => {
  test('only the exact name localhost and loopback literals; *.localhost is the internet; localhost is pinned to loopback', async () => {
    const { isLoopbackHost, assertEgress, egressBlocked, registerGuard, unregisterGuard, trackConnection, closeBlockedConnections } = await import('../server/security/egress.mjs');
    const { httpRequest } = await import('../server/lib/http-client.mjs');
    for (const h of ['localhost', 'LOCALHOST', 'localhost.', '127.0.0.1', '127.8.9.10', '::1', '[::1]', '::ffff:127.0.0.1']) assert.equal(isLoopbackHost(h), true, h);
    for (const h of ['exfil.attacker.example.com.localhost', 'a.localhost', 'localhost.example.com', '10.0.0.1', '0.0.0.0', 'mylocalhost']) assert.equal(isLoopbackHost(h), false, h);
    const g = { blocked: true };
    registerGuard(g);
    const dns = (await import('node:dns')).default;
    const orig = dns.lookup;
    try {
      assert.throws(() => assertEgress('http://exfil.attacker.example.com.localhost/leak', 'model_catalog'), (e) => e.code === 'offline_lock');
      assert.equal(egressBlocked('http://a.localhost/'), true);
      await assert.rejects(httpRequest('http://exfil.attacker.example.com.localhost/leak'), (e) => e.code === 'offline_lock');
      // `localhost` resolving elsewhere (a tampered hosts file / resolver) is refused before connecting
      dns.lookup = (host, opts, cb) => { const f = typeof opts === 'function' ? opts : cb; f(null, [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]); };
      await assert.rejects(httpRequest('http://localhost:9/x', { signal: AbortSignal.timeout(3000) }), (e) => e.code === 'ELOCALHOST_NOT_LOOPBACK' || e.cause?.code === 'ELOCALHOST_NOT_LOOPBACK');
      dns.lookup = orig;
      // long-lived connections to a remote host are closed when the blocker comes back on
      g.blocked = false;
      let closed = 0;
      const untrackLocal = trackConnection('ws://127.0.0.1:8188/ws', () => { closed += 100; });
      trackConnection('ws://comfy.remote.example:8188/ws', () => { closed += 1; });
      assert.equal(closeBlockedConnections(), 0, 'nothing is closed while access is allowed');
      g.blocked = true;
      assert.equal(closeBlockedConnections(), 1);
      assert.equal(closed, 1, 'the remote socket is closed, the local one is not tracked');
      untrackLocal();
    } finally { dns.lookup = orig; unregisterGuard(g); }
  });

  test('IPv4-mapped loopback in the hex form URLs use (::ffff:7f00:1) is this Mac; the rest of ::ffff:0:0/96 is not', async () => {
    const { isLoopbackHost, isLoopbackAddress, egressBlocked, registerGuard, unregisterGuard } = await import('../server/security/egress.mjs');
    const host = new URL('http://[::ffff:127.0.0.1]:11434/').hostname;
    assert.equal(host, '[::ffff:7f00:1]', 'what the URL parser makes of it');
    for (const h of [host, '::ffff:7f00:1', '::ffff:7fff:ffff', '0:0:0:0:0:ffff:7f00:1', '::FFFF:7F00:1']) assert.equal(isLoopbackAddress(h), true, h);
    for (const h of ['::ffff:8000:1', '::ffff:7e00:1', '::ffff:a00:1', '::ffff:0:7f00:1', '::7f00:1', '::ffff:10.0.0.1']) assert.equal(isLoopbackAddress(h), false, h);
    const g = { blocked: true };
    registerGuard(g);
    try {
      assert.equal(egressBlocked('http://[::ffff:127.0.0.1]:11434/api/version'), false, 'not refused as "the internet"');
      assert.equal(egressBlocked('http://[::ffff:a00:1]/'), true);
      assert.equal(isLoopbackHost('[::ffff:7f00:1]'), true);
    } finally { unregisterGuard(g); }
  });
});

describe('instance proof and key-derivation bounds (review F6)', () => {
  test('openDataKeyWithPassword is pure; instanceProof binds the nonce and the port; out-of-range scrypt parameters are refused', async () => {
    const { openDataKeyWithPassword, instanceProof, parseNonce, proofBinding } = await import('../server/security/instance-proof.mjs');
    const { kdfWithinBounds } = await import('../server/security/crypto.mjs');
    const dir = await tmpDir();
    const v = new Vault(dir, { kdf: FAST });
    await v.create('correct horse', { state: { mode: 'password', encrypted: true, offlineLock: true, allowedUntil: null, allowFrom: null, migration: null } });
    const dek = Buffer.from(v.dek);
    v.lock();
    const before = fss.readFileSync(path.join(dir, 'vault.json'), 'utf8');
    const json = JSON.parse(before);
    const k = await openDataKeyWithPassword(json, 'correct horse');
    assert.deepEqual(k, dek);
    for (let i = 0; i < 5; i++) assert.equal(await openDataKeyWithPassword(json, `wrong ${i}`), null);
    assert.equal(fss.readFileSync(path.join(dir, 'vault.json'), 'utf8'), before, 'no throttle bookkeeping, nothing written');
    assert.equal(await openDataKeyWithPassword({ ...json, wraps: { recovery: json.wraps.recovery } }, 'correct horse'), null, 'no password wrap');
    assert.equal(await openDataKeyWithPassword({ ...json, wraps: { ...json.wraps, password: { ...json.wraps.password, kdf: { ...json.wraps.password.kdf, N: 2 ** 30 } } } }, 'correct horse'), null, 'N out of bounds: not even tried');
    // the proof: deterministic, bound to nonce and binding, under a subkey (not a MAC with the data key itself)
    const n1 = crypto.randomBytes(32);
    const n2 = crypto.randomBytes(32);
    const p = instanceProof(k, n1, proofBinding({ port: 4747 }));
    assert.equal(p.length, 32);
    assert.deepEqual(instanceProof(k, n1, 'port:4747'), p);
    assert.notDeepEqual(instanceProof(k, n2, 'port:4747'), p, 'another nonce');
    assert.notDeepEqual(instanceProof(k, n1, 'port:5555'), p, 'another port (a relay)');
    assert.notDeepEqual(instanceProof(k, n1, 'bridge'), p);
    assert.notDeepEqual(instanceProof(crypto.randomBytes(32), n1, 'port:4747'), p, 'another key');
    assert.notDeepEqual(crypto.createHmac('sha256', k).update(Buffer.concat([Buffer.from('harness-instance-proof-v1'), Buffer.from([0]), n1, Buffer.from([0]), Buffer.from('port:4747')])).digest(), p, 'a subkey, not the data key');
    assert.throws(() => instanceProof(k, crypto.randomBytes(8), 'port:4747'), RangeError);
    assert.throws(() => instanceProof(k, n1), TypeError, 'a binding is required');
    assert.throws(() => proofBinding({}), RangeError);
    assert.equal(parseNonce(n1.toString('base64url')).length, 32);
    for (const bad of [undefined, '', 'a', crypto.randomBytes(8).toString('base64url'), crypto.randomBytes(65).toString('base64url'), n1.toString('base64'), `${n1.toString('base64url')}=`]) assert.equal(parseNonce(bad), null, String(bad));
    k.fill(0);
    // bounds: production and test parameters inside; huge or odd ones outside (vault.json is a plain file)
    const salt = crypto.randomBytes(16).toString('base64');
    assert.equal(kdfWithinBounds({ name: 'scrypt', N: 2 ** 17, r: 8, p: 1, keyLen: 32, salt }), true);
    assert.equal(kdfWithinBounds({ name: 'scrypt', ...FAST, salt }), true);
    for (const bad of [{ N: 2 ** 20, r: 8, p: 1 }, { N: 2 ** 17, r: 32, p: 1 }, { N: 3000, r: 8, p: 1 }, { N: 2 ** 9, r: 8, p: 1 }, { N: 2 ** 17, r: 8, p: 9 }, { N: 2 ** 17, r: 8, p: 1, keyLen: 64 }]) assert.equal(kdfWithinBounds({ name: 'scrypt', salt, ...bad }), false, JSON.stringify(bad));
    assert.equal(kdfWithinBounds({ name: 'scrypt', N: 2 ** 17, r: 8, p: 1, salt: 'AAAA' }), false, 'a short salt');
    assert.equal(validVault({ ...json, wraps: { ...json.wraps, password: { ...json.wraps.password, kdf: { ...json.wraps.password.kdf, N: 2 ** 24 } } } }), false, 'such a key store is not taken for one');
  });
});
