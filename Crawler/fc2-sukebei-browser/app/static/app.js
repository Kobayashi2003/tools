// FC2 Sukebei Browser — single-page UI.
//
// The library grid lists one card per FC2 id. Hovering a card cycles through its preview clips
// (or sample images) like an animated GIF; clicking opens the detail view with torrents, magnets,
// preview clips, the official sample video and sample images. All media loads through /media.

import { enhanceSelect } from './controls.js';
import { applyStatic, getLang, setLang, t } from './i18n.js';
import { sortedTorrents, bestTorrent, updateRegion } from './presentation.js';

const PAGE = 60;
const REFRESH_CAP = 1000;
const $ = (sel, root = document) => root.querySelector(sel);

// --- small helpers ---------------------------------------------------------------------------

// DOM builder; children may be strings, nodes, arrays or null. Text is never parsed as HTML.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// `v` (the title's fetched_at) changes after a refresh, so the browser drops its cached copy.
const media = (url, v) => (url ? `media?u=${encodeURIComponent(url)}${v ? `&v=${v}` : ''}` : '');
const code = (id) => `FC2-PPV-${id}`;

// Inline icons drawn with currentColor (static markup, never user data).
const ICONS = {
  magnet: '<path d="M6 4h4v7a2 2 0 0 0 4 0V4h4v7a6 6 0 0 1-12 0z"/><path d="M6 8h4M14 8h4"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  bookmark: '<path d="M7 4h10v16l-5-3.6L7 20z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
};

function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = `ico ico-${name} ${cls}`.trim();
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  return span;
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return t('ago_s');
  if (s < 3600) return t('ago_m', { n: Math.floor(s / 60) });
  if (s < 86400) return t('ago_h', { n: Math.floor(s / 3600) });
  return t('ago_d', { n: Math.floor(s / 86400) });
}

const fullDate = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : '');

async function api(path, options = {}) {
  const init = { ...options };
  if (['POST', 'PUT', 'PATCH'].includes(init.method)) {
    init.body = JSON.stringify(init.body ?? {});
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const message = (await res.json()).detail;
      if (typeof message === 'string') detail = message;
      else if (Array.isArray(message)) detail = message.map((item) => item.msg || JSON.stringify(item)).join('; ') || detail;
      else if (message) detail = JSON.stringify(message);
    } catch { /* not json */ }
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

let toastTimer = 0;
function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2200);
}

