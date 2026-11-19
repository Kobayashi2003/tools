import { ago, api, at, attempt, copyText, esc, fmtSize, isActive, localOffset, prefs, shortcutAllowed, toast } from './api.js';
import { dialog } from './dialog.js';
import { I } from './icons.js';
import * as L from './links.js';
import { on, patch, patchRows } from './live.js';
import { actionItem, checkItem, closeMenu, linkItem, menuOpenFor, openMenu, radioItem } from './menu.js';
import { allGroups } from './regroup.js';
import { emptyState } from './ui.js';

// The creator page. Its parts are described as HTML and patched in (live.js), so an update
// touches only what changed: choosing a post marks two rows and redraws the detail pane, a
// finished job rewrites the rows whose state moved, and the header and toolbar stay put.

const P_LABEL = { full: 'Pawchive: has files', meta: 'Pawchive: metadata only', none: 'Pawchive: not listed', gone: 'Pawchive: gone' };
const F_LABEL = { open: 'Fanbox: accessible', locked: 'Fanbox: not subscribed', gone: 'Fanbox: deleted', unknown: 'Fanbox: not checked', na: '' };
const VIA = {
  pawchive: ['Pawchive', 'vp', 'P'], fanbox: ['Fanbox', 'vf', 'F'],
  local: ['On disk', 'va', 'D'], manual: ['Manual', 'va', 'M'],
};
const PAGE = 150;
// The main area's width from which the list and the detail sit side by side.
const SPLIT_AT = 1400;
const LIST_MIN = 560, PANE_MIN = 520, LIST_DEFAULT = 1040;

// The creator's own site, Fanbox or Patreon: the server stores and labels both as "fanbox"
// (see domain/status.py). The labels above say "Fanbox"; `sited` puts the shown creator's
// site in its place.
const hasSite = (d) => d.service === 'fanbox' || d.service === 'patreon';
const siteName = () => S?.detail?.site || 'Fanbox';
// Patreon's mark is a P like Pawchive's, told apart by colour (.site-patreon in tokens.css).
const siteLetter = () => (S?.detail?.service === 'patreon' ? 'P' : 'F');
const sited = (text) => String(text).replace(/Fanbox/g, siteName());
// A Patreon post you cannot open gives no amount, stored as 1: shown as "Paid".
const money = (fee) => (S?.detail?.currency === '$' ? (fee > 1 ? `$${fee}` : 'Paid') : `¥${fee}`);

// Within one group the options are OR-ed; separate groups (and dropdowns) are AND-ed.
const FILTERS = {
  cov: { label: 'Source', groups: [
    { id: 'c', label: 'Coverage', fn: (r, v) => r.cov === v, opts: [['both', 'On both'], ['ponly', 'Pawchive only'], ['fonly', 'Fanbox only'], ['unknown', 'Fanbox not checked'], ['local', 'Local only']] },
    { id: 'p', label: 'Pawchive', fn: (r, v) => r.p === v, opts: [['full', 'Has files'], ['meta', 'Metadata only'], ['none', 'Not listed'], ['gone', 'Gone']] },
    { id: 'f', label: 'Fanbox', fanbox: true, fn: (r, v) => r.f === v, opts: [['open', 'Accessible'], ['locked', 'Not subscribed'], ['gone', 'Deleted'], ['unknown', 'Not checked']] },
  ] },
  st: { label: 'Status', groups: [
    { id: 's', label: 'Local', fn: (r, v) => r.head.k === v, opts: [['done', 'Done'], ['partial', 'Partial'], ['pending', 'Pending'], ['failed', 'Failed'], ['blocked', 'Blocked (Pawchive 404)'], ['na', 'Unavailable'], ['filtered', 'Filtered'], ['ignored', 'Ignored']] },
    { id: 'm', label: 'Needs a look', fn: (r, v) => FLAG[v](r), opts: [['stale', 'Updated upstream'], ['mismatch', 'Times disagree'], ['bad', 'Check failed'], ['unverified', 'Adopted, unverified']] },
    { id: 'l', label: 'Cloud-storage links', fn: (r, v) => (v === 'new' ? r.links_new > 0 : r.links > 0), opts: [['any', 'Has links'], ['new', 'Has new links']] },
  ] },
  sub: { label: 'Plan', fanbox: true, groups: [
    { id: 'u', label: '', fn: (r, v) => r.sub === v, opts: [['free', 'Free'], ['yes', 'Open to me'], ['no', 'Locked to me'], ['unknown', 'Not signed in']] },
  ] },
  via: { label: 'Got from', groups: [
    { id: 'v', label: '', fn: (r, v) => (v === 'none' ? !r.total : v === 'mix' ? r.via.length > 1 : v === 'nil' ? r.total && !r.via.length : r.via.includes(v)), opts: [['pawchive', 'Pawchive'], ['fanbox', 'Fanbox'], ['local', 'Found on disk'], ['mix', 'Mixed'], ['nil', 'Nothing yet'], ['none', 'No files']] },
  ] },
};
const FLAG = {
  stale: (r) => (r.head.why || '').startsWith('Updated upstream'),
  mismatch: (r) => r.mismatch,
  bad: (r) => r.verified_bad > 0,
  unverified: (r) => (r.head.why || '').includes('unverified'),
};
// Group id → the dropdown it belongs to, for filters read back from the address.
const GROUP_DIM = Object.fromEntries(Object.entries(FILTERS).flatMap(([dim, f]) => f.groups.map((g) => [g.id, dim])));
const ORDER = ['failed', 'blocked', 'partial', 'pending', 'na', 'done', 'filtered', 'ignored'];
const SORTS = {
  new: ['Newest', 'Published · newest first', (a, b) => b.published.localeCompare(a.published)],
  old: ['Oldest', 'Published · oldest first', (a, b) => a.published.localeCompare(b.published)],
  status: ['Status', 'Status · needs work first', (a, b) => ORDER.indexOf(a.head.k) - ORDER.indexOf(b.head.k) || b.published.localeCompare(a.published)],
  fee: ['Fee', 'Fee · highest first', (a, b) => b.fee - a.fee || b.published.localeCompare(a.published)],
  files: ['Files', 'Files · most first', (a, b) => b.total - a.total],
};
// What a creator-wide download takes on; the rest wait for nothing or for you.
const WORK = new Set(['pending', 'partial', 'failed']);

// Filters survive switching creators: "show me what is still pending" is a habit.
const sel = { cov: new Set(), st: new Set(), sub: new Set(), via: new Set() };
let sort = 'new';
let showThumbs = prefs.get('thumbs') !== 'off';
let layout = prefs.get('postLayout') === 'grid' ? 'grid' : 'list';
let showKeys = false;

let S = null;

// The size is in the URL so a browser holding a cached smaller thumbnail asks again.
const thumbURL = (id) => `api/thumbs/${encodeURIComponent(S.cid)}/${encodeURIComponent(id)}?w=640`;
const thumbImg = (id, cls) => (S.noThumb.has(id)
  ? `<span class="${cls} none" title="No cover"></span>`
  : `<img class="${cls}" src="${thumbURL(id)}" data-thumb="${esc(id)}" alt="" loading="lazy" decoding="async">`);

// A missing cover becomes a quiet placeholder of the same size, so rows stay aligned, and
// is remembered, so a later redraw does not ask for it again.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.thumb) return;
  S?.noThumb.add(img.dataset.thumb);
  const ph = document.createElement('span');
  ph.className = img.className + ' none';
  ph.title = 'No cover';
  img.replaceWith(ph);
}, true);

const okey = (g, v) => `${g.id}:${v}`;
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const row = (id) => S.byId.get(id);

function matches(r, dim, except) {
  const s = sel[dim];
  if (!s.size || dim === except) return true;
  return FILTERS[dim].groups.every((g) => {
    const chosen = g.opts.filter(([v]) => s.has(okey(g, v)));
    return !chosen.length || chosen.some(([v]) => g.fn(r, v));
  });
}

// A pasted post link is searched by its id.
const searchTerm = () => {
  const q = S.q.trim().toLowerCase();
  const id = q.match(/(?:post|posts)\/(\d+)/)?.[1];
  return id || q;
};

function visible(except) {
  const q = searchTerm();
  return S.rows.filter((r) => (!q || r.title.toLowerCase().includes(q) || r.id.includes(q)) && Object.keys(FILTERS).every((d) => matches(r, d, except)));
}

const anyFilter = () => Object.values(sel).some((s) => s.size) || !!S.q.trim();

function clearFilters() {
  Object.values(sel).forEach((s) => s.clear());
  S.q = '';
  const input = S.dom?.root.querySelector('#psearch');
  if (input) input.value = '';
}

