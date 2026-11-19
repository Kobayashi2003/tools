import { api, attempt, esc, fmtCount, fmtSize, groupEvents, localTime } from './api.js';
import { I } from './icons.js';
import { on, patch } from './live.js';
import { emptyState, skeletonRows } from './ui.js';

// The overview. The layout, not the data, decides each panel's size: on a wide screen the
// page fills the window and every panel keeps its place whether it is loading, sparse or
// full; long content scrolls inside its panel. Each panel is patched on its own: the tiles
// follow the creator list and the live state, the activity feed follows the event stream,
// and the panels that classify every post arrive once the server has counted them.

const SESSION = {
  none: ['Not set', 'mute'],
  unchecked: ['Unverified', 'wait'],
  valid: ['Valid', 'ok'],
  rejected: ['Rejected', 'bad'],
};

// Kept posts by local state, in the order a reader scans them: settled, then the work left.
const STATES = [
  ['done', 'Done', 'ok'], ['partial', 'Partial', 'warn'], ['pending', 'Pending', 'warn'],
  ['failed', 'Failed', 'bad'], ['blocked', 'Blocked', 'block'], ['na', 'Unavailable', 'mute'],
  ['filtered', 'Filtered', 'line'],
];

// [key, dot, label, unit, filter on the creator page]
const ISSUES = [
  ['failed', 'bad', 'Failed downloads', 'posts', 's:failed'],
  ['blocked', 'block', 'Blocked: Pawchive 404, no other source', 'posts', 's:blocked'],
  ['mismatch', 'bad', 'Files that failed their check', 'posts', 'm:bad'],
  ['stale', 'warn', 'Updated upstream since download', 'posts', 'm:stale'],
  ['unverified', 'mute', 'Adopted, unverified', 'posts', 'm:unverified'],
  ['links', 'warn', 'New cloud-storage links', 'links', null],
  ['unsynced', 'mute', 'Not synced for 30 days', 'creators', null],
];

// Retries an hour apart are still one story on the overview.
const FEED_WINDOW = 2 * 60 * 60 * 1000;
const FEED_ROWS = 40;
const RANK_ROWS = 12;

let H = null;

const nameOf = (id) => {
  const c = H.creators.find((x) => x.id === id);
  return c ? c.alias || c.name : id;
};

