import { api, esc, isActive, prefs, toast } from './api.js';
import { mountAdd } from './add.js';
import { I } from './icons.js';
import { mountJobs } from './jobs.js';
import { connect, on, patchRows } from './live.js';
import { closeMenu } from './menu.js';
import { mountMigrate } from './migrate.js';
import { mountRegroup } from './regroup.js';
import { currentCreator, mountCreator, refreshCreator, unmountCreator } from './posts.js';
import { mountHome, mountSettings } from './settings.js';

const main = document.getElementById('main');
const tree = document.getElementById('tree');
const search = document.getElementById('crsearch');
let creators = [];
// Creators with a folder move queued or running; shown dimmed until it is done.
let moving = new Set();
let collapsed = new Set();
try { collapsed = new Set(JSON.parse(prefs.get('collapsed', '[]'))); } catch { /* not a list */ }

function route() {
  const [path, query] = (location.hash.slice(1) || '/').split('?');
  const parts = path.split('/').filter(Boolean);
  return { parts, params: new URLSearchParams(query || '') };
}

async function loadCreators() {
  try {
    creators = await api('creators');
  } catch {
    return;
  }
  renderTree();
}

function renderTree() {
  const q = search.value.trim().toLowerCase();
  const { parts } = route();
  const current = parts[0] === 'c' || parts[0] === 'migrate' ? decodeURIComponent(parts[1] || '') : '';
  const list = creators.filter((c) => !q || `${c.alias} ${c.name} ${c.id}`.toLowerCase().includes(q));
  const root = { kids: new Map(), items: [] };
  for (const c of list) {
    let node = root;
    for (const seg of (c.group || '').split('/').filter(Boolean)) {
      if (!node.kids.has(seg)) node.kids.set(seg, { kids: new Map(), items: [] });
      node = node.kids.get(seg);
    }
    node.items.push(c);
  }
  const count = (n) => n.items.length + [...n.kids.values()].reduce((s, k) => s + count(k), 0);
  const item = (c) => {
    const busy = moving.has(c.id);
    return `<a class="cr ${c.ignore ? 'ignored' : ''} ${busy ? 'moving' : ''}" href="#/c/${encodeURIComponent(c.id)}" draggable="${!busy}" data-cid="${esc(c.id)}" ${c.id === current ? 'aria-current="true"' : ''} title="${esc(c.alias || c.name)} · ${esc(c.id)}${c.ignore ? ' · ignored' : ''}${busy ? ' · moving its folder' : ' · drag onto a group to move it'}">
      <span class="dots"><i class="dp-${c.p_dot}"></i><i class="df-${c.f_dot}"></i></span><span class="nm">${esc(c.alias || c.name)}</span>
      <span class="cnt" title="${c.ignore ? '' : 'Posts to download'}">${busy ? '<span class="spin"></span>' : c.ignore ? 'off' : c.completed ? 'done' : c.fetchable || ''}</span></a>`;
  };
  const walk = (node, path) => [...node.kids.entries()].map(([name, kid]) => {
    const key = path ? `${path}/${name}` : name;
    const open = q || !collapsed.has(key);
    return `<details class="grp" data-key="${esc(key)}" ${open ? 'open' : ''}><summary draggable="true" title="${esc(key)} · drag onto another group to move it"><span>${esc(name)}</span><span class="num">${count(kid)}</span><button type="button" class="grp-edit" data-gedit aria-label="Rename or move ${esc(name)}" title="Rename or move">${I.edit}</button></summary>
      ${kid.items.map(item).join('')}${walk(kid, key)}</details>`;
  }).join('');
  const ungrouped = root.items.length
    ? `<details class="grp" data-key="__root" ${q || !collapsed.has('__root') ? 'open' : ''}><summary><span>Ungrouped</span><span class="num">${root.items.length}</span></summary>${root.items.map(item).join('')}</details>`
    : '';
  tree.innerHTML = list.length
    ? ungrouped + walk(root, '')
    : `<div class="tree-empty">${creators.length ? 'No match. Press Enter to add it as a link.' : 'No creators yet.<br>Use + to add one, or <span class="mono">main.py import-v1</span>.'}</div>`;
  renderFold();
}

