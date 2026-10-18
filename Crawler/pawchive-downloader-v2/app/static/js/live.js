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

// Makes `node` look like `fresh` with the fewest DOM writes: a changed progress line
// rewrites one text node, and the spinner beside it keeps turning.
function morph(node, fresh) {
  if (node.nodeType !== fresh.nodeType || node.nodeName !== fresh.nodeName) {
    node.replaceWith(fresh);
    return fresh;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    if (node.nodeValue !== fresh.nodeValue) node.nodeValue = fresh.nodeValue;
    return node;
  }
  for (const a of [...node.attributes]) if (!fresh.hasAttribute(a.name)) node.removeAttribute(a.name);
  for (const a of fresh.attributes) if (node.getAttribute(a.name) !== a.value) node.setAttribute(a.name, a.value);
  const was = [...node.childNodes];
  const now = [...fresh.childNodes];
  if (was.length !== now.length) node.replaceChildren(...now);
  else was.forEach((c, i) => morph(c, now[i]));
  return node;
}

// Brings `parent`'s children in line with `rows` ([{ key, html }]), touching only what
// changed, so hover, focus and text selection survive an update.
const shown = new WeakMap();
export function patchRows(parent, rows) {
  const old = new Map([...parent.children].map((n) => [n.dataset.key, n]));
  let prev = null;
  for (const { key, html } of rows) {
    let node = old.get(key);
    old.delete(key);
    if (!node || shown.get(node) !== html) {
      const t = document.createElement('template');
      t.innerHTML = html.trim();
      const fresh = t.content.firstElementChild;
      fresh.dataset.key = key;
      node = node ? morph(node, fresh) : fresh;
      shown.set(node, html);
    }
    const want = prev ? prev.nextElementSibling : parent.firstElementChild;
    if (want !== node) parent.insertBefore(node, want);
    prev = node;
  }
  old.forEach((n) => n.remove());
}
