import { ago, api, attempt, esc, prefs, toast } from './api.js';
import { dialog } from './dialog.js';
import { on, patch } from './live.js';

// Settings: one column of sections and one save bar. A changed field is marked until it is
// saved; everything changed goes in one request. Sessions, the theme and the timer switch
// act at once instead, since each is a deliberate step of its own.

const SESSION = {
  none: ['k-pending', 'Not set'],
  unchecked: ['k-wait', 'Unverified'],
  valid: ['k-done', 'Valid'],
  rejected: ['k-failed', 'Rejected'],
};

// [key, label, kind, hint]; kind: text | number | size ("8MB") | list (comma separated) |
// choice (one of CHOICES, as buttons)
const CHOICES = {
  source_preference: [['pawchive-first', 'Pawchive'], ['fanbox-first', 'Their site']],
  update_policy: [['keep', 'Keep both'], ['overwrite', 'Overwrite']],
};
const FIELDS = {
  downloads: ['Downloads', [
    ['download_dir', 'Download folder', 'text', 'Every download goes here. Folders you have moved elsewhere are never written to.'],
    ['source_preference', 'Source first', 'choice', 'Their site is the creator\'s Fanbox or Patreon. If that source cannot deliver a file, the other is tried in the same run. Each creator can override this.'],
    ['update_policy', 'When a post is updated', 'choice', 'Keep both: before a file is replaced by a different one, the post folder is copied beside it as "<folder> [old <date of its newest file>]". Overwrite: the file is just replaced.'],
    ['max_concurrent_creators', 'Creators at once', 'number', ''],
    ['max_concurrent_files', 'Files per post at once', 'number', ''],
  ]],
  folders: ['Folders and names', [
    ['artist_folder_template', 'Creator folder', 'text', 'Variables: {group} {alias} {name} {service} {user_id}'],
    ['post_folder_template', 'Post folder', 'text', 'Variables: {published} {id} {title}. Keep {id}: migrations recognise folders by it. Dates are UTC.'],
    ['file_template', 'File name', 'text', '{idx} numbers images only (the cover is 0); other files keep their names.'],
    ['date_format', 'Date format', 'text', ''],
  ]],
  filters: ['Filters', [
    ['global_filter.exclude_keywords', 'Skip titles containing', 'list', 'Comma separated. Each creator can override.'],
    ['global_filter.include_keywords', 'Only titles containing', 'list', ''],
    ['global_filter.published_after', 'Only published after', 'text', 'YYYY-MM-DD'],
  ]],
  plimits: ['Pawchive limits', [
    ['max_file_requests_per_second', 'Requests per second', 'number', 'The operator asks for at most 1/s and 5 parallel downloads.'],
    ['max_concurrent_downloads', 'Parallel downloads', 'number', ''],
    ['daily_download_quota', 'Daily quota', 'size', 'e.g. 60GB; 0 = none. When spent, downloads pause; nothing is marked failed.'],
    ['max_download_rate', 'Speed limit', 'size', 'Per second, e.g. 4MB; 0 = none.'],
  ]],
  flimits: ['Fanbox limits', [
    ['fanbox_requests_per_second', 'Requests per second', 'number', 'Requests go out under your account; 0.5 or less is advised.'],
    ['fanbox_max_concurrent_downloads', 'Parallel downloads', 'number', ''],
  ]],
};
const SECTIONS = [
  ['appearance', 'Appearance'], ['fanbox', 'Fanbox session'], ['patreon', 'Patreon session'],
  ['downloads'], ['folders'], ['filters'], ['plimits'], ['flimits'], ['schedule', 'Scheduled downloads'],
];
const KINDS = Object.fromEntries(Object.values(FIELDS).flatMap(([, fields]) => fields.map(([key, , kind]) => [key, kind])));

