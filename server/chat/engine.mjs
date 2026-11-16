// The chat turn runner: settings resolution → retrieval → assembly (+ auto-compaction) → streaming
// agent loop with tools → persistence → background follow-ups (title, memory extraction, recall index).
import { newId } from '../lib/ids.mjs';
import { nowIso, deepMerge, clone, formatBytes, formatTokensK } from '../lib/util.mjs';
import { HttpError, isAbortError, ProviderError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { addMessage, pathTo, setActiveLeaf, activePath } from './tree.mjs';
import { ThinkTagParser } from './reasoning.mjs';
import { assemble, makeRenderer, documentAttachmentIds } from '../context/assemble.mjs';
import { budgetsFor } from '../context/sizing.mjs';
import { activeSummary, planCompaction, summarizeSpan, recordSummary } from '../context/compaction.mjs';
import { enabledTools, toolSchemas } from '../tools/builtin.mjs';
import { chatSummary, publicMessage } from '../store/chats.mjs';
import { extractMemories } from '../memory/extractor.mjs';
import { generateTitle, provisionalTitle } from './titles.mjs';
import { embeddingProfileFor } from '../providers/catalog.mjs';
import { ramTier, isCpuSplit, roundCtx } from '../context/sizing.mjs';
import { normalizeUrl, URL_RE } from '../lib/url.mjs';

const nonNull = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== null && v !== undefined));

export function resolveThink(s, info, provider) {
  const t = s.reasoning?.think ?? 'auto';
  if (provider.kind !== 'ollama') return t === 'off' ? false : undefined;
  if (!info.capabilities.includes('thinking')) return undefined;
  if (t === 'auto' || t === 'on') return true;
  if (t === 'off') return false;
  return t;
}

/** Sampling options a user/preset/chat may set; num_ctx and keep_alive are always ours (sized from RAM). */
export const SAMPLING_KEYS = new Set(['temperature', 'top_p', 'top_k', 'min_p', 'repeat_penalty', 'seed', 'num_predict', 'stop', 'presence_penalty', 'frequency_penalty']);

export function buildOptions(info, s, numCtx, providerKind) {
  const o = {};
  const mf = info.modelfileParameters || {};
  for (const [k, v] of Object.entries(info.profile?.sampling || {})) if (mf[k] === undefined && SAMPLING_KEYS.has(k)) o[k] = v;
  for (const [k, v] of Object.entries(nonNull(s.params))) if (SAMPLING_KEYS.has(k)) o[k] = v;
  if (providerKind === 'ollama') o.num_ctx = numCtx;
  return o;
}

export class ChatEngine {
  constructor(app) {
    this.app = app;
    this.active = new Map();
    // num_ctx each model is currently loaded with (last chat request). Background calls for the same model
    // reuse it so Ollama does not reload; a corrected plan only takes effect at the start of the next turn.
    this.loadedCtx = new Map();
  }

  loadedCtxFor(providerId, model) { return this.loadedCtx.get(`${providerId}/${model}`) ?? null; }

  /**
   * After a real request loaded the model: read its actual footprint from Ollama /api/ps, store it, and
   * surface bad outcomes (over the safe budget / partly on CPU). The current turn keeps its num_ctx;
   * the corrected plan applies from the next turn.
   */
  async measureLoaded(chat, t, emit) {
    if (t.provider.kind !== 'ollama' || t.s.context?.useMeasurements === false) return null;
    const sample = await this.app.measurements.measure(t.provider, t.model, { numCtx: t.plan.numCtx, kvCacheType: t.plan.memory.kvCacheType, digest: t.info.digest, sizeBytes: t.info.sizeBytes });
    if (!sample) return null;
    const mem = t.plan.memory;
    const over = sample.totalBytes + (mem.otherModelsBytes || 0) > mem.budgetBytes;
    const split = isCpuSplit(sample);
    if (!over && !split) return sample;
    const already = new Set((t.plan.warnings || []).map((w) => w.code));
    const next = await this.app.registry.contextPlan(t.provider, t.model, t.s, { info: t.info, otherModelsBytes: mem.otherModelsBytes || 0 });
    const auto = t.plan.mode === 'auto';
    const tail = auto
      ? (next.numCtx < t.plan.numCtx ? ` From the next message the context window will be ${formatTokensK(next.numCtx)} (it is not changed mid-answer because that reloads the model).` : ' A smaller quantization is recommended.')
      : ` Your context setting (${formatTokensK(t.plan.numCtx)}) was kept; about ${formatTokensK(Math.max(2048, roundCtx(Math.min(next.alternatives?.fitMax ?? 0, next.modelMax))))} would fit.`;
    if (over && !already.has('measured_exceeds_budget')) {
      emit('notice', { code: 'measured_exceeds_budget', message: `${t.model} measured ${formatBytes(sample.totalBytes)} at ${formatTokensK(sample.numCtx)} — over the safe memory budget of ${formatBytes(mem.budgetBytes)}.${tail}`, measuredBytes: sample.totalBytes, budgetBytes: mem.budgetBytes, numCtx: sample.numCtx, nextNumCtx: next.numCtx });
    }
    if (split && !already.has('cpu_offload')) {
      const cpu = sample.totalBytes - sample.vramBytes;
      emit('notice', { code: 'cpu_offload', message: `Ollama could only place ${formatBytes(sample.vramBytes)} of ${t.model} (${formatBytes(sample.totalBytes)}) on the GPU at ${formatTokensK(sample.numCtx)}; ${formatBytes(cpu)} runs on the CPU, which is much slower.${tail}`, totalBytes: sample.totalBytes, vramBytes: sample.vramBytes, numCtx: sample.numCtx, nextNumCtx: next.numCtx });
    }
    return sample;
  }

