#!/usr/bin/env node
// CI-only: print a compact summary of a live-check JSON result (every check that did not pass).
import fs from 'node:fs';

const file = process.argv[2];
let j;
try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log(`no live-check result at ${file}: ${e.message}`); process.exit(0); }
const clip = (s, n) => { const t = typeof s === 'string' ? s : JSON.stringify(s); return t && t.length > n ? `${t.slice(0, n)}…` : t; };
console.log(`live-check ${j.toolVersion}: ${JSON.stringify({ total: j.summary.total, PASS: j.summary.PASS, WARN: j.summary.WARN, FAIL: j.summary.FAIL, SKIP: j.summary.SKIP })} exit ${j.exitCode} in ${Math.round(j.durationMs / 1000)} s`);
console.log(`by group: ${JSON.stringify(j.summary.byGroup)}`);
for (const [backend, picks] of Object.entries(j.picks || {})) console.log(`picks ${backend}: ${Object.entries(picks).map(([k, v]) => `${k}=${v?.model ?? v}`).join(' ')}`);
if (j.unresolvedAnchors?.length) console.log(`unresolved code anchors: ${clip(j.unresolvedAnchors, 400)}`);
const order = { FAIL: 0, WARN: 1, SKIP: 2 };
for (const c of j.checks.filter((x) => x.status !== 'PASS').sort((a, b) => order[a.status] - order[b.status])) {
  console.log(`${c.status} ${c.id}: ${clip(c.detail, 420)}`);
  if (c.status === 'SKIP') continue;
  if (c.expected) console.log(`   expected: ${clip(c.expected, 220)}`);
  if (c.actual) console.log(`   actual:   ${clip(c.actual, 420)}`);
  if (c.fix) console.log(`   fix:      ${clip(c.fix, 260)}`);
}
const want = (process.argv[3] || '').split(',').filter(Boolean);
for (const [name, sample] of Object.entries(j.samples || {})) if (want.some((w) => name.includes(w))) console.log(`sample ${name}: ${clip(sample, 900)}`);
