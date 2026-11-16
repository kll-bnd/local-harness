// Context meter: how full the context window is, what fills it, and why the window is this size.
// The bar spans the whole window (numCtx): coloured segments for each prompt component, empty prompt
// budget, a hatched reply reserve at the end, and a tick where auto-summarization kicks in.
import { h, add } from '../../lib/dom.js';
import { fmtInt, fmtTokens, fmtBytes, fmtPercent, modelShort } from '../../lib/format.js';
import { icon } from '../../lib/icons.js';

export const SEGMENTS = [
  { key: 'system', label: 'System prompt', help: 'Preset / persona instructions' },
  { key: 'tools', label: 'Tool definitions', help: 'Descriptions of the tools the model may call' },
  { key: 'memories', label: 'Memories', help: 'Pinned and retrieved long-term memories' },
  { key: 'summary', label: 'Summary', help: 'Rolling summary of earlier messages' },
  { key: 'documents', label: 'Documents', help: 'Attached files or excerpts from them' },
  { key: 'recall', label: 'Recall', help: 'Excerpts from past chats' },
  { key: 'history', label: 'Conversation', help: 'Messages sent verbatim' },
];

function bar(ctx, { large = false } = {}) {
  const num = ctx?.numCtx || 0;
  const el = h(`div.ctx-bar${large ? '.large' : ''}`, { attrs: { 'aria-hidden': 'true' } });
  if (!num) return el;
  const pct = (n) => `${Math.max(0, (n / num) * 100)}%`;
  let usedSum = 0;
  for (const s of SEGMENTS) {
    const v = ctx.breakdown?.[s.key] || 0;
    if (!v) continue;
    usedSum += v;
    add(el, h(`span.seg.seg-${s.key}`, { style: { width: pct(v) } }));
  }
  if (!ctx.breakdown && ctx.used) add(el, h('span.seg.seg-history', { style: { width: pct(ctx.used) } }));
  const free = Math.max(0, (ctx.budget || num) - Math.max(usedSum, ctx.used || 0));
  add(el, h('span.seg.seg-free', { style: { width: pct(free) } }));
  if (ctx.replyReserve) add(el, h('span.seg.seg-reserve', { style: { width: pct(ctx.replyReserve) } }));
  if (ctx.compactAt) add(el, h('span.ctx-tick', { style: { left: pct(ctx.compactAt) } }));
  return el;
}

function level(ctx) {
  if (!ctx?.budget) return '';
  if (ctx.used > ctx.budget) return 'over';
  if (ctx.compactAt && ctx.used > ctx.compactAt) return 'high';
  return '';
}

/** Compact meter for the composer. */
export function miniMeter(ctx, plan, onClick) {
  const numCtx = ctx?.numCtx || plan?.numCtx;
  if (!numCtx) return h('span');
  const lvl = level(ctx);
  const label = ctx ? `${fmtTokens(ctx.used)} / ${fmtTokens(ctx.budget)}` : `${fmtTokens(numCtx)} window`;
  const title = ctx
    ? `Context: ${fmtInt(ctx.used)} of ${fmtInt(ctx.budget)} prompt tokens (${fmtPercent(ctx.used / ctx.budget)}).\nWindow ${fmtInt(ctx.numCtx)} tokens, ${fmtInt(ctx.replyReserve)} reserved for the reply.${ctx.compactAt ? `\nEarlier messages are summarized above ${fmtInt(ctx.compactAt)}.` : ''}${plan?.explanation ? `\n\n${plan.explanation}` : ''}`
    : `${fmtInt(numCtx)}-token context window.${plan?.explanation ? `\n${plan.explanation}` : ''}`;
  return h(`button.ctx-mini${lvl ? `.${lvl}` : ''}${plan?.warnings?.length ? '.warned' : ''}`, { type: 'button', title, 'aria-label': `Context usage: ${label}. Show details`, on: { click: onClick } },
    bar(ctx || { numCtx, budget: numCtx - (plan?.replyReserve || 0), used: 0 }),
    h('span.ctx-num.num', label));
}

/**
 * Full panel for the inspector.
 * opts: { model, onMode(mode), onCompact(), onToggleCompaction(on), maxPlan, compactionEnabled, busy, chatMode }
 */
