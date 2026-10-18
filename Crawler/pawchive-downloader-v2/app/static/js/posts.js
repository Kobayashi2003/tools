import { ago, api, at, attempt, esc, fmtSize, localOffset, toast } from './api.js';
import { dialog } from './dialog.js';
import { I } from './icons.js';
import * as L from './links.js';
import { actionItem, checkItem, closeMenu, linkItem, menuOpenFor, openMenu, radioItem } from './menu.js';
import { allGroups } from './regroup.js';

const P_LABEL = { full: 'Pawchive: has files', meta: 'Pawchive: metadata only', none: 'Pawchive: not listed', gone: 'Pawchive: gone' };
const F_LABEL = { open: 'Fanbox: accessible', locked: 'Fanbox: not subscribed', gone: 'Fanbox: deleted', unknown: 'Fanbox: not checked', na: '' };
const VIA = {
  pawchive: ['Pawchive', 'vp', 'P'], fanbox: ['Fanbox', 'vf', 'F'], adopted: ['Adopted', 'va', 'A'],
  v1: ['v1', 'va', 'v1'], local: ['On disk', 'va', 'D'], manual: ['Manual', 'va', 'M'],
};
const PAGE = 150;

// Within one group the options are OR-ed; separate groups (and dropdowns) are AND-ed.
const FILTERS = {
  cov: { label: 'Source', groups: [
    { id: 'c', label: 'Coverage', fn: (r, v) => r.cov === v, opts: [['both', 'On both'], ['ponly', 'Pawchive only'], ['fonly', 'Fanbox only'], ['unknown', 'Fanbox not checked'], ['local', 'Local only']] },
    { id: 'p', label: 'Pawchive', fn: (r, v) => r.p === v, opts: [['full', 'Has files'], ['meta', 'Metadata only'], ['none', 'Not listed'], ['gone', 'Gone']] },
    { id: 'f', label: 'Fanbox', fanbox: true, fn: (r, v) => r.f === v, opts: [['open', 'Accessible'], ['locked', 'Not subscribed'], ['gone', 'Deleted'], ['unknown', 'Not checked']] },
  ] },
  st: { label: 'Status', groups: [
    { id: 's', label: 'Local', fn: (r, v) => r.head.k === v, opts: [['done', 'Done'], ['partial', 'Partial'], ['pending', 'Pending'], ['failed', 'Failed'], ['wait', 'Waiting'], ['na', 'Unavailable'], ['filtered', 'Filtered'], ['ignored', 'Ignored']] },
    { id: 'm', label: 'Needs a look', fn: (r, v) => FLAG[v](r), opts: [['stale', 'Updated upstream'], ['mismatch', 'Times disagree'], ['bad', 'Check failed'], ['unverified', 'Adopted, unverified']] },
  ] },
  sub: { label: 'Plan', fanbox: true, groups: [
    { id: 'u', label: '', fn: (r, v) => r.sub === v, opts: [['free', 'Free'], ['yes', 'Open to me'], ['no', 'Locked to me'], ['unknown', 'Not signed in']] },
  ] },
  via: { label: 'Got from', groups: [
    { id: 'v', label: '', fn: (r, v) => (v === 'mix' ? r.via.length > 1 : v === 'nil' ? !r.via.length : r.via.includes(v)), opts: [['pawchive', 'Pawchive'], ['fanbox', 'Fanbox'], ['adopted', 'Adopted folder'], ['v1', 'v1'], ['local', 'Found on disk'], ['mix', 'Mixed'], ['nil', 'Nothing yet']] },
  ] },
};
const FLAG = {
  stale: (r) => (r.head.why || '').startsWith('Updated upstream'),
  mismatch: (r) => r.mismatch,
  bad: (r) => r.verified_bad > 0,
  unverified: (r) => (r.head.why || '').includes('unverified'),
};
const ORDER = ['failed', 'wait', 'partial', 'pending', 'na', 'done', 'filtered', 'ignored'];
const SORTS = {
  new: ['Newest', 'Published · newest first', (a, b) => b.published.localeCompare(a.published)],
  old: ['Oldest', 'Published · oldest first', (a, b) => a.published.localeCompare(b.published)],
  status: ['Status', 'Status · needs work first', (a, b) => ORDER.indexOf(a.head.k) - ORDER.indexOf(b.head.k) || b.published.localeCompare(a.published)],
  fee: ['Fee', 'Fee · highest first', (a, b) => b.fee - a.fee || b.published.localeCompare(a.published)],
  files: ['Files', 'Files · most first', (a, b) => b.total - a.total],
};

// Filters survive switching creators: "show me what is still pending" is a habit.
const sel = { cov: new Set(), st: new Set(), sub: new Set(), via: new Set() };
let sort = 'new';
let showThumbs = true;
let layout = 'list';
try {
  showThumbs = localStorage.getItem('thumbs') !== 'off';
  layout = localStorage.getItem('postLayout') === 'grid' ? 'grid' : 'list';
} catch { /* storage unavailable */ }
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

let S = null;

// The size is in the URL so a browser holding a cached smaller thumbnail asks again.
const thumbURL = (id) => `api/thumbs/${encodeURIComponent(S.cid)}/${encodeURIComponent(id)}?w=640`;

// A missing cover becomes a quiet placeholder of the same size, so rows stay aligned.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.classList.contains('thumb')) {
    const ph = document.createElement('span');
    ph.className = img.className + ' none';
    ph.title = 'No cover';
    img.replaceWith(ph);
  }
}, true);

const okey = (g, v) => `${g.id}:${v}`;
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function matches(r, dim, except) {
  const s = sel[dim];
  if (!s.size || dim === except) return true;
  return FILTERS[dim].groups.every((g) => {
    const chosen = g.opts.filter(([v]) => s.has(okey(g, v)));
    return !chosen.length || chosen.some(([v]) => g.fn(r, v));
  });
}

