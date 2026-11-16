// Settings: every key of the settings schema, grouped into sections with the essentials first and the
// rest behind "Advanced". Each control saves immediately (text fields on change), shows the server's
// validation message inline, and offers "Reset" when it differs from the default.
import { h, debounce, download, pickFiles, mount, add } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { fmtBytes, fmtTokens, modelLabel, fmtFull, isMac } from '../lib/format.js';
import { store, patchSettings, setUiPref, uiPrefs, chatModels, loadSettings, loadPresets, loadSystem, loadModels, loadChats } from '../state.js';
import * as api from '../api.js';
import { SETTINGS_SECTIONS } from './settings-sections.js';
import { navigate } from '../router.js';
import { toast, confirmDialog, openDialog } from '../ui/overlays.js';
import { showError, explainError } from '../errors.js';
import { runAction } from '../actions.js';
import { privacySection, backupDialog, restoreBackup } from './privacy.js';

const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
const patchFor = (path, value) => {
  const keys = path.split('.');
  const out = {};
  let o = out;
  keys.forEach((k, i) => { if (i === keys.length - 1) o[k] = value; else { o[k] = {}; o = o[k]; } });
  return out;
};
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const THINK = [['auto', 'Off'], ['on', 'On'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];

/** Field descriptors per section. `adv: true` goes behind the "Advanced" disclosure. */
function fieldsFor(section) {
  const modelOpt = (label) => ({ type: 'model', nullLabel: label });
  switch (section) {
    case 'general': return [
      { ui: 'theme', label: 'Appearance', type: 'segmented', options: [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], dflt: 'system' },
      { ui: 'proseFont', label: 'Answer typeface', help: 'Long answers can be set in a serif for easier reading.', type: 'segmented', options: [['sans', 'System sans'], ['serif', 'Serif']], dflt: 'sans' },
      { ui: 'textSize', label: 'Text size', type: 'segmented', options: [['small', 'Small'], ['default', 'Default'], ['large', 'Large']], dflt: 'default' },
      { ui: 'sendKey', label: 'Send with', type: 'segmented', options: [['enter', 'Enter'], ['mod-enter', isMac ? '⌘ Enter' : 'Ctrl Enter']], dflt: 'enter', help: 'The other key combination inserts a new line.' },
      { path: 'defaultModel', label: 'Default model', help: 'Auto picks the first installed recommended model (Nemotron 3.5 Bolt first).', ...modelOpt('Auto') },
      { path: 'defaultPresetId', label: 'Default preset', type: 'preset' },
      { path: 'titles.auto', label: 'Name chats automatically', help: 'After the first reply the chat model suggests a short title.', type: 'switch' },
      { path: 'titles.model', label: 'Model for titles', adv: true, ...modelOpt('Same as the chat') },
      { path: 'security.allowedOrigins', label: 'Other web pages allowed to use Harness', type: 'tags', empty: [], adv: true, placeholder: 'e.g. http://localhost:5173', help: 'Only for development tools on another local port. The Harness window itself is always allowed.' },
    ];
    case 'model': return [
      { path: 'reasoning.think', label: 'Thinking by default', help: 'For models that can reason before answering: slower first token, often better answers. Each chat can switch it from the composer.', type: 'segmented', options: THINK },
      { path: 'context.mode', label: 'Context window', type: 'contextMode', help: 'Auto picks the largest window that safely fits in memory on this machine.' },
      { path: 'keepAlive', label: 'Keep model loaded', type: 'select', options: [['5m', '5 minutes'], ['30m', '30 minutes'], ['2h', '2 hours'], ['-1', 'Always'], ['0', 'Unload after each reply']], help: 'How long Ollama keeps the model in memory after a reply.' },
      { path: 'systemPrompt', label: 'System prompt override', type: 'textarea', nullable: true, placeholder: 'Empty: use the preset’s instructions', help: 'Applies to every chat unless the chat sets its own.' },
      { label: 'Sampling', type: 'heading', adv: true, help: 'Empty = let the model decide (Modelfile defaults, then Harness’s per-model suggestions).' },
      { path: 'params.temperature', label: 'Temperature', type: 'number', min: 0, max: 5, step: 0.05, nullable: true, adv: true },
      { path: 'params.top_p', label: 'Top P', type: 'number', min: 0, max: 1, step: 0.01, nullable: true, adv: true },
      { path: 'params.top_k', label: 'Top K', type: 'number', min: 0, max: 1000, step: 1, nullable: true, adv: true },
      { path: 'params.min_p', label: 'Min P', type: 'number', min: 0, max: 1, step: 0.01, nullable: true, adv: true },
      { path: 'params.repeat_penalty', label: 'Repeat penalty', type: 'number', min: 0, max: 5, step: 0.05, nullable: true, adv: true },
      { path: 'params.seed', label: 'Seed', type: 'number', step: 1, nullable: true, adv: true },
      { path: 'params.num_predict', label: 'Max reply tokens', type: 'number', min: -2, step: 64, nullable: true, adv: true },
      { path: 'params.stop', label: 'Stop sequences', type: 'tags', adv: true, help: 'Comma separated.' },
      { label: 'Context sizing', type: 'heading', adv: true },
      { path: 'context.maxAuto', label: 'Cap for auto mode', type: 'number', min: 512, step: 1024, nullable: true, adv: true, unit: 'tokens' },
      { path: 'context.lowRamCap', label: 'Cap on 8 GB machines', type: 'number', min: 2048, step: 1024, nullable: true, adv: true, unit: 'tokens', help: 'Long prompts are slow to process on small Macs; empty removes the cap.' },
      { path: 'context.replyReserve', label: 'Reply reserve', type: 'number', min: 64, max: 65536, step: 64, auto: true, adv: true, unit: 'tokens', help: 'Auto: 15 % of the window (384–8192).' },
      { path: 'context.kvCacheType', label: 'KV cache precision (estimate)', type: 'select', options: [['auto', 'Auto'], ['f16', 'f16'], ['q8_0', 'q8_0'], ['q4_0', 'q4_0']], adv: true },
      { path: 'context.useMeasurements', label: 'Learn real memory use', type: 'switch', adv: true, help: 'Correct the RAM estimate from what Ollama actually uses for each model, so the window adapts after the first reply.' },
      { path: 'context.memoryFraction', label: 'Safe RAM fraction', type: 'number', min: 0.1, max: 1, step: 0.05, nullable: true, adv: true, help: 'Override how much of RAM Harness plans to use. Empty = automatic.' },
    ];
    case 'summarizer': return [
      { path: 'compaction.enabled', label: 'Summarize long chats automatically', type: 'switch', help: 'When the prompt gets close to the context window, older messages are condensed into a rolling summary. Messages are never deleted.' },
      { path: 'compaction.threshold', label: 'Summarize when the prompt reaches', type: 'slider', min: 0.3, max: 0.98, step: 0.01, format: 'pct', suffix: 'of the budget' },
      { path: 'compaction.target', label: 'Shrink the prompt to about', type: 'slider', min: 0.1, max: 0.9, step: 0.01, format: 'pct', suffix: 'of the budget' },
      { path: 'compaction.keepRecentFraction', label: 'Keep recent messages verbatim', type: 'slider', min: 0.05, max: 0.8, step: 0.01, format: 'pct', suffix: 'of the budget', adv: true },
      { path: 'compaction.minKeepMessages', label: 'Always keep at least', type: 'number', min: 1, max: 50, step: 1, unit: 'messages', adv: true },
      { path: 'compaction.maxSummaryTokens', label: 'Summary length limit', type: 'number', min: 64, max: 16000, step: 64, auto: true, unit: 'tokens', adv: true, help: 'Auto: 12 % of the window (192–3000).' },
      { path: 'compaction.model', label: 'Summarizer model', adv: true, help: 'Using the chat model itself avoids loading a second model.', ...modelOpt('Same as the chat') },
    ];
    case 'memory': return [
      { path: 'memory.enabled', label: 'Long-term memory', type: 'switch', help: 'Relevant memories are added to prompts; pinned ones always.' },
      { path: 'memory.autoExtract', label: 'Learn from conversations', type: 'switch', help: 'A few seconds after each reply, durable facts and preferences are saved. Secrets are never stored.' },
      { path: 'recall.enabled', label: 'Recall past chats', type: 'switch', help: 'Lets the model search earlier conversations (incognito chats are excluded).' },
      { path: 'recall.autoInject', label: 'Add relevant past excerpts automatically', type: 'switch' },
      { path: 'embeddings.model', label: 'Embedding model', type: 'embedModel' },
      { label: 'Memory retrieval', type: 'heading', adv: true },
      { path: 'memory.topK', label: 'Memories per turn', type: 'number', min: 0, max: 50, step: 1, adv: true },
      { path: 'memory.maxTokens', label: 'Memory token budget', type: 'number', min: 0, max: 20000, step: 32, auto: true, adv: true, unit: 'tokens', help: 'Auto: 5 % of the window.' },
      { path: 'memory.minSimilarity', label: 'Minimum similarity', type: 'slider', min: 0, max: 1, step: 0.01, adv: true },
      { path: 'memory.placement', label: 'Where memories go', type: 'segmented', options: [['turn', 'With the message'], ['system', 'System prompt']], adv: true, help: '“With the message” keeps Ollama’s prompt cache valid (faster on small machines).' },
      { path: 'memory.extractDelayMs', label: 'Extraction delay', type: 'number', min: 0, max: 600000, step: 500, adv: true, unit: 'ms' },
      { path: 'memory.model', label: 'Extraction model', adv: true, ...modelOpt('Same as the chat') },
      { label: 'Recall', type: 'heading', adv: true },
      { path: 'recall.topK', label: 'Past excerpts per turn', type: 'number', min: 0, max: 20, step: 1, adv: true },
      { path: 'recall.maxTokens', label: 'Recall token budget', type: 'number', min: 0, max: 20000, step: 32, auto: true, adv: true, unit: 'tokens' },
      { path: 'recall.minSimilarity', label: 'Minimum similarity', type: 'slider', min: 0, max: 1, step: 0.01, adv: true },
      { label: 'Documents', type: 'heading', adv: true, help: 'Small files are sent whole; large ones are split and only relevant excerpts are sent.' },
      { path: 'documents.inlineMaxTokens', label: 'Send files whole up to', type: 'number', min: 0, max: 200000, step: 256, auto: true, adv: true, unit: 'tokens', help: 'Auto: 25 % of the window.' },
      { path: 'documents.topK', label: 'Excerpts per turn', type: 'number', min: 1, max: 50, step: 1, adv: true },
      { path: 'documents.maxTokens', label: 'Excerpt token budget', type: 'number', min: 64, max: 100000, step: 64, auto: true, adv: true, unit: 'tokens' },
      { path: 'documents.chunkTokens', label: 'Excerpt size', type: 'number', min: 100, max: 4000, step: 50, adv: true, unit: 'tokens' },
      { path: 'documents.maxHistoryImages', label: 'Re-send images from the last', type: 'number', min: 0, max: 50, step: 1, adv: true, unit: 'messages' },
    ];
    case 'tools': return [
      { path: 'tools.enabled', label: 'Let models use tools', type: 'switch', help: 'Models that support tool calling can use the tools below. Turn off per chat from the composer.' },
      { path: 'tools.builtin.calculate', label: 'Calculator', type: 'switch', help: 'Exact arithmetic.' },
      { path: 'tools.builtin.get_current_time', label: 'Current time', type: 'switch' },
      { path: 'tools.builtin.remember', label: 'Remember', type: 'switch', help: 'The model may save a memory when you ask it to.' },
      { path: 'tools.builtin.recall', label: 'Recall past chats', type: 'switch' },
      { path: 'tools.builtin.generate_image', label: 'Generate images', type: 'switch', help: 'Needs an image backend (Draw Things’ API server).' },
      { path: 'tools.builtin.fetch_url', label: 'Fetch web pages', type: 'switch', help: 'The only tool that uses the network. Off by default.' },
      { path: 'tools.fetchUrl.allowPrivateNetwork', label: 'Allow fetching localhost / LAN addresses', type: 'switch', adv: true },
      { path: 'tools.fetchUrl.maxChars', label: 'Max characters per page', type: 'number', min: 500, max: 200000, step: 500, adv: true },
      { path: 'tools.maxIterations', label: 'Max tool calls per turn', type: 'number', min: 1, max: 25, step: 1, adv: true },
    ];
    case 'images': return [
      { path: 'image.enabled', label: 'Image generation', type: 'switch' },
      { path: 'image.providerId', label: 'Image backend', type: 'imageProvider' },
      { path: 'image.model', label: 'Image model', type: 'imageModel' },
      { path: 'image.unloadChatModel', label: 'Free memory for images', type: 'segmented', options: [['auto', 'Auto'], ['always', 'Always'], ['never', 'Never']], help: 'Unload the chat model while an image is generated. Auto: always on 8 GB machines, otherwise only when both would not fit.' },
      { path: 'image.reloadAfter', label: 'Reload the chat model', type: 'segmented', options: [['lazy', 'On next message'], ['eager', 'Right away']], help: 'On 8 GB machines the model always reloads on the next message.' },
      { path: 'image.feedbackToModel', label: 'Show generated images to vision models', type: 'switch' },
      { label: 'Defaults for new images', type: 'heading', adv: true, help: 'Empty = chosen per model family for this machine.' },
      { path: 'image.defaults.width', label: 'Width', type: 'number', min: 64, max: 4096, step: 64, nullable: true, adv: true, unit: 'px' },
      { path: 'image.defaults.height', label: 'Height', type: 'number', min: 64, max: 4096, step: 64, nullable: true, adv: true, unit: 'px' },
      { path: 'image.defaults.steps', label: 'Steps', type: 'number', min: 1, max: 200, step: 1, nullable: true, adv: true },
      { path: 'image.defaults.cfg', label: 'Guidance (CFG)', type: 'number', min: 0, max: 50, step: 0.5, nullable: true, adv: true },
      { path: 'image.defaults.sampler', label: 'Sampler', type: 'text', nullable: true, adv: true },
      { path: 'image.defaults.negativePrompt', label: 'Negative prompt', type: 'text', adv: true },
      { path: 'image.defaults.count', label: 'Images per request', type: 'number', min: 1, max: 8, step: 1, adv: true },
      { path: 'image.timeoutSec', label: 'Timeout', type: 'number', min: 10, max: 7200, step: 10, adv: true, unit: 's' },
      { path: 'image.autodetect', label: 'Detect Draw Things / ComfyUI automatically', type: 'switch', adv: true },
      { path: 'image.comfyWorkflow', label: 'ComfyUI workflow (API format)', type: 'json', adv: true, help: 'Placeholders: {{prompt}} {{negative_prompt}} {{seed}} {{steps}} {{cfg}} {{width}} {{height}} {{count}} {{model}} {{sampler}} {{scheduler}} {{denoise}} {{image}}' },
      { type: 'imageProviders' },
    ];
    case 'providers': return [
      { type: 'providers' },
      { path: 'providers.autodetect', label: 'Detect llama.cpp / MLX and LM Studio', type: 'switch', help: 'Probe ports 8080 and 1234; only running servers are listed.' },
      { path: 'providers.builtin.ollama.baseUrl', label: 'Ollama address', type: 'text', nullable: true, placeholder: 'http://127.0.0.1:11434', adv: true },
      { path: 'providers.builtin.llamacpp.baseUrl', label: 'llama.cpp / MLX address', type: 'text', adv: true },
      { path: 'providers.builtin.lmstudio.baseUrl', label: 'LM Studio address', type: 'text', adv: true },
      { label: 'When Harness starts Ollama', type: 'heading', help: 'Used only when Harness launches `ollama serve` itself.' },
      { path: 'ollama.autoStart', label: 'Start Ollama with Harness', type: 'switch' },
      { path: 'ollama.stopOnExit', label: 'Stop it when Harness quits', type: 'switch' },
      { path: 'ollama.noCloud', label: 'Turn off Ollama cloud features', type: 'switch', adv: true, help: 'Keeps everything on this computer (OLLAMA_NO_CLOUD).' },
      { path: 'ollama.promptCacheMiB', label: 'Prompt cache limit', type: 'number', min: 0, max: 65536, step: 64, auto: true, nullable: true, unit: 'MiB', adv: true, help: 'Caps the RAM Ollama keeps for reusing long prompts. Auto: 512 MiB on 8 GB machines.' },
      { path: 'ollama.flashAttention', label: 'Flash attention', type: 'switch', adv: true },
      { path: 'ollama.kvCacheType', label: 'KV cache type', type: 'select', options: [['f16', 'f16'], ['q8_0', 'q8_0 (half the memory)'], ['q4_0', 'q4_0']], adv: true },
      { path: 'ollama.numParallel', label: 'Parallel requests', type: 'number', min: 1, max: 16, step: 1, adv: true },
      { path: 'ollama.maxLoadedModels', label: 'Max loaded models', type: 'number', min: 1, max: 16, step: 1, auto: true, adv: true, help: 'Auto: 1 on 8 GB machines.' },
      { path: 'ollama.binaryPath', label: 'Path to ollama', type: 'text', nullable: true, adv: true, placeholder: 'Found automatically' },
      { path: 'ollama.extraEnv', label: 'Extra environment', type: 'json', adv: true, help: 'OLLAMA_* variables, e.g. {"OLLAMA_CONTEXT_LENGTH": "8192"}' },
    ];
    default: return [];
  }
}

export class SettingsView {
  constructor(shell) {
    this.shell = shell;
    this.section = 'general';
    this.showAdvanced = new Set();
    this.errors = new Map();
    this.nav = h('nav.settings-nav', { attrs: { 'aria-label': 'Settings sections' } });
    this.content = h('div.settings-content');
    this.scroller = h('div.view-scroll', h('div.settings-page', this.nav, this.content));
    this.el = h('div.view.settings-view', this.scroller);
    this.render = debounce(() => this.renderNow(), 40);
    this.offs = [store.watch(['settings', 'presets', 'system', 'models', 'security', 'network'], () => { if (!this.editing) this.render(); })];
    this.scroller.addEventListener('scroll', () => this.shell.setScrolled(this.scroller.scrollTop > 4), { passive: true });
  }

  show(r) {
    const s = SETTINGS_SECTIONS.some((x) => x.id === r.section) ? r.section : 'general';
    if (s !== this.section) this.scroller.scrollTop = 0;
    this.section = s;
    this.renderNow();
  }

  toolbar() { return { title: h('div.tb-title.page-title', h('span.title-text', 'Settings')), actions: [] }; }

  renderNow() {
    const s = store.get('settings');
    if (!s) return;
    mount(this.nav, ...SETTINGS_SECTIONS.map((x) => h('a.settings-nav-item', { href: `#/settings/${x.id}`, attrs: { 'aria-current': x.id === this.section ? 'page' : null } }, icon(x.icon, { size: 15 }), x.label)));
    const sec = SETTINGS_SECTIONS.find((x) => x.id === this.section);
    const body = h('div.settings-section');
    add(body, h('h1.h1', sec.label));
    if (this.section === 'privacy') add(body, privacySection(this));
    else if (this.section === 'presets') add(body, this.presetsSection());
    else if (this.section === 'data') add(body, this.dataSection());
    else if (this.section === 'about') add(body, this.aboutSection());
    else {
      const fields = fieldsFor(this.section);
      const basic = fields.filter((f) => !f.adv);
      const adv = fields.filter((f) => f.adv);
      add(body, h('div.form', basic.map((f) => this.field(f))));
      if (adv.length) {
        const open = this.showAdvanced.has(this.section);
        add(body, h('button.disclosure.adv-toggle', { type: 'button', 'aria-expanded': String(open), on: { click: () => { if (open) this.showAdvanced.delete(this.section); else this.showAdvanced.add(this.section); this.renderNow(); } } }, icon('chevronRight', { size: 12 }), 'Advanced'));
        if (open) add(body, h('div.form.form-adv', adv.map((f) => this.field(f))));
      }
      if (this.section === 'general') add(body, h('div.row.reset-all', h('span.spacer'), h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: () => this.resetAll() } }, 'Reset all settings…')));
    }
    mount(this.content, body);
  }

  async resetAll() {
    if (!await confirmDialog({ title: 'Reset all settings?', message: 'Every setting goes back to its default. Chats, memories, presets and images are not affected.', confirmLabel: 'Reset', danger: true })) return;
    try { await api.settings.reset(); await loadSettings(); toast({ kind: 'success', message: 'Settings reset' }); } catch (e) { showError(e, 'reset settings'); }
  }

  // ------------------------------------------------------------------------------------------ fields
  value(f) { return f.ui ? (uiPrefs()[f.ui] ?? f.dflt) : get(store.get('settings'), f.path); }
  dflt(f) { return f.ui ? f.dflt : get(store.get('defaults'), f.path); }

  async save(f, value) {
    this.errors.delete(f.path || f.ui);
    if (f.ui) { setUiPref(f.ui, value); this.flash({ path: `ui.${f.ui}` }); this.render(); return true; }
    try {
      await patchSettings(patchFor(f.path, value));
      this.flash(f);
      return true;
    } catch (e) {
      this.errors.set(f.path, e.code === 'bad_request' ? e.message : explainError(e).title);
      this.renderNow();
      return false;
    }
  }

  flash(f) {
    this.savedKey = f.path;
    clearTimeout(this.savedTimer);
    this.savedTimer = setTimeout(() => { this.savedKey = null; this.render(); }, 1400);
  }

  field(f) {
    if (f.type === 'heading') return h('div.form-heading', h('h3.h3', f.label), f.help ? h('p.field-help', f.help) : null);
    if (f.type === 'providers') return this.providersBlock();
    if (f.type === 'imageProviders') return this.imageProvidersBlock();
    const id = `f-${(f.path || f.ui).replace(/\./g, '-')}`;
    const v = this.value(f);
    const d = this.dflt(f);
    const err = this.errors.get(f.path || f.ui);
    const control = this.control(f, v, id);
    const changed = !same(v, d) && f.type !== 'json' || (f.type === 'json' && !same(v, d));
    const stacked = ['textarea', 'json', 'slider', 'contextMode', 'embedModel'].includes(f.type);
    return h(`div.form-row${stacked ? '.stacked' : ''}`, { dataset: { path: f.path || `ui.${f.ui}` } },
      h('div.form-label',
        h('label.field-label', { for: id }, f.label),
        f.help ? h('div.field-help', f.help) : null),
      h('div.form-control', control,
        h('div.form-meta',
          err ? h('span.field-error', { role: 'alert' }, err) : null,
          (f.path || f.ui) && this.savedKey === (f.path || `ui.${f.ui}`) ? h('span.saved', icon('check', { size: 12 }), 'Saved') : null,
          changed && f.type !== 'switch' && d !== undefined ? h('button.btn-link.small.reset-link', { type: 'button', on: { click: () => this.save(f, d) } }, 'Reset') : null)));
  }

  control(f, v, id) {
    switch (f.type) {
      case 'switch':
        return h('button.switch', { id, type: 'button', role: 'switch', 'aria-checked': String(!!v), on: { click: () => this.save(f, !v) } });
      case 'segmented':
        if (f.path === 'reasoning.think' && v === 'off') v = 'auto';
        return h('div.segmented', { id, role: 'radiogroup', attrs: { 'aria-label': f.label } }, f.options.map(([val, label]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === val), on: { click: () => this.save(f, val) } }, label)));
      case 'select': {
        const sel = h('select.select', { id, on: { change: (e) => this.save(f, e.target.value) } }, f.options.map(([val, label]) => h('option', { value: val, selected: String(v) === String(val) }, label)));
        if (!f.options.some(([val]) => String(val) === String(v)) && v != null) sel.prepend(h('option', { value: v, selected: true }, String(v)));
        return sel;
      }
      case 'number': {
        const isAuto = f.auto && v === 'auto';
        const input = h('input.input.input-num.num', { id, type: 'number', min: f.min, max: f.max, step: f.step || 'any', value: isAuto || v == null ? '' : v, placeholder: isAuto ? 'auto' : f.nullable ? 'default' : '', disabled: isAuto });
        input.addEventListener('change', () => {
          const raw = input.value.trim();
          if (!raw) { if (f.nullable) this.save(f, null); else if (f.auto) this.save(f, 'auto'); return; }
          this.save(f, Number(raw));
        });
        return h('div.row', input, f.unit ? h('span.muted.small', f.unit) : null,
          f.auto ? h('label.row.small.muted', h('input', { type: 'checkbox', checked: isAuto, on: { change: (e) => this.save(f, e.target.checked ? 'auto' : (typeof this.dflt(f) === 'number' ? this.dflt(f) : f.min || 512)) } }), 'Auto') : null);
      }
      case 'slider': {
        const fmt = (x) => (f.format === 'pct' ? `${Math.round(x * 100)} %` : Number(x).toFixed(2));
        const out = h('output.num', { for: id }, fmt(v));
        const range = h('input', { id, type: 'range', min: f.min, max: f.max, step: f.step, value: v });
        range.addEventListener('input', () => { out.textContent = fmt(range.value); });
        range.addEventListener('change', () => this.save(f, Number(range.value)));
        return h('div.slider-row', range, out, f.suffix ? h('span.muted.small', f.suffix) : null);
      }
      case 'text': {
        const input = h('input.input', { id, type: 'text', value: v ?? '', placeholder: f.placeholder || '' });
        input.addEventListener('change', () => { const t = input.value.trim(); this.save(f, t ? t : (f.nullable ? null : '')); });
        return input;
      }
      case 'textarea': {
        const ta = h('textarea.textarea', { id, rows: 5, value: v ?? '', placeholder: f.placeholder || '' });
        ta.addEventListener('focus', () => { this.editing = true; });
        ta.addEventListener('blur', () => { this.editing = false; });
        ta.addEventListener('change', () => { const t = ta.value; this.save(f, t.trim() ? t : (f.nullable ? null : '')); });
        return ta;
      }
      case 'tags': {
        const input = h('input.input', { id, type: 'text', value: (v || []).join(', '), placeholder: f.placeholder || 'e.g. <|end|>, ###' });
        input.addEventListener('change', () => { const list = input.value.split(',').map((x) => x.trim()).filter(Boolean); this.save(f, list.length ? list : (f.empty ?? null)); });
        return input;
      }
      case 'json': {
        const ta = h('textarea.textarea.mono', { id, rows: 6, value: v == null ? '' : JSON.stringify(v, null, 2), placeholder: 'null' });
        ta.addEventListener('focus', () => { this.editing = true; });
        ta.addEventListener('blur', () => { this.editing = false; });
        ta.addEventListener('change', () => {
          const t = ta.value.trim();
          if (!t) { this.save(f, f.path === 'ollama.extraEnv' ? {} : null); return; }
          try { this.save(f, JSON.parse(t)); ta.classList.remove('invalid'); } catch { ta.classList.add('invalid'); this.errors.set(f.path, 'Not valid JSON'); this.renderNow(); }
        });
        return ta;
      }
      case 'model': {
        const models = chatModels();
        const cur = v ? `${v.providerId || ''}|${v.model}` : '';
        const sel = h('select.select', { id, on: { change: (e) => { const val = e.target.value; if (!val) { this.save(f, null); return; } const [providerId, ...rest] = val.split('|'); this.save(f, { providerId: providerId || undefined, model: rest.join('|') }); } } },
          h('option', { value: '' }, f.nullLabel || 'Default'),
          ...models.map((m) => h('option', { value: `${m.providerId}|${m.model}`, selected: cur === `${m.providerId}|${m.model}` || (v && !v.providerId && v.model === m.model) }, `${modelLabel(m.name)}${m.providerId !== 'ollama' ? ` (${m.providerName})` : ''}`)));
        if (v && !models.some((m) => m.model === v.model)) add(sel, h('option', { value: cur, selected: true }, `${modelLabel(v.model)} (not installed)`));
        return sel;
      }
      case 'preset': {
        const presets = store.get('presets') || [];
        return h('select.select', { id, on: { change: (e) => this.save(f, e.target.value) } }, presets.map((p) => h('option', { value: p.id, selected: p.id === v }, p.name)));
      }
      case 'contextMode': {
        const mode = v;
        const cur = mode === 'auto' ? 'auto' : mode === 'max' ? 'max' : 'custom';
        const input = h('input.input.input-num.num', { type: 'number', min: 512, step: 1024, value: typeof mode === 'number' ? mode : 8192, hidden: cur !== 'custom', attrs: { 'aria-label': 'Context tokens' } });
        input.addEventListener('change', () => this.save(f, Math.round(Number(input.value))));
        const preview = h('div.field-help.ctx-preview');
        const ref = store.get('settings').defaultModel || store.get('defaultModel');
        if (ref) {
          Promise.all([api.models.context(ref).catch(() => null), api.models.context(ref, 'max').catch(() => null)]).then(([a, m]) => {
            if (!a) return;
            mount(preview, h('div', h('b', `${modelLabel(ref.model)}: `), a.contextPlan.explanation),
              m && m.contextPlan.numCtx !== a.contextPlan.numCtx ? h('div', `Max (${fmtTokens(m.contextPlan.numCtx)}) would need about ${fmtBytes(m.contextPlan.memory?.estimatedTotalBytes)}${m.contextPlan.fits ? '' : ' — more than the safe budget'}.`) : null);
          });
        }
        return h('div.stack', h('div.row', h('div.segmented', { id, role: 'radiogroup', attrs: { 'aria-label': f.label } },
          h('button', { type: 'button', role: 'radio', 'aria-checked': String(cur === 'auto'), on: { click: () => this.save(f, 'auto') } }, 'Auto'),
          h('button', { type: 'button', role: 'radio', 'aria-checked': String(cur === 'max'), on: { click: () => this.save(f, 'max') } }, 'Model max'),
          h('button', { type: 'button', role: 'radio', 'aria-checked': String(cur === 'custom'), on: { click: () => { input.hidden = false; this.save(f, Math.round(Number(input.value)) || 8192); } } }, 'Custom')), input, cur === 'custom' ? h('span.muted.small', 'tokens') : null), preview);
      }
      case 'embedModel': {
        const emb = store.get('system')?.embeddings;
        const cands = emb?.candidates || [];
        const cur = v === 'auto' || v === 'off' ? v : v ? `${v.providerId || ''}|${v.model}` : 'auto';
        const sel = h('select.select', { id, on: { change: (e) => { const val = e.target.value; if (val === 'auto' || val === 'off') this.save(f, val); else { const [providerId, ...rest] = val.split('|'); this.save(f, { providerId, model: rest.join('|') }); } } } },
          h('option', { value: 'auto', selected: cur === 'auto' }, 'Auto'),
          h('option', { value: 'off', selected: cur === 'off' }, 'Off — keyword search only'),
          ...cands.map((c) => h('option', { value: `${c.providerId}|${c.model}`, selected: cur === `${c.providerId}|${c.model}` }, `${modelLabel(c.model)} · ${fmtBytes(c.sizeBytes)}`)));
        return h('div.stack', sel,
          emb ? h('div.field-help', emb.available ? `In use: ${modelLabel(emb.model)} (${emb.retrieval === 'hybrid' ? 'semantic + keyword search' : 'keyword search'}).` : `Not in use — ${emb.reason === 'low_ram_opt_in' ? 'opt-in on 8 GB machines' : emb.reason === 'none_installed' ? 'no embedding model installed' : emb.reason || 'off'}; keyword search (BM25) is used.`) : null,
          emb?.lowRamNote ? h('div.field-help', emb.lowRamNote) : null,
          emb?.suggestion ? h('div.field-help', `Suggested: ${emb.suggestion}. `, h('a', { href: '#/models' }, 'Get it in Models')) : null);
      }
      case 'imageProvider': {
        const provs = store.get('system')?.imageProviders || [];
        const sel = h('select.select', { id, on: { change: (e) => this.save(f, e.target.value || null) } },
          h('option', { value: '' }, 'First available'),
          ...provs.map((p) => h('option', { value: p.id, selected: p.id === v }, `${p.name}${p.status === 'running' ? '' : ' (not reachable)'}`)));
        if (v && !provs.some((p) => p.id === v)) add(sel, h('option', { value: v, selected: true }, `${v} (not detected)`));
        return sel;
      }
      case 'imageModel': {
        const sel = h('select.select', { id, on: { change: (e) => this.save(f, e.target.value || null) } }, h('option', { value: '' }, 'Backend’s current model'));
        if (v) add(sel, h('option', { value: v, selected: true }, v));
        api.images.models({ providerId: store.get('settings').image?.providerId || undefined }).then((r) => {
          for (const m of r.models) if (m.id !== v) add(sel, h('option', { value: m.id }, `${m.name}${m.current ? ' (current)' : ''}`));
        }).catch(() => { add(sel, h('option', { disabled: true }, 'No image backend reachable')); });
        return sel;
      }
      default: return h('span.muted', '—');
    }
  }

  // ------------------------------------------------------------------------------------------ providers
  providersBlock() {
    const sys = store.get('system');
    const provs = sys?.providers || [];
    const s = store.get('settings');
    const custom = s.providers?.custom || [];
    const ollama = sys?.ollama;
    const rows = provs.map((p) => h('div.list-row.provider-row',
      h(`span.dot${p.status === 'running' ? '.ok' : '.err'}`),
      h('div.grow', h('div', h('b', p.name), p.version ? h('span.faint', ` ${p.version}`) : null, p.builtin ? null : h('span.badge.outline', 'custom')), h('div.faint.small.mono', p.baseUrl), p.error ? h('div.field-error', p.error) : null,
        p.id === 'ollama' && ollama?.managed ? h('div.faint.small', `Started by Harness (pid ${ollama.pid})`) : null),
      p.id === 'ollama' && p.status !== 'running' && ollama?.installed ? h('button.btn.btn-small.btn-primary', { type: 'button', on: { click: () => runAction('start-ollama') } }, 'Start') : null,
      p.id === 'ollama' && ollama?.managed ? h('button.btn.btn-small', { type: 'button', on: { click: async () => { try { await api.providers.stopOllama(); await loadSystem({ refresh: true }); } catch (e) { showError(e, 'stop Ollama'); } } } }, 'Stop') : null,
      p.builtin && p.id !== 'ollama' ? h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: () => this.updateProvider(p.id, { enabled: false }) } }, 'Disable') : null,
      !p.builtin ? h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: () => this.editServer(p, 'chat') } }, 'Edit…') : null,
      !p.builtin ? h('button.icon-btn.small', { type: 'button', title: 'Remove', 'aria-label': `Remove ${p.name}`, on: { click: () => this.removeProvider(p) } }, icon('trash', { size: 14 })) : null));
    const disabled = [...['llamacpp', 'lmstudio'].filter((id) => s.providers?.builtin?.[id]?.enabled === false).map((id) => ({ id, name: id === 'llamacpp' ? 'llama.cpp / MLX (8080)' : 'LM Studio (1234)', builtin: true })), ...custom.filter((c) => c.enabled === false)];
    return h('div.form-block',
      h('div.row', h('h3.h3.grow', 'Model servers'), h('button.btn.btn-small', { type: 'button', on: { click: () => runAction('refresh-backends') } }, icon('reload', { size: 13 }), 'Re-check'), h('button.btn.btn-small', { type: 'button', on: { click: () => this.addProvider() } }, icon('plus', { size: 13 }), 'Add server…')),
      h('div.list.card-list', rows.length ? rows : h('div.faint.small', 'No servers detected.')),
      disabled.length ? h('div.stack.small', h('span.muted', 'Disabled:'), ...disabled.map((p) => h('div.row', h('span.grow', p.name), h('button.btn.btn-small', { type: 'button', on: { click: () => this.updateProvider(p.id, { enabled: true }) } }, 'Enable')))) : null);
  }

  async updateProvider(id, body) {
    try { await api.providers.update(id, body); await Promise.all([loadSettings(), loadSystem({ refresh: true }), loadModels({ refresh: true })]); } catch (e) { showError(e, 'update the provider'); }
  }

  async removeProvider(p) {
    if (!await confirmDialog({ title: `Remove ${p.name}?`, message: 'Its models will no longer be listed. Nothing is deleted on the server itself.', confirmLabel: 'Remove', danger: true })) return;
    try { await api.providers.remove(p.id); await Promise.all([loadSettings(), loadSystem({ refresh: true }), loadModels({ refresh: true })]); } catch (e) { showError(e, 'remove the provider'); }
  }

  addProvider() {
    const name = h('input.input', { placeholder: 'e.g. Workstation llama-server', attrs: { 'aria-label': 'Name' } });
    const url = h('input.input', { placeholder: 'http://192.168.1.20:8080/v1', attrs: { 'aria-label': 'Base URL' } });
    const key = h('input.input', { type: 'password', placeholder: 'Optional', attrs: { 'aria-label': 'API key', autocomplete: 'off' } });
    const kind = h('select.select', { attrs: { 'aria-label': 'Kind' } }, h('option', { value: 'openai' }, 'OpenAI-compatible (llama.cpp, LM Studio, vLLM, MLX…)'), h('option', { value: 'ollama' }, 'Ollama'));
    const result = h('div.small');
    const test = async (create) => {
      mount(result, h('span.spinner.small'), ' Testing…');
      try {
        const { provider } = await api.providers.create({ name: name.value.trim() || 'Custom server', kind: kind.value, baseUrl: url.value.trim(), apiKey: key.value || undefined });
        if (provider.status === 'running') {
          mount(result, h('span', { class: 'ok-text' }, icon('check', { size: 12 }), ` Connected${provider.version ? ` · ${provider.version}` : ''}`));
          await Promise.all([loadSettings(), loadSystem({ refresh: true }), loadModels({ refresh: true })]);
          return true;
        }
        mount(result, h('span.field-error', `Saved, but not reachable: ${provider.error || 'no response'}`));
        await Promise.all([loadSettings(), loadSystem({ refresh: true })]);
        return create;
      } catch (e) { mount(result, h('span.field-error', e.message)); return false; }
    };
    openDialog({
      title: 'Add a model server',
      description: 'Harness talks to any OpenAI-compatible server or another Ollama. Keys are stored in settings on this Mac.',
      body: h('div.form.compact', h('label.field-label', 'Name'), name, h('label.field-label', 'Kind'), kind, h('label.field-label', 'Address'), url, h('label.field-label', 'API key'), key, result),
      actions: [{ label: 'Cancel' }, { label: 'Add & test', kind: 'primary', run: async () => (await test(false)) }],
    });
    name.focus();
  }

  imageProvidersBlock() {
    const sys = store.get('system');
    const provs = sys?.imageProviders || [];
    const s = store.get('settings');
    const custom = s.image?.custom || [];
    const rows = provs.map((p) => h('div.list-row.provider-row',
      h(`span.dot${p.status === 'running' ? '.ok' : '.err'}`),
      h('div.grow', h('div', h('b', p.name), p.currentModel ? h('span.faint', ` · ${p.currentModel}`) : null), h('div.faint.small.mono', p.baseUrl), p.error ? h('div.field-error', p.error) : null),
      !p.builtin ? h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: () => this.editServer(p, 'image') } }, 'Edit…') : null,
      !p.builtin ? h('button.icon-btn.small', { type: 'button', 'aria-label': `Remove ${p.name}`, on: { click: async () => { if (await confirmDialog({ title: `Remove ${p.name}?`, confirmLabel: 'Remove', danger: true })) { try { await api.images.removeProvider(p.id); await Promise.all([loadSettings(), loadSystem({ refresh: true })]); } catch (e) { showError(e, 'remove the image backend'); } } } } }, icon('trash', { size: 14 })) : null));
    const unreachable = custom.filter((c) => !provs.some((p) => p.id === c.id));
    return h('div.form-block',
      h('div.row', h('h3.h3.grow', 'Image backends'), h('button.btn.btn-small', { type: 'button', on: { click: () => runAction('refresh-backends') } }, icon('reload', { size: 13 }), 'Re-check'), h('button.btn.btn-small', { type: 'button', on: { click: () => this.addImageProvider() } }, icon('plus', { size: 13 }), 'Add backend…')),
      h('div.list.card-list', rows.length ? rows : h('div.callout', icon('info'), h('div', h('b', 'No image backend running. '), 'In Draw Things, open Settings → API Server, turn on the HTTP server (port 7860), then click Re-check. ComfyUI (port 8188) and A1111/Forge (--api) are detected too.'))),
      unreachable.length ? h('div.faint.small', `Configured but not reachable: ${unreachable.map((c) => c.name).join(', ')}`) : null);
  }

  /** Rename / re-point an existing custom chat or image server (and optionally replace its key). */
  editServer(p, kind) {
    const name = h('input.input', { value: p.name, attrs: { 'aria-label': 'Name' } });
    const url = h('input.input', { value: p.baseUrl, attrs: { 'aria-label': 'Address' } });
    const key = h('input.input', { type: 'password', placeholder: 'Unchanged', attrs: { 'aria-label': 'API key', autocomplete: 'off' } });
    const result = h('div.small');
    openDialog({
      title: `Edit ${p.name}`,
      body: h('div.form.compact', h('label.field-label', 'Name'), name, h('label.field-label', 'Address'), url, h('label.field-label', 'API key'), key, result),
      actions: [{ label: 'Cancel' }, { label: 'Save & test', kind: 'primary', run: async () => {
        const body = { name: name.value.trim() || p.name, baseUrl: url.value.trim() || p.baseUrl };
        if (key.value) body.apiKey = key.value;
        try {
          const r = kind === 'image' ? await api.images.updateProvider(p.id, body) : await api.providers.update(p.id, body);
          await Promise.all([loadSettings(), loadSystem({ refresh: true }), kind === 'chat' ? loadModels({ refresh: true }) : null]);
          const now = (r.providers || []).find((x) => x.id === p.id);
          if (now && now.status !== 'running') { result.replaceChildren(h('span.field-error', `Saved, but not reachable: ${now.error || 'no response'}`)); return false; }
          toast({ kind: 'success', message: `${body.name} saved` });
          return true;
        } catch (e) { result.replaceChildren(h('span.field-error', e.message)); return false; }
      } }],
    });
    name.focus();
  }

  addImageProvider() {
    const name = h('input.input', { placeholder: 'e.g. ComfyUI on the desktop', attrs: { 'aria-label': 'Name' } });
    const url = h('input.input', { placeholder: 'http://127.0.0.1:7860', attrs: { 'aria-label': 'Base URL' } });
    const kind = h('select.select', { attrs: { 'aria-label': 'Kind' } }, h('option', { value: 'a1111' }, 'Draw Things / A1111 / Forge'), h('option', { value: 'comfyui' }, 'ComfyUI'), h('option', { value: 'openai' }, 'OpenAI-compatible images API'));
    const key = h('input.input', { type: 'password', placeholder: 'Optional', attrs: { 'aria-label': 'API key', autocomplete: 'off' } });
    const result = h('div.small');
    openDialog({
      title: 'Add an image backend',
      body: h('div.form.compact', h('label.field-label', 'Name'), name, h('label.field-label', 'Kind'), kind, h('label.field-label', 'Address'), url, h('label.field-label', 'API key'), key, result),
      actions: [{ label: 'Cancel' }, { label: 'Add & test', kind: 'primary', run: async () => {
        try {
          const { provider } = await api.images.createProvider({ name: name.value.trim() || 'Image backend', kind: kind.value, baseUrl: url.value.trim(), apiKey: key.value || undefined });
          await Promise.all([loadSettings(), loadSystem({ refresh: true })]);
          if (provider.status === 'running') { toast({ kind: 'success', message: `${provider.name} connected` }); return true; }
          mount(result, h('span.field-error', `Saved, but not reachable: ${provider.error || 'no response'}`));
          return false;
        } catch (e) { mount(result, h('span.field-error', e.message)); return false; }
      } }],
    });
  }

  // ------------------------------------------------------------------------------------------ presets
  presetsSection() {
    const presets = store.get('presets') || [];
    const s = store.get('settings');
    return h('div.stack-lg',
      h('p.lede', 'Presets bundle a system prompt with sampling settings. Choose one per chat from the composer; the default applies to new chats.'),
      h('div.row', h('span.spacer'), h('button.btn.btn-small.btn-primary', { type: 'button', on: { click: () => this.editPreset(null) } }, icon('plus', { size: 13 }), 'New preset')),
      h('div.list', presets.map((p) => h('div.list-row.preset-row',
        h('span.preset-icon', icon('book', { size: 15 })),
        h('div.grow', h('div', h('b', p.name), p.id === s.defaultPresetId ? h('span.badge.accent', 'default') : null, p.builtin ? h('span.badge.outline', 'built-in') : null), h('div.faint.small', p.description || p.systemPrompt.slice(0, 140)),
          Object.keys(p.params || {}).length ? h('div.faint.small.mono', Object.entries(p.params).map(([k, v]) => `${k}=${v}`).join(' ')) : null),
        p.id !== s.defaultPresetId ? h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: () => patchSettings({ defaultPresetId: p.id }).catch((e) => showError(e)) } }, 'Make default') : null,
        h('button.btn.btn-small', { type: 'button', on: { click: () => this.editPreset(p.builtin ? { ...p, id: null, name: `${p.name} (copy)` } : p) } }, p.builtin ? 'Duplicate' : 'Edit'),
        !p.builtin ? h('button.icon-btn.small', { type: 'button', 'aria-label': `Delete ${p.name}`, title: 'Delete', on: { click: async () => {
          if (!await confirmDialog({ title: `Delete “${p.name}”?`, message: 'Chats using it fall back to the default preset.', confirmLabel: 'Delete', danger: true })) return;
          try { await api.presets.remove(p.id); await loadPresets(); } catch (e) { showError(e, 'delete the preset'); }
        } } }, icon('trash', { size: 14 })) : null))));
  }

  editPreset(p) {
    const name = h('input.input', { value: p?.name || '', placeholder: 'Name', attrs: { 'aria-label': 'Name' } });
    const desc = h('input.input', { value: p?.description || '', placeholder: 'Short description (optional)', attrs: { 'aria-label': 'Description' } });
    const prompt = h('textarea.textarea', { value: p?.systemPrompt || '', rows: 10, placeholder: 'You are…', attrs: { 'aria-label': 'System prompt' } });
    const temp = h('input.input.input-num.num', { type: 'number', step: 0.05, min: 0, max: 2, value: p?.params?.temperature ?? '', placeholder: 'default', attrs: { 'aria-label': 'Temperature' } });
    const err = h('div.field-error');
    openDialog({
      title: p?.id ? 'Edit preset' : 'New preset',
      size: 'large',
      body: h('div.form.compact', h('label.field-label', 'Name'), name, h('label.field-label', 'Description'), desc, h('label.field-label', 'System prompt'), prompt, h('label.field-label', 'Temperature'), h('div.row', temp, h('span.faint.small', 'Empty = model default')), err),
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', run: async () => {
        const body = { name: name.value.trim(), description: desc.value.trim(), systemPrompt: prompt.value, params: { ...(p?.params || {}), ...(temp.value !== '' ? { temperature: Number(temp.value) } : {}) } };
        if (temp.value === '') delete body.params.temperature;
        if (!body.name || !body.systemPrompt.trim()) { err.textContent = 'Name and system prompt are required.'; return false; }
        try { if (p?.id) await api.presets.update(p.id, body); else await api.presets.create(body); await loadPresets(); toast({ kind: 'success', message: 'Preset saved' }); return true; } catch (e) { err.textContent = e.message; return false; }
      } }],
    });
    name.focus();
  }

  // ------------------------------------------------------------------------------------------ data
  dataSection() {
    const sys = store.get('system');
    const dir = sys?.app?.dataDir;
    const desktop = window.harnessDesktop;
    return h('div.stack-lg',
      h('section.form-block',
        h('h3.h3', 'Backup'),
        h('p.field-help', 'One file with every chat (all branches and summaries), memories, presets, settings, attachments and generated images — encrypted with a passphrase if you choose one. Restoring adds to what you have; nothing is overwritten.'),
        h('div.row-wrap',
          h('button.btn', { type: 'button', on: { click: () => backupDialog() } }, icon('download', { size: 14 }), 'Download backup…'),
          h('button.btn', { type: 'button', on: { click: () => restoreBackup() } }, icon('upload', { size: 14 }), 'Restore from backup…'))),
      h('section.form-block',
        h('h3.h3', 'Import chats'),
        h('p.field-help', 'Harness chat exports (.json), Harness backups, or OpenAI-style {messages:[{role, content}]} files. Imported chats get new ids, so nothing is overwritten.'),
        h('div.row', h('button.btn', { type: 'button', on: { click: () => runAction('import-chat') } }, icon('importIcon', { size: 14 }), 'Import…'))),
      h('section.form-block',
        h('h3.h3', 'Where your data lives'),
        h('div.row', h('code.mono.small.grow.data-dir', dir || '—'),
          desktop?.showInFolder && dir ? h('button.btn.btn-small', { type: 'button', on: { click: () => desktop.showInFolder(dir) } }, icon('folder', { size: 13 }), isMac ? 'Show in Finder' : 'Show folder') : null),
        h('p.field-help', 'Everything stays on this computer. Nothing is sent anywhere except to the model servers you configure.')),
      h('section.form-block.danger-zone',
        h('h3.h3', 'Erase'),
        h('div.row-wrap',
          h('button.btn.btn-danger', { type: 'button', on: { click: async () => {
            if (!await confirmDialog({ title: 'Delete all memories?', message: 'Everything Harness has learned about you is erased. This cannot be undone.', confirmLabel: 'Delete all', danger: true })) return;
            try { const r = await api.memories.clear(); toast({ kind: 'success', message: `Deleted ${r.deleted} memories` }); } catch (e) { showError(e, 'delete memories'); }
          } } }, 'Delete all memories…'))));
  }

  aboutSection() {
    const sys = store.get('system');
    const desktop = window.harnessDesktop;
    const m = sys?.machine;
    return h('div.stack-lg',
      h('dl.kv.about-kv',
        h('dt', 'Harness'), h('dd', `${sys?.app?.version || '—'}${desktop?.appVersion ? ` · app ${desktop.appVersion}` : ''}`),
        h('dt', 'Server'), h('dd', `${sys?.app?.transport === 'bridge' ? 'Inside the app (no network listener)' : sys?.app?.url || 'Local'} · Node ${sys?.app?.node || ''}`),
        h('dt', 'Machine'), h('dd', m ? `${m.chip} · ${m.cpus} cores · ${fmtBytes(m.totalMemBytes)} RAM (${m.ramTier} tier)` : '—'),
        h('dt', 'Memory budget'), h('dd', m?.memoryBudget ? `${fmtBytes(m.memoryBudget.budgetBytes)} for models (${Math.round(m.memoryBudget.fraction * 100)} % of RAM)` : '—'),
        h('dt', 'Platform'), h('dd', m ? `${m.platform} ${m.arch} ${m.release}` : '—')),
      h('div.row', h('button.btn', { type: 'button', on: { click: () => runAction('show-shortcuts') } }, icon('keyboard', { size: 14 }), 'Keyboard shortcuts'), h('button.btn', { type: 'button', on: { click: () => navigate('/setup') } }, icon('server', { size: 14 }), 'Setup & health')),
      h('p.faint.small', 'Third-party code: marked (MIT), DOMPurify (Apache-2.0 / MPL-2.0), highlight.js (BSD-3-Clause). See public/vendor/NOTICE.md.'));
  }
}
