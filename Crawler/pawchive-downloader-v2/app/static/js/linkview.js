import { api, attempt, esc, isActive } from './api.js';
import { dialog } from './dialog.js';
import { I } from './icons.js';
import { on, patch } from './live.js';
import { actionItem, closeMenu, linkItem, menuOpenFor, openMenu } from './menu.js';
import { emptyState, skeletonRows } from './ui.js';

// Cloud-storage links found in post text. A link a host can check shows whether it still
// opens; one a host can fetch is saved into its post's download folder under links/ and then
// counts as done. Anything else is opened in the browser and marked by hand.
// A check that finds a link dead marks it failed; one that finds a failed link alive again
// makes it new.
const STATES = [['new', 'New'], ['done', 'Done'], ['failed', 'Failed'], ['skipped', 'Skipped'], ['', 'All']];
const LABEL = { new: 'New', done: 'Done', skipped: 'Skipped', failed: 'Failed' };
const STATE_CHIP = { done: 'k-done', failed: 'k-failed', skipped: 'k-ignored' };
const CHECK = { alive: ['k-done', 'Alive'], dead: ['k-failed', 'Dead'], unknown: ['k-wait', 'Unknown'] };
const ALIVE = [['', 'Any'], ['alive', 'Alive'], ['dead', 'Dead'], ['unchecked', 'Unchecked']];
const KEY_FROM = { text: 'key from the post text', manual: 'key entered by hand' };
// Rows a creator's group shows before "Show all".
const FOLD = 8;
const HELP = 'Google Drive, MEGA and Dropbox links can be checked and fetched, GigaFile links checked. '
  + 'What a fetch saves goes into the post\'s download folder under links/, and the link counts as done. '
  + 'A check that finds a link dead marks it failed. Others are opened here and marked by hand.';

// Kept between visits: which list you were working through.
let state = 'new';
let V = null;

const fetchable = (l) => l.fetcher && l.state === 'new' && l.check_state !== 'dead' && (!l.needs_key || l.key_hints.length);
const wantsKey = (l) => l.needs_key && l.check_state !== 'dead';
const postLink = (l) => `#/c/${encodeURIComponent(l.creator_id)}?post=${encodeURIComponent(l.post_id)}`;

function checkChip(l) {
  if (!l.check_state) return l.checker ? '<span class="chip k-pending" title="Not checked yet">Unchecked</span>' : '';
  const [cls, label] = CHECK[l.check_state] || ['', l.check_state];
  return `<span class="chip ${cls}" title="${esc(`${l.check_note || ''}${l.checked_at ? ` · checked ${l.checked_at.slice(0, 16).replace('T', ' ')} UTC` : ''}`)}">${label}</span>`;
}

// One button for the likeliest next step; the rest in the row's menu.
function primary(l) {
  if (fetchable(l)) return `<button class="btn sm" type="button" data-fetch="${l.id}" title="Save it into the post's download folder under links/">${I.dl}Fetch</button>`;
  if (wantsKey(l)) return `<button class="btn sm" type="button" data-setkey="${l.id}" title="${l.key_hints.length ? 'The post text has a likely key; check it or enter one' : 'Posted without its key: enter it'}">Key…</button>`;
  return `<a class="btn sm" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="Open it in a new tab">${I.ext}Open</a>`;
}

function linkRow(l) {
  const said = l.fetch_error
    ? `Fetch failed: ${l.fetch_error}`
    : [l.check_state && l.check_note, l.key && KEY_FROM[l.key_source]].filter(Boolean).join(' · ');
  const retry = l.fetch_error && fetchable(l) ? `<button class="linkbtn" type="button" data-fetch="${l.id}">Retry</button>` : '';
  const note = said ? `<span class="lk-note ${l.fetch_error ? 'bad' : ''}"><span class="clip" title="${esc(said)}">${esc(said)}</span>${retry}</span>` : '';
  return `<div class="lk-row ${l.state}" data-key="${l.id}">
    <span class="lk-host mono" title="${esc(l.host)}">${esc(l.host)}</span>
    <span class="lk-main"><a class="lk-url" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="${esc(l.url)}">${esc(l.url)}${I.ext}</a>${note}</span>
    <a class="lk-post" href="${postLink(l)}" title="${esc(l.title)}"><span class="mono muted">${esc((l.published || '').slice(0, 10))}</span> ${esc(l.title)}</a>
    <span class="lk-acts">${checkChip(l)}${l.state === 'new' ? '' : `<span class="chip ${STATE_CHIP[l.state] || ''}">${LABEL[l.state] || l.state}</span>`}${l.state === 'new' ? primary(l) : ''}
      <div class="dd"><button type="button" class="kebab" data-lmenu="${l.id}" aria-label="Link actions" aria-haspopup="true" aria-expanded="false">${I.dots}</button></div></span>
  </div>`;
}

