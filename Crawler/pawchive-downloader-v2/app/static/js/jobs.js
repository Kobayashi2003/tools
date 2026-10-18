import { ago, api, attempt, esc, groupEvents, localTime } from './api.js';
import { I } from './icons.js';
import { on, patchRows } from './live.js';

const KIND = { sync: 'Sync', download: 'Download', subscriptions: 'Refresh plans', migration: 'Migration', probe: 'Fanbox check', move: 'Move folder' };
const STATUS = { queued: ['k-pending', 'Queued'], running: ['k-partial', 'Running'], done: ['k-done', 'Done'], failed: ['k-failed', 'Failed'], cancelled: ['k-ignored', 'Cancelled'] };
const LEVEL = { info: ['mute', 'Info'], warning: ['warn', 'Warning'], error: ['bad', 'Error'] };

let level = 'all';
let showProbes = false;
let unmount = () => {};

function jobRow(j) {
  const [k, t] = STATUS[j.status] || ['k-pending', j.status];
  const text = j.error || j.progress || (j.status === 'done' || j.status === 'cancelled' ? j.note : '') || '';
  return `<tr><td class="n muted">${j.id}</td><td><span class="clip" title="${esc(j.note || '')}">${KIND[j.kind] || j.kind}</span></td>
    <td>${j.creator_id ? `<a class="clip" href="#/c/${encodeURIComponent(j.creator_id)}" title="${esc(j.creator_name || j.creator_id)}">${esc(j.creator_name || j.creator_id)}</a>` : '<span class="muted">—</span>'}</td>
    <td><span class="chip ${k}">${t}</span></td>
    <td><span class="clip ${j.error ? 'lvl-error' : ''}" title="${esc(text)}">${esc(text)}</span></td>
    <td class="muted nowrap">${esc(ago(j.started_at || j.created_at))}</td>
    <td class="acts">${j.status === 'running' || j.status === 'queued' ? `<button class="linkbtn" type="button" data-cancel="${j.id}">Cancel</button>` : ''}</td></tr>`;
}

function logRow(g) {
  const e = g.latest;
  const [dot, label] = LEVEL[e.level] || ['mute', e.level];
  return `<tr><td class="mono nowrap muted" title="${g.count > 1 ? `from ${esc(localTime(g.first.at))}` : ''}">${esc(localTime(e.at))}</td>
    <td class="nowrap"><span class="state-dot ${dot}"></span> ${label}</td>
    <td>${e.creator_id ? `<a class="clip" href="#/c/${encodeURIComponent(e.creator_id)}">${esc(e.creator_id)}</a>` : '<span class="muted">—</span>'}</td>
    <td><span class="clip" title="${esc(e.message)}">${esc(g.count > 1 ? g.text : e.message)}${g.count > 1 ? `<b class="feed-n">×${g.count}</b>` : ''}</span></td></tr>`;
}

const placeholder = (cols, text) => [{ key: 'empty', html: `<tr><td colspan="${cols}" class="empty-cell">${text}</td></tr>` }];

export function mountJobs(el) {
  unmount();
  el.innerHTML = `<div class="view">
    <div class="view-head"><div><h1>Jobs</h1><p class="lede">One job per creator at a time. Unfinished jobs resume after a restart.</p></div>
      <div class="row-inline"><button class="btn" type="button" data-all="sync">${I.sync}Sync all</button><button class="btn" type="button" data-all="download">${I.dl}Download all</button><button class="btn danger" type="button" data-stopall disabled>${I.stop}Stop all</button></div></div>
    <section class="panel flush">
      <div class="panel-head pad"><h2>Queue and history</h2>
        <label class="check"><input type="checkbox" data-probes ${showProbes ? 'checked' : ''}> Show background Fanbox checks<span id="probe-n"></span></label></div>
      <div class="table fixed bare"><table>
        <colgroup><col style="width:56px"><col style="width:132px"><col style="width:22%"><col style="width:104px"><col><col style="width:104px"><col style="width:72px"></colgroup>
        <thead><tr><th class="n">#</th><th>Job</th><th>Creator</th><th>Status</th><th>Progress / result</th><th>Started</th><th></th></tr></thead>
        <tbody id="job-rows"><tr><td colspan="7" class="empty-cell">Loading…</td></tr></tbody></table></div>
    </section>
    <section class="panel flush">
      <div class="panel-head pad"><h2>Log</h2>
        <div class="seg" role="group" aria-label="Log level">${[['all', 'All'], ['warning', 'Warnings'], ['error', 'Errors']].map(([k, l]) => `<button type="button" data-level="${k}" aria-pressed="${level === k}">${l}</button>`).join('')}</div></div>
      <div class="table fixed bare"><table>
        <colgroup><col style="width:112px"><col style="width:100px"><col style="width:22%"><col></colgroup>
        <thead><tr><th>Time</th><th>Level</th><th>Creator</th><th>Message</th></tr></thead>
        <tbody id="log-rows"><tr><td colspan="4" class="empty-cell">Loading…</td></tr></tbody></table></div>
    </section>
  </div>`;
  const jobBody = el.querySelector('#job-rows');
  const logBody = el.querySelector('#log-rows');
  let jobs = null;
  let events = null;

  const drawJobs = () => {
    if (!jobs) return;
    const probes = jobs.filter((j) => j.kind === 'probe').length;
    const list = jobs.filter((j) => showProbes || j.kind !== 'probe').slice(0, 80);
    el.querySelector('#probe-n').textContent = probes ? ` (${probes})` : '';
    el.querySelector('[data-stopall]').disabled = !jobs.some((j) => j.status === 'running' || j.status === 'queued');
    patchRows(jobBody, list.length ? list.map((j) => ({ key: `j${j.id}`, html: jobRow(j) })) : placeholder(7, 'No jobs yet.'));
  };
  const drawLog = () => {
    if (!events) return;
    const shown = events.filter((e) => level === 'all' || e.level === level || (level === 'warning' && e.level === 'error'));
    // A group is keyed by its oldest line, which stays put while newer repeats fold into it.
    const groups = groupEvents(shown);
    patchRows(logBody, groups.length ? groups.map((g) => ({ key: `e${g.first.id}`, html: logRow(g) })) : placeholder(4, 'No log lines.'));
  };

  const subs = [
    on('jobs', (v) => { jobs = v; drawJobs(); }),
    on('events', (v) => { events = v; drawLog(); }),
  ];
  // "Started 3 min ago" ages without any new data.
  const tick = setInterval(drawJobs, 30000);
  unmount = () => { subs.forEach((off) => off()); clearInterval(tick); unmount = () => {}; };
  const leave = () => { if (!location.hash.startsWith('#/jobs')) { unmount(); window.removeEventListener('hashchange', leave); } };
  window.addEventListener('hashchange', leave);

  el.onclick = async (e) => {
    const box = e.target.closest('[data-probes]');
    if (box) { showProbes = box.checked; drawJobs(); return; }
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.cancel) await attempt(() => api(`jobs/${b.dataset.cancel}/cancel`, { method: 'POST' }), 'Cancel requested');
    else if (b.dataset.stopall !== undefined) await attempt(() => api('jobs/cancel-all', { method: 'POST' }), 'Stopped all jobs');
    else if (b.dataset.all) await attempt(() => api('jobs', { method: 'POST', body: { kind: b.dataset.all } }), (o) => `Queued ${o.jobs.length} jobs`);
    else if (b.dataset.level) {
      level = b.dataset.level;
      el.querySelectorAll('[data-level]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      drawLog();
    }
  };
}
