// Parsers for streamed HTTP bodies (web ReadableStream from fetch).

export async function* readLines(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      yield line;
    }
  }
  buf += decoder.decode();
  if (buf.length) yield buf.replace(/\r$/, '');
}

/** NDJSON (Ollama native streaming). Yields parsed objects. */
export async function* readNdjson(body) {
  for await (const line of readLines(body)) {
    const t = line.trim();
    if (!t) continue;
    try {
      yield JSON.parse(t);
    } catch {
      // ignore malformed line
    }
  }
}

/** Server-Sent Events (OpenAI-style streaming). Yields `{ event, data }` with data as raw string. */
export async function* readSse(body) {
  let event = null;
  let data = [];
  for await (const line of readLines(body)) {
    if (line === '') {
      if (data.length) yield { event, data: data.join('\n') };
      event = null;
      data = [];
      continue;
    }
    if (line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }
  if (data.length) yield { event, data: data.join('\n') };
}
