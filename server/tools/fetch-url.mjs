// fetch_url tool implementation.
// - http(s) only; every hop (incl. redirects) is resolved ONCE and the connection goes to the vetted address
//   (custom `lookup`), so there is no DNS check-then-connect race.
// - Blocks every non-public address range (loopback, private, link-local, CGNAT, multicast, unspecified,
//   IPv4-mapped/compatible/NAT64/6to4/Teredo IPv6 forms, documentation, benchmarking, site-local, …) unless
//   allowPrivateNetwork is set.
// - Size + time limits; HTML → text with a linear-time scanner.
import dns from 'node:dns';
import net from 'node:net';
import { httpRequest } from '../lib/http-client.mjs';
import { htmlToText } from '../lib/html.mjs';
import { truncateEnd } from '../lib/util.mjs';

const MAX_BYTES = 3 * 1024 * 1024;

// Two lists: Node's BlockList also matches IPv4 addresses against IPv4-mapped IPv6 rules, so mixing them in one
// list would make "::ffff:0:0/96" block every IPv4 address.
const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked4.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['::', 96] /* IPv4-compatible */, ['::ffff:0:0', 96] /* IPv4-mapped */, ['::ffff:0:0:0', 96] /* SIIT */,
  ['64:ff9b::', 96], ['64:ff9b:1::', 48] /* NAT64 */, ['100::', 64] /* discard */, ['2001::', 23] /* IETF special incl. Teredo */,
  ['2001:db8::', 32], ['2002::', 16] /* 6to4 */, ['3fff::', 20], ['5f00::', 16], ['fc00::', 7] /* ULA */, ['fe80::', 10] /* link-local */,
  ['fec0::', 10] /* site-local */, ['ff00::', 8] /* multicast */,
]) blocked6.addSubnet(a, p, 'ipv6');

/** True for any address that is not a normal public unicast address. Unparseable input counts as private. */
export function isPrivateAddress(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(s);
  if (family === 4) return blocked4.check(s, 'ipv4');
  if (family === 6) {
    if (blocked6.check(s, 'ipv6')) return true;
    // Embedded IPv4 written in dotted form (::ffff:127.0.0.1 and friends) — check the IPv4 part as well.
    const m = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
    return m ? blocked4.check(m[1], 'ipv4') : false;
  }
  return true;
}

class BlockedError extends Error {}

/** DNS lookup used for the actual connection: resolves once, rejects if ANY returned address is non-public. */
export function vettedLookup(allowPrivate) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = addrs || [];
      if (!list.length) return cb(new Error(`No address for ${hostname}`));
      if (!allowPrivate) {
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) return cb(new BlockedError(`Refusing to fetch private network address ${hostname} (${bad.address})`));
      }
      const pick = list[0];
      if (options && options.all) return cb(null, [pick]);
      cb(null, pick.address, pick.family);
    });
  };
}

function checkHost(url, allowPrivate) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate) {
    if (/^localhost$|\.localhost$|\.local$|\.internal$|\.home\.arpa$/i.test(host)) throw new BlockedError(`Refusing to fetch local address ${url.hostname}`);
    if (net.isIP(host) && isPrivateAddress(host)) throw new BlockedError(`Refusing to fetch private network address ${url.hostname}`);
  }
}

export async function fetchUrl(rawUrl, { allowPrivateNetwork = false, maxChars = 20000, signal, timeoutMs = 15000 } = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error(`Invalid URL: ${String(rawUrl).slice(0, 200)}`); }
  const t = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, t]) : t;
  for (let hop = 0; hop < 6; hop++) {
    if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https URLs are allowed');
    if (url.username || url.password) throw new Error('URLs with credentials are not allowed');
    checkHost(url, allowPrivateNetwork);
    let res;
    try {
      res = await httpRequest(url, {
        signal: sig,
        lookup: vettedLookup(allowPrivateNetwork),
        headers: { 'user-agent': 'Harness/0.1 (local assistant; fetch_url tool)', accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5', 'accept-encoding': 'identity' },
      });
    } catch (e) {
      if (e?.cause instanceof BlockedError) throw new Error(e.cause.message);
      if (e instanceof BlockedError) throw e;
      if (e?.name === 'TimeoutError') throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s fetching ${url.host}`);
      if (e?.name === 'AbortError') throw e;
      throw new Error(`Could not connect to ${url.host}${e?.code ? ` (${e.code})` : ''}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      res.cancel();
      url = new URL(res.headers.get('location'), url);
      continue;
    }
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const chunks = [];
    let size = 0;
    for await (const c of res.body) {
      size += c.length;
      chunks.push(c);
      if (size > MAX_BYTES) { res.cancel(); break; }
    }
    const buf = Buffer.concat(chunks).subarray(0, MAX_BYTES);
    if (type && !/text|json|xml|javascript|html/.test(type)) {
      return { url: url.toString(), status: res.status, contentType: type, title: '', text: `[Non-text content (${type}, ${buf.length} bytes) not shown]`, truncated: false };
    }
    let text = buf.toString('utf8');
    let title = '';
    if (/html|xml/.test(type) || /^\s*<(!doctype|html)/i.test(text.slice(0, 200))) ({ title, text } = htmlToText(text));
    const truncated = text.length > maxChars;
    return { url: url.toString(), status: res.status, contentType: type, title, text: truncateEnd(text, maxChars, '\n…[truncated]'), truncated };
  }
  throw new Error('Too many redirects');
}
