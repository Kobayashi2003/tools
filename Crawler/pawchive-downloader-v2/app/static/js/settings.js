import { ago, api, attempt, esc, fmtCount, fmtSize, groupEvents, localTime, toast } from './api.js';
import { I } from './icons.js';

const SESSION = {
  none: ['k-pending', 'Not set', 'mute'],
  unchecked: ['k-wait', 'Unverified', 'wait'],
  valid: ['k-done', 'Valid', 'ok'],
  rejected: ['k-failed', 'Rejected', 'bad'],
};

// [key, label, kind, hint]; kind: text | number | size ("8MB") | list (comma separated) |
// a CHOICES key (one of a few values, as buttons)
const CHOICES = {
  source_preference: [['pawchive-first', 'Pawchive'], ['fanbox-first', 'Their site']],
  update_policy: [['keep', 'Keep both'], ['overwrite', 'Overwrite']],
};
const PANELS = [
  ['Downloads', [
    ['download_dir', 'Download folder', 'text', 'Every download goes here, as in v1. Folders you have moved elsewhere are never written to.'],
    ['source_preference', 'Source first', 'choice', 'Their site is the creator\'s Fanbox or Patreon. If that source cannot deliver a file, the other is tried in the same run. Each creator can override this.'],
    ['update_policy', 'When a post is updated', 'choice', 'Keep both: before a file is replaced by a different one, the post folder is copied beside it as "<folder> [old <date of its newest file>]". Overwrite: the file is just replaced.'],
    ['max_concurrent_creators', 'Creators at once', 'number', ''],
    ['max_concurrent_files', 'Files per post at once', 'number', ''],
  ]],
  ['Pawchive limits', [
    ['max_file_requests_per_second', 'Requests per second', 'number', "The operator asks for at most 1/s and 5 parallel downloads."],
    ['max_concurrent_downloads', 'Parallel downloads', 'number', ''],
    ['daily_download_quota', 'Daily quota', 'size', 'e.g. 60GB; 0 = none. When spent, downloads pause; nothing is marked failed.'],
    ['max_download_rate', 'Speed limit', 'size', 'Per second, e.g. 4MB; 0 = none.'],
  ]],
  ['Fanbox limits', [
    ['fanbox_requests_per_second', 'Requests per second', 'number', 'Requests go out under your account; 0.5 or less is advised.'],
    ['fanbox_max_concurrent_downloads', 'Parallel downloads', 'number', ''],
  ]],
  ['Folders and names', [
    ['artist_folder_template', 'Creator folder', 'text', 'Variables: {group} {alias} {name} {service} {user_id}'],
    ['post_folder_template', 'Post folder', 'text', 'Variables: {published} {id} {title}. Keep {id}: migrations recognise folders by it. Dates are UTC.'],
    ['file_template', 'File name', 'text', '{idx} numbers images only (the cover is 0); other files keep their names.'],
    ['date_format', 'Date format', 'text', ''],
  ]],
  ['Filters', [
    ['global_filter.exclude_keywords', 'Skip titles containing', 'list', 'Comma separated. Each creator can override.'],
    ['global_filter.include_keywords', 'Only titles containing', 'list', ''],
    ['global_filter.published_after', 'Only published after', 'text', 'YYYY-MM-DD'],
  ]],
];

const getPath = (values, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), values);
const press = (b) => b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));