const cells = (p, f) => `<span class="src"><span class="sc p ${p}" title="${P_LABEL[p] || ''}">P</span><span class="sc f ${f === 'na' ? 'na' : f}" title="${sited(F_LABEL[f] || '')}">${siteLetter()}</span></span>`;

// Where the post's main files came from; the cover and the text are not counted.
function viaHTML(via, total = 1) {
  if (!total) return '<span class="via muted-dash" title="No files besides the cover and the text">No files</span>';
  if (!via.length) return '<span class="via muted-dash">—</span>';
  if (via.length > 1) {
    return `<span class="via" title="${via.map((v) => sited((VIA[v] || [v])[0])).join(' + ')}">Mixed ${via.map((v) => `<b class="${(VIA[v] || [])[1] || 'va'}">${v === 'fanbox' ? siteLetter() : (VIA[v] || [v, '', v])[2]}</b>`).join('+')}</span>`;
  }
  const [label, cls] = VIA[via[0]] || [via[0], 'va'];
  return `<span class="via"><b class="${cls}">${sited(label)}</b></span>`;
}

function tzTitle(utc) {
  if (!utc) return '';
  const u = at(utc), j = at(utc, 540), l = at(utc, localOffset());
  return `UTC ${u.date} ${u.time} · JST ${j.date} ${j.time} · local ${l.date} ${l.time}`;
}

// Links for one post, or the creator when `postId` is empty; each null when not available.
function sitesFor(postId, r) {
  const d = S.detail;
  const origin = L.origin(d, postId);
  return [
    { label: 'Pawchive', url: L.pawchive(d, postId), why: r?.p === 'none' ? 'Not on Pawchive' : '' },
    ...(d.service === 'fanbox' ? [{ label: 'Fanbox', url: L.fanbox(d, postId), why: !d.fanbox_creator_id ? 'creatorId not resolved yet' : r?.f === 'gone' ? 'Deleted on Fanbox' : '' }] : []),
    ...(origin ? [{ label: origin.label, url: origin.url, why: '' }] : []),
  ].map((s) => ({ ...s, url: s.why ? null : s.url }));
}

// What the Plan column says. Signed out, only the fee is known, shown quietly.
function planCell(r) {
  if (r.sub === 'free') return '<span class="sub free">Free</span>';
  const fee = money(r.fee), site = siteName();
  if (r.sub === 'yes') return `<span class="sub yes" title="${site} opens this ${fee} post to you">${fee}</span>`;
  if (r.sub === 'no') return `<span class="sub no" title="${site} keeps this ${fee} post locked for you">${fee}</span>`;
  return `<span class="sub unknown" title="Sign in to ${site} to see whether your plan covers it">${fee}</span>`;
}

const statusChip = (h) => `<span class="chip k-${h.k}">${esc(h.t)}</span>`;

// ---------------------------------------------------------------- header

function header() {
  const d = S.detail;
  const n = { both: 0, ponly: 0, fonly: 0, local: 0, unknown: 0 };
  const pc = { full: 0, meta: 0, none: 0, gone: 0 };
  const fc = { open: 0, locked: 0, gone: 0, unknown: 0 };
  const k = {};
  for (const r of S.rows) {
    n[r.cov] = (n[r.cov] || 0) + 1;
    pc[r.p] = (pc[r.p] || 0) + 1;
    if (r.f in fc) fc[r.f]++;
    k[r.head.k] = (k[r.head.k] || 0) + 1;
  }
  const total = S.rows.length || 1;
  const seg = (key) => (n[key] ? `<span class="c-${key}" style="width:${((n[key] / total) * 100).toFixed(2)}%"></span>` : '');
  const name = d.alias || d.name;
  const fanbox = hasSite(d);
  const site = siteName();
  const pSum = pc.full + pc.meta;
  const pState = d.pawchive_state === 'none' ? 'Not on Pawchive'
    : d.pawchive_state === 'gone' ? 'Creator no longer on Pawchive'
    : pSum && !pc.full ? 'Metadata only (has_full=false)'
    : `${pc.full} with files · ${pc.meta} metadata only${pc.gone ? ` · ${pc.gone} gone` : ''}`;
  // A cancelled plan leaves your plan list at once but keeps its posts open for the paid month.
  const paidOpen = S.rows.some((r) => r.fee > 0 && r.f === 'open');
  const plan = d.service === 'patreon' ? (d.session === 'rejected' ? 'cookie rejected' : d.session === 'valid' ? 'signed in' : 'signed out')
    : d.plan_fee == null ? (d.session === 'rejected' ? 'cookie rejected' : 'signed out') : d.plan_fee ? `¥${d.plan_fee} plan` : paidOpen ? 'no current plan; paid posts still open' : 'no plan';
  const fState = !fanbox ? '' : d.fanbox_state === 'none' ? `No ${site} page`
    : !d.fanbox_listed_at ? (d.fanbox_checked_at ? 'Not checked yet: the last check failed' : 'Not checked yet')
    : `${fc.open} accessible · ${fc.locked} locked${fc.gone ? ` · ${fc.gone} deleted` : ''}`;
  const loc = d.local || {};
  const localParts = [
    ...[['pawchive', 'Pawchive'], ['fanbox', site], ['found', 'on disk']].filter(([key]) => loc[key]).map(([key, l]) => `${loc[key].toLocaleString()} ${l}`),
    k.blocked && `${k.blocked.toLocaleString()} blocked`,
    k.failed && `${k.failed.toLocaleString()} failed`,
  ].filter(Boolean);
  const work = S.rows.filter((r) => WORK.has(r.head.k)).length;
  const dlTitle = work ? `Download ${plural(work, 'post')} that a source can deliver`
    : k.blocked ? `${plural(k.blocked, 'post')} are blocked: Pawchive answered 404 and ${site} cannot deliver them. Download one by hand to ask again.`
    : 'Nothing to download';
  const synced = d.synced_at || d.fanbox_checked_at;
  const ids = `${esc(d.service)} <span class="mono">${esc(d.user_id)}</span>${fanbox ? ` · <span class="mono">${d.fanbox_creator_id ? (d.service === 'patreon' ? 'campaign ' : '@') + esc(d.fanbox_creator_id) : d.fanbox_state === 'none' ? `no ${site}` : 'not resolved'}</span>` : ''}`;
  return `<div class="ch">
    <div class="ch-top">
      <div class="avatar">${esc(name.slice(0, 1))}</div>
      <div class="ch-id">
        <h1><span class="ch-name">${esc(name)}</span>${d.alias && d.alias !== d.name ? `<small>${esc(d.name)}</small>` : ''}${d.ignore ? '<span class="chip k-ignored">Ignored</span>' : ''}${d.completed ? '<span class="chip k-done">Completed</span>' : ''}</h1>
        <div class="ch-meta">
          <span>${ids}</span>
          <span><button type="button" data-cact="edit" title="Change the alias or group (moves the folder)">${esc(d.group || 'Ungrouped')}</button></span>
          <span title="${esc(synced || '')}">Synced ${esc(ago(synced))}</span>
          <span>${d.preference === 'fanbox-first' ? `${site} first` : 'Pawchive first'}${d.config.source_preference ? '' : ' (default)'}</span>
          ${d.links_new ? `<span><a href="#/links?creator=${encodeURIComponent(d.id)}" title="Cloud-storage links in this creator's posts">${plural(d.links_new, 'new link')}</a></span>` : ''}
        </div>
      </div>
      <div class="ch-btns">
        <span class="ch-sites">${sitesFor('').filter((s) => s.url).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noreferrer" title="Open on ${s.label}">${s.label}${I.ext}</a>`).join('')}</span>
        <button class="btn" type="button" data-cact="sync">${I.sync}Sync</button>
        <button class="btn primary" type="button" data-cact="download" ${work ? '' : 'disabled'} title="${esc(dlTitle)}">${I.dl}Download ${work.toLocaleString()}</button>
        <div class="dd"><button type="button" class="btn icon" data-cmenu aria-label="More actions" aria-haspopup="true" aria-expanded="false">${I.dots}</button></div>
      </div>
    </div>
    <div class="ch-stats">
      <div class="sbox ${pSum && !pc.full ? 'warn' : ''}"><div class="h"><span class="sc p ${pc.full ? 'full' : pSum ? 'meta' : 'none'}">P</span>Pawchive<span class="h-r">${esc(ago(d.pawchive_checked_at))}</span></div><div class="v"><b>${pSum.toLocaleString()}</b>posts</div><div class="s" title="${esc(pState)}">${esc(pState)}</div></div>
      ${fanbox ? `<div class="sbox ${d.session === 'rejected' ? 'warn' : ''}"><div class="h"><span class="sc f ${fc.open ? 'open' : fc.locked ? 'locked' : 'unknown'}">${siteLetter()}</span>${site}<span class="h-r">${esc(plan)}</span></div><div class="v"><b>${(fc.open + fc.locked).toLocaleString()}</b>posts</div><div class="s" title="${esc(fState)}">${esc(fState)}</div></div>`
        : '<div class="sbox"><div class="h"><span class="sc f unknown">F</span>Own site</div><div class="v"><b>—</b></div><div class="s">Not a Fanbox or Patreon creator</div></div>'}
      <div class="sbox"><div class="h"><span class="sc lc">L</span>Local<button class="linkbtn h-r" type="button" data-open="${esc(d.dir)}" title="${esc(d.dir)}">Open folder</button></div><div class="v"><b>${(k.done || 0).toLocaleString()}</b>posts done</div><div class="s" title="${esc(localParts.join(' · '))}">${esc(localParts.join(' · ') || 'Nothing downloaded yet')}</div></div>
      ${S.rows.length ? `<div class="cover">
        <div class="cover-bar" role="img" aria-label="Source coverage">${seg('both')}${seg('ponly')}${seg('fonly')}${seg('unknown')}${seg('local')}</div>
        <div class="cover-legend">
          ${[['both', 'On both', 'c-both'], ['ponly', 'Pawchive only', 'c-ponly'], ['fonly', 'Fanbox only', 'c-fonly'], ['unknown', 'Fanbox not checked', 'c-unknown'], ['local', 'Local only', 'c-local']].filter(([key]) => n[key]).map(([key, l, c]) => `<button type="button" data-cov="${key}" title="Show only these"><i class="${c}"></i>${sited(l)} <span class="num">${n[key].toLocaleString()}</span></button>`).join('')}
        </div></div>` : ''}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- menus

