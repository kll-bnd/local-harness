// Self-test, real-backend half: runs inside the real Harness UI (harness://app/, served by `node server/index.mjs
// --bridge`) and drives the real backend through the same fetch() the UI uses. Password mode on a fresh data folder:
// locked until setup, a streamed chat with a real Ollama model, the marker of that chat not readable on disk, lock
// and unlock, a wrong password, the offline lock around Ollama, and keychain mode across two launches.
// The password is random, lives only in this run's stash file and is never printed.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = await native('stashAll');
  async function check(name, fn, ms = 120000) {
    const t0 = performance.now();
    let v;
    try { v = await Promise.race([fn(), sleep(ms).then(() => ({ ok: false, error: 'timeout' }))]); } catch (e) { v = { ok: false, error: String((e && e.message) || e) }; }
    v.ms = Math.round(performance.now() - t0);
    await native('result', { key: name, value: v });
    return v;
  }
  const req = async (method, path, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    const r = await fetch(path, init);
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, body: j };
  };
  const waitFor = async (cond, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(250); } return false; };
  const MODEL = { providerId: 'ollama', model: 'qwen3:0.6b' };

  async function chat(chatId, content) {
    // Right after an unlock the backend may still be starting its Ollama (503 connection_failed): retry for a while.
    let res;
    let waitedForOllamaMs = 0;
    for (const end = Date.now() + 90000; ;) {
      res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ content, model: MODEL }),
      });
      if (res.status !== 503 || Date.now() > end) break;
      await res.text();
      await sleep(2000);
      waitedForOllamaMs += 2000;
    }
    if (!res.ok) return { status: res.status, body: (await res.text()).slice(0, 200), waitedForOllamaMs };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const times = [];
    const types = {};
    let text = '';
    let buf = '';
    let napHeldDuring = null;
    const t0 = performance.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      times.push(Math.round(performance.now() - t0));
      if (times.length === 3) napHeldDuring = (await native('state')).activityHeld;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (!data) continue;
        try { const ev = JSON.parse(data); types[ev.type] = (types[ev.type] || 0) + 1; if (ev.type === 'token' && ev.delta) text += ev.delta; } catch { /* ignore */ }
      }
    }
    await sleep(500);
    const napHeldAfter = (await native('state')).activityHeld;
    return { status: res.status, pieces: times.length, firstMs: times[0], lastMs: times[times.length - 1], types, chars: text.length, napHeldDuring, napHeldAfter, waitedForOllamaMs };
  }

  // ------------------------------------------------------------------------------------------- launch 3
  if (st.launches >= 3) {
    await check('wrongKeychainKeyFallsBackToPassword', async () => {
      const s = await native('state');
      const pids = s.records.lists.backendPids || [];
      const sec = await req('GET', '/api/security');
      const before = (await req('GET', '/api/chats')).status;
      const u = await req('POST', '/api/security/unlock', { password: st.pw });
      const after = (await req('GET', '/api/chats')).status;
      return { ok: s.events.includes('fatal') && pids.length === 2 && s.ready.locked === true && before === 423 && u.status === 200 && after === 200, eventsSeen: s.events, backendStarts: pids.length, lockedAfterFallback: s.ready.locked, state: sec.body?.state, chatsBefore: before, unlock: u.status, chatsAfter: after };
    });
    await check('leavingKeychainModeDeletesItem', async () => {
      const r = await req('POST', '/api/security/mode', { password: st.pw, mode: 'password' });
      const gone = await waitFor(async () => !(await native('keychain')).exists, 15000);
      return { ok: r.status === 200 && gone, status: r.status, itemDeleted: gone };
    });
    await native('finish', { status: 'launch3-done' });
    return;
  }

  // ------------------------------------------------------------------------------------------- launch 2
  if (st.launches >= 2) {
    await check('keychainModeOpensWithoutPassword', async () => {
      const s = await native('state');
      const sec = await req('GET', '/api/security');
      const chats = await req('GET', '/api/chats');
      const k = await native('keychain');
      return { ok: s.ready.locked === false && sec.body?.state === 'unlocked' && chats.status === 200 && k.fingerprint === st.keyFingerprint, readyLocked: s.ready.locked, state: sec.body?.state, chats: chats.status, sameKeychainItem: k.fingerprint === st.keyFingerprint, keychainRead: s.records.keychainRead };
    });
    // Leave a valid but wrong key in the Keychain for launch 3.
    await native('keychainOverwrite');
    await native('finish', { status: 'launch2-done' });
    return;
  }

  // ------------------------------------------------------------------------------------------- launch 1
  await check('uiFromHarnessScheme', async () => {
    await waitFor(async () => !!document.querySelector('#app'), 10000);
    return { ok: location.href.startsWith('harness://app/') && !!document.querySelector('#app') && document.documentElement.classList.contains('desktop'), href: location.href, title: document.title };
  });

  await check('lockedUntilPasswordSetup', async () => {
    const s = await native('state');
    const sec = await req('GET', '/api/security');
    const routes = {};
    for (const p of ['/api/chats', '/api/memories', '/api/settings', '/api/ui-state', '/api/events']) routes[p] = (await req('GET', p)).status;
    const all423 = Object.values(routes).every((x) => x === 423);
    return { ok: s.ready.locked === true && sec.body?.state === 'needs_setup' && all423, readyLocked: s.ready.locked, state: sec.body?.state, mode: sec.body?.mode, transport: sec.body?.transport, routes };
  });

  const pw = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => 'abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 55]).join('');
  await native('stash', { key: 'pw', value: pw });

  await check('setupWithPassword', async () => {
    const r = await req('POST', '/api/security/setup', { password: pw });
    const ready = await waitFor(async () => (await req('GET', '/api/security')).body?.state === 'unlocked', 60000);
    const chats = await req('GET', '/api/chats');
    const s = await native('state');
    return { ok: r.status === 200 && /^HRK1-/.test(r.body?.recoveryKey || '') && ready && chats.status === 200 && s.locked === false, status: r.status, recoveryKeyShown: /^HRK1-/.test(r.body?.recoveryKey || ''), unlocked: ready, chats: chats.status, appSawUnlocked: !s.locked };
  });

  const marker = `HARNESS-MARKER-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  let chatId = null;
  await check('chatStreamsFromRealModel', async () => {
    const c = await req('POST', '/api/chats', { title: `Self-test ${marker}` });
    chatId = c.body?.chat?.id;
    const r = await chat(chatId, `Reply with the single word "ok". Do not think. ${marker}`);
    return { ok: r.status === 200 && r.pieces >= 3 && (r.types.token || 0) >= 1 && (r.types.done || 0) === 1, created: c.status, ...r };
  }, 300000);
  await native('result', { key: 'marker', value: { ok: true, marker } });

  await check('appNapHeldOnlyWhileGenerating', async () => {
    const r = await chat(chatId, `Count from one to twenty in words. ${marker}`);
    const s = await native('state');
    return { ok: r.napHeldDuring === true && r.napHeldAfter === false && s.busyCount === 0, heldWhileStreaming: r.napHeldDuring, heldAfter: r.napHeldAfter, pieces: r.pieces };
  }, 300000);

  await check('offlineLockAroundOllama', async () => {
    const net = await req('GET', '/api/network');
    const lock = net.body?.offlineLock || net.body;
    const viaHarness = await req('POST', '/api/models/pull', { model: 'all-minilm' }, { accept: 'text/event-stream' });
    const direct = await native('ollama', { path: '/api/pull', body: { model: 'all-minilm', stream: false }, timeout: 60 });
    return {
      ok: lock?.blocked === true && lock?.osEnforced === true && lock?.osScope === 'ollama' && viaHarness.status === 403 && !/"status":"success"/.test(direct.body || ''),
      blocked: lock?.blocked, osEnforced: lock?.osEnforced, osScope: lock?.osScope, pullThroughHarness: viaHarness.status, pullCode: viaHarness.body?.error?.code,
      directPullOnLoopback: `${direct.status} ${String(direct.body || direct.error).slice(0, 120)}`,
    };
  }, 120000);

  await check('allowThenBlockAgain', async () => {
    const netState = async () => { const n = await req('GET', '/api/network'); return n.body?.offlineLock || n.body || {}; };
    const ollamaUp = () => waitFor(async () => (await native('ollama', { path: '/api/version' })).status === 200, 30000);
    const allow = await req('POST', '/api/network/allow', { minutes: 5, password: pw });
    const unsandboxed = await waitFor(async () => (await netState()).osEnforced === false, 30000);
    const upA = await ollamaUp();
    const whileAllowed = await netState();
    const pulled = await native('ollama', { path: '/api/pull', body: { model: 'all-minilm', stream: false }, timeout: 240 });
    const block = await req('POST', '/api/network/block', {});
    const resandboxed = await waitFor(async () => (await netState()).osEnforced === true, 30000);
    const upB = await ollamaUp();
    const lock = await netState();
    const again = await native('ollama', { path: '/api/pull', body: { model: 'all-minilm', stream: false }, timeout: 60 });
    await native('ollama', { path: '/api/delete', body: { model: 'all-minilm' } });
    return {
      ok: allow.status === 200 && unsandboxed && upA && /"status":"success"/.test(pulled.body || '') && block.status === 200 && resandboxed && upB && lock.blocked === true && !/"status":"success"/.test(again.body || ''),
      allow: allow.status, ollamaRestartedWithoutSandbox: unsandboxed, whileAllowed: { blocked: whileAllowed.blocked, osEnforced: whileAllowed.osEnforced, osScope: whileAllowed.osScope },
      pullWhileAllowed: String(pulled.body || pulled.error).slice(0, 160), block: block.status, ollamaRestartedInSandbox: resandboxed, reBlocked: lock.blocked,
      pullAfterBlock: String(again.body || again.error).slice(0, 160),
    };
  }, 400000);

  await check('lockUnloadsAndLocks', async () => {
    // Load the model through Harness (the backend unloads what it loaded itself).
    const warm = await chat(chatId, `One word. ${marker}`);
    const before = await native('ollama', { path: '/api/ps' });
    await native('lock');
    const locked = await waitFor(async () => (await native('state')).locked === true, 15000);
    const chats = await req('GET', '/api/chats');
    await sleep(1500);
    const ps = await native('ollama', { path: '/api/ps' });
    let models = null;
    try { models = JSON.parse(ps.body).models.map((m) => m.name); } catch { /* not JSON */ }
    const s = await native('state');
    return { ok: warm.status === 200 && locked && chats.status === 423 && Array.isArray(models) && models.length === 0 && !s.lockMenuEnabled && s.badge === '', appLocked: locked, chats: chats.status, modelsBefore: (before.body || '').includes('qwen3') ? 'loaded' : 'none', modelsAfterLock: models, lockMenuDisabled: !s.lockMenuEnabled };
  });

  await check('wrongPasswordRejected', async () => {
    const r = await req('POST', '/api/security/unlock', { password: `${pw}x` });
    const still = await req('GET', '/api/chats');
    return { ok: r.status === 401 && r.body?.error?.code === 'wrong_password' && still.status === 423, status: r.status, code: r.body?.error?.code, stillLocked: still.status === 423 };
  });

  await check('unlockThenChatAgain', async () => {
    const r = await req('POST', '/api/security/unlock', { password: pw });
    const unlocked = await waitFor(async () => (await native('state')).locked === false, 15000);
    const list = await req('GET', '/api/chats');
    const found = (list.body?.chats || []).some((c) => c.id === chatId);
    const again = await chat(chatId, `Again, one word please. ${marker}`);
    return { ok: r.status === 200 && unlocked && found && again.status === 200 && (again.types.done || 0) === 1, status: r.status, appSawUnlocked: unlocked, chatStillThere: found, stream: again };
  }, 300000);

  await check('attachmentUploadAndImageShown', async () => {
    // A real PNG (4×3 px) uploaded as a File (the app's fetch shim sends its bytes), then shown from harness://.
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGM4EaABRww4OQAsNg8BoqhHXQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const file = new File([png], 'pixel.png', { type: 'image/png' });
    const up = await fetch(`/api/attachments?name=pixel.png&chatId=${encodeURIComponent(chatId)}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: file });
    const a = (await up.json()).attachment;
    const shown = await new Promise((resolve) => { const i = new Image(); i.onload = () => resolve({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => resolve(null); i.src = `/api/attachments/${encodeURIComponent(a?.id)}/content`; document.body.append(i); });
    return { ok: up.status === 201 && a?.size === png.length && shown?.w === 4 && shown?.h === 3, status: up.status, size: a?.size, shown };
  });

  await check('chatExportSavedThroughBridge', async () => {
    const wait = native('awaitDownload');
    const a = document.createElement('a');
    a.href = `/api/chats/${encodeURIComponent(chatId)}/export?format=markdown`;
    a.download = 'chat.md';
    document.body.append(a);
    a.click();
    a.remove();
    const d = await wait;
    return { ok: !d.error && /\.md$/.test(d.name || '') && d.size > 50, download: { name: d.name, size: d.size, error: d.error } };
  });

  await check('sleepAndScreenLockLock', async () => {
    await native('sleep');
    const a = await waitFor(async () => (await native('state')).locked === true, 15000);
    await req('POST', '/api/security/unlock', { password: pw });
    await waitFor(async () => (await native('state')).locked === false, 15000);
    await native('screenLock');
    const b = await waitFor(async () => (await native('state')).locked === true, 15000);
    await req('POST', '/api/security/unlock', { password: pw });
    const back = await waitFor(async () => (await native('state')).locked === false, 15000);
    return { ok: a && b && back, lockedOnSleep: a, lockedOnScreenLock: b, unlockedAgain: back };
  });

  await check('switchToKeychainMode', async () => {
    const r = await req('POST', '/api/security/mode', { password: pw, mode: 'keychain' });
    const stored = await waitFor(async () => (await native('keychain')).exists, 15000);
    const k = await native('keychain');
    await native('stash', { key: 'keyFingerprint', value: k.fingerprint });
    const s = await native('state');
    return { ok: r.status === 200 && stored && s.records.keychainStore === 0, status: r.status, mode: r.body?.mode, itemCreated: stored, storeStatus: s.records.keychainStore };
  });

  await native('finish', { status: 'launch1-done' });
})().catch((e) => native('result', { key: 'fatal', value: { ok: false, error: String((e && e.stack) || e) } }).then(() => native('finish', { status: 'script-error' })));
