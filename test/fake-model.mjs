import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Deterministic "model brain" shared by the fake Ollama and fake OpenAI-compatible servers.
// It recognises Harness's internal prompts (summaries, memory extraction, titles) and a few trigger
// phrases that make it call tools, so the whole pipeline can be exercised without a real LLM.
//
// Chat trigger phrases (only when the matching tool is offered in the request):
//   "what time is it"            → get_current_time {}
//   "calculate <expr>"           → calculate {expression}
//   "please remember <fact>"     → remember {content}
//   "draw <subject>" / "generate an image of <subject>" → generate_image {prompt}
//   "fetch <url>"                → fetch_url {url}
//   "recall <query>"             → recall {query}
//   "loop forever"               → get_current_time on every turn (tests the iteration cap)
//   "use tool <name> <json>"     → any tool with JSON arguments
// "silent after tools" / "always silent" → empty final answer after tool results.
// Other behaviours: "long answer N" → N words; thinking models think first; deepseek-r1 uses inline
// <think> tags; replies after tool results quote the result.

export function fakeTokenCount(messages, tools) {
  let n = 3;
  for (const m of messages) {
    const c = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.text || '').join(' ') : '';
    n += 4 + Math.ceil(c.length / 3.5);
    const imgs = (m.images?.length || 0) + (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0);
    n += imgs * 258;
    if (m.tool_calls) n += Math.ceil(JSON.stringify(m.tool_calls).length / 3.5);
  }
  if (tools?.length) n += Math.ceil(JSON.stringify(tools).length / 3.5);
  return n;
}

const textOf = (m) => (typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : '');

function stripContext(t) {
  return t.replace(/<context>[\s\S]*?<\/context>\s*/g, '').replace(/<file name="[^"]*">[\s\S]*?<\/file>\s*/g, '').trim();
}

