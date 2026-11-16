// The facts that matter, last in the job log (the log API only returns the end of a log), and the verdict:
//   node native/ci/summary.mjs <label>…   — exits 1 when a build failed, a check failed, or a label has no summary.
import fs from 'node:fs';
const lines = fs.readFileSync(process.env.FACTS || '/tmp/native-facts.txt', 'utf8').split('\n').filter(Boolean);
const expected = process.argv.slice(2);
const keep = lines.filter((l) => /^(build\||bundle\||electron\||guard\|)|\.memory:|summary:|\.PASS:|markerNotOnDisk|\.sockets|cleanQuit.*"ok":false|^ollama\| (sandbox-ollama sandboxed\.(chat|ps|pullSmall)|net-probe)/.test(l));
console.log(`---- summary (${keep.length} of ${lines.length} fact lines) ----`);
for (const l of keep) console.log(l.slice(0, 600));
const problems = [];
for (const l of lines) if (/^build-error\|/.test(l) || / FAIL /.test(l) || /cleanQuit.*"ok":false/.test(l) || /\.sockets: \{"ok":false/.test(l)) problems.push(l);
for (const l of lines) { const m = l.match(/^selftest\| (\S+) summary: (\d+) passed, (\d+) failed/); if (m && Number(m[3]) > 0 && !problems.includes(l)) problems.push(l); }
for (const label of expected) if (!lines.some((l) => l.startsWith(`selftest| ${label} summary:`))) problems.push(`selftest| ${label}: no summary (the step did not finish)`);
console.log(`---- failures (${problems.length}) ----`);
for (const l of problems) console.log(l.slice(0, 1500));
console.log(problems.length ? `RESULT: FAILED (${problems.length})` : `RESULT: all checks passed (${expected.join(', ')})`);
process.exit(problems.length ? 1 : 0);
