// One server-sent event stream for the page. The server sends `state`, `jobs` and `events`
// only when they change; views subscribe to what they show and patch it in place.

const EVENTS_KEPT = 300;
const handlers = { state: new Set(), jobs: new Set(), events: new Set(), online: new Set() };
const latest = { state: null, jobs: null, events: null, online: null };

function emit(kind, value) {
  latest[kind] = value;
  for (const fn of [...handlers[kind]]) fn(value);
}

// Calls `fn` with the latest value (if any, on the next tick) and on every change.
// Returns the unsubscribe function.
export function on(kind, fn) {
  handlers[kind].add(fn);
  if (latest[kind] !== null) queueMicrotask(() => { if (handlers[kind].has(fn)) fn(latest[kind]); });
  return () => handlers[kind].delete(fn);
}

export const current = (kind) => latest[kind];

export function connect() {
  const source = new EventSource('api/stream');
  source.onopen = () => emit('online', true);
  // The browser reconnects on its own; the server then sends everything afresh.
  source.onerror = () => emit('online', false);
  source.addEventListener('state', (e) => emit('state', JSON.parse(e.data)));
  source.addEventListener('jobs', (e) => emit('jobs', JSON.parse(e.data)));
  source.addEventListener('events', (e) => {
    const { reset, items } = JSON.parse(e.data);
    emit('events', reset ? items : [...items, ...(latest.events || [])].slice(0, EVENTS_KEPT));
  });
}

// ---------------------------------------------------------------- patching
// Views redraw by describing the whole of what they show as HTML and letting `patch` bring
// the page in line with the fewest DOM writes. A changed count rewrites one text node; the
// rows around it, their images, hover, focus, scroll and an open menu are left alone.
//
// Children that all carry `data-key` are matched by key, so a list can gain, lose or
// reorder rows without the others being rebuilt. Elements marked `data-transient` (an
// open menu) belong to someone else and are never touched or removed.

const transient = (n) => n.nodeType === Node.ELEMENT_NODE && n.hasAttribute('data-transient');
const blank = (n) => n.nodeType === Node.TEXT_NODE && !n.nodeValue.trim();
// Set by the menu while it is open; the fresh markup always says "false".
const OWNED_ATTRS = new Set(['aria-expanded']);

function morph(node, fresh) {
  if (node.nodeType !== fresh.nodeType || node.nodeName !== fresh.nodeName) {
    node.replaceWith(fresh);
    return fresh;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    if (node.nodeValue !== fresh.nodeValue) node.nodeValue = fresh.nodeValue;
    return node;
  }
  for (const a of [...node.attributes]) {
    if (!fresh.hasAttribute(a.name) && !OWNED_ATTRS.has(a.name)) node.removeAttribute(a.name);
  }
  for (const a of fresh.attributes) {
    if (OWNED_ATTRS.has(a.name) && node.hasAttribute(a.name)) continue;
    if (node.getAttribute(a.name) !== a.value) node.setAttribute(a.name, a.value);
  }
  morphChildren(node, fresh);
  return node;
}

function morphChildren(node, fresh) {
  const now = [...fresh.childNodes];
  const elems = now.filter((c) => !blank(c));
  const keyed = elems.length > 0 && elems.every((c) => c.nodeType === Node.ELEMENT_NODE && c.dataset.key != null);
  const was = [...node.childNodes].filter((c) => !transient(c));
  if (keyed) {
    const old = new Map();
    for (const c of was) {
      if (c.nodeType === Node.ELEMENT_NODE && c.dataset.key != null && !old.has(c.dataset.key)) old.set(c.dataset.key, c);
      else c.remove();
    }
    let prev = null;
    for (const f of elems) {
      let n = old.get(f.dataset.key);
      if (n) { old.delete(f.dataset.key); n = morph(n, f); } else n = f;
      let want = prev ? prev.nextSibling : node.firstChild;
      while (want && transient(want)) want = want.nextSibling;
      if (want !== n) node.insertBefore(n, want);
      prev = n;
    }
    old.forEach((n) => n.remove());
    return;
  }
  if (was.length === now.length) {
    was.forEach((c, i) => morph(c, now[i]));
    return;
  }
  was.forEach((c) => c.remove());
  const anchor = [...node.childNodes].find(transient) || null;
  for (const c of now) node.insertBefore(c, anchor);
}

const parse = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content;
};

// Makes `el`'s content match `html`, keeping every node that did not change.
export function patch(el, html) {
  const frag = parse(html);
  const shell = document.createElement(el.nodeName);
  shell.append(frag);
  morphChildren(el, shell);
}

// Brings `parent`'s children in line with `rows` ([{ key, html }]), touching only what
// changed. A row whose HTML is the same string as last time is not even compared.
const shown = new WeakMap();
export function patchRows(parent, rows) {
  const old = new Map();
  for (const n of [...parent.children]) {
    if (transient(n)) continue;
    if (n.dataset.key != null && !old.has(n.dataset.key)) old.set(n.dataset.key, n);
    else n.remove();
  }
  for (const n of [...parent.childNodes]) if (n.nodeType !== Node.ELEMENT_NODE) n.remove();
  let prev = null;
  for (const { key, html } of rows) {
    let node = old.get(key);
    old.delete(key);
    if (!node || shown.get(node) !== html) {
      const fresh = parse(html).firstElementChild;
      fresh.dataset.key = key;
      node = node ? morph(node, fresh) : fresh;
      shown.set(node, html);
    }
    let want = prev ? prev.nextElementSibling : parent.firstElementChild;
    while (want && transient(want)) want = want.nextElementSibling;
    if (want !== node) parent.insertBefore(node, want);
    prev = node;
  }
  old.forEach((n) => n.remove());
}