// The sites whose session cookie the app keeps: what the panel says about each.
const SITES = {
  fanbox: {
    title: 'Fanbox session', cookie: 'FANBOXSESSID', env: 'FANBOX_SESSID', field: 'sessid', state: 'session', fromEnv: 'session_from_env',
    valid: (s) => `Supporting ${s.supporting ?? 0} plans`,
    none: 'Free posts and post lists work without it.',
  },
  patreon: {
    title: 'Patreon session', cookie: 'session_id', env: 'PATREON_SESSION_ID', field: 'session_id', state: 'patreon_session', fromEnv: 'patreon_session_from_env',
    valid: (s) => `Signed in${s.user ? ` as ${s.user}` : ''}`,
    none: 'Post lists and free posts work without it; paid posts need the tier on your account.',
  },
};

const getPath = (values, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), values);
const shownValue = (kind, v) => (kind === 'list' ? (v || []).join(', ') : v ?? '');
const parse = (kind, text) => {
  const v = text.trim();
  if (kind === 'number') return v === '' ? v : Number(v);
  if (kind === 'list') return v ? v.split(/[,，]/).map((x) => x.trim()).filter(Boolean) : [];
  return v;
};
const same = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');

export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

let T = null;

function fieldHTML([key, label, kind, hint]) {
  const top = key.split('.')[0];
  const locked = T.env.includes(top);
  const v = getPath(T.values, key);
  const id = 'set-' + key.replace(/\./g, '-');
  let input;
  if (kind === 'choice') {
    input = `<div class="seg" role="group" aria-label="${label}">${CHOICES[key].map(([k, l]) => `<button type="button" data-choice="${key}" data-value="${k}" aria-pressed="${T.choice[key] === k}" ${locked ? 'disabled' : ''}>${l}</button>`).join('')}</div>`;
  } else {
    input = `<label class="field${kind === 'number' || kind === 'size' ? ' narrow' : ''}"><input id="${id}" data-field="${key}" data-kind="${kind}" value="${esc(shownValue(kind, v))}" ${locked ? 'disabled' : ''} ${kind === 'number' ? 'inputmode="decimal"' : ''}></label>`;
  }
  const note = locked ? `Set by PAWCHIVE_${top.toUpperCase()} in .env. ` : '';
  const tag = kind === 'choice' ? 'span' : 'label';
  return `<${tag} class="lab" ${kind === 'choice' ? '' : `for="${id}"`} data-lab="${key}">${label}${locked ? '<span class="env">.env</span>' : ''}</${tag}><div class="ctl">${input}${hint || note ? `<div class="hint">${esc(note + hint)}</div>` : ''}</div>`;
}

function sessionHTML(site) {
  const d = SITES[site];
  const s = T.state[d.state] || {};
  const env = T.state[d.fromEnv];
  const lg = T.login[site] || {};
  const [k, t] = SESSION[s.state] || SESSION.none;
  const signing = lg.state === 'waiting';
  const otherSigning = Object.entries(T.login).some(([key, v]) => key !== site && v?.state === 'waiting');
  const note = signing ? lg.message
    : s.state === 'valid' ? `${d.valid(s)} · checked ${ago(s.checked_at)}${s.source === 'browser' ? ' · from the browser sign-in' : ''}`
    : s.message || (s.state === 'none' ? d.none : '');
  return `<div class="panel-head" data-key="h"><h2>${d.title}</h2><span class="chip ${k}">${t}</span></div>
    <div class="form" data-key="f">
      <span class="lab">Sign in</span>
      <div class="ctl">
        ${env ? '' : `<div class="row-inline nowrap">${signing
          ? '<button class="btn" type="button" data-cancellogin>Cancel sign-in</button>'
          : `<button class="btn primary" type="button" data-login ${otherSigning ? 'disabled' : ''}>Sign in with browser</button>`}
          <button class="btn" type="button" data-clearsess ${s.state === 'none' || signing ? 'disabled' : ''}>Clear</button></div>`}
        <div class="hint">${esc(note)}${env ? ` Provided by ${d.env} in the environment.` : ''}</div>
        ${env ? '' : '<div class="hint">Opens Chrome (or Edge) on its own profile in data/browser and closes it once the cookie is read. Sign in there once; later sign-ins finish on their own. The cookie stays on this machine.</div>'}
      </div>
      ${env ? '' : `<label class="lab" for="sess-${site}">Or paste</label>
      <div class="ctl"><div class="row-inline nowrap">
        <label class="field grow"><input id="sess-${site}" type="password" autocomplete="off" placeholder="${d.cookie} value"><button class="linkbtn" type="button" data-reveal>Show</button></label>
        <button class="btn" type="button" data-savesess>Save</button></div></div>`}
    </div>`;
}