function visible(except) {
  const q = S.q.trim().toLowerCase();
  return S.rows.filter((r) => (!q || r.title.toLowerCase().includes(q) || r.id.includes(q)) && Object.keys(FILTERS).every((d) => matches(r, d, except)));
}

const cells = (p, f) => `<span class="src"><span class="sc p ${p}" title="${P_LABEL[p] || ''}">P</span><span class="sc f ${f === 'na' ? 'na' : f}" title="${F_LABEL[f] || ''}">F</span></span>`;

function viaHTML(via) {
  if (!via.length) return '<span class="via muted-dash">—</span>';
  if (via.length > 1) {
    return `<span class="via" title="${via.map((v) => (VIA[v] || [v])[0]).join(' + ')}">Mixed ${via.map((v) => `<b class="${(VIA[v] || [])[1] || 'va'}">${(VIA[v] || [v, '', v])[2]}</b>`).join('+')}</span>`;
  }
  const [label, cls] = VIA[via[0]] || [via[0], 'va'];
  return `<span class="via"><b class="${cls}">${label}</b></span>`;
}

function tzTitle(utc) {
  if (!utc) return '';
  const u = at(utc), j = at(utc, 540), l = at(utc, localOffset());
  return `UTC ${u.date} ${u.time} · JST ${j.date} ${j.time} · local ${l.date} ${l.time}`;
}

const extLink = (url, label, title = '') => `<a class="ext" href="${esc(url)}" target="_blank" rel="noreferrer"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}${I.ext}</a>`;

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
  if (r.sub === 'yes') return `<span class="sub yes" title="Fanbox opens this ¥${r.fee} post to you">¥${r.fee}</span>`;
  if (r.sub === 'no') return `<span class="sub no" title="Fanbox keeps this ¥${r.fee} post locked for you">¥${r.fee}</span>`;
  return `<span class="sub unknown" title="Sign in to Fanbox to see whether your plan covers it">¥${r.fee}</span>`;
}

// ---------------------------------------------------------------- header