mountRegroup(tree, () => creators);

const saveCollapsed = () => prefs.set('collapsed', JSON.stringify([...collapsed]));

tree.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || search.value) return;
  if (d.open) collapsed.delete(d.dataset.key);
  else collapsed.add(d.dataset.key);
  saveCollapsed();
  renderFold();
}, true);

// One button: expands everything while anything is folded, otherwise folds everything.
const fold = document.getElementById('tree-fold');
const groupKeys = () => [...tree.querySelectorAll('details.grp')].map((d) => d.dataset.key);
function renderFold() {
  const keys = groupKeys();
  const expand = keys.some((k) => collapsed.has(k));
  const label = expand ? 'Expand all groups' : 'Collapse all groups';
  fold.innerHTML = expand ? I.unfold : I.fold;
  fold.title = label;
  fold.setAttribute('aria-label', label);
  // While searching every match is shown open, so there is nothing to fold.
  fold.disabled = !keys.length || !!search.value.trim();
}
fold.addEventListener('click', () => {
  const keys = groupKeys();
  if (keys.some((k) => collapsed.has(k))) keys.forEach((k) => collapsed.delete(k));
  else keys.forEach((k) => collapsed.add(k));
  saveCollapsed();
  renderTree();
});

search.addEventListener('input', renderTree);
search.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = search.value.trim();
  const hit = creators.filter((c) => `${c.alias} ${c.name} ${c.id}`.toLowerCase().includes(q.toLowerCase()));
  if (hit.length === 1) location.hash = `#/c/${encodeURIComponent(hit[0].id)}`;
  else if (q) location.hash = `#/add?ref=${encodeURIComponent(q)}`;
});

function setNav(name) {
  document.querySelectorAll('.side nav a').forEach((a) => a.setAttribute('aria-current', a.dataset.nav === name ? 'page' : 'false'));
}

// ---------------------------------------------------------------- transitions
// The page being left stays on screen, dimmed under a progress bar, until the next one is
// ready; then it is swapped in with a short fade. Only a first visit shows a skeleton.

const progress = document.getElementById('progress');
let navToken = 0;

const skeleton = () => `<div class="skeleton" aria-busy="true" aria-label="Loading">
  <div class="sk-head"><span class="sk sk-avatar"></span><span class="sk sk-line w40"></span></div>
  <div class="sk-tiles">${'<span class="sk sk-tile"></span>'.repeat(3)}</div>
  <div class="sk-bar sk"></div>
  ${'<div class="sk-row"><span class="sk sk-thumb"></span><span class="sk sk-line w60"></span><span class="sk sk-line w15"></span></div>'.repeat(8)}
</div>`;

function busy(on) {
  progress.hidden = !on;
  main.classList.toggle('busy', on);
}

async function show() {
  closeMenu();
  const token = ++navToken;
  const { parts, params } = route();
  renderTree();
  if (parts[0] !== 'c') unmountCreator();
  // Each view owns `main` while shown; drop the previous view's click handler.
  main.onclick = null;
  const cid = parts[0] === 'c' && parts[1] ? decodeURIComponent(parts[1]) : '';
  if (cid && currentCreator() === cid) return;
  if (!main.children.length || main.querySelector('.loading:only-child')) main.innerHTML = skeleton();
  busy(true);
  try {
    if (cid) { setNav('creators'); await mountCreator(main, cid, loadCreators); }
    else if (parts[0] === 'add') { setNav('creators'); mountAdd(main, params, loadCreators); }
    else if (parts[0] === 'jobs') { setNav('jobs'); mountJobs(main); }
    else if (parts[0] === 'settings') { setNav('settings'); await mountSettings(main); }
    else if (parts[0] === 'migrate' && parts[1]) { setNav('creators'); await mountMigrate(main, decodeURIComponent(parts[1]), params); }
    else { setNav('creators'); await mountHome(main, creators); }
  } finally {
    if (token === navToken) {
      busy(false);
      main.scrollTop = 0;
      main.classList.remove('enter');
      void main.offsetWidth; // restart the fade
      main.classList.add('enter');
    }
  }
}

// ---------------------------------------------------------------- sidebar