async function copy(text, message = t('copied')) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast(t('copyFailed'), 'error');
  }
}

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`fc2sb.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`fc2sb.${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

// Titles added since the previous visit get a dot until they are opened.
const lastVisit = (() => {
  const previous = store.get('lastVisit', null);
  store.set('lastVisit', Math.floor(Date.now() / 1000));
  return previous;
})();

// --- state -----------------------------------------------------------------------------------

const state = {
  filters: store.get('filters', { q: '', view: 'all', sort: 'uploaded', minSeeders: 0, mediaOnly: false }),
  items: [],
  total: 0,
  loading: false,
  done: false,
  requestId: 0,
  detailIndex: -1,
  detail: null,
  detailRequest: 0,
};
state.filters.q = '';

// --- library grid ----------------------------------------------------------------------------

function query(offset, limit) {
  const f = state.filters;
  const params = new URLSearchParams({
    q: f.q, view: f.view, sort: f.sort, min_seeders: f.minSeeders || 0,
    media_only: f.mediaOnly, offset, limit,
  });
  return api(`api/titles?${params}`);
}

async function loadMore(reset = false, size = PAGE) {
  if (state.loading && !reset) return;
  if (!reset && state.done) return;
  const requestId = ++state.requestId;
  state.loading = true;
  $('#grid').setAttribute('aria-busy', 'true');
  if (!state.items.length) renderGridSkeleton();
  try {
    const data = await query(reset ? 0 : state.items.length, size);
    if (requestId !== state.requestId) return;
    if (reset) {
      state.items = [];
      $('#grid').replaceChildren();
      window.scrollTo({ top: 0 });
    }
    state.items.push(...data.items);
    state.total = data.total;
    state.done = state.items.length >= data.total;
    $('#grid').append(...data.items.map(buildCard));
    syncDividers();
    renderCount();
  } catch (err) {
    toast(`${t('error')}: ${err.message}`, 'error');
  } finally {
    if (requestId === state.requestId) {
      state.loading = false;
      $('#grid').setAttribute('aria-busy', 'false');
      $('#grid').querySelectorAll('.skeleton').forEach(el => el.remove());
      renderCount();
    }
  }
  // Keep filling while the sentinel is still on screen (large monitors, short pages). The observer
  // only fires on visibility changes, so reaching the end while it stays visible is checked here.
  if (isSentinelVisible()) {
    if (!state.done) loadMore();
    else maybeLoadOlder();
  }
}

function isSentinelVisible() {
  const rect = $('#sentinel').getBoundingClientRect();
  return rect.top < window.innerHeight + 600;
}

// Re-read the loaded window and patch cards in place (used while metadata streams in).
async function refreshLoaded() {
  if (state.loading) return;
  const requestId = ++state.requestId;
  state.loading = true;
  // Re-read everything loaded (up to the API cap), so a rebuild keeps the page height and scroll.
  const limit = Math.min(REFRESH_CAP, Math.max(PAGE, state.items.length));
  try {
    const data = await query(0, limit);
    if (requestId !== state.requestId) return;
    const grid = $('#grid');
    const sameOrder = data.items.every((item, i) => !state.items[i] || state.items[i].fc2_id === item.fc2_id);
    const openId = state.detail?.fc2_id;
    if (!sameOrder) {
      // The order shifted (e.g. new uploads on top): start over from the refreshed window so the
      // grid, state.items and the next loadMore offset stay in step.
      grid.replaceChildren(...data.items.map(buildCard));
      state.items = data.items;
    } else {
      const cards = cardElements();
      const next = data.items.map((item, i) => {
        const old = state.items[i];
        const card = cards[i];
        if (!card) grid.append(buildCard(item));
        else if (!old || cardKey(old) !== cardKey(item)) {
          if (card.matches(':hover')) return old; // don't interrupt a playing preview; update next poll
          const focused = card.contains(document.activeElement);
          const control = focused ? ['.star', '.mark', '.copy', '.magnet', '.code'].find(sel => document.activeElement.matches(sel)) : null;
          const fresh = buildCard(item);
          card.replaceWith(fresh);
          if (focused) (control ? $(control, fresh) : fresh)?.focus({ preventScroll: true });
        }
        return item;
      });
      // Keep anything loaded beyond the refreshed window.
      state.items = next.concat(state.items.slice(next.length));
    }
    cardElements().slice(state.items.length).forEach((card) => card.remove());
    syncDividers();
    viewOrder = null;
    if (openId) state.detailIndex = state.items.findIndex((x) => x.fc2_id === openId);
    state.total = data.total;
    state.done = state.items.length >= data.total;
    renderCount();
  } catch { return; /* transient; the next poll retries */ } finally {
    if (requestId === state.requestId) state.loading = false;
  }
  // The library may have grown while the user waits at the end of the grid: show the new titles.
  if (isSentinelVisible()) {
    if (!state.done) loadMore();
    else maybeLoadOlder();
  }
}

const cardElements = () => [...$('#grid').querySelectorAll(':scope > .card')];

function renderGridSkeleton() {
  $('#grid').replaceChildren(...Array.from({ length: PAGE }, () => h('div', { class: 'card skeleton', 'aria-hidden': 'true' },
    h('div', { class: 'thumb' }), h('div', { class: 'card-body' },
      h('div', { class: 'sk-line' }), h('div', { class: 'sk-line' }), h('div', { class: 'sk-line short' })))));
}

function emptyState(title, hint, action = null) {
  return h('div', { class: 'empty-state' }, icon('image'), h('h3', {}, title), h('p', {}, hint), action);
}

// Sorted by upload or by addition, the grid is split into days ("Today", "Yesterday", "Oct 7").
const DAY_FIELDS = { uploaded: 'uploaded', added: 'added' };

function dayStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function dayLabel(ts) {
  const date = new Date(ts * 1000);
  const diff = Math.round((dayStart(new Date()) - dayStart(date)) / 86400000);
  if (diff === 0) return t('today');
  if (diff === 1) return t('yesterday');
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(getLang() === 'ja' ? 'ja-JP' : 'en-US',
    { weekday: 'short', month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
}

function syncDividers() {
  const grid = $('#grid');
  const old = new Map([...grid.querySelectorAll(':scope > .day')].map(el => [el.dataset.day, el]));
  const field = DAY_FIELDS[state.filters.sort];
  if (!field) { old.forEach(el => el.remove()); return; }
  let last = null;
  for (const card of cardElements()) {
    const ts = Number(card.dataset[field]) || 0;
    const key = ts ? dayStart(new Date(ts * 1000)) : 0;
    if (key !== last) {
      const heading = old.get(String(key)) || h('h2', { class: 'day', dataset: { day: key } });
      old.delete(String(key));
      heading.textContent = ts ? dayLabel(ts) : '—';
      if (card.previousElementSibling !== heading) card.before(heading);
      last = key;
    }
  }
  old.forEach(el => el.remove());
}

const cardKey = (item) => [item.fc2_state, item.pp_state, item.title, item.cover, item.clips.length, item.samples.length,
  item.seeders, item.torrent_count, item.starred, item.hidden, item.risky, !!item.viewed_at, item.fetched_at].join('|');

function renderCount() {
  $('#result-count').textContent = t('results', { n: state.total.toLocaleString() });
  if (state.total > (renderCount.lastTotal ?? Infinity)) autoOlderArmed = true;   // the library grew
  renderCount.lastTotal = state.total;
  renderLibraryEnd();
  updateMarkCounter();
  const empty = $('#empty');
  const nothing = state.items.length === 0 && !state.loading;
  empty.hidden = !nothing;
  if (nothing) {
    const f = state.filters;
    const filtered = f.q || f.view !== 'all' || f.minSeeders > 0 || f.mediaOnly;
    updateRegion(empty, [!!filtered, getLang()], () => emptyState(t(filtered ? 'emptyFilter' : 'emptyTitle'),
      t(filtered ? 'emptyFilterHint' : 'emptyHint'), h('button', { class: 'btn', type: 'button',
        onclick: filtered ? clearFilters : () => startJob('update') }, t(filtered ? 'clearFilters' : 'update'))));
  }
}

function buildCard(item) {
  const pending = item.fc2_state === '';
  const clipsPending = item.pp_state === '';
  const cover = item.cover ? h('img', {
    class: 'cover', src: media(item.cover, item.fetched_at), loading: 'lazy', alt: '', referrerpolicy: 'no-referrer',
    onerror: (e) => e.target.classList.add('broken'),
  }) : h('div', { class: 'cover placeholder' },
    pending ? t('fetchingInfo') : clipsPending ? t('coverPending') : t('noCover'));

  const previewCount = item.clips.length || item.samples.length;
  const thumb = h('div', { class: `thumb${pending ? ' pending' : ''}` },
    cover,
    item.duration ? h('span', { class: 'chip duration' }, item.duration.replace(/^00:/, '')) : null,
    item.clips.length ? h('span', { class: 'chip previews', title: t('clips') }, icon('play'), item.clips.length)
      : clipsPending && !pending ? h('span', { class: 'chip previews wait', title: t('clipsPending') }, icon('play'), '…')
        : previewCount ? h('span', { class: 'chip previews', title: t('sampleImages') }, `▣ ${item.samples.length}`) : null,
    item.risky ? h('span', { class: 'chip risky', title: t('riskyTitle') }, icon('alert'), t('risky')) : null,
  );
  attachHoverPreview(thumb, item);
  if (clipsPending || pending) {
    // Lingering on a card that is still waiting moves it to the front of the fetch queue.
    let timer = 0;
    thumb.addEventListener('pointerenter', () => {
      timer = setTimeout(() => api(`api/titles/${item.fc2_id}/prioritize`, { method: 'POST' }).catch(() => {}), 600);
    });
    thumb.addEventListener('pointerleave', () => clearTimeout(timer));
  }

  const fresh = !item.viewed_at && lastVisit && item.added_at > lastVisit;
  const card = h('article', {
    class: `card${item.viewed_at ? ' seen' : ''}${item.hidden ? ' is-hidden' : ''}${fresh ? ' fresh' : ''}${marks.has(item.fc2_id) ? ' marked' : ''}`,
    dataset: { id: item.fc2_id, uploaded: item.uploaded_at || 0, added: item.added_at || 0 },
    'aria-label': code(item.fc2_id),
    tabIndex: 0,
    onclick: (e) => {
      if (e.target.closest('a, button')) return;
      openDetail(state.items.findIndex((x) => x.fc2_id === item.fc2_id));
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' && e.target === card) openDetail(state.items.findIndex((x) => x.fc2_id === item.fc2_id));
    },
  },
  thumb,
  h('div', { class: 'card-body' },
    h('div', { class: 'card-top' },
      h('button', { class: 'code', type: 'button', title: t('copyCode'), onclick: () => copy(code(item.fc2_id)) },
        fresh ? h('span', { class: 'fresh-dot', title: t('freshTitle') }) : null, code(item.fc2_id)),
      h('button', {
        class: `icon star${item.starred ? ' on' : ''}`, type: 'button', title: item.starred ? t('unstar') : t('star'),
        'aria-label': item.starred ? t('unstar') : t('star'),
        'aria-pressed': String(item.starred), onclick: () => setFlags(item.fc2_id, { starred: !item.starred }),
      }, icon('star')),
      h('button', {
        class: `icon mark${marks.has(item.fc2_id) ? ' on' : ''}`, type: 'button',
        title: marks.has(item.fc2_id) ? t('unmark') : t('mark'), 'aria-pressed': String(marks.has(item.fc2_id)),
        'aria-label': marks.has(item.fc2_id) ? t('unmark') : t('mark'),
        onclick: () => toggleMark(item.fc2_id),
      }, icon('bookmark')),
    ),
    h('h3', { class: 'title', title: item.title }, item.title || '—'),
    h('div', { class: 'meta' },
      item.seller ? h('span', { class: 'seller' }, item.seller) : null,
      item.released ? h('span', {}, item.released) : null,
      item.rating != null ? h('span', { class: 'rating' }, `★${item.rating}`) : null,
    ),
    h('div', { class: 'card-foot' },
      h('span', { class: `seeds${item.seeders > 0 ? '' : ' dead'}`, title: 'Seeders' }, `▲ ${item.seeders}`),
      h('span', {}, fmtSize(item.size_bytes)),
      item.torrent_count > 1 ? h('span', { class: 'count', title: t('torrents') }, `×${item.torrent_count}`) : null,
      h('span', { class: 'when', title: fullDate(item.uploaded_at) }, ago(item.uploaded_at)),
      h('span', { class: 'spacer' }),
      item.magnet ? h('button', {
        class: 'icon copy', type: 'button', title: t('copyMagnet'), 'aria-label': t('copyMagnet'),
        onclick: () => copy(item.magnet, t('magnetCopied')),
      }, icon('copy')) : null,
      item.magnet ? h('a', { class: 'icon magnet', href: item.magnet, title: t('openMagnet'), 'aria-label': t('openMagnet') },
        icon('magnet')) : null,
    ),
  ));
  return card;
}

// Hover → play preview clips back to back (or flip through sample images), like a GIF.
function attachHoverPreview(thumb, item) {
  const clips = item.clips || [];
  const images = (item.samples || []).map((s) => s.thumb);
  if (!clips.length && !images.length) return;
  let timer = 0;
  let index = 0;
  let layer = null;

  const stop = () => {
    clearTimeout(timer);
    clearInterval(timer);
    if (layer) {
      if (layer.tagName === 'VIDEO') { layer.pause(); layer.removeAttribute('src'); layer.load(); }
      layer.remove();
      layer = null;
    }
    thumb.classList.remove('playing');
  };

  const start = () => {
    index = 0;
    if (clips.length) {
      layer = h('video', { class: 'hover-media', muted: true, playsInline: true, autoplay: true, preload: 'auto' });
      layer.muted = true;
      const next = () => {
        layer.src = media(clips[index % clips.length], item.fetched_at);
        index += 1;
        layer.play().catch(() => {});
      };
      layer.addEventListener('ended', next);
      layer.addEventListener('error', () => { if (index < clips.length * 2) next(); });
      layer.addEventListener('playing', () => thumb.classList.add('playing'));
      thumb.append(layer);
      next();
    } else {
      layer = h('img', { class: 'hover-media', alt: '' });
      thumb.append(layer);
      const next = () => { layer.src = media(images[index % images.length], item.fetched_at); index += 1; };
      layer.addEventListener('load', () => thumb.classList.add('playing'), { once: true });
      next();
      timer = setInterval(next, 900);
    }
  };

  thumb.addEventListener('pointerenter', () => { stop(); timer = setTimeout(start, 180); });
  thumb.addEventListener('pointerleave', stop);
}

async function setFlags(fc2Id, flags) {
  try {
    const updated = await api(`api/titles/${fc2Id}/flags`, { method: 'POST', body: flags });
    const i = state.items.findIndex((x) => x.fc2_id === fc2Id);
    if (i >= 0) {
      Object.assign(state.items[i], { starred: updated.starred, hidden: updated.hidden });
      const card = $(`#grid .card[data-id="${fc2Id}"]`);
      // Mirror the server's views: Starred shows starred titles even when hidden.
      const view = state.filters.view;
      const leaves = (view === 'starred' && !updated.starred)
        || (view === 'hidden' && !updated.hidden)
        || ((view === 'all' || view === 'unseen') && updated.hidden);
      if (leaves && state.detailIndex < 0) {
        state.items.splice(i, 1);
        card?.remove();
        state.total -= 1;
        renderCount();
      } else {
        updateCardFlags(card, state.items[i]);
      }
    }
    if (state.detail && state.detail.fc2_id === fc2Id) {
      Object.assign(state.detail, { starred: updated.starred, hidden: updated.hidden });
      renderDetail();
    }
  } catch (err) {
    toast(`${t('error')}: ${err.message}`, 'error');
  }
}

function updateCardFlags(card, item) {
  if (!card) return;
  card.classList.toggle('is-hidden', !!item.hidden);
  card.classList.toggle('marked', marks.has(item.fc2_id));
  for (const [selector, on, label] of [
    ['.star', !!item.starred, t(item.starred ? 'unstar' : 'star')],
    ['.mark', marks.has(item.fc2_id), t(marks.has(item.fc2_id) ? 'unmark' : 'mark')],
  ]) {
    const button = $(selector, card);
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}

// --- detail view -----------------------------------------------------------------------------

async function openDetail(index) {
  if (index < 0 || index >= state.items.length) return;
  state.detailIndex = index;
  const item = state.items[index];
  const request = ++state.detailRequest;
  closeStatusPanel();
  const overlay = $('#detail');
  overlay.hidden = false;
  document.body.classList.add('modal-open');
  $('.nav.prev', overlay).disabled = index === 0;
  $('.nav.next', overlay).disabled = index === state.items.length - 1 && state.done;
  state.detail = { ...item, torrents: null };
  renderDetail();
  $('.detail-panel').focus({ preventScroll: true });
  try {
    const full = await api(`api/titles/${item.fc2_id}`);
    if (state.detailRequest !== request || state.detail?.fc2_id !== item.fc2_id) return;
    state.detail = full;
    item.viewed_at = full.viewed_at;
    $(`#grid .card[data-id="${item.fc2_id}"]`)?.classList.add('seen');
    renderDetail();
    if (full.fc2_state === '' || full.pp_state === '') waitForTitle(full.fc2_id);
  } catch (err) {
    toast(`${t('error')}: ${err.message}`, 'error');
  }
}

// Opening a title moves it to the front of the queue; re-render once its metadata lands.
async function waitForTitle(fc2Id) {
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 2500));
    if (!state.detail || state.detail.fc2_id !== fc2Id) return;
    try {
      const full = await api(`api/titles/${fc2Id}?mark_viewed=false`);
      if (!state.detail || state.detail.fc2_id !== fc2Id) return;
      if (full.fc2_state !== state.detail.fc2_state || full.pp_state !== state.detail.pp_state) {
        state.detail = full;
        renderDetail();
      }
      if (full.fc2_state !== '' && full.pp_state !== '') return;
    } catch { /* keep waiting */ }
  }
}

function closeDetail() {
  const overlay = $('#detail');
  if (overlay.hidden) return;
  for (const video of overlay.querySelectorAll('video')) { video.pause(); video.removeAttribute('src'); video.load(); }
  overlay.hidden = true;
  $('.detail-panel').dataset.id = '';
  document.body.classList.remove('modal-open');
  const id = state.detail?.fc2_id;
  state.detailRequest += 1;
  state.detailIndex = -1;
  state.detail = null;
  if (id) {
    const card = $(`#grid .card[data-id="${id}"]`);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'nearest' });
  }
  refreshLoaded(); // flags changed in the detail view may move cards between views
}