function summary(dim) {
  const s = sel[dim];
  if (!s.size) return 'All';
  if (s.size === 1) {
    const key = [...s][0];
    for (const g of FILTERS[dim].groups) for (const [v, l] of g.opts) if (okey(g, v) === key) return sited(l);
  }
  return `${s.size} selected`;
}

function filterMenu(dim) {
  const fanbox = hasSite(S.detail);
  const base = visible(dim);
  const s = sel[dim];
  const groups = FILTERS[dim].groups.filter((g) => fanbox || !g.fanbox);
  const total = groups.reduce((n, g) => n + g.opts.length, 0);
  return `${total > 8 ? `<div class="menu-search"><label class="field">${I.search}<input placeholder="Filter options" aria-label="Filter options"></label></div>` : ''}
    <div class="menu-body">${groups.map((g) => `<div class="menu-group">${g.label ? `<div class="menu-label"><span>${sited(g.label)}</span></div>` : ''}
      ${g.opts.map(([v, l]) => { const key = okey(g, v); const c = base.filter((r) => g.fn(r, v)).length; return checkItem({ key, label: sited(l), on: s.has(key), count: c.toLocaleString(), faint: !c }); }).join('')}</div>`).join('')}</div>
    <div class="menu-foot"><span>${s.size ? `${s.size} selected${groups.length > 1 ? ' · OR within a group' : ''}` : 'No filter'}</span><button type="button" class="linkbtn" data-clear ${s.size ? '' : 'disabled'}>Clear</button></div>`;
}

function rowMenu(r) {
  const done = r.head.k === 'done';
  return `<div class="menu-body">
    ${actionItem({ act: 'download', label: done ? 'Fetch missing files' : 'Download now', icon: I.dl, hint: '<kbd>d</kbd>' })}
    ${actionItem({ act: 'source', label: 'Download from…', icon: I.dl, sub: 'source' })}
    ${actionItem({ act: 'redownload', label: 'Download again', icon: I.reset })}
    ${actionItem({ act: 'resync', label: 'Re-sync (check edits)', icon: I.sync })}
    <div class="sep"></div>
    ${actionItem({ act: 'open', label: 'Open folder', icon: I.folder, hint: '<kbd>o</kbd>' })}
    ${actionItem({ act: 'copy', label: 'Copy post id', icon: I.copy })}
    ${sitesFor(r.id, r).map((s) => linkItem({ href: s.url, label: `Open on ${s.label}`, disabled: s.why })).join('')}
    <div class="sep"></div>
    ${done ? actionItem({ act: 'undone', label: 'Mark as not done', icon: I.reset }) : actionItem({ act: 'done', label: 'Mark as done', icon: I.check })}
  </div>`;
}

function sourceSub(r) {
  const d = S.detail;
  const pWhy = r.p === 'meta' ? 'Pawchive has metadata only' : r.p === 'none' ? 'Not on Pawchive' : r.p === 'gone' ? 'Gone from Pawchive' : '';
  const site = siteName();
  const fWhy = !hasSite(d) ? 'Not a Fanbox or Patreon creator'
    : r.f === 'locked' ? (d.service === 'patreon' ? `Needs a tier you do not have${d.session === 'valid' ? '' : ' (signed out)'}`
      : d.plan_fee == null ? `Needs ¥${r.fee} (signed out)` : `Needs ¥${r.fee}; your plan is ¥${d.plan_fee}`)
    : r.f === 'gone' ? `Deleted on ${site}` : r.f === 'unknown' ? `${site} not checked yet` : '';
  return `<div class="menu-body">
    <button type="button" class="mi two" role="menuitem" data-act="from-pawchive" ${pWhy ? 'aria-disabled="true"' : ''}><span class="ico"><span class="sc p ${r.p} sc-sm">P</span></span><span class="lbl"><span><span class="t">Pawchive</span><span class="why">${pWhy || 'Paced at 1 request/s'}</span></span></span><span class="tail"></span></button>
    <button type="button" class="mi two" role="menuitem" data-act="from-fanbox" ${fWhy ? 'aria-disabled="true"' : ''}><span class="ico"><span class="sc f ${r.f === 'na' ? 'unknown' : r.f} sc-sm">${siteLetter()}</span></span><span class="lbl"><span><span class="t">${site}</span><span class="why">${fWhy || `Uses your ${site} session`}</span></span></span><span class="tail"></span></button>
  </div>`;
}

function creatorMenu() {
  const d = S.detail;
  const pref = d.config.source_preference || 'inherit';
  const fanbox = hasSite(d);
  return `<div class="menu-body">
    ${actionItem({ act: 'deep', label: 'Deep sync (re-read bodies)', icon: I.sync })}
    ${actionItem({ act: 'sync-p', label: 'Sync Pawchive only', icon: I.sync })}
    ${fanbox ? actionItem({ act: 'sync-f', label: `Sync ${siteName()} only`, icon: I.sync }) : ''}
    <div class="sep"></div>
    ${d.service === 'fanbox' ? actionItem({ act: 'adopt', label: 'Adopt a folder…', icon: I.folder }) : ''}
    ${actionItem({ act: 'relayout', label: 'Rename folders…', icon: I.move })}
    ${actionItem({ act: 'edit', label: 'Alias and group…', icon: I.edit })}
    <div class="sep"></div>
    <div class="menu-label"><span>Download source</span></div>
    ${radioItem({ key: 'inherit', label: 'Use the default', on: pref === 'inherit', attr: 'data-act="pref" data-pref' })}
    ${radioItem({ key: 'pawchive-first', label: 'Pawchive first', on: pref === 'pawchive-first', attr: 'data-act="pref" data-pref' })}
    ${radioItem({ key: 'fanbox-first', label: `${siteName()} first`, on: pref === 'fanbox-first', attr: 'data-act="pref" data-pref' })}
    <div class="sep"></div>
    ${actionItem({ act: 'ignore', label: d.ignore ? 'Stop ignoring' : 'Ignore this creator', icon: I.eye })}
    ${actionItem({ act: 'complete', label: d.completed ? 'Mark as ongoing' : 'Mark as completed', icon: I.check })}
    ${actionItem({ act: 'remove', label: 'Remove…', icon: I.trash, danger: true })}
  </div>`;
}

function sortMenu() {
  return `<div class="menu-body">${Object.entries(SORTS).map(([key, [, l]]) => radioItem({ key, label: l, on: sort === key, attr: 'data-sort' })).join('')}</div>`;
}

// ---------------------------------------------------------------- a post's detail

function fileCell(f, r) {
  const p = f.present_p ? 'full' : f.has_p ? (r.p === 'gone' ? 'gone' : 'meta') : 'none';
  const fs = r.f === 'na' ? 'na' : f.present_f ? 'open' : r.f === 'locked' ? 'locked' : r.f === 'gone' ? 'gone' : f.has_f ? 'locked' : 'none';
  return cells(p, fs);
}

