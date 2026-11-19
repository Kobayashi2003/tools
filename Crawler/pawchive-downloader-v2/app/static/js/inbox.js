import { api, at, attempt, esc, fmtSize, isActive, localOffset, prefs, toast } from './api.js';
import { I } from './icons.js';
import { on, patch } from './live.js';
import { emptyState, skeletonRows } from './ui.js';

// The Inbox: posts that finished downloading, newest first, so what is new in the download
// folder can be looked through before the folders are moved by hand. It only reads: no
// button here moves, renames or deletes anything. "Reviewed" is a mark kept in this
// browser, not in the database.

const DAYS = 14;
const LIMIT = 1000;

const utcNow = () => new Date().toISOString().slice(0, 19);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 19);

// Everything after this was downloaded since the Inbox was last marked as reviewed.
export const inboxSince = () => prefs.get('inboxSeen') || daysAgo(DAYS);

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

let B = null;

function localDay(utc) {
  const d = at(utc, localOffset());
  return d ? d.date : '';
}

function dayLabel(day) {
  const today = at(utcNow(), localOffset()).date;
  const yesterday = at(daysAgo(1), localOffset()).date;
  return day === today ? 'Today' : day === yesterday ? 'Yesterday' : day;
}

function rowHTML(p, seen) {
  const thumb = `api/thumbs/${encodeURIComponent(p.creator_id)}/${encodeURIComponent(p.post_id)}?w=640`;
  const t = at(p.done_at, localOffset());
  return `<div class="ib-row ${seen ? 'seen' : ''}" data-key="${esc(p.post_id)}">
    <span class="ib-thumb"><img class="thumb" src="${thumb}" data-thumb-inbox alt="" loading="lazy" decoding="async"></span>
    <span class="t"><a href="#/c/${encodeURIComponent(p.creator_id)}?post=${encodeURIComponent(p.post_id)}" title="${esc(p.title)}">${esc(p.title || '(untitled)')}</a>
      <small><span class="mono">${esc(p.post_id)}</span> · published ${esc((p.published || '').slice(0, 10))} · done ${t ? t.time : ''}</small></span>
    <span class="n">${plural(p.files, 'file')}</span>
    <span class="n">${p.bytes ? fmtSize(p.bytes) : ''}</span>
    <button class="btn sm" type="button" data-open="${esc(p.dir)}" title="${esc(p.dir)}">${I.folder}Open folder</button>
  </div>`;
}

// One section per local day, one panel per creator inside it.
function daysHTML(items, seen, prefix) {
  const days = new Map();
  for (const p of items) {
    const day = localDay(p.done_at);
    if (!days.has(day)) days.set(day, new Map());
    const byCreator = days.get(day);
    if (!byCreator.has(p.creator_id)) byCreator.set(p.creator_id, []);
    byCreator.get(p.creator_id).push(p);
  }
  return [...days.entries()].map(([day, byCreator]) => {
    const n = [...byCreator.values()].reduce((s, list) => s + list.length, 0);
    return `<section class="ib-day" data-key="${prefix}${day}"><h2>${esc(dayLabel(day))}<small>${plural(n, 'post')}</small></h2>
      ${[...byCreator.entries()].map(([cid, list]) => `<div class="panel ib-cr" data-key="${esc(cid)}">
        <div class="ib-cr-head"><a href="#/c/${encodeURIComponent(cid)}">${esc(list[0].creator_name)}</a><span class="muted">${esc(list[0].group || 'Ungrouped')} · ${plural(list.length, 'post')}</span>
          <button class="linkbtn" type="button" data-open="${esc(list[0].creator_dir)}" title="${esc(list[0].creator_dir)}">Open creator folder</button></div>
        ${list.map((p) => rowHTML(p, seen)).join('')}</div>`).join('')}
    </section>`;
  }).join('');
}