async function stepDetail(step) {
  let next = state.detailIndex + step;
  if (next >= state.items.length && !state.done) {
    await loadMore();
  }
  if (next >= 0 && next < state.items.length) {
    for (const video of $('#detail').querySelectorAll('video')) video.pause();
    openDetail(next);
  }
}

function sourceBadge(label, value, error) {
  const key = { ok: 'srcOk', removed: 'srcRemoved', missing: 'srcMissing', error: 'srcError' }[value] || 'srcPending';
  return h('span', { class: `src src-${value || 'pending'}`, title: error || null }, `${label}: ${t(key)}`);
}

function section(title, ...body) {
  return h('section', { class: 'd-section' }, h('h3', {}, title), ...body);
}

function renderDetail() {
  const d = state.detail;
  const panel = $('.detail-panel');
  const pending = d.fc2_state === '' || d.pp_state === '';
  const images = d.samples.map((s) => s.full);
  const v = d.fetched_at;
  if (panel.dataset.id !== d.fc2_id) {
    panel.dataset.id = d.fc2_id;
    const menu = h('details', { class: 'detail-menu' },
      h('summary', { class: 'btn square', 'aria-label': t('moreActions'), title: t('moreActions') }, '⋯'),
      h('div', { class: 'popover action-menu' },
        h('button', { class: 'menu-hide', type: 'button', onclick: () => setFlags(d.fc2_id, { hidden: !state.detail.hidden }) }),
        h('button', { type: 'button', onclick: () => refreshTitle(d.fc2_id) }, t('refresh')),
        ...[
          ['FC2', `https://adult.contents.fc2.com/article/${d.fc2_id}/`],
          ['paipancon', `https://paipancon.com/fc2daily/detail/${code(d.fc2_id)}`],
          ['sukebei', `https://sukebei.nyaa.si/?f=0&c=0_0&q=${d.fc2_id}`],
        ].map(([site, href]) => h('a', { href, target: '_blank', rel: 'noreferrer' }, t('openOn', { site })))));
    menu.addEventListener('click', (event) => { if (event.target.closest('.action-menu a, .action-menu button')) menu.open = false; });
    panel.replaceChildren(
      h('header', { class: 'd-head' },
        h('button', { id: 'detail-code', class: 'code big', type: 'button', title: t('copyCode'), onclick: () => copy(code(d.fc2_id)) }, code(d.fc2_id), icon('copy')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn d-star', type: 'button', onclick: () => setFlags(d.fc2_id, { starred: !state.detail.starred }) }, icon('star'), h('span')),
        h('button', { class: 'btn d-mark', type: 'button', onclick: () => toggleMark(d.fc2_id) }, icon('bookmark'), h('span')),
        menu,
        h('button', { class: 'icon close', type: 'button', 'aria-label': t('close'), onclick: closeDetail }, '×')),
      h('div', { class: 'd-body' },
        h('div', { class: 'd-media' }, h('div', { class: 'd-media-top' }), h('div', { class: 'd-sample' }), h('div', { class: 'd-samples' }), h('div', { class: 'd-contact' })),
        h('div', { class: 'd-sidebar' }, h('div', { class: 'd-info' }), h('section', { class: 'd-section d-torrents' },
          h('h3'), h('div', { class: 'torrents' })))));
    panel.scrollTop = 0;
  }
  const star = $('.d-star', panel);
  const mark = $('.d-mark', panel);
  star.classList.toggle('on', !!d.starred);
  star.setAttribute('aria-pressed', String(!!d.starred));
  $('span:not(.ico)', star).textContent = t(d.starred ? 'unstar' : 'star');
  mark.classList.toggle('on', marks.has(d.fc2_id));
  mark.setAttribute('aria-pressed', String(marks.has(d.fc2_id)));
  $('span:not(.ico)', mark).textContent = t(marks.has(d.fc2_id) ? 'unmark' : 'mark');
  $('.menu-hide', panel).textContent = t(d.hidden ? 'unhide' : 'hide');
  $('.d-star', panel).setAttribute('aria-label', t(d.starred ? 'unstar' : 'star'));
  $('.d-mark', panel).setAttribute('aria-label', t(marks.has(d.fc2_id) ? 'unmark' : 'mark'));
  $('.d-head .close', panel).setAttribute('aria-label', t('close'));
  $('.detail-menu summary', panel).setAttribute('aria-label', t('moreActions'));
  $('.detail-menu summary', panel).title = t('moreActions');
  $('.action-menu button:not(.menu-hide)', panel).textContent = t('refresh');
  $('.action-menu', panel).querySelectorAll('a').forEach((link, i) => { link.textContent = t('openOn', { site: ['FC2', 'paipancon', 'sukebei'][i] }); });

  const sampleImages = () => h('div', { class: 'image-grid' }, d.samples.map((s, i) => h('button', {
    class: 'image-shot', type: 'button', 'aria-label': `${t('sampleImages')} ${i + 1}`, onclick: () => openLightbox(images, i, v),
  }, h('img', { src: media(s.thumb, v), loading: 'lazy', alt: '', onerror: (e) => e.target.classList.add('broken') }))));
  const coverUrl = d.cover_full || d.cover;
  updateRegion($('.d-media-top', panel), [coverUrl, d.clips, d.samples, pending, v, getLang()], () => !coverUrl && !d.clips.length && !d.samples.length
    ? h('div', { class: 'media-empty wide' }, emptyState(t(pending ? 'fetchingInfo' : 'noMediaTitle'), t(pending ? 'metadataHint' : 'noMedia')))
    : [
    h('div', { class: 'd-cover' }, coverUrl
      ? h('button', { class: 'cover-shot', type: 'button', 'aria-label': t('viewCover'), onclick: () => openLightbox([coverUrl, ...images], 0, v) },
        h('img', { src: media(coverUrl, v), alt: '', onerror: (e) => e.target.classList.add('broken') }))
      : h('div', { class: 'cover placeholder' }, emptyState(t(pending ? 'fetchingInfo' : 'noCover'), t(pending ? 'metadataHint' : 'noMedia')))),
    d.clips.length ? section(`${t('clips')} (${d.clips.length})`,
      h('div', { class: 'clip-grid' }, d.clips.map((url, i) => h('div', { class: 'clip-frame' }, h('video', {
        src: media(url, v), muted: true, loop: true, autoplay: true, playsInline: true, preload: 'metadata',
        tabindex: 0, 'aria-label': `${t('clipAudio')} ${i + 1}`,
        onclick: (e) => { e.target.muted = !e.target.muted; },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); e.target.muted = !e.target.muted; } },
      })))))
      : d.samples.length ? section(`${t('sampleImages')} (${d.samples.length})`, sampleImages())
        : h('div', { class: 'media-empty' }, emptyState(t(pending ? 'fetchingInfo' : 'noMediaTitle'), t(pending ? 'metadataHint' : 'noMedia'))),
  ]);

  updateRegion($('.d-info', panel), [d.title, d.seller, d.seller_url, d.released, d.duration, d.rating, d.reviews, d.tags, d.fc2_state, d.pp_state, d.errors, getLang()], () => [
      h('h2', {}, d.title || '—'),
      h('dl', {},
        d.seller ? [h('dt', {}, t('seller')), h('dd', { class: 'seller-line' }, d.seller_url
          ? h('a', { href: d.seller_url, target: '_blank', rel: 'noreferrer' }, d.seller) : d.seller,
          h('button', { class: 'text-button', type: 'button', onclick: () => { closeDetail(); setFilterQuery(d.seller); } }, t('filter')))] : null,
        d.released ? [h('dt', {}, t('released')), h('dd', {}, d.released)] : null,
        d.duration ? [h('dt', {}, t('duration')), h('dd', {}, d.duration)] : null,
        d.rating != null ? [h('dt', {}, t('rating')), h('dd', {},
          h('span', { class: 'stars' }, '★'.repeat(d.rating) + '☆'.repeat(5 - d.rating)),
          d.reviews != null ? h('span', { class: 'dim' }, ` · ${t('reviews', { n: d.reviews })}`) : null)] : null,
        d.tags.length ? [h('dt', {}, t('tags')), h('dd', { class: 'tags' }, d.tags.map((tag) => h('button', {
          class: 'tag', type: 'button', onclick: () => { closeDetail(); setFilterQuery(tag); },
        }, tag)))] : null,
        [h('dt', {}, t('sources')), h('dd', { class: 'sources' },
          sourceBadge('FC2', d.fc2_state, d.errors?.fc2), sourceBadge('paipancon', d.pp_state, d.errors?.pp))],
      ),
  ]);
  updateRegion($('.d-sample', panel), [d.fc2_id, getLang()], () => section(t('sampleVideo'), h('div', { class: 'sample-slot' },
    h('div', { class: 'sample-prompt' }, icon('play'), h('p', {}, t('sampleHint')),
      h('button', { class: 'btn', type: 'button', onclick: (e) => loadSample(d.fc2_id, e.currentTarget.closest('.sample-slot')) }, t('loadSample'))))));
  updateRegion($('.d-samples', panel), [!!d.clips.length, d.samples, v, getLang()], () => d.clips.length && d.samples.length ? section(`${t('sampleImages')} (${d.samples.length})`, sampleImages()) : null);
  updateRegion($('.d-contact', panel), [d.grid, v, getLang()], () => d.grid ? section(t('contactSheet'), h('button', {
    class: 'contact-shot', type: 'button', 'aria-label': t('contactSheet'), onclick: () => openLightbox([d.grid], 0, v),
  }, h('img', { class: 'contact', src: media(d.grid, v), loading: 'lazy', alt: '' }))) : null);
  renderTorrents();
}