function rowMenu(l) {
  return `<div class="menu-body">
    ${l.checker ? actionItem({ act: 'check', label: `Check with ${esc(l.checker)}`, icon: I.sync }) : ''}
    ${wantsKey(l) && fetchable(l) ? actionItem({ act: 'key', label: 'Decryption key…', icon: I.edit }) : ''}
    ${linkItem({ href: esc(l.url), label: 'Open the link' })}
    <div class="sep"></div>
    ${l.state === 'new'
      ? `${actionItem({ act: 'done', label: 'Mark as done', icon: I.check })}${actionItem({ act: 'skipped', label: 'Skip', icon: I.x })}`
      : actionItem({ act: 'new', label: 'Show as new again', icon: I.reset })}
  </div>`;
}

function shown() {
  const q = V.q.trim().toLowerCase();
  return V.links.filter((l) => (!V.hosts.size || V.hosts.has(l.host))
    && (!V.alive || (V.alive === 'unchecked' ? !l.check_state : l.check_state === V.alive))
    && (!q || `${l.url} ${l.title} ${l.creator_name}`.toLowerCase().includes(q)));
}

function filtersHTML() {
  const hosts = new Map();
  for (const l of V.links) hosts.set(l.host, (hosts.get(l.host) || 0) + 1);
  return `<div class="lk-hosts" data-key="hosts">${[...hosts.entries()].sort((a, b) => b[1] - a[1]).map(([h, n]) => `<button type="button" class="hchip" data-key="${esc(h)}" data-host="${esc(h)}" aria-pressed="${V.hosts.has(h)}">${esc(h)}<span class="num">${n.toLocaleString()}</span></button>`).join('')}</div>
    <div class="seg" data-key="alive" role="group" aria-label="Check result">${ALIVE.map(([k, l]) => `<button type="button" data-alive="${k}" aria-pressed="${V.alive === k}">${l}</button>`).join('')}</div>`;
}

function bodyHTML() {
  const list = shown();
  const groups = new Map();
  for (const l of list) {
    if (!groups.has(l.creator_id)) groups.set(l.creator_id, []);
    groups.get(l.creator_id).push(l);
  }
  if (!groups.size) {
    const filtered = V.hosts.size || V.alive || V.q.trim();
    return `<section class="panel" data-key="none">${filtered
      ? emptyState({ icon: I.search, title: 'No links match', hint: 'Nothing in this list passes the host, check and search filters.', action: '<button class="btn sm" type="button" data-clear>Clear filters</button>' })
      : emptyState({ icon: state === 'new' ? I.check : I.link, title: state === 'new' ? 'No new links' : `No ${(LABEL[state] || '').toLowerCase()} links`.replace('  ', ' '), hint: 'Links to Google Drive, MEGA, Dropbox, GigaFile and the other hosts in Settings are collected from post text on every sync.' })}</section>`;
  }
  return [...groups.entries()].map(([cid, items]) => {
    const fresh = items.filter((l) => l.state === 'new');
    const checkable = items.filter((l) => l.checker);
    const canFetch = items.filter(fetchable);
    const open = V.expanded.has(cid) || items.length <= FOLD;
    return `<section class="panel lk-group" data-key="g:${esc(cid)}">
      <div class="panel-head"><h2><a href="#/c/${encodeURIComponent(cid)}">${esc(items[0].creator_name)}</a> <span class="muted">${items.length.toLocaleString()}</span></h2>
        <span class="lk-bulk">
        ${checkable.length ? `<button class="btn sm" type="button" data-check="${checkable.map((l) => l.id).join(',')}">${I.sync}Check ${checkable.length}</button>` : ''}
        ${canFetch.length ? `<button class="btn sm" type="button" data-fetch="${canFetch.map((l) => l.id).join(',')}">${I.dl}Fetch ${canFetch.length}</button>` : ''}
        ${fresh.length ? `<button class="btn sm" type="button" data-mark="done" data-ids="${fresh.map((l) => l.id).join(',')}">${I.check}Mark ${fresh.length} done</button>` : ''}
        </span></div>
      <div class="lk-list">${(open ? items : items.slice(0, FOLD)).map(linkRow).join('')}</div>
      ${open ? '' : `<div class="lk-more"><button class="linkbtn" type="button" data-expand="${esc(cid)}">Show all ${items.length.toLocaleString()}</button></div>`}
    </section>`;
  }).join('');
}

function draw() {
  if (!V) return;
  patch(V.el.querySelector('[data-part="filters"]'), filtersHTML());
  patch(V.el.querySelector('[data-part="body"]'), bodyHTML());
}

async function refresh() {
  const mine = V;
  try {
    const links = await api(`links?state=${state}${mine.creator ? `&creator_id=${encodeURIComponent(mine.creator)}` : ''}`);
    if (V !== mine) return;
    V.links = links;
  } catch (e) {
    if (V !== mine) return;
    V.el.querySelector('[data-part="body"]').innerHTML = `<div class="empty-note">${esc(e.message)}</div>`;
    return;
  }
  // A host no longer in the list cannot stay chosen.
  const hosts = new Set(V.links.map((l) => l.host));
  V.hosts.forEach((h) => { if (!hosts.has(h)) V.hosts.delete(h); });
  draw();
}

