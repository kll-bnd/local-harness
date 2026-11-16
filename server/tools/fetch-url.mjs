// fetch_url tool implementation: http(s) only, blocks private/loopback/link-local targets by default
// (re-checked on every redirect hop), size + time limits, HTML → text.
import dns from 'node:dns/promises';
import net from 'node:net';
import { htmlToText } from '../lib/html.mjs';
import { truncateEnd } from '../lib/util.mjs';

const MAX_BYTES = 3 * 1024 * 1024;

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::') return true;
    if (x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80')) return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

async function assertPublic(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new Error(`Refusing to fetch local address ${hostname}`);
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  for (const a of addrs) if (isPrivateAddress(a.address)) throw new Error(`Refusing to fetch private network address ${hostname} (${a.address})`);
}

export async function fetchUrl(rawUrl, { allowPrivateNetwork = false, maxChars = 20000, signal, timeoutMs = 15000 } = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error(`Invalid URL: ${rawUrl}`); }
  const t = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, t]) : t;
  for (let hop = 0; hop < 6; hop++) {
    if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https URLs are allowed');
    if (!allowPrivateNetwork) await assertPublic(url.hostname);
    const res = await fetch(url, { redirect: 'manual', signal: sig, headers: { 'user-agent': 'Harness/0.1 (local assistant; fetch_url tool)', accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      await res.body?.cancel().catch(() => {});
      continue;
    }
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const reader = res.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        chunks.push(value);
        if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
      }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    if (!/text|json|xml|javascript|html/.test(type) && type) {
      return { url: url.toString(), status: res.status, contentType: type, title: '', text: `[Non-text content (${type}, ${buf.length} bytes) not shown]`, truncated: false };
    }
    let text = buf.toString('utf8');
    let title = '';
    if (/html|xml/.test(type) || /^\s*<(!doctype|html)/i.test(text)) ({ title, text } = htmlToText(text));
    const truncated = text.length > maxChars;
    return { url: url.toString(), status: res.status, contentType: type, title, text: truncateEnd(text, maxChars, '\n…[truncated]'), truncated };
  }
  throw new Error('Too many redirects');
}