function renderTorrents() {
  const d = state.detail;
  const heading = `${t('torrents')}${d.torrents ? ` (${d.torrents.length})` : ''}`;
  if ($('.d-torrents h3').textContent !== heading) $('.d-torrents h3').textContent = heading;
  const region = $('.torrents');
  if (!d.torrents) {
    if (region.dataset.state !== 'loading') region.replaceChildren(...Array.from({ length: 3 }, () => h('div', { class: 'torrent skeleton', 'aria-hidden': 'true' }, h('div', { class: 'sk-line' }), h('div', { class: 'sk-line short' }))));
    region.dataset.state = 'loading';
    return;
  }
  if (!d.torrents.length) {
    const phase = `empty-${getLang()}`;
    if (region.dataset.state !== phase) region.replaceChildren(emptyState(t('noTorrents'), t('noTorrentsHint')));
    region.dataset.state = phase;
    return;
  }
  region.dataset.state = 'list';
  region.querySelectorAll('.skeleton, .empty-state').forEach(node => node.remove());
  const best = bestTorrent(d.torrents);
  const wanted = new Set(d.torrents.map(tr => String(tr.view_id)));
  let previous = null;
  for (const tr of sortedTorrents(d.torrents)) {
    const key = String(tr.view_id);
    let row = $(`.torrent[data-id="${key}"]`, region);
    const signature = JSON.stringify([tr.view_id, tr.name, tr.seeders, tr.leechers, tr.downloads, tr.size_bytes, tr.risky, tr.flag, getLang()]);
    if (!row || row.dataset.signature !== signature) {
      const fresh = torrentRow(tr);
      fresh.dataset.id = key;
      fresh.dataset.signature = signature;
      if (row) row.replaceWith(fresh);
      row = fresh;
    }
    const isBest = best?.view_id === tr.view_id;
    row.classList.toggle('best', isBest);
    $('.best-badge', row).hidden = !isBest;
    $('.t-magnet', row).classList.toggle('primary', isBest);
    const position = previous ? previous.nextElementSibling : region.firstElementChild;
    if (position !== row) region.insertBefore(row, position);
    previous = row;
  }
  for (const row of region.children) if (!wanted.has(row.dataset.id)) row.remove();
}

function torrentRow(tr) {
  const filesSlot = h('div', { class: 'files', hidden: true });
  const toggle = h('button', { class: 'btn small', type: 'button' }, t('files'));
  toggle.addEventListener('click', async () => {
    if (!filesSlot.hidden) {
      filesSlot.hidden = true;
      toggle.textContent = t('files');
      return;
    }
    filesSlot.hidden = false;
    toggle.textContent = t('hideFiles');
    if (tr.files) { renderFiles(filesSlot, tr); return; }
    filesSlot.replaceChildren(h('div', { class: 'dim' }, t('loadingFiles')));
    try {
      Object.assign(tr, await api(`api/torrents/${tr.view_id}`));
      renderFiles(filesSlot, tr);
      row.querySelector('.badges').replaceChildren(...badges(tr));
      // A newly read file list can reveal risk after a torrent was recommended.
      if (tr.risky) {
        row.classList.add('risky');
        const best = bestTorrent(state.detail?.torrents || []);
        for (const other of document.querySelectorAll('.torrent[data-id]')) {
          const isBest = other.dataset.id === String(best?.view_id);
          other.classList.toggle('best', isBest);
          $('.best-badge', other).hidden = !isBest;
          $('.t-magnet', other).classList.toggle('primary', isBest);
        }
      }
    } catch (err) {
      filesSlot.replaceChildren(h('div', { class: 'error' }, `${t('error')}: ${err.message}`));
    }
  });

  const row = h('div', { class: `torrent${tr.risky ? ' risky' : ''}` },
    h('span', { class: 'best-badge', hidden: true }, t('best')),
    h('div', { class: 't-main' },
      h('a', { class: 't-name', href: `https://sukebei.nyaa.si/view/${tr.view_id}`, target: '_blank', rel: 'noreferrer', title: tr.name }, tr.name),
      h('div', { class: 't-meta' },
        h('span', { class: 'badges' }, badges(tr)),
        h('span', {}, fmtSize(tr.size_bytes)),
        h('span', { class: `seeds${tr.seeders > 0 ? '' : ' dead'}` }, `▲ ${tr.seeders}`),
        h('span', { class: 'leech' }, `▼ ${tr.leechers}`),
        h('span', { class: 'dim' }, `✓ ${tr.downloads}`),
        h('span', { class: 'dim', title: fullDate(tr.uploaded_at) }, ago(tr.uploaded_at)),
      ),
    ),
    h('div', { class: 't-actions' },
      h('a', { class: 'btn small t-magnet', href: tr.magnet, title: t('openMagnet') }, icon('magnet'), t('magnet')),
      h('button', { class: 'btn small', type: 'button', title: t('copyMagnet'), 'aria-label': t('copyMagnet'), onclick: () => copy(tr.magnet, t('magnetCopied')) }, icon('copy')),
      h('a', { class: 'btn small', href: `https://sukebei.nyaa.si/download/${tr.view_id}.torrent`, title: '.torrent' }, '.torrent'),
      toggle,
    ),
    filesSlot,
  );
  return row;
}

function badges(tr) {
  return [
    tr.flag ? h('span', { class: `badge ${tr.flag}` }, t(tr.flag)) : null,
    tr.risky ? h('span', { class: 'badge risky', title: t('riskyTitle') }, `⚠ ${t('risky')}`) : null,
  ].filter(Boolean);
}

const JUNK = /\.(url|html?|txt|mht|chm|lnk|torrent)$/i;

function renderFiles(slot, tr) {
  const files = tr.files || [];
  // Drop the shared top-level folder so paths stay readable.
  const first = files[0]?.path.split('/')[0];
  const shared = files.length && files.every((f) => f.path.includes('/') && f.path.split('/')[0] === first);
  const risky = files.filter((f) => f.risky).length;
  slot.replaceChildren(...[
    risky ? h('div', { class: 'risk-note' }, `⚠ ${t('riskyFiles', { n: risky })} — ${t('riskyTitle')}`) : null,
    h('ul', {}, files.map((f) => h('li', { class: f.risky ? 'risky' : JUNK.test(f.path) ? 'junk' : '' },
      h('span', { class: 'path' }, shared ? f.path.slice(first.length + 1) : f.path),
      h('span', { class: 'size' }, f.size)))),
    tr.description ? h('details', {}, h('summary', {}, t('description')), h('pre', {}, tr.description)) : null,
  ].filter(Boolean));
}