function header() {
  const d = S.detail;
  const n = { both: 0, ponly: 0, fonly: 0, local: 0, unknown: 0 };
  const pc = { full: 0, meta: 0, none: 0, gone: 0 };
  const fc = { open: 0, locked: 0, gone: 0, unknown: 0 };
  let done = 0;
  for (const r of S.rows) {
    n[r.cov] = (n[r.cov] || 0) + 1;
    pc[r.p] = (pc[r.p] || 0) + 1;
    if (r.f in fc) fc[r.f]++;
    if (r.head.k === 'done') done++;
  }
  const total = S.rows.length || 1;
  const seg = (k) => (n[k] ? `<span class="c-${k}" style="width:${((n[k] / total) * 100).toFixed(2)}%"></span>` : '');
  const name = d.alias || d.name;
  const fanbox = d.service === 'fanbox';
  const pSum = pc.full + pc.meta;
  const pState = d.pawchive_state === 'none' ? 'Not on Pawchive'
    : d.pawchive_state === 'gone' ? 'Creator no longer on Pawchive'
    : pSum && !pc.full ? 'Metadata only (has_full=false)'
    : `${pc.full} with files · ${pc.meta} metadata only${pc.gone ? ` · ${pc.gone} gone` : ''}`;
  // A cancelled plan leaves your plan list at once but keeps its posts open for the paid month.
  const paidOpen = S.rows.some((r) => r.fee > 0 && r.f === 'open');
  const plan = d.plan_fee == null ? (d.session === 'rejected' ? 'cookie rejected' : 'signed out') : d.plan_fee ? `¥${d.plan_fee} plan` : paidOpen ? 'no current plan; paid posts still open' : 'no plan';
  const fState = !fanbox ? '' : d.fanbox_state === 'none' ? 'No Fanbox page'
    : !d.fanbox_listed_at ? (d.fanbox_checked_at ? 'Not checked yet: the last check failed' : 'Not checked yet')
    : `${fc.open} accessible · ${fc.locked} locked${fc.gone ? ` · ${fc.gone} deleted` : ''}`;
  const loc = d.local || {};
  const viaParts = [['adopted', 'adopted'], ['v1', 'v1'], ['pawchive', 'Pawchive'], ['fanbox', 'Fanbox'], ['found', 'on disk']].filter(([k]) => loc[k]).map(([k, l]) => `${loc[k].toLocaleString()} ${l}`);
  const fetchable = S.rows.filter((r) => ['pending', 'partial', 'failed'].includes(r.head.k)).length;
  const synced = d.synced_at || d.fanbox_checked_at;
  return `<div class="ch">
    <div class="ch-top">
      <div class="avatar">${esc(name.slice(0, 1))}</div>
      <div class="ch-id">
        <h1><span class="ch-name">${esc(name)}</span>${d.alias && d.alias !== d.name ? `<small>${esc(d.name)}</small>` : ''}${d.ignore ? '<span class="chip k-ignored">Ignored</span>' : ''}${d.completed ? '<span class="chip k-done">Completed</span>' : ''}</h1>
        <div class="ids">
          <span>${esc(d.service)} <span class="mono">${esc(d.user_id)}</span>${fanbox ? ` · <span class="mono">${d.fanbox_creator_id ? '@' + esc(d.fanbox_creator_id) : d.fanbox_state === 'none' ? 'no Fanbox' : '@ not resolved'}</span>` : ''}</span>
          <span class="ext-links">${sitesFor('').filter((s) => s.url).map((s) => extLink(s.url, s.label, `Open on ${s.label}`)).join('')}</span>
          <span class="ids-grp" title="Group">${esc(d.group || 'Ungrouped')}</span>
          <span>Synced ${esc(ago(synced))}</span>
          <span>${d.preference === 'fanbox-first' ? 'Fanbox first' : 'Pawchive first'}${d.config.source_preference ? '' : ' (default)'}</span>
        </div>
      </div>
      <div class="btns">
        <button class="btn" type="button" data-cact="sync">${I.sync}Sync</button>
        <button class="btn primary" type="button" data-cact="download" ${fetchable ? '' : 'disabled'}>${I.dl}Download ${fetchable.toLocaleString()}</button>
        <div class="dd"><button type="button" class="btn icon" data-cmenu aria-label="More actions" aria-haspopup="true" aria-expanded="false">${I.dots}</button></div>
      </div>
    </div>
    <div class="sources">
      <div class="sbox ${pSum && !pc.full ? 'warn' : ''}"><div class="h"><span class="sc p ${pc.full ? 'full' : pSum ? 'meta' : 'none'}">P</span>Pawchive<span class="h-r">${esc(ago(d.pawchive_checked_at))}</span></div><div class="v"><b>${pSum.toLocaleString()}</b>posts</div><div class="s" title="${esc(pState)}">${esc(pState)}</div></div>
      ${fanbox ? `<div class="sbox ${d.session === 'rejected' ? 'warn' : ''}"><div class="h"><span class="sc f ${fc.open ? 'open' : fc.locked ? 'locked' : 'unknown'}">F</span>Fanbox<span class="h-r">${esc(plan)}</span></div><div class="v"><b>${(fc.open + fc.locked).toLocaleString()}</b>posts</div><div class="s" title="${esc(fState)}">${esc(fState)}</div></div>`
        : '<div class="sbox"><div class="h"><span class="sc f unknown">F</span>Fanbox</div><div class="v"><b>—</b></div><div class="s">Not a Fanbox creator</div></div>'}
      <div class="sbox"><div class="h"><span class="sc lc">L</span>Local<button class="linkbtn h-r" type="button" data-open="${esc(d.dir)}" title="${esc(d.dir)}">Open folder</button></div><div class="v"><b>${done.toLocaleString()}</b>posts done</div><div class="s" title="${esc(viaParts.join(' · '))}">${esc(viaParts.join(' · ') || 'Nothing downloaded yet')}${loc.failed ? ` · ${loc.failed} failed files` : ''}</div></div>
    </div>
    ${S.rows.length ? `<div class="cover">
      <div class="cover-bar" role="img" aria-label="Source coverage">${seg('both')}${seg('ponly')}${seg('fonly')}${seg('unknown')}${seg('local')}</div>
      <div class="cover-legend">
        ${[['both', 'On both', 'c-both'], ['ponly', 'Pawchive only', 'c-ponly'], ['fonly', 'Fanbox only', 'c-fonly'], ['unknown', 'Fanbox not checked', 'c-unknown'], ['local', 'Local only', 'c-local']].filter(([k]) => n[k]).map(([k, l, c]) => `<button type="button" data-cov="${k}" title="Show only these"><i class="${c}"></i>${l} <span class="num">${n[k].toLocaleString()}</span></button>`).join('')}
      </div></div>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- menus

function summary(dim) {
  const s = sel[dim];
  if (!s.size) return 'All';
  if (s.size === 1) {
    const k = [...s][0];
    for (const g of FILTERS[dim].groups) for (const [v, l] of g.opts) if (okey(g, v) === k) return l;
  }
  return `${s.size} selected`;
}

function filterMenu(dim) {
  const fanbox = S.detail.service === 'fanbox';
  const base = visible(dim);
  const s = sel[dim];
  const groups = FILTERS[dim].groups.filter((g) => fanbox || !g.fanbox);
  const total = groups.reduce((n, g) => n + g.opts.length, 0);
  return `${total > 8 ? `<div class="menu-search"><label class="field">${I.search}<input placeholder="Filter options" aria-label="Filter options"></label></div>` : ''}
    <div class="menu-body">${groups.map((g) => `<div class="menu-group">${g.label ? `<div class="menu-label"><span>${g.label}</span></div>` : ''}
      ${g.opts.map(([v, l]) => { const k = okey(g, v); const c = base.filter((r) => g.fn(r, v)).length; return checkItem({ key: k, label: l, on: s.has(k), count: c.toLocaleString(), faint: !c }); }).join('')}</div>`).join('')}</div>
    <div class="menu-foot"><span>${s.size ? `${s.size} selected${groups.length > 1 ? ' · OR within a group' : ''}` : 'No filter'}</span><button type="button" class="linkbtn" data-clear ${s.size ? '' : 'disabled'}>Clear</button></div>`;
}

function rowMenu(r) {
  const done = r.head.k === 'done';
  return `<div class="menu-body">
    ${actionItem({ act: 'download', label: done ? 'Fetch missing files' : 'Download now', icon: I.dl })}
    ${actionItem({ act: 'source', label: 'Download from…', icon: I.dl, sub: 'source' })}
    ${actionItem({ act: 'redownload', label: 'Download again (overwrite)', icon: I.reset })}
    ${actionItem({ act: 'resync', label: 'Re-sync (check edits)', icon: I.sync })}
    <div class="sep"></div>
    ${actionItem({ act: 'open', label: 'Open folder', icon: I.folder })}
    ${sitesFor(r.id, r).map((s) => linkItem({ href: s.url, label: `Open on ${s.label}`, disabled: s.why })).join('')}
    <div class="sep"></div>
    ${done ? actionItem({ act: 'undone', label: 'Mark as not done', icon: I.reset }) : actionItem({ act: 'done', label: 'Mark as done', icon: I.check })}
  </div>`;
}

function sourceSub(r) {
  const d = S.detail;
  const pWhy = r.p === 'meta' ? 'Pawchive has metadata only' : r.p === 'none' ? 'Not on Pawchive' : r.p === 'gone' ? 'Gone from Pawchive' : '';
  const fWhy = d.service !== 'fanbox' ? 'Not a Fanbox creator'
    : r.f === 'locked' ? (d.plan_fee == null ? `Needs ¥${r.fee} (signed out)` : `Needs ¥${r.fee}; your plan is ¥${d.plan_fee}`)
    : r.f === 'gone' ? 'Deleted on Fanbox' : r.f === 'unknown' ? 'Fanbox not checked yet' : '';
  return `<div class="menu-body">
    <button type="button" class="mi two" role="menuitem" data-act="from-pawchive" ${pWhy ? 'aria-disabled="true"' : ''}><span class="ico"><span class="sc p ${r.p} sc-sm">P</span></span><span class="lbl"><span><span class="t">Pawchive</span><span class="why">${pWhy || 'Paced at 1 request/s'}</span></span></span><span class="tail"></span></button>
    <button type="button" class="mi two" role="menuitem" data-act="from-fanbox" ${fWhy ? 'aria-disabled="true"' : ''}><span class="ico"><span class="sc f ${r.f === 'na' ? 'unknown' : r.f} sc-sm">F</span></span><span class="lbl"><span><span class="t">Fanbox</span><span class="why">${fWhy || 'Uses your Fanbox session'}</span></span></span><span class="tail"></span></button>
  </div>`;
}

function creatorMenu() {
  const d = S.detail;
  const pref = d.config.source_preference || 'inherit';
  const fanbox = d.service === 'fanbox';
  return `<div class="menu-body">
    ${actionItem({ act: 'deep', label: 'Deep sync (re-read bodies)', icon: I.sync })}
    ${actionItem({ act: 'sync-p', label: 'Sync Pawchive only', icon: I.sync })}
    ${fanbox ? actionItem({ act: 'sync-f', label: 'Sync Fanbox only', icon: I.sync }) : ''}
    <div class="sep"></div>
    ${fanbox ? actionItem({ act: 'adopt', label: 'Adopt a folder…', icon: I.folder }) : ''}
    ${actionItem({ act: 'relayout', label: 'Rename folders…', icon: I.move })}
    ${actionItem({ act: 'edit', label: 'Alias and group…', icon: I.edit })}
    <div class="sep"></div>
    ${sitesFor('').map((s) => linkItem({ href: s.url, label: `Open on ${s.label}`, disabled: s.why })).join('')}
    <div class="sep"></div>
    <div class="menu-label"><span>Download source</span></div>
    ${radioItem({ key: 'inherit', label: 'Use the default', on: pref === 'inherit', attr: 'data-act="pref" data-pref' })}
    ${radioItem({ key: 'pawchive-first', label: 'Pawchive first', on: pref === 'pawchive-first', attr: 'data-act="pref" data-pref' })}
    ${radioItem({ key: 'fanbox-first', label: 'Fanbox first', on: pref === 'fanbox-first', attr: 'data-act="pref" data-pref' })}
    <div class="sep"></div>
    ${actionItem({ act: 'ignore', label: d.ignore ? 'Stop ignoring' : 'Ignore this creator', icon: I.eye })}
    ${actionItem({ act: 'complete', label: d.completed ? 'Mark as ongoing' : 'Mark as completed', icon: I.check })}
    ${actionItem({ act: 'remove', label: 'Remove…', icon: I.trash, danger: true })}
  </div>`;
}

function sortMenu() {
  return `<div class="menu-body">${Object.entries(SORTS).map(([k, [, l]]) => radioItem({ key: k, label: l, on: sort === k, attr: 'data-sort' })).join('')}</div>`;
}

// ---------------------------------------------------------------- rows & detail

function fileCell(f, r) {
  const p = f.present_p ? 'full' : f.has_p ? (r.p === 'gone' ? 'gone' : 'meta') : 'none';
  const fs = r.f === 'na' ? 'na' : f.present_f ? 'open' : r.f === 'locked' ? 'locked' : r.f === 'gone' ? 'gone' : f.has_f ? 'locked' : 'none';
  return cells(p, fs);
}

function detailHTML(r) {
  const d = S.details.get(r.id);
  if (!d) return '<div class="detail"><div class="loading">Loading…</div></div>';
  const u = at(d.published), j = at(d.published, 540), l = at(d.published, localOffset());
  const fanbox = S.detail.service === 'fanbox';
  const obs = d.obs || {};
  const so = (src, label) => {
    const o = obs[src];
    if (!o) return `<div class="fact"><div class="h">${label}</div><div class="v">${src === 'pawchive' ? 'Not listed' : 'Not checked'}</div><div class="v2">—</div></div>`;
    const states = { full: 'Has files', meta: 'Metadata only', gone: 'Gone', open: 'Accessible', locked: 'Not subscribed' };
    return `<div class="fact"><div class="h">${label}</div><div class="v">${states[o.state] || o.state}${o.gone_since ? ` since ${o.gone_since.slice(0, 10)}` : ''}</div>
      <div class="v2">First seen ${o.first_seen.slice(0, 10)} · last ${o.last_seen.slice(0, 10)}${src === 'fanbox' ? ` · body ${o.detail_at ? o.detail_at.slice(0, 10) : 'not read'}` : ''}</div></div>`;
  };
  const vt = (f) => (f.verified === 1 ? '<span class="tick" title="Matches the source">✓</span>' : f.verified === 0 ? '<span class="cross">Mismatch</span>' : f.state === 'done' ? '<span class="muted">Unchecked</span>' : '—');
  const dims = (f) => [f.width && f.height ? `${f.width}×${f.height}` : '', f.size ? fmtSize(f.size) : f.local_size ? fmtSize(f.local_size) : ''].filter(Boolean).join(' · ') || '—';
  const st = (f) => {
    if (f.state === 'done') return '<span class="chip k-done">Done</span>';
    if (f.state === 'failed') return '<span class="chip k-failed">Failed</span>';
    if (f.deferred_until) return `<span class="chip k-wait">Retry ${f.deferred_until.slice(5, 10)}</span>`;
    return '<span class="chip k-pending">Pending</span>';
  };
  const notes = [];
  if (d.mismatch && obs.pawchive && obs.fanbox) notes.push(`The two sources disagree on the publish time (Pawchive ${obs.pawchive.published}, Fanbox ${obs.fanbox.published} UTC); Fanbox's is used.`);
  if (r.p === 'gone') notes.push(`Pawchive listed this post until ${(obs.pawchive?.gone_since || '').slice(0, 10)}.`);
  if (r.f === 'gone') notes.push('Deleted on Fanbox.' + (r.head.k === 'done' ? ' The local copy may be the only one left.' : ''));
  if (d.stale) notes.push(`Fanbox updated this post (${(d.edited || '').slice(0, 10)}) after it was downloaded. The file count is unchanged; use ⋯ → Download again if needed.`);
  if (r.origin === 'adopted') notes.push(r.total ? 'This folder was adopted from the extension\'s layout.' : 'Adopted without a file list from either source, so its files are unchecked.');
  if (r.origin === 'manual') notes.push('Marked as done by hand.');
  const files = d.files || [];
  const roles = { cover: 'Cover', image: 'Image', file: 'File' };
  return `<div class="detail">
    <div class="detail-top">
      <a class="cover-big" href="${thumbURL(r.id)}" target="_blank" rel="noreferrer" title="Open the cover"><img class="thumb big" src="${thumbURL(r.id)}" alt="Cover" loading="lazy" decoding="async"></a>
      <div class="facts">
        <div class="fact"><div class="h">Published</div><div class="v mono">${u ? `${u.date} ${u.time}` : '—'} UTC</div><div class="v2 mono">JST ${j ? `${j.date} ${j.time}` : '—'} · local ${l ? l.date : '—'}</div></div>
        <div class="fact"><div class="h">Fee / plan</div><div class="v">${r.fee ? '¥' + r.fee : 'Free'}${fanbox && r.fee ? ` · ${{ yes: 'open to you', no: 'locked', unknown: 'signed out' }[r.sub] || ''}` : ''}</div><div class="v2">${fanbox ? (S.detail.plan_fee == null ? 'Not signed in to Fanbox' : S.detail.plan_fee ? `Your plan: ¥${S.detail.plan_fee}` : r.sub === 'yes' ? 'No current plan; still open (paid month not over)' : 'You do not support this creator') : '—'}</div></div>
        <div class="fact"><div class="h">Selection</div><div class="v">${r.filtered ? 'Filtered out' : 'Included'}</div><div class="v2">${esc(r.filtered || 'No filter rule matches')}</div></div>
        <div class="fact"><div class="h">Folder · ${d.dir_exists ? 'exists' : 'not created'}</div><div class="v mono clamp2 small" title="${esc(d.dir)}">${esc(d.dir.split(/[\\/]/).pop())}</div><div class="v2">${d.done_at ? `Done ${d.done_at.slice(0, 10)}` : 'Not done'}</div></div>
      </div>
    </div>
    <div class="facts two">${so('pawchive', 'Pawchive')}${fanbox ? so('fanbox', 'Fanbox') : '<div class="fact"><div class="h">Fanbox</div><div class="v">Not applicable</div><div class="v2">—</div></div>'}</div>
    ${notes.map((n) => `<div class="note">${esc(n)}</div>`).join('')}
    ${files.length ? `<div class="ftable"><table><colgroup><col style="width:14%"><col style="width:8%"><col><col style="width:62px"><col style="width:96px"><col style="width:84px"><col style="width:132px"><col style="width:84px"></colgroup>
      <thead><tr><th>Local name</th><th>Role</th><th>Match key</th><th>Source</th><th>Status</th><th>Got from</th><th>Size</th><th>Check</th></tr></thead><tbody>
      ${files.map((f) => `<tr><td class="mono clip" title="${esc(f.local_name)}">${esc(f.local_name)}</td><td>${roles[f.role] || f.role}</td><td class="key clip" title="${esc(f.key)}">${esc(f.key)}</td><td>${fileCell(f, r)}</td><td>${st(f)}</td><td>${f.via ? viaHTML([f.via]) : '<span class="via">—</span>'}</td><td class="num muted">${dims(f)}</td><td>${vt(f)}</td></tr>${f.error ? `<tr class="err-row"><td colspan="8" class="err">${esc(f.error)}</td></tr>` : ''}`).join('')}
    </tbody></table></div>` : `<div class="note">${r.f === 'locked' && r.p !== 'full' ? 'File list unknown: not subscribed on Fanbox, and Pawchive has no list for this post.' : 'This post has no files.'}</div>`}
    ${d.content ? `<details class="content"><summary>Text</summary><div class="content-box">${esc(d.content.replace(/<[^>]+>/g, ' '))}</div></details>` : ''}
    <div class="detail-actions">
      <button class="btn sm" type="button" data-ract="download" data-id="${r.id}">${I.dl}${r.head.k === 'done' ? 'Fetch missing' : 'Download'}</button>
      <button class="btn sm" type="button" data-open="${esc(d.dir)}">${I.folder}Open folder</button>
      ${sitesFor(r.id, r).filter((s) => s.url).map((s) => `<a class="btn sm" href="${esc(s.url)}" target="_blank" rel="noreferrer" title="Open this post on ${s.label}">${I.ext}${s.label}</a>`).join('')}
    </div>
  </div>`;
}

function rowHTML(r) {
  const open = S.open.has(r.id);
  const pick = S.picked.has(r.id);
  const h = r.head;
  const u = at(r.published);
  const fanbox = S.detail.service === 'fanbox';
  return `<div class="row ${open ? 'open' : ''} ${pick ? 'sel' : ''}" data-id="${r.id}">
    <div class="row-main" data-toggle="${r.id}" aria-expanded="${open}">
      <button type="button" class="rowcb c-cb" data-pick="${r.id}" aria-label="Select"><span class="cb ${pick ? 'on' : ''}"></span></button>
      <span class="c-thumb">${showThumbs ? `<img class="thumb" src="${thumbURL(r.id)}" alt="" loading="lazy" decoding="async">` : ''}</span>
      <div class="ttl"><span class="t" title="${esc(r.title)}">${esc(r.title || '(untitled)')}</span>
        <span class="m"><span class="mono">${r.id}</span><span class="tz mono" title="${tzTitle(r.published)}">${u ? u.date : '—'}</span>${r.total ? `<span>${plural(r.total, 'file')}</span>` : ''}${r.mismatch ? '<span class="warn" title="The two sources disagree on the publish time">time differs</span>' : ''}</span></div>
      <span class="c-src">${cells(r.p, r.f)}</span>
      <span class="c-sub">${fanbox ? planCell(r) : '<span class="sub free">—</span>'}</span>
      <span class="c-stat stat"><span class="chip k-${h.k}">${esc(h.t)}</span>${h.progress != null ? `<span class="mini-bar"><i style="width:${(h.progress * 100).toFixed(0)}%"></i></span>` : ''}${h.why ? `<span class="why" title="${esc(h.why)}">${esc(h.why)}</span>` : ''}</span>
      <span class="c-via">${viaHTML(r.via)}</span>
      <span class="c-kb"><div class="dd"><button type="button" class="kebab" data-rmenu="${r.id}" aria-label="Post actions" aria-haspopup="true" aria-expanded="false">${I.dots}</button></div></span>
    </div>
    ${open ? detailHTML(r) : ''}
  </div>`;
}

const dims = () => ['cov', 'st', ...(S.detail.service === 'fanbox' ? ['sub'] : []), 'via'];

// The toolbar is drawn once per load; everything below it is redrawn on each change, so an
// open dropdown and the search box keep their place while the list updates underneath.
function render() {
  if (!S) return;
  const scroll = S.el.scrollTop;
  S.el.innerHTML = `${header()}
    <div class="toolbar">
      <label class="field search" for="psearch">${I.search}<input id="psearch" placeholder="Title or post id" value="${esc(S.q)}" autocomplete="off"></label>
      ${dims().map((dim) => `<div class="dd"><button type="button" class="dd-trigger" data-filter="${dim}" aria-haspopup="true" aria-expanded="false">${FILTERS[dim].label}<span class="val"></span>${I.chev}</button></div>`).join('')}
      <span class="spacer"></span>
      <button type="button" class="dd-trigger toggle" data-thumbs aria-pressed="${showThumbs}" title="Show post covers in the list" ${layout === 'grid' ? 'hidden' : ''}>Covers<span class="val">${showThumbs ? 'On' : 'Off'}</span></button>
      <div class="seg layout" role="group" aria-label="Layout">
        <button type="button" data-layout="list" aria-pressed="${layout === 'list'}" title="List">${I.list}</button>
        <button type="button" data-layout="grid" aria-pressed="${layout === 'grid'}" title="Grid">${I.grid}</button>
      </div>
      <div class="dd"><button type="button" class="dd-trigger" data-sortmenu aria-haspopup="true" aria-expanded="false">Sort<span class="val"></span>${I.chev}</button></div>
    </div>
    <div data-body></div>`;
  S.el.classList.toggle('with-thumbs', showThumbs && layout === 'list');
  S.el.querySelector('#psearch').addEventListener('input', (e) => {
    S.q = e.target.value;
    S.limit = PAGE;
    renderBody();
  });
  renderBody();
  S.el.scrollTop = scroll;
}

function renderBody() {
  if (!S) return;
  for (const dim of dims()) {
    const b = S.el.querySelector(`[data-filter="${dim}"]`);
    b.classList.toggle('active', sel[dim].size > 0);
    b.querySelector('.val').textContent = summary(dim);
  }
  S.el.querySelector('[data-sortmenu] .val').textContent = SORTS[sort][0];
  const list = visible().sort(SORTS[sort][2]);
  S.list = list;
  const fanbox = S.detail.service === 'fanbox';
  const chips = [];
  for (const dim of Object.keys(FILTERS)) {
    for (const g of FILTERS[dim].groups) {
      for (const [v, l] of g.opts) {
        const k = okey(g, v);
        if (sel[dim].has(k)) chips.push(`<span class="fchip"><b>${g.label || FILTERS[dim].label}</b>${l}<button type="button" aria-label="Remove ${l}" data-unchip="${dim}|${k}">${I.x}</button></span>`);
      }
    }
  }
  const anySel = Object.values(sel).some((s) => s.size);
  const shown = list.slice(0, S.limit);
  const allPicked = list.length && list.every((r) => S.picked.has(r.id));
  const somePicked = !allPicked && list.some((r) => S.picked.has(r.id));
  S.el.querySelector('[data-body]').innerHTML = `
    ${chips.length || S.q ? `<div class="chips">${chips.join('')}<button type="button" class="linkbtn" data-clearall>Clear all</button><span class="count num">${list.length.toLocaleString()} of ${S.rows.length.toLocaleString()}</span></div>` : ''}
    ${layout === 'list'
      ? `<div class="grid-head"><button type="button" class="rowcb c-cb" data-pickall aria-label="Select all shown" title="Select all ${list.length.toLocaleString()} matching posts"><span class="cb ${allPicked ? 'on' : somePicked ? 'some' : ''}"></span></button><span class="c-thumb">Cover</span><span>Post</span><span>Source</span><span class="c-sub">${fanbox ? 'Fee' : ''}</span><span>Local status</span><span class="c-via">Got from</span><span></span></div>`
      : `<div class="cards-head"><button type="button" class="rowcb" data-pickall aria-label="Select all shown"><span class="cb ${allPicked ? 'on' : somePicked ? 'some' : ''}"></span></button><span>Select all ${list.length.toLocaleString()} matching</span></div>`}
    ${shown.length
      ? (layout === 'list' ? `<div class="rows">${shown.map(rowHTML).join('')}</div>` : `<div class="cards">${shown.map(cardHTML).join('')}</div>`)
      : `<div class="empty">${S.rows.length ? `No posts match.${anySel || S.q ? ' <button type="button" class="linkbtn" data-clearall>Clear filters</button>' : ''}` : 'No posts yet. Sync to read both sources.'}</div>`}
    ${list.length > S.limit ? `<div class="more">Showing ${S.limit.toLocaleString()} of ${list.length.toLocaleString()}<button class="btn sm" type="button" data-more>Show ${Math.min(PAGE, list.length - S.limit)} more</button><button class="linkbtn" type="button" data-all>Show all</button></div>` : ''}
    ${S.picked.size ? `<div class="bulk"><span><b class="num">${S.picked.size.toLocaleString()}</b> selected</span><span class="spacer"></span>
      <button class="btn" type="button" data-bulk="download">${I.dl}Download</button>
      ${fanbox ? `<button class="btn" type="button" data-bulk="from-fanbox">${I.dl}From Fanbox</button>` : ''}
      <button class="btn" type="button" data-bulk="done">${I.check}Mark done</button>
      <button class="btn" type="button" data-bulk="undone">${I.reset}Mark not done</button>
      <button class="btn" type="button" data-unpick>Deselect</button></div>` : ''}`;
  renderDrawer();
}

// ---------------------------------------------------------------- grid & drawer

function cardHTML(r) {
  const h = r.head;
  const u = at(r.published);
  const pick = S.picked.has(r.id);
  const fanbox = S.detail.service === 'fanbox';
  return `<article class="card ${pick ? 'sel' : ''} ${S.drawer === r.id ? 'open' : ''}" data-card="${r.id}">
    <div class="card-cover">
      <img class="thumb card-img" src="${thumbURL(r.id)}" alt="" loading="lazy" decoding="async">
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

// The grid opens a post in a side panel, so the cards keep their places.
let drawerEl = null;
function renderDrawer() {
  if (!S || !S.drawer) {
    if (drawerEl) { drawerEl.remove(); drawerEl = null; }
    return;
  }
  const r = S.rows.find((x) => x.id === S.drawer);
  if (!r) { S.drawer = null; return renderDrawer(); }
  if (!drawerEl) {
    drawerEl = document.createElement('div');
    drawerEl.className = 'drawer-wrap';
    drawerEl.addEventListener('click', (e) => {
      if (e.target === drawerEl || e.target.closest('[data-close]')) return closeDrawer();
      onClick(e);
    });
    document.body.appendChild(drawerEl);
  }
  const scroll = drawerEl.querySelector('.drawer-body')?.scrollTop || 0;
  drawerEl.innerHTML = `<aside class="drawer" role="dialog" aria-label="${esc(r.title)}">
    <header class="drawer-head">
      <div class="drawer-title"><b title="${esc(r.title)}">${esc(r.title || '(untitled)')}</b><span class="mono muted">${r.id}</span></div>
      <span class="chip k-${r.head.k}">${esc(r.head.t)}</span>
      <div class="dd"><button type="button" class="btn icon sm" data-rmenu="${r.id}" aria-label="Post actions" aria-haspopup="true" aria-expanded="false">${I.dots}</button></div>
      <button type="button" class="btn icon sm" data-close aria-label="Close" title="Close (Esc)">${I.close}</button>
    </header>
    <div class="drawer-body">${detailHTML(r)}</div>
  </aside>`;
  drawerEl.querySelector('.drawer-body').scrollTop = scroll;
}

function openDrawer(id) {
  S.drawer = id;
  renderBody();
  loadDetail(id);
}

function closeDrawer() {
  if (!S) return;
  S.drawer = null;
  renderBody();
}

document.addEventListener('keydown', (e) => {
  // An open menu takes the first Escape (it calls preventDefault); the panel the next.
  if (e.key === 'Escape' && S?.drawer && !e.defaultPrevented) closeDrawer();
});

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
  const patch = async (body) => { await attempt(() => api(`creators/${S.cid}`, { method: 'PATCH', body }), 'Saved'); await reload(); S.onChange?.(); };
  if (act === 'pref') return patch({ preference: el.dataset.pref });
  if (act === 'ignore') return patch({ ignore: !d.ignore });
  if (act === 'complete') return patch({ completed: !d.completed });
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
  if (act === 'download') return postAction([r.id], 'download');
  if (act === 'from-pawchive') return postAction([r.id], 'download', 'pawchive');
  if (act === 'from-fanbox') return postAction([r.id], 'download', 'fanbox');
  if (act === 'redownload') {
    const v = await dialog({ title: 'Download this post again?', confirm: 'Download again', body: 'Every file is fetched again and overwrites the local copy.' });
    if (v) return postAction([r.id], 'redownload');
    return;
  }
  if (act === 'resync') return postAction([r.id], 'resync');
  if (act === 'done') return postAction([r.id], 'mark_done');
  if (act === 'undone') return postAction([r.id], 'mark_undone');
  if (act === 'open') {
    const d = S.details.get(r.id) || await api(`creators/${S.cid}/posts/${r.id}`);
    return openPath(d.dir);
  }
}

export async function openPath(path) {
  const out = await attempt(() => api('open', { method: 'POST', body: { path } }));
  if (out && !out.exact) toast('That folder does not exist yet; opened the nearest parent');
}

async function loadDetail(id) {
  try {
    S.details.set(id, await api(`creators/${S.cid}/posts/${id}`));
  } catch (e) {
    toast(e.message, true);
    S.open.delete(id);
  }
  renderBody();
}

function onClick(e) {
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
        if (only) sel[dim] = new Set([only.dataset.only]);
        else if (mi.dataset.clear !== undefined) sel[dim].clear();
        else if (mi.dataset.opt) {
          const s = sel[dim];
          if (s.has(mi.dataset.opt)) s.delete(mi.dataset.opt);
          else s.add(mi.dataset.opt);
        }
        S.limit = PAGE;
        renderBody();
        return 'keep';
      },
    });
    return;
  }
  const lay = t.closest('[data-layout]');
  if (lay) {
    layout = lay.dataset.layout;
    remember('postLayout', layout);
    lay.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === lay)));
    S.el.querySelector('[data-thumbs]').hidden = layout === 'grid';
    S.el.classList.toggle('with-thumbs', showThumbs && layout === 'list');
    return renderBody();
  }
  const tb = t.closest('[data-thumbs]');
  if (tb) {
    showThumbs = !showThumbs;
    remember('thumbs', showThumbs ? 'on' : 'off');
    tb.setAttribute('aria-pressed', String(showThumbs));
    tb.querySelector('.val').textContent = showThumbs ? 'On' : 'Off';
    S.el.classList.toggle('with-thumbs', showThumbs);
    return renderBody();
  }
  if (t.closest('[data-sortmenu]')) {
    const b = t.closest('[data-sortmenu]');
    if (menuOpenFor(b)) return closeMenu();
    openMenu(b, { className: 'mini right', keyboard: e.detail === 0, build: sortMenu, onPick: (mi) => { if (mi.dataset.sort) { sort = mi.dataset.sort; renderBody(); } } });
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
    const r = S.rows.find((x) => x.id === rm.dataset.rmenu);
    if (menuOpenFor(rm)) return closeMenu();
    openMenu(rm, { className: 'mini right', keyboard: e.detail === 0, build: () => rowMenu(r), sub: () => sourceSub(r), onPick: (mi) => { setTimeout(() => rowAction(mi.dataset.act, r)); } });
    return;
  }
  const cact = t.closest('[data-cact]');
  if (cact) return creatorAction(cact.dataset.cact);
  const ract = t.closest('[data-ract]');
  if (ract) return rowAction(ract.dataset.ract, S.rows.find((x) => x.id === ract.dataset.id));
  const op = t.closest('[data-open]');
  if (op) return openPath(op.dataset.open);
  const pick = t.closest('[data-pick]');
  if (pick) {
    const id = pick.dataset.pick;
    if (S.picked.has(id)) S.picked.delete(id);
    else S.picked.add(id);
    return renderBody();
  }
  if (t.closest('[data-pickall]')) {
    const all = S.list.every((r) => S.picked.has(r.id));
    S.list.forEach((r) => (all ? S.picked.delete(r.id) : S.picked.add(r.id)));
    return renderBody();
  }
  if (t.closest('[data-unpick]')) { S.picked.clear(); return renderBody(); }
  const bulk = t.closest('[data-bulk]');
  if (bulk) {
    const a = bulk.dataset.bulk;
    postAction([...S.picked], a === 'done' ? 'mark_done' : a === 'undone' ? 'mark_undone' : 'download', a === 'from-fanbox' ? 'fanbox' : undefined);
    return;
  }
  const un = t.closest('[data-unchip]');
  if (un) { const [d, k] = un.dataset.unchip.split('|'); sel[d].delete(k); return renderBody(); }
  if (t.closest('[data-clearall]')) {
    Object.values(sel).forEach((s) => s.clear());
    S.q = '';
    S.el.querySelector('#psearch').value = '';
    return renderBody();
  }
  const cov = t.closest('[data-cov]');
  if (cov) { sel.cov = new Set(['c:' + cov.dataset.cov]); S.limit = PAGE; return renderBody(); }
  if (t.closest('[data-more]')) { S.limit += PAGE; return renderBody(); }
  if (t.closest('[data-all]')) { S.limit = S.list.length; return renderBody(); }
  const card = t.closest('[data-card]');
  if (card && !btn) return openDrawer(card.dataset.card);
  const tg = t.closest('[data-toggle]');
  if (tg && !btn) {
    const id = tg.dataset.toggle;
    if (S.open.has(id)) { S.open.delete(id); renderBody(); }
    else { S.open.add(id); renderBody(); loadDetail(id); }
  }
}

async function reload() {
  if (!S) return;
  const [detail, rows] = await Promise.all([api(`creators/${S.cid}`), api(`creators/${S.cid}/posts`)]);
  S.detail = detail;
  S.rows = rows;
  for (const id of S.open) loadDetail(id);
  render();
}

export async function mountCreator(el, cid, onChange) {
  closeMenu();
  S?.abort.abort();
  const abort = new AbortController();
  S = { el, cid, q: '', open: new Set(), picked: new Set(), details: new Map(), rows: [], detail: null, limit: PAGE, list: [], abort, onChange };
  el.addEventListener('click', onClick, { signal: abort.signal });
  try {
    await reload();
  } catch (e) {
    el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

export function unmountCreator() {
  S?.abort.abort();
  S?.el.classList.remove('with-thumbs');
  S = null;
  renderDrawer();
}

// Called when a job for this creator finishes, so the list reflects it without a reload.
export function refreshCreator(cid) {
  if (S && S.cid === cid) {
    S.details.clear();
    reload().catch(() => {});
  }
}

export const currentCreator = () => S?.cid;
