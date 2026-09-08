/* Everything the page holds, in one object.
 *
 * A single mutable `state` rather than a module of `let` bindings: switching
 * channel replaces the index wholesale, and an imported binding cannot be
 * reassigned from the module that reads it. */

const PREFS_KEY = "tmw2.filters";
const CHANNEL_KEY = "tmw2.channel";

/* Storage is not always there -- a private window, or site data blocked -- and
 * a filter you cannot remember is not worth a broken page. */
function readLocal(key) {
  try { return localStorage.getItem(key); } catch (err) { return null; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, value); } catch (err) { /* not worth saying */ }
}

export const state = {
  index: [],                 // every recommendation, lean, oldest first
  detail: new Map(),         // id -> {covers, discord_url, expires}
  taken: new Set(),          // job ids already downloaded
  held: new Map(),           // job id -> {dir, n}, what is on disk
  bookmarks: [],             // [{id, ts, title, ...}], newest first
  saved: new Set(),          // the same, as ids, for drawing
  meta: { channel: {}, display: {}, coverage: {} },
  channel: readLocal(CHANNEL_KEY) || "",
  scope: { tail: null },
  filters: { q: "", kind: "", source: "", savedOnly: false, missingOnly: false, desc: false },
  // The crawl running on the server for this channel, as last polled.
  job: { active: false, dir: "older", fetched: 0, added: 0, edge: null, error: "" },
  // The download queue, as last polled: the whole list, and a job -> state map
  // for the cards, which only need the one word.
  grabs: { tasks: [], active: 0, queued: 0, failed: 0, error: "" },
  jobState: new Map(),
  claims: new Map(),         // job id -> what a press said it holds
};

/* Filters persist, the search box does not: coming back to yesterday's chips is
 * helpful, coming back to a half-typed query is not. */
export function savePrefs() {
  const { kind, source, savedOnly, missingOnly, desc } = state.filters;
  writeLocal(PREFS_KEY, JSON.stringify({ kind, source, savedOnly, missingOnly, desc }));
}

export function loadPrefs() {
  try {
    const saved = JSON.parse(readLocal(PREFS_KEY)) || {};
    Object.assign(state.filters, {
      kind: saved.kind || "",
      source: saved.source || "",
      savedOnly: !!saved.savedOnly,
      missingOnly: !!saved.missingOnly,
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
  return !!(f.q || f.kind || f.source || f.savedOnly || f.missingOnly);
};

/* Whether this one is already on disk. The tick and the ledger can disagree
 * -- a run that ticked a job before the ledger existed, a folder since moved --
 * so either counts, and the card says which. */
export const have = (post) => state.taken.has(post.job) || state.held.has(post.job);

/* One lowercased haystack per post, built once on arrival: a query runs over
 * every post on every keystroke, and rebuilding this each time would be the
 * whole cost of it. */
export function indexPost(post) {
  post._hay = [post.title, post.kind, post.who, post.body, post.job, post.volumes]
    .concat(post.titles || []).join(" ").toLowerCase();
  return post;
}

export function passes(post) {
  const f = state.filters;
  if (f.savedOnly && !state.saved.has(post.id)) return false;
  if (f.missingOnly && have(post)) return false;
  if (f.kind && post.kind !== f.kind) return false;
  // The two kinds of job behave differently enough to be worth separating:
  // one opens a reader session, the other is a link somewhere else.
  if (f.source === "hosted" && !post.hosted) return false;
  if (f.source === "external" && post.hosted) return false;
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
