// Where the keychain-mode key lives (only in "keychain" mode; never in the default password mode).
//
// macOS: a generic-password item in the login Keychain — service `local.harness`, account `data-key`,
// label `Harness data key`, value base64 of 32 random bytes — the same item the native app reads with the
// Security framework. It is driven through `/usr/bin/security -i` with the commands (and the value) written to its
// stdin, never in argv or the environment, so the key does not show up in `ps`. What this protects: other user
// accounts, a copied disk or a stolen backup. What it does not: any program running as this user can run
// `security find-generic-password` too (macOS may ask the user first, depending on the item's access list).
//
// Elsewhere (development, CI): a 0600 file `.dev-keychain` in the data directory — clearly NOT protection.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const KEYCHAIN_SERVICE = 'local.harness';
export const KEYCHAIN_ACCOUNT = 'data-key';
export const KEYCHAIN_LABEL = 'Harness data key';

const B64_32 = /^[A-Za-z0-9+/]{43}=$/;

function runSecurity(bin, commands, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, ['-i'], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { resolve({ ok: false, out: '', err: e.message }); return; }
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out, err }); });
    child.stdin.on('error', () => {});
    child.stdin.end(commands.join('\n') + '\n');
  });
}

/** The macOS login Keychain via /usr/bin/security (the binary is injectable for tests). */
export function macKeychain({ securityBin = process.env.HARNESS_SECURITY_BIN || '/usr/bin/security' } = {}) {
  const q = (s) => `"${String(s).replace(/["\\]/g, '\\$&')}"`;
  return {
    kind: 'keychain',
    async get() {
      const r = await runSecurity(securityBin, [`find-generic-password -s ${q(KEYCHAIN_SERVICE)} -a ${q(KEYCHAIN_ACCOUNT)} -w`]);
      const line = r.out.split(/\r?\n/).map((l) => l.trim().replace(/^security>\s*/, '')).find((l) => B64_32.test(l));
      return line ? Buffer.from(line, 'base64') : null;
    },
    async set(key) {
      const v = Buffer.from(key).toString('base64');
      const r = await runSecurity(securityBin, [`add-generic-password -U -s ${q(KEYCHAIN_SERVICE)} -a ${q(KEYCHAIN_ACCOUNT)} -l ${q(KEYCHAIN_LABEL)} -w ${v}`]);
      if (!r.ok && !/^\s*$/.test(r.err) && /error|could not/i.test(r.err)) throw new Error(`Could not store the key in the Keychain: ${r.err.trim().slice(0, 200)}`);
      const back = await this.get();
      if (!back || !back.equals(Buffer.from(key))) throw new Error('The Keychain did not return the stored key');
    },
    async delete() { await runSecurity(securityBin, [`delete-generic-password -s ${q(KEYCHAIN_SERVICE)} -a ${q(KEYCHAIN_ACCOUNT)}`]); },
  };
}

/** Development / non-macOS stand-in: a 0600 file next to the data. Not a protection. */
export function fileKeychain(dataDir) {
  const file = path.join(dataDir, '.dev-keychain');
  return {
    kind: 'file',
    async get() { try { const v = fs.readFileSync(file, 'utf8').trim(); return B64_32.test(v) ? Buffer.from(v, 'base64') : null; } catch { return null; } },
    async set(key) { fs.writeFileSync(file, Buffer.from(key).toString('base64') + '\n', { mode: 0o600 }); },
    async delete() { fs.rmSync(file, { force: true }); },
  };
}

/** Bridge mode: the native app keeps the item; the backend only hands it over (`keychain-key` event). */
export function appKeychain({ initialKey = null, emit }) {
  let key = initialKey ? Buffer.from(initialKey) : null;
  return {
    kind: 'app',
    async get() { return key; },
    async set(k) { key = Buffer.from(k); emit({ type: 'keychain-key', dataKey: key.toString('base64') }); },
    async delete() { key = null; emit({ type: 'keychain-key', dataKey: null }); },
  };
}

export function platformKeychain(dataDir, platform = process.platform) {
  return platform === 'darwin' ? macKeychain() : fileKeychain(dataDir);
}
