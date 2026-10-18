import { I } from './icons.js';

// One dropdown at a time. A menu is described by `build()` returning its inner HTML and
// `onPick(item, event)` returning 'keep' to stay open (it is then rebuilt in place, so
// checkbox menus show their new state without losing scroll position or focus).
let current = null;

export function closeMenu(returnFocus = false) {
  if (!current) return;
  const { trigger, el } = current;
  el.remove();
  trigger.setAttribute('aria-expanded', 'false');
  if (returnFocus) trigger.focus();
  current = null;
}

export const menuOpenFor = (trigger) => current && current.trigger === trigger;

function place(el, host) {
  // Flip sideways when it would overflow, upward when there is clearly more room above,
  // and never taller than the space available, so the page itself does not scroll.
  const r = host.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  if (!el.classList.contains('right') && r.left + el.offsetWidth > vw - 12) el.classList.add('right');
  if (el.classList.contains('right') && r.right - el.offsetWidth < 12) el.classList.remove('right');
  const below = vh - r.bottom;
  const above = r.top;
  if (below < Math.min(el.offsetHeight, 300) + 12 && above > below) el.classList.add('up');
  const room = (el.classList.contains('up') ? above : below) - 18;
  el.style.maxHeight = Math.max(180, Math.min(420, room)) + 'px';
}

function render(state, keepFocusIndex) {
  const body = state.el.querySelector('.menu-body');
  const scroll = body ? body.scrollTop : 0;
  const query = state.el.querySelector('.menu-search input')?.value || '';
  state.el.innerHTML = state.build();
  const nb = state.el.querySelector('.menu-body');
  if (nb) nb.scrollTop = scroll;
  const search = state.el.querySelector('.menu-search input');
  if (search) {
    search.value = query;
    filterItems(state.el, query);
    search.addEventListener('input', () => filterItems(state.el, search.value));
  }
  if (keepFocusIndex != null) items(state.el)[keepFocusIndex]?.focus();
}

function filterItems(el, query) {
  const q = query.trim().toLowerCase();
  el.querySelectorAll('.mi').forEach((m) => { m.hidden = !!q && !(m.dataset.text || m.textContent).toLowerCase().includes(q); });
  el.querySelectorAll('.menu-group').forEach((g) => { g.hidden = ![...g.querySelectorAll('.mi')].some((m) => !m.hidden); });
}

const items = (scope, includeDisabled = false) =>
  [...scope.querySelectorAll('.mi')].filter((m) => !m.hidden && (includeDisabled || m.getAttribute('aria-disabled') !== 'true') && (scope.classList.contains('submenu') || !m.closest('.submenu')));

export function openMenu(trigger, { build, onPick, className = '', sub = null, keyboard = false }) {
  const host = trigger.closest('.dd') || trigger.parentElement;
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu ' + className;
  el.setAttribute('role', 'menu');
  host.appendChild(el);
  current = { trigger, el, build, onPick, sub };
  render(current);
  trigger.setAttribute('aria-expanded', 'true');
  place(el, host);
  const search = el.querySelector('.menu-search input');
  if (search) search.focus();
  else if (keyboard) items(el)[0]?.focus();
}

function toggleSub(btn) {
  const anchor = btn.parentElement;
  const open = anchor.querySelector('.submenu');
  if (open) {
    open.remove();
    btn.setAttribute('aria-expanded', 'false');
    current.el.classList.remove('lets-sub');
    return null;
  }
  const html = current.sub?.(btn.dataset.sub);
  if (!html) return null;
  anchor.insertAdjacentHTML('beforeend', `<div class="menu mini submenu" role="menu">${html}</div>`);
  btn.setAttribute('aria-expanded', 'true');
  // The parent's scroll container would clip the submenu; let it escape while open.
  current.el.classList.add('lets-sub');
  const sm = anchor.querySelector('.submenu');
  if (sm.getBoundingClientRect().right > document.documentElement.clientWidth - 8) sm.classList.add('flip');
  return sm;
}

