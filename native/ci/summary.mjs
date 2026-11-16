// The facts that matter, last in the job log (the log API only returns the end of a log).
import fs from 'node:fs';
const lines = fs.readFileSync(process.env.FACTS || '/tmp/native-facts.txt', 'utf8').split('\n');
const keep = lines.filter((l) => /^(build(-error)?\||bundle\||electron\|)|\.memory:|summary:| FAIL |\.PASS:| detail |markerNotOnDisk|\.sockets|cleanQuit.*"ok":false|^ollama\| (sandbox-ollama sandboxed\.(chat|ps|pullSmall)|net-probe)/.test(l));
console.log(`---- summary (${keep.length} of ${lines.length} fact lines) ----`);
for (const l of keep) console.log(l.slice(0, 600));
