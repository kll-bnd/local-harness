// "Block all internet access" (docs/API.md 10.6): one switch, on by default. The chat never mentions it; the
// title bar carries a small shield (blocked, or allowed for mm:ss with "Block now"), and anything that needs the
// internet answers 403 offline_lock with everything a single "Allow internet for 15 minutes" prompt needs —
// after which the action is retried by itself.
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import * as api from '../api.js';
import { store } from '../state.js';
import { openPopover, toast, confirmDialog } from '../ui/overlays.js';
import { confirmWithPassword, fmtWait } from '../security-ui.js';
import { navigate } from '../router.js';

const DEFAULT_ALLOW = { method: 'POST', path: '/api/network/allow', body: { minutes: 15 }, needsPassword: true, label: 'Allow internet for 15 minutes' };

// ------------------------------------------------------------------------------------------------ status
export function applyNetworkStatus(ol) {
  if (!ol || typeof ol !== 'object') return;
  store.set('network', { ...ol, receivedAt: Date.now() });
}

/** → { state: 'blocked' | 'allowed' | 'off' | 'unknown', leftMs } */
export function networkState(ol = store.get('network')) {
  if (!ol) return { state: 'unknown', leftMs: 0 };
  if (!ol.enabled) return { state: 'off', leftMs: 0 };
  if (ol.blocked) return { state: 'blocked', leftMs: 0 };
  const left = ol.allowedUntil ? new Date(ol.allowedUntil).getTime() - Date.now() : 0;
  return { state: 'allowed', leftMs: Math.max(0, left), waitingFor: ol.waitingFor || null };
}

let clock = null;
let refreshedAfterExpiry = false;
/** While internet access is allowed, tick once a second (no requests) so the countdown stays live. */
export function startNetworkClock() {
  const sync = () => {
    const s = networkState();
    if (s.state === 'allowed') {
      if (!clock) clock = setInterval(tick, 1000);
      refreshedAfterExpiry = false;
    } else if (clock) { clearInterval(clock); clock = null; }
  };
  const tick = () => {
    const s = networkState();
    if (s.state !== 'allowed') { sync(); return; }
    if (s.leftMs <= 0 && !s.waitingFor && !refreshedAfterExpiry) {
      // The backend re-blocks by itself at allowedUntil; ask once for the new status.
      refreshedAfterExpiry = true;
      api.network.get().then(applyNetworkStatus).catch(() => {});
    }
    store.set('networkTick', Date.now());
  };
  store.on('network', sync);
  sync();
}

// ------------------------------------------------------------------------------------------------ explaining
const WHAT = {
  model_catalog: 'Browsing models online needs the internet.',
  model_download: 'Downloading a model needs the internet.',
  fetch_url: 'Reading a web page needs the internet.',
  remote_provider: 'This model runs on a server outside this Mac.',
  remote_image_provider: 'This image service runs outside this Mac.',
  other: 'This needs the internet.',
};

export function describeWhat(details) {
  const base = WHAT[details?.what] || WHAT.other;
  return details?.host && !['model_catalog', 'model_download'].includes(details?.what) ? `${base} (${details.host})` : base;
}

const SCOPE = {
  backend: 'macOS also keeps all of Harness in a sandbox without internet access.',
  ollama: 'macOS also keeps the Ollama that Harness started in a sandbox without internet access.',
  none: 'Harness blocks it in its own code; no macOS sandbox is in force.',
};

export function scopeSentence(ol) {
  if (!ol) return '';
  let s = ol.osEnforced ? (SCOPE[ol.osScope] || SCOPE.none) : SCOPE.none;
  if (ol.externalOllama) s += ' The Ollama in use was not started by Harness, so Harness cannot confine it — only what Harness itself sends is blocked.';
  return s;
}

// ------------------------------------------------------------------------------------------------ allow prompt
let pendingPrompt = null;

/**
 * Show the one "Allow internet for 15 minutes" prompt for an offline_lock answer (details from the error).
 * Concurrent callers share the same prompt. → true when internet access is now allowed.
 */
