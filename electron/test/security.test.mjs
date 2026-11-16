// Desktop shell: URL allow-listing, IPC argument validation, permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const s = require('../lib/security.cjs');
const ORIGIN = 'http://127.0.0.1:4747';

test('navigation is locked to the local server origin', () => {
  assert.equal(s.navigationDecision('http://127.0.0.1:4747/', ORIGIN), 'allow');
  assert.equal(s.navigationDecision('http://127.0.0.1:4747/chats/abc?x=1#y', ORIGIN), 'allow');
  // Same host, other port / other spelling of localhost: not our origin.
  assert.equal(s.navigationDecision('http://127.0.0.1:4748/', ORIGIN), 'external');
  assert.equal(s.navigationDecision('http://localhost:4747/', ORIGIN), 'external');
  assert.equal(s.navigationDecision('https://example.com/a', ORIGIN), 'external');
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank', 'ftp://x.org/', 'harness://x', '', 'not a url', null, 42]) {
    assert.equal(s.navigationDecision(u, ORIGIN), 'deny', String(u));
  }
  assert.equal(s.navigationDecision('http://127.0.0.1:4747/', null), 'external');
});

test('window.open never creates windows: http(s) → browser, everything else denied', () => {
  assert.equal(s.windowOpenDecision('https://ollama.com/download'), 'external');
  assert.equal(s.windowOpenDecision('http://127.0.0.1:4747/api/images/img_1/file'), 'external');
  assert.equal(s.windowOpenDecision('file:///Users/a/x'), 'deny');
  assert.equal(s.windowOpenDecision('javascript:void(0)'), 'deny');
  assert.equal(s.windowOpenDecision('about:blank'), 'deny');
  assert.equal(s.windowOpenDecision('x'.repeat(10000)), 'deny');
});

test('openExternal accepts only http/https', () => {
  assert.ok(s.isExternalHttpUrl('https://huggingface.co/unsloth'));
  assert.ok(s.isExternalHttpUrl('http://example.org'));
  assert.ok(!s.isExternalHttpUrl('mailto:a@b.c'));
  assert.ok(!s.isExternalHttpUrl('smb://server/share'));
  assert.ok(!s.isExternalHttpUrl('vscode://file/x'));
  assert.ok(!s.isExternalHttpUrl({ toString: () => 'https://x.org' }));
  assert.ok(!s.isExternalHttpUrl('https://'));
});

test('showInFolder only resolves existing paths inside the data dir (symlinks resolved)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sec-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(data, 'images'), { recursive: true });
  fs.writeFileSync(path.join(data, 'images', 'a.png'), 'x');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'x');
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(data, 'link.txt'));
  const realData = fs.realpathSync(data);
  assert.equal(s.resolveInsideDir(path.join(data, 'images', 'a.png'), data), path.join(realData, 'images', 'a.png'));
  assert.equal(s.resolveInsideDir('images/a.png', data), path.join(realData, 'images', 'a.png'));
  assert.equal(s.resolveInsideDir(data, data), realData);
  assert.equal(s.resolveInsideDir(path.join(data, '..', 'secret.txt'), data), null);
  assert.equal(s.resolveInsideDir('../secret.txt', data), null);
  assert.equal(s.resolveInsideDir(path.join(data, 'link.txt'), data), null, 'symlink pointing outside');
  assert.equal(s.resolveInsideDir(path.join(data, 'missing.png'), data), null);
  assert.equal(s.resolveInsideDir('/etc/passwd', data), null);
  assert.equal(s.resolveInsideDir('images/a.png\0', data), null);
  assert.equal(s.resolveInsideDir(42, data), null);
  assert.equal(s.resolveInsideDir('', data), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('badge text is sanitized', () => {
  assert.equal(s.sanitizeBadge(''), '');
  assert.equal(s.sanitizeBadge(null), '');
  assert.equal(s.sanitizeBadge(undefined), '');
  assert.equal(s.sanitizeBadge(3), '3');
  assert.equal(s.sanitizeBadge(0), '');
  assert.equal(s.sanitizeBadge(-1), '');
  assert.equal(s.sanitizeBadge(NaN), '');
  assert.equal(s.sanitizeBadge(1e9), '99999+');
  assert.equal(s.sanitizeBadge('  •  '), '•');
  assert.equal(s.sanitizeBadge('a\nb\u0007c'), 'abc');
  assert.equal(s.sanitizeBadge('x'.repeat(50)), 'x'.repeat(12));
  assert.equal(s.sanitizeBadge({}), null);
  assert.equal(s.sanitizeBadge(['1']), null);
});

test('permissions are denied by default', () => {
  assert.ok(s.isPermissionAllowed('clipboard-sanitized-write', 'http://127.0.0.1:4747/', ORIGIN));
  assert.ok(s.isPermissionAllowed('fullscreen', 'http://127.0.0.1:4747', ORIGIN));
  assert.ok(!s.isPermissionAllowed('clipboard-sanitized-write', 'https://evil.example/', ORIGIN));
  for (const p of ['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'pointerLock', 'openExternal', 'clipboard-read', 'hid', 'serial', 'usb', 'unknown']) {
    assert.ok(!s.isPermissionAllowed(p, 'http://127.0.0.1:4747/', ORIGIN), p);
  }
});
