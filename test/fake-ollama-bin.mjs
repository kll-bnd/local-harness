#!/usr/bin/env node
// Stand-in for the `ollama` binary in process-management tests: `fake-ollama-bin.mjs serve`
// records its environment (FAKE_OLLAMA_ENV_FILE) and serves the fake API on OLLAMA_HOST.
import fs from 'node:fs';
import { startFakeOllama } from './fake-ollama.mjs';

const [cmd] = process.argv.slice(2);
if (cmd !== 'serve') { console.error('only "serve" is supported'); process.exit(2); }
const host = process.env.OLLAMA_HOST || '127.0.0.1:11434';
const [h, p] = host.split(':');
if (process.env.FAKE_OLLAMA_ENV_FILE) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('OLLAMA_')));
  fs.writeFileSync(process.env.FAKE_OLLAMA_ENV_FILE, JSON.stringify({ ...env, argv: process.argv.slice(2) }));
}
await startFakeOllama({ host: h || '127.0.0.1', port: Number(p || 11434) });
process.on('SIGTERM', () => process.exit(0));
