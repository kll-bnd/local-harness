// Chat route view: the conversation (or the new-chat intro), the composer, drag & drop, and the toolbar
// contents for a chat (title, live status, actions).
import { h, mount, add } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { fmtTokens, fmtBytes, modelLabel, modelShort } from '../../lib/format.js';
import { makeTextOnlyCopy } from '../model-flows.js';
import { store, findModel, modelInfo, loadRecommended, chatModels, patchSettings, loadModels } from '../../state.js';
import { chatModel, peekChatModel, sendMessage, stopGeneration, generateImageInChat, describeLive, mergeChatSummary } from '../../chat/session.js';
import { ConversationView } from './conversation.js';
import { Composer } from './composer.js';
import { navigate } from '../../router.js';
import * as api from '../../api.js';
import { runAction } from '../../actions.js';
import { showError } from '../../errors.js';
import { toast } from '../../ui/overlays.js';

/**
 * What the new-chat screen should suggest, if anything:
 *  - the chosen model is too big for this machine → the installed setup that fits, or Models;
 *  - on a small Mac, a recommended file is downloaded but not yet set up as its text-only copy → finish it.
 */
function introAdvice(ref, plan, rec, sys) {
  const lowRam = sys?.machine?.ramTier === 'low';
  const variants = (rec?.models || []).flatMap((m) => m.variants.map((v) => ({ ...v, rec: m })));
  // The model this machine should actually run for a variant: its text-only copy where that is recommended.
  const runnable = (v) => (v.textOnly?.recommended ? (v.textOnly.installed ? v.textOnly.model : null) : (findModel({ model: v.model }) ? v.model : null));
  const tooBig = plan.warnings?.some((w) => ['model_exceeds_budget', 'model_too_big', 'memory_pressure'].includes(w.code));
  if (tooBig) {
    const better = variants.find((v) => v.estimate?.fits && runnable(v) && runnable(v) !== ref.model);
    return h('div.callout.warn', icon('warning'), h('div.grow',
      h('div', h('b', `${modelShort(ref.model, 40)} is too large for this Mac's memory.`)),
      h('div.small', better ? `${modelShort(runnable(better), 44)} is installed and fits with a ${fmtTokens(better.estimate.numCtx)} window.` : plan.explanation)),
    better ? h('button.btn.btn-small', { type: 'button', on: { click: async () => {
      try { await patchSettings({ defaultModel: { providerId: 'ollama', model: runnable(better) } }); await loadModels(); toast({ kind: 'success', message: `Default model: ${modelShort(runnable(better), 40)}` }); } catch (e) { showError(e, 'change the default model'); }
    } } }, 'Use it by default') : h('button.btn.btn-small', { type: 'button', on: { click: () => runAction('open-setup') } }, 'Set up a smaller model'));
  }
  if (lowRam) {
    const unfinished = variants.find((v) => v.textOnly?.recommended && !v.textOnly.installed && findModel({ model: v.model }) && v.estimate?.fits);
    if (unfinished && unfinished.textOnly.model !== ref.model) {
      return h('div.callout.accent', icon('chip'), h('div.grow',
        h('div', h('b', `${unfinished.rec.name} is downloaded but not set up for this Mac yet.`)),
        h('div.small', `Make a text-only copy: a few seconds, nothing to download, about 1 GB less memory (${fmtBytes(unfinished.textOnly.approxSizeBytes)}) — but it can't read images.`)),
      h('button.btn.btn-small.btn-primary', { type: 'button', on: { click: async (e) => { e.currentTarget.disabled = true; await makeTextOnlyCopy(unfinished.model, { setDefault: true }); } } }, 'Make text-only copy'));
    }
  }
  return null;
}

export class ChatView {
  constructor(shell) {
    this.shell = shell;
    this.model = null;
    this.conv = null;
    this.body = h('div.chat-body');
    this.dropOverlay = h('div.drop-overlay', { hidden: true }, h('div', icon('paperclip', { size: 22 }), h('div', 'Drop files to attach'), h('div.small.muted', 'Images, PDFs, text and code')));
    this.composer = new Composer({
      getModel: () => this.model,
      send: (p) => this.send(p),
      generateImage: (prompt) => this.generateImage(prompt),
      stop: () => stopGeneration(this.model),
      busy: () => runAction('stop-generation-hint'),
      editMessage: (id) => this.conv?.setEditing(id),
      onPendingChange: () => this.renderIntro(),
    });
    this.el = h('div.view.chat-view', this.body, this.composer.el, this.dropOverlay);
    this.bindDrop();
    this.offs = [store.watch(['models', 'defaultModel', 'pendingChat', 'recommended'], () => { if (!this.model) this.renderIntro(); })];
  }

