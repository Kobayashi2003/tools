import { api, esc, fmtCount, isActive, prefs, toast } from './api.js';
import { mountAdd } from './add.js';
import { I } from './icons.js';
import { mountInbox, inboxSince } from './inbox.js';
import { mountJobs } from './jobs.js';
import { mountLinks } from './linkview.js';
import { connect, on, patch, patchRows } from './live.js';
import { closeMenu } from './menu.js';
import { mountMigrate } from './migrate.js';
import { mountHome, refreshHome } from './overview.js';
import { mountRegroup } from './regroup.js';
import { applyCreatorRoute, currentCreator, mountCreator, refreshCreator, unmountCreator } from './posts.js';
import { mountSettings } from './settings.js';

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

const getCreators = () => creators;

async function loadCreators() {
  try {
    creators = await api('creators');
  } catch {
    return;
  }
  renderTree();
  const newLinks = creators.reduce((n, c) => n + (c.links_new || 0), 0);
  badge('links-n', newLinks, `${newLinks.toLocaleString()} new links`);
  document.getElementById('creators-n').textContent = creators.length ? creators.length.toLocaleString() : '';
  if (route().parts.length === 0) refreshHome(main, creators);
  refreshInboxBadge();
}

function badge(id, n, title) {
  const b = document.getElementById(id);
  b.hidden = !n;
  b.textContent = fmtCount(n);
  b.title = title;
}

// ---------------------------------------------------------------- tree
// Redrawn as a whole description and patched in: a job that changes one creator's counts
// rewrites that one badge, and the tree keeps its scroll, hover and drag state.

const waiting = (c) => (c.ignore || c.completed ? 0 : Math.max(0, c.fetchable - c.failed));
const failedOf = (c) => (c.ignore || c.completed ? 0 : c.failed);
const linksOf = (c) => (c.ignore || c.completed ? 0 : c.links_new || 0);
const blockedOf = (c) => (c.ignore || c.completed ? 0 : c.blocked || 0);

function counts(parts) {
  return [
    parts.dl && `${parts.dl.toLocaleString()} posts to download`,
    parts.failed && `${parts.failed.toLocaleString()} failed, retried on the next download`,
    parts.blocked && `${parts.blocked.toLocaleString()} blocked: Pawchive 404 and no other source`,
    parts.links && `${parts.links.toLocaleString()} new links`,
  ].filter(Boolean).join(' · ');
}

// The one badge a creator shows: what waits, else what failed, else new links.
function creatorBadge(c, busy) {
  if (busy) return '<span class="spin" title="Moving its folder"></span>';
  if (c.ignore) return '<span class="tb off">off</span>';
  if (c.completed) return '<span class="tb off">done</span>';
  const dl = waiting(c), failed = failedOf(c), links = linksOf(c);
  if (dl) return `<span class="tb">${I.dl}${fmtCount(dl)}</span>`;
  if (failed) return `<span class="tb bad">${I.x}${fmtCount(failed)}</span>`;
  if (links) return `<span class="tb ln">${I.link}${fmtCount(links)}</span>`;
  return '';
}

