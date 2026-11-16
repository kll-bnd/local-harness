// Runs inside the probe web view. Phase 1: no CSP; phase 2: the real UI's CSP.
const csp = !!document.querySelector('meta[http-equiv="Content-Security-Policy"]');
const R = {};
const post = (m) => window.webkit.messageHandlers.probe.postMessage(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pat = (n) => { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (Math.imul(i, 31) + 7) & 255; return u; };
const okPat = (u) => { for (let i = 0; i < u.length; i++) if (u[i] !== ((Math.imul(i, 31) + 7) & 255)) return false; return true; };

async function test(name, fn, ms = 20000) {
  const s = performance.now();
  try {
    R[name] = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  } catch (e) {
    R[name] = { error: String((e && (e.name + ': ' + e.message)) || e) };
  }
  if (R[name] && typeof R[name] === 'object') R[name].ms = Math.round(performance.now() - s);
}

async function echo(init, q = '') {
  const res = await fetch('/echo' + q, init);
  const j = await res.json();
  return { status: res.status, src: j.bodySource, len: j.bodyLength, intact: j.intact, ct: j.headers?.['Content-Type'] || j.headers?.['content-type'] || null, xf: j.headers?.['X-Filename'] || j.headers?.['x-filename'] || null, text: j.bodyText ? j.bodyText.slice(0, 80) : undefined };
}

async function readStream(url, init) {
  const res = await fetch(url, init);
  const reader = res.body.getReader();
  const times = [];
  let bytes = 0;
  const t = performance.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    times.push(Math.round(performance.now() - t));
    bytes += value.length;
  }
  return { status: res.status, ct: res.headers.get('content-type'), pieces: times.length, times: times.slice(0, 12), bytes };
}

async function phaseCommon() {
  await test('env', async () => ({
    origin: location.origin, href: location.href, secure: window.isSecureContext, uuid: typeof crypto.randomUUID,
    subtle: !!crypto.subtle, clipboard: !!navigator.clipboard, platform: navigator.platform, ua: navigator.userAgent.slice(0, 160),
  }));
  await test('postJson', () => echo({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hello: 'wörld', n: 42 }) }));
  await test('image', () => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => reject(new Error('img error')); i.src = '/image.png'; }));
  await test('dataImage', () => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve({ w: i.naturalWidth }); i.onerror = () => reject(new Error('img error')); i.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'; }));
  await test('blobImage', async () => { const b = await (await fetch('/image.png')).blob(); const u = URL.createObjectURL(b); return new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve({ w: i.naturalWidth }); i.onerror = () => reject(new Error('img error')); i.src = u; }); });
  await test('remoteImage', () => new Promise((resolve) => { const i = new Image(); i.onload = () => resolve({ loaded: true }); i.onerror = () => resolve({ loaded: false }); i.src = 'https://www.apple.com/favicon.ico?' + Date.now(); }), 10000);
  await test('remoteFetch', async () => { try { const r = await fetch('https://www.apple.com/?' + Date.now(), { mode: 'no-cors' }); return { fetched: true, type: r.type }; } catch (e) { return { fetched: false, err: String(e.message) }; } }, 10000);
  await test('streamGet', () => readStream('/stream?n=8&ms=250'));
  await test('streamPost', () => readStream('/stream?n=5&ms=200', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: '{"content":"hi"}' }));
  await test('eventSource', () => new Promise((resolve) => {
    const es = new EventSource('/events?n=3&ms=200');
    let got = 0; let errors = 0;
    es.addEventListener('tick', () => { got++; });
    es.onerror = () => { errors++; if (errors >= 2 || got >= 3) { es.close(); resolve({ got, errors, readyState: es.readyState }); } };
    setTimeout(() => { es.close(); resolve({ got, errors, readyState: es.readyState, timedOut: true }); }, 5000);
  }));
  await test('status423', async () => { const r = await fetch('/status?code=423'); return { status: r.status, ok: r.ok, statusText: r.statusText, body: (await r.json()).error.code }; });
}

async function phase1() {
  await phaseCommon();
  await test('postArrayBuffer3MB', () => echo({ method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pat(3 * 1024 * 1024).buffer }));
  await test('postUint8Array1MB', () => echo({ method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pat(1024 * 1024) }));
  await test('postBlob5MB', () => echo({ method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Blob([pat(5 * 1024 * 1024)]) }));
  await test('postFile2MB', () => echo({ method: 'POST', headers: { 'content-type': 'image/png', 'x-filename': 'a%20b.png' }, body: new File([pat(2 * 1024 * 1024)], 'a b.png', { type: 'image/png' }) }));
  await test('postBlob50MB', () => echo({ method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Blob([pat(50 * 1024 * 1024)]) }), 60000);
  await test('postArrayBuffer50MB', () => echo({ method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pat(50 * 1024 * 1024).buffer }), 60000);
  await test('postString', () => echo({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'plain text body' }));
  await test('putJson', () => echo({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"put":true}' }));
  await test('deleteNoBody', () => echo({ method: 'DELETE' }));
  await test('keepalive', () => echo({ method: 'PATCH', keepalive: true, headers: { 'content-type': 'application/json' }, body: '{"keep":"alive"}' }, '?keepalive=1'));
  await test('bigDownload20MB', async () => { const t = performance.now(); const b = new Uint8Array(await (await fetch('/big?mb=20')).arrayBuffer()); return { len: b.length, intact: okPat(b), dlms: Math.round(performance.now() - t) }; }, 60000);
  await test('cancelAbort', async () => {
    const ac = new AbortController();
    const res = await fetch('/forever', { signal: ac.signal });
    const reader = res.body.getReader();
    await reader.read();
    await reader.read();
    ac.abort();
    try { await reader.read(); } catch { /* aborted */ }
    await sleep(800);
    return await (await fetch('/cancel-status')).json();
  });
  await test('localStorage', async () => { localStorage.setItem('k', 'v'); return { v: localStorage.getItem('k') }; });
  await test('download', async () => { const a = document.createElement('a'); a.href = '/download'; a.download = 'x.txt'; document.body.append(a); a.click(); a.remove(); await sleep(1000); return { clicked: true }; });
  await test('downloadBlob', async () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['blobdata'])); a.download = 'b.txt'; document.body.append(a); a.click(); a.remove(); await sleep(1000); return { clicked: true }; });
  await test('windowOpen', async () => { const w = window.open('https://www.apple.com/', '_blank'); await sleep(500); return { returned: w === null ? 'null' : typeof w }; });
  await test('targetBlankHarness', async () => { const a = document.createElement('a'); a.href = '/image.png'; a.target = '_blank'; document.body.append(a); a.click(); a.remove(); await sleep(800); return { clicked: true }; });
  post({ kind: 'phase1', results: R });
  try { await fetch('/done', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(R) }); } catch { /* ignore */ }
  location.href = 'probe-csp.html';
}

async function phase2() {
  await phaseCommon();
  post({ kind: 'phase2', results: R });
  await sleep(300);
  location.href = 'https://www.apple.com/';
}

(csp ? phase2() : phase1()).catch((e) => post({ kind: 'fatal', error: String(e) }));
