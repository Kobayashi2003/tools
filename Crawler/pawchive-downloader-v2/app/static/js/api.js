// Every URL is relative to the document, so the app works under a gateway prefix.
export async function api(path, { method = 'GET', body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch('api/' + path, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
    } catch {
      /* body was not JSON */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json();
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

let toastTimer = 0;
export function toast(message, error = false) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.className = 'toast' + (error ? ' err' : '');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 6000 : 3000);
}

export async function attempt(fn, done) {
  try {
    const out = await fn();
    if (done) toast(typeof done === 'function' ? done(out) : done);
    return out;
  } catch (e) {
    toast(e.message, true);
    return undefined;
  }
}

const pad = (n) => String(n).padStart(2, '0');

// Stored times are naive UTC; folders use the UTC date.
export function at(utc, offsetMinutes = 0) {
  if (!utc) return null;
  const d = new Date(utc + 'Z');
  d.setUTCMinutes(d.getUTCMinutes() + offsetMinutes);
  return {
    date: `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

export const localOffset = () => -new Date().getTimezoneOffset();

export function localTime(utc) {
  const t = at(utc, localOffset());
  return t ? `${t.date.slice(5).replace('.', '-')} ${t.time}` : '';
}

// Retry lines arrive in bursts that differ only in numbers (offset, attempt, wait), and
// interleave with other lines when several jobs run. Events (newest first) that match once
// digits are removed fold into one row while within 15 minutes of that row's newest.
const RETRY = /^(Pawchive|Fanbox) (.+?): (\d{3}|\w+) · attempt \d+ failed/;
const WINDOW_MS = 15 * 60 * 1000;
export function groupEvents(events) {
  const out = [];
  const open = new Map();
  for (const e of events) {
    const key = `${e.level}|${e.message.replace(/\d+/g, '#')}`;
    const g = open.get(key);
    if (g && new Date(g.latest.at + 'Z') - new Date(e.at + 'Z') <= WINDOW_MS) {
      g.count++;
      g.first = e;
      continue;
    }
    const fresh = { key, count: 1, latest: e, first: e };
    open.set(key, fresh);
    out.push(fresh);
  }
  for (const g of out) {
    const m = g.latest.message.match(RETRY);
    g.text = m
      ? `${m[1]} ${m[3] === '429' ? 'is rate limiting (429)' : `request failed (${m[3]})`}; retrying`
      : g.latest.message;
  }
  return out;
}

export function ago(utc) {
  if (!utc) return 'never';
  const s = (Date.now() - new Date(utc + 'Z').getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return utc.slice(0, 10);
}

export const fmtSize = (n) => {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return i ? `${v.toFixed(1)} ${u[i]}` : `${v} B`;
};
