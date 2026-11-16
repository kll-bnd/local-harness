// One conversational turn: the user message and the assistant/tool chain that answers it, rendered as a
// single block. TurnView reconciles keyed sub-views (one StepView per assistant step, one ToolCard per tool
// call) so streaming only touches what changed, and finished markdown is rendered once (and cached).
import { h, copyText, mount, add } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { StreamingMarkdown, renderMarkdown, renderUserMarkdown } from '../../lib/markdown.js';
import { fmtTime, fmtFull, fmtInt, fmt1, fmtMs, fmtBytes, modelLabel, modelShort, plural, truncate } from '../../lib/format.js';
import { openMenu, toast } from '../../ui/overlays.js';
import { openLightbox } from '../../ui/lightbox.js';
import { explainError } from '../../errors.js';
import { describeLive } from '../../chat/session.js';
import { nextStepButtons } from '../../next-steps.js';
import * as api from '../../api.js';
import { store } from '../../state.js';

/** Group the active path into turns. */
export function groupTurns(model) {
  const turns = [];
  let cur = null;
  for (const m of model.pathMessages()) {
    if (m.role === 'user') { cur = { key: m.id, user: m, chain: [] }; turns.push(cur); }
    else {
      if (!cur) { cur = { key: m.id, user: null, chain: [] }; turns.push(cur); }
      cur.chain.push(m);
    }
  }
  return turns;
}

const sig = (m) => (m ? `${m.id}:${m.status}:${(m.content || '').length}:${(m.reasoning || '').length}:${m.updatedAt || ''}:${(m.toolCalls || []).length}:${(m.images || []).length}:${(m.siblingIds || []).length}:${m.error || ''}` : '');

function modelName(ref) {
  if (!ref) return 'Assistant';
  if (ref.kind === 'image') return ref.model ? `Image · ${modelLabel(ref.model.replace(/\s*\[[^\]]+\]$/, ''))}` : 'Image';
  const known = (store.get('models') || []).find((m) => m.model === ref.model);
  return modelShort(known?.name || ref.model, 44);
}

function branchSwitcher(msg, ctx, label) {
  const sibs = msg?.siblingIds || [];
  if (sibs.length < 2) return null;
  const i = sibs.indexOf(msg.id);
  return h('div.branch-switch', { role: 'group', 'aria-label': `${label} versions` },
    h('button.icon-btn.small', { type: 'button', disabled: i <= 0 || ctx.model.generating, 'aria-label': `Previous ${label.toLowerCase()} version`, title: 'Previous version', dataset: { action: 'branch', target: sibs[i - 1] } }, icon('chevronLeft', { size: 14 })),
    h('span.branch-pos.num', { 'aria-live': 'polite' }, `${i + 1}/${sibs.length}`),
    h('button.icon-btn.small', { type: 'button', disabled: i >= sibs.length - 1 || ctx.model.generating, 'aria-label': `Next ${label.toLowerCase()} version`, title: 'Next version', dataset: { action: 'branch', target: sibs[i + 1] } }, icon('chevronRight', { size: 14 })),
  );
}

function attachmentChips(atts = []) {
  if (!atts.length) return null;
  return h('div.msg-attachments', atts.map((a) => (a.kind === 'image'
    ? h('button.att-thumb', { type: 'button', title: a.name, dataset: { action: 'open-attachment-image', url: api.attachments.contentUrl(a.id), name: a.name } }, h('img', { src: api.attachments.contentUrl(a.id), alt: a.name, loading: 'lazy' }))
    : h('a.att-chip', { href: api.attachments.contentUrl(a.id), target: '_blank', rel: 'noopener noreferrer', title: `${a.name} · ${fmtBytes(a.size)}` }, icon('file', { size: 14 }), h('span.ellipsis', a.name), h('span.faint.small', fmtBytes(a.size))))));
}

// ------------------------------------------------------------------------------------------------ tool card
function argsSummary(name, args) {
  if (!args || typeof args !== 'object') return '';
  if (name === 'calculate') return args.expression || '';
  if (name === 'generate_image') return args.prompt || '';
  if (name === 'remember') return args.content || '';
  if (name === 'fetch_url') return args.url || '';
  if (name === 'recall') return args.query || '';
  const s = JSON.stringify(args);
  return s === '{}' ? '' : s;
}