  globalEffectiveSettings() {
    const g = this.app.settings.get();
    const preset = this.app.presets.get(g.defaultPresetId) || this.app.presets.get('default');
    const s = clone(g);
    s.systemPrompt = g.systemPrompt ?? preset.systemPrompt;
    s.params = { ...nonNull(preset.params), ...nonNull(g.params) };
    s.model = g.defaultModel || null;
    s.preset = { id: preset.id, name: preset.name };
    return s;
  }

  /** Global settings ⊕ preset ⊕ per-chat overrides. Params: profile suggestion < global < preset < chat. */
  effectiveSettings(chat) {
    const g = this.app.settings.get();
    const cs = chat?.settings || {};
    const preset = this.app.presets.get(cs.presetId || g.defaultPresetId) || this.app.presets.get('default');
    let s = clone(g);
    const overrides = {};
    for (const k of ['keepAlive', 'context', 'reasoning', 'tools', 'compaction', 'memory', 'recall']) if (cs[k] !== undefined) overrides[k] = cs[k];
    s = deepMerge(s, overrides);
    s.systemPrompt = cs.systemPrompt ?? g.systemPrompt ?? preset.systemPrompt;
    s.params = { ...nonNull(g.params), ...nonNull(preset.params), ...nonNull(cs.params) };
    s.model = cs.model || g.defaultModel || null;
    s.preset = { id: preset.id, name: preset.name };
    return s;
  }

  busy(chatId) { return this.active.has(chatId); }

  /**
   * Reserve a chat for one operation (generation, chat-linked image job, compaction, extraction).
   * Synchronous on purpose: callers reserve BEFORE their first await, so two concurrent requests can never
   * both pass the busy check. Also pre-empts background model work so the user's turn goes first.
   */
  reserve(chatId, kind = 'chat') {
    if (this.active.has(chatId)) throw new HttpError(409, 'chat_busy', 'A generation is already running for this chat');
    const rec = { generationId: newId('gen'), controller: new AbortController(), startedAt: nowIso(), kind, assistantMessageId: null, released: false };
    this.active.set(chatId, rec);
    this.app.foreground++;
    this.app.background?.preempt();
    return rec;
  }

  /** Release a reservation (idempotent; only the owner's record is removed). */
  release(chatId, rec) {
    if (!rec || rec.released) return;
    rec.released = true;
    if (this.active.get(chatId) === rec) this.active.delete(chatId);
    this.app.foreground = Math.max(0, this.app.foreground - 1);
    this.app.background?.kick();
  }

  stop(chatId) {
    const g = this.active.get(chatId);
    if (!g) return false;
    g.controller.abort();
    return true;
  }

  /** Resolve model, metadata, context plan and budgets for a chat. */
  async target(chat, modelRef = null) {
    const s = this.effectiveSettings(chat);
    const { provider, model } = await this.app.registry.resolve(modelRef || s.model);
    const st = await this.app.registry.status(provider);
    if (!st.ok) throw new ProviderError(`${provider.name} is not running at ${provider.baseUrl}${provider.id === 'ollama' ? ' — start Ollama (POST /api/providers/ollama/start)' : ''}`, { status: 503, code: 'connection_failed', providerId: provider.id });
    const info = await this.app.registry.modelInfo(provider, model);
    if (info.capabilities.includes('embedding') && !info.capabilities.includes('completion')) throw new HttpError(400, 'not_chat_model', `${model} is an embedding model and cannot chat`);
    let otherModelsBytes = 0;
    // A resident embedding model shares RAM with the chat model (not on ≤8 GB, where embeddings are opt-in).
    const emb = await this.app.embedder.resolve();
    if (emb.ref && emb.ref.providerId === provider.id && provider.kind === 'ollama') {
      const tag = await this.app.registry.findModel(emb.ref.model, provider.id);
      otherModelsBytes = tag?.sizeBytes || embeddingProfileFor(emb.ref.model).approxSizeBytes || 0;
    }
    const plan = await this.app.registry.contextPlan(provider, model, s, { info, otherModelsBytes });
    const budgets = budgetsFor(plan.numCtx, s);
    const counter = this.app.calibrator.counter(provider.id, model, { imageTokens: info.profile?.imageTokens || 576 });
    return { s, provider, model, info, plan, budgets, counter };
  }

