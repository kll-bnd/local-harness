// Keychain mode on the DEFAULT data folder (~/Library/Application Support/Harness — what the real user has): the app
// must use the account `data-key` there (docs/BRIDGE.md `keychain-key`). Two launches: switch to keychain mode and
// check the item; then open without a password and leave keychain mode, which deletes the item.
//
// SAFETY: run only through `run-selftest.mjs --data default --allow-default-data` on GitHub Actions. That runner
// refuses (exit 2, touching nothing) when the default data folder exists in any form or the login Keychain already
// has the item local.harness / data-key, and afterwards removes only what this run created. It cannot run on a Mac
// that has Harness data. Proven by native/test/run-selftest-guard.test.mjs.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = await native('stashAll');
  async function check(name, fn, ms = 60000) {
    const t0 = performance.now();
    let v;
    try { v = await Promise.race([fn(), sleep(ms).then(() => ({ ok: false, error: 'timeout' }))]); } catch (e) { v = { ok: false, error: String((e && e.message) || e) }; }
    v.ms = Math.round(performance.now() - t0);
    await native('result', { key: name, value: v });
  }
  const req = async (method, path, body) => {
    const init = { method, headers: {} };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    const r = await fetch(path, init);
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, body: j };
  };
  const waitFor = async (cond, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(250); } return false; };

  if (st.launches >= 2) {
    await check('defaultFolderOpensFromKeychain', async () => {
      const s = await native('state');
      const k = await native('keychain');
      return { ok: s.ready.locked === false && k.exists && k.account === 'data-key' && k.fingerprint === st.fp, readyLocked: s.ready.locked, account: k.account, sameItem: k.fingerprint === st.fp };
    });
    await check('defaultFolderLeavingKeychainModeDeletesItem', async () => {
      const r = await req('POST', '/api/security/mode', { password: st.pw, mode: 'password' });
      const gone = await waitFor(async () => !(await native('keychain')).exists);
      return { ok: r.status === 200 && gone, status: r.status, itemDeleted: gone };
    });
    await native('finish', { status: 'launch2-done' });
    return;
  }

  await check('defaultFolderUsesAccountDataKey', async () => {
    const pw = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => 'abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 55]).join('');
    await native('stash', { key: 'pw', value: pw });
    const before = await native('keychain');
    const setup = await req('POST', '/api/security/setup', { password: pw });
    await waitFor(async () => (await req('GET', '/api/security')).body?.state === 'unlocked', 60000);
    const mode = await req('POST', '/api/security/mode', { password: pw, mode: 'keychain' });
    const stored = await waitFor(async () => (await native('keychain')).exists);
    const k = await native('keychain');
    await native('stash', { key: 'fp', value: k.fingerprint });
    return { ok: !before.exists && setup.status === 200 && mode.status === 200 && stored && k.account === 'data-key', itemBefore: before.exists, setup: setup.status, mode: mode.status, account: k.account };
  });
  await native('finish', { status: 'launch1-done' });
})().catch((e) => native('result', { key: 'fatal', value: { ok: false, error: String((e && e.stack) || e) } }).then(() => native('finish', { status: 'script-error' })));
