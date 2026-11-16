// The first chat after unlocking must not fail because the Ollama that Harness starts itself is still coming up:
// the turn waits (model_status loading / starting_ollama) and only fails when Ollama really does not start.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir, parseSse } from './helpers.mjs';
import { startServer } from '../server/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let prevAuto;
before(() => { prevAuto = process.env.HARNESS_NO_OLLAMA_AUTOSTART; process.env.HARNESS_NO_OLLAMA_AUTOSTART = '0'; });
after(() => { process.env.HARNESS_NO_OLLAMA_AUTOSTART = prevAuto; });

async function stackWithBinary(script) {
  const dir = await tmpDir('harness-ostart-');
  const binDir = await tmpDir('harness-obin-');
  const bin = path.join(binDir, 'ollama');
  await fs.writeFile(bin, script, { mode: 0o755 });
  const port = await freePort();
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({
    providers: { builtin: { ollama: { baseUrl: `http://127.0.0.1:${port}` } } }, defaultModel: { providerId: 'ollama', model: 'qwen3:4b' },
    ollama: { autoStart: true, binaryPath: bin, stopOnExit: true }, embeddings: { model: 'off' }, memory: { enabled: false }, titles: { auto: false },
  }));
  const srv = await startServer({ port: 0, dataDir: dir, autodetect: false, logLevel: 'silent', processGuards: false, security: { mode: 'off', apiAuth: false }, offlineLock: false });
  return {
    srv,
    async turn(content) {
      const c = await (await fetch(`${srv.url}/api/chats`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
      const r = await fetch(`${srv.url}/api/chats/${c.chat.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
      return { status: r.status, events: r.headers.get('content-type').includes('event-stream') ? parseSse(await r.text()) : [], body: r.headers.get('content-type').includes('json') ? await r.json() : null };
    },
    close: async () => { await srv.close(); await fs.rm(dir, { recursive: true, force: true }); await fs.rm(binDir, { recursive: true, force: true }); },
  };
}

describe('a chat while the managed Ollama starts', () => {
  test('chat sent before Ollama is up: waits for it (starting_ollama), then answers', async () => {
    const s = await stackWithBinary(`#!/bin/sh\nsleep 1\nexec "${process.execPath}" "${path.join(here, 'fake-ollama-bin.mjs')}" "$@"\n`);
    try {
      const t = await s.turn('hello there');
      assert.equal(t.status, 200, JSON.stringify(t.body));
      const types = t.events.map((e) => `${e.type}${e.reason ? `:${e.reason}` : ''}`);
      assert.equal(types[0], 'model_status:starting_ollama', types.join(' '));
      assert.ok(t.events.some((e) => e.type === 'done'), types.join(' '));
      assert.ok(!t.events.some((e) => e.type === 'error'), types.join(' '));
      assert.equal(s.srv.core.ollamaProcess.managed, true);
    } finally { await s.close(); }
  });

  test('Ollama never comes up: the turn reports why, after the bounded wait', async () => {
    const s = await stackWithBinary('#!/bin/sh\necho "Error: could not bind" >&2\nexit 1\n');
    try {
      const t0 = Date.now();
      const t = await s.turn('hello');
      const err = t.events.find((e) => e.type === 'error') || t.body?.error;
      assert.ok(err, JSON.stringify(t));
      assert.equal(err.code, 'connection_failed');
      assert.match(err.message, /Harness tried to start it: Ollama exited during start-up/);
      assert.ok(Date.now() - t0 < 25000);
    } finally { await s.close(); }
  });
});