  makeRenderer(t, path) {
    const maxImg = t.s.documents?.maxHistoryImages ?? 4;
    // Only the most recent `maxImg` user images are re-sent; older ones become placeholders.
    const imageMsgIdx = [];
    path.forEach((m, i) => { if (m.role === 'user' && (m.attachments || []).some((a) => this.app.attachments.tryGet(a.id)?.kind === 'image')) imageMsgIdx.push(i - path.length); });
    const allowed = new Set(imageMsgIdx.slice(-maxImg));
    return makeRenderer({
      attachments: this.app.attachments,
      gallery: this.app.gallery,
      counter: t.counter,
      inlineMaxTokens: t.budgets.inlineFileMax,
      vision: t.info.capabilities.includes('vision') || (t.provider.kind !== 'ollama' && !t.info.capabilitiesKnown),
      imageIndexAllowed: (relIdx) => allowed.has(relIdx),
      feedbackImages: !!t.s.image?.feedbackToModel,
      providerKind: t.provider.kind,
    });
  }

  /** Per-turn retrieval: memories, document chunks, past-chat snippets — each under its own budget. */
  async retrieve(chat, t, path, query, signal) {
    const out = { pinned: [], memories: [], documents: [], recall: [] };
    const s = t.s;
    const memOn = s.memory?.enabled !== false && !chat.incognito;
    const recallOn = s.recall?.enabled !== false && s.recall?.autoInject !== false && !chat.incognito && t.budgets.recall >= 64;
    const docIds = documentAttachmentIds(path, this.app.attachments, t.budgets.inlineFileMax);
    if (memOn) out.pinned = this.app.memories.pinned();
    if (!query || (!memOn && !recallOn && !docIds.length)) return out;
    const emb = await this.app.embedder.embed([query], { kind: 'query', signal }).catch(() => null);
    const qv = emb ? { model: emb.model, vec: emb.vectors[0] } : null;
    const c = t.counter;
    if (memOn && (s.memory?.topK ?? 6) > 0) {
      let budget = t.budgets.memories - out.pinned.reduce((a, m) => a + c.text(m.content) + 2, 0);
      for (const r of this.app.memories.search(query, { k: s.memory.topK ?? 6, queryVector: qv, minSimilarity: s.memory.minSimilarity ?? 0.5, excludePinned: true })) {
        const cost = c.text(r.memory.content) + 2;
        if (cost > budget) break;
        budget -= cost;
        out.memories.push({ ...r.memory, score: r.score });
      }
    }
    if (docIds.length) {
      let budget = t.budgets.documents;
      const hits = this.app.attachments.searchDocuments(query, docIds, { k: (s.documents?.topK ?? 6) * 2, queryVector: qv });
      for (const h of hits) {
        const cost = c.text(h.item.text) + 12;
        if (cost > budget) continue;
        budget -= cost;
        const a = this.app.attachments.tryGet(h.item.meta.attachmentId);
        out.documents.push({ attachmentId: h.item.meta.attachmentId, name: a?.name || 'document', n: h.item.meta.n, total: h.item.meta.total, text: h.item.text, score: Math.round(h.score * 1000) / 1000 });
        if (out.documents.length >= (s.documents?.topK ?? 6)) break;
      }
      out.documents.sort((a, b) => (a.attachmentId === b.attachmentId ? a.n - b.n : 0));
    }
    if (recallOn && (s.recall?.topK ?? 3) > 0) {
      let budget = t.budgets.recall;
      for (const h of this.app.recall.search(query, { k: s.recall.topK ?? 3, queryVector: qv, excludeChatId: chat.id, minSimilarity: s.recall.minSimilarity ?? 0.6 })) {
        const cost = c.text(h.text) + 12;
        if (cost > budget) continue;
        budget -= cost;
        out.recall.push(h);
      }
    }
    if (out.memories.length) this.app.memories.markUsed(out.memories.map((m) => m.id)).catch(() => {});
    return out;
  }

  async assembleFor(chat, t, anchorId, retrieval, tools) {
    const path = pathTo(chat, anchorId);
    const summary = t.s.compaction?.enabled === false ? null : activeSummary(chat, path);
    const renderer = this.makeRenderer(t, path);
    const asm = await assemble({
      path, summary, baseSystem: t.s.systemPrompt || '', dateLine: `Current date: ${new Date().toISOString().slice(0, 10)} (${new Date().toLocaleDateString('en-US', { weekday: 'long' })}).`,
      pinnedMemories: retrieval.pinned, retrieval, placement: t.s.memory?.placement || 'turn', tools, counter: t.counter, budgets: t.budgets, renderer,
    });
    return { asm, path, summary };
  }

