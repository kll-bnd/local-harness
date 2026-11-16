// "What to do next" buttons the API attaches to some failures (e.g. `model_load_failed` → nextSteps:
// create a text-only copy / use a smaller file / retry). One place turns them into working actions.
import { h } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { modelShort } from './lib/format.js';
import * as api from './api.js';
import { store, findModel, loadModels, dropModelInfo } from './state.js';
import { toast } from './ui/overlays.js';
import { showError } from './errors.js';

const SHORT_LABEL = {
  create_text_only_copy: 'Make a text-only copy',
  use_smaller_file: 'Use a smaller file',
  retry: 'Try again',
};

/**
 * Run one next step. ctx: { chat?: ChatModel, messageId?: string, retry?: () => void }
 */
export async function runNextStep(step, ctx = {}) {
  const { regenerate } = await import('./chat/session.js');
  const retry = ctx.retry || (ctx.chat && ctx.messageId ? () => regenerate(ctx.chat, ctx.messageId) : null);
  const useModel = async (refModel) => {
    if (!ctx.chat) return;
    const d = await api.chats.update(ctx.chat.id, { settings: { model: refModel } });
    ctx.chat.setChatMeta(d.chat);
  };
  try {
    if (step.action === 'create_text_only_copy') {
      const t = toast({ message: 'Making a text-only copy…', detail: 'No download — this takes a few seconds.', timeout: 0, id: 'text-only' });
      const r = await api.models.createTextOnly(step.body || {});
      t.dismiss(true);
      dropModelInfo();
      await loadModels({ refresh: true }).catch(() => {});
      toast({ kind: 'success', message: `Created ${modelShort(r.model, 40)}`, detail: 'Same model without image/audio input — about 1 GB less memory.', id: 'text-only' });
      await useModel({ providerId: r.providerId, model: r.model });
      retry?.();
    } else if (step.action === 'use_smaller_file') {
      if (findModel({ model: step.model })) { await useModel({ model: step.model }); retry?.(); return; }
      const { pullModel } = await import('./views/pulls.js');
      toast({ message: `Downloading ${modelShort(step.model, 40)}…`, detail: 'Follow the progress in Models; switch to it when it is ready.', id: 'smaller' });
      pullModel({ model: step.model });
    } else if (step.action === 'retry') {
      retry?.();
    }
  } catch (e) { showError(e, SHORT_LABEL[step.action]?.toLowerCase() || 'do that'); }
}

/** Buttons for a list of next steps (first one is the primary suggestion). */
export function nextStepButtons(steps = [], ctx = {}) {
  return steps.filter((s) => SHORT_LABEL[s.action]).map((s, i) => h(`button.btn.btn-small${i === 0 ? '.btn-primary' : ''}`, {
    type: 'button', title: s.label, on: { click: (e) => { e.currentTarget.disabled = true; runNextStep(s, ctx); } },
  }, s.action === 'create_text_only_copy' ? icon('file', { size: 13 }) : s.action === 'retry' ? icon('regenerate', { size: 13 }) : null,
  s.action === 'use_smaller_file' && s.model ? `Use ${modelShort(s.model, 26)}` : SHORT_LABEL[s.action]));
}

export { store };