const TOOL_LABEL = { calculate: 'Calculator', get_current_time: 'Current time', remember: 'Remember', recall: 'Recall past chats', fetch_url: 'Fetch web page', generate_image: 'Generate image' };
const TOOL_ICON = { calculate: 'hash', get_current_time: 'clock', remember: 'memory', recall: 'history', fetch_url: 'globe', generate_image: 'image' };

class ToolCard {
  constructor(ctx, call) {
    this.ctx = ctx;
    this.call = call;
    this.expanded = ctx.view.expanded.has(`tool:${call.id}`);
    this.el = h('div.tool-card');
    this.sig = null;
  }

  update(call, toolMsg) {
    const live = this.ctx.model.tool.get(call.id);
    const status = toolMsg ? (toolMsg.isError ? 'error' : toolMsg.status === 'running' ? 'running' : 'done') : live?.status === 'error' ? 'error' : this.ctx.model.live ? 'running' : 'aborted';
    const s = `${status}:${this.expanded}:${toolMsg?.id || ''}:${toolMsg?.content?.length || 0}:${live ? `${live.phase}:${live.progress}:${live.images.length}:${live.message || ''}` : ''}`;
    if (s === this.sig) return;
    this.sig = s;
    this.call = call;
    const name = call.name;
    const dur = toolMsg?.durationMs ?? live?.durationMs;
    const statusEl = status === 'running' ? h('span.tool-status', h('span.spinner.small'), 'Running')
      : status === 'error' ? h('span.tool-status.err', icon('error', { size: 13 }), 'Failed')
        : status === 'aborted' ? h('span.tool-status', 'Stopped')
          : h('span.tool-status.ok', icon('check', { size: 13 }), dur != null ? fmtMs(dur) : 'Done');
    const summary = argsSummary(name, call.arguments);
    const head = h('button.tool-head', {
      type: 'button', 'aria-expanded': String(this.expanded),
      on: { click: () => { this.expanded = !this.expanded; this.ctx.view.toggleExpanded(`tool:${call.id}`, this.expanded); this.update(call, toolMsg); } },
    }, h('span.tool-icon', icon(TOOL_ICON[name] || 'tools', { size: 14 })),
    h('span.tool-name', TOOL_LABEL[name] || name),
    summary ? h('span.tool-args', truncate(summary, 140)) : null,
    h('span.spacer'), statusEl, h('span.tool-chev', icon('chevronRight', { size: 12 })));

    const detail = this.expanded ? h('div.tool-detail',
      h('div.tool-sec', h('div.tool-sec-title', 'Arguments'), h('pre.tool-pre', JSON.stringify(call.arguments ?? {}, null, 2))),
      toolMsg ? h('div.tool-sec', h('div.tool-sec-title', toolMsg.isError ? 'Error' : 'Result', h('span.faint', dur != null ? ` · ${fmtMs(dur)}` : '')), h('pre.tool-pre', toolMsg.content || '(empty)')) : null,
      toolMsg?.data && name !== 'generate_image' ? h('div.tool-sec', h('div.tool-sec-title', 'Data'), h('pre.tool-pre', JSON.stringify(toolMsg.data, null, 2))) : null,
    ) : null;

    const images = toolMsg?.images?.length ? toolMsg.images : live?.images?.length ? live.images : [];
    const job = name === 'generate_image' && live && (status === 'running' || live.phase === 'error') ? imageJobStatus(live, this.ctx) : null;
    const grid = name === 'generate_image' ? imageGrid(images, live, status === 'running') : null;
    this.el.className = `tool-card tool-${status}${name === 'generate_image' ? ' tool-image' : ''}`;
    this.el.dataset.toolCallId = call.id;
    mount(this.el, head, detail, job, grid);
  }
}