function field(values, env, [key, label, kind, hint]) {
  const top = key.split('.')[0];
  const locked = env.includes(top);
  const v = getPath(values, key);
  const id = 'set-' + key.replace(/\./g, '-');
  let input;
  if (kind === 'choice') {
    input = `<div class="seg" role="group" aria-label="${label}">${CHOICES[key].map(([k, l]) => `<button type="button" data-choice="${key}" data-value="${k}" aria-pressed="${v === k}" ${locked ? 'disabled' : ''}>${l}</button>`).join('')}</div>`;
  } else {
    const shown = kind === 'list' ? (v || []).join(', ') : v ?? '';
    input = `<label class="field${kind === 'number' || kind === 'size' ? ' narrow' : ''}"><input id="${id}" data-key="${key}" data-kind="${kind}" value="${esc(shown)}" ${locked ? 'disabled' : ''} ${kind === 'number' ? 'inputmode="decimal"' : ''}></label>`;
  }
  const note = locked ? `Set by PAWCHIVE_${top.toUpperCase()} in .env. ` : '';
  return `<label class="lab" for="${id}">${label}${locked ? '<span class="env">.env</span>' : ''}</label><div class="ctl">${input}${hint || note ? `<div class="hint">${esc(note + hint)}</div>` : ''}</div>`;
}

let watching = false;

// The sites whose session cookie the app keeps: what the panel says about each.
const SITES = {
  fanbox: {
    title: 'Fanbox session', cookie: 'FANBOXSESSID', env: 'FANBOX_SESSID', field: 'sessid',
    valid: (s) => `Supporting ${s.supporting ?? 0} plans`,
    none: 'Free posts and post lists work without it.',
  },
  patreon: {
    title: 'Patreon session', cookie: 'session_id', env: 'PATREON_SESSION_ID', field: 'session_id',
    valid: (s) => `Signed in${s.user ? ` as ${s.user}` : ''}`,
    none: 'Post lists and free posts work without it; paid posts need the tier on your account.',
  },
};

// Polls a running browser sign-in until it ends, then redraws the page if it is still shown.
async function watchLogin(el, site) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await api(`${site}/login`).catch(() => null);
    if (st?.state === 'waiting') continue;
    if (st) toast(st.message || st.state, st.state === 'failed');
    if (location.hash.startsWith('#/settings')) mountSettings(el);
    return;
  }
}

