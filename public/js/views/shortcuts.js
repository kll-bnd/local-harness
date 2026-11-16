// Keyboard shortcut cheat sheet (generated from the action registry, so it can never drift).
import { h } from '../lib/dom.js';
import { allActions, keyLabel } from '../actions.js';
import { openDialog } from '../ui/overlays.js';

const EXTRA = [
  ['Chats', 'Send message', 'Enter'],
  ['Chats', 'New line', 'Shift+Enter'],
  ['Chats', 'Stop generating', 'Escape'],
  ['Chats', 'Edit last message (empty field)', 'ArrowUp'],
  ['Chats', 'Slash commands: /image /remember /compact /new /model /export', '/'],
  ['Chats', 'Rename chat in sidebar', 'F2'],
];

export function openShortcuts() {
  const groups = new Map();
  for (const a of allActions()) {
    if (!a.keys?.length) continue;
    const g = a.group || 'General';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push([a.title, a.keys.slice(0, 2)]);
  }
  for (const [g, label, key] of EXTRA) {
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push([label, [key]]);
  }
  const order = ['General', 'Chats', 'Go to', 'View', 'Appearance', 'Models', 'Help'];
  const body = h('div.shortcuts-grid', [...groups].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([g, rows]) => h('section.shortcut-group',
    h('h3.section-title', g),
    h('dl.shortcut-list', rows.flatMap(([label, keys]) => [h('dt', label), h('dd', keys.map((k, i) => [i ? h('span.faint', ' or ') : null, h('kbd', keyLabel(k))]))])))));
  openDialog({ title: 'Keyboard shortcuts', body, size: 'large', actions: [{ label: 'Done', kind: 'primary', autofocus: true }] });
}
