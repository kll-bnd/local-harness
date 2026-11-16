// Setup & health: is a chat backend running (start Ollama, or how to install it), is there a model (with
// a recommendation that fits this machine and live download progress), the machine and its memory
// budget, the image backend (pointer to Draw Things' API server) and embeddings.
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { fmtBytes, fmtTokens, modelLabel } from '../lib/format.js';
import { store, loadRecommended, chatModels, ollamaStatus, loadSystem, loadModels, patchSettings } from '../state.js';
import { runAction } from '../actions.js';
import { navigate } from '../router.js';
import { pullModel, pullFor, cancelPull } from './pulls.js';
import { showError } from '../errors.js';
import { toast } from '../ui/overlays.js';

export class SetupView {
  constructor(shell) {
    this.shell = shell;
    this.page = h('div.page.setup-page');
    this.scroller = h('div.view-scroll', this.page);
    this.el = h('div.view', this.scroller);
    this.showAll = false;
    store.watch(['system', 'models', 'recommended', 'pulls', 'defaultModel'], () => this.render());
    this.scroller.addEventListener('scroll', () => this.shell.setScrolled(this.scroller.scrollTop > 4), { passive: true });
  }

  async show() {
    this.render();
    loadSystem({ refresh: true }).catch(() => {});
    loadRecommended().catch(() => {});
  }

