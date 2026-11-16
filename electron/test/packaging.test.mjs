// Guards for the packaging/runtime contract: the server keeps zero runtime dependencies (so
// `npm start` works without `npm install`) and electron-builder packages only what the app needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test('no runtime dependencies; Electron tooling is dev-only', () => {
  assert.equal(pkg.dependencies, undefined);
  assert.ok(pkg.devDependencies.electron && pkg.devDependencies['electron-builder']);
  for (const v of Object.values(pkg.devDependencies)) assert.match(v, /^\d+\.\d+\.\d+$/, 'pin exact versions');
  assert.equal(pkg.scripts.start, 'node server/index.mjs');
});

test('server/ and electron/ only import Node built-ins, relative files and electron', () => {
  const builtins = new Set(builtinModules);
  const bad = [];
  let seen = 0;
  for (const file of [...walk(path.join(root, 'server')), ...walk(path.join(root, 'electron'))]) {
    if (!/\.(mjs|cjs|js)$/.test(file) || file.includes(`${path.sep}test${path.sep}`)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const specs = [
      ...src.matchAll(/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]/gm),
      ...src.matchAll(/^\s*import\s*['"]([^'"\n]+)['"]/gm),
      ...src.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g),
    ].map((m) => m[1]);
    seen += specs.length;
    for (const s of specs) {
      const ok = s.startsWith('.') || s.startsWith('node:') || builtins.has(s) || (s === 'electron' && file.includes(`${path.sep}electron${path.sep}`));
      if (!ok) bad.push(`${path.relative(root, file)}: ${s}`);
    }
  }
  assert.ok(seen > 100, `scanner found ${seen} import specifiers`);
  assert.deepEqual(bad, []);
});

test('electron-builder config: arm64 mac, ad-hoc signed, allow-listed files', () => {
  const b = pkg.build;
  assert.equal(pkg.main, 'electron/main.cjs');
  assert.equal(b.mac.identity, '-', 'ad-hoc signature (required on Apple Silicon)');
  assert.deepEqual(b.mac.target.map((t) => t.arch), [['arm64']]);
  assert.ok(fs.existsSync(path.join(root, b.mac.icon)), b.mac.icon);
  assert.ok(fs.existsSync(path.join(root, b.linux.icon)), b.linux.icon);
  for (const must of ['server/**/*', 'public/**/*', 'electron/**/*', '!electron/test{,/**/*}']) assert.ok(b.files.includes(must), must);
  assert.ok(!b.files.some((f) => /^(test|docs|scripts|\.harness-dev)/.test(f)), 'tests, docs, scripts and dev data are not packaged');
});