function timerHTML() {
  const t = T.timer;
  return `<div class="panel-head"><h2>Scheduled downloads</h2></div>
    <div class="form">
      <span class="lab">Timers</span>
      <div class="ctl"><div class="seg" role="group" aria-label="Timers"><button type="button" data-timers="off" aria-pressed="${!T.values.timers_enabled}">Off</button><button type="button" data-timers="on" aria-pressed="${!!T.values.timers_enabled}">On</button></div>
        <div class="hint">Off by default. Turn on to run global and creator timers. Changes take effect immediately.</div></div>
      <span class="lab" data-lab="global_timer">Default timer</span>
      <div class="ctl"><div class="row-inline">
        <div class="seg" role="group" aria-label="Frequency">${[['', 'None'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']].map(([v, l]) => `<button type="button" data-timer="${v}" aria-pressed="${t.type === v}">${l}</button>`).join('')}</div>
        <label class="field tiny" title="Time (HH:MM)"><input id="t-time" data-timerfield value="${esc(t.time)}" aria-label="Time"></label>
        <label class="field tiny" title="Day"><input id="t-day" data-timerfield value="${esc(t.day)}" placeholder="Day" aria-label="Day"></label></div>
        <div class="hint">Local time. Weekly: day 0 is Monday. Monthly: day of the month. A creator can have its own timer.</div></div>
    </div>`;
}

function appearanceHTML() {
  const theme = prefs.get('theme', 'system');
  return `<div class="panel-head"><h2>Appearance</h2></div>
    <div class="form"><span class="lab">Theme</span><div class="ctl"><div class="seg" role="group" aria-label="Theme">${[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button type="button" data-theme="${k}" aria-pressed="${theme === k}">${l}</button>`).join('')}</div>
      <div class="hint">Kept in this browser. System follows the operating system's light or dark mode.</div></div></div>`;
}

const savedTimer = () => {
  const g = T.values.global_timer || {};
  return { type: g.type || '', time: g.time || '00:00', day: g.day ?? '' };
};

// What differs from the saved settings, as the request body would carry it.
function changes() {
  const out = {};
  for (const input of T.el.querySelectorAll('input[data-field]:not([disabled])')) {
    const key = input.dataset.field;
    const kind = input.dataset.kind;
    const now = parse(kind, input.value);
    if (!same(now, parse(kind, String(shownValue(kind, getPath(T.values, key)))))) out[key] = now;
  }
  for (const [key, value] of Object.entries(T.choice)) if (value !== T.values[key]) out[key] = value;
  const t = { type: T.timer.type, time: T.el.querySelector('#t-time').value.trim() || '00:00', day: T.el.querySelector('#t-day').value.trim() };
  const was = savedTimer();
  if (t.type !== was.type || (t.type && (t.time !== was.time || String(t.day) !== String(was.day)))) {
    out.global_timer = t.type ? { type: t.type, time: t.time, ...(t.day !== '' ? { day: Number(t.day) } : {}) } : null;
  }
  return out;
}