function bodyHTML() {
  const seenAt = prefs.get('inboxSeen');
  const fresh = B.items.filter((p) => !seenAt || p.done_at > seenAt);
  const old = B.items.filter((p) => seenAt && p.done_at <= seenAt);
  if (!B.items.length) return `<section class="panel" data-key="none">${emptyState({ icon: I.dl, title: 'Nothing downloaded lately', hint: `Posts that finish downloading in the next ${DAYS} days show up here, newest first.` })}</section>`;
  const mark = seenAt ? `<div class="ib-mark" data-key="mark">Reviewed up to ${esc(localDay(seenAt))} ${esc(at(seenAt, localOffset()).time)}</div>` : '';
  return `${fresh.length ? daysHTML(fresh, false, 'n') : `<section class="panel" data-key="caught">${emptyState({ icon: I.check, title: 'All caught up', hint: 'Nothing has finished downloading since you last marked the Inbox as reviewed. What came before is below.' })}</section>`}
    ${old.length ? `${mark}${daysHTML(old, true, 's')}` : ''}
    ${B.items.length >= LIMIT ? `<div class="muted" data-key="cap">Showing the latest ${LIMIT.toLocaleString()} posts.</div>` : ''}`;
}

function headHTML() {
  const seenAt = prefs.get('inboxSeen');
  const fresh = B.items.filter((p) => !seenAt || p.done_at > seenAt).length;
  return `<span class="muted" data-key="t">${seenAt ? `${plural(fresh, 'post')} since your last review` : `${plural(B.items.length, 'post')} in the last ${DAYS} days`}</span>
    <button class="btn primary" type="button" data-key="b" data-seen ${fresh ? '' : 'disabled'}>Mark all as reviewed</button>`;
}

function draw() {
  patch(B.el.querySelector('[data-part="head"]'), headHTML());
  patch(B.el.querySelector('[data-part="body"]'), bodyHTML());
}

async function load() {
  const mine = B;
  // From the last review, or two weeks back, whichever reaches further.
  const seenAt = prefs.get('inboxSeen');
  const floor = daysAgo(DAYS);
  const since = seenAt && seenAt < floor ? seenAt : floor;
  const items = await api(`recent?since=${encodeURIComponent(since)}&limit=${LIMIT}`);
  if (B !== mine) return;
  B.items = items;
  draw();
}

export async function mountInbox(el) {
  B = { el, items: [] };
  const mine = B;
  el.innerHTML = `<div class="view wide">
    <div class="view-head"><div><h1>Inbox</h1><p class="lede">Posts that finished downloading, newest first. Look through them, then move the folders where they belong by hand; nothing here moves or deletes files.</p></div>
      <div class="row-inline" data-part="head"></div></div>
    <div class="view" style="padding:0" data-part="body"><section class="panel">${skeletonRows(8, { height: 72 })}</section></div>
  </div>`;
  await load();
  // A finished download adds posts: read the list again and patch it in.
  let active = null;
  const off = on('jobs', (jobs) => {
    const now = new Set(jobs.filter((j) => isActive(j) && j.kind === 'download').map((j) => j.id));
    if (active && [...active].some((id) => !now.has(id))) load().catch(() => {});
    active = now;
  });
  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.open) {
      const out = await attempt(() => api('open', { method: 'POST', body: { path: b.dataset.open } }));
      if (out && !out.exact) toast('That folder is not there any more (moved?); opened the nearest parent');
    } else if (b.dataset.seen !== undefined) {
      prefs.set('inboxSeen', utcNow());
      draw();
      window.dispatchEvent(new Event('inbox-seen'));
    }
  };
  // A cover that is not there becomes the same quiet placeholder the creator page uses.
  const abort = new AbortController();
  el.addEventListener('error', (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.hasAttribute('data-thumb-inbox')) {
      const ph = document.createElement('span');
      ph.className = 'thumb none';
      img.replaceWith(ph);
    }
  }, { capture: true, signal: abort.signal });
  return { cleanup: () => { off(); abort.abort(); if (B === mine) B = null; } };
}