  destroy() { this.offs.forEach((o) => o()); this.unbindModel(); this.composer.destroy(); }

  unbindModel() {
    this.modelOffs?.forEach((o) => o());
    this.modelOffs = null;
    this.conv?.destroy();
    this.conv = null;
  }

  async show(route) {
    const id = route.chatId || null;
    if (this.shown && this.shownId === id && (this.conv || !id)) {
      if (route.query?.get('m')) this.conv?.scrollToMessage(route.query.get('m'));
      return;
    }
    this.shown = true;
    this.shownId = id;
    this.unbindModel();
    if (!id) {
      this.model = null;
      this.composer.bind(null);
      this.renderIntro();
      this.shell.updateToolbar();
      return;
    }
    const model = chatModel(id);
    this.model = model;
    this.composer.bind(model);
    if (!model.loaded) {
      mount(this.body, h('div.loading-chat', h('span.spinner'), h('span.muted', 'Opening chat…')));
      this.shell.updateToolbar();
      try { await model.load(); } catch (e) {
        if (this.model !== model) return;
        mount(this.body, h('div.empty', icon('warning', { size: 22 }), h('div.empty-title', e.code === 'not_found' ? 'This chat no longer exists' : "Couldn't open this chat"), h('div', e.code === 'not_found' ? 'It may have been deleted in another window.' : e.message), h('button.btn', { type: 'button', on: { click: () => runAction('new-chat') } }, 'New chat')));
        return;
      }
      if (this.model !== model) return;
    }
    this.mountConversation(model);
    if (route.query?.get('m')) this.conv.scrollToMessage(route.query.get('m'));
  }

  mountConversation(model) {
    this.conv = new ConversationView(model, { onEmpty: (empty) => { this.el.classList.toggle('is-empty', empty); } });
    mount(this.body, this.conv.el);
    this.conv.el.addEventListener('transcript-scroll', (e) => this.shell.setScrolled(e.detail.top > 4));
    this.conv.el.addEventListener('live-tick', () => this.shell.updateToolbar());
    this.modelOffs = [
      model.on('meta', () => this.shell.updateToolbar()),
      model.on('live', () => this.shell.updateToolbar()),
    ];
    this.composer.bind(model);
    this.shell.updateToolbar();
    model.refreshContext().catch(() => {});
    if (model.chat?.summary) model.loadSummary().catch(() => {});
    // A generation started before a reload: watch for it to finish.
    if (model.chat?.generating && !model.live) this.watchRemote(model);
  }

  watchRemote(model) {
    const t = setInterval(async () => {
      if (this.model !== model) { clearInterval(t); return; }
      await model.load({ force: true }).catch(() => {});
      if (!model.chat?.generating) { clearInterval(t); this.shell.updateToolbar(); }
    }, 1500);
  }

  scrollToMessage(id) { return this.conv?.scrollToMessage(id); }

  // ------------------------------------------------------------------------------------------ actions
  async ensureChat() {
    if (this.model) return this.model;
    const pending = store.get('pendingChat') || {};
    const d = await api.chats.create({ settings: pending.settings || {}, incognito: !!pending.incognito });
    store.set('pendingChat', null);
    const model = chatModel(d.chat.id);
    model.applyDetail(d);
    mergeChatSummary(d.chat);
    this.composer.adoptNewChat(d.chat.id);
    this.model = model;
    this.shownId = d.chat.id;
    this.mountConversation(model);
    navigate(`/chat/${d.chat.id}`, { replace: false });
    return model;
  }

  async send({ content, attachments }) {
    let model;
    try { model = await this.ensureChat(); } catch (e) { showError(e, 'start a chat'); return false; }
    this.conv?.scrollToBottom();
    return sendMessage(model, { content, attachments });
  }

  async generateImage(prompt) {
    let model;
    try { model = await this.ensureChat(); } catch (e) { showError(e, 'start a chat'); return false; }
    this.conv?.scrollToBottom();
    return generateImageInChat(model, { prompt });
  }

