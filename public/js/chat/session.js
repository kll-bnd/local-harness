// Chat runtime, independent of any view: one ChatModel per chat holds the message tree, the active path
// and live generation state, and applies SSE events as they arrive. Views subscribe to it, so a stream
// keeps running (and stays correct) while you look at another chat, and re-mounting a view mid-stream
// just renders the current model.
//
// ChatModel events:
//   'reset'                 structure changed (load, branch switch, refetch) → reconcile all turns
//   'change' (ids: Set)     these messages changed (content / status / tool state)
//   'live'                  live generation state changed (phase, compaction, model reload…)
//   'context'               context usage / plan updated
//   'summary'               chat.summary changed
//   'meta'                  chat metadata (title, incognito, settings) changed
import * as api from '../api.js';
import { Emitter } from '../lib/store.js';
import { store, refreshChatsSoon, bus } from '../state.js';
import { toast } from '../ui/overlays.js';
import { showError, explainError } from '../errors.js';
import { runAction } from '../actions.js';
import { truncate } from '../lib/format.js';

export class ChatModel extends Emitter {
  constructor(id) {
    super();
    this.id = id;
    this.chat = null;
    this.byId = new Map();
    this.path = [];
    this.loaded = false;
    this.loading = null;
    this.live = null; // { kind, generationId, controller, assistantId, phase, compaction, modelStatus, retrieval, startedAt }
    this.tool = new Map(); // toolCallId | `msg:<id>` → live tool / image-job state
    this.stats = new Map(); // messageId → last `stats` event
    this.context = null; // ContextUsage (latest)
    this.plan = null; // ContextPlan
    this.contextModel = null;
    this.summaryInfo = null; // GET /summary
    this.noticed = new Set();
    this.timing = new Map(); // messageId → { reasoningStart, reasoningEnd, start }
    this.trail = new Map(); // assistant step id → [{ icon, text }] — what the machine did during that turn
  }

  get title() { return this.chat?.title || 'New chat'; }
  get generating() { return !!this.live || !!this.chat?.generating; }
  msg(id) { return this.byId.get(id); }
  pathMessages() { return this.path.map((id) => this.byId.get(id)).filter(Boolean); }

  load({ force = false } = {}) {
    if (this.loading && !force) return this.loading;
    this.loading = api.chats.get(this.id).then((d) => { this.applyDetail(d); return this; }).finally(() => { this.loading = null; });
    return this.loading;
  }

  applyDetail(d) {
    // Preserve in-flight streaming text if the refetch raced ahead of the stream.
    const live = this.live;
    this.chat = d.chat;
    const next = new Map(d.messages.map((m) => [m.id, m]));
    if (live) for (const [id, m] of this.byId) if (m.status === 'streaming' && (!next.has(id) || next.get(id).status === 'streaming')) next.set(id, { ...next.get(id), ...m });
    this.byId = next;
    this.path = d.path;
    this.loaded = true;
    this.emit('reset');
    this.emit('meta');
    this.emit('summary');
  }

