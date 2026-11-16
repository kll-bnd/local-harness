// Inspector (right panel) for the current chat: Context (meter, why this size, mode, compaction),
// Memory (what was used, per-chat switches, pinned memories), Summary (view/edit/history) and Chat
// (per-chat overrides: preset, system prompt, sampling, tools).
import { h, debounce, mount, add } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { fmtInt, fmtFull, fmtRelative, plural, truncate, modelLabel } from '../lib/format.js';
import { renderMarkdown } from '../lib/markdown.js';
import { store, setUiPref, uiPrefs, findModel } from '../state.js';
import * as api from '../api.js';
import { contextPanel } from './chat/context-meter.js';
import { compactNow } from '../chat/session.js';
import { showError } from '../errors.js';
import { toast, confirmDialog } from '../ui/overlays.js';
import { runAction } from '../actions.js';
import { navigate } from '../router.js';

const TABS = [
  { id: 'context', label: 'Context', icon: 'layers' },
  { id: 'memory', label: 'Memory', icon: 'memory' },
  { id: 'summary', label: 'Summary', icon: 'summary' },
  { id: 'chat', label: 'Chat', icon: 'sliders' },
];

export class Inspector {
  constructor(shell) {
    this.shell = shell;
    this.model = null;
    this.focusRetrieval = null;
    this.maxPlan = null;
    this.maxPlanKey = null;
    this.memCache = null;
    this.tabsEl = h('div.segmented.inspector-tabs', { role: 'tablist', attrs: { 'aria-label': 'Inspector' } });
    this.body = h('div.inspector-body', { role: 'tabpanel', tabIndex: -1 });
    this.el = h('aside.inspector', { attrs: { 'aria-label': 'Inspector' } }, h('div.inspector-inner',
      h('div.titlebar', this.tabsEl, h('span.spacer'), h('button.icon-btn', { type: 'button', 'aria-label': 'Close inspector', title: 'Close inspector', on: { click: () => runAction('toggle-inspector') } }, icon('x'))),
      this.body));
    this.render = debounce(() => this.renderNow(), 30);
    this.offs = [store.watch(['settings', 'presets', 'models'], () => this.render())];
    this.tabsEl.addEventListener('keydown', (e) => {
      const i = TABS.findIndex((t) => t.id === this.tab);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const n = TABS[(i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length];
        this.setTab(n.id);
        this.tabsEl.querySelector(`[data-tab="${n.id}"]`)?.focus();
      }
    });
  }

  get tab() { return uiPrefs().inspectorTab || 'context'; }
  setTab(id) { setUiPref('inspectorTab', id); this.renderNow(); }

  bind(model) {
    if (this.model === model) return;
    this.modelOffs?.forEach((o) => o());
    this.model = model;
    this.focusRetrieval = null;
    this.modelOffs = model ? [
      model.on('context', () => this.render()),
      model.on('summary', () => this.render()),
      model.on('meta', () => this.render()),
      model.on('live', () => { if (this.tab === 'context' || this.tab === 'memory') this.render(); }),
    ] : [];
    this.renderNow();
  }

  show(tab, opts = {}) {
    if (opts.retrieval) this.focusRetrieval = opts.retrieval;
    if (tab) setUiPref('inspectorTab', tab);
    this.renderNow();
  }

  renderNow() {
    if (!this.shell.inspectorOpen()) return;
    const tab = this.tab;
    mount(this.tabsEl, ...TABS.map((t) => h('button', { type: 'button', role: 'tab', id: `itab-${t.id}`, tabIndex: t.id === tab ? 0 : -1, 'aria-selected': String(t.id === tab), attrs: { 'aria-controls': 'inspector-panel' }, dataset: { tab: t.id }, on: { click: () => this.setTab(t.id) } }, t.label)));
    this.body.id = 'inspector-panel';
    this.body.setAttribute('aria-labelledby', `itab-${tab}`);
    const m = this.model;
    const scroll = this.body.scrollTop;
    let content;
    if (tab === 'context') content = this.contextTab(m);
    else if (tab === 'memory') content = this.memoryTab(m);
    else if (tab === 'summary') content = this.summaryTab(m);
    else content = this.chatTab(m);
    mount(this.body, content);
    this.body.scrollTop = scroll;
  }