  /** Summarize the oldest live span. Throws on failure (caller decides on fallback). */
  async compact(chat, t, { path, summary, plan, signal }) {
    let target = { provider: t.provider, model: t.model, info: t.info, numCtx: t.plan.numCtx, settings: t.s };
    const ref = t.s.compaction?.model;
    if (ref?.model && (ref.model !== t.model || (ref.providerId && ref.providerId !== t.provider.id))) target = await this.app.llm.resolveFor(ref, chat);
    const counter = this.app.calibrator.counter(target.provider.id, target.model);
    const complete = (messages, { maxTokens, signal: sig }) => this.app.llm.completeWith(target, messages, { maxTokens, temperature: 0.2, signal: sig });
    const r = await summarizeSpan({ complete, existingSummary: summary?.content || '', span: plan.evict, counter, ctxTokens: target.numCtx, maxSummaryTokens: t.budgets.maxSummaryTokens, attachments: this.app.attachments, signal });
    const entry = recordSummary(chat, { upToMessageId: plan.evict[plan.evict.length - 1].id, previous: summary, content: r.content, counter: t.counter, model: target.model, method: r.method, evictedCount: plan.evict.length });
    chat.compaction = { lastError: null, lastErrorAt: null };
    this.app.chats.touch(chat);
    this.app.bus.publish('chat.compacted', { chatId: chat.id, summary: entry });
    return { entry, calls: r.calls };
  }

  /** Manual "compact now": summarize everything except a minimal recent tail. */
  async compactNow(chat, { keepRecentMessages, signal } = {}) {
    const path = activePath(chat);
    if (path.length < 2) throw new HttpError(400, 'nothing_to_compact', 'Not enough messages to compact');
    const rec = this.reserve(chat.id, 'compaction');
    const onAbort = () => rec.controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let lease = null;
    try {
      const t = await this.target(chat);
      const leaf = path[path.length - 1];
      const { asm, summary } = await this.assembleFor(chat, t, leaf.id, { pinned: this.app.memories.pinned() }, []);
      const plan = planCompaction({ live: asm.live, liveTokens: asm.liveTokens, fixedTokens: asm.fixedTokens, budgets: { ...t.budgets, keepRecentTokens: 0, compactTarget: 0 }, minKeepMessages: keepRecentMessages ?? t.s.compaction?.minKeepMessages ?? 2, force: true });
      if (!plan) throw new HttpError(400, 'nothing_to_compact', 'Nothing can be compacted (the recent tail is the whole live history)');
      lease = await this.app.ram.acquire('llm', { owner: rec.generationId, signal: rec.controller.signal });
      const { entry } = await this.compact(chat, t, { path, summary, plan, signal: rec.controller.signal });
      return { summary: entry, messagesSummarized: plan.evict.length, tokensBefore: asm.usage.used, keptMessages: asm.live.length - plan.boundary };
    } finally {
      lease?.release();
      signal?.removeEventListener('abort', onAbort);
      this.release(chat.id, rec);
    }
  }

  /** Context usage preview for the active path (+ optional draft text) without generating. */
  async preview(liveChat, { draft = '' } = {}) {
    const t = await this.target(liveChat);
    // Work on a shallow copy: the live chat is never modified (no draft message visible to concurrent requests).
    const chat = { ...liveChat, messages: { ...liveChat.messages } };
    const path = activePath(chat);
    const fake = draft ? { id: '__draft__', role: 'user', content: String(draft).slice(0, 1_000_000), parentId: path.at(-1)?.id ?? null, createdAt: nowIso() } : null;
    if (fake) chat.messages[fake.id] = fake;
    {
      const anchor = fake?.id || path.at(-1)?.id;
      const retrieval = anchor ? await this.retrieve(chat, t, pathTo(chat, anchor), draft || path.at(-1)?.content || '', undefined) : { pinned: [] };
      const tools = toolSchemas(await this.toolsFor(chat, t), { compact: t.budgets.numCtx <= 8192 });
      if (!anchor) return { context: emptyUsage(t, tools), plan: t.plan };
      const { asm, summary } = await this.assembleFor(chat, t, anchor, retrieval, tools);
      return { context: { ...asm.usage, needsCompaction: asm.needsCompaction, summaryId: summary?.id || null, truncation: asm.truncation }, plan: t.plan, model: { providerId: t.provider.id, model: t.model } };
    }
  }

  async toolsFor(chat, t) {
    const s = t.s;
    if (s.tools?.enabled === false) return [];
    if (t.provider.kind === 'ollama' && !t.info.capabilities.includes('tools')) return [];
    if (this.app.registry.toolsRejected.has(`${t.provider.id}|${t.model}`)) return [];
    const imageAvailable = s.image?.enabled !== false && s.tools?.builtin?.generate_image !== false ? await this.app.imageProviders.available() : false;
    return enabledTools({ app: this.app, chat, settings: s, imageAvailable });
  }

