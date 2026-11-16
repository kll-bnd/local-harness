// Self-test, transport half: runs inside the real Harness.app's page (served by native/test/mock-backend.mjs) and
// drives the real app through window.native(op, args) (native/Sources/SelfTest.swift). Two launches on one data dir:
// launch 1 checks the transport, the page contract, menus, windows, locks, downloads and the Keychain hand-over;
// launch 2 checks that the Keychain item from launch 1 is read again and sent to the backend.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = await native('stashAll');
  const R = {};
  async function check(name, fn, ms = 30000) {
    const t0 = performance.now();
    let v;
    try { v = await Promise.race([fn(), sleep(ms).then(() => ({ ok: false, error: 'timeout' }))]); } catch (e) { v = { ok: false, error: String((e && e.message) || e) }; }
    v.ms = Math.round(performance.now() - t0);
    R[name] = v;
    await native('result', { key: name, value: v });
    return v;
  }
  const pat = (n) => { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (Math.imul(i, 31) + 7) & 255; return u; };
  const post = (path, body, headers = { 'content-type': 'application/json' }) => fetch(path, { method: 'POST', headers, body });
  const jpost = async (path, o) => (await post(path, JSON.stringify(o))).json();
  const emit = (o) => jpost('/api/mock/emit', o);
  const menuSeen = [];
  if (window.harnessDesktop) window.harnessDesktop.onMenuAction((a) => menuSeen.push(a));

  if (st.launches >= 2) {
    // ------------------------------------------------------------------------------- launch 2: Keychain reuse
    await check('keychainReusedOnSecondLaunch', async () => {
      const h = await (await fetch('/api/mock/hello')).json();
      const k = await native('keychain');
      return { ok: h.keySent && h.keyMatches && k.exists && k.fingerprint === st.keyFingerprint, keySent: h.keySent, keyMatches: h.keyMatches, sameFingerprint: k.fingerprint === st.keyFingerprint };
    });
    await check('keychainDeletedWhenModeOff', async () => {
      await emit({ type: 'keychain-key' });
      await sleep(500);
      const k = await native('keychain');
      return { ok: !k.exists, exists: k.exists };
    });
    await native('finish', { status: 'launch2-done' });
    return;
  }

  if (st.phase === 'restarting') {
    // ------------------------------------------------------------------- after restart-required (same launch)
    await check('restartRequiredHandled', async () => {
      const s = await native('state');
      const pids = s.records.lists.backendPids || [];
      return { ok: pids.length >= 2 && pids[0] !== pids[pids.length - 1] && location.hash === st.hash && s.backendRunning, backendStarts: pids.length, sameRoute: location.hash === st.hash, pageLoads: s.records.pageLoads };
    });
    await native('stash', { key: 'phase', value: 'after-restart' });
    await native('finish', { status: 'launch1-done' });
    return;
  }

  // ------------------------------------------------------------------------------------- launch 1
  await check('uiFromHarnessScheme', async () => ({ ok: location.href.startsWith('harness://app/') && document.title === 'Harness mock', href: location.href, secure: isSecureContext }));

  await check('pageContract', async () => {
    const d = window.harnessDesktop;
    const cls = [...document.documentElement.classList];
    let threw = false;
    try { d.onMenuAction('nope'); } catch (e) { threw = e instanceof TypeError; }
    return {
      ok: !!d && Object.isFrozen(d) && d.platform === 'darwin' && typeof d.appVersion === 'string' && d.appVersion.length > 0 && cls.includes('desktop') && cls.includes('desktop-mac') && threw
        && ['onMenuAction', 'openExternal', 'showInFolder', 'setBadge'].every((k) => typeof d[k] === 'function'),
      classes: cls, appVersion: d && d.appVersion, typeErrorOnBadCallback: threw,
    };
  });

  await check('classesSurviveClassNameOverwrite', async () => {
    document.documentElement.className = 'something-else';
    await sleep(50);
    const cls = [...document.documentElement.classList];
    return { ok: cls.includes('desktop') && cls.includes('desktop-mac'), classes: cls };
  });

  await check('jsonRoundTrip', async () => {
    const sent = { marker: 'round-trip ✓ ü', n: 42, nested: { a: [1, 2, 3] } };
    const r = await jpost('/api/echo', sent);
    return { ok: r.method === 'POST' && r.bodyText === JSON.stringify(sent) && r.headers['content-type'] === 'application/json', bodyLength: r.bodyLength };
  });

  await check('streamArrivesInPieces', async () => {
    const res = await post('/api/stream?n=6&ms=300', '{}', { 'content-type': 'application/json', accept: 'text/event-stream' });
    const reader = res.body.getReader();
    const times = [];
    const t0 = performance.now();
    for (;;) { const { done } = await reader.read(); if (done) break; times.push(Math.round(performance.now() - t0)); }
    return { ok: times.length >= 5 && times[times.length - 1] - times[0] >= 1000, pieces: times.length, times, contentType: res.headers.get('content-type') };
  });

  for (const [name, mk, len] of [
    ['postArrayBuffer5MB', (n) => pat(n).buffer, 5 * 1024 * 1024],
    ['postBlob5MBViaShim', (n) => new Blob([pat(n)], { type: 'application/octet-stream' }), 5 * 1024 * 1024],
    ['postFile50MBViaShim', (n) => new File([pat(n)], 'big.bin', { type: 'application/octet-stream' }), 50 * 1024 * 1024],
  ]) {
    await check(name, async () => {
      const t = performance.now();
      const r = await (await fetch('/api/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: mk(len) })).json();
      return { ok: r.length === len && r.pattern === true, length: r.length, intact: r.pattern, uploadMs: Math.round(performance.now() - t) };
    }, 90000);
  }

  await check('filePickerAndUpload', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    document.body.append(input);
    const picked = new Promise((resolve) => input.addEventListener('change', () => resolve([...input.files]), { once: true }));
    input.click();
    const files = await Promise.race([picked, sleep(5000).then(() => [])]);
    input.remove();
    if (!files.length) return { ok: false, error: 'no files from the open panel' };
    const f = files[0];
    const r = await (await fetch('/api/upload', { method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream' }, body: f })).json();
    return { ok: r.length === f.size && r.pattern === true, name: f.name, size: f.size, received: r.length, intact: r.pattern };
  }, 60000);

  await check('imageShown', () => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ ok: img.naturalWidth === 4 && img.naturalHeight === 3, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ ok: false, error: 'image failed' });
    img.src = '/api/image.png';
    document.body.append(img);
  }));

  await check('cancelStopsBackendStream', async () => {
    const ac = new AbortController();
    const res = await fetch('/api/forever?ms=100', { signal: ac.signal });
    const reader = res.body.getReader();
    await reader.read();
    const t = Date.now();
    ac.abort();
    try { await reader.read(); } catch { /* aborted */ }
    await sleep(700);
    const s = await (await fetch('/api/cancel-status')).json();
    const c = s.cancelled.find((x) => x.path.startsWith('/api/forever'));
    return { ok: !!c, backendSawCancelAfterMs: c ? c.at - t : null };
  });

  await check('menuAccelerators', async () => {
    const m = await native('menuItems');
    const want = {
      'new-chat': 'cmd+n', 'import-chat': 'cmd+o', 'export-chat': 'shift+cmd+e', 'open-settings': 'cmd+,', 'search-chats': 'cmd+f',
      'command-palette': 'cmd+k', 'toggle-sidebar': 'ctrl+cmd+s', 'toggle-inspector': 'alt+cmd+i', 'open-models': 'cmd+1',
      'open-images': 'cmd+2', 'open-memory': 'cmd+3', 'focus-composer': 'cmd+l', 'stop-generation': 'cmd+.', 'show-shortcuts': 'cmd+/', lock: 'ctrl+cmd+l',
    };
    const wrong = Object.entries(want).filter(([a, k]) => m.actions[a] !== k).map(([a]) => `${a}=${m.actions[a]}`);
    return { ok: wrong.length === 0 && Object.keys(m.actions).length === 15, wrong, menus: m.menus, dock: m.dock };
  });

  await check('everyMenuActionReachesPage', async () => {
    menuSeen.length = 0;
    const actions = ['new-chat', 'import-chat', 'export-chat', 'open-settings', 'search-chats', 'command-palette', 'toggle-sidebar', 'toggle-inspector',
      'open-models', 'open-images', 'open-memory', 'focus-composer', 'stop-generation', 'show-shortcuts', 'lock'];
    for (const a of actions) { await native('menu', { action: a }); await sleep(30); }
    await sleep(300);
    const missing = actions.filter((a) => !menuSeen.includes(a));
    const c = (await (await fetch('/api/mock/hello')).json()).controls;
    await emit({ type: 'unlocked' });
    await sleep(200);
    return { ok: missing.length === 0 && c.includes('lock'), received: menuSeen.length, missing, lockControlSent: c.includes('lock') };
  });

  await check('keyEquivalentsGoToMenuFirst', async () => {
    menuSeen.length = 0;
    const keys = [];
    const onKey = (e) => keys.push(`${e.metaKey ? 'cmd+' : ''}${e.key}`);
    document.addEventListener('keydown', onKey, true);
    await native('key', { key: 'n', mods: ['cmd'] });
    await native('key', { key: 'k', mods: ['cmd'] });
    await native('key', { key: 's', mods: ['ctrl', 'cmd'] });
    await sleep(300);
    document.removeEventListener('keydown', onKey, true);
    return { ok: menuSeen.includes('new-chat') && menuSeen.includes('command-palette') && menuSeen.includes('toggle-sidebar') && keys.length === 0, actions: menuSeen.slice(), pageKeydowns: keys };
  });

  await check('externalNavigationBlocked', async () => {
    const before = location.href;
    const click = (href, target) => { const a = document.createElement('a'); a.href = href; if (target) a.target = target; document.body.append(a); a.click(); a.remove(); };
    window.open('https://example.com/from-window-open', '_blank');
    await sleep(400);
    click('https://example.com/from-link');
    await sleep(400);
    click('https://example.com/from-blank-link', '_blank');
    await sleep(400);
    const okHttp = await window.harnessDesktop.openExternal('https://example.com/api');
    const noFile = await window.harnessDesktop.openExternal('file:///etc/passwd');
    const noJs = await window.harnessDesktop.openExternal('javascript:alert(1)');
    const noData = await window.harnessDesktop.openExternal('data:text/html,hi');
    const s = await native('state');
    const opened = s.records.lists.openExternal || [];
    return {
      ok: location.href === before && okHttp === true && !noFile && !noJs && !noData && opened.includes('https://example.com/from-link') && opened.includes('https://example.com/from-blank-link'),
      stayed: location.href === before, opened, windowOpenReachedApp: opened.includes('https://example.com/from-window-open'), rejected: { file: !noFile, js: !noJs, data: !noData },
    };
  });

  await check('remoteSubresourcesBlocked', async () => {
    const img = await new Promise((resolve) => { const i = new Image(); i.onload = () => resolve('loaded'); i.onerror = () => resolve('blocked'); i.src = `https://www.apple.com/favicon.ico?${Date.now()}`; });
    let f;
    try { await fetch(`https://www.apple.com/?${Date.now()}`, { mode: 'no-cors' }); f = 'loaded'; } catch { f = 'blocked'; }
    let ws;
    try { const w = new WebSocket('wss://echo.websocket.org/'); ws = await new Promise((resolve) => { w.onopen = () => resolve('open'); w.onerror = () => resolve('blocked'); setTimeout(() => resolve('timeout'), 4000); }); } catch { ws = 'blocked'; }
    return { ok: img === 'blocked' && f === 'blocked' && ws !== 'open', image: img, fetch: f, websocket: ws };
  });

  await check('showInFolderValidation', async () => {
    const d = window.harnessDesktop;
    const inside = await d.showInFolder('logs');
    const up = await d.showInFolder('../../../etc/passwd');
    const abs = await d.showInFolder('/etc/hosts');
    const missing = await d.showInFolder('no-such-file');
    return { ok: inside && !up && !abs && !missing, inside, rejected: { dotdot: !up, absolute: !abs, missing: !missing } };
  });

  await check('dockBadge', async () => {
    const d = window.harnessDesktop;
    const a = await d.setBadge('3');
    const s1 = (await native('state')).badge;
    const b = await d.setBadge(7.9);
    const s2 = (await native('state')).badge;
    const c = await d.setBadge('  a\u0007bcdefghijklmnopq ');
    const s3 = (await native('state')).badge;
    await d.setBadge('');
    const s4 = (await native('state')).badge;
    return { ok: a && s1 === '3' && b && s2 === '7' && c && s3 === 'abcdefghijkl' && s4 === '', values: [s1, s2, s3, s4] };
  });

  await check('fullScreenClass', async () => {
    const has = () => document.documentElement.classList.contains('desktop-fullscreen');
    const waitClass = async (want) => { for (let i = 0; i < 40; i++) { if (has() === want) return true; await sleep(100); } return false; };
    const on = await native('fullscreen', { on: true });
    const clsOn = await waitClass(true);
    const off = await native('fullscreen', { on: false });
    const clsOff = await waitClass(false);
    await sleep(800);
    return { ok: on.ok && clsOn && off.ok && clsOff, entered: on.ok, classWhileFull: clsOn, classRemovedAfter: clsOff };
  });

  await check('hideOnCloseAndReopen', async () => {
    const closed = await native('closeWindow');
    const s = await native('state');
    const reopened = await native('reopen');
    return { ok: closed.visible === false && s.backendRunning && reopened.visible === true, closed, reopened };
  });

  await check('globalShortcut', async () => {
    const s = await native('state');
    const hidden = await native('hotkey');
    const back = await native('unhide');
    return { ok: /^registered/.test(s.hotKey) && back.visible, status: s.hotKey, afterToggle: hidden, afterUnhide: back };
  });

  await check('titlebarClickReachesPage', async () => {
    const b = document.createElement('button');
    b.textContent = 'tb';
    b.style.cssText = 'position:fixed;left:180px;top:4px;width:60px;height:24px;z-index:99999';
    let clicked = false;
    b.addEventListener('click', () => { clicked = true; });
    document.body.append(b);
    await native('click', { x: 200, y: 12 });
    await sleep(200);
    b.remove();
    const s = await native('state');
    return { ok: clicked, clicked, titlebarHeight: s.titlebarHeight };
  });

  await check('passwordFieldUsesSecureInput', async () => {
    const i = document.createElement('input');
    i.type = 'password';
    i.autocomplete = 'current-password';
    document.body.append(i);
    i.focus();
    await sleep(300);
    const s = await native('state');
    i.remove();
    return { ok: s.secureInput === true, secureInput: s.secureInput, spellcheck: i.spellcheck };
  });

  await check('downloadThroughSavePanel', async () => {
    const a = document.createElement('a');
    a.href = '/api/download';
    a.download = 'fallback-name.md';
    document.body.append(a);
    const wait = native('awaitDownload');
    a.click();
    a.remove();
    const d = await wait;
    return { ok: d.name === 'chat export.md' && d.size === 11000 && !d.error, download: d };
  });

  await check('blobDownload', async () => {
    const wait = native('awaitDownload');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['made in the page']));
    a.download = 'page-made.txt';
    document.body.append(a);
    a.click();
    a.remove();
    const d = await wait;
    return { ok: d.name === 'page-made.txt' && d.size === 16, download: d };
  });

  await check('lockTriggers', async () => {
    await native('sleep');
    await sleep(300);
    const s1 = await native('state');
    await emit({ type: 'unlocked' });
    await native('screenLock');
    await sleep(300);
    const c = (await (await fetch('/api/mock/hello')).json()).controls.filter((x) => x === 'lock').length;
    const locked = await fetch('/api/echo', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    await emit({ type: 'unlocked' });
    await sleep(200);
    const s2 = await native('state');
    return { ok: c >= 3 && s1.locked && !s1.lockMenuEnabled && s1.badge === '' && locked.status === 423 && !s2.locked && s2.lockMenuEnabled, lockControls: c, lockedAfterSleep: s1.locked, menuDisabledWhileLocked: !s1.lockMenuEnabled, status423: locked.status === 423 };
  });

  await check('keychainItemCreated', async () => {
    await emit({ type: 'keychain-key', random: true });
    await sleep(800);
    const k = await native('keychain');
    await native('stash', { key: 'keyFingerprint', value: k.fingerprint });
    return { ok: k.exists && typeof k.fingerprint === 'string', exists: k.exists };
  });

  // Last in launch 1: the backend asks for a restart; the page reloads on the same route and the script resumes.
  location.hash = '#/chat/selftest';
  await native('stash', { key: 'hash', value: location.hash });
  await native('stash', { key: 'phase', value: 'restarting' });
  await emit({ type: 'restart-required', reason: 'offline_lock' });
})().catch((e) => native('result', { key: 'fatal', value: { ok: false, error: String(e && e.stack || e) } }).then(() => native('finish', { status: 'script-error' })));
