// Prompt assembly: stored message path → provider-neutral messages within the token budget,
// with a per-section usage breakdown.
//
// Layout (prefix-cache friendly — the part that changes every turn is at the end):
//   [system]  base prompt + date + pinned memories (+ all memories if placement=system) + rolling summary
//   [history] messages after the summary boundary, verbatim (reasoning stripped)
//   [last user message] ← ephemeral <context> block (retrieved memories, document excerpts, past-chat snippets)
import { PROMPT_OVERHEAD } from './tokens.mjs';
import { summaryBlock, memoryBlock, turnContextBlock, escapeUntrusted, untrustedBlock, UNTRUSTED_NOTE } from '../chat/prompts.mjs';

/** Tool results that carry text from outside (web pages, past chats) — rendered as untrusted data. */
export const UNTRUSTED_TOOLS = new Set(['fetch_url', 'recall']);
import { stripThinking } from '../chat/reasoning.mjs';
import { truncateMiddle } from '../lib/util.mjs';

/** Indices where a new "group" starts (a user message, or the very first message). */
export function groupStarts(msgs) {
  const out = [];
  msgs.forEach((m, i) => { if (i === 0 || m.role === 'user') out.push(i); });
  return out;
}

/**
 * Safe split points inside a message list: index i such that msgs[i] is not a tool result and
 * msgs[i-1] is not an assistant message with pending tool calls (never split a call from its result).
 */
export function safeSplitPoints(msgs) {
  const out = [];
  for (let i = 1; i < msgs.length; i++) {
    const prev = msgs[i - 1];
    if (msgs[i].role === 'tool') continue;
    if (prev.role === 'assistant' && prev.toolCalls?.length) continue;
    out.push(i);
  }
  return out;
}

/**
 * Message renderer factory: stored Message → neutral message (or null to skip) with token cost.
 */
export function makeRenderer({ attachments, counter, inlineMaxTokens, vision, imageIndexAllowed, feedbackImages = false, gallery = null, providerKind = 'ollama' }) {
  const docs = new Set();
  const untrusted = { flag: false };
  const render = async (m, index) => {
    if (m.role === 'system') return null;
    if (m.role === 'user') {
      if (m.kind === 'image_request') {
        return { role: 'user', content: `[The user generated an image with the prompt: "${m.content}"]`, _id: m.id };
      }
      const files = [];
      const notes = [];
      const images = [];
      for (const ref of m.attachments || []) {
        const a = attachments.tryGet(ref.id);
        if (!a) { notes.push(`[Attachment "${ref.name || ref.id}" was removed]`); continue; }
        if (a.kind === 'image') {
          if (vision && imageIndexAllowed(index)) { images.push({ mime: a.mime, base64: (await attachments.readOriginal(a.id)).toString('base64'), name: a.name }); untrusted.flag = true; }
          else notes.push(`[Image attached: ${a.name}${vision ? '' : ' (this model cannot see images)'}]`);
        } else if (a.kind === 'text') {
          if ((a.tokens || 0) <= inlineMaxTokens) {
            const text = await attachments.readText(a.id);
            files.push(`<file name="${escapeUntrusted(a.name).replace(/"/g, "'")}">\n${escapeUntrusted(text ?? '')}\n</file>`);
            untrusted.flag = true;
          } else {
            docs.add(a.id);
            untrusted.flag = true;
            notes.push(`[Document attached: ${a.name} (~${a.tokens} tokens, ${a.chunks} parts). Relevant excerpts are provided in <context> when they match the question.]`);
          }
        } else {
          notes.push(`[Attachment "${a.name}" could not be read: ${a.error || 'unsupported type'}]`);
        }
      }
      const content = [...files, ...notes, m.content || ''].filter(Boolean).join('\n\n');
      return { role: 'user', content, ...(images.length ? { images } : {}), _id: m.id };
    }
    if (m.role === 'assistant') {
      if (m.kind === 'image_result') {
        const n = m.images?.length || 0;
        return { role: 'assistant', content: n ? `[Generated ${n} image${n > 1 ? 's' : ''} for that prompt; they are shown to the user.]` : '[Image generation failed.]', _id: m.id };
      }
      const content = stripThinking(m.content || '');
      const toolCalls = m.toolCalls?.length ? m.toolCalls : null;
      if (!content && !toolCalls) return null; // empty / failed generation
      return { role: 'assistant', content, ...(toolCalls ? { toolCalls } : {}), _id: m.id };
    }
    if (m.role === 'tool') {
      const isUntrusted = UNTRUSTED_TOOLS.has(m.toolName);
      if (isUntrusted) untrusted.flag = true;
      const out = { role: 'tool', content: isUntrusted ? untrustedBlock(m.toolName, m.content || '') : m.content || '', toolCallId: m.toolCallId, toolName: m.toolName, _id: m.id };
      if (feedbackImages && vision && m.images?.length && gallery) {
        out.images = [];
        for (const ref of m.images) {
          const r = gallery.tryGet(ref.id);
          if (r) out.images.push({ mime: r.mime, base64: (await gallery.read(r.id)).toString('base64'), name: r.id });
        }
        if (!out.images.length) delete out.images;
      }
      return out;
    }
    return null;
  };
  return { render, docs, providerKind, untrusted, tokens: (nm) => (nm ? counter.message(nm) : 0) };
}