async function loadSample(fc2Id, slot) {
  slot.replaceChildren(h('div', { class: 'sample-prompt' }, h('p', {}, t('loadingSample'))));
  try {
    const { url } = await api(`api/titles/${fc2Id}/sample`);
    slot.replaceChildren(h('video', { class: 'sample-video', src: url, controls: true, autoplay: true, playsInline: true, referrerpolicy: 'no-referrer' }));
  } catch (err) {
    slot.replaceChildren(h('div', { class: 'sample-prompt' }, h('p', {}, err.status === 404 ? t('noSample') : `${t('error')}: ${err.message}`)));
  }
}

async function refreshTitle(fc2Id) {
  try {
    await api(`api/titles/${fc2Id}/refresh`, { method: 'POST' });
    toast(t('refreshQueued'));
    if (state.detail?.fc2_id !== fc2Id) return;
    state.detail.state = 'pending';
    // Poll this title until the worker has re-fetched it.
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      if (!state.detail || state.detail.fc2_id !== fc2Id) return;
      const full = await api(`api/titles/${fc2Id}?mark_viewed=false`);
      if (full.state !== 'pending') {
        state.detail = full;
        renderDetail();
        refreshLoaded();
        return;
      }
    }
  } catch (err) {
    toast(`${t('error')}: ${err.message}`, 'error');
  }
}

// --- lightbox --------------------------------------------------------------------------------

const lightbox = { urls: [], index: 0, version: null, returnFocus: null };

function openLightbox(urls, index, version = null) {
  lightbox.returnFocus = document.activeElement;
  lightbox.urls = urls.filter(Boolean);
  lightbox.version = version;
  lightbox.index = index;
  $('#lightbox').hidden = false;
  showLightbox();
  $('.lb-close').focus({ preventScroll: true });
}

function showLightbox() {
  const box = $('#lightbox');
  const n = lightbox.urls.length;
  lightbox.index = (lightbox.index + n) % n;
  $('img', box).src = media(lightbox.urls[lightbox.index], lightbox.version);
  $('.lb-count', box).textContent = n > 1 ? `${lightbox.index + 1} / ${n}` : '';
  for (const b of box.querySelectorAll('.lb-nav')) b.hidden = n < 2;
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lightbox img').removeAttribute('src');
  if (lightbox.returnFocus?.isConnected) lightbox.returnFocus.focus({ preventScroll: true });
}

// --- crawl & status --------------------------------------------------------------------------
//
// The library grows along two edges: Update fetches new uploads (and runs on a timer server-side),
// Older reads the next blocks of FC2 ids into history. Reaching the end of the grid with no filters
// asks for more history by itself, so scrolling is how the library extends backwards.

let lastStats = null;
let lastStatus = null;
let pollTimer = 0;
let refreshTimer = 0;
let autoOlderArmed = true;      // re-armed whenever the library grows
let autoOlderEmpty = 0;         // automatic history runs in a row that added nothing
let lastJobEnd = null;
const AUTO_OLDER_EMPTY_LIMIT = 3;

async function pollStatus() {
  clearTimeout(pollTimer);
  let busy = false;
  try {
    const status = await api('api/status');
    lastStatus = status;
    busy = renderStatus(status);
    const key = status.stats && `${status.stats.titles}|${status.stats.pending}|${status.stats.torrents}`;
    if (lastStats !== null && key !== lastStats) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshLoaded, 800);
    }
    lastStats = key;
  } catch { /* server restarting; keep polling */ }
  pollTimer = setTimeout(pollStatus, busy ? 2000 : 8000);
}

const jobRunning = () => !!lastStatus?.job?.running;

function jobText(job) {
  const page = Math.max(job.page, 1);
  if (job.kind === 'older') {
    const done = job.blocks ? `${job.blocks_done}/${job.blocks}` : String(job.blocks_done);
    return t(job.range ? 'jobRange' : 'jobOlder', { block: job.block ?? '…', page, done });
  }
  if (job.kind === 'search') return t('jobSearch', { page });
  return t('jobUpdate', { page });
}

function coverageText(c) {
  const history = c.history_complete ? t('covComplete')
    : c.history_next == null ? t('covNotStarted')
      : c.history_phase === 'short' ? t('covShort', { next: c.history_next })
        : t('covDown', {
          from: c.history_next + 1, top: c.history_top, next: c.history_next,
          x: 'x'.repeat(Math.max(0, 7 - (c.history_digits ?? 4))),
        });
  return { history };
}

function renderStatus(status) {
  const job = status.job;
  const crawling = job && job.running;
  const waiting = status.queue + status.active.length;
  const pill = $('#status-pill');
  pill.classList.toggle('busy', crawling || waiting > 0);
  $('#status-text').textContent = crawling ? jobText(job)
    : waiting ? [status.waiting.fc2 ? t('fetchingDetails', { n: status.waiting.fc2 }) : '',
      status.waiting.pp ? t('fetchingClips', { n: status.waiting.pp }) : ''].filter(Boolean).join(' · ') || t('idle')
      : t('idle');
  pill.title = `${t('librarySync')}: ${$('#status-text').textContent}`;
  pill.setAttribute('aria-label', pill.title);
  $('#job-update').hidden = !!crawling;
  $('#job-older').disabled = !!crawling || (status.coverage.history_complete && !older.rangeOn);
  renderOlderOptions();
  $('#job-cancel').hidden = !crawling;
  $('#query-run').disabled = !!crawling;

  const s = status.stats;
  $('#status-stats').removeAttribute('aria-busy');
  updateRegion($('#status-stats'), [s, getLang()], () => [
    ...[['statTitles', s.titles], ['statTorrents', s.torrents], ['statPending', s.pending],
      ['statFailed', s.failed], ['statStarred', s.starred]].map(([k, v]) => h('span', {}, h('b', {}, v.toLocaleString()), ` ${t(k)}`)),
  ]);
  $('#retry-failed').disabled = !s.failed;

  const c = status.coverage;
  renderRuler(c);
  const synced = c.last_update_at ? t('covSynced', { ago: ago(c.last_update_at) }) : t('covNever');
  const auto = status.watch_minutes ? ` · ${t('covAuto', { n: status.watch_minutes })}` : '';
  updateRegion($('#coverage'), [synced, auto, c, getLang()], () => [
    h('dt', {}, t('covNew')), h('dd', {}, synced + auto),
    h('dt', {}, t('covHistory')), h('dd', {}, coverageText(c).history),
    c.update_gap ? h('dd', { class: 'gap' }, `⚠ ${t('covGap')}`) : null,
  ].filter(Boolean));
  $('#history-reset').disabled = !!crawling || c.history_next == null;
  const lines = status.log.slice().reverse();
  updateRegion($('#status-log'), [lines, getLang()], () => lines.length ? lines.map((line) => h('li', { class: line.level },
    h('time', {}, new Date(line.at * 1000).toLocaleTimeString()), ' ', line.message))
    : h('li', { class: 'log-empty' }, t('noActivity')));
  renderLibraryEnd();
  noteJobEnd(job);
  return crawling || waiting > 0;
}

// When a history run ends and the user is still at the end of the grid, keep going: blocks of
// ids already held add nothing, so a few empty runs in a row are allowed before stopping.
function noteJobEnd(job) {
  if (!job || job.running || job.finished_at === lastJobEnd) return;
  const first = lastJobEnd === null;
  lastJobEnd = job.finished_at;
  if (first || job.kind !== 'older' || job.error) return;
  if (job.new_titles > 0) autoOlderEmpty = 0;
  else if (autoOlderEmpty < AUTO_OLDER_EMPTY_LIMIT) { autoOlderEmpty += 1; autoOlderArmed = true; }
  if (state.done && isSentinelVisible()) setTimeout(maybeLoadOlder, 1500);   // after the grid refresh
}

// History progress over all 9000 id blocks (1000-9999), filled from the newest end. The bar's right
// edge is where Update keeps adding new uploads.
function renderRuler(c) {
  const ruler = $('#ruler');
  if (!c.top_block) { updateRegion(ruler, ['empty'], () => []); return; }
  const pct = (c.history_blocks / c.history_total) * 100;
  const shown = pct === 0 ? '0' : pct < 1 ? pct.toFixed(1) : String(Math.round(pct));
  updateRegion(ruler, [c.history_blocks, c.history_total, c.top_block, getLang()], () => [
    h('div', { class: 'ruler-track', role: 'img', 'aria-label': t('rulerShare', { done: c.history_blocks, total: c.history_total, pct: shown }) },
      c.history_blocks ? h('div', { class: 'ruler-fill', style: `width:max(3px, ${pct.toFixed(2)}%)` }) : null,
      h('div', { class: 'ruler-edge', title: t('covNew') })),
    h('div', { class: 'ruler-scale' },
      h('span', {}, t('rulerOldest')),
      h('span', { class: 'ruler-share' }, t('rulerShare', { done: c.history_blocks.toLocaleString(), total: c.history_total.toLocaleString(), pct: shown })),
      h('span', {}, t('rulerNewest', { id: `${c.top_block}xxx` }))),
  ]);
}