// A file Pawchive 404ed that the own site cannot stand in for: no run asks for it again.
const fileBlocked = (f, r) => f.state !== 'done' && f.misses != null && r.f !== 'open';

function fileState(f, r) {
  if (f.state === 'done') return '<span class="chip k-done">Done</span>';
  if (fileBlocked(f, r)) return '<span class="chip k-blocked" title="Pawchive answered 404; only a download by hand asks again">Blocked</span>';
  if (f.state === 'failed') return '<span class="chip k-failed">Failed</span>';
  return '<span class="chip k-pending">Pending</span>';
}

function filesHTML(d, r) {
  const files = d.files || [];
  if (!files.length) {
    return `<div class="note">${r.f === 'locked' && r.p !== 'full' ? `File list unknown: not subscribed on ${siteName()}, and Pawchive has no list for this post.` : 'This post has no files.'}</div>`;
  }
  const roles = { cover: 'Cover', image: 'Image', file: 'File' };
  const vt = (f) => (f.verified === 1 ? '<span class="tick" title="Matches the source">✓</span>' : f.verified === 0 ? '<span class="cross">Mismatch</span>' : f.state === 'done' ? '<span class="muted">Unchecked</span>' : '—');
  const dims = (f) => [f.width && f.height ? `${f.width}×${f.height}` : '', f.size ? fmtSize(f.size) : f.local_size ? fmtSize(f.local_size) : ''].filter(Boolean).join(' · ') || '—';
  // One shared error is said once above the table, not under every file.
  const errs = files.filter((f) => f.error && f.state !== 'done');
  const shared = errs.length > 1 && errs.every((f) => f.error === errs[0].error) ? errs[0].error : '';
  const cols = `<col style="width:24%"><col style="width:64px">${showKeys ? '<col style="width:22%">' : ''}<col style="width:62px"><col style="width:96px"><col><col style="width:128px"><col style="width:80px">`;
  return `<section class="pd-files">
    <div class="pd-files-head"><span>Files (${files.length})</span><button type="button" class="linkbtn" data-keys aria-pressed="${showKeys}">${showKeys ? 'Hide' : 'Show'} match keys</button></div>
    ${shared ? `<div class="note bad">${plural(errs.length, 'file')}: ${esc(shared)}</div>` : ''}
    <div class="ftable"><table><colgroup>${cols}</colgroup>
      <thead><tr><th>Local name</th><th>Role</th>${showKeys ? '<th>Match key</th>' : ''}<th>Source</th><th>Status</th><th>Got from</th><th>Size</th><th>Check</th></tr></thead><tbody>
      ${files.map((f) => `<tr><td class="clip" title="${esc(f.local_name)} · ${esc(f.key)}"><span class="mono">${esc(f.local_name)}</span>${f.error && f.state !== 'done' && !shared ? `<span class="ferr">${esc(f.error)}</span>` : ''}</td><td>${roles[f.role] || f.role}</td>${showKeys ? `<td class="key" title="${esc(f.key)}">${esc(f.key)}</td>` : ''}<td>${fileCell(f, r)}</td><td>${fileState(f, r)}</td><td>${f.via ? viaHTML([f.via]) : '<span class="via">—</span>'}</td><td class="num" title="${dims(f)}">${dims(f)}</td><td>${vt(f)}</td></tr>`).join('')}
    </tbody></table></div></section>`;
}

// Everything below a post's title; the same in the pane, an opened row and the drawer.
function detailBody(r) {
  const d = S.details.get(r.id);
  if (!d) return '<div class="loading">Loading…</div>';
  const u = at(d.published), j = at(d.published, 540), l = at(d.published, localOffset());
  const fanbox = hasSite(S.detail);
  const site = siteName();
  const obs = d.obs || {};
  const src = (key, label, letter, cls) => {
    const o = obs[key];
    const states = { full: 'Has files', meta: 'Metadata only', gone: 'Gone', open: 'Accessible', locked: 'Not subscribed' };
    const state = o ? `${states[o.state] || o.state}${o.gone_since ? ` since ${o.gone_since.slice(0, 10)}` : ''}` : key === 'pawchive' ? 'Not listed' : 'Not checked';
    const seen = o ? `first seen ${o.first_seen.slice(0, 10)} · last ${o.last_seen.slice(0, 10)}${key === 'fanbox' ? ` · body ${o.detail_at ? o.detail_at.slice(0, 10) : 'not read'}` : ''}` : '';
    return `<div><span class="sc ${cls} sc-sm">${letter}</span><b>${label}</b><span>${state}${seen ? ` <small>· ${seen}</small>` : ''}</span></div>`;
  };
  const notes = [];
  if (d.mismatch && obs.pawchive && obs.fanbox) notes.push(`The two sources disagree on the publish time (Pawchive ${obs.pawchive.published}, ${site} ${obs.fanbox.published} UTC); ${site}'s is used.`);
  if (r.p === 'gone') notes.push(`Pawchive listed this post until ${(obs.pawchive?.gone_since || '').slice(0, 10)}.`);
  if (r.f === 'gone') notes.push(`Deleted on ${site}.` + (r.head.k === 'done' ? ' The local copy may be the only one left.' : ''));
  if (d.stale) notes.push(`${site} updated this post (${(d.edited || '').slice(0, 10)}) after it was downloaded. The file count is unchanged; use ⋯ → Download again if needed.`);
  if (r.head.k === 'blocked') notes.push(`Pawchive answered 404 for the missing files and ${site} cannot deliver them, so no run asks again by itself. Download this post by hand to try once more.`);
  if (r.origin === 'adopted') notes.push(r.total ? 'This folder was adopted from the extension\'s layout.' : 'Adopted without a file list from either source, so its files are unchecked.');
  if (r.origin === 'manual') notes.push('Marked as done by hand.');
  if (r.head.k === 'done' && r.cover && r.cover !== 'done') notes.push('The cover is missing; it does not hold the post open.');
  if (r.head.k === 'done' && r.text === false) notes.push('The text (content.txt) has not been saved.');
  if (r.links) notes.push(`The text has ${r.links} cloud-storage link${r.links === 1 ? '' : 's'}${r.links_new ? `, ${r.links_new} new` : ''}; they are listed under Links.`);
  const planNote = S.detail.service === 'patreon' ? (r.sub === 'yes' ? 'Patreon opens it to you' : r.sub === 'no' ? 'Not in your tiers' : '')
    : fanbox ? (S.detail.plan_fee == null ? 'Not signed in to Fanbox' : S.detail.plan_fee ? `Your plan: ¥${S.detail.plan_fee}` : r.sub === 'yes' ? 'No current plan; still open (paid month not over)' : 'You do not support this creator') : '';
  return `<div class="pd-top">
      <a class="cover-big" href="${thumbURL(r.id)}" target="_blank" rel="noreferrer" title="Open the cover">${thumbImg(r.id, 'thumb big')}</a>
      <dl class="kv">
        <dt>Published</dt><dd><span class="mono">${u ? `${u.date} ${u.time}` : '—'} UTC</span><small class="mono">JST ${j ? `${j.date} ${j.time}` : '—'} · local ${l ? l.date : '—'}</small></dd>
        <dt>Fee / plan</dt><dd>${r.fee ? money(r.fee) : 'Free'}${fanbox && r.fee ? ` · ${{ yes: 'open to you', no: 'locked', unknown: 'signed out' }[r.sub] || ''}` : ''}${planNote ? `<small>${planNote}</small>` : ''}</dd>
        <dt>Selection</dt><dd>${r.filtered ? 'Filtered out' : 'Included'}<small>${esc(r.filtered || 'No filter rule matches')}</small></dd>
        <dt>Folder</dt><dd><span class="mono clip" title="${esc(d.dir)}">${esc(d.dir.split(/[\\/]/).pop())}</span><small>${d.dir_exists ? 'Exists' : 'Not created yet'}${d.done_at ? ` · done ${d.done_at.slice(0, 10)}` : ''}</small></dd>
      </dl>
    </div>
    <div class="pd-src">${src('pawchive', 'Pawchive', 'P', `p ${r.p}`)}${fanbox ? src('fanbox', site, siteLetter(), `f ${r.f === 'na' ? 'unknown' : r.f}`) : ''}</div>
    ${notes.map((n) => `<div class="note">${esc(n)}</div>`).join('')}
    ${filesHTML(d, r)}
    ${d.content ? `<details class="content"><summary>Text</summary><div class="content-box">${esc(d.content.replace(/<[^>]+>/g, ' '))}</div></details>` : ''}`;
}

