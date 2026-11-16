// `run-selftest.mjs --data default` must never touch existing Harness data (see the comment next to the option).
// Runs on Linux and macOS with a throw-away HOME — never the real one:
//   node --test native/test/run-selftest-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-selftest.mjs');

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-guard-home-'));
  const data = path.join(home, 'Library', 'Application Support', 'Harness');
  return { home, data, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function run(home, extraEnv = {}, args = ['--data', 'default', '--allow-default-data']) {
  const env = { ...process.env, HOME: home, GITHUB_ACTIONS: 'true', CI: 'true', FACTS: path.join(home, 'facts.txt'), ...extraEnv };
  return spawnSync(process.execPath, [runner, '--app', path.join(home, 'NoSuch.app'), '--label', 'guard', ...args], { env, encoding: 'utf8', timeout: 30000 });
}

test('an existing data folder with chats: refused, nothing touched', () => {
  const h = fakeHome();
  try {
    fs.mkdirSync(path.join(h.data, 'chats'), { recursive: true });
    fs.writeFileSync(path.join(h.data, 'chats', 'chat_1.json'), 'my real chat');
    fs.writeFileSync(path.join(h.data, 'launch.json'), '{"encryption":"keychain"}');
    const r = run(h.home);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /refusing --data default: .* exists/);
    assert.equal(fs.readFileSync(path.join(h.data, 'chats', 'chat_1.json'), 'utf8'), 'my real chat');
    assert.equal(fs.readFileSync(path.join(h.data, 'launch.json'), 'utf8'), '{"encryption":"keychain"}');
  } finally { h.cleanup(); }
});

test('an existing empty data folder: refused and kept', () => {
  const h = fakeHome();
  try {
    fs.mkdirSync(h.data, { recursive: true });
    const r = run(h.home);
    assert.equal(r.status, 2, r.stderr);
    assert.ok(fs.statSync(h.data).isDirectory());
  } finally { h.cleanup(); }
});

test('the data folder is a symlink: refused, the link and its target untouched', () => {
  const h = fakeHome();
  try {
    const target = path.join(h.home, 'elsewhere');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'vault.json'), 'keep me');
    fs.mkdirSync(path.dirname(h.data), { recursive: true });
    fs.symlinkSync(target, h.data);
    const r = run(h.home);
    assert.equal(r.status, 2, r.stderr);
    assert.ok(fs.lstatSync(h.data).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(target, 'vault.json'), 'utf8'), 'keep me');
  } finally { h.cleanup(); }
});

test('a dangling symlink or a plain file at that path: refused and kept', () => {
  const h = fakeHome();
  try {
    fs.mkdirSync(path.dirname(h.data), { recursive: true });
    fs.symlinkSync(path.join(h.home, 'missing-target'), h.data);
    assert.equal(run(h.home).status, 2);
    assert.ok(fs.lstatSync(h.data).isSymbolicLink());
    fs.unlinkSync(h.data);
    fs.writeFileSync(h.data, 'a file');
    assert.equal(run(h.home).status, 2);
    assert.equal(fs.readFileSync(h.data, 'utf8'), 'a file');
  } finally { h.cleanup(); }
});

test('outside GitHub Actions, or without --allow-default-data: refused before looking at anything', () => {
  const h = fakeHome();
  try {
    fs.mkdirSync(h.data, { recursive: true });
    fs.writeFileSync(path.join(h.data, 'x'), 'y');
    for (const r of [run(h.home, { GITHUB_ACTIONS: '' }), run(h.home, {}, ['--data', 'default'])]) {
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /only on GitHub Actions/);
    }
    assert.equal(fs.readFileSync(path.join(h.data, 'x'), 'utf8'), 'y');
  } finally { h.cleanup(); }
});
