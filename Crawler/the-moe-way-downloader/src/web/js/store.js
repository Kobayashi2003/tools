/* Everything the page holds, in one object.
 *
 * A single mutable `state` rather than a module of `let` bindings: switching
 * channel replaces the index wholesale, and an imported binding cannot be
 * reassigned from the module that reads it. */

const PREFS_KEY = "tmw.filters";
const CHANNEL_KEY = "tmw.channel";

/* Storage is not always there -- a private window, or site data blocked -- and
 * a filter you cannot remember is not worth a broken page. */
function readLocal(key) {
  try { return localStorage.getItem(key); } catch (err) { return null; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, value); } catch (err) { /* not worth saying */ }
}

export const state = {
  index: [],                 // every post, lean, oldest first
  detail: new Map(),         // id -> {covers, files, links, discord_url}
  taken: new Set(),          // attachment ids already fetched
  bookmarks: [],             // [{id, ts, title, ...}], newest share first
  saved: new Set(),          // the same, as ids, for drawing
  meta: { channel: {}, display: {}, coverage: {} },
  channel: readLocal(CHANNEL_KEY) || "",
  scope: { tail: null },
  filters: { q: "", kind: "", source: "", savedOnly: false, desc: false },
  // The crawl running on the server for this channel, as last polled.
  job: { active: false, dir: "older", fetched: 0, added: 0, edge: null, error: "" },
};

/* Filters persist, the search box does not: coming back to yesterday's chips is
 * helpful, coming back to a half-typed query is not. */
export function savePrefs() {
  const { kind, source, savedOnly, desc } = state.filters;
  writeLocal(PREFS_KEY, JSON.stringify({ kind, source, savedOnly, desc }));
}

export function loadPrefs() {
  try {
    const saved = JSON.parse(readLocal(PREFS_KEY)) || {};
    Object.assign(state.filters, {
      kind: saved.kind || "",
      source: saved.source || "",
      savedOnly: !!saved.savedOnly,
      desc: !!saved.desc,
    });
  } catch (err) { /* a filter set is not worth a failed boot */ }
  return state.filters;
}

export function rememberChannel(id) {
  state.channel = id;
  writeLocal(CHANNEL_KEY, id);
}

export const filtering = () => {
  const f = state.filters;
  return !!(f.q || f.kind || f.source || f.savedOnly);
};

/* One lowercased haystack per post, built once on arrival: a query runs over
 * 11k posts on every keystroke, and rebuilding this each time would be the
 * whole cost of it. */
export function indexPost(post) {
  post._hay = [post.title, post.author, post.category, post.poster, post.body]
    .concat(post.names || []).join(" ").toLowerCase();
  return post;
}

export function passes(post) {
  const f = state.filters;
  if (f.savedOnly && !state.saved.has(post.id)) return false;
  if (f.kind && post.category !== f.kind) return false;
  // A quarter of this channel is a MEGA link rather than an upload, and the two
  // are handled differently enough to be worth separating.
  if (f.source === "files" && !post.n_files) return false;
  if (f.source === "links" && !post.n_links) return false;
  if (!f.q) return true;
  return post._hay.includes(f.q);
}

/* Snowflakes are decimal ids of different lengths -- an id from 2021 is 18
 * digits, an early one 17 -- so a plain string compare sorts "9…" after "10…".
 * Longer is always newer; the same length compares lexically. */
export function byIdAsc(a, b) {
  const left = String(a.id), right = String(b.id);
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}
