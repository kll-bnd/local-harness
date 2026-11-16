// Bridge framing (docs/BRIDGE.md): 4-byte big-endian length N, 1-byte type, 4-byte big-endian stream id,
// N − 5 bytes of payload (at most 1 MiB).
export const T = Object.freeze({
  REQ_HEAD: 0x01, REQ_BODY: 0x02, REQ_END: 0x03, CANCEL: 0x04, CONTROL: 0x05,
  RES_HEAD: 0x11, RES_BODY: 0x12, RES_END: 0x13, EVENT: 0x15,
});
export const MAX_PAYLOAD = 1024 * 1024;
export const PROTOCOL = 1;

export function encodeFrame(type, stream, payload = Buffer.alloc(0)) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  if (p.length > MAX_PAYLOAD) throw new RangeError('frame payload above 1 MiB');
  const h = Buffer.alloc(9);
  h.writeUInt32BE(p.length + 5, 0);
  h.writeUInt8(type, 4);
  h.writeUInt32BE(stream >>> 0, 5);
  return Buffer.concat([h, p]);
}

/** Body bytes as frames of at most 1 MiB each. */
export function* bodyFrames(type, stream, buf) {
  for (let off = 0; off < buf.length; off += MAX_PAYLOAD) yield encodeFrame(type, stream, buf.subarray(off, off + MAX_PAYLOAD));
}

/** Incremental decoder: push bytes, get { type, stream, payload } frames. Throws on a corrupt length. */
export class FrameDecoder {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32BE(0);
      if (n < 5 || n > MAX_PAYLOAD + 5) { const e = new Error(`corrupt frame length ${n}`); e.code = 'corrupt_stream'; throw e; }
      if (this.buf.length < 4 + n) break;
      out.push({ type: this.buf.readUInt8(4), stream: this.buf.readUInt32BE(5), payload: this.buf.subarray(9, 4 + n) });
      this.buf = this.buf.subarray(4 + n);
    }
    if (!this.buf.length) this.buf = Buffer.alloc(0);
    return out;
  }
}
