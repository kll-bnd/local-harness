#!/usr/bin/env node
// Development stack without any real model: fake Ollama + fake Draw Things/A1111 + fake ComfyUI +
// fake OpenAI-compatible server (chat + images), and the real Harness server wired to them.
//
//   npm run dev:fake                      # UI at http://127.0.0.1:4747
//   npm run dev:fake -- --ram 8           # pretend the machine has 8 GB RAM (low-RAM code paths)
//   npm run dev:fake -- --delay 40 --step 150 --port 4747 --data .harness-dev --fresh
//   npm run dev:fake -- --insecure       # no password, no API sessions, internet not blocked (explicit opt-out)
//
// By default the stack runs with the shipped 0.2 defaults: the UI asks for a password first (the data dir is
// encrypted), and internet access is blocked. Once encrypted, settings.json cannot be rewritten from here: the
// fakes keep their default ports, so the wiring from the first start stays valid (use --fresh to start over).
//
// Fakes prefer their real default ports (11434, 7860, 8188, 8080) and fall back to free ports.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFakeOllama } from '../test/fake-ollama.mjs';
import { startFakeA1111 } from '../test/fake-a1111.mjs';
import { startFakeComfyUI } from '../test/fake-comfyui.mjs';
import { startFakeOpenAI } from '../test/fake-openai.mjs';
import { parseArgs } from '../test/fake-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const delay = Number(args.delay ?? 30);
const step = Number(args.step ?? 120);

const portFree = (p) => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });
const pick = async (p) => ((await portFree(p)) ? p : 0);

const ollama = await startFakeOllama({ port: await pick(11434), delayMs: delay, pullStepMs: 300 });
const a1111 = await startFakeA1111({ port: await pick(7860), stepMs: step });
const comfy = await startFakeComfyUI({ port: await pick(8188), stepMs: step });
const openai = await startFakeOpenAI({ port: await pick(8080), delayMs: delay });

const dataDir = path.resolve(root, args.data || '.harness-dev');
if (args.fresh === 'true') await fs.rm(dataDir, { recursive: true, force: true });
await fs.mkdir(dataDir, { recursive: true });
const settingsFile = path.join(dataDir, 'settings.json');
let settings = {};
let encrypted = false;
try {
  const raw = await fs.readFile(settingsFile);
  encrypted = raw.subarray(0, 4).toString('latin1') === 'HXC1';
  if (!encrypted) settings = JSON.parse(raw.toString('utf8'));
} catch { /* first run */ }
settings.providers = { ...(settings.providers || {}), autodetect: true, builtin: { ...(settings.providers?.builtin || {}), ollama: { enabled: true, baseUrl: ollama.url }, llamacpp: { enabled: true, baseUrl: openai.url }, lmstudio: { enabled: false, baseUrl: 'http://127.0.0.1:1234' } } };
settings.image = { ...(settings.image || {}), autodetect: true, builtin: { a1111: { enabled: true, baseUrl: a1111.url }, comfyui: { enabled: true, baseUrl: comfy.url } } };
settings.ollama = { ...(settings.ollama || {}), autoStart: false };
if (!encrypted) await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2));

if (args.ram) process.env.HARNESS_TOTALMEM_BYTES = String(Number(args.ram) * 1024 ** 3);
const { startServer } = await import('../server/index.mjs');
const insecure = args.insecure === 'true';
const srv = await startServer({ port: Number(args.port || 4747), dataDir, openBrowser: args.open === 'true', ...(insecure ? { security: { mode: 'off', apiAuth: false }, offlineLock: false } : {}) });
const sec = srv.core.securityStatus();

console.log(`
Harness dev stack (fake backends)
  Harness UI/API     ${srv.url}
  fake Ollama        ${ollama.url}
  fake Draw Things   ${a1111.url}   (A1111-compatible API)
  fake ComfyUI       ${comfy.url}
  fake llama.cpp     ${openai.url}   (OpenAI-compatible chat + images)
  data dir           ${dataDir}${args.ram ? `\n  simulated RAM      ${args.ram} GB` : ''}
  security           ${insecure ? 'OFF (--insecure)' : `${sec.mode} mode, ${sec.state}${sec.state === 'needs_setup' ? ' — choose a password in the UI' : ''}`}; internet ${sec.offlineLock.blocked ? 'blocked' : 'allowed'}${encrypted ? '\n  note               settings.json is encrypted: backend wiring kept from the first start' : ''}

Trigger phrases for the fake model: "calculate 2+2", "what time is it", "please remember that ...",
"draw a red fox", "long answer 200", "my name is Ada". Use qwen3:4b for thinking, deepseek-r1:1.5b for <think> tags.
`);

const stop = async () => {
  await srv.close();
  await Promise.all([ollama.close(), a1111.close(), comfy.close(), openai.close()]);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
