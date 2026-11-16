// Auto-summarizer ("compaction"): when the assembled prompt passes the threshold, the oldest span of the
// live history is folded into a rolling structured summary. Incremental (new = f(old summary, newly evicted
// span)), map-reduce for spans larger than the summarizer's context, never splits a tool call from its
// result, and never deletes stored messages — summaries only change what is sent to the model.
import { groupStarts, safeSplitPoints } from './assemble.mjs';
import { summarySystemPrompt, summaryUserPrompt, chunkNotesSystemPrompt, chunkNotesUserPrompt, mergeNotesUserPrompt } from '../chat/prompts.mjs';
import { stripThinking } from '../chat/reasoning.mjs';
import { newId } from '../lib/ids.mjs';
import { nowIso, truncateMiddle } from '../lib/util.mjs';

/** The deepest summary whose boundary message lies on `path` (summaries are valid on every branch through it). */
export function activeSummary(chat, path) {
  if (!chat.summaries?.length) return null;
  const pos = new Map(path.map((m, i) => [m.id, i]));
  let best = null;
  let bestPos = -1;
  for (const s of chat.summaries) {
    const p = pos.get(s.upToMessageId);
    if (p !== undefined && (p > bestPos || (p === bestPos && s.updatedAt > best.updatedAt))) { best = s; bestPos = p; }
  }
  return best;
}

/**
 * Decide what to evict. `live` = messages after the current summary boundary, `liveTokens` their costs.
 * Returns null (nothing to do / nothing evictable) or `{ boundary, evict, evictTokens, keepTokens }`.
 */
export function planCompaction({ live, liveTokens, fixedTokens, budgets, minKeepMessages = 2, force = false }) {
  const n = live.length;
  if (n < 2) return null;
  const total = fixedTokens + liveTokens.reduce((a, b) => a + b, 0);
  if (!force && total <= budgets.compactAt) return null;
  const suffix = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + liveTokens[i];
  const tail = (b) => suffix[b];
  let lastUser = -1;
  for (let i = n - 1; i >= 0; i--) if (live[i].role === 'user') { lastUser = i; break; }
  const limit = lastUser >= 0 ? lastUser : n - 1;
  const tailBudget = Math.max(0, Math.min(budgets.keepRecentTokens, budgets.compactTarget - fixedTokens - budgets.maxSummaryTokens));
  const gs = groupStarts(live).filter((b) => b > 0 && b <= limit);
  const sp = safeSplitPoints(live).filter((b) => b > 0 && b <= limit);
  const choose = (cands) => {
    if (!cands.length) return null;
    const okKeep = cands.filter((b) => n - b >= minKeepMessages);
    const pool = okKeep.length ? okKeep : cands;
    const fit = pool.filter((b) => tail(b) <= tailBudget);
    return fit.length ? Math.min(...fit) : Math.max(...pool);
  };
  let b = choose(gs);
  if (b === null || tail(b) > tailBudget) {
    const b2 = choose([...new Set([...gs, ...sp])].sort((x, y) => x - y));
    if (b2 !== null && (b === null || tail(b2) < tail(b))) b = b2;
  }
  if (b === null || b <= 0) return null;
  return { boundary: b, evict: live.slice(0, b), evictTokens: total - fixedTokens - tail(b), keepTokens: tail(b), tailBudget };
}

/** Plain-text transcript lines for a span of stored messages. */
export function spanLines(span, { maxCharsPerMessage = 6000, attachments = null } = {}) {
  const lines = [];
  for (const m of span) {
    if (m.role === 'user') {
      const att = (m.attachments || []).map((r) => attachments?.tryGet(r.id)?.name || r.name || r.id);
      const prefix = m.kind === 'image_request' ? '[asked for an image] ' : '';
      lines.push(`User: ${prefix}${truncateMiddle(m.content || '', maxCharsPerMessage)}${att.length ? `\n[attached: ${att.join(', ')}]` : ''}`);
    } else if (m.role === 'assistant') {
      const parts = [];
      const c = stripThinking(m.content || '');
      if (c) parts.push(truncateMiddle(c, maxCharsPerMessage));
      for (const tc of m.toolCalls || []) parts.push(`[called tool ${tc.name} ${JSON.stringify(tc.arguments || {}).slice(0, 300)}]`);
      if (m.kind === 'image_result') parts.push(`[generated ${m.images?.length || 0} image(s)]`);
      if (parts.length) lines.push(`Assistant: ${parts.join('\n')}`);
    } else if (m.role === 'tool') {
      lines.push(`Tool result (${m.toolName || 'tool'}): ${truncateMiddle(m.content || '', Math.min(1500, maxCharsPerMessage))}`);
    }
  }
  return lines;
}

