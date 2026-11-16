// Run a command with a time limit and append its output (last lines) to the facts file (CI helper).
//   node native/ci/run.mjs <seconds> <label> -- <command> [args…]
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [secs, label, sep, cmd, ...args] = process.argv.slice(2);
if (sep !== '--' || !cmd) { console.error('usage: run.mjs <seconds> <label> -- <cmd> [args…]'); process.exit(2); }
const FACTS = process.env.FACTS || '/tmp/native-facts.txt';
const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
const timer = setTimeout(() => { out += `\n[killed after ${secs}s]`; child.kill('SIGKILL'); }, Number(secs) * 1000);
child.on('close', (code, signal) => {
  clearTimeout(timer);
  const lines = out.split('\n').filter((l) => l.trim()).slice(-Number(process.env.KEEP || 40));
  const text = `${lines.map((l) => `${label}| ${l.slice(0, 400)}`).join('\n')}\n${label}| exit=${code ?? signal}\n`;
  process.stdout.write(text);
  fs.appendFileSync(FACTS, text);
  process.exit(0);
});
