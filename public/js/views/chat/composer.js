// The composer: multiline input, attachments (picker / drop / paste), model + preset pickers, quick
// toggles, slash commands, per-chat drafts, send/stop, and the always-visible context meter.
import { h, autosize, pickFiles, debounce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { fmtBytes, fmtTokens, modelLabel, isMac } from '../../lib/format.js';
import { store, chatModels, findModel, sameRef, modelInfo, uiPrefs } from '../../state.js';
import * as api from '../../api.js';
import { openPopover, openMenu, toast } from '../../ui/overlays.js';
import { showError } from '../../errors.js';
import { runAction, keyLabel } from '../../actions.js';
import { miniMeter } from './context-meter.js';

const SLASH = [
  { cmd: '/image', alias: ['/draw'], args: '<prompt>', desc: 'Generate an image in this chat', needsArg: true },
  { cmd: '/remember', args: '<fact>', desc: 'Save a memory', needsArg: true },
  { cmd: '/compact', desc: 'Summarize earlier messages now' },
  { cmd: '/new', desc: 'Start a new chat' },
  { cmd: '/incognito', desc: 'Start a new incognito chat' },
  { cmd: '/model', args: '[name]', desc: 'Choose the model for this chat' },
  { cmd: '/export', desc: 'Export this chat' },
  { cmd: '/help', desc: 'Keyboard shortcuts and commands' },
];

const draftKey = (id) => `harness.draft.${id || 'new'}`;
const loadDraft = (id) => { try { return localStorage.getItem(draftKey(id)) || ''; } catch { return ''; } };
const saveDraft = (id, v) => { try { if (v) localStorage.setItem(draftKey(id), v); else localStorage.removeItem(draftKey(id)); } catch { /* ignore */ } };

export class Composer {
  /** host: { getModel(): ChatModel|null, ensureChat(): Promise<ChatModel>, send({content, attachments}), generateImage(prompt), stop() } */
  constructor(host) {
    this.host = host;
    this.attachments = []; // { localId, file, status: uploading|ready|error, attachment?, error? }
    this.slashIndex = 0;
    this.chatId = null;

    this.input = h('textarea.composer-input', { rows: 1, placeholder: 'Message', attrs: { 'aria-label': 'Message', 'aria-autocomplete': 'list', spellcheck: 'true' } });
    this.attachRow = h('div.attach-row', { hidden: true });
    this.slashEl = h('div.slash-menu', { hidden: true, role: 'listbox', attrs: { 'aria-label': 'Commands' } });
    this.pickers = h('div.composer-left');
    this.meter = h('div.composer-meter');
    this.sendBtn = h('button.send-btn', { type: 'button', on: { click: () => this.onSendClick() } });
    this.hint = h('div.composer-hint');
    this.box = h('div.composer', this.attachRow, this.slashEl, this.input,
      h('div.composer-bar', this.pickers, h('div.composer-right', this.meter, this.sendBtn)));
    this.el = h('div.composer-wrap', this.box, this.hint);

    this.input.addEventListener('input', () => this.onInput());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('paste', (e) => this.onPaste(e));
    this.input.addEventListener('focus', () => this.box.classList.add('focused'));
    this.input.addEventListener('blur', () => { this.box.classList.remove('focused'); setTimeout(() => this.hideSlash(), 150); });
    this.previewDraft = debounce(() => {
      const m = this.host.getModel();
      if (m && !m.generating && m.path.length) m.refreshContext({ draft: this.input.value });
    }, 700);
    this.offs = [
      store.watch(['settings', 'models', 'defaultModel', 'presets'], () => this.renderBar()),
    ];
    this.renderBar();
  }

  destroy() { this.offs.forEach((o) => o()); this.modelOffs?.forEach((o) => o()); }

  /** Bind to a chat (or null for a new chat). Saves/restores drafts. */
  bind(model) {
    const nextId = model?.id || null;
    if (nextId !== this.chatId || !this.initialized) {
      if (this.initialized) saveDraft(this.chatId, this.input.value);
      this.chatId = nextId;
      this.input.value = loadDraft(nextId);
      this.initialized = true;
      if (this.attachments.length) { this.attachments = []; this.renderAttachments(); }
      autosize(this.input);
    }
    this.modelOffs?.forEach((o) => o());
    this.modelOffs = model ? [model.on('live', () => this.renderSend()), model.on('meta', () => this.renderBar()), model.on('context', () => this.renderMeter())] : [];
    this.renderBar();
  }

  focus() { this.input.focus(); }

  // ------------------------------------------------------------------------------------------ effective settings
  pending() { return store.get('pendingChat') || {}; }
  chatSettings() { return this.host.getModel()?.chat?.settings || this.pending().settings || {}; }
  incognito() { const m = this.host.getModel(); return m ? !!m.chat?.incognito : !!this.pending().incognito; }

  effectiveModel() {
    const m = this.host.getModel();
    const cs = this.chatSettings();
    return cs.model || m?.chat?.model || store.get('defaultModel') || null;
  }

  async patchChat(patch) {
    const m = this.host.getModel();
    if (!m) {
      const p = this.pending();
      const settings = { ...(p.settings || {}) };
      if (patch.settings) for (const [k, v] of Object.entries(patch.settings)) { if (v === null) delete settings[k]; else settings[k] = typeof v === 'object' && !Array.isArray(v) ? { ...(settings[k] || {}), ...v } : v; }
      store.set('pendingChat', { ...p, settings, ...(patch.incognito !== undefined ? { incognito: patch.incognito } : {}) });
      this.renderBar();
      this.host.onPendingChange?.();
      return;
    }
    try {
      const d = await api.chats.update(m.id, patch);
      m.setChatMeta(d.chat);
      this.renderBar();
      m.refreshContext().catch(() => {});
    } catch (e) { showError(e, 'change the chat settings'); }
  }

  // ------------------------------------------------------------------------------------------ bar
  renderBar() {
    const s = store.get('settings');
    if (!s) return;
    const cs = this.chatSettings();
    const ref = this.effectiveModel();
    const info = findModel(ref);
    const caps = info?.capabilities || [];
    const presets = store.get('presets') || [];
    const presetId = cs.presetId || s.defaultPresetId || 'default';
    const preset = presets.find((p) => p.id === presetId);
    const toolsOn = cs.tools?.enabled ?? s.tools?.enabled ?? true;
    const think = cs.reasoning?.think ?? s.reasoning?.think ?? 'auto';
    const thinkOn = think !== 'off';
    const incog = this.incognito();
    const memOn = !incog && (cs.memory?.enabled ?? s.memory?.enabled ?? true);
    const noModel = !ref;

    const modelBtn = h('button.picker', { type: 'button', title: 'Model for this chat', 'aria-haspopup': 'dialog', on: { click: (e) => this.openModelPicker(e.currentTarget) } },
      icon('cube', { size: 14 }), h('span.picker-label', noModel ? 'No model' : modelLabel(info?.name || ref.model)), icon('chevronDown', { size: 11 }));
    const presetBtn = h('button.picker.hide-narrow', { type: 'button', title: 'Preset / persona', 'aria-haspopup': 'menu', on: { click: (e) => this.openPresetMenu(e.currentTarget) } },
      icon('book', { size: 14 }), h('span.picker-label', preset?.name || 'Assistant'), icon('chevronDown', { size: 11 }));
    const toggle = (label, iconName, on, title, run, extra = {}) => h('button.toggle', { type: 'button', 'aria-pressed': String(!!on), title, on: { click: run }, ...extra }, icon(iconName, { size: 14 }), h('span.toggle-label', label));
    this.pickers.replaceChildren(
      h('button.icon-btn.attach-btn', { type: 'button', title: 'Attach files (images, PDFs, text, code)', 'aria-label': 'Attach files', on: { click: () => this.pick() } }, icon('paperclip')),
      modelBtn,
      presetBtn,
      h('span.bar-sep'),
      toggle('Tools', 'tools', toolsOn, toolsOn ? 'Tools on: calculator, time, memory, images… (click to turn off for this chat)' : 'Tools off for this chat', () => this.patchChat({ settings: { tools: { enabled: !toolsOn } } })),
      caps.includes('thinking') ? toggle('Think', 'think', thinkOn, thinkOn ? 'Thinking on: the model reasons before answering (slower, often better)' : 'Thinking off: faster answers', () => this.patchChat({ settings: { reasoning: { think: thinkOn ? 'off' : 'on' } } })) : null,
      toggle('Memory', 'memory', memOn, incog ? 'Memory is off in incognito chats' : memOn ? 'Memory on: relevant memories are added and new facts may be saved' : 'Memory off for this chat', () => this.patchChat({ settings: { memory: { enabled: !memOn } } }), { disabled: incog }),
      toggle('Incognito', 'incognito', incog, incog ? 'Incognito: nothing from this chat is remembered or recalled' : 'Make this chat incognito (no memory, not recalled later)', () => this.patchChat({ incognito: !incog }), { class: 'toggle-incognito' }),
    );
    this.box.classList.toggle('incognito', incog);
    this.renderSend();
    this.renderMeter();
    this.renderHint();
  }

  renderMeter() {
    const m = this.host.getModel();
    this.meter.replaceChildren(miniMeter(m ? m.context : null, m ? m.plan : this.newChatPlan, () => runAction('show-context')));
    if (!m && !this.newChatPlan && this.effectiveModel()) {
      const ref = this.effectiveModel();
      const key = `${ref.providerId}|${ref.model}`;
      if (this._planKey !== key) {
        this._planKey = key;
        modelInfo(ref).then((r) => { this.newChatPlan = r?.contextPlan || null; this.renderMeter(); }).catch(() => {});
      }
    }
  }

  renderHint() {
    const sendKey = uiPrefs().sendKey === 'mod-enter' ? `${keyLabel('Mod+Enter')} to send · ${keyLabel('Enter')} new line` : `${keyLabel('Enter')} to send · ${keyLabel('Shift+Enter')} new line`;
    const incog = this.incognito();
    this.hint.replaceChildren(
      incog ? h('span.hint-incog', icon('incognito', { size: 12 }), 'Incognito — not remembered, not searchable by recall') : null,
      h('span.hint-keys', `${sendKey} · / for commands`),
    );
  }

  renderSend() {
    const m = this.host.getModel();
    const busy = !!m?.generating;
    const busyHere = !!m?.live;
    const hasContent = !!this.input.value.trim() || this.readyAttachments().length > 0;
    const uploading = this.attachments.some((a) => a.status === 'uploading');
    const noModel = !this.effectiveModel();
    this.sendBtn.replaceChildren(icon(busy ? 'stop' : 'send', { size: busy ? 12 : 15 }));
    this.sendBtn.classList.toggle('stop', busy);
    this.sendBtn.setAttribute('aria-label', busy ? 'Stop generating' : 'Send');
    this.sendBtn.title = busy ? `Stop (${keyLabel('Escape')})` : noModel ? 'Install a model first' : uploading ? 'Waiting for uploads…' : 'Send';
    this.sendBtn.disabled = busy ? false : (!hasContent || uploading || (noModel && !this.input.value.trim().startsWith('/')));
    this.box.classList.toggle('busy', busyHere);
  }

  // ------------------------------------------------------------------------------------------ pickers
  openModelPicker(anchor) {
    const list = chatModels();
    const current = this.effectiveModel();
    const filter = h('input.input.input-small', { type: 'search', placeholder: 'Filter models', attrs: { 'aria-label': 'Filter models' } });
    const ul = h('div.model-options', { role: 'listbox', attrs: { 'aria-label': 'Models' } });
    let pop = null;
    const render = () => {
      const q = filter.value.trim().toLowerCase();
      const items = list.filter((m) => !q || m.model.toLowerCase().includes(q) || (m.providerName || '').toLowerCase().includes(q));
      const groups = new Map();
      for (const m of items) { if (!groups.has(m.providerName)) groups.set(m.providerName, []); groups.get(m.providerName).push(m); }
      ul.replaceChildren(...[...groups].flatMap(([prov, ms]) => [
        h('div.menu-heading', prov),
        ...ms.map((m) => {
          const sel = sameRef(current, m) || (current && !current.providerId && current.model === m.model);
          const caps = m.capabilities || [];
          return h('button.model-option', { type: 'button', role: 'option', 'aria-selected': String(!!sel), on: { click: () => { pop.close(true); this.patchChat({ settings: { model: { providerId: m.providerId, model: m.model } } }); } } },
            h('span.menu-check', sel ? icon('check', { size: 14 }) : null),
            h('span.mo-main', h('span.mo-name', modelLabel(m.name)), h('span.mo-meta.num', [m.parameterSize, m.quantization, m.sizeBytes ? fmtBytes(m.sizeBytes) : null, m.contextLength ? `${fmtTokens(m.contextLength)} ctx` : null].filter(Boolean).join(' · '))),
            h('span.mo-caps', caps.includes('vision') ? h('span.badge', { title: 'Can see images' }, 'vision') : null, caps.includes('thinking') ? h('span.badge', { title: 'Can think before answering' }, 'think') : null, caps.includes('tools') ? null : h('span.badge.warn', { title: 'Cannot call tools' }, 'no tools')),
            m.loaded ? h('span.dot.ok', { title: 'Loaded in memory' }) : null);
        }),
      ]));
      if (!items.length) ul.append(h('div.empty.small', list.length ? 'No match' : 'No chat models installed'));
    };
    filter.addEventListener('input', render);
    filter.addEventListener('keydown', (e) => {
      const opts = [...ul.querySelectorAll('.model-option')];
      if (e.key === 'ArrowDown') { e.preventDefault(); opts[0]?.focus(); }
      if (e.key === 'Enter' && opts.length === 1) { e.preventDefault(); opts[0].click(); }
    });
    ul.addEventListener('keydown', (e) => {
      const opts = [...ul.querySelectorAll('.model-option')];
      const i = opts.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); opts[Math.min(i + 1, opts.length - 1)]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) filter.focus(); else opts[i - 1].focus(); }
    });
    render();
    const cs = this.chatSettings();
    const foot = h('div.picker-foot',
      cs.model ? h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: () => { pop.close(true); this.patchChat({ settings: { model: null } }); } } }, 'Use default model') : null,
      h('span.spacer'),
      h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: () => { pop.close(); runAction('open-models'); } } }, icon('cube', { size: 13 }), 'Manage models…'));
    pop = openPopover(anchor, h('div.model-picker', h('div.picker-search', filter), ul, foot), { placement: 'top-start', label: 'Choose model' });
    filter.focus();
  }

  openPresetMenu(anchor) {
    const s = store.get('settings');
    const cs = this.chatSettings();
    const cur = cs.presetId || s.defaultPresetId || 'default';
    const presets = store.get('presets') || [];
    openMenu(anchor, [
      ...presets.map((p) => ({ label: p.name, hint: p.description ? null : null, checked: p.id === cur, run: () => this.patchChat({ settings: { presetId: p.id } }) })),
      { separator: true },
      { label: 'Edit presets…', icon: 'book', run: () => runAction('open-settings', 'presets') },
    ], { placement: 'top-start', label: 'Preset' });
  }

  // ------------------------------------------------------------------------------------------ attachments
  async pick() {
    const files = await pickFiles({ multiple: true });
    if (files.length) this.addFiles(files);
  }

  addFiles(files) {
    for (const file of files) {
      if (file.size > 50 * 1024 * 1024) { toast({ kind: 'error', message: `${file.name} is too large`, detail: 'Attachments can be up to 50 MB.' }); continue; }
      const a = { localId: Math.random().toString(36).slice(2), file, status: 'uploading', preview: /^image\//.test(file.type) ? URL.createObjectURL(file) : null };
      this.attachments.push(a);
      this.upload(a);
    }
    this.renderAttachments();
  }

  async upload(a) {
    try {
      const { attachment } = await api.attachments.upload(a.file, { chatId: this.chatId || undefined });
      a.attachment = attachment;
      a.status = attachment.status === 'error' ? 'error' : 'ready';
      a.error = attachment.error;
    } catch (e) {
      a.status = 'error';
      a.error = e.message;
    }
    this.renderAttachments();
  }

  readyAttachments() { return this.attachments.filter((a) => a.status === 'ready'); }

  removeAttachment(a) {
    this.attachments = this.attachments.filter((x) => x !== a);
    if (a.preview) URL.revokeObjectURL(a.preview);
    if (a.attachment?.id) api.attachments.remove(a.attachment.id).catch(() => {});
    this.renderAttachments();
  }

  renderAttachments() {
    this.attachRow.hidden = !this.attachments.length;
    const visionOk = (findModel(this.effectiveModel())?.capabilities || []).includes('vision');
    this.attachRow.replaceChildren(...this.attachments.map((a) => {
      const att = a.attachment;
      const isImg = (att?.kind || (a.preview ? 'image' : '')) === 'image';
      const meta = a.status === 'uploading' ? 'Uploading…' : a.status === 'error' ? (a.error || 'Unusable') : isImg ? `${att.width}×${att.height}${visionOk ? '' : ' · model can’t see images'}` : att?.source === 'pdf' ? `PDF · ${att.pages} pages · ~${fmtTokens(att.tokens)} tokens` : `~${fmtTokens(att?.tokens)} tokens${att?.chunks > 1 ? ' · searched by excerpt' : ''}`;
      return h(`div.att${a.status === 'error' ? '.att-error' : ''}`, { title: `${a.file.name} · ${fmtBytes(a.file.size)}${a.error ? `\n${a.error}` : ''}` },
        isImg && a.preview ? h('img.att-img', { src: a.preview, alt: '' }) : h('span.att-icon', a.status === 'uploading' ? h('span.spinner.small') : icon(a.status === 'error' ? 'warning' : 'file', { size: 15 })),
        h('span.att-text', h('span.att-name', a.file.name), h('span.att-meta', meta)),
        h('button.icon-btn.small', { type: 'button', 'aria-label': `Remove ${a.file.name}`, on: { click: () => this.removeAttachment(a) } }, icon('x', { size: 12 })));
    }));
    this.renderSend();
  }

  onPaste(e) {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); this.addFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i}.${(f.type.split('/')[1] || 'bin').replace('jpeg', 'jpg')}`, { type: f.type })))); }
  }

  // ------------------------------------------------------------------------------------------ input
  onInput() {
    autosize(this.input);
    saveDraft(this.chatId, this.input.value);
    this.renderSend();
    this.updateSlash();
    this.previewDraft();
  }

  onKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (!this.slashEl.hidden) {
      const opts = this.slashOptions();
      if (e.key === 'ArrowDown') { e.preventDefault(); this.slashIndex = (this.slashIndex + 1) % opts.length; this.renderSlash(opts); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.slashIndex = (this.slashIndex - 1 + opts.length) % opts.length; this.renderSlash(opts); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && opts[this.slashIndex] && !this.input.value.includes(' '))) { e.preventDefault(); this.completeSlash(opts[this.slashIndex]); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.hideSlash(); return; }
    }
    const modEnter = uiPrefs().sendKey === 'mod-enter';
    if (e.key === 'Enter') {
      const wantsSend = modEnter ? (e.metaKey || e.ctrlKey) : !e.shiftKey && !e.altKey;
      if (wantsSend) { e.preventDefault(); this.submit(); }
    } else if (e.key === 'Escape' && this.host.getModel()?.generating) {
      e.preventDefault();
      this.host.stop();
    } else if (e.key === 'ArrowUp' && !this.input.value && !e.shiftKey) {
      // Up in an empty composer: edit the last user message (like many chat apps).
      const m = this.host.getModel();
      const lastUser = m && [...m.pathMessages()].reverse().find((x) => x.role === 'user' && x.kind !== 'image_request');
      if (lastUser && !m.generating) { e.preventDefault(); this.host.editMessage?.(lastUser.id); }
    }
  }

  slashOptions() {
    const v = this.input.value;
    const word = v.split(/\s/)[0].toLowerCase();
    return SLASH.filter((c) => c.cmd.startsWith(word) || (c.alias || []).some((a) => a.startsWith(word)));
  }

  updateSlash() {
    const v = this.input.value;
    if (!v.startsWith('/') || v.includes('\n') || /\s/.test(v.trim()) && !this.slashOptions().length) { this.hideSlash(); return; }
    if (/\s/.test(v)) { this.hideSlash(); return; }
    const opts = this.slashOptions();
    if (!opts.length) { this.hideSlash(); return; }
    this.slashIndex = Math.min(this.slashIndex, opts.length - 1);
    this.renderSlash(opts);
  }

  renderSlash(opts) {
    this.slashEl.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.slashEl.replaceChildren(...opts.map((c, i) => h('button.slash-item', {
      type: 'button', role: 'option', id: `slash-${i}`, 'aria-selected': String(i === this.slashIndex),
      on: { mousedown: (e) => { e.preventDefault(); this.completeSlash(c); } },
    }, h('span.slash-cmd', c.cmd), c.args ? h('span.slash-args', c.args) : null, h('span.slash-desc', c.desc))));
    this.input.setAttribute('aria-activedescendant', `slash-${this.slashIndex}`);
  }

  hideSlash() {
    this.slashEl.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  completeSlash(c) {
    if (c.needsArg || c.args) { this.input.value = `${c.cmd} `; this.hideSlash(); this.input.focus(); autosize(this.input); this.renderSend(); return; }
    this.input.value = c.cmd;
    this.hideSlash();
    this.submit();
  }

  onSendClick() {
    const m = this.host.getModel();
    if (m?.generating) this.host.stop();
    else this.submit();
  }

  /** Parse slash commands, else send. */
  async submit() {
    const raw = this.input.value;
    const text = raw.trim();
    const m = this.host.getModel();
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.split(/\s+/);
      const arg = text.slice(cmd.length).trim();
      const known = SLASH.find((c) => c.cmd === cmd.toLowerCase() || (c.alias || []).includes(cmd.toLowerCase()));
      if (known) {
        if (known.needsArg && !arg) { toast({ kind: 'info', message: `${known.cmd} needs ${known.args}` }); return; }
        this.clear();
        await this.runSlash(known.cmd, arg, rest);
        return;
      }
    }
    if (!text && !this.readyAttachments().length) return;
    if (m?.generating) { this.host.busy(); return; }
    if (this.attachments.some((a) => a.status === 'uploading')) { toast({ message: 'Still uploading attachments…', id: 'uploading' }); return; }
    if (!this.effectiveModel()) { runAction('open-setup'); return; }
    const attachments = this.readyAttachments().map((a) => a.attachment.id);
    const sentText = raw;
    const sentAtts = this.attachments;
    this.clear({ keepAttachments: false });
    const ok = await this.host.send({ content: sentText, attachments });
    if (ok === false && !this.input.value) {
      // Put the text back so nothing typed is lost when sending failed before the stream started.
      this.input.value = sentText;
      this.attachments = sentAtts;
      autosize(this.input);
      saveDraft(this.chatId, sentText);
      this.renderAttachments();
    } else {
      for (const a of sentAtts) if (a.preview) URL.revokeObjectURL(a.preview);
    }
  }

  async runSlash(cmd, arg) {
    switch (cmd) {
      case '/image': await this.host.generateImage(arg); break;
      case '/remember':
        try { const r = await api.memories.create({ content: arg }); toast({ kind: 'success', message: r.action === 'unchanged' ? 'Already remembered' : r.action === 'updated' ? 'Memory updated' : 'Remembered', detail: r.memory.content, action: { label: 'View', run: () => runAction('open-memory') } }); } catch (e) { showError(e, 'save the memory'); }
        break;
      case '/compact': runAction('compact-chat'); break;
      case '/new': runAction('new-chat'); break;
      case '/incognito': runAction('new-incognito-chat'); break;
      case '/model': {
        if (arg) {
          const hit = chatModels().find((x) => x.model.toLowerCase().includes(arg.toLowerCase()));
          if (hit) await this.patchChat({ settings: { model: { providerId: hit.providerId, model: hit.model } } });
          else toast({ kind: 'warn', message: `No installed model matches “${arg}”` });
        } else this.openModelPicker(this.pickers.querySelector('.picker'));
        break;
      }
      case '/export': runAction('export-chat'); break;
      case '/help': runAction('show-shortcuts'); break;
      default: break;
    }
  }

  clear({ keepAttachments = false } = {}) {
    this.input.value = '';
    saveDraft(this.chatId, '');
    if (!keepAttachments) this.attachments = [];
    autosize(this.input);
    this.hideSlash();
    this.renderAttachments();
  }

  /** Called by the view when a new chat was created for the first message. */
  adoptNewChat(id) {
    saveDraft(null, '');
    this.chatId = id;
  }
}