export function requestInternet(details = {}) {
  if (pendingPrompt) return pendingPrompt;
  const allow = { ...DEFAULT_ALLOW, ...(details.allow || {}) };
  const minutes = allow.body?.minutes || 15;
  const send = async (password) => {
    const r = await api.call(allow.method, allow.path, { ...(allow.body || {}), ...(password ? { password } : {}) });
    if (r?.offlineLock) applyNetworkStatus(r.offlineLock);
    if (r?.restartRequired) {
      toast({ kind: 'warn', message: 'Harness needs to restart to go online', detail: 'All of Harness runs in the macOS offline sandbox. Quit Harness and open it again; internet access stays allowed for the time you chose.', timeout: 0, id: 'net-restart' });
    }
    return !r?.restartRequired;
  };
  const message = `${describeWhat(details)} Internet access is blocked in Harness.`;
  const note = h('p.field-help', `Harness blocks it again by itself after ${minutes} minutes. Chat and everything on this Mac keep working either way.`);
  pendingPrompt = (async () => {
    try {
      if (allow.needsPassword === false) {
        const ok = await confirmDialog({ title: `${allow.label}?`, message: `${message} ${note.textContent}`, confirmLabel: allow.label });
        return ok ? await send(null) : false;
      }
      const r = await confirmWithPassword({ title: `${allow.label}?`, message, body: note, confirmLabel: allow.label, run: send });
      return r === true;
    } finally { pendingPrompt = null; }
  })();
  return pendingPrompt;
}

const isOfflineLock = (e) => e instanceof api.ApiError && e.code === 'offline_lock';

/**
 * Run fn(); when it is refused with offline_lock, ask once and run it again. A declined prompt rejects with
 * the original error marked `quiet` (callers that show errors skip it).
 */
export async function withInternet(fn) {
  try { return await fn(); } catch (e) {
    if (!isOfflineLock(e)) throw e;
    const ok = await requestInternet(e.details || {});
    if (!ok) { e.quiet = true; throw e; }
    return fn();
  }
}

/**
 * The same prompt in place (e.g. in a catalogue list): explanation, password and the allow button.
 * onAllowed() runs after access was granted.
 */
export function allowPanel(details, { onAllowed, title = 'Internet access is blocked' } = {}) {
  const allow = { ...DEFAULT_ALLOW, ...(details?.allow || {}) };
  const minutes = allow.body?.minutes || 15;
  const btn = h('button.btn.btn-primary', { type: 'button', on: { click: async () => {
    const ok = await requestInternet(details || {});
    if (ok) onAllowed?.();
  } } }, icon('globe', { size: 14 }), allow.label);
  return h('div.allow-panel', { role: 'region', attrs: { 'aria-label': title } },
    h('div.allow-icon', icon('shieldCheck', { size: 22 })),
    h('div.allow-body',
      h('h3.allow-title', title),
      h('p.allow-text', `${describeWhat(details)} Harness keeps everything on this Mac until you allow it, and blocks it again after ${minutes} minutes.`),
      h('div.row', btn, h('button.btn.btn-ghost', { type: 'button', on: { click: () => navigate('/settings/privacy') } }, 'Internet settings'))));
}

// ------------------------------------------------------------------------------------------------ actions
export async function blockNow() {
  try {
    const r = await api.network.block();
    if (r?.offlineLock) applyNetworkStatus(r.offlineLock);
    toast({ kind: 'success', message: 'Internet access is blocked again', id: 'net', timeout: 2500 });
  } catch (e) { toast({ kind: 'error', message: "Couldn't block internet access", detail: e.message, id: 'net' }); }
}

export async function allowFor(minutes = 15) {
  return requestInternet({ what: 'other', allow: { ...DEFAULT_ALLOW, body: { minutes }, label: minutes === 15 ? DEFAULT_ALLOW.label : `Allow internet for ${minutes} minutes` } }).then((ok) => {
    if (ok) toast({ kind: 'success', message: `Internet allowed for ${minutes} minutes`, id: 'net', timeout: 2500 });
    return ok;
  });
}

/** Turn the blocker itself on (no password) or off (password). */
export async function setBlocker(enabled) {
  if (enabled) {
    const r = await api.network.setEnabled(true);
    if (r?.offlineLock) applyNetworkStatus(r.offlineLock);
    return true;
  }
  const r = await confirmWithPassword({
    title: 'Stop blocking internet access?',
    message: 'Harness and the models it starts will be able to reach the internet at any time, not only for downloads you allow.',
    confirmLabel: 'Stop blocking',
    danger: true,
    run: (password) => api.network.setEnabled(false, { password }),
  });
  if (r?.offlineLock) applyNetworkStatus(r.offlineLock);
  return !!r;
}

