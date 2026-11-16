#!/usr/bin/env node
// Stand-in for `ollama serve` whose GPU discovery is slow, as when another app is loading a model onto the GPU:
// it listens on OLLAMA_HOST at once but does not answer for FAKE_GPU_DELAY_MS (default 6 s; 0 = never), then
// serves the fake Ollama API there. Harness sees "listening, still looking for the GPU" (waiting_for_gpu).
import net from 'node:net';
import { startFakeOllama } from '../fake-ollama.mjs';

const [cmd] = process.argv.slice(2);
if (cmd !== 'serve') { console.error('only "serve" is supported'); process.exit(2); }
const [host = '127.0.0.1', port = '11434'] = (process.env.OLLAMA_HOST || '127.0.0.1:11434').split(':');
const delay = Number(process.env.FAKE_GPU_DELAY_MS ?? 6000);

// Accept connections and say nothing (requests hang) while "discovering the GPU".
const sockets = new Set();
const hold = net.createServer((s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); });
await new Promise((r) => hold.listen(Number(port), host, r));
console.log(`time=… level=INFO msg="Listening on ${host}:${port} (version 0.0.0-fake)"`);
console.log('time=… level=INFO msg="discovering available GPUs..."');
if (delay > 0) {
  setTimeout(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => hold.close(r));
    await startFakeOllama({ host, port: Number(port), delayMs: 0 });
    console.log('time=… level=INFO msg="inference compute" library=Metal');
  }, delay);
}
process.on('SIGTERM', () => process.exit(0));