// "Sync 遠藤弘土: …" next to a 遠藤弘土 link reads as "Sync: …".
function withoutName(text, name) {
  if (!name) return text;
  for (const sep of [': ', '：']) {
    if (text.startsWith(name + sep)) return text.slice(name.length + sep.length);
    if (text.includes(` ${name}${sep}`)) return text.replace(` ${name}${sep}`, sep);
  }
  return text;
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const creatorLink = (id, filter) => `#/c/${encodeURIComponent(id)}${filter ? `?f=${encodeURIComponent(filter)}` : ''}`;
// A panel: a fixed head, then a body that scrolls on its own.
const head = (title, meta = '') => `<div class="panel-head" data-key="h"><h2>${title}</h2>${meta ? `<span class="muted">${meta}</span>` : ''}</div>`;
const body = (html, cls = '') => `<div class="pbody ${cls}" data-key="b">${html}</div>`;

// ---------------------------------------------------------------- tiles

function statsHTML() {
  const cs = H.creators;
  const active = cs.filter((c) => !c.ignore);
  const total = cs.reduce((n, c) => n + c.total, 0);
  const done = cs.reduce((n, c) => n + c.done, 0);
  const fetchable = active.reduce((n, c) => n + c.fetchable, 0);
  const waiting = active.filter((c) => c.fetchable).length;
  const blocked = active.reduce((n, c) => n + (c.blocked || 0), 0);
  const fanboxes = active.filter((c) => c.service === 'fanbox');
  const checked = fanboxes.filter((c) => c.f_checked).length;
  const pct = total ? (done / total) * 100 : 0;
  const s = H.state?.session || {};
  const [sessionLabel, sessionDot] = SESSION[s.state || 'none'] || SESSION.none;
  const quota = H.state?.quota;
  const meter = (p, cls = '') => `<span class="meter wide ${cls}"><i style="width:${Math.min(100, p).toFixed(1)}%"></i></span>`;
  // Every tile is label · aside / value / foot left · foot right: one height, one baseline,
  // and something on both sides so no tile leans on its left edge.
  const tile = (key, { label, aside = '', value, left = '', right = '', cls = '', title = '' }) => `<div class="tile kpi ${cls}" data-key="${key}" title="${esc(title)}">
    <span class="st-top"><span class="h">${label}</span><span class="aside">${aside}</span></span>
    <span class="v">${value}</span>
    <span class="st-foot"><span class="l">${left}</span><span class="r">${right}</span></span></div>`;
  return [
    tile('posts', { label: 'Posts', value: total.toLocaleString(), left: `in ${plural(cs.length, 'creator')}`, right: 'both sources' }),
    tile('done', { label: 'Done', aside: `${pct.toFixed(1)}%`, value: done.toLocaleString(), left: meter(pct), cls: 'ok' }),
    tile('dl', {
      label: 'To download', value: fetchable.toLocaleString(), cls: fetchable ? 'warn' : '',
      left: fetchable ? `from ${plural(waiting, 'creator')}` : 'Nothing waiting',
      right: blocked ? `<span class="state-dot block"></span>${blocked.toLocaleString()} blocked` : '',
      title: 'Posts a source can deliver that are not fully downloaded. Blocked posts (Pawchive 404, no other source) are not counted.',
    }),
    tile('fanbox', {
      label: 'Fanbox session', value: `<span class="state-dot ${sessionDot}"></span>${sessionLabel}`,
      left: fanboxes.length ? `${checked} of ${fanboxes.length} creators checked` : 'No Fanbox creators',
      title: 'Saved Fanbox creators are checked in the background, one at a time, every 7 days',
    }),
    quota?.enabled
      ? tile('quota', { label: 'Pawchive quota', aside: `of ${fmtSize(quota.limit)}`, value: `${fmtSize(quota.remaining)}`, left: meter(quota.limit ? (quota.remaining / quota.limit) * 100 : 0, 'quota'), right: `resets in ${esc(quota.resets_in)}` })
      : tile('quota', { label: 'Pawchive quota', value: 'None', left: 'No daily quota set', right: '<a href="#/settings">Settings</a>' }),
  ].join('');
}

// ---------------------------------------------------------------- panels

function issuesHTML() {
  const o = H.overview;
  if (!o) return head('Needs a look') + body(skeletonRows(6, { height: 46 }));
  const rows = ISSUES.filter(([key]) => o.issues[key]);
  const href = (key, filter, id) => (key === 'links' ? `#/links?creator=${encodeURIComponent(id)}` : creatorLink(id, filter));
  if (!rows.length) return head('Needs a look') + body(emptyState({ icon: I.check, title: 'Nothing needs a look', hint: 'Failures, files that fail their check, posts updated upstream and new links show up here.' }));
  return head('Needs a look', `${plural(rows.length, 'kind')} of issue`) + body(`<div class="lines" data-key="list">${rows.map(([key, dot, label, unit, filter]) => {
    const it = o.issues[key];
    const n = unit === 'creators' ? it.n : it.posts;
    const who = it.who || [];
    const names = who.slice(0, 3).map(([id]) => esc(nameOf(id))).join(', ') + (who.length > 3 ? ` and ${who.length - 3} more` : '');
    const inner = `<span class="state-dot ${dot}"></span><span class="issue-t">${label}<small>${names}</small></span><b class="num" title="${n.toLocaleString()} ${unit}">${fmtCount(n)}</b>`;
    // One creator: the row goes straight there. Several: it opens the list of them.
    if (who.length === 1) return `<a class="issue" data-key="${key}" href="${href(key, filter, who[0][0])}">${inner}<span class="go">›</span></a>`;
    return `<details data-key="${key}" ${H.openIssues.has(key) ? 'open' : ''}><summary class="issue">${inner}<span class="go">›</span></summary>
      <div class="issue-who">${who.map(([id, count]) => `<a href="${href(key, filter, id)}"><span>${esc(nameOf(id))}</span><span class="num">${unit === 'creators' ? '' : count.toLocaleString()}</span></a>`).join('')}</div></details>`;
  }).join('')}</div>`);
}

// What is left to get, in two parts: posts a run will fetch, and posts that wait on you
// (a plan for the creator's own site, or a download by hand once Pawchive has the files).
function rankHTML() {
  const live = H.creators.filter((c) => !c.ignore);
  const waiting = live.filter((c) => c.fetchable).sort((a, b) => b.fetchable - a.fetchable);
  const blocked = live.filter((c) => c.blocked).sort((a, b) => b.blocked - a.blocked);
  const rest = live.filter((c) => !c.completed && !c.fetchable && !c.blocked).length;
  const row = (c, n, what, cls = '') => {
    const p = c.total ? (c.done / c.total) * 100 : 0;
    return `<a class="rank-row ${cls}" data-key="${esc(c.id)}" href="${creatorLink(c.id, cls ? 's:blocked' : '')}">
      <span class="rank-name"><b>${esc(c.alias || c.name)}</b><small>${esc(c.group || 'Ungrouped')}</small></span>
      <span class="rank-bar" title="${c.done.toLocaleString()} of ${c.total.toLocaleString()} done (${p.toFixed(0)}%)"><i style="width:${p.toFixed(1)}%"></i></span>
      <span class="rank-n" title="${n.toLocaleString()} posts"><b class="num">${fmtCount(n)}</b><small>${what}</small></span></a>`;
  };
  const sum = (list, key) => list.reduce((n, c) => n + c[key], 0);
  if (!waiting.length && !blocked.length) {
    return head('Left to download') + body(emptyState({ icon: I.check, title: 'Nothing left to download', hint: 'Every creator is up to date.' }));
  }
  return head('Left to download', plural(waiting.length + blocked.length, 'creator')) + body(`
    <div class="rank-sec" data-key="waiting">
      <div class="psub"><span>Waiting for a run</span><span>${plural(sum(waiting, 'fetchable'), 'post')}</span></div>
      ${waiting.length ? `<div class="lines">${waiting.slice(0, RANK_ROWS).map((c) => row(c, c.fetchable, 'to get')).join('')}</div>` : '<div class="rank-none">No posts waiting: the next run has nothing to fetch.</div>'}
    </div>
    ${blocked.length ? `<div class="rank-sec" data-key="blocked">
      <div class="psub"><span>Blocked</span><span>${plural(sum(blocked, 'blocked'), 'post')} · Pawchive 404, no other source</span></div>
      <div class="lines">${blocked.slice(0, RANK_ROWS).map((c) => row(c, c.blocked, 'blocked', 'blocked')).join('')}</div>
    </div>` : ''}
    <div class="pfoot" data-key="foot"><span>${plural(rest, 'other creator')} with nothing left</span></div>`);
}

// Local status, what was downloaded day by day and where files came from: one panel, three
// parts, all about what is on disk.
function statusHTML() {
  const o = H.overview;
  if (!o) {
    return head('Local status') + body(`<div class="sk-status" data-key="loading" aria-busy="true"><span class="sk sk-bar"></span><span class="sk sk-line" style="width:70%"></span>
      <span class="sk sk-chart"></span><span class="sk sk-chart"></span><span class="sk sk-line" style="width:55%"></span><span class="sk sk-line" style="width:45%"></span></div>`);
  }
  const total = STATES.reduce((n, [k]) => n + (o.status[k] || 0), 0) || 1;
  const shown = STATES.filter(([k]) => o.status[k]);
  const got = [['pawchive', 'Pawchive'], ['fanbox', 'Fanbox'], ['local', 'Found on disk']].filter(([k]) => o.got[k]);
  const files = got.reduce((n, [k]) => n + o.got[k], 0);
  const days = Array.from({ length: o.days }, (_, i) => {
    const d = new Date(o.first_day + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  const get = (day, via) => o.daily.find((r) => r.day === day && r.via === via) || { files: 0, bytes: 0 };
  const max = Math.max(1, ...o.daily.map((r) => r.files));
  const sum = (via) => o.daily.filter((r) => r.via === via).reduce((a, r) => ({ files: a.files + r.files, bytes: a.bytes + r.bytes }), { files: 0, bytes: 0 });
  // One row per source rather than one stacked bar: the two source hues are too close for
  // some readers to tell apart, and their row names them anyway.
  const line = (via, label, cls) => {
    const t = sum(via);
    return `<div class="drow" data-key="${via}"><span class="dlabel"><b>${label}</b><small title="${t.files.toLocaleString()} files">${fmtCount(t.files)} files · ${fmtSize(t.bytes)}</small></span>
      <span class="dbars">${days.map((day) => {
        const r = get(day, via);
        const h = r.files ? Math.max(2, Math.round((r.files / max) * 40)) : 0;
        return `<span class="dcol" title="${day} · ${label}: ${r.files.toLocaleString()} files, ${fmtSize(r.bytes)}"><i class="${cls}" style="height:${h}px"></i></span>`;
      }).join('')}</span></div>`;
  };
  return head('Local status', `${total.toLocaleString()} posts`) + body(`
    <div class="psec" data-key="status">
      <div class="sbar" role="img" aria-label="${shown.map(([k, l]) => `${l} ${o.status[k]}`).join(', ')}">${shown.map(([k, l, c]) => `<i class="b-${c}" style="flex-grow:${o.status[k]}" title="${l}: ${o.status[k].toLocaleString()} (${((o.status[k] / total) * 100).toFixed(1)}%)"></i>`).join('')}</div>
      <div class="slegend">${shown.map(([k, l, c]) => `<span><i class="b-${c}"></i>${l}<b class="num">${o.status[k].toLocaleString()}</b></span>`).join('')}</div>
    </div>
    <div class="psec" data-key="daily">
      <div class="psub"><span>Downloaded</span><span>last ${o.days} days</span></div>
      ${line('pawchive', 'Pawchive', 'src-p')}${line('fanbox', 'Fanbox', 'src-f')}
      <div class="daxis"><span></span><span class="mono">${days[0].slice(5)}</span><span class="mono">today</span></div>
    </div>
    <div class="psec" data-key="got">
      <div class="psub"><span>Files on disk came from</span><span>${files.toLocaleString()} files</span></div>
      <div class="got">${got.map(([k, l]) => `<span class="via"><b class="${{ pawchive: 'vp', fanbox: 'vf' }[k] || 'va'}">${l}</b><span class="num">${o.got[k].toLocaleString()}</span><small>${o.got[k] / files < 0.001 ? '<0.1' : ((o.got[k] / files) * 100).toFixed(1)}%</small></span>`).join('')}</div>
    </div>`, 'sections');
}

// Failed posts by creator, folded: one creator's run of failures does not bury the rest.
function failedHTML() {
  const o = H.overview;
  if (!o) return head('Failed posts') + body(skeletonRows(5, { height: 40, lines: 1 }));
  const n = o.issues.failed?.posts || 0;
  const blocked = o.issues.blocked?.posts || 0;
  const foot = blocked ? `<div class="pfoot" data-key="foot"><span><span class="state-dot block"></span>${plural(blocked, 'blocked post')} are not listed: Pawchive answered 404 and no run asks again.</span></div>` : '';
  const groups = new Map();
  for (const f of o.failed) {
    if (!groups.has(f.creator_id)) groups.set(f.creator_id, []);
    groups.get(f.creator_id).push(f);
  }
  if (!groups.size) return head('Failed posts') + body(emptyState({ icon: I.check, title: 'No failed downloads', hint: 'Posts whose files failed show up here; the next download tries them again.' }) + foot);
  // A few groups open by themselves, so the panel shows the posts rather than one folded
  // line above empty space; once you fold or unfold one, your choice is kept.
  const auto = !H.failedTouched && groups.size <= 3;
  return head('Failed posts', `${plural(n, 'post')} · retried on the next download`) + body(`<div class="lines" data-key="list">${[...groups.entries()].map(([cid, items]) => {
    const same = items.every((f) => f.error === items[0].error) ? items[0].error : '';
    return `<details class="fgroup" data-key="${esc(cid)}" ${auto || H.openFailed.has(cid) ? 'open' : ''}><summary><b>${esc(nameOf(cid))}</b><span class="muted">${plural(items.length, 'post')}</span><span class="e" title="${esc(same)}">${esc(same)}</span></summary>
      <div>${items.map((f) => `<a class="fail-row" href="#/c/${encodeURIComponent(cid)}?post=${encodeURIComponent(f.post_id)}" title="${esc(f.error)}">
        <span class="mono">${esc((f.published || '').slice(0, 10))}</span>
        <span class="fail-t">${esc(f.title)} <small class="mono">${esc(f.post_id)}</small></span>
        <span class="num" title="${f.files.toLocaleString()} files">${plural(f.files, 'file')}</span>
        <span class="fail-e">${same ? '' : esc(f.error)}</span></a>`).join('')}</div></details>`;
  }).join('')}</div>${foot}`);
}

function feedHTML() {
  const events = H.events;
  const top = head('Recent activity', '<a class="linkbtn" href="#/jobs">All logs →</a>');
  if (!events) return top + body(skeletonRows(12, { height: 36, lines: 1 }));
  const groups = groupEvents(events, FEED_WINDOW).slice(0, FEED_ROWS);
  if (!groups.length) return top + body(emptyState({ icon: I.list, title: 'No activity yet', hint: 'Syncs, downloads and their problems are logged here as they happen.' }));
  return top + body(`<div class="lines" data-key="list">${groups.map((g) => {
    const e = g.latest;
    const name = e.creator_id ? nameOf(e.creator_id) : '';
    const span = g.count > 1 && localTime(g.first.at) !== localTime(e.at) ? `<small>from ${esc(localTime(g.first.at).slice(6))}</small>` : '';
    return `<div class="feed-row" data-key="${g.first.id}" title="${esc(e.message)}">
      <span class="state-dot ${{ error: 'bad', warning: 'warn' }[e.level] || 'mute'}"></span>
      <span class="feed-t mono">${esc(localTime(e.at))}${span}</span>
      <span class="feed-m">${e.creator_id ? `<a href="${creatorLink(e.creator_id)}">${esc(name)}</a> · ` : ''}${esc(withoutName(g.text, name))}${g.count > 1 ? `<b class="feed-n">×${g.count}</b>` : ''}</span>
    </div>`;
  }).join('')}</div>`);
}

const PARTS = { stats: statsHTML, issues: issuesHTML, rank: rankHTML, status: statusHTML, failed: failedHTML, feed: feedHTML };

function draw(...names) {
  if (!H) return;
  for (const n of names) {
    const el = H.el.querySelector(`[data-part="${n}"]`);
    if (el) patch(el, PARTS[n]());
  }
}

export async function mountHome(el, creators) {
  H = { el, creators, state: null, overview: null, events: null, openIssues: new Set(), openFailed: new Set(), failedTouched: false };
  try { H.state = await api('state'); } catch { /* shown as unknown */ }
  el.innerHTML = `<div class="view home">
    <div class="view-head"><div><h1>Overview</h1><p class="lede">${plural(creators.length, 'creator')} · downloads go to <span class="mono">${esc(H.state?.download_dir || '')}</span></p></div>
      <div class="row-inline"><a class="btn" href="#/add">${I.plus}Add creator</a><button class="btn" type="button" data-subs>${I.sync}Refresh plans</button><button class="btn primary" type="button" data-dlall>${I.dl}Download all</button></div></div>
    <div class="stats" data-part="stats"></div>
    <div class="home-grid">
      ${['issues', 'failed', 'status', 'rank', 'feed'].map((p) => `<section class="panel fill" data-part="${p}" style="grid-area:${p}"></section>`).join('')}
    </div>
  </div>`;
  draw(...Object.keys(PARTS));
  syncDownloadAll();
  const mine = H;
  const abort = new AbortController();
  const signal = abort.signal;
  // Folded lists stay as the reader left them when a panel is patched.
  el.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || H !== mine) return;
    const failed = !!d.closest('[data-part="failed"]');
    const set = failed ? mine.openFailed : mine.openIssues;
    if (d.open) set.add(d.dataset.key); else set.delete(d.dataset.key);
  }, { capture: true, signal });
  // The first fold by hand takes over from the automatic opening of failed groups. A patch
  // opening a group also fires `toggle`, so the hand is told apart by its click.
  el.addEventListener('click', (e) => {
    if (H !== mine || mine.failedTouched || !e.target.closest('[data-part="failed"] details.fgroup > summary')) return;
    mine.failedTouched = true;
    setTimeout(() => {
      mine.openFailed = new Set([...el.querySelectorAll('[data-part="failed"] details.fgroup[open]')].map((x) => x.dataset.key));
    });
  }, { signal });
  // The panels that classify every post arrive after the page, as the server counts them.
  api('overview').then((o) => {
    if (H !== mine) return;
    H.overview = o;
    draw('issues', 'status', 'failed', 'feed');
  }).catch(() => {
    if (H !== mine) return;
    for (const p of ['issues', 'status', 'failed']) {
      patch(el.querySelector(`[data-part="${p}"]`), head({ issues: 'Needs a look', status: 'Local status', failed: 'Failed posts' }[p])
        + body(emptyState({ icon: I.x, title: 'Could not count the posts', hint: 'The server did not answer; reload the page to try again.' })));
    }
  });
  const subs = [
    on('events', (events) => { if (H === mine) { H.events = events; draw('feed'); } }),
    on('state', (state) => { if (H === mine) { H.state = state; draw('stats'); } }),
  ];
  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.dlall !== undefined) await attempt(() => api('jobs', { method: 'POST', body: { kind: 'download' } }), (o) => `Queued ${o.jobs.length} downloads`);
    if (b.dataset.subs !== undefined) await attempt(() => api('jobs', { method: 'POST', body: { kind: 'subscriptions' } }), 'Queued');
  };
  return { cleanup: () => { subs.forEach((off) => off()); abort.abort(); if (H === mine) H = null; } };
}

function syncDownloadAll() {
  const b = H.el.querySelector('[data-dlall]');
  const n = H.creators.filter((c) => !c.ignore).reduce((s, c) => s + c.fetchable, 0);
  b.disabled = !n;
  b.title = n ? `Queue a download for every creator with posts waiting (${n.toLocaleString()} posts)` : 'Nothing to download';
}

// The creator list was reloaded (a job finished): the tiles and the ranking follow it.
export function refreshHome(el, creators) {
  if (!H || H.el !== el) return;
  H.creators = creators;
  draw('stats', 'rank');
  syncDownloadAll();
}