function postActions(r) {
  return `<button class="btn sm ${WORK.has(r.head.k) || r.head.k === 'blocked' ? 'primary' : ''}" type="button" data-ract="download" data-id="${r.id}" title="${r.head.k === 'blocked' ? 'Asks Pawchive again for the files it answered 404 for' : ''}">${I.dl}${r.head.k === 'done' ? 'Fetch missing' : 'Download'}</button>
    <button class="btn sm" type="button" data-ract="open" data-id="${r.id}">${I.folder}Open folder</button>
    ${sitesFor(r.id, r).filter((s) => s.url).map((s) => `<a class="btn sm ghost" href="${esc(s.url)}" target="_blank" rel="noreferrer" title="Open this post on ${s.label}">${I.ext}${s.label}</a>`).join('')}`;
}

// The post as the side pane and the drawer show it: title, state, actions, detail.
function postHTML(r) {
  const h = r.head;
  return `<div class="pd" data-key="pd:${esc(r.id)}">
    <div class="pd-head">
      <h2>${esc(r.title || '(untitled)')}</h2>
      <div class="dd"><button type="button" class="btn icon sm" data-rmenu="${r.id}" aria-label="Post actions" aria-haspopup="true" aria-expanded="false">${I.dots}</button></div>
      <div class="pd-sub"><button type="button" class="idcopy mono" data-copy="${esc(r.id)}" title="Copy the post id">${esc(r.id)}${I.copy}</button>${statusChip(h)}${h.progress != null ? `<span class="mini-bar"><i style="width:${(h.progress * 100).toFixed(0)}%"></i></span>` : ''}${h.why ? `<span>${esc(h.why)}</span>` : ''}</div>
    </div>
    <div class="pd-acts">${postActions(r)}</div>
    ${detailBody(r)}
  </div>`;
}

function paneHTML() {
  const r = S.sel && row(S.sel);
  if (!r) {
    return S.rows.length
      ? emptyState({ icon: I.list, title: S.list.length ? 'Select a post' : 'No post to show', hint: S.list.length ? 'Its files, sources and folder show here. <kbd>j</kbd> <kbd>k</kbd> move, <kbd>x</kbd> selects, <kbd>d</kbd> downloads, <kbd>o</kbd> opens its folder.' : 'No post matches the filters on the left.' })
      : emptyState({ icon: I.sync, title: 'No posts yet', hint: 'Sync reads the post lists of Pawchive and the creator\'s own site.', action: '<button class="btn sm primary" type="button" data-cact="sync">Sync now</button>' });
  }
  return postHTML(r);
}

// ---------------------------------------------------------------- rows and cards

function rowHTML(r) {
  const open = !S.split && S.open.has(r.id);
  const pick = S.picked.has(r.id);
  const h = r.head;
  const u = at(r.published);
  const fanbox = hasSite(S.detail);
  return `<div class="row ${open ? 'open' : ''} ${pick ? 'sel' : ''} ${r.id === S.sel ? 'cur' : ''}">
    <div class="row-main" data-toggle="${r.id}" aria-expanded="${open}">
      <button type="button" class="rowcb c-cb" data-pick="${r.id}" aria-label="Select"><span class="cb ${pick ? 'on' : ''}"></span></button>
      <span class="c-thumb">${showThumbs ? thumbImg(r.id, 'thumb') : ''}</span>
      <div class="ttl"><span class="t" title="${esc(r.title)}">${esc(r.title || '(untitled)')}</span>
        <span class="m"><span class="mono">${r.id}</span><span class="tz mono" title="${tzTitle(r.published)}">${u ? u.date : '—'}</span>${r.total ? `<span>${plural(r.total, 'file')}</span>` : ''}${r.mismatch ? '<span class="warn" title="The two sources disagree on the publish time">time differs</span>' : ''}</span></div>
      <span class="c-src">${cells(r.p, r.f)}</span>
      <span class="c-sub">${fanbox ? planCell(r) : '<span class="sub free">—</span>'}</span>
      <span class="c-stat stat">${statusChip(h)}${h.progress != null ? `<span class="mini-bar"><i style="width:${(h.progress * 100).toFixed(0)}%"></i></span>` : ''}${h.why ? `<span class="why" title="${esc(h.why)}">${esc(h.why)}</span>` : ''}</span>
      <span class="c-kb"><div class="dd"><button type="button" class="kebab" data-rmenu="${r.id}" aria-label="Post actions" aria-haspopup="true" aria-expanded="false">${I.dots}</button></div></span>
    </div>
    ${open ? `<div class="detail"><div class="pd"><div class="pd-acts">${postActions(r)}</div>${detailBody(r)}</div></div>` : ''}
  </div>`;
}

function cardHTML(r) {
  const h = r.head;
  const u = at(r.published);
  const pick = S.picked.has(r.id);
  const fanbox = hasSite(S.detail);
  const cur = S.split ? r.id === S.sel : S.drawer === r.id;
  return `<article class="card ${pick ? 'sel' : ''} ${cur ? 'cur' : ''}" data-card="${r.id}">
    <div class="card-cover">
      ${thumbImg(r.id, 'thumb card-img')}
      <button type="button" class="rowcb card-cb" data-pick="${r.id}" aria-label="Select"><span class="cb ${pick ? 'on' : ''}"></span></button>
      <span class="card-src">${cells(r.p, r.f)}</span>
    </div>
    <div class="card-body">
      <div class="card-title" title="${esc(r.title)}">${esc(r.title || '(untitled)')}</div>
      <div class="card-meta"><span class="mono" title="${tzTitle(r.published)}">${u ? u.date : '—'}</span>${r.total ? `<span>${plural(r.total, 'file')}</span>` : ''}${fanbox ? planCell(r) : ''}</div>
      <div class="card-foot">
        <span class="chip k-${h.k}" title="${esc(h.why || '')}">${esc(h.t)}</span>
        <span class="why" title="${esc(h.why || '')}">${esc(h.why || '')}</span>
        <div class="dd"><button type="button" class="kebab" data-rmenu="${r.id}" aria-label="Post actions" aria-haspopup="true" aria-expanded="false">${I.dots}</button></div>
      </div>
    </div>
    ${h.progress != null ? `<span class="card-progress"><i style="width:${(h.progress * 100).toFixed(0)}%"></i></span>` : ''}
  </article>`;
}

const dims = () => ['cov', 'st', ...(hasSite(S.detail) ? ['sub'] : []), 'via'];

// ---------------------------------------------------------------- drawing

// The frame is built once per creator (and again when the layout switches between split
// and single column); every part inside it is patched from then on.
function build() {
  const listW = Number(prefs.get('listW')) || LIST_DEFAULT;
  S.el.classList.toggle('panes', S.split);
  S.el.innerHTML = `<div class="cv ${S.split ? 'split' : ''} ${showThumbs && layout === 'list' ? 'with-thumbs' : ''} ${S.detail.service === 'patreon' ? 'site-patreon' : ''}" style="--list-w:${listW}px">
    <div data-head></div>
    <div class="toolbar">
      <label class="field search" for="psearch">${I.search}<input id="psearch" placeholder="Title, post id or link" value="${esc(S.q)}" autocomplete="off" title="Search (/)"></label>
      ${dims().map((dim) => `<div class="dd"><button type="button" class="dd-trigger" data-filter="${dim}" aria-haspopup="true" aria-expanded="false">${FILTERS[dim].label}<span class="val"></span>${I.chev}</button></div>`).join('')}
      <span class="spacer"></span>
      <button type="button" class="dd-trigger toggle" data-thumbs title="Show post covers in the list">Covers<span class="val"></span></button>
      <div class="seg layout" role="group" aria-label="Layout">
        <button type="button" data-layout="list" title="List">${I.list}</button>
        <button type="button" data-layout="grid" title="Grid">${I.grid}</button>
      </div>
      <div class="dd"><button type="button" class="dd-trigger" data-sortmenu aria-haspopup="true" aria-expanded="false">Sort<span class="val"></span>${I.chev}</button></div>
    </div>
    <div class="cv-body">
      <div class="cv-list" data-list>
        <div data-chips></div>
        <div data-lhead></div>
        <div data-rows></div>
        <div data-more></div>
        <div data-bulk></div>
      </div>
      <div class="cv-split" data-splitter title="Drag to resize; double-click to reset" aria-hidden="true"></div>
      <aside class="cv-pane" data-pane aria-label="Post"></aside>
    </div>
  </div>`;
  const root = S.el.firstElementChild;
  S.dom = {
    root,
    head: root.querySelector('[data-head]'),
    list: root.querySelector('[data-list]'),
    chips: root.querySelector('[data-chips]'),
    lhead: root.querySelector('[data-lhead]'),
    rows: root.querySelector('[data-rows]'),
    more: root.querySelector('[data-more]'),
    bulk: root.querySelector('[data-bulk]'),
    pane: root.querySelector('[data-pane]'),
  };
  root.querySelector('#psearch').addEventListener('input', (e) => {
    S.q = e.target.value;
    S.limit = PAGE;
    renderList();
  });
  mountSplitter(root.querySelector('[data-splitter]'));
  renderHead();
  syncToolbar();
  renderList();
  renderPane();
}