function treeHTML() {
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
  const total = (n) => n.items.length + [...n.kids.values()].reduce((s, k) => s + total(k), 0);
  const sum = (n, fn) => n.items.reduce((s, c) => s + fn(c), 0) + [...n.kids.values()].reduce((s, k) => s + sum(k, fn), 0);
  const item = (c) => {
    const busy = moving.has(c.id);
    const title = [`${c.alias || c.name} · ${c.id}`, c.ignore && 'ignored', busy ? 'moving its folder' : 'drag onto a group to move it',
      !busy && counts({ dl: waiting(c), failed: failedOf(c), blocked: blockedOf(c), links: linksOf(c) })].filter(Boolean).join(' · ');
    return `<a class="cr ${c.ignore ? 'ignored' : ''} ${busy ? 'moving' : ''}" data-key="c:${esc(c.id)}" href="#/c/${encodeURIComponent(c.id)}" draggable="${!busy}" data-cid="${esc(c.id)}" ${c.id === current ? 'aria-current="true"' : ''} title="${esc(title)}">
      <span class="dots ${c.service === 'patreon' ? 'site-patreon' : ''}"><i class="dp-${c.p_dot}"></i><i class="df-${c.f_dot}"></i></span><span class="nm">${esc(c.alias || c.name)}</span>
      <span class="cnt">${creatorBadge(c, busy)}</span></a>`;
  };
  // A group shows how many posts wait inside it and how many creators it holds.
  const summary = (key, name, node, editable) => {
    const dl = sum(node, waiting);
    const title = [key || 'Ungrouped', counts({ dl, failed: sum(node, failedOf), blocked: sum(node, blockedOf), links: sum(node, linksOf) }), editable && 'drag onto another group to move it'].filter(Boolean).join(' · ');
    return `<summary data-key="#s" ${editable ? 'draggable="true"' : ''} title="${esc(title)}"><span class="gname">${esc(name)}</span><span>${dl ? `<span class="tb">${I.dl}${fmtCount(dl)}</span>` : ''}</span><span class="num">${total(node)}</span>${editable ? `<button type="button" class="grp-edit" data-gedit aria-label="Rename or move ${esc(name)}" title="Rename or move">${I.edit}</button>` : '<span></span>'}</summary>`;
  };
  const walk = (node, path) => [...node.kids.entries()].map(([name, kid]) => {
    const key = path ? `${path}/${name}` : name;
    const open = q || !collapsed.has(key);
    return `<details class="grp" data-key="${esc(key)}" ${open ? 'open' : ''}>${summary(key, name, kid, true)}${kid.items.map(item).join('')}${walk(kid, key)}</details>`;
  }).join('');
  const ungrouped = root.items.length
    ? `<details class="grp" data-key="__root" ${q || !collapsed.has('__root') ? 'open' : ''}>${summary('', 'Ungrouped', { items: root.items, kids: new Map() }, false)}${root.items.map(item).join('')}</details>`
    : '';
  return list.length
    ? ungrouped + walk(root, '')
    : `<div class="tree-empty" data-key="#empty">${creators.length ? 'No match. Press Enter to add it as a link.' : 'No creators yet.<br>Use + to add one.'}</div>`;
}

function renderTree() {
  patch(tree, treeHTML());
  renderFold();
}

mountRegroup(tree, getCreators);

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
  if (fold.dataset.state !== String(expand)) {
    fold.innerHTML = expand ? I.unfold : I.fold;
    fold.dataset.state = String(expand);
  }
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

// ---------------------------------------------------------------- inbox badge

async function refreshInboxBadge() {
  try {
    const { n } = await api(`recent/count?since=${encodeURIComponent(inboxSince())}`);
    badge('recent-n', n, `${n.toLocaleString()} posts downloaded since you last marked the Inbox as reviewed`);
  } catch { /* the badge just stays as it was */ }
}
window.addEventListener('inbox-seen', refreshInboxBadge);

// ---------------------------------------------------------------- transitions
// The page being left stays on screen, dimmed under a progress bar, until the next one is
// ready; then it is swapped in with a short fade. Only a first visit shows a skeleton.

