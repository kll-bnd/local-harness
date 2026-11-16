import zlib from 'node:zlib';

/** Build a small valid multi-page PDF with Flate-compressed content streams. */
export function buildPdf(pageContents) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const catalog = add(null);
  const pages = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const content of pageContents) {
    const data = zlib.deflateSync(Buffer.from(content, 'latin1'));
    const cs = add({ dict: `<< /Length ${data.length} /Filter /FlateDecode >>`, data });
    kids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${cs} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objs[pages - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  objs.forEach((o, i) => {
    if (typeof o === 'string') parts.push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1'));
    else parts.push(Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, 'latin1'), o.data, Buffer.from('\nendstream\nendobj\n', 'latin1'));
  });
  parts.push(Buffer.from(`trailer\n<< /Root ${catalog} 0 R /Size ${objs.length + 1} >>\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