/** Attachment ids on `path` that are too large to inline and therefore use document retrieval. */
export function documentAttachmentIds(path, attachments, inlineMaxTokens) {
  const ids = [];
  for (const m of path) {
    if (m.role !== 'user') continue;
    for (const ref of m.attachments || []) {
      const a = attachments.tryGet(ref.id);
      if (a && a.kind === 'text' && (a.tokens || 0) > inlineMaxTokens) ids.push(a.id);
    }
  }
  return [...new Set(ids)];
}

/**
 * Repair a neutral message list so every backend/template accepts it:
 * drop orphan tool results, strip tool calls without results, merge consecutive user messages,
 * ensure the first non-system message is a user message, and (OpenAI) move tool-result images
 * into a following user message.
 */
export function normalizeMessages(list, { providerKind = 'ollama' } = {}) {
  const out = [];
  let lastNonTool = null;
  // pass 1: tool-call integrity
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const ids = new Set();
      let j = i + 1;
      while (j < list.length && list[j].role === 'tool') { ids.add(list[j].toolCallId); j++; }
      const kept = m.toolCalls.filter((c) => ids.has(c.id));
      const mm = { ...m };
      if (kept.length) mm.toolCalls = kept; else delete mm.toolCalls;
      if (!mm.toolCalls && !mm.content) continue;
      out.push(mm);
      lastNonTool = mm;
      continue;
    }
    if (m.role === 'tool') {
      const prevAsst = lastNonTool;
      if (!prevAsst || prevAsst.role !== 'assistant' || !prevAsst.toolCalls?.some((c) => c.id === m.toolCallId)) continue;
    }
    out.push(m);
    if (m.role !== 'tool') lastNonTool = m;
  }
  // pass 2: merge consecutive user messages, fix leading role
  const merged = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === 'user' && m.role === 'user') {
      merged[merged.length - 1] = { ...last, content: [last.content, m.content].filter(Boolean).join('\n\n'), images: [...(last.images || []), ...(m.images || [])] };
      if (!merged[merged.length - 1].images.length) delete merged[merged.length - 1].images;
      continue;
    }
    merged.push(m);
  }
  const firstNonSystem = merged.findIndex((m) => m.role !== 'system');
  if (firstNonSystem >= 0 && merged[firstNonSystem].role !== 'user') {
    merged.splice(firstNonSystem, 0, { role: 'user', content: '(Continuing the conversation summarized above.)' });
  }
  if (providerKind !== 'ollama') {
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i];
      if (m.role === 'tool' && m.images?.length) {
        const imgs = m.images;
        merged[i] = { ...m };
        delete merged[i].images;
        let j = i + 1;
        while (j < merged.length && merged[j].role === 'tool') j++;
        merged.splice(j, 0, { role: 'user', content: 'Here is the generated image for your review.', images: imgs });
      }
    }
  }
  return merged.map(({ _id, ...m }) => m);
}

/**
 * Assemble a request.
 * @returns {{ messages, usage, live, liveTokens, fixedTokens, needsCompaction, overBudget, truncation, rawEstimate, hasImages, docIds }}
 */