function chunkLines(lines, budgetTokens, counter) {
  const chunks = [];
  let cur = [];
  let tok = 0;
  for (const l of lines) {
    const t = counter.text(l) + 2;
    if (tok + t > budgetTokens && cur.length) { chunks.push(cur.join('\n\n')); cur = []; tok = 0; }
    cur.push(t > budgetTokens ? truncateMiddle(l, budgetTokens * 3) : l);
    tok += Math.min(t, budgetTokens);
  }
  if (cur.length) chunks.push(cur.join('\n\n'));
  return chunks;
}

function cleanSummary(text) {
  let t = stripThinking(text || '').trim();
  t = t.replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/i, '').trim();
  return t;
}

/**
 * Summarize `existingSummary` + `span` into a new summary using `complete(messages, {maxTokens})`.
 * `ctxTokens` is the summarizer's context window. Returns `{ content, method, calls }`.
 */
export async function summarizeSpan({ complete, existingSummary, span, counter, ctxTokens, maxSummaryTokens, attachments, signal }) {
  const maxWords = Math.max(60, Math.floor(maxSummaryTokens * 0.7));
  const sys = summarySystemPrompt(maxWords);
  const overhead = counter.text(sys) + 80;
  const existingTok = counter.text(existingSummary || '');
  const replyTok = Math.ceil(maxSummaryTokens * 1.25);
  const singleBudget = ctxTokens - replyTok - overhead - existingTok;
  const lines = spanLines(span, { maxCharsPerMessage: Math.max(800, Math.floor(Math.max(singleBudget, 512) * 2)), attachments });
  const spanText = lines.join('\n\n');
  const spanTok = counter.text(spanText);
  let calls = 0;
  const call = async (system, user, maxTokens) => {
    calls++;
    const out = await complete([{ role: 'system', content: system }, { role: 'user', content: user }], { maxTokens, signal });
    const t = cleanSummary(out);
    if (!t) throw new Error('Summarizer returned an empty response');
    return t;
  };
  if (spanTok <= singleBudget) {
    const content = await call(sys, summaryUserPrompt(existingSummary, spanText), replyTok);
    return { content, method: 'single', calls };
  }
  // Map: notes per chunk.
  const notesWords = Math.max(60, Math.floor(maxSummaryTokens * 0.5));
  const notesSys = chunkNotesSystemPrompt(notesWords);
  const mapBudget = Math.max(256, ctxTokens - Math.ceil(notesWords * 1.6) - counter.text(notesSys) - 80);
  const chunks = chunkLines(lines, mapBudget, counter);
  let notes = [];
  for (let i = 0; i < chunks.length; i++) notes.push(await call(notesSys, chunkNotesUserPrompt(chunks[i], i + 1, chunks.length), Math.ceil(notesWords * 1.6)));
  // Reduce: merge notes until they fit next to the existing summary.
  const reduceBudget = Math.max(256, ctxTokens - replyTok - overhead - existingTok);
  let guard = 0;
  while (counter.text(notes.join('\n\n')) > reduceBudget && notes.length > 1 && guard++ < 8) {
    const groups = chunkLines(notes, Math.max(256, mapBudget), counter);
    const next = [];
    for (let i = 0; i < groups.length; i++) next.push(await call(notesSys, chunkNotesUserPrompt(groups[i], i + 1, groups.length), Math.ceil(notesWords * 1.6)));
    if (next.length >= notes.length) { notes = next; break; }
    notes = next;
  }
  const content = await call(sys, mergeNotesUserPrompt(existingSummary, notes), replyTok);
  return { content, method: 'map-reduce', calls };
}

/** Create and store a summary entry on the chat. */
export function recordSummary(chat, { upToMessageId, previous, content, counter, model, method, evictedCount }) {
  const now = nowIso();
  const entry = {
    id: newId('sum'),
    upToMessageId,
    previousSummaryId: previous?.id || null,
    content,
    tokens: counter.text(content),
    messagesCovered: (previous?.messagesCovered || 0) + evictedCount,
    method,
    model: model || null,
    editedByUser: false,
    createdAt: now,
    updatedAt: now,
  };
  chat.summaries.push(entry);
  return entry;
}