/** The unload → generate → reload dance, made visible. */
export function imageJobStatus(st, ctx, { cancellable = true } = {}) {
  const phases = st.phases || [];
  const unloads = !!st.unload || phases.includes('unloading') || phases.includes('unloaded');
  const steps = [];
  if (unloads) steps.push({ id: 'unload', label: st.unload?.models?.length ? `Unload ${modelShort(st.unload.models[0], 34)}` : 'Unload chat model', done: phases.includes('unloaded') || ['generating', 'saving', 'done'].includes(st.phase), active: st.phase === 'unloading' });
  steps.push({ id: 'gen', label: st.steps ? `Generate · step ${st.step}/${st.steps}` : 'Generate', done: ['saving', 'done'].includes(st.phase), active: st.phase === 'generating' || st.phase === 'starting' || st.phase === 'queued' || st.phase === 'unloaded' });
  steps.push({ id: 'save', label: 'Save', done: st.phase === 'done', active: st.phase === 'saving' });
  const reloadNote = unloads ? h('div.job-note', icon('info', { size: 13 }), 'The chat model reloads automatically for the next reply.') : null;
  return h('div.image-job', { role: 'status' },
    h('ol.job-steps', steps.map((s) => h('li', { class: { done: s.done, active: s.active } }, h('span.job-dot', s.done ? icon('check', { size: 11 }) : s.active ? h('span.spinner.small') : null), h('span', s.label)))),
    st.phase === 'generating' || st.progress ? h('div.progress', h('span', { style: { width: `${Math.round((st.progress || 0) * 100)}%` } })) : null,
    st.message && st.phase !== 'done' ? h('div.job-msg', st.message) : null,
    st.phase === 'error' ? h('div.job-msg.err', st.error || 'Image generation failed') : null,
    (st.warnings || []).length ? h('div.job-msg.warn', st.warnings.map((w) => w.message).join(' ')) : null,
    st.phase !== 'error' ? reloadNote : null,
    cancellable && st.jobId && st.phase !== 'done' && st.phase !== 'error' ? h('button.btn.btn-small.btn-ghost', { type: 'button', dataset: { action: 'cancel-image', job: st.jobId } }, icon('stop', { size: 12 }), 'Cancel') : null,
  );
}

function imageGrid(images, live, running) {
  const params = live?.params;
  const want = running ? Math.max(params?.count || 1, images.length) : images.length;
  if (!want) return null;
  const cells = [];
  for (let i = 0; i < want; i++) {
    const img = images[i];
    if (img) {
      cells.push(h('button.gen-img', { type: 'button', title: img.prompt || 'Generated image', dataset: { action: 'open-image', index: i }, style: { aspectRatio: img.width && img.height ? `${img.width} / ${img.height}` : null } },
        h('img', { src: img.url, alt: img.prompt || 'Generated image', loading: 'lazy', width: img.width || undefined, height: img.height || undefined })));
    } else {
      cells.push(h('div.gen-img.placeholder', { style: { aspectRatio: params ? `${params.width} / ${params.height}` : '1 / 1' }, attrs: { 'aria-hidden': 'true' } }));
    }
  }
  const grid = h(`div.image-grid.n${Math.min(want, 4)}`, cells);
  grid._images = images;
  return grid;
}

// ------------------------------------------------------------------------------------------------ step
class StepView {
  constructor(ctx, msg) {
    this.ctx = ctx;
    this.id = msg.id;
    this.el = h('div.step', { dataset: { messageId: msg.id } });
    this.reasoningEl = h('div.reasoning');
    this.toolsEl = h('div.tool-cards');
    this.proseEl = h('div.prose');
    this.extraEl = h('div.step-extra');
    add(this.el, this.reasoningEl, this.proseEl, this.toolsEl, this.extraEl);
    this.md = new StreamingMarkdown(this.proseEl, { cacheKey: `m:${msg.id}` });
    this.reasonMd = null;
    this.cards = new Map();
    this.contentSig = null;
    this.reasonSig = null;
    this.extraSig = null;
  }

  update(msg, toolMsgs) {
    const streaming = msg.status === 'streaming';
    // reasoning
    const r = msg.reasoning || '';
    const rs = `${r.length}:${streaming}:${!!msg.content}:${this.ctx.view.expanded.has(`r:${msg.id}`)}`;
    if (rs !== this.reasonSig) {
      this.reasonSig = rs;
      this.renderReasoning(msg, streaming);
    }
    // content
    const c = msg.content || '';
    const cs = `${c.length}:${streaming}`;
    if (cs !== this.contentSig) {
      this.contentSig = cs;
      if (streaming) this.md.update(c);
      else if (c) this.md.finish(c);
      else mount(this.proseEl);
      this.proseEl.hidden = !c;
    }
    // tool calls (in call order)
    const calls = msg.toolCalls || [];
    const seen = new Set();
    for (const call of calls) {
      seen.add(call.id);
      let card = this.cards.get(call.id);
      if (!card) { card = new ToolCard(this.ctx, call); this.cards.set(call.id, card); }
      card.update(call, toolMsgs.get(call.id));
      if (card.el.parentNode !== this.toolsEl) add(this.toolsEl, card.el);
    }
    for (const [id, card] of this.cards) if (!seen.has(id)) { card.el.remove(); this.cards.delete(id); }
    this.toolsEl.hidden = !calls.length;
    // images on image_result messages
    const live = this.ctx.model.tool.get(`msg:${msg.id}`);
    const es = `${(msg.images || []).length}:${msg.kind}:${live ? `${live.phase}:${live.progress}:${live.images.length}` : ''}:${msg.status}`;
    if (es !== this.extraSig) {
      this.extraSig = es;
      const parts = [];
      if (msg.kind === 'image_result') {
        const imgs = msg.images?.length ? msg.images : live?.images || [];
        if (live && (streaming || live.phase === 'error')) parts.push(imageJobStatus(live, this.ctx));
        const grid = imageGrid(imgs, live, streaming);
        if (grid) parts.push(grid);
      }
      mount(this.extraEl, ...parts);
    }
  }