async function startJob(kind, extra = {}, quiet = false) {
  const body = { kind, source: $('#crawl-source').value, check_files: $('#crawl-files').checked, ...extra };
  store.set('crawl', { check_files: body.check_files });
  try {
    await api('api/jobs', { method: 'POST', body });
    if (!quiet) toast(t('jobStarted', { what: kind === 'search' ? `“${body.query}”` : t(kind === 'older' ? 'older' : 'update') }));
    pollStatus();
    return true;
  } catch (err) {
    if (!quiet) toast(err.status === 409 ? t('jobBusy') : `${t('error')}: ${err.message}`, 'error');
    return false;
  }
}

const defaultFilters = () => {
  const f = state.filters;
  return !f.q && f.view === 'all' && !f.minSeeders && !f.mediaOnly;
};

// The end of the grid: say how far history reaches and offer (or, unfiltered, start) more.
function renderLibraryEnd() {
  const end = $('#library-end');
  const show = state.done && state.items.length > 0 && lastStatus;
  end.hidden = !show;
  if (!show) return;
  const c = lastStatus.coverage;
  const running = jobRunning();
  updateRegion(end, [coverageText(c).history, c.history_complete, running, lastStatus.job?.kind, getLang()], () => [
    h('span', {}, `${t('libraryEnd')} · ${t('covHistory')}: ${coverageText(c).history}`),
    c.history_complete ? null : h('button', {
      class: 'btn small', type: 'button', disabled: running,
      onclick: runOlder,
    }, running && lastStatus.job.kind === 'older' ? t('loadingOlder') : `↓ ${t('loadOlder')}`),
  ].filter(Boolean));
}

function maybeLoadOlder() {
  if (!autoOlderArmed || !state.done || !lastStatus || jobRunning()) return;
  if (!defaultFilters() || lastStatus.coverage.history_complete || !state.items.length) return;
  autoOlderArmed = false;
  startJob('older', { blocks: 2, block_digits: older.digits }, true);
}

// --- history options -------------------------------------------------------------------------
//
// How Older runs: blocks per run (or all that are left), block size, stopping at an empty block,
// or an id range that leaves the walk's position alone. Kept per browser; the automatic run at the
// end of the grid uses the same block size.

const OLDER_DEFAULTS = { blocks: 5, all: false, digits: 4, stopEmpty: false, rangeOn: false, from: '', to: '' };
const older = { ...OLDER_DEFAULTS, ...store.get('older', {}) };
let olderDigitsSelect = null;
const SUKEBEI_DELAY = 1.5;

function readOlderControls() {
  older.blocks = Math.max(1, Number($('#older-blocks').value) || 1);
  older.all = $('#older-all').checked;
  older.digits = Number($('#older-digits').value) || 4;
  older.stopEmpty = $('#older-stop-empty').checked;
  older.rangeOn = $('#older-range-on').checked;
  older.from = $('#older-range-from').value.trim();
  older.to = $('#older-range-to').value.trim();
  store.set('older', older);
  renderOlderOptions();
}

function writeOlderControls() {
  $('#older-blocks').value = older.blocks;
  $('#older-all').checked = older.all;
  $('#older-digits').value = String(older.digits);
  olderDigitsSelect?.sync();
  $('#older-stop-empty').checked = older.stopEmpty;
  $('#older-range-on').checked = older.rangeOn;
  $('#older-range-from').value = older.from;
  $('#older-range-to').value = older.to;
  renderOlderOptions();
}

// The range in blocks, or an error message when the two ids cannot form one.
function olderRange() {
  const [a, b] = [older.from, older.to];
  if (!/^\d{5,8}$/.test(a) || !/^\d{5,8}$/.test(b)) return { error: t('olderRangeMissing') };
  if (a.length !== b.length) return { error: t('olderRangeBad') };
  const [high, low] = [a, b].sort((x, y) => Number(y) - Number(x));
  const from = Number(high.slice(0, older.digits));
  const to = Number(low.slice(0, older.digits));
  return { from, to, count: from - to + 1, body: { range_from: Number(high), range_to: Number(low) } };
}

function olderBody() {
  const body = { block_digits: older.digits, stop_on_empty: older.stopEmpty, blocks: older.all ? null : older.blocks };
  if (older.rangeOn) {
    const range = olderRange();
    if (range.error) return null;
    Object.assign(body, range.body, { blocks: null });
  }
  return body;
}

const blockIds = (digits) => (10 ** (7 - digits)).toLocaleString();

function renderOlderOptions() {
  $('#older-blocks').disabled = older.all || older.rangeOn;
  $('#older-all').disabled = older.rangeOn;
  $('#older-range-fields').hidden = !older.rangeOn;
  const c = lastStatus?.coverage;
  let summary;
  let problem = false;
  if (older.rangeOn) {
    const range = olderRange();
    problem = !!range.error;
    summary = range.error ?? t('olderSumRange', { from: range.from, to: range.to, n: range.count.toLocaleString() });
  } else if (c?.history_complete) {
    summary = t('historyDone');
  } else {
    // Where the walk continues at the chosen size (finer blocks start at the top of the current one).
    const next = c?.history_next == null ? null
      : String(c.history_next).slice(0, older.digits).padEnd(older.digits, '9');
    const start = next ? t('olderSumAt', { block: next }) : t('olderSumNewest');
    const total = 9 * 10 ** (older.digits - 1);
    const scale = 10 ** (older.digits - (c?.history_digits ?? older.digits));
    const left = Math.max(0, total - Math.round((c?.history_blocks ?? 0) * scale));
    summary = older.all
      ? t('olderSumAll', { n: left.toLocaleString(), start, hours: (left * SUKEBEI_DELAY / 3600).toFixed(1) })
      : t('olderSumBlocks', { n: older.blocks, size: blockIds(older.digits), start });
  }
  if (older.stopEmpty && !problem) summary += ` ${t('olderSumStop')}`;
  $('#older-summary').textContent = summary;
  $('#job-older').disabled = jobRunning() || (older.rangeOn ? !!olderRange().error : !!c?.history_complete);
}

function runOlder() {
  const body = olderBody();
  if (!body) { toast(olderRange().error, 'error'); return; }
  startJob('older', body);
}

// --- reading marks ---------------------------------------------------------------------------
//
// A mark pins a title as "read up to here". Marks follow the title, not a scroll offset, so they
// survive new uploads and re-sorting; jumping asks the server for the view's full order, loads the
// grid up to the marked title and scrolls to it. [ and ] step between marks, M marks the card under
// the pointer.

const marks = new Map();           // fc2_id -> { fc2_id, title, created_at, cover, fetched_at }
let viewOrder = null;              // { key, ids, at } for the current filters
let hoveredId = null;
let markCursor = null;             // the mark jumped to last; the reference while it is on screen

const filtersKey = () => JSON.stringify(state.filters);

async function loadMarks() {
  try {
    setMarks(await api('api/marks'));
  } catch { /* retried on the next change */ }
}

function setMarks(list) {
  marks.clear();
  for (const mark of list) marks.set(mark.fc2_id, mark);
  renderMarksNav();
}

async function toggleMark(fc2Id) {
  const marked = marks.has(fc2Id);
  try {
    setMarks(marked
      ? await api(`api/marks/${fc2Id}`, { method: 'DELETE' })
      : await api('api/marks', { method: 'POST', body: { fc2_id: fc2Id } }));
  } catch (err) {
    toast(`${t('error')}: ${err.message}`, 'error');
    return;
  }
  toast(t(marked ? 'markRemoved' : 'markAdded'));
  const i = state.items.findIndex((x) => x.fc2_id === fc2Id);
  if (i >= 0) updateCardFlags($(`#grid .card[data-id="${fc2Id}"]`), state.items[i]);
  if (state.detail?.fc2_id === fc2Id) renderDetail();
}

async function currentOrder() {
  const key = filtersKey();
  if (viewOrder?.key === key && Date.now() - viewOrder.at < 15000) return viewOrder.ids;
  const f = state.filters;
  const params = new URLSearchParams({
    q: f.q, view: f.view, sort: f.sort, min_seeders: f.minSeeders || 0, media_only: f.mediaOnly,
  });
  const { ids } = await api(`api/titles/order?${params}`);
  viewOrder = { key, ids, at: Date.now() };
  return ids;
}

// Index (in the view) of the first card whose bottom is below the sticky top bar.
function readingIndex() {
  const edge = $('.topbar').getBoundingClientRect().bottom + 8;
  const cards = cardElements();
  const i = cards.findIndex((card) => card.getBoundingClientRect().bottom > edge);
  return i < 0 ? state.items.length : i;
}

// Where "next" and "previous" count from: the last mark jumped to while it is still on screen
// (it may share a row with earlier cards), otherwise the first card below the top bar.
function referenceIndex(ids) {
  if (markCursor) {
    const card = $(`#grid .card[data-id="${markCursor}"]`);
    const rect = card?.getBoundingClientRect();
    if (rect && rect.bottom > $('.topbar').getBoundingClientRect().bottom && rect.top < window.innerHeight) {
      const index = ids.indexOf(markCursor);
      if (index >= 0) return index;
    }
  }
  const card = cardElements()[readingIndex()];
  return card ? ids.indexOf(card.dataset.id) : ids.length;
}