export async function mountSettings(el) {
  const [settings, state, login, plogin] = await Promise.all([
    api('settings'), api('state'), api('fanbox/login'), api('patreon/login'),
  ]);
  const values = settings.values;
  const sessions = {
    fanbox: { s: state.session || {}, env: state.session_from_env, login },
    patreon: { s: state.patreon_session || {}, env: state.patreon_session_from_env, login: plogin },
  };
  const signingSite = Object.keys(sessions).find((k) => sessions[k].login.state === 'waiting');
  const sessionPanel = (site) => {
    const { s, env, login: lg } = sessions[site];
    const d = SITES[site];
    const [k, t] = SESSION[s.state] || SESSION.none;
    const signing = lg.state === 'waiting';
    const note = signing ? lg.message
      : s.state === 'valid' ? `${d.valid(s)} · checked ${ago(s.checked_at)}${s.source === 'browser' ? ' · from the browser sign-in' : ''}`
      : s.message || (s.state === 'none' ? d.none : '');
    return `<section class="panel" data-site="${site}">
      <div class="panel-head"><h2>${d.title}</h2><span class="chip ${k}">${t}</span></div>
      <div class="form">
        <span class="lab">Sign in</span>
        <div class="ctl">
          ${env ? '' : `<div class="row-inline nowrap">${signing
            ? `<button class="btn" type="button" data-cancellogin>Cancel sign-in</button>`
            : `<button class="btn primary" type="button" data-login ${signingSite ? 'disabled' : ''}>Sign in with browser</button>`}
            <button class="btn" type="button" data-clearsess ${s.state === 'none' || signing ? 'disabled' : ''}>Clear</button></div>`}
          <div class="hint">${esc(note)}${env ? ` Provided by ${d.env} in the environment.` : ''}</div>
          ${env ? '' : `<div class="hint">Opens Chrome (or Edge) on its own profile in data/browser and closes it once the cookie is read. Sign in there once; later sign-ins finish on their own. The cookie stays on this machine.</div>`}
        </div>
        ${env ? '' : `<label class="lab" for="sess-${site}">Or paste</label>
        <div class="ctl"><div class="row-inline nowrap">
          <label class="field grow"><input id="sess-${site}" type="password" autocomplete="off" placeholder="${d.cookie} value"><button class="linkbtn" type="button" data-reveal>Show</button></label>
          <button class="btn" type="button" data-savesess>Save</button></div></div>`}
      </div>
    </section>`;
  };
  const panel = (i) => {
    const [title, fields] = PANELS[i];
    return `<section class="panel" data-panel="${i}"><div class="panel-head"><h2>${title}</h2><button class="btn sm" type="button" data-save="${i}">Save</button></div>
      <div class="form">${fields.map((f) => field(values, settings.env, f)).join('')}</div></section>`;
  };
  // Two independent columns on wide screens: each stacks top-down, so panels of different
  // heights never leave ragged gaps the way a flowing grid would.
  el.innerHTML = `<div class="view">
    <div class="view-head"><div><h1>Settings</h1><p class="lede">Saved in data/config.json. PAWCHIVE_* values in .env win. Settings cannot change while a job runs.</p></div></div>
    <div class="cols">
    <div class="col">
    ${sessionPanel('fanbox')}${sessionPanel('patreon')}
    ${panel(0)}${panel(3)}
    </div>
    <div class="col">
    ${panel(1)}${panel(2)}${panel(4)}
    <section class="panel">
      <div class="panel-head"><h2>Scheduled downloads</h2><button class="btn sm" type="button" data-savetimer>Save</button></div>
      <div class="form">
        <span class="lab">Timers</span>
        <div class="ctl"><div class="seg" role="group" aria-label="Timers"><button type="button" data-timers="off" aria-pressed="${!values.timers_enabled}">Off</button><button type="button" data-timers="on" aria-pressed="${!!values.timers_enabled}">On</button></div>
          <div class="hint">Off by default. Timers imported from v1 are kept but only fire once this is on. Keep it off while v1 still runs, or both pull from Pawchive at once.</div></div>
        <span class="lab">Default timer</span>
        <div class="ctl"><div class="row-inline">
          <div class="seg" role="group" aria-label="Frequency">${[['', 'None'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']].map(([v, l]) => `<button type="button" data-timer="${v}" aria-pressed="${(values.global_timer?.type || '') === v}">${l}</button>`).join('')}</div>
          <label class="field tiny" title="Time (HH:MM)"><input id="t-time" value="${esc(values.global_timer?.time || '00:00')}" aria-label="Time"></label>
          <label class="field tiny" title="Day"><input id="t-day" value="${esc(values.global_timer?.day ?? '')}" placeholder="Day" aria-label="Day"></label></div>
          <div class="hint">Local time. Weekly: day 0 is Monday. Monthly: day of the month. A creator can have its own timer.</div></div>
      </div>
    </section>
    </div>
    </div>
  </div>`;
  if (signingSite && !watching) {
    watching = true;
    watchLogin(el, signingSite).finally(() => { watching = false; });
  }
  let timerType = values.global_timer?.type || '';
  const picked = Object.fromEntries(Object.keys(CHOICES).map((k) => [k, values[k]]));
  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const site = b.closest('[data-site]')?.dataset.site;
    if (b.dataset.reveal !== undefined) {
      const i = el.querySelector(`#sess-${site}`);
      i.type = i.type === 'password' ? 'text' : 'password';
      b.textContent = i.type === 'password' ? 'Show' : 'Hide';
      return;
    }
    if (b.dataset.login !== undefined) {
      if (await attempt(() => api(`${site}/login`, { method: 'POST' }))) await mountSettings(el);
      return;
    }
    if (b.dataset.cancellogin !== undefined) {
      await attempt(() => api(`${site}/login`, { method: 'DELETE' }));
      return;
    }
    if (b.dataset.savesess !== undefined || b.dataset.clearsess !== undefined) {
      const value = b.dataset.clearsess !== undefined ? '' : el.querySelector(`#sess-${site}`).value.trim();
      if (b.dataset.savesess !== undefined && !value) return toast('Paste the cookie first', true);
      const out = await attempt(() => api(`${site}/session`, { method: 'POST', body: { [SITES[site].field]: value } }));
      if (out) toast(out.state === 'valid' ? `Cookie valid; ${SITES[site].valid(out).toLowerCase()}` : out.state === 'none' ? 'Cleared' : `Result: ${out.message || out.state}`, out.state === 'rejected');
      return mountSettings(el);
    }
    if (b.dataset.choice) { picked[b.dataset.choice] = b.dataset.value; press(b); return; }
    if (b.dataset.timers) {
      const on = b.dataset.timers === 'on';
      const out = await attempt(() => api('settings', { method: 'PATCH', body: { timers_enabled: on } }), on ? 'Timers on' : 'Timers off');
      if (out) { values.timers_enabled = out.values.timers_enabled; press(b); }
      return;
    }
    if (b.dataset.timer !== undefined) { timerType = b.dataset.timer; press(b); return; }
    if (b.dataset.savetimer !== undefined) {
      const day = el.querySelector('#t-day').value.trim();
      const timer = timerType ? { type: timerType, time: el.querySelector('#t-time').value.trim() || '00:00', ...(day ? { day: Number(day) } : {}) } : null;
      await attempt(() => api('settings', { method: 'PATCH', body: { global_timer: timer } }), 'Saved');
      return;
    }
    if (b.dataset.save) {
      const panel = el.querySelector(`[data-panel="${b.dataset.save}"]`);
      const body = {};
      for (const input of panel.querySelectorAll('input[data-key]:not([disabled])')) {
        const [top, sub] = input.dataset.key.split('.');
        let v = input.value.trim();
        if (input.dataset.kind === 'number') v = Number(v);
        if (input.dataset.kind === 'list') v = v ? v.split(/[,，]/).map((x) => x.trim()).filter(Boolean) : [];
        if (sub) {
          body[top] = body[top] || { ...(values[top] || {}) };
          if ((Array.isArray(v) && !v.length) || v === '') delete body[top][sub];
          else body[top][sub] = v;
        } else body[top] = v;
      }
      for (const k of new Set([...panel.querySelectorAll('[data-choice]:not([disabled])')].map((x) => x.dataset.choice))) body[k] = picked[k];
      const out = await attempt(() => api('settings', { method: 'PATCH', body }), 'Saved');
      if (out) Object.assign(values, out.values);
    }
  };
}