  /**
   * Run one assistant turn answering `anchorId` (a user message). Streams events through `emit`.
   * `reservation` comes from reserve() (taken by the route before its first await); without it, run() reserves.
   * Errors before the `start` event (setup: model/provider/anchor) are thrown — the route turns them into JSON
   * errors; later failures end the stream with an `error` event. The reservation is always released.
   */
  async run({ chat, anchorId, emit = () => {}, signal, modelRef = null, userMessage = null, prepared = null, reservation = null }) {
    const rec = reservation || this.reserve(chat.id);
    const { controller, generationId } = rec;
    const onAbort = () => controller.abort();
    if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const sig = controller.signal;
    const t0 = Date.now();
    const created = [];
    let asst = null;
    let started = false;
    let lease = null;
    const totals = { promptTokens: 0, completionTokens: 0, evalMs: 0, promptMs: 0, loadMs: 0, iterations: 0, toolCalls: 0 };
    let finalReason = 'stop';
    let lastUsage = null;
    const finishUp = () => {
      lease?.release();
      lease = null;
      signal?.removeEventListener('abort', onAbort);
      this.release(chat.id, rec);
      if (!started) return;
      this.app.chats.touch(chat);
      this.app.chats.saveNow(chat).catch(() => {});
      this.app.bus.publish('generation.finished', { chatId: chat.id, generationId });
    };
    try {
      const t = prepared || (await this.target(chat, modelRef));
      // Re-check after the awaits: the chat or the message may have been deleted meanwhile.
      if (this.app.chats.chats.get(chat.id) !== chat) throw new HttpError(404, 'not_found', 'Chat not found (it was deleted)');
      if (!chat.messages[anchorId]) throw new HttpError(409, 'message_deleted', 'The message to answer no longer exists');
      const s = t.s;
      const modelInfo = { providerId: t.provider.id, model: t.model };
      const newAssistant = (parentId) => {
        const m = { id: newId('msg'), parentId, role: 'assistant', content: '', reasoning: '', status: 'streaming', model: modelInfo, createdAt: nowIso() };
        addMessage(chat, m);
        setActiveLeaf(chat, m.id);
        created.push(m.id);
        return m;
      };
      asst = newAssistant(anchorId);
      started = true;
      rec.assistantMessageId = asst.id;
      this.app.chats.touch(chat);
      this.app.bus.publish('generation.started', { chatId: chat.id, generationId, assistantMessageId: asst.id });
      emit('start', { generationId, chatId: chat.id, userMessage: userMessage ? publicMessage(userMessage) : null, assistantMessage: publicMessage(asst), model: { ...modelInfo, displayName: t.info.displayName, capabilities: t.info.capabilities }, contextPlan: t.plan });
      // RAM lease: on low-RAM machines a chat turn never runs next to an image job (waits, visibly, abortable).
      lease = await this.app.ram.acquire('llm', {
        owner: rec.generationId,
        signal: sig,
        onWait: (w) => emit('model_status', { phase: 'waiting', reason: w.reason, message: w.message }),
      });
      if (lease.waited) emit('model_status', { phase: 'ready', reason: 'ram_available' });
      rec.lease = lease;
      const anchor = chat.messages[anchorId];
      const path0 = pathTo(chat, anchorId);
      // Query for retrieval: the user message, plus the previous assistant reply when the message is short ("yes, do that").
      let query = anchor?.content || '';
      if (query.length < 40) {
        const prevA = [...path0].reverse().find((m) => m.role === 'assistant' && m.id !== asst.id && m.content);
        if (prevA) query = `${prevA.content.slice(-300)}\n${query}`;
      }
      const retrieval = await this.retrieve(chat, t, path0, query, sig);
      if (retrieval.memories.length || retrieval.documents.length || retrieval.recall.length || retrieval.pinned.length) {
        emit('retrieval', {
          pinnedMemories: retrieval.pinned.map((m) => ({ id: m.id, content: m.content })),
          memories: retrieval.memories.map((m) => ({ id: m.id, content: m.content, score: m.score })),
          documents: retrieval.documents.map((d) => ({ attachmentId: d.attachmentId, name: d.name, part: d.n + 1, of: d.total, score: d.score })),
          recall: retrieval.recall.map((r) => ({ chatId: r.chatId, chatTitle: r.chatTitle, date: r.date, score: r.score })),
        });
      }
      asst.retrieval = { memoryIds: retrieval.memories.map((m) => m.id), pinnedMemoryIds: retrieval.pinned.map((m) => m.id), documentChunks: retrieval.documents.map((d) => `${d.attachmentId}:${d.n}`), recallChunkIds: retrieval.recall.map((r) => r.id) };

      let toolDefs = await this.toolsFor(chat, t);
      let tools = toolSchemas(toolDefs, { compact: t.budgets.numCtx <= 8192 });
      let { asm, summary } = await this.assembleFor(chat, t, anchorId, retrieval, tools);

      // --- auto-compaction -------------------------------------------------------------------
      const recentFailure = chat.compaction?.lastErrorAt && Date.now() - Date.parse(chat.compaction.lastErrorAt) < 5 * 60 * 1000;
      if (asm.needsCompaction && s.compaction?.enabled !== false && !recentFailure) {
        const plan = planCompaction({ live: asm.live, liveTokens: asm.liveTokens, fixedTokens: asm.fixedTokens, budgets: t.budgets, minKeepMessages: s.compaction?.minKeepMessages ?? 2 });
        if (plan) {
          const before = asm.usage.used;
          emit('compaction', { status: 'started', messages: plan.evict.length, tokens: plan.evictTokens, keptMessages: asm.live.length - plan.boundary, usedBefore: before, threshold: t.budgets.compactAt });
          try {
            const { entry, calls } = await this.compact(chat, t, { path: path0, summary, plan, signal: sig });
            ({ asm, summary } = await this.assembleFor(chat, t, anchorId, retrieval, tools));
            emit('compaction', { status: 'completed', summary: entry, messages: plan.evict.length, calls, usedBefore: before, usedAfter: asm.usage.used });
          } catch (e) {
            if (sig.aborted) throw e;
            chat.compaction = { lastError: e.message, lastErrorAt: nowIso() };
            log.warn(`Compaction failed for ${chat.id}: ${e.message}`);
            emit('compaction', { status: 'failed', error: e.message, fallback: 'truncate' });
          }
        }
      }
      if (asm.truncation) emit('notice', { code: 'context_truncated', message: `Context was over budget: ${asm.truncation.droppedMessages} older message(s) left out and ${asm.truncation.truncatedMessages} shortened for this request (stored messages are unchanged).`, ...asm.truncation });
      for (const w of t.plan.warnings || []) emit('notice', { code: w.code, message: w.message });
      if (retrieval.pinned.length && asm.usage.breakdown.memories > t.budgets.memories * 1.5) emit('notice', { code: 'pinned_memories_large', message: 'Pinned memories use more than their share of this small context window.' });
      emit('context', { ...asm.usage, summaryId: summary?.id || null, messageId: asst.id, contextPlan: { numCtx: t.plan.numCtx, limitedBy: t.plan.limitedBy, explanation: t.plan.explanation } });
      asst.context = { ...asm.usage, summaryId: summary?.id || null };

      const options = buildOptions(t.info, s, t.plan.numCtx, t.provider.kind);
      let think = resolveThink(s, t.info, t.provider);
      const maxIter = s.tools?.maxIterations ?? 6;
      let iteration = 0;
      let measured = false;
      for (;;) {
        const offerTools = tools.length && iteration < maxIter ? tools : undefined;
        if (this.app.modelState.unloadedForImage) emit('model_status', { phase: 'loading', models: this.app.modelState.models, reason: 'reload_after_image', message: 'Reloading the chat model…' });
        const r = await this.streamOnce({ t, messages: asm.messages, tools: offerTools, options, think, signal: sig, asst, emit });
        think = r.think;
        if (r.toolsRejected) { tools = []; toolDefs = []; this.app.registry.toolsRejected.add(`${t.provider.id}|${t.model}`); }
        totals.iterations++;
        lastUsage = r.usage;
        if (r.usage) {
          totals.promptTokens += r.usage.promptTokens || 0;
          totals.completionTokens += r.usage.completionTokens || 0;
          totals.evalMs += r.usage.evalMs || 0;
          totals.promptMs += r.usage.promptMs || 0;
          totals.loadMs += r.usage.loadMs || 0;
          if (r.usage.promptTokens) {
            const cal = this.app.calibrator.observe(t.provider.id, t.model, { estimatedRaw: asm.rawEstimate, actual: r.usage.promptTokens, numCtx: t.plan.numCtx, hasImages: asm.hasImages });
            if (cal) t.counter = this.app.calibrator.counter(t.provider.id, t.model, { imageTokens: t.info.profile?.imageTokens || 576 });
          }
          emit('stats', statsPayload(asst.id, iteration, r.usage, t.plan.numCtx));
        }
        if (t.provider.kind === 'ollama') this.loadedCtx.set(`${t.provider.id}/${t.model}`, t.plan.numCtx);
        if (iteration === 0 && r.usage && !measured) {
          measured = true;
          await this.measureLoaded(chat, t, emit).catch((e) => log.debug('measure failed', e.message));
        }
        if (r.doneReason === 'length') finalReason = 'length';
        if (r.toolCalls.length && offerTools) {
          asst.toolCalls = r.toolCalls;
          asst.status = 'complete';
          asst.usage = r.usage;
          asst.updatedAt = nowIso();
          emit('message', { message: publicMessage(asst) });
          let parent = asst;
          for (const call of r.toolCalls) {
            totals.toolCalls++;
            const tm = { id: newId('msg'), parentId: parent.id, role: 'tool', toolCallId: call.id, toolName: call.name, content: '', status: 'running', createdAt: nowIso() };
            addMessage(chat, tm);
            setActiveLeaf(chat, tm.id);
            created.push(tm.id);
            emit('tool_call', { messageId: asst.id, toolMessageId: tm.id, toolCall: call });
            const started = Date.now();
            const def = toolDefs.find((d) => d.name === call.name);
            let result;
            if (!def) result = { content: `Error: unknown tool "${call.name}". Available tools: ${toolDefs.map((d) => d.name).join(', ') || 'none'}.`, isError: true };
            else {
              try {
                result = await def.run(call.arguments || {}, { app: this.app, chat, settings: s, emit, signal: sig, messageId: asst.id, toolMessageId: tm.id, toolCallId: call.id, tainted: turnTainted(asm), leaseOwner: rec.generationId, allowedUrls: userUrls(chat, anchorId) });
              } catch (e) {
                if (sig.aborted || isAbortError(e)) throw e;
                result = { content: `Error: ${e.message}`, isError: true };
              }
            }
            tm.content = String(result.content ?? '');
            tm.isError = !!result.isError;
            if (result.data !== undefined) tm.data = result.data;
            if (result.images?.length) tm.images = result.images;
            tm.status = 'complete';
            tm.durationMs = Date.now() - started;
            emit('tool_result', { message: publicMessage(tm), toolCallId: call.id, name: call.name, content: tm.content, isError: tm.isError, data: tm.data ?? null, images: tm.images || [], durationMs: tm.durationMs });
            parent = tm;
          }
          this.app.chats.touch(chat);
          iteration++;
          asst = newAssistant(parent.id);
          asst.retrieval = chat.messages[created[0]]?.retrieval;
          emit('message', { message: publicMessage(asst) });
          ({ asm } = await this.assembleFor(chat, t, parent.id, retrieval, iteration < maxIter ? tools : []));
          asst.context = { ...asm.usage, summaryId: summary?.id || null };
          emit('context', { ...asst.context, messageId: asst.id });
          continue;
        }
        if (r.toolCalls.length && !offerTools) finalReason = 'tool_limit';
        break;
      }
      asst.status = 'complete';
    } catch (e) {
      if (!started) {
        finishUp();
        throw e;
      }
      if (sig.aborted || isAbortError(e)) {
        finalReason = 'aborted';
        if (asst) asst.status = 'aborted';
      } else {
        log.warn(`Generation failed for ${chat.id}: ${e.message}`);
        if (asst) { asst.status = 'error'; asst.error = e.message; asst.errorCode = e.code || 'internal_error'; }
        // Close any tool messages left running.
        for (const id of created) { const m = chat.messages[id]; if (m?.role === 'tool' && m.status === 'running') { m.status = 'error'; m.content ||= `Error: ${e.message}`; m.isError = true; } }
        finishUp();
        emit('error', { code: e.code || 'internal_error', message: e.message, messageId: asst?.id || null, generationId });
        return asst;
      }
    } finally {
      // Every exit path releases the chat, the RAM lease and the foreground count (idempotent).
      finishUp();
    }
    {
      for (const id of created) { const m = chat.messages[id]; if (m?.role === 'tool' && m.status === 'running') { m.status = 'aborted'; m.content ||= 'Aborted'; } }
      const durationMs = Date.now() - t0;
      asst.updatedAt = nowIso();
      asst.usage = lastUsage;
      asst.stats = {
        durationMs,
        iterations: totals.iterations,
        toolCalls: totals.toolCalls,
        promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens,
        tokensPerSecond: totals.evalMs ? Math.round((totals.completionTokens / totals.evalMs) * 10000) / 10 : null,
        loadMs: totals.loadMs,
      };
      if (finalReason !== 'stop') asst.finishReason = finalReason;
      if (lastUsage?.promptTokens && asst.context) asst.context.actual = { promptTokens: lastUsage.promptTokens, completionTokens: lastUsage.completionTokens, used: lastUsage.promptTokens + (lastUsage.completionTokens || 0) };
      this.app.chats.markDirty(chat);
    }
    emit('done', { generationId, reason: finalReason, message: publicMessage(asst), createdMessageIds: created, chat: chatSummary(chat), context: asst.context || null, stats: asst.stats });
    if (finalReason !== 'aborted') this.afterTurn(chat);
    return asst;
  }