  renderReasoning(msg, streaming) {
    const r = msg.reasoning || '';
    if (!r) { mount(this.reasoningEl); this.reasoningEl.hidden = true; return; }
    this.reasoningEl.hidden = false;
    const thinking = streaming && !msg.content;
    const open = this.ctx.view.expanded.has(`r:${msg.id}`);
    const tm = this.ctx.model.timing.get(msg.id);
    const secs = tm?.reasoningStart ? ((tm.reasoningEnd || Date.now()) - tm.reasoningStart) / 1000 : null;
    const label = thinking ? 'Thinking…' : secs != null && secs >= 0.1 ? `Thought for ${secs < 10 ? secs.toFixed(1) : Math.round(secs)} s` : 'Reasoning';
    if (!this._rHead) {
      this._rHead = h('button.disclosure.reasoning-toggle', { type: 'button', on: { click: () => { const o = !this.ctx.view.expanded.has(`r:${msg.id}`); this.ctx.view.toggleExpanded(`r:${msg.id}`, o); this.reasonSig = null; this.update(this.ctx.model.msg(msg.id) || msg, new Map()); } } });
      this._rBody = h('div.reasoning-body');
      this._rPeek = h('div.reasoning-peek');
      add(this.reasoningEl, this._rHead, this._rPeek, this._rBody);
      this.reasonMd = new StreamingMarkdown(this._rBody);
    }
    this._rHead.setAttribute('aria-expanded', String(open));
    mount(this._rHead, icon('chevronRight', { size: 12 }), thinking ? h('span.spinner.small') : null, h('span', label), r && !thinking ? h('span.faint', ` · ${fmtInt(r.split(/\s+/).length)} words`) : null);
    this._rBody.hidden = !open;
    this._rPeek.hidden = open || !thinking;
    if (!open && thinking) this._rPeek.textContent = r.slice(-220).replace(/\s+/g, ' ');
    if (open) { if (streaming) this.reasonMd.update(r); else this.reasonMd.finish(r); }
  }
}

// ------------------------------------------------------------------------------------------------ turn
export class TurnView {
  constructor(ctx, turn, { materialize = true } = {}) {
    this.ctx = ctx;
    this.key = turn.key;
    this.el = h('section.turn', { dataset: { turn: turn.key } });
    this.materialized = false;
    this.turn = turn;
    this.steps = new Map();
    this.sigs = '';
    if (materialize) this.materialize(); else this.placeholder();
  }

  placeholder() {
    const chars = (this.turn.user?.content?.length || 0) + this.turn.chain.reduce((n, m) => n + (m.content?.length || 0), 0);
    this.el.classList.add('turn-lazy');
    this.el.style.minHeight = `${Math.min(2400, 90 + chars / 3)}px`;
  }

  materialize() {
    if (this.materialized) return;
    this.materialized = true;
    this.el.classList.remove('turn-lazy');
    this.el.style.minHeight = '';
    this.userEl = h('div.msg.msg-user');
    this.asstEl = h('div.msg.msg-assistant');
    this.stepsEl = h('div.steps');
    this.statusEl = h('div.turn-status', { role: 'status' });
    this.noteEl = h('div.turn-note');
    this.footEl = h('div.msg-foot');
    this.headEl = h('div.msg-head');
    add(this.asstEl, this.headEl, this.stepsEl, this.statusEl, this.noteEl, this.footEl);
    add(this.el, this.userEl, this.asstEl);
    this.sigs = '';
    this.update(this.turn, true);
  }