export async function assemble({
  path, summary = null, baseSystem = '', dateLine = '', pinnedMemories = [], retrieval = {}, placement = 'turn',
  tools = [], counter, budgets, renderer,
}) {
  const idx = summary ? path.findIndex((m) => m.id === summary.upToMessageId) : -1;
  const live = idx >= 0 ? path.slice(idx + 1) : path.slice();
  const rendered = [];
  for (let i = 0; i < live.length; i++) rendered.push(await renderer.render(live[i], i - live.length));
  const liveTokens = rendered.map((r) => renderer.tokens(r));

  const memSystem = placement === 'system' ? [...pinnedMemories, ...(retrieval.memories || [])] : pinnedMemories;
  const memTurn = placement === 'system' ? [] : retrieval.memories || [];
  const sysBase = [baseSystem.trim(), dateLine, UNTRUSTED_NOTE].filter(Boolean).join('\n\n');
  const sysMem = memSystem.length ? memoryBlock(memSystem) : '';
  const sysSummary = summary?.content ? summaryBlock(summary.content) : '';
  const systemText = [sysBase, sysMem, sysSummary].filter(Boolean).join('\n\n');

  const ctxMem = turnContextBlock({ memories: memTurn });
  const ctxDocs = turnContextBlock({ documents: retrieval.documents || [] });
  const ctxRecall = turnContextBlock({ recall: retrieval.recall || [] });
  const turnCtx = turnContextBlock({ memories: memTurn, documents: retrieval.documents || [], recall: retrieval.recall || [] });

  const breakdown = {
    system: counter.text(sysBase) + 4 + PROMPT_OVERHEAD,
    tools: counter.tools(tools),
    memories: counter.text(sysMem) + counter.text(ctxMem),
    summary: counter.text(sysSummary),
    documents: counter.text(ctxDocs),
    recall: counter.text(ctxRecall),
    history: liveTokens.reduce((a, b) => a + b, 0),
  };
  const fixedTokens = breakdown.system + breakdown.tools + breakdown.memories + breakdown.summary + breakdown.documents + breakdown.recall;
  let total = fixedTokens + breakdown.history;
  const needsCompaction = total > budgets.compactAt;

  // Hard truncation (fallback when compaction is off/failed or the tail itself is too big).
  let start = 0;
  let truncation = null;
  if (total > budgets.input) {
    const starts = groupStarts(live).filter((s) => s > 0);
    const splits = [...new Set([...starts, ...safeSplitPoints(live)])].sort((a, b) => a - b);
    let dropped = 0;
    for (const s of splits) {
      if (total <= budgets.input) break;
      if (s >= live.length) break;
      // never drop the final user message (the question being answered)
      const lastUser = live.map((m) => m.role).lastIndexOf('user');
      if (s > lastUser && lastUser >= 0) break;
      const removed = liveTokens.slice(start, s).reduce((a, b) => a + b, 0);
      total -= removed;
      dropped += s - start;
      start = s;
    }
    truncation = { droppedMessages: dropped, truncatedMessages: 0 };
  }
  const kept = rendered.slice(start).map((r) => (r ? { ...r } : null));
  const keptTokens = liveTokens.slice(start);
  if (total > budgets.input) {
    // Still too big: middle-truncate the largest messages (never below ~200 tokens each).
    const order = keptTokens.map((t, i) => [t, i]).sort((a, b) => b[0] - a[0]);
    for (const [t, i] of order) {
      if (total <= budgets.input) break;
      const m = kept[i];
      if (!m || !m.content || t < 300) continue;
      const excess = total - budgets.input;
      const targetTok = Math.max(200, t - excess - 50);
      const ratio = targetTok / t;
      const newContent = truncateMiddle(m.content, Math.max(400, Math.floor(m.content.length * ratio)));
      const newTok = counter.message({ ...m, content: newContent });
      total -= t - newTok;
      kept[i] = { ...m, content: newContent };
      keptTokens[i] = newTok;
      truncation = truncation || { droppedMessages: 0, truncatedMessages: 0 };
      truncation.truncatedMessages++;
    }
  }
  breakdown.history = keptTokens.reduce((a, b) => a + b, 0);

  // Build final list; attach turn context to the latest user message.
  const list = [{ role: 'system', content: systemText }, ...kept.filter(Boolean)];
  if (turnCtx) {
    for (let i = list.length - 1; i > 0; i--) {
      if (list[i].role === 'user') { list[i] = { ...list[i], content: turnCtx + list[i].content }; break; }
    }
  }
  const messages = normalizeMessages(list, { providerKind: renderer.providerKind || 'ollama' });
  const used = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const rawEstimate = messages.reduce((a, m) => a + counter.messageRaw(m), 0) + counter.toolsRaw(tools) + PROMPT_OVERHEAD;
  return {
    messages,
    usage: {
      numCtx: budgets.numCtx,
      budget: budgets.input,
      replyReserve: budgets.replyReserve,
      compactAt: budgets.compactAt,
      used,
      percent: Math.round((used / budgets.numCtx) * 1000) / 10,
      breakdown,
      estimated: true,
      calibration: counter.factor,
    },
    live,
    liveTokens,
    fixedTokens,
    needsCompaction,
    overBudget: used > budgets.input,
    truncation,
    rawEstimate,
    hasImages: messages.some((m) => m.images?.length),
    docIds: [...renderer.docs],
    // Text we did not write (files, documents, web pages, past-chat snippets, attached images) is in this request.
    untrusted: !!(renderer.untrusted?.flag || (retrieval.documents || []).length || (retrieval.recall || []).length),
  };
}
