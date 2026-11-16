// Best-effort, dependency-free PDF text extraction.
// Supports: classic and object-stream (PDF 1.5+) objects, FlateDecode / ASCIIHex / ASCII85 streams,
// page-tree ordering, Tj/TJ/'/" text operators with simple line-break heuristics, ToUnicode CMaps
// (bfchar/bfrange, 1- and 2-byte codes). Not supported: encrypted PDFs, scanned (image-only) PDFs (no OCR),
// LZW streams, text inside form XObjects, Type3 glyph mapping.
import zlib from 'node:zlib';

function parseObjects(s, buf) {
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = s.indexOf('endobj', start);
    if (end < 0) break;
    const body = s.slice(start, end);
    const si = body.search(/\bstream(\r\n|\n|\r)/);
    let dict = body;
    let stream = null;
    if (si >= 0) {
      dict = body.slice(0, si);
      const nl = body.slice(si).match(/^stream(\r\n|\n|\r)/)[0].length;
      const dataStart = start + si + nl;
      let dataEnd = -1;
      const lm = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      if (lm) {
        const L = Number(lm[1]);
        if (/^\s*endstream/.test(s.slice(dataStart + L, dataStart + L + 20))) dataEnd = dataStart + L;
      }
      if (dataEnd < 0) {
        dataEnd = s.indexOf('endstream', dataStart);
        if (dataEnd < 0) dataEnd = end;
        while (dataEnd > dataStart && (s[dataEnd - 1] === '\n' || s[dataEnd - 1] === '\r')) dataEnd--;
      }
      stream = buf.subarray(dataStart, dataEnd);
    }
    objs.set(num, { dict, stream });
    re.lastIndex = end + 6;
  }
  return objs;
}

function ascii85(str) {
  const s = str.replace(/\s+/g, '').replace(/^<~/, '').replace(/~>.*$/, '');
  const out = [];
  let group = [];
  for (const ch of s) {
    if (ch === 'z' && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Buffer.from(out);
}

function decodeStream(obj) {
  if (!obj?.stream) return null;
  const fm = obj.dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/);
  const filters = fm ? (fm[1].match(/\/\w+/g) || []).map((f) => f.slice(1)) : [];
  let data = obj.stream;
  for (const f of filters) {
    if (f === 'FlateDecode' || f === 'Fl') {
      try { data = zlib.inflateSync(data); } catch {
        try { data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return null; }
      }
    } else if (f === 'ASCIIHexDecode' || f === 'AHx') {
      data = Buffer.from(data.toString('latin1').replace(/[^0-9a-fA-F]/g, ''), 'hex');
    } else if (f === 'ASCII85Decode' || f === 'A85') {
      data = ascii85(data.toString('latin1'));
    } else {
      return null; // DCT/JPX/LZW/CCITT etc.
    }
  }
  return data;
}

function expandObjectStreams(objs) {
  for (const [, o] of [...objs]) {
    if (!/\/Type\s*\/ObjStm\b/.test(o.dict)) continue;
    const data = decodeStream(o);
    if (!data) continue;
    const n = Number(o.dict.match(/\/N\s+(\d+)/)?.[1] || 0);
    const first = Number(o.dict.match(/\/First\s+(\d+)/)?.[1] || 0);
    const txt = data.toString('latin1');
    const header = txt.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = header[i * 2];
      const off = header[i * 2 + 1];
      const next = i + 1 < n ? header[(i + 1) * 2 + 1] : txt.length - first;
      if (!objs.has(num)) objs.set(num, { dict: txt.slice(first + off, first + next), stream: null });
    }
  }
}