  // ------------------------------------------------------------------------------------------ intro (new chat)
  renderIntro() {
    if (this.model) return;
    this.el.classList.add('is-empty');
    const pending = store.get('pendingChat') || {};
    const ref = pending.settings?.model || store.get('defaultModel');
    const info = findModel(ref);
    const sys = store.get('system');
    const ram = sys?.machine?.totalMemBytes;
    const intro = h('div.intro');
    const models = store.get('models');
    if (models && !chatModels().length) {
      add(intro, h('div.intro-inner',
        h('div.intro-mark', 'Harness'),
        h('h1.intro-title', 'No chat model yet'),
        h('p.lede', 'Harness runs models entirely on this Mac. Download one to get started — the setup suggests a size that fits your memory.'),
        h('button.btn.btn-primary.btn-large', { type: 'button', on: { click: () => runAction('open-setup') } }, 'Set up a model')));
      mount(this.body, intro);
      return;
    }
    const planLine = h('span.intro-plan.num');
    const nameEl = h('span.who', ref ? modelLabel(info?.name || ref.model) : 'No model selected');
    const advice = h('div.intro-advice');
    if (ref) {
      modelInfo(ref).then(async (r) => {
        const plan = r?.contextPlan;
        if (!plan) return;
        planLine.textContent = `${fmtTokens(plan.numCtx)} context${ram ? ` on this ${Math.round(ram / 1024 ** 3)} GB ${sys.machine.appleSilicon || sys.machine.platform === 'darwin' ? 'Mac' : 'machine'}` : ''}`;
        const rec = store.get('recommended') || await loadRecommended().catch(() => null);
        if (this.model) return;
        nameEl.textContent = modelLabel(ref.model); // catalog names are known now
        mount(advice, introAdvice(ref, plan, rec, sys));
      }).catch(() => {});
    }
    const running = (sys?.imageProviders || []).filter((p) => p.status === 'running');
    const img = running.find((p) => p.id === 'a1111') || running[0];
    const card = (ic, title, desc, run) => h('button.intro-card', { type: 'button', on: { click: run } }, h('span.intro-card-icon', icon(ic)), h('span.intro-card-text', h('b', title), h('span', desc)));
    add(intro, h('div.intro-inner',
      h('div.intro-mark', pending.incognito ? h('span.row', icon('incognito', { size: 14 }), 'Incognito chat') : 'Harness'),
      h('div.intro-model', nameEl, planLine),
      advice,
      h('div.intro-cards',
        card('paperclip', 'Ask about a file', 'PDF, text or code — or drop it anywhere', () => this.composer.pick()),
        card('image', 'Generate an image', img ? `with ${img.name.replace(/\s*\(.*\)$/, '')}` : 'Needs Draw Things’ API server', () => { this.composer.input.value = '/image '; this.composer.onInput(); this.composer.focus(); }),
        card('memory', 'What Harness remembers', 'Browse and edit memories', () => runAction('open-memory')),
        card('incognito', pending.incognito ? 'Normal chat' : 'Incognito chat', pending.incognito ? 'Remembered and searchable' : 'Nothing remembered or recalled', () => this.composer.patchChat({ incognito: !pending.incognito })),
      ),
    ));
    mount(this.body, intro);
  }

  // ------------------------------------------------------------------------------------------ drag & drop
  bindDrop() {
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    this.el.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; this.dropOverlay.hidden = false; });
    this.el.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    this.el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) this.dropOverlay.hidden = true; });
    this.el.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      this.dropOverlay.hidden = true;
      this.composer.addFiles([...e.dataTransfer.files]);
      this.composer.focus();
    });
  }

  // ------------------------------------------------------------------------------------------ toolbar
  toolbar() {
    const m = this.model;
    const pending = store.get('pendingChat') || {};
    const incog = m ? m.chat?.incognito : pending.incognito;
    const title = h('div.tb-title',
      h('span.title-text', { title: m ? 'Double-click to rename' : '', dataset: { action: m ? 'rename-chat' : null } }, m ? m.title : 'New chat'),
      incog ? h('span.badge.incog-badge', { title: 'Incognito: no memory, not recalled, not indexed' }, icon('incognito', { size: 12 }), 'Incognito') : null);
    const d = m ? describeLive(m) : null;
    let status;
    if (d) {
      const prog = d.progress != null ? h('span.mini-progress', h('span', { style: { width: `${Math.round(d.progress * 100)}%` } })) : null;
      status = h('button.status-pill.busy', { type: 'button', title: 'What Harness is doing now', on: { click: () => runAction('show-context') } }, h('span.spinner.small'), h('span.label', d.label), prog);
    } else status = this.shell.modelStatusPill(m?.chat?.settings?.model || m?.chat?.model || pending.settings?.model || store.get('defaultModel'));
    const actions = [];
    if (m) {
      actions.push(h('button.icon-btn', { type: 'button', title: 'Chat actions', 'aria-label': 'Chat actions', 'aria-haspopup': 'menu', on: { click: (e) => this.shell.chatMenu(e.currentTarget, m.chat) } }, icon('more')));
    }
    return { title, status, actions };
  }
}

export { peekChatModel, fmtBytes };