const toggle = document.getElementById('side-toggle');
function setCollapsed(collapsed) {
  document.documentElement.classList.toggle('side-collapsed', collapsed);
  toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  toggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  prefs.set('side', collapsed ? 'collapsed' : 'open');
}
toggle.addEventListener('click', () => setCollapsed(!document.documentElement.classList.contains('side-collapsed')));
setCollapsed(document.documentElement.classList.contains('side-collapsed'));
document.addEventListener('keydown', (e) => {
  // Ctrl+B / Cmd+B, as in most editors.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && !e.target.closest?.('input, textarea')) {
    e.preventDefault();
    toggle.click();
  }
});

// ---------------------------------------------------------------- live state

const foot = document.getElementById('side-foot');

// Finished jobs are found in the job history, not by watching the active list: a folder
// move takes milliseconds and can start and end between two snapshots.
let wasActive = null;
let reloadTimer = 0;
on('jobs', (jobs) => {
  // Ended since the last snapshot: active then, or not seen before (the first snapshot
  // only records what is there).
  const ended = (j) => !isActive(j) && wasActive.get(j.id) !== false;
  const finished = wasActive ? jobs.filter(ended) : [];
  wasActive = new Map(jobs.map((j) => [j.id, isActive(j)]));
  for (const id of new Set(finished.map((j) => j.creator_id).filter(Boolean))) refreshCreator(id);
  const moves = finished.filter((j) => j.kind === 'move');
  if (moves.length) reportMoves(moves);
  const nowMoving = new Set(jobs.filter((j) => j.kind === 'move' && isActive(j)).map((j) => j.creator_id));
  const movingChanged = nowMoving.size !== moving.size || [...nowMoving].some((id) => !moving.has(id));
  moving = nowMoving;
  if (finished.length) {
    // A group move finishes as one job per creator: reload once for the lot.
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(loadCreators, 250);
  } else if (movingChanged) renderTree();
});

function reportMoves(moves) {
  // Show where the creators went, even inside groups that were folded.
  for (const j of moves) {
    const parts = (j.params.group || '').split('/').filter(Boolean);
    parts.forEach((_, i) => collapsed.delete(parts.slice(0, i + 1).join('/')));
    if (!parts.length) collapsed.delete('__root');
  }
  saveCollapsed();
  const failed = moves.filter((j) => j.status !== 'done');
  if (failed.length) toast(`Move failed: ${failed[0].creator_name || failed[0].creator_id}: ${failed[0].error || failed[0].status}`, true);
  else if (moves.length === 1) toast(`${moves[0].creator_name}: ${moves[0].note}`);
  else toast(`Moved ${moves.length} creators`);
}
const banner = document.getElementById('banner');

on('online', (up) => {
  if (!up) patchRows(foot, [{ key: 'offline', html: '<span class="lvl-error">Cannot reach the server. Is it running?</span>' }]);
});

on('state', (state) => {
  const running = state.jobs.filter((j) => j.status === 'running');
  const queued = state.jobs.length - running.length;
  // Patched row by row: a redrawn row would restart its spinner on every progress line.
  patchRows(foot, running.length || queued
    ? [
      ...running.map((j) => ({ key: `j${j.id}`, html: `<a class="job" href="#/jobs" title="${esc(j.creator_name || j.kind)}"><span class="spin"></span><span class="job-t">${esc(j.creator_name || j.kind)} · ${esc(j.kind === 'probe' ? 'checking Fanbox' : j.progress || 'starting')}</span></a>` })),
      ...(queued ? [{ key: 'queued', html: `<span class="job-t">${queued} queued</span>` }] : []),
    ]
    : [{ key: 'idle', html: '<span class="job"><span class="idle-dot"></span><span class="job-t">Idle</span></span>' }]);
  const s = state.session || {};
  banner.hidden = s.state !== 'rejected';
  if (!banner.hidden) banner.innerHTML = `${I.x}<span>Fanbox rejected the cookie; Fanbox requests are paused. ${esc(s.message || '')}</span><a href="#/settings">Update it</a>`;
});

window.addEventListener('hashchange', show);
loadCreators().then(show);
connect();