function markPositions(ids) {
  const index = new Map(ids.map((id, i) => [id, i]));
  return [...marks.keys()].filter((id) => index.has(id)).map((id) => ({ id, index: index.get(id) }))
    .sort((a, b) => a.index - b.index);
}

async function ensureLoaded(index) {
  while (state.loading) await new Promise((r) => setTimeout(r, 50));
  while (state.items.length <= index && !state.done) {
    const before = state.items.length;
    await loadMore(false, Math.min(REFRESH_CAP, index - before + PAGE));
    if (state.items.length === before) break;
  }
}

async function jumpToMark(fc2Id) {
  const ids = await currentOrder();
  const index = ids.indexOf(fc2Id);
  if (index < 0) { toast(t('markNotInView'), 'error'); return; }
  await ensureLoaded(index);
  const card = $(`#grid .card[data-id="${fc2Id}"]`);
  if (!card) return;
  const top = card.getBoundingClientRect().top + window.scrollY - $('.topbar').getBoundingClientRect().bottom - 12;
  // Glide to a nearby mark; jump straight to a distant one instead of a long animated scroll.
  const near = Math.abs(top - window.scrollY) < window.innerHeight * 2;
  window.scrollTo({ top, behavior: near ? 'smooth' : 'auto' });
  markCursor = fc2Id;
  card.classList.remove('flash');
  void card.offsetWidth;                       // restart the highlight animation
  card.classList.add('flash');
  card.addEventListener('animationend', () => card.classList.remove('flash'), { once: true });
  updateMarkCounter();                          // no scroll event fires when the page is already there
  closeMarkList();
}

async function stepMark(step) {
  if (!marks.size) { toast(t('marksHint')); return; }
  const ids = await currentOrder();
  const positions = markPositions(ids);
  const here = referenceIndex(ids);
  const target = step > 0 ? positions.find((p) => p.index > here) : positions.filter((p) => p.index < here).pop();
  if (!target) { toast(t(step > 0 ? 'noMarkBelow' : 'noMarkAbove')); return; }
  jumpToMark(target.id);
}

function renderMarksNav() {
  const nav = $('#marks-nav');
  nav.hidden = marks.size === 0;
  if (!marks.size) { closeMarkList(); return; }
  updateMarkCounter();
  currentOrder().then(updateMarkCounter).catch(() => {});
  if (!$('#mark-list').hidden) renderMarkList();
}

// "Mark 2 / 5": marks at or above the reading position, out of the marks in this view.
let orderRefetch = 0;

function updateMarkCounter() {
  if (!marks.size) return;
  const cached = viewOrder?.key === filtersKey();
  if (!cached && !orderRefetch) {
    // Count from the loaded cards for now; the full order (marks further down) follows shortly.
    orderRefetch = setTimeout(() => currentOrder().then(updateMarkCounter).catch(() => {})
      .finally(() => { orderRefetch = 0; }), 400);
  }
  const ids = cached ? viewOrder.ids : state.items.map((x) => x.fc2_id);
  const positions = markPositions(ids);
  const here = referenceIndex(ids);
  const passed = positions.filter((p) => p.index <= here).length;
  $('#mark-count .mark-count-text').textContent = t('markCounter', { i: passed, n: positions.length });
}

async function renderMarkList() {
  const list = $('#mark-list');
  const ids = await currentOrder().catch(() => []);
  const index = new Map(ids.map((id, i) => [id, i]));
  const rows = [...marks.values()].sort((a, b) =>
    (index.get(a.fc2_id) ?? Infinity) - (index.get(b.fc2_id) ?? Infinity) || a.created_at - b.created_at);
  list.replaceChildren(
    h('div', { class: 'mark-list-head' }, h('span', {}, t('marksTitle')), h('span', { class: 'dim' }, t('marksHint'))),
    ...rows.map((mark) => {
      const inView = index.has(mark.fc2_id);
      return h('div', { class: `mark-row${inView ? '' : ' away'}` },
        h('button', {
          class: 'mark-go', type: 'button', disabled: !inView, title: inView ? '' : t('markNotInView'),
          onclick: () => jumpToMark(mark.fc2_id),
        },
        h('span', { class: 'code' }, code(mark.fc2_id)),
        h('span', { class: 'mark-title' }, mark.title || '—'),
        inView ? null : h('span', { class: 'mark-away' }, t('markNotInView'))),
        h('button', {
          class: 'icon', type: 'button', title: t('unmark'), 'aria-label': t('unmark'),
          onclick: () => toggleMark(mark.fc2_id),
        }, '×'));
    }),
  );
}

function openMarkList() {
  $('#mark-list').hidden = false;
  $('#mark-count').setAttribute('aria-expanded', 'true');
  renderMarkList();
}

function closeMarkList() {
  $('#mark-list').hidden = true;
  $('#mark-count').setAttribute('aria-expanded', 'false');
}

// --- filters ---------------------------------------------------------------------------------

function saveFilters() {
  const { q, ...rest } = state.filters;
  store.set('filters', rest);
}

function applyFilters() {
  saveFilters();
  renderFilterChip();
  viewOrder = null;
  state.done = false;
  loadMore(true);
}

function clearFilters() {
  Object.assign(state.filters, { q: '', view: 'all', sort: 'uploaded', minSeeders: 0, mediaOnly: false });
  $('#filter-q').value = '';
  syncFilterControls();
  applyFilters();
}

function renderFilterChip() {
  const chip = $('#filter-chip');
  chip.hidden = !state.filters.q;
  $('span', chip).textContent = `“${state.filters.q}”`;
  chip.setAttribute('aria-label', `${t('clearSearch')}: ${state.filters.q}`);
}

function setFilterQuery(text) {
  $('#filter-q').value = text;
  state.filters.q = text;
  applyFilters();
}

let sortSelect = null;

function syncFilterControls() {
  const f = state.filters;
  for (const b of document.querySelectorAll('#filter-view button')) b.classList.toggle('active', b.dataset.view === f.view);
  $('#filter-sort').value = f.sort;
  sortSelect?.sync();
  $('#filter-seeders').value = f.minSeeders || 0;
  $('#filter-media').checked = !!f.mediaOnly;
}

// --- wiring ----------------------------------------------------------------------------------

function closeStatusPanel(refocus = false) {
  if ($('#status-panel').hidden) return;
  $('#status-panel').hidden = true;
  $('#status-pill').setAttribute('aria-expanded', 'false');
  if (refocus) $('#status-pill').focus();
}

function openStatusPanel() {
  $('#status-panel').hidden = false;
  $('#status-pill').setAttribute('aria-expanded', 'true');
  $('#status-close').focus({ preventScroll: true });
}

function renderKeys() {
  updateRegion($('#keys-list'), getLang(), () => [
    ['← → ↑ ↓', 'keyGrid'], ['Enter', 'keyOpen'], ['s', 'keyStar'], ['m', 'keyMark'],
    ['h', 'keyHide'], ['c', 'keyCopy'], ['r', 'keyRefresh'], ['← →', 'keyStep'],
    ['/', 'keySearch'], ['[ ]', 'keyMarks'], ['Esc', 'keyClose'], ['?', 'shortcuts'],
  ].map(([keys, label]) => h('div', { class: 'key-row' }, h('kbd', {}, keys), h('span', {}, t(label)))));
}

function showKeys() {
  renderKeys();
  if (!$('#keys-dialog').open) $('#keys-dialog').showModal();
}

function trapFocus(event, root) {
  if (event.key !== 'Tab') return;
  const controls = [...root.querySelectorAll('button, a[href], input, summary, [tabindex="0"]')]
    .filter(el => !el.disabled && el.getClientRects().length && !el.closest('[hidden]'));
  const at = controls.indexOf(document.activeElement);
  if (!controls.length) { event.preventDefault(); return; }
  if (event.shiftKey && at <= 0) { event.preventDefault(); controls.at(-1).focus(); }
  else if (!event.shiftKey && (at < 0 || at === controls.length - 1)) { event.preventDefault(); controls[0].focus(); }
}

let gridMoving = false;
async function moveGridFocus(key) {
  if (gridMoving) return;
  gridMoving = true;
  try {
    let cards = cardElements();
    const current = document.activeElement?.closest('.card');
    if (!current) { cards[0]?.focus(); return; }
    let index = cards.indexOf(current);
    const rows = () => [...new Set(cards.map(card => card.offsetTop))];
    const target = () => {
      if (key === 'ArrowLeft') return cards[index - 1];
      if (key === 'ArrowRight') return cards[index + 1];
      const tops = rows();
      const row = tops.indexOf(current.offsetTop) + (key === 'ArrowDown' ? 1 : -1);
      const candidates = cards.filter(card => card.offsetTop === tops[row]);
      return candidates.sort((a, b) => Math.abs(a.offsetLeft - current.offsetLeft) - Math.abs(b.offsetLeft - current.offsetLeft))[0];
    };
    let next = target();
    if (!next && !state.done && ['ArrowRight', 'ArrowDown'].includes(key)) {
      await loadMore();
      cards = cardElements();
      index = cards.indexOf(current);
      next = target();
    }
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: 'nearest' });
  } finally { gridMoving = false; }
}