  update(turn, force = false) {
    this.turn = turn;
    if (!this.materialized) return;
    const isLast = this.ctx.view.isLastTurn(this.key);
    const live = isLast ? this.ctx.model.live : null;
    const liveD = live ? describeLive(this.ctx.model) : null;
    const liveSig = live ? `${live.phase}:${live.compaction?.status}:${live.modelStatus?.phase}:${liveD?.label}:${[...this.ctx.model.tool.values()].map((t) => `${t.phase}${t.progress}${t.images.length}${t.status}`).join()}` : '';
    const trailN = turn.chain.reduce((n, m) => n + (this.ctx.model.trail.get(m.id)?.length || 0), 0);
    const s = `${sig(turn.user)}|${turn.chain.map(sig).join('|')}|${liveSig}|${isLast}|${this.ctx.model.generating}|${this.ctx.view.editing || ''}|${trailN}`;
    if (!force && s === this.sigs) return;
    this.sigs = s;
    this.renderUser(turn.user);
    this.renderAssistant(turn, isLast);
  }

  renderUser(u) {
    const editing = u && this.ctx.view.editing === u.id;
    if (!u) { this.userEl.hidden = true; return; }
    this.userEl.hidden = false;
    this.userEl.dataset.messageId = u.id;
    if (editing) {
      if (this.userEl.querySelector('.msg-editor')) return;
      mount(this.userEl, editor(u.content, { label: 'Edit message', submitLabel: 'Save & send', hint: 'Creates a new branch; the original stays available.', onCancel: () => this.ctx.view.setEditing(null), onSubmit: (text) => this.ctx.view.submitEdit(u, text) }));
      return;
    }
    const isImage = u.kind === 'image_request';
    const body = isImage
      ? h('div.user-text.image-request', h('span.badge.accent', icon('image', { size: 12 }), 'Image'), ' ', u.content, u.imageRequest ? h('span.faint.small', ` · ${[u.imageRequest.aspect, u.imageRequest.size, u.imageRequest.seed != null && u.imageRequest.seed >= 0 ? `seed ${u.imageRequest.seed}` : null].filter(Boolean).join(' · ')}`) : null)
      : h('div.user-text.user-md', renderUserMarkdown(u.content, { cacheKey: `u:${u.id}` }));
    mount(this.userEl, 
      body,
      attachmentChips(u.attachments),
      h('div.msg-tools.user-tools',
        branchSwitcher(u, this.ctx, 'Message'),
        u.editedFrom ? h('span.faint.small', 'edited') : null,
        h('span.msg-time.faint.small', { title: fmtFull(u.createdAt) }, fmtTime(u.createdAt)),
        h('button.icon-btn.small', { type: 'button', title: 'Copy', 'aria-label': 'Copy message', dataset: { action: 'copy-msg', id: u.id } }, icon('copy', { size: 14 })),
        !isImage ? h('button.icon-btn.small', { type: 'button', title: 'Edit & resend', 'aria-label': 'Edit and resend', disabled: this.ctx.model.generating, dataset: { action: 'edit', id: u.id } }, icon('pencil', { size: 14 })) : null,
      ),
    );
  }

