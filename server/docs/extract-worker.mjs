// Worker thread for text extraction + chunking of uploads (PDFs and large files), so hostile or unusual
// input can never freeze or exhaust the main server: it runs with resourceLimits and a wall-clock timeout.
import { parentPort, workerData } from 'node:worker_threads';
import { processUpload, chunkText } from './extract.mjs';

const { name, mime, buffer, chunkTokens } = workerData;
try {
  const buf = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const r = processUpload(name, mime, buf);
  const chunks = r.kind === 'text' && r.text ? chunkText(r.text, { targetTokens: chunkTokens, overlapTokens: Math.round(chunkTokens / 8) }) : [];
  parentPort.postMessage({ ok: true, result: r, chunks });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e?.message || String(e) });
}