function titleShortcut(key, item, detail = false) {
  if (!item) return false;
  if (key === 's') setFlags(item.fc2_id, { starred: !item.starred });
  else if (key === 'm') toggleMark(item.fc2_id);
  else if (key === 'h') setFlags(item.fc2_id, { hidden: !item.hidden });
  else if (key === 'c') {
    const torrent = detail ? bestTorrent(item.torrents || []) || sortedTorrents(item.torrents || [])[0] : item;
    if (torrent?.magnet) copy(torrent.magnet, t('magnetCopied'));
  } else if (detail && key === 'r') refreshTitle(item.fc2_id);
  else return false;
  return true;
}

function wire() {
  const sourceSelect = $('#crawl-source');
  let savedSource = sourceSelect.value;
  sourceSelect.disabled = true;
  const sourceControl = enhanceSelect(sourceSelect);
  api('api/source').then(({ source }) => {
    savedSource = source;
    sourceSelect.value = source;
    sourceSelect.disabled = false;
    sourceControl.sync();
  }).catch((err) => toast(`${t('error')}: ${err.message}`, 'error'));
  sourceSelect.addEventListener('change', async () => {
    sourceSelect.disabled = true;
    sourceControl.sync();
    try {
      await api('api/source', { method: 'PUT', body: { source: sourceSelect.value } });
      savedSource = sourceSelect.value;
    } catch (err) {
      toast(`${t('error')}: ${err.message}`, 'error');
      sourceSelect.value = savedSource;
    } finally {
      sourceSelect.disabled = false;
      sourceControl.sync();
    }
  });
  $('#job-update').addEventListener('click', () => startJob('update'));
  $('#job-older').addEventListener('click', runOlder);
  olderDigitsSelect = enhanceSelect($('#older-digits'));
  writeOlderControls();
  $('#older-options').addEventListener('input', readOlderControls);
  $('#older-options').addEventListener('change', readOlderControls);
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const query = $('#search-query').value.trim();
    if (query) startJob('search', { query });
  });
  $('#job-cancel').addEventListener('click', () => api('api/jobs/cancel', { method: 'POST' }).then(pollStatus));
  $('#history-reset').addEventListener('click', async () => {
    await api('api/history/reset', { method: 'POST' });
    toast(t('historyResetDone'));
    autoOlderArmed = true;
    pollStatus();
  });
  $('#crawl-files').checked = !!store.get('crawl', {}).check_files;
  $('#crawl-files').addEventListener('change', (e) => store.set('crawl', { check_files: e.target.checked }));

  const size = $('#card-size');
  const applySize = (px) => document.documentElement.style.setProperty('--card-min', `${px}px`);
  size.value = store.get('cardSize', 232);
  applySize(size.value);
  size.addEventListener('input', () => { applySize(size.value); store.set('cardSize', Number(size.value)); });

  $('#status-pill').addEventListener('click', () => {
    if ($('#status-panel').hidden) openStatusPanel();
    else closeStatusPanel();
  });
  $('#status-close').addEventListener('click', () => closeStatusPanel(true));
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('#status-panel, #status-pill')) closeStatusPanel();
    const menu = $('.detail-menu[open]');
    if (menu && !menu.contains(event.target)) menu.open = false;
  });
  const resizeChrome = () => {
    document.documentElement.style.setProperty('--chrome-h', `${$('.app-chrome').offsetHeight}px`);
    document.documentElement.style.setProperty('--topbar-h', `${$('.topbar').offsetHeight}px`);
  };
  new ResizeObserver(resizeChrome).observe($('.app-chrome'));
  resizeChrome();
  $('#keys-open').addEventListener('click', showKeys);
  $('#keys-close').addEventListener('click', () => $('#keys-dialog').close());
  $('#keys-dialog').addEventListener('click', event => {
    if (event.target === event.currentTarget) {
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();
    }
  });
  $('#filter-chip').addEventListener('click', () => setFilterQuery(''));
  $('#retry-failed').addEventListener('click', async () => {
    const { queued } = await api('api/retry-failed', { method: 'POST' });
    toast(t('retryQueued', { n: queued }));
    pollStatus();
  });
  $('#lang-toggle').addEventListener('click', () => {
    setLang(getLang() === 'ja' ? 'en' : 'ja');
    $('#lang-toggle').textContent = getLang() === 'ja' ? 'English' : '日本語';
    $('#grid').replaceChildren(...state.items.map(buildCard));
    syncDividers();
    renderCount();
    sortSelect.sync();
    sourceControl.sync();
    olderDigitsSelect.sync();
    renderFilterChip();
    renderMarksNav();
    if (state.detail) renderDetail();
    pollStatus();
  });

  let filterTimer = 0;
  $('#filter-q').addEventListener('input', (e) => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { state.filters.q = e.target.value.trim(); applyFilters(); }, 250);
  });
  $('#filter-view').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    state.filters.view = b.dataset.view;
    syncFilterControls();
    applyFilters();
  });
  $('#filter-sort').addEventListener('change', (e) => { state.filters.sort = e.target.value; applyFilters(); });
  $('#filter-seeders').addEventListener('change', (e) => { state.filters.minSeeders = Math.max(0, Number(e.target.value) || 0); applyFilters(); });
  $('#filter-media').addEventListener('change', (e) => { state.filters.mediaOnly = e.target.checked; applyFilters(); });

  new IntersectionObserver((entries) => {
    if (!entries.some((x) => x.isIntersecting)) return;
    if (state.done) maybeLoadOlder();
    else loadMore();
  }, { rootMargin: '600px' }).observe($('#sentinel'));

  $('#grid').addEventListener('pointerover', (e) => { hoveredId = e.target.closest('.card')?.dataset.id ?? null; });
  $('#grid').addEventListener('pointerleave', () => { hoveredId = null; });
  $('#mark-prev').addEventListener('click', () => stepMark(-1));
  $('#mark-next').addEventListener('click', () => stepMark(1));
  $('#mark-count').addEventListener('click', () => ($('#mark-list').hidden ? openMarkList() : closeMarkList()));
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#marks-nav')) closeMarkList(); });
  let counterFrame = 0;
  window.addEventListener('scroll', () => {
    cancelAnimationFrame(counterFrame);
    counterFrame = requestAnimationFrame(updateMarkCounter);
  }, { passive: true });

  const detail = $('#detail');
  detail.addEventListener('click', (e) => {
    if (e.target.matches('[data-close]')) closeDetail();
    const nav = e.target.closest('.nav');
    if (nav) stepDetail(Number(nav.dataset.step));
  });

  const box = $('#lightbox');
  box.addEventListener('click', (e) => {
    const nav = e.target.closest('.lb-nav');
    if (nav) { lightbox.index += Number(nav.dataset.step); showLightbox(); return; }
    if (e.target === box || e.target.matches('.lb-close')) closeLightbox();
  });

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    if ($('#keys-dialog').open) return;
    if (!box.hidden) {
      trapFocus(e, box);
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') { lightbox.index -= 1; showLightbox(); }
      else if (e.key === 'ArrowRight') { lightbox.index += 1; showLightbox(); }
      if (['Escape', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
      return;
    }
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' && $('.detail-menu[open]')) { $('.detail-menu').open = false; $('.detail-menu summary').focus(); return; }
    if (e.key === 'Escape' && !$('#status-panel').hidden) { closeStatusPanel(true); return; }
    if (!detail.hidden) {
      trapFocus(e, $('.detail-panel'));
      if (e.key === 'Escape') closeDetail();
      else if (typing) return;
      else if (e.key === 'ArrowLeft') stepDetail(-1);
      else if (e.key === 'ArrowRight') stepDetail(1);
      else if (e.key === '?') showKeys();
      else if (e.key === '/') { closeDetail(); $('#filter-q').focus(); }
      else if (e.key === '[' || e.key === ']') { closeDetail(); stepMark(e.key === ']' ? 1 : -1); }
      else if (!titleShortcut(e.key.toLowerCase(), state.detail, true)) return;
      e.preventDefault();
      return;
    }
    if (typing) return;
    if (!$('#status-panel').hidden) return;
    if (e.key === '/') {
      e.preventDefault();
      $('#filter-q').focus();
    } else if (e.key === ']') stepMark(1);
    else if (e.key === '[') stepMark(-1);
    else if (e.key === '?') showKeys();
    else if (e.key.startsWith('Arrow') && !document.activeElement.closest('.select')) { e.preventDefault(); moveGridFocus(e.key); }
    else if (e.key === 'Escape') closeMarkList();
    else {
      const id = document.activeElement?.closest?.('.card')?.dataset.id ?? hoveredId;
      if (titleShortcut(e.key.toLowerCase(), state.items.find(item => item.fc2_id === id))) e.preventDefault();
    }
  });
}

applyStatic();
$('#lang-toggle').textContent = getLang() === 'ja' ? 'English' : '日本語';
sortSelect = enhanceSelect($('#filter-sort'));
syncFilterControls();
wire();
loadMarks().then(() => loadMore(true));
pollStatus();