const refOf = (str, key) => {
  const m = str.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`));
  return m ? Number(m[1]) : null;
};

/** Extract the balanced `<< ... >>` that follows `/key`, or the dict of the referenced object. */
function subDict(objs, str, key) {
  const i = str.search(new RegExp(`/${key}\\b`));
  if (i < 0) return null;
  const rest = str.slice(i + key.length + 1);
  const ref = rest.match(/^\s*(\d+)\s+\d+\s+R/);
  if (ref) return objs.get(Number(ref[1]))?.dict ?? null;
  const start = rest.indexOf('<<');
  if (start < 0 || rest.slice(0, start).trim()) return null;
  let depth = 0;
  for (let j = start; j < rest.length - 1; j++) {
    if (rest[j] === '<' && rest[j + 1] === '<') { depth++; j++; } else if (rest[j] === '>' && rest[j + 1] === '>') { depth--; j++; if (depth === 0) return rest.slice(start, j + 1); }
  }
  return null;
}

function hexToBytes(h) {
  const clean = h.replace(/[^0-9a-fA-F]/g, '');
  return Buffer.from(clean.length % 2 ? clean + '0' : clean, 'hex');
}

function utf16be(bytes) {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return s;
}

function parseCMap(text) {
  const map = new Map();
  let codeBytes = 1;
  const cs = text.match(/begincodespacerange\s*<([0-9a-fA-F]+)>/);
  if (cs) codeBytes = Math.max(1, cs[1].length / 2);
  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), utf16be(hexToBytes(m[2])));
  }
  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (hi - lo > 65535) continue;
      if (m[4] !== undefined) {
        const base = hexToBytes(m[4]);
        for (let c = lo; c <= hi; c++) {
          const b = Buffer.from(base);
          b[b.length - 1] += c - lo;
          map.set(c, utf16be(b));
        }
      } else {
        const items = [...m[5].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16be(hexToBytes(x[1])));
        items.forEach((u, k) => map.set(lo + k, u));
      }
    }
  }
  return { map, codeBytes };
}

function fontsForPage(objs, pageDict) {
  let resources = subDict(objs, pageDict, 'Resources');
  // Inherit resources from parent page-tree nodes.
  let parent = refOf(pageDict, 'Parent');
  const seen = new Set();
  while (!resources && parent && !seen.has(parent)) {
    seen.add(parent);
    const pd = objs.get(parent)?.dict || '';
    resources = subDict(objs, pd, 'Resources');
    parent = refOf(pd, 'Parent');
  }
  const fonts = new Map();
  if (!resources) return fonts;
  const fontDict = subDict(objs, resources, 'Font');
  if (!fontDict) return fonts;
  for (const m of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const fobj = objs.get(Number(m[2]));
    if (!fobj) continue;
    const tu = refOf(fobj.dict, 'ToUnicode');
    let cmap = null;
    if (tu) {
      const data = decodeStream(objs.get(tu));
      if (data) cmap = parseCMap(data.toString('latin1'));
    }
    const type0 = /\/Subtype\s*\/Type0/.test(fobj.dict);
    fonts.set(m[1], { cmap, codeBytes: cmap?.codeBytes || (type0 ? 2 : 1) });
  }
  return fonts;
}

function decodePdfString(bytes, font) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be(bytes.subarray(2));
  if (!font) return bytes.toString('latin1');
  const { cmap, codeBytes } = font;
  let out = '';
  for (let i = 0; i + codeBytes <= bytes.length; i += codeBytes) {
    const code = codeBytes === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
    if (cmap?.map.has(code)) out += cmap.map.get(code);
    else if (codeBytes === 1) out += String.fromCharCode(code);
  }
  return out;
}

function readLiteral(s, i) {
  // s[i] === '('
  let depth = 1;
  const bytes = [];
  i++;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      const esc = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
      if (n in esc) { bytes.push(esc[n]); i += 2; continue; }
      if (/[0-7]/.test(n)) {
        let oct = '';
        let j = i + 1;
        while (j < s.length && oct.length < 3 && /[0-7]/.test(s[j])) oct += s[j++];
        bytes.push(parseInt(oct, 8) & 255);
        i = j;
        continue;
      }
      if (n === '\r' || n === '\n') { i += n === '\r' && s[i + 2] === '\n' ? 3 : 2; continue; }
      i += 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
    bytes.push(c.charCodeAt(0) & 255);
    i++;
  }
  return { bytes: Buffer.from(bytes), end: i };
}

function extractTextFromContent(content, fonts) {
  const s = content;
  let i = 0;
  let out = '';
  let stack = [];
  let font = null;
  let lastY = null;
  const push = (t) => { out += t; };
  const newline = () => { if (out && !out.endsWith('\n')) out += '\n'; };
  while (i < s.length) {
    const c = s[i];
    if (c === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { const r = readLiteral(s, i); stack.push({ str: r.bytes }); i = r.end; continue; }
    if (c === '<' && s[i + 1] === '<') { stack.push({ dict: true }); i += 2; continue; }
    if (c === '>' && s[i + 1] === '>') { i += 2; continue; }
    if (c === '<') { const j = s.indexOf('>', i); stack.push({ str: hexToBytes(s.slice(i + 1, j < 0 ? s.length : j)) }); i = j < 0 ? s.length : j + 1; continue; }
    if (c === '[') { stack.push({ arrStart: true }); i++; continue; }
    if (c === ']') {
      const arr = [];
      while (stack.length && !stack[stack.length - 1].arrStart) arr.unshift(stack.pop());
      stack.pop();
      stack.push({ arr });
      i++;
      continue;
    }
    if (c === '/') { let j = i + 1; while (j < s.length && !/[\s/<>[\]()%{}]/.test(s[j])) j++; stack.push({ name: s.slice(i + 1, j) }); i = j; continue; }
    if (/[0-9+\-.]/.test(c)) { let j = i + 1; while (j < s.length && /[0-9.]/.test(s[j])) j++; stack.push({ num: Number(s.slice(i, j)) }); i = j; continue; }
    // operator
    let j = i;
    while (j < s.length && !/[\s/<>[\]()%{}]/.test(s[j])) j++;
    if (j === i) j = i + 1;
    const op = s.slice(i, j);
    i = j;
    const nums = () => stack.filter((x) => 'num' in x).map((x) => x.num);
    switch (op) {
      case 'Tf': { const nm = stack.find((x) => 'name' in x); font = nm ? fonts.get(nm.name) || null : null; break; }
      case 'Tj': { const st = stack[stack.length - 1]; if (st?.str) push(decodePdfString(st.str, font)); break; }
      case "'": case '"': { newline(); const st = stack[stack.length - 1]; if (st?.str) push(decodePdfString(st.str, font)); break; }
      case 'TJ': {
        const a = stack[stack.length - 1]?.arr || [];
        for (const el of a) {
          if (el.str) push(decodePdfString(el.str, font));
          else if ('num' in el && el.num < -180 && !out.endsWith(' ')) push(' ');
        }
        break;
      }
      case 'Td': case 'TD': { const n = nums(); const ty = n[n.length - 1] || 0; const tx = n[n.length - 2] || 0; if (Math.abs(ty) > 0.5) newline(); else if (tx > 1 && !out.endsWith(' ')) push(' '); break; }
      case 'Tm': { const n = nums(); const y = n[5]; if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 0.5) newline(); lastY = y ?? lastY; break; }
      case 'T*': newline(); break;
      case 'ET': if (!out.endsWith('\n') && !out.endsWith(' ')) push(' '); break;
      case 'ID': { const e = s.slice(i).search(/\sEI\b/); i = e < 0 ? s.length : i + e + 3; break; }
      default: break;
    }
    stack = [];
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function orderedPages(objs) {
  const pageNums = [];
  const catalog = [...objs.entries()].find(([, o]) => /\/Type\s*\/Catalog\b/.test(o.dict));
  const root = catalog ? refOf(catalog[1].dict, 'Pages') : null;
  const seen = new Set();
  const walk = (n) => {
    if (n == null || seen.has(n)) return;
    seen.add(n);
    const o = objs.get(n);
    if (!o) return;
    if (/\/Type\s*\/Page\b/.test(o.dict)) { pageNums.push(n); return; }
    const kids = o.dict.match(/\/Kids\s*\[([^\]]*)\]/);
    if (kids) for (const k of kids[1].matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(k[1]));
  };
  walk(root);
  if (!pageNums.length) {
    for (const [n, o] of [...objs.entries()].sort((a, b) => a[0] - b[0])) if (/\/Type\s*\/Page\b/.test(o.dict)) pageNums.push(n);
  }
  return pageNums;
}

/**
 * @param {Buffer} buf
 * @returns {{ text: string, pages: number, warnings: string[] }}
 */
export function extractPdfText(buf) {
  const s = buf.toString('latin1');
  if (!s.startsWith('%PDF')) throw new Error('Not a PDF file');
  if (/\/Encrypt\s+\d+\s+\d+\s+R|\/Encrypt\s*<</.test(s)) throw new Error('Encrypted PDFs are not supported');
  const objs = parseObjects(s, buf);
  expandObjectStreams(objs);
  const pages = orderedPages(objs);
  const warnings = [];
  const texts = [];
  for (const pn of pages) {
    const page = objs.get(pn);
    const fonts = fontsForPage(objs, page.dict);
    let refs = [];
    const arr = page.dict.match(/\/Contents\s*\[([^\]]*)\]/);
    if (arr) refs = [...arr[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
    else { const r = refOf(page.dict, 'Contents'); if (r) refs = [r]; }
    let content = '';
    for (const r of refs) {
      const data = decodeStream(objs.get(r));
      if (data) content += data.toString('latin1') + '\n';
    }
    texts.push(extractTextFromContent(content, fonts).trim());
  }
  const text = texts.join('\n\n').trim();
  if (!text) warnings.push('No extractable text found (the PDF may be scanned images; OCR is not supported).');
  return { text, pages: pages.length, warnings };
}