  /** One model call with streaming; retries once without tools / think when the backend rejects them. */
  async streamOnce({ t, messages, tools, options, think, signal, asst, emit }) {
    let useTools = tools;
    let useThink = think;
    let toolsRejected = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const parser = new ThinkTagParser();
      const toolCalls = [];
      let usage = null;
      let doneReason = 'stop';
      let streamed = false;
      const onPart = (type, text) => {
        if (!text) return;
        streamed = true;
        if (type === 'reasoning') { asst.reasoning += text; emit('reasoning', { messageId: asst.id, delta: text }); }
        else { asst.content += text; emit('token', { messageId: asst.id, delta: text }); }
      };
      try {
        let first = true;
        for await (const ev of t.provider.chat({ model: t.model, messages, tools: useTools, options, keepAlive: t.s.keepAlive, think: useThink, signal })) {
          if (first) {
            first = false;
            if (this.app.modelState.unloadedForImage) { this.app.modelState.markReloaded(); emit('model_status', { phase: 'ready' }); }
          }
          if (ev.type === 'thinking') onPart('reasoning', ev.text);
          else if (ev.type === 'content') for (const p of parser.push(ev.text)) onPart(p.type, p.text);
          else if (ev.type === 'tool_call') toolCalls.push(ev.call);
          else if (ev.type === 'done') { usage = ev.usage; doneReason = ev.doneReason; }
        }
        for (const p of parser.end()) onPart(p.type, p.text);
        return { toolCalls, usage, doneReason, think: useThink, toolsRejected };
      } catch (e) {
        if (signal.aborted) throw e;
        if (!streamed && e.code === 'tools_unsupported' && useTools) {
          useTools = undefined;
          toolsRejected = true;
          emit('notice', { code: 'tools_unsupported', message: `${t.model} does not support tool calling; continuing without tools.` });
          continue;
        }
        if (!streamed && e.code === 'thinking_unsupported' && useThink !== undefined) {
          useThink = undefined;
          emit('notice', { code: 'thinking_unsupported', message: `${t.model} does not support thinking mode; continuing without it.` });
          continue;
        }
        throw e;
      }
    }
    throw new HttpError(500, 'internal_error', 'Generation retries exhausted');
  }

  /** Background follow-ups after a completed turn. */
  afterTurn(chat) {
    const s = this.effectiveSettings(chat);
    const bg = this.app.background;
    if (s.titles?.auto !== false && chat.titleSource !== 'user' && chat.titleSource !== 'auto') {
      bg.schedule(`title:${chat.id}`, ({ signal } = {}) => generateTitle(this.app, chat, { signal }).catch((e) => { if (signal?.aborted) throw e; log.debug('title failed', e.message); }), { priority: 1, label: 'title' });
    }
    if (!chat.incognito && s.memory?.enabled !== false && s.memory?.autoExtract !== false) {
      bg.schedule(`memory:${chat.id}`, ({ signal } = {}) => this.app.chats.has(chat.id) && extractMemories(this.app, chat, { signal }), { delayMs: s.memory?.extractDelayMs ?? 4000, priority: 5, label: 'memory_extraction' });
    }
    if (!chat.incognito && s.recall?.enabled !== false) {
      const embeds = ramTier(this.app.system.totalMem) !== 'low' || this.app.settings.get().embeddings?.model !== 'auto';
      bg.schedule(`recall:${chat.id}`, async ({ signal } = {}) => {
        if (!this.app.chats.has(chat.id)) return;
        const n = this.app.recall.indexChat(chat);
        if (n) await this.app.recall.index.ensureEmbeddings({ signal });
      }, { delayMs: 1500, priority: 8, needsModel: embeds, label: 'recall_index' });
    }
  }

  /** Create a user message (send / edit-and-resend). */
  createUserMessage(chat, { content, attachments = [], parentId, kind }) {
    const m = { id: newId('msg'), parentId: parentId ?? null, role: 'user', content: content || '', attachments, createdAt: nowIso(), status: 'complete' };
    if (kind) m.kind = kind;
    addMessage(chat, m);
    setActiveLeaf(chat, m.id);
    if (!chat.titleSource && content) { chat.title = provisionalTitle(content); chat.titleSource = 'provisional'; }
    this.app.chats.touch(chat);
    return m;
  }
}