  toolbar() { return { title: h('div.tb-title.page-title', h('span.title-text', 'Setup & health')), actions: [h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: () => runAction('refresh-backends') } }, icon('reload', { size: 13 }), 'Check again')] }; }

  render() {
    const sys = store.get('system');
    const models = chatModels();
    const { provider, process, running } = ollamaStatus();
    const others = (sys?.providers || []).filter((p) => p.id !== 'ollama' && p.status === 'running');
    const anyBackend = running || others.length > 0;
    const hasModel = models.length > 0;
    const m = sys?.machine;
    const ramGb = m ? Math.round(m.totalMemBytes / 1024 ** 3) : null;
    const img = (sys?.imageProviders || []).filter((p) => p.status === 'running');

    const step = (n, title, state, body) => h(`section.setup-step.${state}`,
      h('div.step-mark', state === 'done' ? icon('check', { size: 14 }) : state === 'warn' ? icon('warning', { size: 14 }) : h('span.num', n)),
      h('div.step-body', h('h2.h2', title), body));

    // 1. backend
    let backendBody;
    if (running) {
      backendBody = h('div.stack', h('p', `Ollama ${provider.version || ''} is running at `, h('code', provider.baseUrl), process?.managed ? ' (started by Harness).' : '.'),
        others.length ? h('p.muted', `Also found: ${others.map((p) => p.name).join(', ')}.`) : null);
    } else if (process?.installed) {
      backendBody = h('div.stack', h('p', 'Ollama is installed but not running.'), h('div.row', h('button.btn.btn-primary', { type: 'button', on: { click: () => runAction('start-ollama') } }, icon('power', { size: 14 }), 'Start Ollama'), h('span.faint.small', process.binaryPath)),
        process.lastError ? h('div.callout.warn', icon('warning'), h('div', process.lastError, process.logTail?.length ? h('pre.log-tail', process.logTail.slice(-6).join('\n')) : null)) : null,
        others.length ? h('p.muted', `Meanwhile you can use: ${others.map((p) => p.name).join(', ')}.`) : null);
    } else {
      backendBody = h('div.stack',
        h('p', others.length ? `Using ${others.map((p) => p.name).join(', ')}. Ollama is not installed.` : 'Harness needs a local model server. Ollama is the easiest on a Mac.'),
        h('ol.howto', h('li', 'Download Ollama from ', h('a', { href: 'https://ollama.com/download', target: '_blank', rel: 'noopener noreferrer', dataset: { external: '' } }, 'ollama.com/download'), ' and move it to Applications.'), h('li', 'Come back here and click ', h('b', 'Check again'), ' — Harness starts Ollama automatically from then on.')),
        h('p.faint.small', 'Already run llama.cpp (llama-server), MLX-LM or LM Studio? Harness detects them on ports 8080 and 1234, or add any OpenAI-compatible address in Settings → Providers.'),
        h('div.row', h('button.btn', { type: 'button', on: { click: () => runAction('refresh-backends') } }, icon('reload', { size: 14 }), 'Check again'), h('button.btn.btn-ghost', { type: 'button', on: { click: () => navigate('/settings/providers') } }, 'Providers…')));
    }

    // 2. model
    const rec = store.get('recommended');
    let modelBody;
    if (!anyBackend) modelBody = h('p.muted', 'Once a model server is running you can download a model here.');
    else {
      const def = store.get('defaultModel');
      modelBody = h('div.stack',
        hasModel ? h('p', `${models.length} chat model${models.length === 1 ? '' : 's'} installed. Default: `, h('b', def ? modelLabel(def.model) : '—'), '.') : h('p', 'No chat model installed yet. This one is suggested for this machine:'),
        rec ? this.recommendations(rec, hasModel) : h('div.muted.small', h('span.spinner.small'), ' Checking what fits…'));
    }

    // machine
    const machine = m ? h('div.machine-card',
      h('div.mc-main', icon('chip', { size: 18 }), h('div', h('div.h3', `${m.appleSilicon ? m.chip : m.chip} · ${ramGb} GB`), h('div.muted.small', `${m.cpus} cores · ${m.platform} ${m.arch}`))),
      h('div.mc-bar', { title: 'How much memory Harness plans to use for models' },
        h('div.progress', h('span', { style: { width: `${Math.round((m.memoryBudget.budgetBytes / m.totalMemBytes) * 100)}%` } })),
        h('div.small.muted.num', `Model budget ${fmtBytes(m.memoryBudget.budgetBytes)} of ${fmtBytes(m.totalMemBytes)} — the rest stays free for macOS and your apps.`)),
      m.ramTier === 'low' ? h('div.callout.accent', icon('info'), h('div.small', h('b', 'Tuned for 8 GB. '), 'Harness keeps one model loaded, caps the context for responsiveness, quantizes the KV cache, uses keyword search instead of a second embedding model, and unloads the chat model while an image is generated — it reloads on your next message.')) : null) : null;

    // 3. images
    const imgBody = img.length
      ? h('div.stack', h('p', `${img.map((p) => p.name).join(', ')} ${img.length === 1 ? 'is' : 'are'} ready${img[0].currentModel ? ` (model: ${img[0].currentModel})` : ''}.`), h('div.row', h('button.btn', { type: 'button', on: { click: () => navigate('/images') } }, icon('image', { size: 14 }), 'Open the image studio')))
      : h('div.stack', h('p', 'Optional: generate images locally with Draw Things.'),
        h('ol.howto', h('li', 'Install Draw Things from the Mac App Store and download a model (SD Turbo or SDXL Lightning are fast on 8 GB).'), h('li', 'In Draw Things open ', h('b', 'Settings → API Server'), ', enable the ', h('b', 'HTTP'), ' server on port ', h('b', '7860'), '.'), h('li', 'Click ', h('b', 'Check again'), '.')),
        h('p.faint.small', 'ComfyUI (port 8188) and AUTOMATIC1111/Forge with --api are detected as well.'));

    // embeddings
    const emb = sys?.embeddings;
    const embBody = emb ? h('div.stack.small',
      h('p', emb.available ? `Memory search uses ${modelLabel(emb.model)} plus keywords.` : 'Memory search uses keywords (BM25).'),
      emb.lowRamNote ? h('p.muted', emb.lowRamNote) : null,
      emb.suggestion && m?.ramTier !== 'low' ? h('div.row', h('button.btn.btn-small', { type: 'button', on: { click: () => pullModel({ model: emb.suggestion }) } }, `Download ${emb.suggestion}`)) : null) : null;

    mount(this.page, 
      h('div.page-head', h('h1.h1', hasModel && anyBackend ? 'Ready' : 'Welcome to Harness'), hasModel && anyBackend ? h('button.btn.btn-primary', { type: 'button', on: { click: () => runAction('new-chat') } }, icon('compose', { size: 14 }), 'Start chatting') : null),
      h('p.lede', 'Everything runs on this computer. Here is what Harness found, and what still needs doing.'),
      machine,
      h('div.setup-steps',
        step(1, 'Model server', running || others.length ? 'done' : 'todo', backendBody),
        step(2, 'Chat model', hasModel ? 'done' : anyBackend ? 'todo' : 'blocked', modelBody),
        step(3, 'Image generation', img.length ? 'done' : 'optional', imgBody),
        embBody ? step(4, 'Memory search', 'done', embBody) : null),
    );
  }

  recommendations(rec, hasModel) {
    const list = rec.models || [];
    const top = this.showAll || !hasModel ? list : list.slice(0, 2);
    return h('div.stack',
      h('div.rec-list', top.map((r) => recCard(r, rec.machine))),
      list.length > top.length ? h('button.btn-link.small', { type: 'button', on: { click: () => { this.showAll = true; this.render(); } } }, `Show ${list.length - top.length} more`) : null,
      h('p.faint.small', rec.note));
  }
}