  /** Recompute siblingIds for the children of `parentId` (optimistic, until the next refetch). */
  _relink(parentId) {
    const kids = [...this.byId.values()].filter((m) => (m.parentId ?? null) === (parentId ?? null)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const ids = kids.map((k) => k.id);
    for (const k of kids) k.siblingIds = ids;
    if (parentId && this.byId.has(parentId)) this.byId.get(parentId).childIds = ids;
  }

  /** Insert or replace a message and put it on the active path after its parent. */
  upsert(m, { onPath = true } = {}) {
    const prev = this.byId.get(m.id);
    const merged = prev ? { ...prev, ...m } : { childIds: [], siblingIds: [m.id], ...m };
    this.byId.set(m.id, merged);
    if (!prev) this._relink(m.parentId);
    if (onPath && !this.path.includes(m.id)) {
      const pi = m.parentId ? this.path.indexOf(m.parentId) : -1;
      if (m.parentId && pi < 0) this.path.push(m.id);
      else this.path = [...this.path.slice(0, pi + 1), m.id];
      return true;
    }
    return !prev;
  }

  async refreshContext({ draft = '', signal } = {}) {
    try {
      const r = await api.chats.context(this.id, { draft, signal });
      this.context = r.context;
      this.plan = r.plan;
      this.contextModel = r.model;
      this.emit('context');
    } catch (e) {
      if (e.name !== 'AbortError' && e.code !== 'no_model' && e.code !== 'connection_failed') console.warn('context preview failed', e);
    }
  }

  async loadSummary() {
    const r = await api.chats.summary(this.id);
    this.summaryInfo = r;
    if (this.chat) this.chat = { ...this.chat, summary: r.summary };
    this.emit('summary');
    return r;
  }

  setChatMeta(chat) {
    // List summaries carry `generating` as a boolean snapshot; the detail's object form is authoritative.
    const { generating, ...rest } = chat;
    this.chat = { ...(this.chat || {}), ...rest, ...(typeof generating === 'object' ? { generating } : {}) };
    this.emit('meta');
  }
}

// ------------------------------------------------------------------------------------------------ registry
const models = new Map();

export function chatModel(id) {
  if (!models.has(id)) models.set(id, new ChatModel(id));
  const m = models.get(id);
  // Keep memory bounded: drop idle, unobserved models beyond 24.
  if (models.size > 24) {
    for (const [k, v] of models) {
      if (models.size <= 24) break;
      if (k !== id && !v.live && !(v.map.get('reset')?.size)) models.delete(k);
    }
  }
  return m;
}

export function peekChatModel(id) { return models.get(id) || null; }
export function forgetChatModel(id) { const m = models.get(id); if (m?.live) m.live.controller?.abort(); models.delete(id); }
export function liveChats() { return [...models.values()].filter((m) => m.live); }

// ------------------------------------------------------------------------------------------------ live state
function setLive(model, patch) {
  model.live = model.live ? { ...model.live, ...patch } : null;
  model.emit('live');
  bus.emit('activity');
}

function toolState(model, key) {
  if (!model.tool.has(key)) model.tool.set(key, { status: 'running', phase: null, phases: [], images: [], progress: null, startedAt: Date.now() });
  return model.tool.get(key);
}

const changed = (model, ...ids) => model.emit('change', new Set(ids.filter(Boolean)));

/** Plain-language description of what the chat is doing right now (for the toolbar / status line). */
export function describeLive(model) {
  const l = model.live;
  if (!l) return model.chat?.generating ? { label: 'Still replying…', phase: 'remote' } : null;
  if (l.compaction?.status === 'running') return { label: 'Summarizing earlier messages…', phase: 'compaction' };
  for (const t of model.tool.values()) {
    if (t.status !== 'running') continue;
    if (t.phase === 'unloading') return { label: 'Unloading chat model to make room…', phase: 'unloading' };
    if (t.phase === 'unloaded' || t.phase === 'starting' || t.phase === 'queued') return { label: 'Preparing image…', phase: 'image' };
    if (t.phase === 'generating') return { label: t.steps ? `Generating image · step ${t.step}/${t.steps}` : 'Generating image…', phase: 'image', progress: t.progress };
    if (t.phase === 'saving') return { label: 'Saving image…', phase: 'image', progress: 1 };
    if (t.name) return { label: `Running ${t.name}…`, phase: 'tool' };
  }
  if (l.modelStatus?.phase === 'loading') return { label: 'Reloading chat model…', phase: 'loading' };
  const m = model.byId.get(l.assistantId);
  if (l.kind === 'image') return { label: 'Preparing image…', phase: 'image' };
  if (m && !m.content && m.reasoning) return { label: 'Thinking…', phase: 'thinking' };
  if (m && m.content) return { label: 'Writing…', phase: 'writing' };
  return { label: 'Waiting for the model…', phase: 'waiting' };
}

// ------------------------------------------------------------------------------------------------ events
function handleEvent(model, ev) {
  const t = ev.type;
  switch (t) {
    case 'start': {
      const ids = [];
      if (ev.userMessage) { model.upsert(ev.userMessage); ids.push(ev.userMessage.id); }
      model.upsert(ev.assistantMessage);
      ids.push(ev.assistantMessage.id);
      model.timing.set(ev.assistantMessage.id, { start: Date.now() });
      setLive(model, { generationId: ev.generationId, assistantId: ev.assistantMessage.id, modelInfo: ev.model, phase: 'waiting' });
      if (ev.contextPlan) model.plan = ev.contextPlan;
      model.emit('reset');
      changed(model, ...ids);
      break;
    }
    case 'message': {
      const m = ev.message;
      const isNew = !model.byId.has(m.id);
      model.upsert(m);
      if (isNew && m.role === 'assistant' && m.status === 'streaming') { model.timing.set(m.id, { start: Date.now() }); setLive(model, { assistantId: m.id }); }
      if (model.live?.kind === 'image' && m.kind === 'image_result') setLive(model, { assistantId: m.id });
      if (isNew) model.emit('reset');
      changed(model, m.id);
      break;
    }
    case 'retrieval': {
      setLive(model, { retrieval: ev });
      const n = (ev.memories?.length || 0) + (ev.pinnedMemories?.length || 0);
      if (n) model.lastRetrieval = ev;
      changed(model, model.live?.assistantId);
      break;
    }
    case 'compaction': {
      if (ev.status === 'started') setLive(model, { compaction: { status: 'running', ...ev } });
      else if (ev.status === 'completed') {
        setLive(model, { compaction: { status: 'done', ...ev } });
        addTrail(model, { key: 'compaction', icon: 'summary', text: `Summarized ${ev.messages || 'earlier'} earlier message${ev.messages === 1 ? '' : 's'} to make room (${ev.usedBefore ?? '?'} → ${ev.usedAfter ?? '?'} tokens)` });
        if (model.chat) model.chat = { ...model.chat, summary: ev.summary };
        model.emit('summary');
        model.emit('reset');
      } else {
        setLive(model, { compaction: { status: 'failed', ...ev } });
        toast({ kind: 'warn', message: "Couldn't summarize earlier messages", detail: `${ev.error || ''} Older messages were dropped instead.`.trim(), id: `compact-${model.id}` });
      }
      changed(model, model.live?.assistantId);
      break;
    }
    case 'notice': {
      // Non-fatal info. Memory-budget warnings are shown once per model per app session (the status
      // pill and context meter keep showing the state quietly); everything else once per chat.
      const budget = BUDGET_CODES.includes(ev.code);
      const key = budget ? `budget:${model.live?.modelInfo?.model || ''}` : `${model.id}:${ev.code}`;
      if (noticedOnce.has(key) || ev.code === 'thinking_unsupported') break;
      noticedOnce.add(key);
      model.notices = [...(model.notices || []), ev];
      const kind = budget || ev.code === 'context_truncated' ? 'warn' : 'info';
      const action = budget ? { label: 'Details', run: () => runAction('show-context') } : null;
      toast({ kind, message: noticeTitle(ev), detail: ev.message, action, id: budget ? 'notice-budget' : `notice-${ev.code}`, timeout: 9000 });
      break;
    }
    case 'context': {
      const { type, messageId, contextPlan, ...usage } = ev;
      model.context = usage;
      if (contextPlan) model.plan = { ...(model.plan || {}), ...contextPlan };
      model.emit('context');
      break;
    }
    case 'model_status': {
      if (ev.phase === 'loading') model.reloadStarted = Date.now();
      if (ev.phase === 'ready') {
        const secs = model.reloadStarted ? (Date.now() - model.reloadStarted) / 1000 : null;
        addTrail(model, { key: 'reload', icon: 'regenerate', text: `Reloaded the chat model after the image${secs != null && secs >= 0.1 ? ` (${secs < 10 ? secs.toFixed(1) : Math.round(secs)} s)` : ''}` });
      }
      setLive(model, { modelStatus: ev.phase === 'loading' ? ev : null });
      changed(model, model.live?.assistantId);
      break;
    }
    case 'reasoning':
    case 'token': {
      const m = model.byId.get(ev.messageId);
      if (!m) break;
      const tm = model.timing.get(m.id) || {};
      if (t === 'reasoning') {
        m.reasoning = (m.reasoning || '') + ev.delta;
        tm.reasoningStart ||= Date.now();
      } else {
        m.content = (m.content || '') + ev.delta;
        if (tm.reasoningStart && !tm.reasoningEnd) tm.reasoningEnd = Date.now();
      }
      model.timing.set(m.id, tm);
      if (model.live && model.live.phase !== t) setLive(model, { phase: t });
      changed(model, m.id);
      break;
    }
    case 'stats': {
      model.stats.set(ev.messageId, ev);
      changed(model, ev.messageId);
      break;
    }
    case 'tool_call': {
      const m = model.byId.get(ev.messageId);
      if (m) {
        const calls = m.toolCalls || [];
        if (!calls.some((c) => c.id === ev.toolCall.id)) m.toolCalls = [...calls, ev.toolCall];
      }
      const st = toolState(model, ev.toolCall.id);
      Object.assign(st, { name: ev.toolCall.name, toolMessageId: ev.toolMessageId, status: 'running', startedAt: Date.now() });
      model.emit('live');
      bus.emit('activity');
      changed(model, ev.messageId);
      break;
    }
    case 'tool_result': {
      model.upsert(ev.message);
      const st = toolState(model, ev.toolCallId);
      Object.assign(st, { status: ev.isError ? 'error' : 'done', durationMs: ev.durationMs });
      model.emit('live');
      bus.emit('activity');
      changed(model, ev.message.parentId, ev.message.id);
      break;
    }
    case 'memory': {
      if (ev.action === 'added' || ev.action === 'updated') {
        toast({ kind: 'success', message: ev.action === 'added' ? 'Remembered' : 'Memory updated', detail: truncate(ev.memory?.content, 140), action: { label: 'View', run: () => runAction('open-memory') }, id: `mem-${ev.memory?.id}` });
      }
      break;
    }
    case 'image_job':
    case 'image_status':
    case 'image_progress':
    case 'image':
    case 'image_done':
    case 'image_error': {
      const key = ev.toolCallId || (model.live?.assistantId ? `msg:${model.live.assistantId}` : `job:${ev.jobId}`);
      const st = toolState(model, key);
      st.jobId = ev.jobId || ev.job?.id || st.jobId;
      if (t === 'image_job') { st.job = ev.job; st.phase = 'queued'; st.name ||= 'generate_image'; }
      if (t === 'image_status') {
        st.phase = ev.phase;
        if (!st.phases.includes(ev.phase)) st.phases.push(ev.phase);
        if (ev.message) st.message = ev.message;
        if (ev.phase === 'unloading') {
          st.unload = { models: ev.models, reason: ev.reason, message: ev.message };
          addTrail(model, { key: `unload:${st.jobId}`, icon: 'eject', text: `Unloaded ${(ev.models || []).join(', ') || 'the chat model'} to free memory for the image` });
        }
        if (ev.phase === 'starting') { st.params = ev.params; st.family = ev.family; st.warnings = ev.warnings || []; }
      }
      if (t === 'image_progress') Object.assign(st, { progress: ev.progress, step: ev.step, steps: ev.steps, eta: ev.etaSeconds });
      if (t === 'image') st.images = [...st.images, ev.image];
      if (t === 'image_done') Object.assign(st, { phase: 'done', status: st.status === 'running' && !ev.toolCallId ? 'done' : st.status, chatModelUnloaded: ev.chatModelUnloaded, reload: ev.reload, progress: 1 });
      if (t === 'image_error') Object.assign(st, { phase: 'error', status: 'error', error: ev.message, code: ev.code });
      model.emit('live');
      bus.emit('activity');
      changed(model, ev.messageId, ev.toolMessageId, model.live?.assistantId);
      break;
    }
    case 'done': {
      if (ev.message) model.upsert(ev.message);
      if (ev.userMessage) model.upsert(ev.userMessage);
      if (ev.context) { model.context = ev.context; model.emit('context'); }
      if (ev.stats && ev.message) model.stats.set(`turn:${ev.message.id}`, ev.stats);
      if (ev.chat) mergeChatSummary(ev.chat);
      model.doneReason = ev.reason || null;
      changed(model, ev.message?.id);
      break;
    }
    case 'error': {
      const m = ev.messageId ? model.byId.get(ev.messageId) : model.byId.get(model.live?.assistantId);
      if (m) { m.status = ev.code === 'aborted' ? 'aborted' : 'error'; m.error = ev.message; m.errorCode = ev.code; }
      model.lastError = ev;
      changed(model, m?.id);
      break;
    }
    default: break;
  }
}

const BUDGET_CODES = ['model_exceeds_budget', 'exceeds_budget', 'measured_exceeds_budget', 'cpu_offload'];
const noticedOnce = new Set();

/** Remember a notable machine event for the turn being generated (shown under the answer). */
function addTrail(model, entry) {
  const id = model.live?.assistantId;
  if (!id) return;
  const list = model.trail.get(id) || [];
  if (entry.key && list.some((x) => x.key === entry.key)) return;
  model.trail.set(id, [...list, entry]);
}

function noticeTitle(ev) {
  switch (ev.code) {
    case 'model_exceeds_budget': return 'This model is too large for this Mac';
    case 'measured_exceeds_budget': return 'This model uses more memory than is safe';
    case 'cpu_offload': return 'Part of the model runs on the CPU (slower)';
    case 'exceeds_budget': return 'Context window is larger than memory allows';
    case 'context_truncated': return 'Older messages were left out to fit the context';
    case 'tools_unsupported': return "This model can't use tools";
    case 'pinned_memories_large': return 'Pinned memories use a lot of the context';
    case 'clamped_to_model_max': return 'Context limited to the model maximum';
    case 'context_unknown': return "This model's context length is unknown";
    default: return 'Note';
  }
}

export function mergeChatSummary(summary) {
  const list = store.get('chats');
  if (!list) return;
  const i = list.findIndex((c) => c.id === summary.id);
  if (summary.archived) { if (i >= 0) store.set('chats', list.filter((c) => c.id !== summary.id)); return; }
  const next = i >= 0 ? list.map((c) => (c.id === summary.id ? { ...c, ...summary } : c)) : [summary, ...list];
  store.set('chats', next);
  peekChatModel(summary.id)?.setChatMeta(summary);
}

// ------------------------------------------------------------------------------------------------ runners
async function run(model, kind, starter) {
  if (model.live) {
    const x = explainError({ code: 'chat_busy' });
    toast({ kind: 'warn', message: x.title, detail: x.detail, action: x.action, id: 'busy' });
    return false;
  }
  const controller = new AbortController();
  model.live = { kind, controller, startedAt: Date.now(), phase: 'starting' };
  model.lastError = null;
  model.doneReason = null;
  for (const [k, v] of model.tool) if (v.status !== 'running') model.tool.delete(k);
  model.emit('live');
  bus.emit('activity');
  let result = null;
  try {
    try {
      result = await starter((ev) => handleEvent(model, ev), controller.signal);
    } catch (e) {
      // Our previous turn may still be finalizing on the server for a few ms: retry once.
      if (e.code !== 'chat_busy' || !model.lastFinishedAt || Date.now() - model.lastFinishedAt > 3000) throw e;
      await new Promise((r) => setTimeout(r, 400));
      result = await starter((ev) => handleEvent(model, ev), controller.signal);
    }
  } catch (e) {
    model.live = null;
    model.emit('live');
    bus.emit('activity');
    if (e.code === 'chat_busy') { model.chat = { ...(model.chat || {}), generating: { generationId: null } }; model.emit('live'); }
    showError(e, kind === 'image' ? 'generate the image' : 'send the message');
    await model.load({ force: true }).catch(() => {});
    return false;
  }
  const ownGeneration = model.live?.generationId;
  model.live = null;
  model.lastFinishedAt = Date.now();
  for (const [, v] of model.tool) if (v.status === 'running') v.status = result?.aborted ? 'aborted' : 'done';
  model.emit('live');
  bus.emit('activity', { finished: model.id });
  await model.load({ force: true }).catch(() => {});
  // The refetch can race the server's bookkeeping; our own generation is over either way.
  if (model.chat?.generating && (!model.chat.generating.generationId || model.chat.generating.generationId === ownGeneration)) {
    model.chat = { ...model.chat, generating: null };
    model.emit('live');
  }
  model.refreshContext().catch(() => {});
  if (model.lastError && model.lastError.code !== 'aborted') {
    const x = explainError(model.lastError);
    if (['connection_failed', 'no_model', 'model_not_found', 'image_provider_unreachable', 'no_image_provider', 'image_disabled'].includes(model.lastError.code)) {
      toast({ kind: 'error', message: x.title, detail: x.detail, action: x.action, id: 'gen-error' });
    }
  }
  refreshChatsSoon();
  return true;
}

export function sendMessage(model, { content, attachments = [], parentId, modelRef } = {}) {
  const body = { content, attachments };
  if (parentId !== undefined) body.parentId = parentId;
  if (modelRef) body.model = modelRef;
  return run(model, 'chat', (onEvent, signal) => api.chats.send(model.id, body, onEvent, { signal }));
}

export function regenerate(model, messageId, { modelRef } = {}) {
  return run(model, 'chat', (onEvent, signal) => api.chats.regenerate(model.id, messageId, modelRef ? { model: modelRef } : {}, onEvent, { signal }));
}

export function editAndResend(model, messageId, { content, attachments } = {}) {
  const body = { content };
  if (attachments) body.attachments = attachments;
  return run(model, 'chat', (onEvent, signal) => api.chats.edit(model.id, messageId, body, onEvent, { signal }));
}

export async function editAssistant(model, messageId, content) {
  try {
    await api.chats.edit(model.id, messageId, { content }, () => {});
    await model.load({ force: true });
    return true;
  } catch (e) { showError(e, 'save the edit'); return false; }
}

export function generateImageInChat(model, request) {
  return run(model, 'image', (onEvent, signal) => api.images.generate({ ...request, chatId: model.id }, onEvent, { signal }));
}

export async function stopGeneration(model) {
  if (!model) return false;
  try {
    const r = await api.chats.stop(model.id);
    if (!r.stopped && model.live) model.live.controller.abort();
    return true;
  } catch (e) {
    model.live?.controller.abort();
    showError(e, 'stop');
    return false;
  }
}

export async function switchBranch(model, messageId) {
  if (model.generating) { showError({ code: 'chat_busy' }); return; }
  try {
    const r = await api.chats.branch(model.id, messageId);
    model.path = r.path;
    if (model.chat) model.chat = { ...model.chat, activeLeafId: r.activeLeafId, summary: r.summary };
    model.emit('reset');
    model.emit('summary');
    model.refreshContext().catch(() => {});
  } catch (e) { showError(e, 'switch branches'); }
}

export async function deleteMessage(model, messageId) {
  try {
    await api.chats.deleteMessage(model.id, messageId);
    await model.load({ force: true });
    model.refreshContext().catch(() => {});
  } catch (e) { showError(e, 'delete the message'); }
}

export async function compactNow(model) {
  setLive(model, {});
  model.compacting = true;
  model.emit('live');
  bus.emit('activity');
  try {
    const r = await api.chats.compact(model.id);
    toast({ kind: 'success', message: `Summarized ${r.messagesSummarized} earlier message${r.messagesSummarized === 1 ? '' : 's'}`, detail: `Kept the last ${r.keptMessages} verbatim.`, id: `compact-${model.id}` });
    await model.load({ force: true });
    await model.loadSummary().catch(() => {});
    model.refreshContext().catch(() => {});
  } catch (e) {
    showError(e, 'summarize the chat');
  } finally {
    model.compacting = false;
    model.emit('live');
    bus.emit('activity');
  }
}
