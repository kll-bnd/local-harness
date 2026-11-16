// Message-tree operations. A chat stores `messages: {id: Message}`; each message has `parentId`
// (null for roots) and `activeChildId` (the branch last shown under it). `activeLeafId` is the end of
// the active path. Paths are unique (tree), so any data keyed by a message id is valid on every branch
// that passes through it — compaction summaries rely on this.

export function children(chat, parentId) {
  const out = [];
  for (const m of Object.values(chat.messages)) if ((m.parentId ?? null) === (parentId ?? null)) out.push(m);
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function siblings(chat, id) {
  const m = chat.messages[id];
  if (!m) return [];
  return children(chat, m.parentId ?? null);
}

/** Path root→id (inclusive). */
export function pathTo(chat, id) {
  const out = [];
  const seen = new Set();
  let cur = id ? chat.messages[id] : null;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = cur.parentId ? chat.messages[cur.parentId] : null;
  }
  return out.reverse();
}

export function activePath(chat) {
  return chat.activeLeafId ? pathTo(chat, chat.activeLeafId) : [];
}

/** From `id`, descend via activeChildId (or newest child) to a leaf. */
export function deepestLeaf(chat, id) {
  let cur = chat.messages[id];
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const kids = children(chat, cur.id);
    if (!kids.length) return cur.id;
    const next = (cur.activeChildId && chat.messages[cur.activeChildId]) || kids[kids.length - 1];
    cur = next;
  }
  return cur?.id ?? null;
}

/** Make `leafId` the active leaf and remember the branch choice at every ancestor. */
export function setActiveLeaf(chat, leafId) {
  const p = pathTo(chat, leafId);
  for (let i = 0; i < p.length; i++) {
    if (i === 0) chat.activeRootId = p[0].id;
    else p[i - 1].activeChildId = p[i].id;
  }
  chat.activeLeafId = leafId;
}

export function addMessage(chat, msg) {
  if (msg.parentId && !chat.messages[msg.parentId]) throw new Error(`parent ${msg.parentId} not found`);
  chat.messages[msg.id] = msg;
  return msg;
}

/** Delete a message and its whole subtree. Returns deleted ids. If the active path is affected, picks a neighbour. */
export function deleteSubtree(chat, id) {
  const target = chat.messages[id];
  if (!target) return [];
  const doomed = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    doomed.push(cur);
    for (const c of children(chat, cur)) stack.push(c.id);
  }
  const activeIds = new Set(activePath(chat).map((m) => m.id));
  const affectsActive = doomed.some((d) => activeIds.has(d));
  const parentId = target.parentId ?? null;
  for (const d of doomed) delete chat.messages[d];
  for (const m of Object.values(chat.messages)) if (m.activeChildId && !chat.messages[m.activeChildId]) m.activeChildId = null;
  if (affectsActive) {
    const sibs = children(chat, parentId);
    if (sibs.length) setActiveLeaf(chat, deepestLeaf(chat, sibs[sibs.length - 1].id));
    else if (parentId && chat.messages[parentId]) setActiveLeaf(chat, parentId);
    else {
      const roots = children(chat, null);
      if (roots.length) setActiveLeaf(chat, deepestLeaf(chat, roots[roots.length - 1].id));
      else { chat.activeLeafId = null; chat.activeRootId = null; }
    }
  }
  return doomed;
}

/** First message of the turn that produced `id` (walk up to the nearest user message). */
export function turnUserMessage(chat, id) {
  let cur = chat.messages[id];
  while (cur && cur.role !== 'user') cur = cur.parentId ? chat.messages[cur.parentId] : null;
  return cur || null;
}