const progress = document.getElementById('progress');
let navToken = 0;
// What the shown view asks for when it is left: `cleanup` stops its subscriptions, and
// `guard` may keep the page (unsaved settings) by resolving false.
let leaving = { cleanup: null, guard: null };
let shownHash = location.hash;

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
  const { parts, params } = route();
  const cid = parts[0] === 'c' && parts[1] ? decodeURIComponent(parts[1]) : '';
  // Within one creator only the query changes (a post, a filter): the page stays.
  if (cid && currentCreator() === cid) {
    shownHash = location.hash;
    renderTree();
    applyCreatorRoute(params);
    return;
  }
  if (leaving.guard && !(await leaving.guard())) {
    history.replaceState(null, '', shownHash);
    return;
  }
  const token = ++navToken;
  shownHash = location.hash;
  renderTree();
  leaving.cleanup?.();
  leaving = { cleanup: null, guard: null };
  if (parts[0] !== 'c') unmountCreator();
  // Each view owns `main` while shown; drop the previous view's handlers and layout.
  main.onclick = null;
  main.oninput = null;
  main.classList.remove('panes');
  if (!main.children.length || main.querySelector('.loading:only-child')) main.innerHTML = skeleton();
  busy(true);
  try {
    let out = null;
    if (cid) { setNav(''); await mountCreator(main, cid, params, loadCreators); }
    else if (parts[0] === 'add') { setNav(''); mountAdd(main, params, loadCreators); }
    else if (parts[0] === 'recent') { setNav('recent'); out = await mountInbox(main); }
    else if (parts[0] === 'jobs') { setNav('jobs'); out = mountJobs(main, getCreators); }
    else if (parts[0] === 'links') { setNav('links'); out = await mountLinks(main, params); }
    else if (parts[0] === 'settings') { setNav('settings'); out = await mountSettings(main); }
    else if (parts[0] === 'migrate' && parts[1]) { setNav(''); await mountMigrate(main, decodeURIComponent(parts[1]), params); }
    else { setNav('overview'); out = await mountHome(main, creators); }
    if (token === navToken && out) leaving = { cleanup: out.cleanup || null, guard: out.guard || null };
    else out?.cleanup?.();
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
function setCollapsed(on) {
  document.documentElement.classList.toggle('side-collapsed', on);
  toggle.setAttribute('aria-label', on ? 'Expand sidebar' : 'Collapse sidebar');
  toggle.title = `${on ? 'Expand' : 'Collapse'} sidebar (Ctrl+B)`;
  prefs.set('side', on ? 'collapsed' : 'open');
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

// Dragging the sidebar's edge sets its width; a double-click puts it back.
const resizer = document.getElementById('side-resize');
const SIDE_MIN = 240, SIDE_MAX = 440, SIDE_DEFAULT = 300;
const setSideWidth = (w) => document.documentElement.style.setProperty('--side-w', `${w}px`);
resizer.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add('on');
  const left = resizer.parentElement.getBoundingClientRect().left;
  let width = SIDE_DEFAULT;
  const move = (ev) => {
    width = Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, ev.clientX - left)));
    setSideWidth(width);
  };
  const up = () => {
    resizer.classList.remove('on');
    resizer.removeEventListener('pointermove', move);
    prefs.set('sideW', String(width));
  };
  resizer.addEventListener('pointermove', move);
  resizer.addEventListener('pointerup', up, { once: true });
  resizer.addEventListener('pointercancel', up, { once: true });
});
resizer.addEventListener('dblclick', () => { setSideWidth(SIDE_DEFAULT); prefs.set('sideW', String(SIDE_DEFAULT)); });

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

const JOB_WORD = { probe: 'Fanbox check', sync: 'Sync', download: 'Download', subscriptions: 'Refresh plans', migration: 'Migration', move: 'Move folder', link_check: 'Check links', link_fetch: 'Fetch links' };

on('state', (state) => {
  const running = state.jobs.filter((j) => j.status === 'running');
  const queued = state.jobs.length - running.length;
  // Patched row by row: a redrawn row would restart its spinner on every progress line.
  // Two lines per job: who, then what it is doing, so neither has to give way.
  patchRows(foot, running.length || queued
    ? [
      ...running.map((j) => ({ key: `j${j.id}`, html: `<a class="job" href="#/jobs" title="${esc(`${j.creator_name || ''} · ${j.progress || ''}`)}"><span class="spin"></span><span class="job-n">${esc(j.creator_name || JOB_WORD[j.kind] || j.kind)}</span><span class="job-p">${esc(j.kind === 'probe' ? 'checking Fanbox' : `${JOB_WORD[j.kind] || j.kind} · ${j.progress || 'starting'}`)}</span></a>` })),
      ...(queued ? [{ key: 'queued', html: `<span class="job-q">${queued} queued</span>` }] : []),
    ]
    : [{ key: 'idle', html: '<span class="job"><span class="idle-dot"></span><span class="job-n">Idle</span></span>' }]);
  // Background Fanbox checks run all the time; the badge counts work you asked for.
  const asked = state.jobs.filter((j) => j.kind !== 'probe').length;
  badge('jobs-n', asked, `${asked.toLocaleString()} jobs running or queued`);
  const s = state.session || {};
  banner.hidden = s.state !== 'rejected';
  if (!banner.hidden) banner.innerHTML = `${I.x}<span>Fanbox rejected the cookie; Fanbox requests are paused. ${esc(s.message || '')}</span><a href="#/settings">Update it</a>`;
});

window.addEventListener('hashchange', show);
loadCreators().then(show);
connect();