// ---------------------------------------------------------------- overview

function nameOf(creators, id) {
  const c = creators.find((x) => x.id === id);
  return c ? c.alias || c.name : id;
}

// "Sync 遠藤弘土: …" next to a 遠藤弘土 link reads as "Sync: …".
function withoutName(text, name) {
  if (!name) return text;
  for (const sep of [': ', '：']) {
    if (text.startsWith(name + sep)) return text.slice(name.length + sep.length);
    if (text.includes(` ${name}${sep}`)) return text.replace(` ${name}${sep}`, sep);
  }
  return text;
}

// Kept posts by local state, in the order a reader scans them: settled, then the work left.
const STATES = [
  ['done', 'Done', 'ok'], ['partial', 'Partial', 'warn'], ['pending', 'Pending', 'warn'],
  ['failed', 'Failed', 'bad'], ['na', 'Unavailable', 'mute'], ['filtered', 'Filtered', 'line'],
];

function statusPanel(o) {
  const total = STATES.reduce((n, [k]) => n + (o.status[k] || 0), 0) || 1;
  const shown = STATES.filter(([k]) => o.status[k]);
  const got = [['pawchive', 'Pawchive'], ['fanbox', 'Fanbox'], ['local', 'Found on disk']].filter(([k]) => o.got[k]);
  const files = got.reduce((n, [k]) => n + o.got[k], 0);
  return `<div class="panel-head"><h2>Local status</h2><span class="muted">${total.toLocaleString()} posts</span></div>
    <div class="sbar" role="img" aria-label="${shown.map(([k, l]) => `${l} ${o.status[k]}`).join(', ')}">${shown.map(([k, l, c]) => `<i class="b-${c}" style="flex-grow:${o.status[k]}" title="${l}: ${o.status[k].toLocaleString()} (${((o.status[k] / total) * 100).toFixed(1)}%)"></i>`).join('')}</div>
    <div class="slegend">${shown.map(([k, l, c]) => `<span><i class="b-${c}"></i>${l}<b class="num">${o.status[k].toLocaleString()}</b></span>`).join('')}</div>
    <div class="got"><span class="h">Files on disk came from</span>${got.map(([k, l]) => `<span class="via"><b class="${{ pawchive: 'vp', fanbox: 'vf' }[k] || 'va'}">${l}</b><span class="num">${o.got[k].toLocaleString()}</span><small>${o.got[k] / files < 0.001 ? '<0.1' : ((o.got[k] / files) * 100).toFixed(1)}%</small></span>`).join('')}</div>`;
}

