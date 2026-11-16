// Streaming splitter for inline reasoning tags (<think>…</think>, <thinking>…</thinking>) that may be
// split across chunk boundaries. Text outside tags → content, inside → reasoning.

const OPEN = ['<think>', '<thinking>'];
const CLOSE = { '<think>': '</think>', '<thinking>': '</thinking>' };

export class ThinkTagParser {
  constructor() {
    this.buf = '';
    this.inside = null; // open tag when inside
    this.sawContent = false;
    this.afterClose = false;
  }

  /** Feed a chunk; returns `[{type:'content'|'reasoning', text}]`. */
  push(chunk) {
    this.buf += chunk;
    const out = [];
    const emit = (type, text) => {
      if (!text) return;
      if (type === 'content' && (!this.sawContent || this.afterClose)) {
        // drop leading whitespace at the start of the answer / right after a closing tag
        text = text.replace(/^\s+/, '');
        if (!text) return;
        this.sawContent = true;
        this.afterClose = false;
      }
      const last = out[out.length - 1];
      if (last && last.type === type) last.text += text; else out.push({ type, text });
    };
    for (;;) {
      if (this.inside) {
        const close = CLOSE[this.inside];
        const i = this.buf.indexOf(close);
        if (i >= 0) {
          emit('reasoning', this.buf.slice(0, i));
          this.buf = this.buf.slice(i + close.length);
          this.inside = null;
          this.afterClose = true;
          continue;
        }
        const keep = partialSuffix(this.buf, [close]);
        emit('reasoning', this.buf.slice(0, this.buf.length - keep));
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
      let best = -1;
      let tag = null;
      for (const t of OPEN) {
        const i = this.buf.indexOf(t);
        if (i >= 0 && (best < 0 || i < best)) { best = i; tag = t; }
      }
      if (best >= 0) {
        emit('content', this.buf.slice(0, best));
        this.buf = this.buf.slice(best + tag.length);
        this.inside = tag;
        continue;
      }
      const keep = partialSuffix(this.buf, OPEN);
      emit('content', this.buf.slice(0, this.buf.length - keep));
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }

  /** Flush remaining buffered text at end of stream. */
  end() {
    const rest = this.buf;
    this.buf = '';
    if (!rest) return [];
    if (this.inside) return [{ type: 'reasoning', text: rest }];
    const text = this.sawContent && !this.afterClose ? rest : rest.replace(/^\s+/, '');
    return text ? [{ type: 'content', text }] : [];
  }
}

/** Length of the longest suffix of `s` that is a proper prefix of any tag. */
function partialSuffix(s, tags) {
  let best = 0;
  for (const t of tags) {
    for (let n = Math.min(t.length - 1, s.length); n > 0; n--) {
      if (s.endsWith(t.slice(0, n))) { best = Math.max(best, n); break; }
    }
  }
  return best;
}

/** Remove reasoning blocks from finished text (used when resending history / cleaning titles). */
export function stripThinking(text) {
  if (!text) return text;
  return text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g, '').replace(/^\s*<think(?:ing)?>[\s\S]*$/, '').trim();
}
