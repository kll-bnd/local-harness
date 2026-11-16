// Compact view of SchemeProbe's JSON (CI helper): one line per fact, appended to the facts file.
import fs from 'node:fs';
const FACTS = process.env.FACTS || '/tmp/native-facts.txt';
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const lines = [];
const add = (k, v) => lines.push(`probe| ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 600));
add('finish', j.finish);
add('ruleList', { compiled: j.ruleListCompiled, error: j.ruleListError || null });
for (const phase of ['phase1', 'phase2']) for (const [k, v] of Object.entries(j[phase] || {})) add(`${phase}.${k}`, v);
add('stop', { calls: j.stopCalls || 0, paths: j.stopPaths || [] });
add('messageOrigin', j.messageOrigin || null);
add('notes', j.notes || []);
for (const p of j.policy || []) add('policy', p);
const byPath = {};
for (const r of j.requests || []) { const k = `${r.method} ${r.path}`; (byPath[k] ||= []).push(`${r.bodySource}:${r.bodyLength}${r.mainThread ? '' : ':bg'}`); }
for (const [k, v] of Object.entries(byPath)) add(`req ${k}`, v.slice(0, 6).join(' '));
const keep = (j.requests || []).find((r) => r.path === '/echo' && r.method === 'PATCH');
add('keepaliveSeen', keep ? { src: keep.bodySource, len: keep.bodyLength } : 'not received');
const text = lines.join('\n') + '\n';
process.stdout.write(text);
fs.appendFileSync(FACTS, text);