function statsPayload(messageId, iteration, u, numCtx) {
  return {
    messageId,
    iteration,
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    tokensPerSecond: u.evalMs ? Math.round(((u.completionTokens || 0) / u.evalMs) * 10000) / 10 : null,
    promptTokensPerSecond: u.promptMs ? Math.round(((u.promptTokens || 0) / u.promptMs) * 10000) / 10 : null,
    promptMs: u.promptMs, evalMs: u.evalMs, loadMs: u.loadMs, totalMs: u.totalMs,
    contextUsed: (u.promptTokens || 0) + (u.completionTokens || 0),
    numCtx,
  };
}

function emptyUsage(t, tools) {
  const tok = t.counter.tools(tools);
  return { numCtx: t.budgets.numCtx, budget: t.budgets.input, replyReserve: t.budgets.replyReserve, compactAt: t.budgets.compactAt, used: tok, percent: 0, breakdown: { system: 0, tools: tok, memories: 0, summary: 0, documents: 0, recall: 0, history: 0 }, estimated: true, calibration: t.counter.factor };
}

/** True when the request contains text we did not write (files, documents, web pages, past-chat snippets). */
export function turnTainted(asm) {
  return !!asm?.untrusted;
}

/** URLs that literally appear in the user's own messages on this branch (what fetch_url may open). */
export function userUrls(chat, anchorId) {
  const set = new Set();
  for (const m of pathTo(chat, anchorId)) {
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    for (const raw of m.content.match(URL_RE) || []) {
      const n = normalizeUrl(raw.replace(/[.,;:!?]+$/, ''));
      if (n) set.add(n);
    }
  }
  return set;
}