export function contextPanel(ctx, plan, opts = {}) {
  const parts = [];
  if (ctx) {
    const lvl = level(ctx);
    parts.push(h('div.ctx-headline',
      h('div', h('span.ctx-big.num', fmtInt(ctx.used)), h('span.muted', ` of ${fmtInt(ctx.budget)} prompt tokens`)),
      h(`span.badge${lvl === 'over' ? '.danger' : lvl === 'high' ? '.warn' : ''}.num`, fmtPercent(ctx.used / ctx.budget))));
    parts.push(bar(ctx, { large: true }));
    parts.push(h('div.ctx-scale.num.faint', h('span', '0'), ctx.compactAt ? h('span.ctx-scale-tick', { style: { left: `${(ctx.compactAt / ctx.numCtx) * 100}%` } }, `summarize ${fmtTokens(ctx.compactAt)}`) : null, h('span', fmtTokens(ctx.numCtx))));
    const rows = SEGMENTS.filter((s) => (ctx.breakdown?.[s.key] || 0) > 0).map((s) => h('div.legend-row', { title: s.help },
      h(`span.swatch.seg-${s.key}`), h('span.legend-label', s.label), h('span.legend-val.num', fmtInt(ctx.breakdown[s.key]))));
    rows.push(h('div.legend-row', { title: 'Kept free so the model has room to answer' }, h('span.swatch.seg-reserve'), h('span.legend-label', 'Reply reserve'), h('span.legend-val.num', fmtInt(ctx.replyReserve))));
    rows.push(h('div.legend-row', h('span.swatch.seg-free'), h('span.legend-label', 'Free'), h('span.legend-val.num', fmtInt(Math.max(0, ctx.budget - ctx.used)))));
    parts.push(h('div.ctx-legend', rows));
    const actual = ctx.actual?.promptTokens;
    parts.push(h('p.faint.small', ctx.estimated
      ? `Estimated${ctx.calibration && ctx.calibration !== 1 ? ` (calibrated ×${ctx.calibration.toFixed(2)} from real counts)` : ''}.${actual ? ` The last reply's prompt was ${fmtInt(actual)} tokens.` : ''}`
      : 'Exact token counts from the model server.'));
    if (ctx.truncation) parts.push(h('div.callout.warn', h('span', `${fmtInt(ctx.truncation.droppedMessages || 0)} older messages don't fit and will be left out.`)));
  } else if (plan) {
    parts.push(h('div.ctx-headline', h('div', h('span.ctx-big.num', fmtTokens(plan.numCtx)), h('span.muted', ' token window'))));
    parts.push(h('p.muted.small', 'Usage appears after the first message.'));
  }

  if (plan) {
    const warn = plan.warnings?.length || plan.limitedBy === 'memory';
    parts.push(h('section.ctx-section',
      h('h3.section-title', 'Why this size'),
      h(`div.callout${warn ? '.warn' : ''}.ctx-explain`, h('span', plan.explanation)),
      plan.contextNote ? h('p.faint.small', plan.contextNote) : null,
      warningList(plan, opts),
      opts.onMode ? modeControl(plan, opts) : null,
      opts.maxPlan ? maxCost(plan, opts.maxPlan) : null,
      plan.memory ? memoryTable(plan) : null,
    ));
  }

  if (opts.onCompact) {
    parts.push(h('section.ctx-section',
      h('h3.section-title', 'Summarizer'),
      h('div.setting-line',
        h('div.grow', h('div', 'Summarize automatically'), h('div.faint.small', ctx?.compactAt ? `When the prompt passes ${fmtInt(ctx.compactAt)} tokens, older messages are condensed into a summary.` : 'Older messages are condensed into a summary when the context fills up.')),
        h('button.switch', { type: 'button', role: 'switch', 'aria-checked': String(opts.compactionEnabled !== false), 'aria-label': 'Summarize automatically', on: { click: () => opts.onToggleCompaction?.(opts.compactionEnabled === false) } })),
      h('div.row',
        h('button.btn.btn-small', { type: 'button', disabled: !!opts.busy, on: { click: opts.onCompact } }, opts.compacting ? h('span.spinner.small') : null, opts.compacting ? 'Summarizing…' : 'Compact now'),
        h('span.faint.small', 'Summarize everything except the last few messages.')),
    ));
  }
  return h('div.ctx-panel', parts);
}