  // ------------------------------------------------------------------------------------------ context
  contextTab(m) {
    const composerPlan = this.shell.chatView?.composer?.newChatPlan;
    if (!m) {
      return h('div.stack', h('p.inspector-empty', 'The context meter fills in once this chat has messages.'), composerPlan ? contextPanel(null, composerPlan, {}) : null);
    }
    const plan = m.plan;
    const ref = m.contextModel || m.chat?.settings?.model || m.chat?.model;
    if (plan && ref && plan.limitedBy !== 'model' && plan.limitedBy !== 'server') {
      const key = `${ref.providerId}|${ref.model}|${plan.numCtx}`;
      if (this.maxPlanKey !== key) {
        this.maxPlanKey = key;
        this.maxPlan = null;
        api.models.context(ref, 'max').then((r) => { this.maxPlan = r.contextPlan; this.render(); }).catch(() => {});
      }
    } else this.maxPlan = null;
    const s = store.get('settings');
    const cs = m.chat?.settings || {};
    const compactionEnabled = cs.compaction?.enabled ?? s?.compaction?.enabled ?? true;
    return contextPanel(m.context, plan, {
      maxPlan: this.maxPlan,
      chatMode: cs.context?.mode ?? null,
      onMode: (mode) => this.patch({ settings: { context: mode === null ? null : { mode } } }),
      compactionEnabled,
      onToggleCompaction: (on) => this.patch({ settings: { compaction: { enabled: on } } }),
      onCompact: () => compactNow(m).then(() => this.render()),
      busy: m.generating || m.compacting || !m.path.length,
      compacting: m.compacting,
    });
  }

  async patch(body) {
    const m = this.model;
    if (!m) return;
    try {
      const d = await api.chats.update(m.id, body);
      m.setChatMeta(d.chat);
      m.refreshContext().catch(() => {});
      this.renderNow();
    } catch (e) { showError(e, 'update the chat'); }
  }

  // ------------------------------------------------------------------------------------------ memory
  async memories() {
    if (!this.memCache || Date.now() - this.memCache.at > 5000) {
      const r = await api.memories.list({ limit: 500 });
      this.memCache = { at: Date.now(), list: r.memories, enabled: r.enabled };
    }
    return this.memCache;
  }

  memoryTab(m) {
    const s = store.get('settings');
    const wrap = h('div.stack-lg');
    const cs = m?.chat?.settings || store.get('pendingChat')?.settings || {};
    const incog = m ? !!m.chat?.incognito : !!store.get('pendingChat')?.incognito;
    const globalOn = s?.memory?.enabled !== false;
    const memOn = cs.memory?.enabled ?? globalOn;
    const recallOn = cs.recall?.enabled ?? s?.recall?.enabled ?? true;
    const sw = (label, help, on, run, disabled = false) => h('div.setting-line',
      h('div.grow', h('div', label), help ? h('div.faint.small', help) : null),
      h('button.switch', { type: 'button', role: 'switch', 'aria-checked': String(!!on), 'aria-label': label, disabled, on: { click: run } }));
    const patch = (body) => (m ? this.patch(body) : this.shell.chatView?.composer?.patchChat(body).then(() => this.renderNow()));

    add(wrap, h('section.stack',
      h('h3.section-title', 'This chat'),
      !globalOn ? h('div.callout.warn', icon('info'), h('div.grow', 'Memory is turned off for all chats.', ' ', h('a', { href: '#/settings/memory' }, 'Settings'))) : null,
      sw('Use memory', incog ? 'Off in incognito chats.' : 'Add relevant memories to the prompt and save new facts after each turn.', memOn && !incog && globalOn, () => patch({ settings: { memory: { enabled: !memOn } } }), incog || !globalOn),
      sw('Recall past chats', 'Let the model look up earlier conversations.', recallOn && !incog, () => patch({ settings: { recall: { enabled: !recallOn } } }), incog),
      sw('Incognito', 'Nothing from this chat is remembered, indexed or recalled.', incog, () => patch({ incognito: !incog })),
      m && !incog && globalOn ? h('button.btn.btn-small', { type: 'button', on: { click: async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try { const r = await api.memories.extract(m.id); toast({ kind: 'success', message: r.added.length || r.updated.length ? `Saved ${plural(r.added.length, 'new memory', 'new memories')}${r.updated.length ? `, updated ${r.updated.length}` : ''}` : 'Nothing new to remember', detail: [...r.added, ...r.updated].map((x) => `• ${x.content}`).join('\n') || null }); this.memCache = null; this.renderNow(); } catch (err) { showError(err, 'extract memories'); } finally { b.disabled = false; }
      } } }, icon('memory', { size: 13 }), 'Extract memories from this chat now') : null,
    ));

