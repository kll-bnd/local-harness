// ⌘K command palette: actions, chats, models and settings pages in one fuzzy-searchable list.
// Accessible as a combobox + listbox (aria-activedescendant), fully keyboard driven.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { modelLabel, fmtWhen } from '../lib/format.js';
import { allActions, runAction, keyLabel } from '../actions.js';
import { store, chatModels } from '../state.js';
import { navigate } from '../router.js';
import { SETTINGS_SECTIONS } from '../views/settings-sections.js';

function score(q, text) {
  if (!q) return 1;
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i === 0) return 100 - t.length / 100;
  if (i > 0) return 80 - i - t.length / 100;
  // subsequence
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const j = t.indexOf(ch, ti);
    if (j < 0) return 0;
    gaps += j - ti;
    ti = j + 1;
  }
  return Math.max(1, 40 - gaps);
}

let open = null;

export function openPalette(shell) {
  if (open) { open.input.focus(); return; }
  const returnFocus = document.activeElement;
  const input = h('input.palette-input', { type: 'text', placeholder: 'Type a command, chat or model…', attrs: { role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list', 'aria-label': 'Command palette' } });
  const list = h('div.palette-list#palette-list', { role: 'listbox', attrs: { 'aria-label': 'Results' } });
  const dlg = h('dialog.palette', { attrs: { 'aria-label': 'Command palette' } }, h('div.palette-head', icon('search'), input), list,
    h('div.palette-foot.faint.small', h('span', '↑↓ to move · ↩ to run · Esc to close')));
  let items = [];
  let index = 0;

  const sources = () => {
    const out = [];
    for (const a of allActions()) {
      if (a.palette === false || (a.when && !a.when())) continue;
      out.push({ id: `a:${a.id}`, label: a.title, group: a.group || 'Commands', icon: a.icon || 'command', kbd: a.keys?.[0] ? keyLabel(a.keys[0]) : '', run: () => runAction(a.id) });
    }
    for (const c of (store.get('chats') || []).slice(0, 300)) {
      out.push({ id: `c:${c.id}`, label: c.title || 'New chat', group: 'Chats', icon: c.incognito ? 'incognito' : 'compose', hint: fmtWhen(c.updatedAt), run: () => navigate(`/chat/${c.id}`) });
    }
    const chat = shell.chatView.model;
    for (const m of chatModels()) {
      out.push({ id: `m:${m.providerId}:${m.model}`, label: `Use ${modelLabel(m.name)}`, group: chat ? 'Model for this chat' : 'Model for the new chat', icon: 'cube', hint: m.providerName, run: () => shell.chatView.composer.patchChat({ settings: { model: { providerId: m.providerId, model: m.model } } }) });
    }
    for (const s of SETTINGS_SECTIONS) out.push({ id: `s:${s.id}`, label: `Settings: ${s.label}`, group: 'Settings', icon: s.icon, run: () => navigate(`/settings/${s.id}`) });
    return out;
  };
  const all = sources();

  const render = () => {
    const q = input.value.trim().toLowerCase();
    const scored = all.map((it) => ({ it, s: score(q, `${it.label} ${it.group}`) })).filter((x) => x.s > 0);
    if (q) scored.sort((a, b) => b.s - a.s);
    items = (q ? scored : scored.filter((x) => x.it.group !== 'Chats' || all.indexOf(x.it) < all.findIndex((y) => y.group === 'Chats') + 8)).slice(0, 60).map((x) => x.it);
    index = Math.min(index, Math.max(0, items.length - 1));
    const frag = [];
    let lastGroup = null;
    items.forEach((it, i) => {
      if (!q && it.group !== lastGroup) { frag.push(h('div.palette-group', { role: 'presentation' }, it.group)); lastGroup = it.group; }
      frag.push(h('div.palette-item', { role: 'option', id: `pi-${i}`, 'aria-selected': String(i === index), on: { mousemove: () => { if (index !== i) { index = i; mark(); } }, click: () => choose(i) } },
        h('span.pi-icon', icon(it.icon, { size: 15 })), h('span.pi-label', it.label), q ? h('span.pi-group', it.group) : null, it.hint ? h('span.pi-hint', it.hint) : null, it.kbd ? h('kbd', it.kbd) : null));
    });
    if (!items.length) frag.push(h('div.palette-empty', 'No matches'));
    list.replaceChildren(...frag);
    mark();
  };
  const mark = () => {
    for (const el of list.querySelectorAll('.palette-item')) el.setAttribute('aria-selected', String(el.id === `pi-${index}`));
    input.setAttribute('aria-activedescendant', `pi-${index}`);
    list.querySelector(`#pi-${index}`)?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { if (!open) return; open = null; dlg.close(); dlg.remove(); if (returnFocus && document.contains(returnFocus)) returnFocus.focus?.(); };
  const choose = (i) => { const it = items[i]; if (!it) return; close(); setTimeout(() => it.run(), 0); };

  input.addEventListener('input', () => { index = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(items.length - 1, index + 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(0, index - 1); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(index); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); close(); }
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) close(); });
  document.body.append(dlg);
  dlg.showModal();
  open = { input, close };
  render();
  input.focus();
}