// One row per source rather than one stacked bar: the two source hues are too close for
// some readers to tell apart, and their row names them anyway.
function dailyPanel(o) {
  const days = Array.from({ length: o.days }, (_, i) => {
    const d = new Date(o.first_day + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  const get = (day, via) => o.daily.find((r) => r.day === day && r.via === via) || { files: 0, bytes: 0 };
  const max = Math.max(1, ...o.daily.map((r) => r.files));
  const sum = (via) => o.daily.filter((r) => r.via === via).reduce((a, r) => ({ files: a.files + r.files, bytes: a.bytes + r.bytes }), { files: 0, bytes: 0 });
  const row = (via, label, cls) => {
    const t = sum(via);
    return `<div class="drow"><span class="dlabel"><b>${label}</b><small title="${t.files.toLocaleString()} files">${fmtCount(t.files)} files · ${fmtSize(t.bytes)}</small></span>
      <span class="dbars">${days.map((day) => {
        const r = get(day, via);
        const h = r.files ? Math.max(2, Math.round((r.files / max) * 40)) : 0;
        return `<span class="dcol" title="${day} · ${label}: ${r.files.toLocaleString()} files, ${fmtSize(r.bytes)}"><i class="${cls}" style="height:${h}px"></i></span>`;
      }).join('')}</span></div>`;
  };
  return `<div class="panel-head"><h2>Downloaded</h2><span class="muted">last ${o.days} days</span></div>
    ${row('pawchive', 'Pawchive', 'src-p')}${row('fanbox', 'Fanbox', 'src-f')}
    <div class="daxis"><span></span><span class="mono">${days[0].slice(5)}</span><span class="mono">today</span></div>`;
}

const ISSUES = [
  ['failed', 'bad', 'Failed downloads', 'posts'],
  ['mismatch', 'bad', 'Files that failed their check', 'posts'],
  ['stale', 'warn', 'Updated upstream since download', 'posts'],
  ['unverified', 'mute', 'Adopted, unverified', 'posts'],
  ['links', 'warn', 'New cloud-storage links', 'posts'],
  ['unsynced', 'mute', 'Not synced for 30 days', 'creators'],
];

function issuesPanel(o, creators) {
  const rows = ISSUES.filter(([k]) => o.issues[k]);
  return `<div class="panel-head"><h2>Needs a look</h2></div>
    ${rows.length ? `<div class="issues">${rows.map(([k, dot, label, unit]) => {
      const it = o.issues[k];
      const n = unit === 'posts' ? it.posts : it.n;
      const who = it.creators.map((id) => `<a href="#/c/${encodeURIComponent(id)}">${esc(nameOf(creators, id))}</a>`).join(', ');
      return `<div class="issue"><span class="state-dot ${dot}"></span><span class="issue-t">${label}<small>${who}${it.n > it.creators.length ? ` and ${it.n - it.creators.length} more` : ''}</small></span><b class="num" title="${n.toLocaleString()}">${fmtCount(n)}</b></div>`;
    }).join('')}</div>` : '<div class="empty-note">Nothing needs a look.</div>'}`;
}

function failedPanel(o, creators) {
  const n = o.issues.failed?.posts || 0;
  return `<div class="panel-head"><h2>Failed posts</h2><span class="muted">${n ? `${n.toLocaleString()} posts${n > o.failed.length ? `, newest ${o.failed.length} shown` : ''} · retried on the next download` : ''}</span></div>
    ${o.failed.length ? `<div class="fails">${o.failed.map((f) => `<a class="fail-row" href="#/c/${encodeURIComponent(f.creator_id)}" title="${esc(f.error)}">
        <span class="mono muted">${esc((f.published || '').slice(0, 10))}</span>
        <span class="fail-who">${esc(nameOf(creators, f.creator_id))}</span>
        <span class="fail-t">${esc(f.title)} <small class="mono">${esc(f.post_id)}</small></span>
        <span class="num" title="${f.files.toLocaleString()} files">${fmtCount(f.files)} file${f.files === 1 ? '' : 's'}</span>
        <span class="fail-e">${esc(f.error)}</span></a>`).join('')}</div>` : '<div class="empty-note">No failed posts.</div>'}`;
}

export async function mountHome(el, creators) {
  const total = creators.reduce((n, c) => n + c.total, 0);
  const done = creators.reduce((n, c) => n + c.done, 0);
  const active = creators.filter((c) => !c.ignore);
  const fetchable = active.reduce((n, c) => n + c.fetchable, 0);
  const waiting = active.filter((c) => c.fetchable).length;
  const top = active.filter((c) => c.fetchable).sort((a, b) => b.fetchable - a.fetchable).slice(0, 10);
  const fanboxes = active.filter((c) => c.service === 'fanbox');
  const checked = fanboxes.filter((c) => c.f_checked).length;
  let state = {};
  let events = [];
  try { [state, events] = await Promise.all([api('state'), api('events?limit=150')]); } catch { /* shown as unknown */ }
  const s = state.session || {};
  // Feed rows are about two thirds the height of ranking rows: show enough of them that the
  // two side-by-side panels end level.
  const groups = groupEvents(events).slice(0, Math.max(8, Math.round(top.length * 1.5)));
  const pct = total ? (done / total) * 100 : 0;
  const [, sessionLabel, sessionDot] = SESSION[s.state || 'none'] || SESSION.none;
  // Every tile is label / value / one line, so the row keeps one height and one baseline.
  const tile = (label, value, sub, cls = '', title = '') => `<div class="tile stat ${cls}" title="${esc(title)}"><span class="h">${label}</span><span class="v">${value}</span><span class="s">${sub}</span></div>`;
  el.innerHTML = `<div class="view">
    <div class="view-head"><div><h1>Overview</h1><p class="lede">${creators.length} creators · downloads go to <span class="mono">${esc(state.download_dir || '')}</span></p></div>
      <div class="row-inline"><a class="btn" href="#/add">${I.plus}Add creator</a><button class="btn" type="button" data-subs>${I.sync}Refresh plans</button><button class="btn primary" type="button" data-dlall ${fetchable ? '' : 'disabled'}>${I.dl}Download all</button></div></div>
    <div class="stats">
      ${tile('Posts', total.toLocaleString(), 'Both sources')}
      ${tile('Done', done.toLocaleString(), `<span class="meter"><i style="width:${pct.toFixed(1)}%"></i></span>${pct.toFixed(1)}%`, 'ok')}
      ${tile('To download', fetchable.toLocaleString(), `from ${waiting} creators`, 'warn', 'Posts that a source has files for and that are not fully downloaded')}
      ${tile('Fanbox', `<span class="state-dot ${sessionDot}"></span>${sessionLabel}`, fanboxes.length ? `${checked} of ${fanboxes.length} creators checked` : 'No Fanbox creators', '', 'Saved Fanbox creators are checked in the background, one at a time, every 7 days')}
      ${tile('Pawchive quota', state.quota?.enabled ? `${(state.quota.remaining / 1024 ** 3).toFixed(1)} GB` : 'None', state.quota?.enabled ? `left · resets in ${esc(state.quota.resets_in)}` : 'No daily quota set')}
    </div>
    <div class="home-row" id="overview">
      ${['Local status', 'Downloaded', 'Needs a look'].map((t) => `<section class="panel"><div class="panel-head"><h2>${t}</h2></div><div class="empty-note">Counting…</div></section>`).join('')}
    </div>
    <section class="panel home-wide" id="failed"><div class="panel-head"><h2>Failed posts</h2></div><div class="empty-note">Counting…</div></section>
    <div class="home-grid">
      <section class="panel">
        <div class="panel-head"><h2>Most to download</h2><span class="muted">${waiting ? `${waiting} creators` : ''}</span></div>
        ${top.length ? `<div class="rank">${top.map((c) => {
          const p = c.total ? (c.done / c.total) * 100 : 0;
          return `<a class="rank-row" href="#/c/${encodeURIComponent(c.id)}">
            <span class="rank-name"><b>${esc(c.alias || c.name)}</b><small>${esc(c.group || 'Ungrouped')}</small></span>
            <span class="rank-bar" title="${c.done.toLocaleString()} of ${c.total.toLocaleString()} done"><i style="width:${p.toFixed(1)}%"></i></span>
            <span class="rank-n" title="${c.fetchable.toLocaleString()} posts"><b class="num">${fmtCount(c.fetchable)}</b><small>to get</small></span></a>`;
        }).join('')}</div>` : '<div class="empty-note">Nothing to download.</div>'}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Recent activity</h2><a class="linkbtn" href="#/jobs">All logs →</a></div>
        ${groups.length ? `<div class="feed">${groups.map((g) => `<div class="feed-row" title="${esc(g.latest.message)}">
            <span class="state-dot ${{ error: 'bad', warning: 'warn' }[g.latest.level] || 'mute'}"></span>
            <span class="feed-t mono">${esc(localTime(g.latest.at))}</span>
            <span class="feed-m">${g.latest.creator_id ? `<a href="#/c/${encodeURIComponent(g.latest.creator_id)}">${esc(nameOf(creators, g.latest.creator_id))}</a> · ` : ''}${esc(withoutName(g.text, nameOf(creators, g.latest.creator_id)))}${g.count > 1 ? `<b class="feed-n">×${g.count}</b>` : ''}</span>
          </div>`).join('')}</div>` : '<div class="empty-note">No activity yet.</div>'}
      </section>
    </div>
  </div>`;
  // The panels that classify every post arrive after the page, as the server counts them.
  api('overview').then((o) => {
    const box = el.querySelector('#overview');
    if (!box) return;
    box.innerHTML = [statusPanel(o), dailyPanel(o), issuesPanel(o, creators)].map((h) => `<section class="panel">${h}</section>`).join('');
    el.querySelector('#failed').innerHTML = failedPanel(o, creators);
  }).catch(() => {
    const box = el.querySelector('#overview');
    if (box) box.innerHTML = '<section class="panel"><div class="empty-note">Could not load the overview.</div></section>';
  });
  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.dlall !== undefined) await attempt(() => api('jobs', { method: 'POST', body: { kind: 'download' } }), (o) => `Queued ${o.jobs.length} downloads`);
    if (b.dataset.subs !== undefined) await attempt(() => api('jobs', { method: 'POST', body: { kind: 'subscriptions' } }), 'Queued');
  };
}