function syncDirty() {
  const changed = changes();
  const keys = new Set(Object.keys(changed));
  T.el.querySelectorAll('[data-lab]').forEach((l) => l.classList.toggle('dirty', keys.has(l.dataset.lab)));
  const n = keys.size;
  T.dirty = n;
  const running = T.running;
  patch(T.el.querySelector('[data-savebar]'), `<span class="msg" data-key="m">${running ? 'A job is running; settings can be saved when it ends.' : n ? `${n} unsaved change${n === 1 ? '' : 's'}` : 'All changes saved'}</span>
    <button class="btn" type="button" data-key="d" data-discard ${n ? '' : 'disabled'}>Discard</button>
    <button class="btn primary" type="button" data-key="s" data-save ${n && !running ? '' : 'disabled'}>Save changes</button>`);
  T.el.querySelector('[data-savebar]').classList.toggle('dirty', !!n);
}

// Sends every change in one request. Nested values (the filter) go as their whole object.
async function save() {
  const changed = changes();
  const body = {};
  for (const [key, v] of Object.entries(changed)) {
    const [top, sub] = key.split('.');
    if (!sub) { body[top] = v; continue; }
    body[top] = body[top] || { ...(T.values[top] || {}) };
    if ((Array.isArray(v) && !v.length) || v === '') delete body[top][sub];
    else body[top][sub] = v;
  }
  const out = await attempt(() => api('settings', { method: 'PATCH', body }), 'Saved');
  if (!out) return;
  T.values = out.values;
  // Show the values as the server keeps them (a size typed as "60gb" comes back normalised).
  for (const input of T.el.querySelectorAll('input[data-field]')) {
    if (changed[input.dataset.field] !== undefined) input.value = shownValue(input.dataset.kind, getPath(T.values, input.dataset.field));
  }
  syncDirty();
}

function discard() {
  for (const input of T.el.querySelectorAll('input[data-field]')) input.value = shownValue(input.dataset.kind, getPath(T.values, input.dataset.field));
  T.choice = Object.fromEntries(Object.keys(CHOICES).map((k) => [k, T.values[k]]));
  T.el.querySelectorAll('[data-choice]').forEach((b) => b.setAttribute('aria-pressed', String(T.choice[b.dataset.choice] === b.dataset.value)));
  T.timer = savedTimer();
  patch(T.el.querySelector('[data-sec="schedule"]'), timerHTML());
  syncDirty();
}

async function refreshSession(site) {
  const mine = T;
  const [state, login] = await Promise.all([api('state'), api(`${site}/login`)]);
  if (T !== mine) return;
  T.state = state;
  T.login[site] = login;
  for (const s of Object.keys(SITES)) patch(T.el.querySelector(`[data-sec="${s}"]`), sessionHTML(s));
  if (login.state === 'waiting') watchLogin(site);
}

// Polls a running browser sign-in until it ends, redrawing only its panel.
async function watchLogin(site) {
  const mine = T;
  if (mine.watching.has(site)) return;
  mine.watching.add(site);
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      if (T !== mine) return;
      const st = await api(`${site}/login`).catch(() => null);
      if (st?.state === 'waiting') continue;
      if (st) toast(st.message || st.state, st.state === 'failed');
      break;
    }
  } finally {
    mine.watching.delete(site);
  }
  if (T === mine) refreshSession(site);
}

