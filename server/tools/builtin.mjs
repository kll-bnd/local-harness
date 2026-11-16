// Built-in tools for the agent loop. Each tool: { name, description, parameters, available(ctx), run(args, ctx) }.
// run() returns { content: string (what the model sees), isError?, data? (for the UI), images? }.
import { evaluate, formatNumber } from './calculate.mjs';
import { anyBlocking } from '../security/egress.mjs';
import { fetchUrl } from './fetch-url.mjs';
import { ASPECTS } from '../image/defaults.mjs';
import { imageRef } from '../image/gallery.mjs';
import { isAbortError } from '../lib/errors.mjs';
import { normalizeUrl } from '../lib/url.mjs';

const memoryOn = (ctx) => ctx.settings.memory?.enabled !== false && !ctx.chat?.incognito;

export const BUILTIN_TOOLS = [
  {
    name: 'remember',
    shortDescription: 'Save a lasting fact about the user to long-term memory, as one third-person sentence.',
    description: 'Save a durable fact about the user to long-term memory (preferences, personal details, ongoing projects, standing instructions). Use when the user asks you to remember something or shares lasting information. Write one self-contained sentence in third person, e.g. "The user prefers metric units."',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact to remember, as one self-contained sentence.' },
        category: { type: 'string', enum: ['fact', 'preference', 'project', 'instruction', 'other'] },
      },
      required: ['content'],
    },
    available: memoryOn,
    async run(args, ctx) {
      if (!args.content) return { content: 'Error: content is required', isError: true };
      // In a turn where untrusted text (web pages, documents, past snippets, tool output) is in the context, a
      // memory may have been planted by that text: it is saved as "needs review" and not used until confirmed.
      const r = await ctx.app.memories.add({ content: String(args.content), category: args.category || 'other', origin: 'tool', source: { chatId: ctx.chat.id, messageId: ctx.messageId }, needsReview: !!ctx.tainted });
      if (r.action === 'rejected') return { content: 'Not saved: that looks like a password, key or other secret, and secrets are never stored in memory.', data: { action: 'rejected', reason: r.reason } };
      ctx.emit('memory', { action: r.action, memory: r.memory, origin: 'tool' });
      const review = r.memory.needsReview ? ' It will be used once the user confirms it (it was saved while untrusted content was in the conversation).' : '';
      return { content: r.action === 'added' ? `Saved to memory: "${r.memory.content}".${review}` : r.action === 'updated' ? `Updated an existing memory: "${r.memory.content}"` : 'That is already in memory.', data: { action: r.action, memoryId: r.memory.id, needsReview: !!r.memory.needsReview } };
    },
  },
  {
    name: 'recall',
    shortDescription: 'Search long-term memory and past conversations.',
    description: 'Search long-term memory and past conversations for information about the user or earlier discussions. Use when the user refers to something from before that is not in the current conversation.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for.' },
        scope: { type: 'string', enum: ['memories', 'chats', 'all'], description: 'Where to search (default all).' },
      },
      required: ['query'],
    },
    available: (ctx) => !ctx.chat?.incognito && (ctx.settings.memory?.enabled !== false || ctx.settings.recall?.enabled !== false),
    async run(args, ctx) {
      const q = String(args.query || '').trim();
      if (!q) return { content: 'Error: query is required', isError: true };
      const scope = args.scope || 'all';
      const emb = await ctx.app.embedder.embed([q], { kind: 'query', signal: ctx.signal }).catch(() => null);
      const qv = emb ? { model: emb.model, vec: emb.vectors[0] } : null;
      const lines = [];
      const data = { memories: [], chats: [] };
      if (scope !== 'chats' && ctx.settings.memory?.enabled !== false) {
        const mem = ctx.app.memories.search(q, { k: 8, queryVector: qv, minSimilarity: Math.min(0.4, ctx.settings.memory?.minSimilarity ?? 0.5) });
        for (const r of mem) { lines.push(`- [memory] ${r.memory.content}`); data.memories.push({ id: r.memory.id, score: r.score }); }
      }
      if (scope !== 'memories' && ctx.settings.recall?.enabled !== false) {
        const hits = ctx.app.recall.search(q, { k: 4, queryVector: qv, excludeChatId: ctx.chat.id, minSimilarity: 0.45 });
        for (const h of hits) { lines.push(`- [chat "${h.chatTitle}", ${h.date}] ${h.text.slice(0, 600)}`); data.chats.push({ chatId: h.chatId, score: h.score }); }
      }
      return { content: lines.length ? `Found:\n${lines.join('\n')}` : 'Nothing relevant found.', data };
    },
  },
  {
    name: 'get_current_time',
    description: 'Get the current date and time (optionally in a specific IANA time zone such as "Europe/Paris").',
    parameters: { type: 'object', properties: { timezone: { type: 'string', description: 'IANA time zone name; defaults to the computer\'s local zone.' } } },
    available: () => true,
    async run(args) {
      const now = new Date();
      let tz = args.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      let local;
      try {
        local = new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' }).format(now);
      } catch {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        local = new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' }).format(now);
      }
      return { content: `${local} (time zone ${tz}; ISO ${now.toISOString()})`, data: { iso: now.toISOString(), timezone: tz, local } };
    },
  },
  {
    name: 'calculate',
    shortDescription: 'Evaluate a math expression exactly (+ - * / ^ !, sqrt, log, sin, round(x, d), pi, e).',
    description: 'Evaluate a math expression exactly. Supports + - * / % ^ !, parentheses, sqrt, ln, log, log2, sin/cos/tan (radians; sind/cosd/tand for degrees), round(x, digits), min, max, abs, floor, ceil, pi, e. Use for any non-trivial arithmetic instead of computing in your head.',
    parameters: { type: 'object', properties: { expression: { type: 'string', description: 'e.g. "(17.5 * 3) / sqrt(2)"' } }, required: ['expression'] },
    available: () => true,
    async run(args) {
      try {
        const v = evaluate(String(args.expression ?? ''));
        return { content: `${args.expression} = ${formatNumber(v)}`, data: { value: v } };
      } catch (e) {
        return { content: `Error: ${e.message}`, isError: true };
      }
    },
  },
  {
    name: 'fetch_url',
    shortDescription: 'Download a web page as text (only for URLs the user gives or asks about).',
    description: 'Download a web page and return its readable text. Only use when the user provides a URL or explicitly asks you to look something up online.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full http(s) URL.' } }, required: ['url'] },
    // Not offered to the model while internet access is blocked (docs/API.md §10.6).
    available: () => !anyBlocking(),
    async run(args, ctx) {
      const cfg = ctx.settings.tools?.fetchUrl || {};
      const raw = String(args.url || '');
      // Enforced in code, not in the prompt: only links the user wrote in this chat can be opened, so text
      // injected by a document / web page / tool result cannot make the model exfiltrate data via a URL.
      if (raw.length > 2048) return { content: 'Error: URL is too long (max 2048 characters).', isError: true };
      const norm = normalizeUrl(raw);
      if (!norm) return { content: `Error: not a valid http(s) URL: ${raw.slice(0, 200)}`, isError: true };
      if (new URL(norm).search.length > 1024) return { content: 'Error: URL query string is too long.', isError: true };
      if (!ctx.allowedUrls?.has(norm)) return { content: 'Error: fetch_url can only open links that the user wrote in this conversation. Ask the user to paste the link if they want you to read it.', isError: true, data: { blocked: 'not_user_supplied' } };
      try {
        const r = await fetchUrl(norm, { allowPrivateNetwork: !!cfg.allowPrivateNetwork, maxChars: cfg.maxChars || 20000, signal: ctx.signal });
        return { content: `${r.title ? `# ${r.title}\n` : ''}URL: ${r.url} (HTTP ${r.status})\n\n${r.text}`, data: { url: r.url, status: r.status, title: r.title, truncated: r.truncated } };
      } catch (e) {
        if (isAbortError(e) && ctx.signal?.aborted) throw e;
        if (e?.code === 'offline_lock') return { content: 'Error: internet access is blocked in Harness, so web pages cannot be opened. The user can allow it for a few minutes in Harness.', isError: true, data: { blocked: 'offline_lock', error: { code: 'offline_lock', details: e.details } } };
        return { content: `Error fetching ${args.url}: ${e.message}`, isError: true };
      }
    },
  },
  {
    name: 'generate_image',
    shortDescription: 'Create an image with the local image generator, only when the user asks for a picture. prompt: concrete English visual description (subject, details, setting, lighting, style), comma-separated; unwanted things go in negative_prompt.',
    description:
      'Create an image with the local image generator. Call this ONLY when the user asks you to create, draw, paint, render, design or visualize a picture — not when they merely mention or ask about images. ' +
      'Write `prompt` in English as a concrete visual description for a diffusion model: main subject first, then details, setting, lighting, style/medium, comma-separated. ' +
      'Example: "a red fox curled up in fresh snow, early morning golden light, soft background blur, detailed fur, wildlife photography". ' +
      'Describe what should be visible; do not write instructions or negations in `prompt` — put unwanted things in `negative_prompt` (e.g. "blurry, text, watermark"). ' +
      'After it returns, reply with one or two sentences about what you made; the user already sees the image.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Visual description: subject, details, setting, lighting, style.' },
        negative_prompt: { type: 'string', description: 'Things to avoid, comma-separated (optional).' },
        aspect: { type: 'string', enum: Object.keys(ASPECTS), description: 'Image shape (default square).' },
        seed: { type: 'integer', description: 'Reuse a previous seed to make a variation of the same image (optional).' },
      },
      required: ['prompt'],
    },
    available: (ctx) => ctx.imageAvailable === true,
    async run(args, ctx) {
      const prompt = String(args.prompt || '').trim();
      if (!prompt) return { content: 'Error: prompt is required', isError: true };
      const req = { prompt, negativePrompt: args.negative_prompt || undefined, aspect: ASPECTS[args.aspect] ? args.aspect : undefined, seed: Number.isInteger(args.seed) ? args.seed : undefined };
      try {
        const { job, images } = await ctx.app.images.generate(req, {
          signal: ctx.signal,
          emit: (type, data) => ctx.emit(type, { ...data, toolCallId: ctx.toolCallId, messageId: ctx.messageId, toolMessageId: ctx.toolMessageId }),
          chatId: ctx.chat.id,
          messageId: ctx.toolMessageId,
          source: 'tool',
          toolCallId: ctx.toolCallId,
          leaseOwner: ctx.leaseOwner || null,
        });
        const p = job.params;
        const refs = images.map(imageRef);
        return {
          content: `Generated ${images.length} image${images.length > 1 ? 's' : ''} (${p.width}×${p.height}, seed ${images[0]?.seed ?? p.seed}${images[0]?.model ? `, model ${images[0].model}` : ''}). It is now shown to the user.`,
          data: { jobId: job.id, imageIds: images.map((i) => i.id) },
          images: refs,
        };
      } catch (e) {
        if (isAbortError(e)) throw e;
        return { content: `Image generation failed: ${e.message}`, isError: true };
      }
    },
  },
];

/** OpenAI/Ollama tool schemas. `compact` uses shorter descriptions (small context windows). */
export function toolSchemas(tools, { compact = false } = {}) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: compact && t.shortDescription ? t.shortDescription : t.description, parameters: t.parameters } }));
}

/** Tools enabled for this request (settings flags + availability). */
export function enabledTools(ctx) {
  const s = ctx.settings.tools || {};
  if (s.enabled === false) return [];
  return BUILTIN_TOOLS.filter((t) => (s.builtin?.[t.name] ?? false) && t.available(ctx));
}