function titleCase(s) {
  return s.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function facts(text) {
  const out = [];
  for (const m of text.matchAll(/FACT:\s*([^\n]+?)(?=\s*(?:FACT:|\n|$))/g)) {
    const f = m[1].trim().replace(/[.;,]+$/, '');
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

function summaryOutput(allText, spanText) {
  const fs = facts(allText);
  const msgs = (spanText.match(/^(User|Assistant|Tool result[^:]*):/gm) || []).length;
  return [
    '## Goals', '- Continue helping the user.',
    '## Key facts & context', ...(fs.length ? fs.map((f) => `- FACT: ${f}`) : ['- (none)']),
    `- Span covered ${msgs} message(s).`,
    '## Decisions', '- (none)',
    '## User preferences', '- (none)',
    '## Code & artifacts', '- (none)',
    '## Open threads', '- (none)',
  ].join('\n');
}

function memoryOutput(userContent) {
  const conv = (userContent.match(/<conversation>([\s\S]*?)<\/conversation>/) || [])[1] || '';
  const existing = [...userContent.matchAll(/^\[(mem_[^\]]+)\]\s*(.+)$/gm)].map((m) => ({ id: m[1], content: m[2] }));
  const userLines = conv.split('\n').filter((l) => l.startsWith('User:')).map((l) => l.slice(5).trim()).join(' ');
  const out = [];
  const push = (content, category) => {
    const key = content.split(' ').slice(0, 4).join(' ').toLowerCase();
    const ex = existing.find((e) => e.content.toLowerCase().startsWith(key));
    if (ex && ex.content === content) return;
    out.push(ex ? { action: 'update', id: ex.id, content, category } : { action: 'add', content, category });
  };
  let m;
  if ((m = userLines.match(/\bmy name is ([A-Z][\w-]+)/i))) push(`The user's name is ${m[1]}.`, 'fact');
  if ((m = userLines.match(/\bI (?:really )?(?:prefer|like|love) ([^.!?\n]+)/i))) push(`The user prefers ${m[1].trim()}.`, 'preference');
  if ((m = userLines.match(/\bI(?:'m| am) working on ([^.!?\n]+)/i))) push(`The user is working on ${m[1].trim()}.`, 'project');
  if ((m = userLines.match(/\bmy (?:api key|password) is (\S+)/i))) push(`The user's password is ${m[1]}.`, 'fact');
  if ((m = userLines.match(/\bI live in ([A-Z][\w -]+)/))) push(`The user lives in ${m[1].trim()}.`, 'fact');
  return JSON.stringify({ memories: out });
}

/**
 * @param {object} req { model, messages (Ollama or OpenAI shaped), tools, think, capabilities }
 * @returns {{ thinking: string, content: string, toolCalls: Array<{name, arguments}> }}
 */
export function respond({ model, messages, tools, think, capabilities = [] }) {
  const sys = messages.filter((m) => m.role === 'system').map(textOf).join('\n');
  const last = messages[messages.length - 1] || {};
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const userText = stripContext(textOf(lastUser));
  const toolNames = new Set((tools || []).map((t) => t.function?.name || t.name));

  // ---- internal Harness tasks
  if (/You maintain a running summary/.test(sys)) {
    const u = textOf(lastUser);
    const span = (u.match(/<conversation_span>([\s\S]*?)<\/conversation_span>/) || [])[1] || '';
    return { thinking: '', content: summaryOutput(u, span), toolCalls: [] };
  }
  if (/You take notes on one part/.test(sys)) {
    const fs = facts(textOf(lastUser));
    return { thinking: '', content: fs.length ? fs.map((f) => `- FACT: ${f}`).join('\n') : '- (no facts in this part)', toolCalls: [] };
  }
  if (/You extract durable long-term memories/.test(sys)) return { thinking: '', content: memoryOutput(textOf(lastUser)), toolCalls: [] };
  if (/^Write a short, specific title/.test(textOf(lastUser))) {
    const u = (textOf(lastUser).match(/User: (.+)/) || [])[1] || 'Chat';
    return { thinking: '', content: `Title: "${titleCase(u.replace(/[^\w\s]/g, ' ').split(/\s+/).slice(0, 4).join(' '))}"`, toolCalls: [] };
  }

  // ---- after tool results
  if (last.role === 'tool') {
    // "silent after tools": like Nemotron after generate_image — an EMPTY final message (no text, no tool calls)
    // while tools are offered; "always silent" also stays empty when asked again without tools.
    if (/silent after tools/i.test(userText) && (tools?.length || /always silent/i.test(userText))) return { thinking: '', content: '', toolCalls: [] };
    const results = [];
    for (let i = messages.length - 1; i >= 0 && messages[i].role === 'tool'; i--) results.unshift(messages[i]);
    const loop = /loop forever/i.test(userText) && toolNames.has('get_current_time');
    if (loop) return { thinking: '', content: '', toolCalls: [{ name: 'get_current_time', arguments: {} }] };
    const names = results.map((r) => r.tool_name || r.name || 'tool');
    return { thinking: '', content: `Tool ${names.join(', ')} returned: ${results.map((r) => textOf(r).slice(0, 200)).join(' | ')}`, toolCalls: [] };
  }

  // ---- tool triggers
  const call = (name, args) => (toolNames.has(name) ? { thinking: '', content: '', toolCalls: [{ name, arguments: args }] } : null);
  let m;
  let r = null;
  if (!r && /what time is it|current time/i.test(userText)) r = call('get_current_time', {});
  if (!r && /loop forever/i.test(userText)) r = call('get_current_time', {});
  if (!r && (m = userText.match(/\bcalculate\s+(.+?)\s*$/i))) r = call('calculate', { expression: m[1] });
  if (!r && (m = userText.match(/\bplease remember (?:that )?(.+?)\s*$/i))) r = call('remember', { content: m[1] });
  if (!r && (m = userText.match(/\b(?:draw|paint|generate an image of|create an image of|make an image of)\s+(.+?)\s*$/i))) r = call('generate_image', { prompt: m[1], aspect: /wide|landscape/i.test(m[1]) ? 'landscape' : 'square' });
  if (!r && (m = userText.match(/\bfetch (https?:\/\/\S+)/i))) r = call('fetch_url', { url: m[1] });
  if (!r && (m = userText.match(/\brecall (.+?)\s*$/i))) r = call('recall', { query: m[1] });
  if (!r && (m = userText.match(/\buse tool (\w+)\s*(\{.*\})?\s*$/i))) { try { r = call(m[1], m[2] ? JSON.parse(m[2]) : {}); } catch { r = null; } }
  if (r) return r;

  // ---- plain answer
  let content = `You said: ${userText.slice(0, 300)}`;
  const imgCount = (lastUser?.images?.length || 0) + (Array.isArray(lastUser?.content) ? lastUser.content.filter((p) => p.type === 'image_url').length : 0);
  if (imgCount) content += ` [I see ${imgCount} image(s)]`;
  if (/## Summary of the earlier conversation/.test(sys)) content += ' [summary present]';
  if ((m = userText.match(/long answer (\d+)/i))) content += ' ' + Array.from({ length: Number(m[1]) }, (_, i) => `word${i}`).join(' ');
  let thinking = '';
  const inline = /deepseek-r1|inline-think/.test(model);
  if (inline) content = `<think>Reasoning about: ${userText.slice(0, 60)}</think>\n\n${content}`;
  else if (think && capabilities.includes('thinking')) thinking = `Thinking about: ${userText.split(/\s+/).slice(0, 8).join(' ')}`;
  return { thinking, content, toolCalls: [] };
}

/** Split text into stream chunks (keeps tags splittable across chunks to test parsers). */
export function chunkText(text, size = 7) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Deterministic bag-of-words embedding (64 dims) so retrieval tests are meaningful. */
export function fakeEmbedding(text, dims = 64) {
  const v = new Array(dims).fill(0);
  const words = String(text).toLowerCase().replace(/^(task:[^|]*\|\s*query:|title:[^|]*\|\s*text:|search_query:|search_document:)/, '').match(/[a-z0-9]+/g) || [];
  for (const w of words) {
    if (w.length < 3) continue;
    const stem = w.replace(/(ing|ed|es|s)$/, '');
    let h = 2166136261;
    for (const ch of stem) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    v[Math.abs(h) % dims] += 1;
  }
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / n);
}

export async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

export function sendJson(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[k] = v;
    }
  }
  return out;
}

export function isCli(metaUrl) {
  if (process.env.NODE_TEST_CONTEXT || !process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === metaUrl;
}