export async function mountSettings(el) {
  const [settings, state, login, plogin] = await Promise.all([
    api('settings'), api('state'), api('fanbox/login'), api('patreon/login'),
  ]);
  T = {
    el, values: settings.values, env: settings.env, state, login: { fanbox: login, patreon: plogin },
    choice: Object.fromEntries(Object.keys(CHOICES).map((k) => [k, settings.values[k]])),
    timer: null, dirty: 0, running: false, watching: new Set(),
  };
  T.timer = savedTimer();
  const mine = T;
  const title = (id) => SECTIONS.find(([k]) => k === id)[1] || FIELDS[id][0];
  const section = (id) => {
    if (id === 'appearance') return appearanceHTML();
    if (id === 'fanbox' || id === 'patreon') return sessionHTML(id);
    if (id === 'schedule') return timerHTML();
    return `<div class="panel-head"><h2>${FIELDS[id][0]}</h2></div><div class="form">${FIELDS[id][1].map(fieldHTML).join('')}</div>`;
  };
  el.innerHTML = `<div class="view narrow">
    <div class="view-head"><div><h1>Settings</h1><p class="lede">Saved in data/config.json. PAWCHIVE_* values in .env win.</p></div></div>
    <div class="settings">
      <nav class="set-nav" aria-label="Sections">${SECTIONS.map(([id]) => `<a href="#/settings" data-goto="${id}">${title(id)}</a>`).join('')}</nav>
      <div class="set-main">${SECTIONS.map(([id]) => `<section class="panel" id="sec-${id}" data-sec="${id}">${section(id)}</section>`).join('')}</div>
    </div>
    <div class="savebar" data-savebar></div>
  </div>`;
  syncDirty();
  for (const site of Object.keys(SITES)) if (T.login[site]?.state === 'waiting') watchLogin(site);

  // The section in view is marked in the index beside it.
  const navLinks = new Map([...el.querySelectorAll('[data-goto]')].map((a) => [a.dataset.goto, a]));
  const seen = new Map();
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) seen.set(e.target.dataset.sec, e.isIntersecting);
    const first = SECTIONS.map(([id]) => id).find((id) => seen.get(id));
    navLinks.forEach((a, id) => a.classList.toggle('on', id === first));
  }, { root: el, rootMargin: '0px 0px -60% 0px' });
  el.querySelectorAll('[data-sec]').forEach((s) => observer.observe(s));

  const offState = on('state', (s) => {
    if (T !== mine) return;
    const running = s.jobs.some((j) => j.status === 'running');
    if (running !== T.running) { T.running = running; syncDirty(); }
  });
  const unload = (e) => { if (T === mine && T.dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', unload);

  el.oninput = (e) => { if (e.target.closest('[data-field], [data-timerfield]')) syncDirty(); };
  el.onclick = async (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) {
      e.preventDefault();
      el.querySelector(`#sec-${go.dataset.goto}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const b = e.target.closest('button');
    if (!b) return;
    const press = () => b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    const site = b.closest('[data-sec="fanbox"], [data-sec="patreon"]')?.dataset.sec;
    if (b.dataset.theme) {
      prefs.set('theme', b.dataset.theme);
      applyTheme(b.dataset.theme);
      press();
      return;
    }
    if (b.dataset.reveal !== undefined) {
      const i = el.querySelector(`#sess-${site}`);
      i.type = i.type === 'password' ? 'text' : 'password';
      b.textContent = i.type === 'password' ? 'Show' : 'Hide';
      return;
    }
    if (b.dataset.login !== undefined) {
      if (await attempt(() => api(`${site}/login`, { method: 'POST' }))) await refreshSession(site);
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
      return refreshSession(site);
    }
    if (b.dataset.choice) { T.choice[b.dataset.choice] = b.dataset.value; press(); syncDirty(); return; }
    if (b.dataset.timers) {
      const turnOn = b.dataset.timers === 'on';
      const out = await attempt(() => api('settings', { method: 'PATCH', body: { timers_enabled: turnOn } }), turnOn ? 'Timers on' : 'Timers off');
      if (out) { T.values.timers_enabled = out.values.timers_enabled; press(); }
      return;
    }
    if (b.dataset.timer !== undefined) { T.timer.type = b.dataset.timer; press(); syncDirty(); return; }
    if (b.dataset.save !== undefined) return save();
    if (b.dataset.discard !== undefined) return discard();
  };

  return {
    cleanup: () => { observer.disconnect(); offState(); window.removeEventListener('beforeunload', unload); if (T === mine) T = null; },
    guard: async () => !T || T !== mine || !T.dirty || !!(await dialog({
      title: 'Leave without saving?',
      body: `<p>${T.dirty} change${T.dirty === 1 ? '' : 's'} on this page ${T.dirty === 1 ? 'is' : 'are'} not saved and will be lost.</p>`,
      confirm: 'Discard and leave',
      danger: true,
    })),
  };
}