function renderHead() {
  patch(S.dom.head, header());
}

function syncToolbar() {
  const root = S.dom.root;
  for (const dim of dims()) {
    const b = root.querySelector(`[data-filter="${dim}"]`);
    b.classList.toggle('active', sel[dim].size > 0);
    b.querySelector('.val').textContent = summary(dim);
  }
  root.querySelector('[data-sortmenu] .val').textContent = SORTS[sort][0];
  const tb = root.querySelector('[data-thumbs]');
  tb.hidden = layout === 'grid';
  tb.setAttribute('aria-pressed', String(showThumbs));
  tb.querySelector('.val').textContent = showThumbs ? 'On' : 'Off';
  root.querySelectorAll('[data-layout]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layout === layout)));
  root.classList.toggle('with-thumbs', showThumbs && layout === 'list');
}

function renderList() {
  if (!S?.dom) return;
  const list = visible().sort(SORTS[sort][2]);
  S.list = list;
  const fanbox = hasSite(S.detail);
  const chips = [];
  for (const dim of Object.keys(FILTERS)) {
    for (const g of FILTERS[dim].groups) {
      for (const [v, l] of g.opts) {
        const key = okey(g, v);
        if (sel[dim].has(key)) chips.push(`<span class="fchip" data-key="${key}"><b>${sited(g.label || FILTERS[dim].label)}</b>${sited(l)}<button type="button" aria-label="Remove ${l}" data-unchip="${dim}|${key}">${I.x}</button></span>`);
      }
    }
  }
  const allPicked = list.length && list.every((r) => S.picked.has(r.id));
  const somePicked = !allPicked && list.some((r) => S.picked.has(r.id));
  const cb = `<button type="button" class="rowcb c-cb" data-pickall aria-label="Select all shown" title="Select all ${list.length.toLocaleString()} matching posts"><span class="cb ${allPicked ? 'on' : somePicked ? 'some' : ''}"></span></button>`;
  patch(S.dom.chips, chips.length || S.q
    ? `<div class="chips">${chips.join('')}<button type="button" class="linkbtn" data-clearall>Clear all</button><span class="count num">${list.length.toLocaleString()} of ${S.rows.length.toLocaleString()}</span></div>`
    : '');
  patch(S.dom.lhead, !list.length ? '' : layout === 'list'
    ? `<div class="grid-head">${cb}<span class="c-thumb">Cover</span><span>Post</span><span>Source</span><span class="c-sub">${fanbox ? 'Fee' : ''}</span><span>Local status</span><span></span></div>`
    : `<div class="cards-head">${cb}<span>Select all ${list.length.toLocaleString()} matching</span></div>`);
  const rowsEl = S.dom.rows;
  const cls = list.length ? (layout === 'list' ? 'rows' : 'cards') : '';
  if (rowsEl.className !== cls) { rowsEl.className = cls; rowsEl.replaceChildren(); }
  const shown = list.slice(0, S.limit);
  patchRows(rowsEl, shown.length
    ? shown.map((r) => ({ key: r.id, html: layout === 'list' ? rowHTML(r) : cardHTML(r) }))
    : [{ key: '#empty', html: `<div class="empty">${S.rows.length
      ? emptyState({ icon: I.search, title: 'No posts match', hint: `None of the ${S.rows.length.toLocaleString()} posts passes the search and filters.`, action: anyFilter() ? '<button type="button" class="btn sm" data-clearall>Clear filters</button>' : '' })
      : emptyState({ icon: I.sync, title: 'No posts yet', hint: 'Sync reads the post lists of Pawchive and the creator\'s own site.', action: '<button class="btn sm primary" type="button" data-cact="sync">Sync now</button>' })}</div>` }]);
  patch(S.dom.more, list.length > S.limit
    ? `<div class="more">Showing ${S.limit.toLocaleString()} of ${list.length.toLocaleString()}<button class="btn sm" type="button" data-more>Show ${Math.min(PAGE, list.length - S.limit)} more</button><button class="linkbtn" type="button" data-all>Show all</button></div>`
    : '');
  patch(S.dom.bulk, S.picked.size
    ? `<div class="bulk"><span><b class="num">${S.picked.size.toLocaleString()}</b> selected</span><span class="spacer"></span>
      <button class="btn" type="button" data-bulk="download">${I.dl}Download</button>
      ${fanbox ? `<button class="btn" type="button" data-bulk="from-fanbox">${I.dl}From ${siteName()}</button>` : ''}
      <button class="btn" type="button" data-bulk="done">${I.check}Mark done</button>
      <button class="btn" type="button" data-bulk="undone">${I.reset}Mark not done</button>
      <button class="btn" type="button" data-unpick>Deselect</button></div>`
    : '');
  // The chosen post stays chosen while it is shown; a list without it moves to the first.
  if (S.split && (!S.sel || !list.some((r) => r.id === S.sel)) && list.length) select(list[0].id, { scroll: false });
}

function renderPane() {
  if (!S.split) return;
  patch(S.dom.pane, paneHTML());
}

// Marks the chosen post without redrawing the list: its row and the one before change.
function markCur(id, on) {
  if (!id) return;
  S.dom.rows.querySelector(`:scope > [data-key="${CSS.escape(id)}"]`)?.classList.toggle('cur', on);
}

function select(id, { scroll = true } = {}) {
  if (S.sel === id) return;
  const prev = S.sel;
  S.sel = id;
  markCur(prev, false);
  markCur(id, true);
  syncUrl();
  if (S.split) {
    S.dom.pane.scrollTop = 0;
    renderPane();
    // Moving fast with j/k fetches only where it stops.
    clearTimeout(S.detailTimer);
    if (!S.details.has(id)) S.detailTimer = setTimeout(() => loadDetail(id), 90);
  }
  if (scroll) reveal(id);
}

function reveal(id) {
  const i = S.list.findIndex((r) => r.id === id);
  if (i >= S.limit) { S.limit = Math.ceil((i + 1) / PAGE) * PAGE; renderList(); }
  S.dom.rows.querySelector(`:scope > [data-key="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

function step(by) {
  if (!S.list.length) return;
  const at0 = S.list.findIndex((r) => r.id === (S.drawer || S.sel));
  const next = S.list[Math.max(0, Math.min(S.list.length - 1, at0 < 0 ? 0 : at0 + by))];
  if (S.drawer) { S.drawer = next.id; markDrawerCard(); renderDrawer(); loadDetail(next.id); }
  select(next.id);
}

// ---------------------------------------------------------------- drawer (narrow grid)

let drawerEl = null;
function markDrawerCard() {
  S.dom.rows.querySelectorAll(':scope > .card.cur').forEach((c) => c.classList.remove('cur'));
  if (S.drawer) S.dom.rows.querySelector(`:scope > [data-key="${CSS.escape(S.drawer)}"]`)?.classList.add('cur');
}

function renderDrawer() {
  if (!S || !S.drawer || S.split) {
    drawerEl?.remove();
    drawerEl = null;
    return;
  }
  const r = row(S.drawer);
  if (!r) { S.drawer = null; return renderDrawer(); }
  if (!drawerEl) {
    drawerEl = document.createElement('div');
    drawerEl.className = 'drawer-wrap';
    drawerEl.innerHTML = `<aside class="drawer" role="dialog" aria-label="Post"><header class="drawer-head"><button type="button" class="btn icon sm" data-close aria-label="Close" title="Close (Esc)">${I.close}</button></header><div class="drawer-body"></div></aside>`;
    drawerEl.addEventListener('click', (e) => {
      if (e.target === drawerEl || e.target.closest('[data-close]')) return closeDrawer();
      onClick(e);
    });
    document.body.appendChild(drawerEl);
  }
  drawerEl.classList.toggle('site-patreon', S.detail.service === 'patreon');
  patch(drawerEl.querySelector('.drawer-body'), postHTML(r));
}

function openDrawer(id) {
  S.drawer = id;
  markDrawerCard();
  renderDrawer();
  loadDetail(id);
}

function closeDrawer() {
  if (!S) return;
  S.drawer = null;
  markDrawerCard();
  renderDrawer();
}

// ---------------------------------------------------------------- the split's divider

function mountSplitter(handle) {
  const setW = (w) => S.dom.root.style.setProperty('--list-w', `${w}px`);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('on');
    const body = handle.parentElement.getBoundingClientRect();
    let width = S.dom.list.getBoundingClientRect().width;
    const move = (ev) => {
      width = Math.round(Math.max(LIST_MIN, Math.min(body.width - PANE_MIN, ev.clientX - body.left)));
      setW(width);
    };
    const up = () => {
      handle.classList.remove('on');
      handle.removeEventListener('pointermove', move);
      prefs.set('listW', String(width));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('dblclick', () => { setW(LIST_DEFAULT); prefs.set('listW', String(LIST_DEFAULT)); });
}

// ---------------------------------------------------------------- address

// The filters, the sort and the chosen post live in the address, so a reload or a shared
// link shows the same view. Updated in place: it is not a step to go back to.
function syncUrl() {
  if (!S) return;
  const q = new URLSearchParams();
  const f = Object.values(sel).flatMap((s) => [...s]);
  if (f.length) q.set('f', f.join(','));
  if (sort !== 'new') q.set('sort', sort);
  if (S.sel) q.set('post', S.sel);
  const hash = `#/c/${encodeURIComponent(S.cid)}${[...q.keys()].length ? `?${q}` : ''}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function filtersFrom(params) {
  if (!params.has('f') && !params.has('sort')) return false;
  Object.values(sel).forEach((s) => s.clear());
  for (const key of (params.get('f') || '').split(',').filter(Boolean)) {
    const dim = GROUP_DIM[key.split(':')[0]];
    if (dim) sel[dim].add(key);
  }
  sort = SORTS[params.get('sort')] ? params.get('sort') : 'new';
  return true;
}

function applyRoute(params) {
  filtersFrom(params);
  const post = params.get('post');
  if (post && S.byId.has(post)) {
    // A link to one post shows it even when the filters would hide it.
    if (!visible().some((r) => r.id === post)) clearFilters();
    S.limit = PAGE;
    if (!S.split) { S.open.add(post); loadDetail(post); }
  }
  syncToolbar();
  renderList();
  if (post && S.byId.has(post)) {
    const before = S.sel;
    select(post, { scroll: false });
    if (before === post && S.split) renderPane();
    requestAnimationFrame(() => reveal(post));
  } else syncUrl();
}

// ---------------------------------------------------------------- actions

async function postAction(ids, action, source) {
  const out = await attempt(() => api(`creators/${S.cid}/posts/action`, { method: 'POST', body: { post_ids: ids, action, source } }));
  if (!out) return;
  if (out.job) toast(`Queued as job #${out.job}`);
  else { toast('Updated'); await reload(); }
}

async function creatorAction(act, el) {
  const d = S.detail;
  const job = (kind, params = {}) => attempt(() => api('jobs', { method: 'POST', body: { kind, creator_id: S.cid, params } }), 'Queued');
  if (act === 'sync') return job('sync');
  if (act === 'deep') return job('sync', { deep: true });
  if (act === 'sync-p') return job('sync', { sources: ['pawchive'] });
  if (act === 'sync-f') return job('sync', { sources: ['fanbox'] });
  if (act === 'download') return job('download');
  if (act === 'adopt') { location.hash = `#/migrate/${S.cid}?kind=adopt`; return; }
  if (act === 'relayout') { location.hash = `#/migrate/${S.cid}?kind=relayout`; return; }
  const change = async (body) => { await attempt(() => api(`creators/${S.cid}`, { method: 'PATCH', body }), 'Saved'); await reload(); S?.onChange?.(); };
  if (act === 'pref') return change({ preference: el.dataset.pref });
  if (act === 'ignore') return change({ ignore: !d.ignore });
  if (act === 'complete') return change({ completed: !d.completed });
  if (act === 'edit') {
    const groups = allGroups(await api('creators').catch(() => []));
    const v = await dialog({ title: 'Alias and group', confirm: 'Save', body: `<p>Both name the creator's folder, which moves to match:</p><div class="move-path"><span class="mono">${esc(d.dir)}</span></div>`, fields: [
      { name: 'alias', label: 'Alias', value: d.alias, placeholder: d.name },
      { name: 'group', label: 'Group', value: d.group, hint: 'Levels separated by /, e.g. 絵師/ロリメイン/T0. You can also drag the creator onto a group in the sidebar.', options: groups },
    ] });
    if (!v) return;
    const out = await attempt(() => api(`creators/${S.cid}`, { method: 'PATCH', body: v }));
    if (out) toast(out.job ? 'Moving the folder; this page updates when it is done' : 'Nothing changed');
    return;
  }
  if (act === 'remove') {
    const v = await dialog({ title: `Remove ${d.alias || d.name}?`, danger: true, confirm: 'Remove', body: 'Only the records go (posts, file states, observations). Files on disk stay, and adding the creator again re-syncs it.' });
    if (!v) return;
    await attempt(() => api(`creators/${S.cid}`, { method: 'DELETE' }), 'Removed');
    S.onChange?.();
    location.hash = '#/';
  }
}

async function rowAction(act, r) {
  if (!r) return;
  if (act === 'download') return postAction([r.id], 'download');
  if (act === 'from-pawchive') return postAction([r.id], 'download', 'pawchive');
  if (act === 'from-fanbox') return postAction([r.id], 'download', 'fanbox');
  if (act === 'redownload') {
    const v = await dialog({ title: 'Download this post again?', confirm: 'Download again', body: 'Every file is fetched again. Files that came back different replace the local ones; under "Keep both" (Settings → Downloads) the folder as it was is copied aside first.' });
    if (v) return postAction([r.id], 'redownload');
    return;
  }
  if (act === 'resync') return postAction([r.id], 'resync');
  if (act === 'done') return postAction([r.id], 'mark_done');
  if (act === 'undone') return postAction([r.id], 'mark_undone');
  if (act === 'copy') return copyText(r.id, 'Post id copied');
  if (act === 'open') {
    const d = S.details.get(r.id) || await api(`creators/${S.cid}/posts/${r.id}`);
    return openPath(d.dir);
  }
}

async function openPath(path) {
  const out = await attempt(() => api('open', { method: 'POST', body: { path } }));
  if (out && !out.exact) toast('That folder does not exist yet; opened the nearest parent');
}

// Fetches one post's detail and redraws only the places that show it.
async function loadDetail(id) {
  const s = S;
  try {
    const d = await api(`creators/${s.cid}/posts/${id}`);
    if (S !== s) return;
    s.details.set(id, d);
  } catch (e) {
    if (S !== s) return;
    toast(e.message, true);
    s.open.delete(id);
  }
  if (S.split && S.sel === id) renderPane();
  if (!S.split && S.open.has(id)) renderList();
  if (S.drawer === id) renderDrawer();
}

function toggleOpen(id) {
  const prev = S.sel;
  S.sel = id;
  markCur(prev, false);
  if (S.open.has(id)) S.open.delete(id);
  else { S.open.add(id); if (!S.details.has(id)) loadDetail(id); }
  renderList();
  syncUrl();
}

function setFilter(dim, change) {
  change(sel[dim]);
  S.limit = PAGE;
  renderList();
  syncToolbar();
  syncUrl();
}

function onClick(e) {
  if (!S) return;
  const t = e.target;
  const btn = t.closest('button, a');
  const filterBtn = t.closest('[data-filter]');
  if (filterBtn) {
    const dim = filterBtn.dataset.filter;
    if (menuOpenFor(filterBtn)) return closeMenu();
    openMenu(filterBtn, {
      keyboard: e.detail === 0,
      build: () => filterMenu(dim),
      onPick: (mi, ev) => {
        const only = ev.target.closest('[data-only]');
        setFilter(dim, (s) => {
          if (only) { s.clear(); s.add(only.dataset.only); }
          else if (mi.dataset.clear !== undefined) s.clear();
          else if (mi.dataset.opt) { if (s.has(mi.dataset.opt)) s.delete(mi.dataset.opt); else s.add(mi.dataset.opt); }
        });
        return 'keep';
      },
    });
    return;
  }
  const lay = t.closest('[data-layout]');
  if (lay) {
    if (layout === lay.dataset.layout) return;
    layout = lay.dataset.layout;
    prefs.set('postLayout', layout);
    closeDrawer();
    syncToolbar();
    return renderList();
  }
  if (t.closest('[data-thumbs]')) {
    showThumbs = !showThumbs;
    prefs.set('thumbs', showThumbs ? 'on' : 'off');
    syncToolbar();
    return renderList();
  }
  if (t.closest('[data-keys]')) {
    showKeys = !showKeys;
    renderPane();
    renderDrawer();
    if (!S.split) renderList();
    return;
  }
  if (t.closest('[data-sortmenu]')) {
    const b = t.closest('[data-sortmenu]');
    if (menuOpenFor(b)) return closeMenu();
    openMenu(b, { className: 'mini right', keyboard: e.detail === 0, build: sortMenu, onPick: (mi) => { if (mi.dataset.sort) { sort = mi.dataset.sort; renderList(); syncToolbar(); syncUrl(); } } });
    return;
  }
  if (t.closest('[data-cmenu]')) {
    const b = t.closest('[data-cmenu]');
    if (menuOpenFor(b)) return closeMenu();
    openMenu(b, { className: 'mini right', keyboard: e.detail === 0, build: creatorMenu, onPick: (mi) => { setTimeout(() => creatorAction(mi.dataset.act, mi)); } });
    return;
  }
  const rm = t.closest('[data-rmenu]');
  if (rm) {
    const r = row(rm.dataset.rmenu);
    if (menuOpenFor(rm)) return closeMenu();
    openMenu(rm, { className: 'mini right', keyboard: e.detail === 0, build: () => rowMenu(r), sub: () => sourceSub(r), onPick: (mi) => { setTimeout(() => rowAction(mi.dataset.act, r)); } });
    return;
  }
  const cact = t.closest('[data-cact]');
  if (cact) return creatorAction(cact.dataset.cact);
  const ract = t.closest('[data-ract]');
  if (ract) return rowAction(ract.dataset.ract, row(ract.dataset.id));
  const copy = t.closest('[data-copy]');
  if (copy) return copyText(copy.dataset.copy, 'Post id copied');
  const op = t.closest('[data-open]');
  if (op) return openPath(op.dataset.open);
  const pick = t.closest('[data-pick]');
  if (pick) {
    const id = pick.dataset.pick;
    if (S.picked.has(id)) S.picked.delete(id);
    else S.picked.add(id);
    return renderList();
  }
  if (t.closest('[data-pickall]')) {
    const all = S.list.every((r) => S.picked.has(r.id));
    S.list.forEach((r) => (all ? S.picked.delete(r.id) : S.picked.add(r.id)));
    return renderList();
  }
  if (t.closest('[data-unpick]')) { S.picked.clear(); return renderList(); }
  const bulk = t.closest('[data-bulk]');
  if (bulk) {
    const a = bulk.dataset.bulk;
    postAction([...S.picked], a === 'done' ? 'mark_done' : a === 'undone' ? 'mark_undone' : 'download', a === 'from-fanbox' ? 'fanbox' : undefined);
    return;
  }
  const un = t.closest('[data-unchip]');
  if (un) { const [dim, key] = un.dataset.unchip.split('|'); return setFilter(dim, (s) => s.delete(key)); }
  if (t.closest('[data-clearall]')) {
    clearFilters();
    S.limit = PAGE;
    renderList();
    syncToolbar();
    return syncUrl();
  }
  const cov = t.closest('[data-cov]');
  if (cov) return setFilter('cov', (s) => { s.clear(); s.add('c:' + cov.dataset.cov); });
  if (t.closest('[data-more]')) { S.limit += PAGE; return renderList(); }
  if (t.closest('[data-all]')) { S.limit = S.list.length; return renderList(); }
  const card = t.closest('[data-card]');
  if (card && !btn) return S.split ? select(card.dataset.card, { scroll: false }) : openDrawer(card.dataset.card);
  const tg = t.closest('[data-toggle]');
  if (tg && !btn) return S.split ? select(tg.dataset.toggle, { scroll: false }) : toggleOpen(tg.dataset.toggle);
}

function onKey(e) {
  if (!S || !shortcutAllowed(e)) return;
  // Enter on a focused button or link is that control's own click.
  if (e.key === 'Enter' && e.target.closest?.('button, a, summary')) return;
  const cur = S.drawer || S.sel;
  const act = {
    j: () => step(1),
    k: () => step(-1),
    // In one column the arrows keep scrolling the page.
    ArrowDown: S.split ? () => step(1) : null,
    ArrowUp: S.split ? () => step(-1) : null,
    x: () => { if (cur) { if (S.picked.has(cur)) S.picked.delete(cur); else S.picked.add(cur); renderList(); } },
    d: () => rowAction('download', row(cur)),
    o: () => rowAction('open', row(cur)),
    '/': () => S.dom.root.querySelector('#psearch')?.focus(),
    Enter: !S.split && cur ? () => (layout === 'grid' ? openDrawer(cur) : toggleOpen(cur)) : null,
  }[e.key];
  if (!act) {
    // An open menu takes the first Escape (it calls preventDefault); the drawer the next.
    if (e.key === 'Escape' && S.drawer) closeDrawer();
    return;
  }
  e.preventDefault();
  act();
}

// ---------------------------------------------------------------- loading

// Re-reads the creator and its posts and patches every part in. `details` also refreshes
// the posts whose detail is shown, after a job changed their files.
async function reload({ details = true } = {}) {
  const s = S;
  const seq = ++s.seq;
  const [detail, rows] = await Promise.all([api(`creators/${s.cid}`), api(`creators/${s.cid}/posts`)]);
  if (S !== s || seq !== s.seq) return;
  s.detail = detail;
  s.rows = rows;
  s.byId = new Map(rows.map((r) => [r.id, r]));
  if (details) {
    const shown = new Set([s.sel, s.drawer, ...s.open].filter(Boolean));
    for (const id of [...s.details.keys()]) if (!shown.has(id)) s.details.delete(id);
    shown.forEach((id) => loadDetail(id));
  }
  if (!s.dom) return;
  renderHead();
  syncToolbar();
  renderList();
  renderPane();
  renderDrawer();
}

// While one of this creator's jobs runs, the page re-reads its posts now and then, so
// progress shows without leaving; only rows that changed are rewritten.
function watchJobs(jobs) {
  if (!S) return;
  const busy = jobs.some((j) => isActive(j) && j.status === 'running' && j.creator_id === S.cid && ['download', 'sync', 'migration', 'link_fetch'].includes(j.kind));
  if (busy && !S.poll) {
    S.poll = setInterval(() => { reload({ details: false }).catch(() => {}); }, S.rows.length > 3000 ? 15000 : 5000);
  } else if (!busy && S.poll) {
    clearInterval(S.poll);
    S.poll = 0;
  }
}

export async function mountCreator(el, cid, params, onChange) {
  closeMenu();
  unmountCreator();
  const abort = new AbortController();
  S = {
    el, cid, q: '', open: new Set(), picked: new Set(), details: new Map(), rows: [], byId: new Map(), detail: null,
    limit: PAGE, list: [], abort, onChange, sel: null, drawer: null, split: el.clientWidth >= SPLIT_AT,
    dom: null, seq: 0, poll: 0, detailTimer: 0, noThumb: new Set(), observer: null, offJobs: null,
  };
  el.addEventListener('click', onClick, { signal: abort.signal });
  document.addEventListener('keydown', onKey, { signal: abort.signal });
  try {
    await reload({ details: false });
  } catch (e) {
    if (S?.cid === cid) el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  if (S?.cid !== cid) return;
  filtersFrom(params);
  build();
  applyRoute(params);
  S.offJobs = on('jobs', watchJobs);
  // Crossing the width at which the list and the detail split rebuilds the frame once.
  S.observer = new ResizeObserver(() => {
    if (!S?.dom) return;
    const split = el.clientWidth >= SPLIT_AT;
    if (split === S.split) return;
    S.split = split;
    closeDrawer();
    build();
    if (S.sel) {
      if (!split) { S.open.add(S.sel); if (!S.details.has(S.sel)) loadDetail(S.sel); renderList(); }
      else if (!S.details.has(S.sel)) loadDetail(S.sel);
      reveal(S.sel);
    }
  });
  S.observer.observe(el);
}

export function applyCreatorRoute(params) {
  if (S?.dom) applyRoute(params);
}

export function unmountCreator() {
  if (!S) return;
  S.abort.abort();
  S.observer?.disconnect();
  S.offJobs?.();
  clearInterval(S.poll);
  clearTimeout(S.detailTimer);
  S.el.classList.remove('panes');
  drawerEl?.remove();
  drawerEl = null;
  S = null;
}

// Called when a job for this creator finishes, so the page reflects it without a reload.
export function refreshCreator(cid) {
  if (S && S.cid === cid) reload().catch(() => {});
}

export const currentCreator = () => S?.cid;