    // what was used
    const usedSec = h('section.stack', h('h3.section-title', 'Used for the last reply'), h('div.faint.small', 'Loading…'));
    add(wrap, usedSec);
    const focus = this.focusRetrieval && m?.msg(this.focusRetrieval);
    const last = focus || (m ? [...m.pathMessages()].reverse().find((x) => x.role === 'assistant' && x.retrieval) : null);
    const liveRet = !focus ? m?.lastRetrieval : null;
    const pinnedSec = h('section.stack', h('h3.section-title', 'Always included (pinned)'));
    add(wrap, pinnedSec);
    this.memories().then(({ list }) => {
      const byId = new Map(list.map((x) => [x.id, x]));
      const ret = last?.retrieval;
      const usedIds = [...new Set([...(ret?.pinnedMemoryIds || []), ...(ret?.memoryIds || [])])];
      const items = usedIds.map((id) => byId.get(id) || { id, content: liveRet?.memories?.find((x) => x.id === id)?.content || '(deleted memory)' });
      const docs = liveRet?.documents || [];
      const recall = liveRet?.recall || [];
      mount(usedSec, h('h3.section-title', focus ? 'Used for this reply' : 'Used for the last reply'),
        !ret && !liveRet ? h('div.faint.small', 'Nothing yet.') : null,
        ret && !items.length && !(ret.documentChunks || []).length && !(ret.recallChunkIds || []).length ? h('div.faint.small', 'No memories, documents or past chats were added.') : null,
        ...items.map((x) => memoryRow(x, (ret?.pinnedMemoryIds || []).includes(x.id))),
        (ret?.documentChunks || []).length ? h('div.small.muted', icon('file', { size: 12 }), ` ${plural(ret.documentChunks.length, 'document excerpt')}${docs.length ? `: ${[...new Set(docs.map((d) => d.name))].join(', ')}` : ''}`) : null,
        recall.length ? h('div.stack', recall.map((r) => h('a.small', { href: `#/chat/${r.chatId}` }, icon('history', { size: 12 }), ` ${r.chatTitle || 'Past chat'} · ${fmtRelative(r.date)}`))) : (ret?.recallChunkIds || []).length ? h('div.small.muted', `${plural(ret.recallChunkIds.length, 'excerpt')} from past chats`) : null,
        focus ? h('button.btn-link.small', { type: 'button', on: { click: () => { this.focusRetrieval = null; this.renderNow(); } } }, 'Show the last reply instead') : null);
      const pinned = list.filter((x) => x.pinned);
      mount(pinnedSec, h('h3.section-title', 'Always included (pinned)'),
        pinned.length ? pinned.map((x) => memoryRow(x, true)) : h('div.faint.small', 'Pin a memory to include it in every chat.'),
        h('button.btn-link.small', { type: 'button', on: { click: () => runAction('open-memory') } }, `Manage all memories (${list.length})`));
    }).catch(() => mount(usedSec, h('div.faint.small', 'Could not load memories.')));
    return wrap;
  }

  // ------------------------------------------------------------------------------------------ summary
  summaryTab(m) {
    if (!m) return h('p.inspector-empty', 'Long chats are summarized automatically when the context fills up. The summary will appear here.');
    const info = m.summaryInfo;
    if (!info) { m.loadSummary().catch(() => {}); return h('div.faint.small', 'Loading…'); }
    const s = info.summary;
    const wrap = h('div.stack-lg');
    if (!info.enabled) add(wrap, h('div.callout', icon('info'), h('span', 'Automatic summaries are off for this chat; older messages are dropped when the context is full.')));
    if (info.lastError) add(wrap, h('div.callout.warn', icon('warning'), h('span', `Last summary attempt failed: ${info.lastError}`)));
    if (!s) {
      add(wrap, h('p.muted', 'No summary yet — everything still fits in the context.'),
        h('button.btn.btn-small', { type: 'button', disabled: m.generating || m.compacting || m.path.length < 3, on: { click: () => compactNow(m) } }, m.compacting ? 'Summarizing…' : 'Compact now'));
      return wrap;
    }
    const editing = this.summaryEditing;
    add(wrap, h('div.stack',
      h('div.row', h('span.badge.accent', `${plural(info.compactedMessageCount, 'message')} summarized`), h('span.badge', `${fmtInt(s.tokens)} tokens`), s.editedByUser ? h('span.badge.outline', 'edited') : null, h('span.spacer'),
        !editing ? h('button.icon-btn.small', { type: 'button', title: 'Edit summary', 'aria-label': 'Edit summary', on: { click: () => { this.summaryEditing = true; this.renderNow(); } } }, icon('pencil', { size: 14 })) : null),
      editing ? this.summaryEditor(m, s) : h('div.prose.prose-small', renderMarkdown(s.content, { cacheKey: `s:${s.id}:${s.updatedAt}` })),
      h('div.faint.small', `${s.method === 'manual' ? 'Compacted manually' : `Auto-summarized (${s.method})`} · ${fmtFull(s.updatedAt || s.createdAt)}${s.model ? ` · ${modelLabel(s.model)}` : ''}`),
      h('div.row', h('button.btn.btn-small', { type: 'button', disabled: m.generating || m.compacting, on: { click: () => compactNow(m) } }, m.compacting ? 'Summarizing…' : 'Compact now'),
        h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: () => { this.shell.chatView?.conv?.scrollToMessage(s.upToMessageId); } } }, 'Show in chat')),
    ));
    if (info.history?.length > 1) {
      add(wrap, h('section.stack', h('h3.section-title', 'Earlier summaries on this branch'),
        ...info.history.slice(0, -1).reverse().map((x) => h('details.history-item', h('summary', `${fmtFull(x.createdAt)} · ${fmtInt(x.tokens)} tokens · ${x.messagesCovered} messages`), h('div.prose.prose-small', renderMarkdown(x.content))))));
    }
    return wrap;
  }

  summaryEditor(m, s) {
    const ta = h('textarea.textarea.mono', { value: s.content, rows: 16, attrs: { 'aria-label': 'Summary' } });
    requestAnimationFrame(() => ta.focus());
    return h('div.stack', ta, h('div.row', h('span.spacer'),
      h('button.btn.btn-small', { type: 'button', on: { click: () => { this.summaryEditing = false; this.renderNow(); } } }, 'Cancel'),
      h('button.btn.btn-small.btn-primary', { type: 'button', on: { click: async () => {
        try { await api.chats.putSummary(m.id, ta.value); this.summaryEditing = false; await m.loadSummary(); m.refreshContext(); toast({ kind: 'success', message: 'Summary saved' }); } catch (e) { showError(e, 'save the summary'); }
      } } }, 'Save')));
  }

  // ------------------------------------------------------------------------------------------ chat overrides
  chatTab(m) {
    if (!m) return h('p.inspector-empty', 'Per-chat settings appear once the chat has started. Use the composer toggles to choose the model, preset and tools for the first message.');
    const s = store.get('settings');
    const cs = m.chat?.settings || {};
    const presets = store.get('presets') || [];
    const ref = cs.model || m.chat?.model;
    const caps = findModel(ref)?.capabilities || [];
    const p = cs.params || {};
    const num = (key, label, attrs, help) => {
      const input = h('input.input.input-small.num', { type: 'number', value: p[key] ?? '', placeholder: s?.params?.[key] ?? 'default', ...attrs, attrs: { 'aria-label': label } });
      input.addEventListener('change', () => this.patch({ settings: { params: { [key]: input.value === '' ? null : Number(input.value) } } }));
      return h('label.param-row', h('span.grow', label, help ? h('span.faint.small', ` ${help}`) : null), input);
    };
    const sys = h('textarea.textarea', { value: cs.systemPrompt || '', rows: 5, placeholder: presets.find((x) => x.id === (cs.presetId || s?.defaultPresetId))?.systemPrompt || 'Uses the preset’s instructions', attrs: { 'aria-label': 'System prompt for this chat' } });
    sys.addEventListener('change', () => this.patch({ settings: { systemPrompt: sys.value.trim() ? sys.value : null } }));
    const presetSel = h('select.select', { attrs: { 'aria-label': 'Preset' }, on: { change: (e) => this.patch({ settings: { presetId: e.target.value || null } }) } },
      h('option', { value: '' }, `Default (${presets.find((x) => x.id === s?.defaultPresetId)?.name || 'Assistant'})`),
      ...presets.map((x) => h('option', { value: x.id, selected: cs.presetId === x.id }, x.name)));
    const think = cs.reasoning?.think ?? null;
    const thinkCtl = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Thinking' },
      ...[['', 'Default'], ['off', 'Off'], ['low', 'Low'], ['medium', 'Med'], ['high', 'High']].map(([v, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String((think ?? '') === v), on: { click: () => this.patch({ settings: { reasoning: v ? { think: v } : null } }) } }, l)));
    const tools = s?.tools?.builtin || {};
    const ctools = cs.tools?.builtin || {};
    const toolNames = Object.keys(tools);
    return h('div.stack-lg',
      h('section.stack', h('h3.section-title', 'Persona'), presetSel,
        h('label.field-label.small', 'System prompt for this chat'), sys,
        h('div.faint.small', 'Leave empty to use the preset.')),
      caps.includes('thinking') ? h('section.stack', h('h3.section-title', 'Thinking'), thinkCtl) : null,
      h('section.stack', h('h3.section-title', 'Sampling'),
        num('temperature', 'Temperature', { step: 0.05, min: 0, max: 2 }),
        num('top_p', 'Top P', { step: 0.01, min: 0, max: 1 }),
        num('top_k', 'Top K', { step: 1, min: 0 }),
        num('seed', 'Seed', { step: 1 }, '(fixed = reproducible)'),
        num('num_predict', 'Max reply tokens', { step: 64, min: -1 })),
      h('section.stack', h('h3.section-title', 'Tools in this chat'),
        ...toolNames.map((t) => {
          const on = ctools[t] ?? tools[t];
          return h('div.setting-line', h('span.grow.mono.small', t), h('button.switch', { type: 'button', role: 'switch', 'aria-checked': String(!!on), 'aria-label': t, on: { click: () => this.patch({ settings: { tools: { builtin: { [t]: !on } } } }) } }));
        })),
      h('section.stack', h('h3.section-title', 'This chat'),
        h('dl.kv', h('dt', 'Created'), h('dd', fmtFull(m.chat?.createdAt)), h('dt', 'Messages'), h('dd', fmtInt(m.chat?.messageCount)), h('dt', 'Title'), h('dd', m.chat?.titleSource === 'user' ? 'set by you' : m.chat?.titleSource === 'auto' ? 'generated' : 'from the first message')),
        h('div.row-wrap',
          h('button.btn.btn-small', { type: 'button', on: { click: async () => { try { const r = await api.chats.title(m.id); m.setChatMeta(r.chat); toast({ kind: 'success', message: 'New title', detail: r.title }); } catch (e) { showError(e, 'regenerate the title'); } } } }, 'Regenerate title'),
          Object.keys(cs).length ? h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: async () => { if (await confirmDialog({ title: 'Reset this chat’s settings?', message: 'Model, preset, prompt, sampling and tool overrides go back to your global settings.', confirmLabel: 'Reset' })) this.patch({ settings: null }); } } }, 'Reset overrides') : null)),
    );
  }
}

function memoryRow(x, pinned) {
  return h('div.mem-mini', pinned ? icon('pinFilled', { size: 11 }) : icon('memory', { size: 12 }), h('span.grow', truncate(x.content, 220)));
}

export { navigate };
