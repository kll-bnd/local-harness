// Shared test harness: fake Ollama + real Harness server in-process, JSON + SSE clients.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFakeOllama } from './fake-ollama.mjs';
import { createFakeMemoryProbe } from './fake-memory-probe.mjs';
import { startServer } from '../server/index.mjs';
import { deepMerge } from '../server/lib/util.mjs';

process.env.HARNESS_NO_OLLAMA_AUTOSTART = '1';
// The 0.2 defaults (password-encrypted data, API sessions, internet blocked) are opted out of EXPLICITLY here
// for the suites that test other things; test/security*.test.mjs pass their own options to exercise them.
export const LEGACY_OPTS = Object.freeze({ security: { mode: 'off', apiAuth: false }, offlineLock: false });
for (const [k, v] of Object.entries({ HARNESS_ENCRYPTION: 'off', HARNESS_API_AUTH: '0', HARNESS_OFFLINE_LOCK: '0' })) process.env[k] ??= v;

export const GiB = 1024 ** 3;

export async function tmpDir(prefix = 'harness-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function parseSse(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    let type = null;
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) type = line.slice(7);
      else if (line.startsWith('data: ')) data.push(line.slice(6));
    }
    if (type && data.length) events.push({ type, ...JSON.parse(data.join('\n')) });
  }
  return events;
}

export function client(baseUrl) {
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(baseUrl + p, { method, headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
  /** POST and collect the whole SSE stream. */
  const sse = async (p, body, { signal } = {}) => {
    const res = await fetch(baseUrl + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('event-stream')) return { status: res.status, error: await res.json(), events: [] };
    const text = await res.text();
    return { status: res.status, events: parseSse(text), raw: text };
  };
  /** POST and stream SSE events to `onEvent` (returns when stream closes). */
  const sseStream = async (p, body, onEvent, { signal } = {}) => {
    const res = await fetch(baseUrl + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const all = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i + 2);
          buf = buf.slice(i + 2);
          for (const ev of parseSse(block)) { all.push(ev); await onEvent(ev); }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    }
    return all;
  };
  return {
    api,
    get: (p) => api('GET', p),
    post: (p, b) => api('POST', p, b ?? {}),
    patch: (p, b) => api('PATCH', p, b),
    put: (p, b) => api('PUT', p, b),
    del: (p) => api('DELETE', p),
    sse,
    sseStream,
  };
}

/**
 * Start fake Ollama + Harness. `settings` is merged into the initial settings.json.
 * @returns {Promise<{fake, srv, app, url, dataDir, c, restart, close}>}
 */
export async function setup({ settings = {}, system, fakeOptions = {}, dataDir, probe } = {}) {
  const fake = await startFakeOllama({ port: 0, ...fakeOptions });
  // Always a fake memory probe (deterministic on any OS; never the developer's real Ollama processes).
  const memoryProbe = probe === null ? null : probe || createFakeMemoryProbe(fake);
  // A fixed 16 GB machine unless the test says otherwise: results must not depend on the RAM of
  // whatever computer runs the suite (which model fits, and so which becomes the default, does).
  system = { totalMem: 16 * GiB, ...(system || {}), memoryProbe };
  dataDir ||= await tmpDir();
  const base = {
    providers: { builtin: { ollama: { baseUrl: fake.url } } },
    memory: { extractDelayMs: 0 },
    embeddings: { model: 'off' },
    ollama: { autoStart: false },
  };
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify(deepMerge(base, settings)));
  let srv = await startServer({ port: 0, dataDir, autodetect: false, logLevel: 'error', system, ...LEGACY_OPTS });
  const ctx = {
    fake, probe: memoryProbe, srv, app: srv.app, url: srv.url, dataDir, c: client(srv.url),
    async restart() {
      await srv.close();
      srv = await startServer({ port: 0, dataDir, autodetect: false, logLevel: 'error', system, ...LEGACY_OPTS });
      Object.assign(ctx, { srv, app: srv.app, url: srv.url, c: client(srv.url) });
      return ctx;
    },
    async close() {
      await srv.close();
      await fake.close();
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
  return ctx;
}

export async function newChat(c, body = {}) {
  const r = await c.post('/api/chats', body);
  if (r.status !== 201) throw new Error(`create chat failed: ${JSON.stringify(r.data)}`);
  return r.data.chat.id;
}

export async function send(c, chatId, content, extra = {}) {
  return c.sse(`/api/chats/${chatId}/messages`, { content, ...extra });
}

export const byType = (events, type) => events.filter((e) => e.type === type);
export const last = (events, type) => byType(events, type).at(-1);
export const text = (events) => byType(events, 'token').map((e) => e.delta).join('');

export async function waitFor(fn, { timeout = 5000, interval = 20 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}