async function enterKey(l) {
  const hints = l.key_hints;
  const got = await dialog({
    title: 'Decryption key',
    body: `<p class="mono" style="word-break:break-all">${esc(l.url)}</p><p>${hints.length
      ? `The post text holds ${hints.length > 1 ? `${hints.length} strings that look like its key; the likeliest is filled in` : 'a string that looks like its key; it is filled in'}. A check tries it against the host.`
      : 'Posted without its key, and the post text shows none. Paste the key (the part after # in the full link).'}</p>`,
    fields: [{ name: 'key', label: 'Key', value: hints[0] || '', options: hints.length > 1 ? hints : undefined, placeholder: 'e.g. N8fkV-FoUINJ1qg1Ra62BQ' }],
    confirm: 'Save and check',
  });
  if (!got || !got.key.trim()) return;
  const out = await attempt(() => api('links/key', { method: 'POST', body: { id: l.id, key: got.key.trim() } }), 'Key saved; checking');
  if (out) refresh();
}

async function mark(ids, to) {
  if (await attempt(() => api('links/state', { method: 'POST', body: { ids, state: to } }))) refresh();
}

async function run(kind, ids, button) {
  const out = await attempt(
    () => api(`links/${kind}`, { method: 'POST', body: { ids } }),
    `${kind === 'fetch' ? 'Fetching' : 'Checking'} ${ids.length} link${ids.length > 1 ? 's' : ''}; this page updates when the job is done`,
  );
  if (out && button) button.disabled = true;
}

export async function mountLinks(el, params) {
  V = { el, creator: params.get('creator') || '', links: [], hosts: new Set(), alive: '', q: '', expanded: new Set() };
  const mine = V;
  el.innerHTML = `<div class="view wide">
    <div class="view-head"><div><h1>Links<span class="help-tip" title="${esc(HELP)}">${I.help}</span></h1><p class="lede">Cloud-storage links found in post text.</p></div>
      <div class="seg" role="group" aria-label="Show">${STATES.map(([k, l]) => `<button type="button" data-state="${k}" aria-pressed="${state === k}">${l}</button>`).join('')}</div></div>
    <div class="lk-tools">
      <label class="field">${I.search}<input data-q placeholder="URL, post title or creator" autocomplete="off"></label>
      ${V.creator ? `<span class="fchip"><b>Creator</b><span data-who>${esc(V.creator)}</span><a class="linkbtn" href="#/links" aria-label="All creators">${I.x}</a></span>` : ''}
      <div class="lk-tools" data-part="filters"></div>
    </div>
    <div class="view" style="padding:0" data-part="body"><section class="panel">${skeletonRows(8, { height: 48 })}</section></div>
  </div>`;
  el.querySelector('[data-q]').addEventListener('input', (e) => { V.q = e.target.value; draw(); });
  await refresh();
  if (V === mine && V.creator && V.links[0]) el.querySelector('[data-who]').textContent = V.links[0].creator_name;

  // Check and fetch run as jobs; when one ends the list is read again and patched.
  let active = null;
  const off = on('jobs', (jobs) => {
    const now = new Set(jobs.filter((j) => isActive(j) && (j.kind === 'link_check' || j.kind === 'link_fetch')).map((j) => j.id));
    if (active && [...active].some((id) => !now.has(id))) refresh();
    active = now;
  });

  el.onclick = async (e) => {
    const lm = e.target.closest('[data-lmenu]');
    if (lm) {
      const l = V.links.find((x) => x.id === Number(lm.dataset.lmenu));
      if (menuOpenFor(lm)) return closeMenu();
      openMenu(lm, { className: 'mini right', keyboard: e.detail === 0, build: () => rowMenu(l), onPick: (mi) => {
        const act = mi.dataset.act;
        setTimeout(() => {
          if (act === 'check') run('check', [l.id]);
          else if (act === 'key') enterKey(l);
          else if (act) mark([l.id], act);
        });
      } });
      return;
    }
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.state !== undefined) {
      state = b.dataset.state;
      b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      V.expanded.clear();
      refresh();
    } else if (b.dataset.host) {
      if (V.hosts.has(b.dataset.host)) V.hosts.delete(b.dataset.host); else V.hosts.add(b.dataset.host);
      draw();
    } else if (b.dataset.alive !== undefined) {
      V.alive = b.dataset.alive;
      draw();
    } else if (b.dataset.clear !== undefined) {
      V.hosts.clear();
      V.alive = '';
      V.q = '';
      el.querySelector('[data-q]').value = '';
      draw();
    } else if (b.dataset.expand) {
      V.expanded.add(b.dataset.expand);
      draw();
    } else if (b.dataset.mark) {
      mark(b.dataset.ids.split(',').map(Number), b.dataset.mark);
    } else if (b.dataset.setkey) {
      const l = V.links.find((x) => x.id === Number(b.dataset.setkey));
      if (l) enterKey(l);
    } else if (b.dataset.check || b.dataset.fetch) {
      const fetch = Boolean(b.dataset.fetch);
      run(fetch ? 'fetch' : 'check', (b.dataset.fetch || b.dataset.check).split(',').map(Number), b);
    }
  };
  return { cleanup: () => { off(); if (V === mine) V = null; } };
}