/** A recommended model with its variants and fit estimates; shared with the Models page. */
export function recCard(r, machine) {
  const suggested = r.variants.find((v) => v.model === r.suggestedVariant) || r.variants[0];
  const pull = pullFor(suggested.model);
  const installedVariant = r.variants.find((v) => v.installed);
  const def = store.get('defaultModel');
  const lowRam = machine?.ramTier === 'low';
  const variantRow = (v) => {
    const p = pullFor(v.model);
    const isDefault = def?.model === v.model;
    return h(`div.variant${v.model === r.suggestedVariant ? '.suggested' : ''}`,
      h('div.grow',
        h('div.row', h('b', v.label), v.model === r.suggestedVariant ? h('span.badge.accent', 'best fit') : null, !v.estimate.fits ? h('span.badge.warn', 'too large') : null, v.installed ? h('span.badge', 'installed') : null, isDefault ? h('span.badge.outline', 'default') : null),
        h('div.faint.small.mono.ellipsis', v.model),
        h('div.small.muted', `${fmtBytes(v.approxSizeBytes)} · ${fmtTokens(v.estimate.numCtx)} context here`),
        h('div.small.variant-expl', v.estimate.explanation)),
      p && !p.done ? pullProgress(p)
        : v.installed
          ? (!isDefault ? h('button.btn.btn-small', { type: 'button', on: { click: async () => { try { await patchSettings({ defaultModel: { providerId: v.providerId || 'ollama', model: v.model } }); await loadModels(); toast({ kind: 'success', message: `Default model: ${modelLabel(v.model)}` }); } catch (e) { showError(e, 'set the default model'); } } } }, 'Make default') : null)
          : h(`button.btn.btn-small${v.model === r.suggestedVariant ? '.btn-primary' : ''}`, { type: 'button', on: { click: () => pullModel({ model: v.model }) } }, icon('download', { size: 13 }), 'Download'));
  };
  return h('article.rec-card', { dataset: { rec: r.id } },
    h('div.rec-head', h('div.grow', h('h3.h3', r.name), h('p.small.muted', r.description)), h('div.row-wrap.rec-tags', (r.tags || []).map((t) => h(`span.badge${t === 'recommended' ? '.accent' : ''}`, t)))),
    h('div.variants', r.variants.map(variantRow)),
    lowRam && !installedVariant && !pull ? h('p.faint.small', 'On 8 GB the smaller quantization leaves room for a useful context window; the default quant would be squeezed to 2K.') : null);
}

export function pullProgress(p) {
  const pct = p.percent;
  return h('div.pull-progress', { role: 'status' },
    h('div.row.small', h('span.grow.ellipsis', p.status || 'Starting…'), pct != null ? h('span.num', `${Math.round(pct)}%`) : null),
    h(`div.progress${pct == null ? '.indeterminate' : ''}`, h('span', { style: { width: `${pct || 0}%` } })),
    p.total ? h('div.faint.small.num', `${fmtBytes(p.completed || 0)} of ${fmtBytes(p.total)}`) : null,
    p.local ? h('button.btn.btn-small.btn-ghost', { type: 'button', on: { click: () => cancelPull(p.model) } }, 'Cancel') : null);
}
