#!/usr/bin/env node
// Regenerate the app icons from build/icon.svg (needs `npm install`; downloads electron-builder's
// checksum-pinned icon toolset once):
//   build/icon.icns  macOS icon, written by electron-builder's own icon tool (the same code path
//                    electron-builder uses when it converts a PNG/SVG icon during `npm run dist`)
//   build/icon.png   1024×1024 PNG (Linux builds, Dock icon during `npm run app`), taken from the icns
//
// The generated files are committed, so building the Mac app does not need this step.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { runIconsTool } = require('app-builder-lib/out/toolsets/icons.js');

const svg = path.join(root, 'build', 'icon.svg');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-icons-'));
await runIconsTool({ inputFile: svg, outputFormat: 'icns', outDir: out });
const icns = fs.readFileSync(path.join(out, 'icon.icns'));
fs.writeFileSync(path.join(root, 'build', 'icon.icns'), icns);

// Walk the ICNS container: 'icns' + u32 length, then entries of (4-char type, u32 length incl. header, payload).
if (icns.toString('ascii', 0, 4) !== 'icns' || icns.readUInt32BE(4) !== icns.length) throw new Error('bad icns container');
const entries = [];
for (let o = 8; o < icns.length;) {
  const type = icns.toString('ascii', o, o + 4);
  const len = icns.readUInt32BE(o + 4);
  const payload = icns.subarray(o + 8, o + len);
  const isPng = payload.subarray(1, 4).toString('ascii') === 'PNG';
  entries.push({ type, bytes: len, png: isPng ? `${payload.readUInt32BE(16)}x${payload.readUInt32BE(20)}` : 'argb' });
  if (type === 'ic10') fs.writeFileSync(path.join(root, 'build', 'icon.png'), payload);
  o += len;
}
fs.rmSync(out, { recursive: true, force: true });
console.log('build/icon.icns entries:');
for (const e of entries) console.log(`  ${e.type}  ${e.png.padEnd(9)} ${e.bytes} bytes`);
if (!entries.some((e) => e.type === 'ic10')) throw new Error('icns has no 1024px (ic10) entry');
console.log('build/icon.png  1024x1024');