/** "Check that nothing can get out" → plain-language lines per layer. */
export async function selfTest() {
  const r = await api.network.test();
  const lines = (r.results || []).map((x) => {
    const layer = x.layer === 'os' ? 'macOS sandbox' : x.layer === 'code' ? 'Harness itself' : x.layer;
    let text;
    if (x.result === 'blocked') text = x.layer === 'os' ? `stopped a connection to ${x.target}.` : `refused to connect to ${x.target}.`;
    else if (x.result === 'reachable') text = `a connection to ${x.target} got through.`;
    else text = x.layer === 'os' ? 'not tested — no macOS sandbox covers this part of Harness here.' : 'not tested.';
    return { layer, result: x.result, text, detail: x.detail || '' };
  });
  return { blocked: !!r.blocked, lines };
}

// ------------------------------------------------------------------------------------------------ title bar
/** The always-visible shield in the title bar. */
export function shieldButton() {
  const btn = h('button.net-shield', { type: 'button' });
  const blockBtn = h('button.btn.btn-small.net-block', { type: 'button', on: { click: (e) => { e.stopPropagation(); blockNow(); } } }, 'Block now');
  const el = h('span.net-shield-wrap', btn, blockBtn);
  const render = () => {
    const ol = store.get('network');
    const s = networkState(ol);
    el.dataset.state = s.state;
    el.hidden = s.state === 'unknown';
    blockBtn.hidden = s.state !== 'allowed';
    let label;
    let text = null;
    if (s.state === 'blocked') {
      label = 'Internet access is blocked';
      mount(btn, icon('shieldCheck', { size: 15 }));
    } else if (s.state === 'allowed') {
      label = s.waitingFor ? 'Internet allowed until the download finishes' : `Internet allowed for ${fmtWait(s.leftMs)}`;
      text = s.waitingFor ? 'Online until done' : `Online ${fmtClock(s.leftMs)}`;
      mount(btn, icon('globe', { size: 15 }), h('span.net-text', text));
    } else {
      label = 'Internet access is not blocked';
      mount(btn, icon('shieldOff', { size: 15 }), h('span.net-text', 'Not blocked'));
    }
    btn.title = label;
    btn.setAttribute('aria-label', label);
  };
  btn.addEventListener('click', () => openShieldPopover(btn));
  store.on('network', render);
  store.on('networkTick', render);
  render();
  return el;
}

const fmtClock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function openShieldPopover(anchor) {
  const ol = store.get('network');
  const s = networkState(ol);
  const until = ol?.allowedUntil ? new Date(ol.allowedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  let pop;
  const close = () => pop?.close?.();
  const body = h('div.net-pop',
    h('div.net-pop-head', icon(s.state === 'blocked' ? 'shieldCheck' : s.state === 'allowed' ? 'globe' : 'shieldOff', { size: 18 }),
      h('strong', s.state === 'blocked' ? 'Internet access is blocked' : s.state === 'allowed' ? (s.waitingFor ? 'Online until the download finishes' : `Online until ${until}`) : 'Internet access is not blocked')),
    h('p.net-pop-text', s.state === 'blocked'
      ? 'Nothing in Harness can reach the internet. Chat, memory, documents and local image generation work as usual.'
      : s.state === 'allowed'
        ? 'Model downloads and the online catalogue work now. Harness blocks internet access again by itself.'
        : 'Harness and the models it starts can reach the internet. Turn blocking back on in Privacy & security.'),
    ol ? h('p.net-pop-scope.faint', scopeSentence(ol)) : null,
    h('div.row.net-pop-actions',
      s.state === 'blocked' ? h('button.btn.btn-small', { type: 'button', on: { click: () => { close(); allowFor(15); } } }, 'Allow for 15 minutes…') : null,
      s.state === 'allowed' ? h('button.btn.btn-small.btn-primary', { type: 'button', on: { click: () => { close(); blockNow(); } } }, 'Block now') : null,
      s.state === 'off' ? h('button.btn.btn-small.btn-primary', { type: 'button', on: { click: async () => { close(); try { await setBlocker(true); toast({ kind: 'success', message: 'Internet access is blocked', id: 'net', timeout: 2000 }); } catch (e) { toast({ kind: 'error', message: "Couldn't turn blocking on", detail: e.message }); } } } }, 'Block all internet access') : null,
      h('span.spacer'),
      h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: () => { close(); navigate('/settings/privacy'); } } }, 'Settings')),
  );
  pop = openPopover(anchor, body, { placement: 'bottom-end', label: 'Internet access' });
}