  renderAssistant(turn, isLast) {
    const chain = turn.chain;
    const model = this.ctx.model;
    const first = chain.find((m) => m.role === 'assistant');
    const last = [...chain].reverse().find((m) => m.role === 'assistant');
    this.asstEl.hidden = !chain.length && !(isLast && model.live);
    if (this.asstEl.hidden) return;
    this.asstEl.dataset.messageId = last?.id || '';

    // head: model · time
    const editingA = last && this.ctx.view.editing === last.id;
    mount(this.headEl, 
      h('span.who', modelName(first?.model || model.live?.modelInfo)),
      first ? h('span.msg-time.faint', { title: fmtFull(first.createdAt) }, fmtTime(first.createdAt)) : null,
      last?.edited ? h('span.badge.outline', 'edited') : null,
    );

    // steps
    const toolMsgs = new Map(chain.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m]));
    const seen = new Set();
    let prev = null;
    for (const m of chain) {
      if (m.role !== 'assistant') continue;
      seen.add(m.id);
      let sv = this.steps.get(m.id);
      if (!sv) { sv = new StepView(this.ctx, m); this.steps.set(m.id, sv); }
      if (editingA && m.id === last.id) {
        sv.el.hidden = true;
      } else {
        sv.el.hidden = false;
        sv.update(m, toolMsgs);
      }
      const want = prev ? prev.el.nextSibling : this.stepsEl.firstChild;
      if (want !== sv.el) this.stepsEl.insertBefore(sv.el, want);
      prev = sv;
    }
    for (const [id, sv] of this.steps) if (!seen.has(id)) { sv.el.remove(); this.steps.delete(id); }
    const oldEditor = this.stepsEl.querySelector(':scope > .msg-editor');
    if (editingA) {
      if (!oldEditor) add(this.stepsEl, editor(last.content, { label: 'Edit answer', submitLabel: 'Save', hint: 'Saved as an edited copy; the original stays available as a version.', onCancel: () => this.ctx.view.setEditing(null), onSubmit: (text) => this.ctx.view.submitAssistantEdit(last, text) }));
    } else oldEditor?.remove();

    // what the machine did during this turn (kept after the fact) + what it is doing right now
    const d = isLast ? describeLive(model) : null;
    const trail = chain.flatMap((m) => model.trail.get(m.id) || []);
    mount(this.statusEl,
      ...trail.map((t) => h('span.status-line.done', icon(t.icon, { size: 13 }), t.text)),
      d ? h(`span.status-line.phase-${d.phase}`, h('span.spinner.small'), d.label) : null,
      d?.hint ? h('span.status-hint', d.hint) : null,
    );
    this.statusEl.hidden = !this.statusEl.childNodes.length;

    // notes: errors, aborted, cut off
    const notes = [];
    if (last?.status === 'error' && last.nextSteps?.length) {
      // A failure the server can explain (e.g. the model could not start): calm, specific, with real fixes.
      const x = explainError({ code: last.errorCode, message: last.error });
      notes.push(h('div.callout.warn.msg-error.with-steps', icon('warning'), h('div.grow.stack',
        h('div', h('b', x.title)), h('div.small', last.error),
        h('div.row-wrap', nextStepButtons(last.nextSteps, { chat: model, messageId: last.id })))));
    } else if (last?.status === 'error') {
      const x = explainError({ code: last.errorCode || 'provider_error', message: last.error });
      notes.push(h('div.callout.danger.msg-error', icon('error'), h('div.grow', h('div', h('b', x.title)), x.detail ? h('div.small', x.detail) : null),
        x.action ? h('button.btn.btn-small', { type: 'button', on: { click: x.action.run } }, x.action.label) : null,
        h('button.btn.btn-small', { type: 'button', dataset: { action: 'regenerate', id: last.id } }, icon('regenerate', { size: 13 }), 'Retry')));
    } else if (last?.status === 'aborted' && !(isLast && model.live)) {
      notes.push(h('div.note-line', icon('stop', { size: 11 }), 'Stopped'));
    }
    // A turn that is only tool work (e.g. the image *is* the answer) should read as finished, not empty.
    const anyText = chain.some((m) => m.role === 'assistant' && (m.content || '').trim());
    const toolMsgsAll = chain.filter((m) => m.role === 'tool');
    if (!anyText && toolMsgsAll.length && last?.status === 'complete' && !(isLast && model.live)) {
      const nImg = toolMsgsAll.reduce((n, m) => n + (m.images?.length || 0), 0);
      notes.push(h('div.note-line.done-line', icon('check', { size: 13 }), nImg ? `Done — ${plural(nImg, 'image')} above.` : `Done — ${plural(toolMsgsAll.length, 'tool')} used.`));
    }
    if (last?.finishReason === 'length') notes.push(h('div.note-line', icon('info', { size: 13 }), 'Cut off at the reply length limit.'));
    if (last?.finishReason === 'tool_limit') notes.push(h('div.note-line', icon('info', { size: 13 }), 'Stopped after reaching the tool-call limit for one turn.'));
    mount(this.noteEl, ...notes);
    this.noteEl.hidden = !notes.length;

    // footer: stats + retrieval + actions + versions
    const generating = isLast && !!model.live;
    if (!last || generating || editingA) { mount(this.footEl); this.footEl.hidden = true; return; }
    this.footEl.hidden = false;
    const stats = last.stats || model.stats.get(`turn:${last.id}`) || null;
    const live = model.stats.get(last.id);
    const tps = stats?.tokensPerSecond ?? live?.tokensPerSecond;
    const comp2 = stats?.completionTokens ?? last.usage?.completionTokens ?? live?.completionTokens;
    const dur = stats?.durationMs ?? last.usage?.totalMs;
    const statBits = [];
    if (tps) statBits.push(`${fmt1(tps)} tok/s`);
    if (comp2) statBits.push(`${fmtInt(comp2)} tokens`);
    if (dur) statBits.push(fmtMs(dur));
    const tip = stats ? [
      stats.promptTokens != null ? `Prompt: ${fmtInt(stats.promptTokens)} tokens` : null,
      stats.completionTokens != null ? `Reply: ${fmtInt(stats.completionTokens)} tokens` : null,
      stats.loadMs ? `Model load: ${fmtMs(stats.loadMs)}` : null,
      stats.iterations > 1 ? `${stats.iterations} model calls` : null,
      stats.toolCalls ? plural(stats.toolCalls, 'tool call') : null,
      last.context?.numCtx ? `Context window: ${fmtInt(last.context.numCtx)}` : null,
    ].filter(Boolean).join('\n') : '';
    const ret = first?.retrieval;
    const nMem = (ret?.memoryIds?.length || 0) + (ret?.pinnedMemoryIds?.length || 0);
    const nDoc = ret?.documentChunks?.length || 0;
    const nRec = ret?.recallChunkIds?.length || 0;
    const retBits = [nMem ? plural(nMem, 'memory', 'memories') : null, nDoc ? plural(nDoc, 'excerpt') : null, nRec ? plural(nRec, 'past chat', 'past chats') : null].filter(Boolean);
    const isImage = last.kind === 'image_result';
    mount(this.footEl, 
      statBits.length ? h('span.msg-stats.num', { title: tip }, statBits.join(' · ')) : null,
      retBits.length ? h('button.chip.used-chip', { type: 'button', title: 'Show what was added to the prompt', dataset: { action: 'show-retrieval', id: first.id } }, icon('memory', { size: 12 }), `Used ${retBits.join(' · ')}`) : null,
      h('span.spacer'),
      branchSwitcher(first, this.ctx, 'Reply'),
      h('div.msg-tools',
        h('button.icon-btn.small', { type: 'button', title: 'Copy', 'aria-label': 'Copy reply', dataset: { action: 'copy-turn', id: this.key } }, icon('copy', { size: 14 })),
        isImage
          ? h('button.icon-btn.small', { type: 'button', title: 'Generate again', 'aria-label': 'Generate image again', dataset: { action: 'image-again', id: this.key } }, icon('regenerate', { size: 14 }))
          : h('button.icon-btn.small', { type: 'button', title: 'Regenerate', 'aria-label': 'Regenerate reply', dataset: { action: 'regenerate', id: last.id } }, icon('regenerate', { size: 14 })),
        h('button.icon-btn.small', { type: 'button', title: 'More', 'aria-label': 'More actions', 'aria-haspopup': 'menu', dataset: { action: 'turn-menu', id: last.id, turn: this.key } }, icon('more', { size: 14 })),
      ),
    );
  }
}

