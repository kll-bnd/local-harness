// Attachment classification, text extraction, image dimension sniffing and chunking.
import path from 'node:path';
import { extractPdfText } from './pdf.mjs';
import { estimateTextTokens } from '../context/tokens.mjs';

export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const TEXT_EXT = new Set(('txt md markdown rst org csv tsv json jsonl ndjson yaml yml toml ini cfg conf env xml html htm css scss less svg ' +
  'js mjs cjs jsx ts tsx py rb go rs java kt kts swift c h cc cpp hpp cs m mm php pl lua r jl scala sh bash zsh fish ps1 bat sql graphql ' +
  'proto tf hcl dockerfile makefile cmake gradle vue svelte astro tex bib log diff patch gitignore editorconfig').split(' '));

const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', md: 'text/markdown', json: 'application/json', txt: 'text/plain', csv: 'text/csv', html: 'text/html' };

export function guessMime(name, declared, head) {
  if (head?.length >= 4) {
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
    if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
    if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    if (head.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  }
  if (declared && declared !== 'application/octet-stream') return declared.split(';')[0].trim().toLowerCase();
  const ext = path.extname(name || '').slice(1).toLowerCase();
  return EXT_MIME[ext] || (TEXT_EXT.has(ext) ? 'text/plain' : 'application/octet-stream');
}

function looksTextual(buf) {
  const n = Math.min(buf.length, 8192);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  return ctrl / (n || 1) < 0.02;
}

function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return buf.toString('latin1'); }
}

export function imageSize(buf, mime) {
  try {
    if (mime === 'image/png' && buf.length > 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/gif' && buf.length > 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
    if (mime === 'image/webp' && buf.length > 30) {
      const fmt = buf.subarray(12, 16).toString('latin1');
      if (fmt === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') { const b = buf.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
    }
  } catch { /* ignore */ }
  return { width: null, height: null };
}

/**
 * Classify + extract. Returns `{ kind: 'image'|'text'|'binary', mime, text?, pages?, width?, height?, warnings, error? }`.
 */
export function processUpload(name, declaredMime, buf) {
  const mime = guessMime(name, declaredMime, buf.subarray(0, 16));
  const warnings = [];
  if (IMAGE_MIMES.has(mime)) return { kind: 'image', mime, ...imageSize(buf, mime), warnings };
  if (mime === 'application/pdf') {
    try {
      const r = extractPdfText(buf);
      return { kind: r.text ? 'text' : 'binary', mime, text: r.text, pages: r.pages, warnings: r.warnings, source: 'pdf', ...(r.text ? {} : { error: r.warnings[0] }) };
    } catch (e) {
      return { kind: 'binary', mime, warnings, error: `PDF text extraction failed: ${e.message}` };
    }
  }
  const ext = path.extname(name || '').slice(1).toLowerCase();
  if (mime.startsWith('text/') || /json|xml|yaml|toml|javascript|typescript|x-sh|sql/.test(mime) || TEXT_EXT.has(ext) || looksTextual(buf)) {
    if (!looksTextual(buf)) return { kind: 'binary', mime, warnings, error: 'File does not look like text' };
    return { kind: 'text', mime: mime === 'application/octet-stream' ? 'text/plain' : mime, text: decodeText(buf), warnings, source: 'plain' };
  }
  return { kind: 'binary', mime, warnings, error: `Unsupported file type (${mime}). Supported: images, text/code files, PDF (text only).` };
}

/**
 * Split text into ~`targetTokens` chunks on paragraph/line/sentence boundaries with small overlap.
 * Returns `[{ n, text, tokens }]`.
 */
export function chunkText(text, { targetTokens = 400, overlapTokens = 50 } = {}) {
  const paras = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const units = [];
  for (const p of paras) {
    if (estimateTextTokens(p) <= targetTokens) { units.push(p); continue; }
    // Break long paragraphs by lines, then sentences, then hard slices.
    const lines = p.split('\n');
    for (const line of lines) {
      if (estimateTextTokens(line) <= targetTokens) { units.push(line); continue; }
      const sentences = line.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [line];
      for (const s of sentences) {
        if (estimateTextTokens(s) <= targetTokens) { units.push(s.trim()); continue; }
        const step = targetTokens * 4;
        for (let i = 0; i < s.length; i += step) units.push(s.slice(i, i + step));
      }
    }
  }
  const chunks = [];
  let cur = [];
  let curTok = 0;
  let fresh = false;
  const flush = () => {
    if (!cur.length) return;
    fresh = false;
    const t = cur.join('\n\n');
    chunks.push({ n: chunks.length, text: t, tokens: estimateTextTokens(t) });
    // overlap: carry trailing units up to overlapTokens
    const keep = [];
    let k = 0;
    for (let i = cur.length - 1; i >= 0; i--) {
      const tk = estimateTextTokens(cur[i]);
      if (k + tk > overlapTokens) break;
      keep.unshift(cur[i]);
      k += tk;
    }
    cur = keep;
    curTok = k;
  };
  for (const u of units) {
    const tk = estimateTextTokens(u);
    if (curTok + tk > targetTokens && cur.length) flush();
    cur.push(u);
    curTok += tk;
    fresh = true;
  }
  if (cur.length && fresh) {
    const t = cur.join('\n\n');
    chunks.push({ n: chunks.length, text: t, tokens: estimateTextTokens(t) });
  }
  return chunks;
}