document.addEventListener('click', (e) => {
  if (!current) return;
  if (!current.el.contains(e.target)) {
    if (!current.trigger.contains(e.target)) closeMenu();
    return;
  }
  // A menu can sit inside a clickable row; the row must not also react.
  e.stopPropagation();
  const subBtn = e.target.closest('[data-sub]');
  if (subBtn) { toggleSub(subBtn); return; }
  const mi = e.target.closest('.mi, [data-act]');
  if (!mi || mi.getAttribute('aria-disabled') === 'true') return;
  const idx = items(current.el).indexOf(mi.closest('.mi'));
  const state = current;
  const result = state.onPick?.(mi, e);
  if (result === 'keep' && current === state) render(state, idx >= 0 ? idx : null);
  else if (current === state) closeMenu(true);
}, true);

document.addEventListener('keydown', (e) => {
  if (!current) return;
  const el = current.el;
  const sm = el.querySelector('.submenu');
  const inSub = sm && sm.contains(document.activeElement);
  if (e.key === 'Escape') {
    e.preventDefault();
    if (sm) { sm.remove(); el.classList.remove('lets-sub'); el.querySelector('[data-sub]')?.focus(); return; }
    closeMenu(true);
    return;
  }
  if (e.key === 'Tab') { closeMenu(); return; }
  if (document.activeElement?.closest('.menu-search') && !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  const scope = inSub ? sm : el;
  const list = items(scope);
  const i = list.indexOf(document.activeElement);
  const go = (n) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus(); };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i < 0 ? list.length - 1 : i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(list.length - 1);
  else if (e.key === 'ArrowRight' && document.activeElement?.dataset.sub) {
    e.preventDefault();
    const opened = sm || toggleSub(document.activeElement);
    // Disabled items stay focusable inside a submenu so their reason can be read.
    if (opened) (items(opened)[0] || items(opened, true)[0])?.focus();
  } else if (e.key === 'ArrowLeft' && inSub) {
    e.preventDefault();
    sm.remove();
    el.classList.remove('lets-sub');
    el.querySelector('[data-sub]')?.focus();
  }
});

window.addEventListener('resize', () => closeMenu());

// ---- builders shared by every menu ----

export const checkItem = ({ key, label, on, count, faint = false, only = true }) => `
  <button type="button" class="mi${faint && !on ? ' faint' : ''}" role="menuitemcheckbox" aria-checked="${on}" data-opt="${key}" data-text="${label}">
    <span class="cb ${on ? 'on' : ''}"></span><span class="lbl"><span class="t">${label}</span></span>
    <span class="tail"><span class="count">${count ?? ''}</span>${only ? `<span class="only" data-only="${key}">Only</span>` : ''}</span>
  </button>`;

export const radioItem = ({ key, label, on, attr = 'data-radio' }) => `
  <button type="button" class="mi" role="menuitemradio" aria-checked="${on}" ${attr}="${key}">
    <span class="rd ${on ? 'on' : ''}"></span><span class="lbl"><span class="t">${label}</span></span><span class="tail"></span>
  </button>`;

// A real link, so middle-click and "copy link" work; null `href` shows `disabled` instead.
export const linkItem = ({ href, label, disabled = '' }) => href
  ? `<a class="mi" role="menuitem" href="${href}" target="_blank" rel="noreferrer"><span class="ico">${I.ext}</span><span class="lbl"><span class="t">${label}</span></span><span class="tail"></span></a>`
  : actionItem({ act: '', label, icon: I.ext, disabled });

export const actionItem =({ act, label, icon = '', hint = '', disabled = '', danger = false, sub = '' }) => `
  <div class="${sub ? 'sub-anchor' : ''}">
  <button type="button" class="mi${disabled ? ' two' : ''}${danger ? ' danger' : ''}${sub ? ' has-sub' : ''}" role="menuitem" data-act="${act}"
    ${disabled ? 'aria-disabled="true"' : ''} ${sub ? `data-sub="${sub}" aria-haspopup="true"` : ''}>
    <span class="ico">${icon}</span>
    <span class="lbl"><span><span class="t">${label}</span>${disabled ? `<span class="why">${disabled}</span>` : ''}</span></span>
    <span class="tail">${hint}</span>
  </button></div>`;