function editor(text, { label, submitLabel, hint, onCancel, onSubmit }) {
  const ta = h('textarea.textarea.msg-edit-input', { value: text, rows: Math.min(14, Math.max(3, text.split('\n').length + 1)), attrs: { 'aria-label': label } });
  const submit = () => { const v = ta.value; if (!v.trim()) return; onSubmit(v); };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  });
  const el = h('div.msg-editor', ta, h('div.row',
    h('span.faint.small.grow', hint),
    h('button.btn.btn-small', { type: 'button', on: { click: onCancel } }, 'Cancel'),
    h('button.btn.btn-small.btn-primary', { type: 'button', on: { click: submit } }, submitLabel)));
  requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
  return el;
}

/** Text of a whole turn's answer (for copy). */
export function turnText(turn) {
  return turn.chain.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content).join('\n\n');
}

export function openTurnImages(turn, index, model, extraActions) {
  const imgs = [];
  for (const m of turn.chain) {
    if (m.images?.length) imgs.push(...m.images);
    else if (m.role === 'assistant' && m.kind === 'image_result') imgs.push(...(model.tool.get(`msg:${m.id}`)?.images || []));
    if (m.role === 'assistant') for (const c of m.toolCalls || []) { if (!turn.chain.some((t) => t.toolCallId === c.id)) imgs.push(...(model.tool.get(c.id)?.images || [])); }
  }
  openLightbox(imgs, index, { actions: extraActions });
}

export { toast, copyText, openMenu, renderMarkdown };
