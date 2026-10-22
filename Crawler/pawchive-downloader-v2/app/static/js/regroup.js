import { api, attempt, esc, toast } from './api.js';
import { dialog } from './dialog.js';

// Regrouping in the sidebar. A group is a folder level ({group} in the creator folder
// template), so every change here moves folders on disk: it is confirmed first and runs as
// a job per creator, after any job that creator already has.

const leaf = (path) => path.split('/').pop();
const parentOf = (path) => path.split('/').slice(0, -1).join('/');
const inside = (path, group) => path === group || path.startsWith(group + '/');
const label = (group) => group || 'Ungrouped';

// Every group path, including levels that only hold other groups.
export function allGroups(creators) {
  const out = new Set();
  for (const c of creators) {
    const parts = (c.group || '').split('/').filter(Boolean);
    parts.forEach((_, i) => out.add(parts.slice(0, i + 1).join('/')));
  }
  return [...out].sort();
}

const pathLine = (from, to) => `<div class="move-path"><span class="mono">${esc(from)}</span><span class="arrow">→</span><span class="mono">${esc(to)}</span></div>`;

async function moveCreator(c, group) {
  const p = await attempt(() => api(`creators/${encodeURIComponent(c.id)}/move?group=${encodeURIComponent(group)}`));
  if (!p) return false;
  const body = !p.moves ? '<p>The creator folder template does not use the group, so no folder moves.</p>'
    : p.exists ? `<p>The creator's folder moves with it:</p>${pathLine(p.from, p.to)}<p class="muted">Post folders elsewhere, such as adopted ones, stay where they are.</p>`
    : `<p>Nothing is on disk yet; new downloads will go to</p><div class="move-path"><span class="mono">${esc(p.to)}</span></div>`;
  const ok = await dialog({ title: `Move ${c.alias || c.name} to ${label(group)}?`, body, confirm: 'Move' });
  if (!ok) return false;
  const out = await attempt(() => api(`creators/${encodeURIComponent(c.id)}/move`, { method: 'POST', body: { group } }));
  if (out) toast(out.job ? 'Moving; the sidebar updates when it is done' : 'Nothing to move');
  return !!out;
}

async function moveGroup(from, to, creators) {
  const n = creators.filter((c) => inside(c.group || '', from)).length;
  const out = await attempt(() => api('groups/move', { method: 'POST', body: { from, to } }));
  if (out) toast(`Moving ${n} creator${n === 1 ? '' : 's'}; the sidebar updates when they are done`);
  return !!out;
}

async function confirmGroup(from, to, creators) {
  const n = creators.filter((c) => inside(c.group || '', from)).length;
  const ok = await dialog({
    title: `Move ${leaf(from)} into ${label(parentOf(to))}?`,
    body: `<p>${n} creator${n === 1 ? '' : 's'} move with their folders:</p>${pathLine(from, to)}`,
    confirm: 'Move',
  });
  return ok ? moveGroup(from, to, creators) : false;
}

// The rename dialog takes a full path, so it also moves a group anywhere, or merges it into
// one that exists.
async function editGroup(key, creators) {
  const n = creators.filter((c) => inside(c.group || '', key)).length;
  const v = await dialog({
    title: `Rename or move ${leaf(key)}`,
    confirm: 'Move',
    body: `<p>${n} creator${n === 1 ? '' : 's'} move with their folders. Naming an existing group merges into it.</p>`,
    fields: [{ name: 'to', label: 'Group path', value: key, hint: 'Levels separated by /', options: allGroups(creators).filter((g) => !inside(g, key)) }],
  });
  const to = (v?.to || '').split(/[\\/]/).map((s) => s.trim()).filter(Boolean).join('/');
  if (!v || to === key) return;
  if (!to) return toast('A group needs a name; drag its creators to Ungrouped instead', true);
  if (inside(to, key)) return toast('A group cannot move into itself', true);
  await moveGroup(key, to, creators);
}

export function mountRegroup(tree, getCreators) {
  let dragged = null;
  let over = null;

  const groupOf = (el) => {
    const d = el.closest('details.grp');
    return d ? (d.dataset.key === '__root' ? '' : d.dataset.key) : null;
  };
  // Where `dragged` would land if dropped on group `g`; null when that changes nothing.
  const destination = (g) => {
    if (g == null || !dragged) return null;
    if (dragged.creator) return (dragged.creator.group || '') === g ? null : g;
    const to = g ? `${g}/${leaf(dragged.group)}` : leaf(dragged.group);
    return inside(g, dragged.group) || to === dragged.group ? null : to;
  };
  const mark = (summary) => {
    if (over === summary) return;
    over?.classList.remove('drop');
    over = summary;
    over?.classList.add('drop');
  };

  tree.addEventListener('dragstart', (e) => {
    const cr = e.target.closest?.('.cr[data-cid]');
    const sum = e.target.closest?.('details.grp > summary[draggable]');
    if (cr) dragged = { creator: getCreators().find((c) => c.id === cr.dataset.cid) };
    else if (sum) dragged = { group: sum.parentElement.dataset.key };
    else return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragged.creator ? dragged.creator.id : dragged.group);
    tree.classList.add('dragging');
  });
  tree.addEventListener('dragover', (e) => {
    const g = groupOf(e.target);
    if (destination(g) == null) { mark(null); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    mark(e.target.closest('details.grp').querySelector(':scope > summary'));
  });
  tree.addEventListener('dragleave', (e) => { if (!tree.contains(e.relatedTarget)) mark(null); });
  tree.addEventListener('dragend', () => { mark(null); dragged = null; tree.classList.remove('dragging'); });
  tree.addEventListener('drop', async (e) => {
    const g = groupOf(e.target);
    const to = destination(g);
    const what = dragged;
    mark(null);
    if (to == null || !what) return;
    e.preventDefault();
    if (what.creator) await moveCreator(what.creator, to);
    else await confirmGroup(what.group, to, getCreators());
  });
  tree.addEventListener('click', (e) => {
    const b = e.target.closest('[data-gedit]');
    if (!b) return;
    // Inside a <summary>: without this the click would also fold the group.
    e.preventDefault();
    editGroup(b.closest('details.grp').dataset.key, getCreators());
  });
}