/** Plan warnings (swapping, CPU offload, model too large…), each with the suggested fix when the API names one. */
function warningList(plan, opts) {
  const ws = (plan.warnings || []).filter((w) => w.message && w.message !== plan.explanation);
  if (!ws.length) return null;
  return h('ul.warn-list', ws.map((w) => {
    const suggested = w.suggestedModel || w.suggestion?.model || w.details?.suggestedModel || null;
    return h('li', icon('warning', { size: 13 }), h('div.grow', h('div', w.message),
      suggested && opts.onSwitchModel ? h('button.btn.btn-small', { type: 'button', on: { click: () => opts.onSwitchModel(suggested, w) } }, `Switch to ${modelShort(typeof suggested === 'string' ? suggested : suggested.model, 32)}`) : null));
  }));
}

function modeControl(plan, opts) {
  const mode = opts.chatMode ?? null; // null = inherit
  const cur = mode === null ? 'default' : mode === 'auto' ? 'auto' : mode === 'max' ? 'max' : 'custom';
  const custom = h('input.input.input-small.num', { type: 'number', min: 512, step: 512, value: typeof mode === 'number' ? mode : plan.numCtx, attrs: { 'aria-label': 'Custom context size (tokens)' }, hidden: cur !== 'custom' });
  custom.addEventListener('change', () => { const n = Math.round(Number(custom.value)); if (n >= 512) opts.onMode(n); });
  const btn = (id, label, title) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(cur === id), title, on: { click: () => { if (id === 'custom') { custom.hidden = false; custom.focus(); opts.onMode(Math.round(Number(custom.value)) || plan.numCtx); } else opts.onMode(id === 'default' ? null : id); } } }, label);
  return h('div.ctx-mode',
    h('div.row', h('span.small.muted', 'Window for this chat'), h('span.spacer'),
      h('div.segmented', { role: 'radiogroup', 'aria-label': 'Context window mode' },
        btn('default', 'Default', 'Follow the global setting'),
        btn('auto', 'Auto', 'Largest window that safely fits in RAM'),
        btn('max', 'Max', 'The model maximum, regardless of RAM'),
        btn('custom', 'Custom', 'A fixed number of tokens'))),
    custom);
}

function maxCost(plan, maxPlan) {
  const alt = plan.alternatives?.max;
  if (!maxPlan && !alt) return null;
  const numCtx = maxPlan?.numCtx || alt?.numCtx;
  const total = maxPlan?.memory?.estimatedTotalBytes || alt?.estimatedTotalBytes;
  const budget = plan.memory?.budgetBytes;
  const over = alt?.overBudgetBytes || (total && budget ? Math.max(0, total - budget) : 0);
  if (numCtx === plan.numCtx) return h('p.small.muted', `This is already the model maximum (${fmtTokens(numCtx)}).`);
  return h('div.max-cost', h('span.small', `Max (${fmtTokens(numCtx)}) would need about `, h('b.num', fmtBytes(total)), over > 0 ? h('span', ' — ', h('span.warn-text', `${fmtBytes(over)} over the safe budget`), ', likely to swap.') : ' and fits.'));
}

function memoryTable(plan) {
  const m = plan.memory;
  return h('details.ctx-mem',
    h('summary', 'Memory estimate'),
    h('dl.kv',
      h('dt', 'Model weights'), h('dd', fmtBytes(m.modelBytes)),
      h('dt', `KV cache (${fmtTokens(plan.numCtx)}, ${m.kvCacheType})`), h('dd', fmtBytes(m.kvBytes)),
      h('dt', 'Runtime overhead'), h('dd', fmtBytes(m.overheadBytes)),
      m.otherModelsBytes ? h('dt', 'Other loaded models') : null, m.otherModelsBytes ? h('dd', fmtBytes(m.otherModelsBytes)) : null,
      h('dt', 'Estimated total'), h('dd', h('b', fmtBytes(m.estimatedTotalBytes))),
      h('dt', 'Safe budget'), h('dd', `${fmtBytes(m.budgetBytes)} of ${fmtBytes(m.totalBytes)} RAM`),
    ));
}
