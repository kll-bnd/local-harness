// Non-streaming LLM helper for internal tasks (summaries, memory extraction, titles).
// Uses the same num_ctx / keep_alive as chat requests so Ollama never reloads the model for them.
import { stripThinking } from './reasoning.mjs';
import { HttpError } from '../lib/errors.mjs';

export class LLM {
  constructor(app) { this.app = app; }

  /** Resolve a model target (ref or chat default) with its context plan. */
  async resolveFor(ref, chat = null) {
    const s = chat ? this.app.engine.effectiveSettings(chat) : this.app.engine.globalEffectiveSettings();
    const r = await this.app.registry.resolve(ref?.model ? ref : s.model);
    const info = await this.app.registry.modelInfo(r.provider, r.model);
    if (info.capabilities.includes('embedding') && !info.capabilities.includes('completion')) throw new HttpError(400, 'not_chat_model', `${r.model} is an embedding model and cannot chat`);
    const plan = await this.app.registry.contextPlan(r.provider, r.model, s, { info });
    // Use the num_ctx the model is loaded with right now (set by the last chat request) so internal calls
    // never force Ollama to reload it; a corrected plan only applies at the next chat turn.
    let loaded = r.provider.kind === 'ollama' ? this.app.engine.loadedCtxFor(r.provider.id, r.model) : null;
    if (!loaded && r.provider.kind === 'ollama') {
      // Nothing sent in this process yet (e.g. after a restart): if Ollama reports the loaded context, keep it.
      const ps = await r.provider.ps().catch(() => []);
      const e = ps.find((m) => m.model === r.model || m.name === r.model || m.model === `${r.model}:latest`);
      if (Number.isFinite(e?.contextLength) && e.contextLength >= 512) loaded = e.contextLength;
    }
    return { ...r, info, plan, numCtx: loaded || plan.numCtx, settings: s };
  }

  async complete({ ref = null, chat = null, messages, maxTokens, temperature = 0.2, format, signal }) {
    const t = await this.resolveFor(ref, chat);
    return this.completeWith(t, messages, { maxTokens, temperature, format, signal });
  }

  async completeWith(t, messages, { maxTokens, temperature = 0.2, format, signal } = {}) {
    const options = { temperature };
    if (t.provider.kind === 'ollama') options.num_ctx = t.numCtx;
    if (maxTokens) options.num_predict = maxTokens;
    // Explicit think:false for every Ollama call: omitted means ON for thinking models, and an internal call with a
    // small num_predict would then spend its whole budget thinking and return nothing.
    let think = t.provider.kind === 'ollama' ? false : undefined;
    let fmt = t.provider.kind === 'ollama' ? format : undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      let text = '';
      let usage = null;
      try {
        for await (const ev of t.provider.chat({ model: t.model, messages, options, keepAlive: t.settings.keepAlive, think, format: fmt, signal })) {
          if (ev.type === 'content') text += ev.text;
          else if (ev.type === 'done') usage = ev.usage;
        }
        if (usage?.promptTokens) {
          const counter = this.app.calibrator.counter(t.provider.id, t.model);
          const raw = messages.reduce((a, m) => a + counter.messageRaw(m), 0) + 3;
          this.app.calibrator.observe(t.provider.id, t.model, { estimatedRaw: raw, actual: usage.promptTokens, numCtx: t.numCtx });
        }
        this.app.modelState?.markReloaded();
        return stripThinking(text);
      } catch (e) {
        if (e.code === 'thinking_unsupported' && think !== undefined) { think = undefined; continue; }
        if (fmt && /format|schema|grammar/i.test(e.message)) { fmt = undefined; continue; }
        throw e;
      }
    }
    return '';
  }
}

/** Lenient JSON extraction from model output (code fences, leading prose, trailing junk). */
export function parseJsonLoose(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  try { return JSON.parse(t); } catch { /* continue */ }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch { /* continue */ } }
  const as = t.indexOf('[');
  const ae = t.lastIndexOf(']');
  if (as >= 0 && ae > as) { try { return { memories: JSON.parse(t.slice(as, ae + 1)) }; } catch { /* give up */ } }
  return null;
}
