/* The feed itself.
 *
 * A grid of covers, drawn as a flat row model: day headings, and rows of cards. Every
 * card has the same height, pinned in the stylesheet, so every row's height is known
 * before it is drawn: the offsets are arithmetic, only the rows near the viewport are
 * in the DOM, and nothing ever moves behind the reader.
 *
 * Newest first by default; oldest first reads the channel the way it was written. */

import { $, alarm, el, monthOf, show } from "./dom.js";
import { drawCard, fillCard } from "./card.js";
import { post as apiPost } from "./net.js";
import { byIdAsc, filtering, indexPost, passes, state } from "./store.js";

const OVERSCAN = 3;
const GROW_STREAK = 40;   // pages to pull unattended before waiting to be asked
const SHORT_PAGE = 240;   // px of slack that still counts as "nothing to scroll"
const GROW_ROWS = 3;      // this close to an end, ask for more

/* What the feed is made of, after filters. Exported as one object so callers
 * read the live values rather than a copy taken at import time. */
export const view = {
  rows: [],        // {t: "day", ts} | {t: "cards", posts}
  tops: [],        // row offsets, cumulative
  heights: [],
  live: new Map(), // row index -> element
  order: [],       // post ids in reading order
  where: new Map(),// post id -> [row index, column]
  here: null,      // the chosen post's id
  cols: 1,
};

/* The archive grows as you arrive at either end, rather than being decided up
 * front. `done` is latched per direction so a channel with no more to give is
 * not asked twice, and only one request is ever in flight. */
const grow = { busy: false, older: false, newer: false, streak: 0 };

const changeHooks = [];
const grewHooks = [];
const hereHooks = [];
/* `onChange` is every repaint; `onGrew` is the rarer case where posts the page had
 * never seen arrived; `onHere` is a different post being chosen. */
export const onChange = (fn) => changeHooks.push(fn);
export const onGrew = (fn) => grewHooks.push(fn);
export const onHere = (fn) => hereHooks.push(fn);
const changed = () => { for (const hook of changeHooks) hook(); };
const grewBy = (n) => { for (const hook of grewHooks) hook(n); };

const feedEl = () => $("#feed");

/* ---------- sizes ---------- */

/* Read from the stylesheet so the two cannot drift apart. */
const metrics = { card: 334, gap: 14, day: 44, min: 260 };

function readMetrics() {
  const style = getComputedStyle(document.documentElement);
  const px = (name, fallback) => parseFloat(style.getPropertyValue(name)) || fallback;
  metrics.card = px("--card-h", 334);
  metrics.gap = px("--card-gap", 14);
  metrics.day = px("--day-h", 44);
  metrics.min = px("--card-min", 260);
  const width = feedEl().clientWidth || 800;
  view.cols = Math.max(1, Math.min(8, Math.floor((width + metrics.gap) / (metrics.min + metrics.gap))));
  feedEl().style.setProperty("--cols", view.cols);
}

function reflow() {
  view.tops = new Array(view.rows.length);
  let y = 0;
  for (let i = 0; i < view.rows.length; i++) {
    view.tops[i] = y;
    y += view.heights[i];
  }
  $("#spacer").style.height = y + "px";
}

const newestFirst = () => state.filters.sort !== "old";

/* The posts that pass the filters, in the order they are shown. */
function shownPosts() {
  let list = state.index.filter(passes);
  if (state.filters.sort === "love") {
    list = list.slice().sort((a, b) => (b.reactions || 0) - (a.reactions || 0) || byIdAsc(b, a));
  } else if (newestFirst()) {
    list = list.slice().reverse();
  }
  return list;
}

export function buildRows() {
  readMetrics();
  const list = shownPosts();
  const rows = [];
  const push = (posts) => { for (let i = 0; i < posts.length; i += view.cols) rows.push({ t: "cards", posts: posts.slice(i, i + view.cols) }); };
  if (state.filters.sort === "love") {
    // Ranked, not dated: a heading would cut the ranking into pieces.
    push(list);
  } else {
    // A heading per month, not per day: a channel shares two or three books a
    // day, and a row of seven slots per day would be mostly empty. Each card
    // carries its own date.
    let month = "", run = [], head = null;
    for (const post of list) {
      const key = monthOf(post.ts);
      if (key !== month) {
        push(run);
        run = [];
        month = key;
        head = { t: "day", ts: post.ts, n: 0 };
        rows.push(head);
      }
      head.n++;
      run.push(post);
    }
    push(run);
  }
  view.rows = rows;
  view.heights = rows.map((row) => (row.t === "day" ? metrics.day : metrics.card + metrics.gap));
  view.order = [];
  view.where = new Map();
  rows.forEach((row, i) => {
    if (row.t !== "cards") return;
    row.posts.forEach((post, c) => { view.order.push(post.id); view.where.set(post.id, [i, c]); });
  });
  reflow();
}

/* ---------- drawing ---------- */

function drawRow(i) {
  const row = view.rows[i];
  if (row.t === "day") {
    const label = new Date(row.ts).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    return el("div", { class: "row" }, [el("div", { class: "day" }, [
      el("span", { text: label }),
      el("span", { class: "day-n", text: `${row.n.toLocaleString()} shared` }),
    ])]);
  }
  return el("div", { class: "row" }, [
    el("div", { class: "cards-row" }, row.posts.map((post) => drawCard(post, post.id === view.here))),
  ]);
}

const place = (node, y) => { node.style.transform = `translateY(${y}px)`; };

export function lowerBound(y) {
  let lo = 0, hi = view.rows.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (view.tops[mid] <= y) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

export function paint() {
  const feed = feedEl();
  if (!view.rows.length) {
    for (const [, node] of view.live) node.remove();
    view.live.clear();
    paintEmpty(feed);
    return;
  }
  feed.querySelector(".nothing")?.remove();

  const top = window.scrollY - feed.offsetTop;
  const bottom = top + window.innerHeight;
  const first = Math.max(0, lowerBound(top) - OVERSCAN);
  const last = Math.min(view.rows.length - 1, lowerBound(bottom) + OVERSCAN);

  for (const [i, node] of view.live) {
    if (i < first || i > last) { node.remove(); view.live.delete(i); }
  }
  const batch = document.createDocumentFragment();
  for (let i = first; i <= last; i++) {
    if (view.live.has(i)) continue;
    const node = drawRow(i);
    place(node, view.tops[i]);
    node.dataset.row = i;
    view.live.set(i, node);
    batch.appendChild(node);
  }
  feed.appendChild(batch);
  maybeGrow(first, last);
}

/* Nothing to draw: while the channel is still being read, a grid of placeholder
 * cards the size of the real ones; once read, a message in the middle of the room. */
function paintEmpty(feed) {
  const waiting = !filtering() && !grow.older && !state.meta.offline && !state.index.length;
  const kind = waiting ? "wait" : "none";
  const old = feed.querySelector(".nothing");
  if (old && old.dataset.kind === kind) return;
  old?.remove();
  readMetrics();
  feed.appendChild(waiting
    ? el("div", { class: "nothing row skeleton-grid", "data-kind": kind, "aria-busy": "true", "aria-label": "Reading the channel" },
      [el("div", { class: "cards-row" }, Array.from({ length: view.cols * 3 }, () => el("div", { class: "card sk-card" }, [
        el("div", { class: "plate" }), el("div", { class: "c-body" }, [el("span", { class: "sk-line w40" }), el("span", { class: "sk-line w90" }), el("span", { class: "sk-line w70" })]),
      ])))])
    : el("div", { class: "nothing row", "data-kind": kind }, [
      filtering()
        ? el("div", { class: "empty-state" }, [
          el("span", { class: "es-mark", text: "∅" }),
          el("span", { class: "es-t", text: "Nothing matches" }),
          el("span", { class: "es-h", text: "No recommendation in this channel passes the search and filters." }),
          el("button", { class: "act", text: "Clear filters", onclick: () => document.getElementById("reset")?.click() }),
        ])
        : el("div", { class: "empty-state" }, [
          el("span", { class: "es-mark", text: "#" }),
          el("span", { class: "es-t", text: "No recommendations here yet" }),
          el("span", { class: "es-h", text: state.meta.offline
            ? "This run is offline and nothing of this channel is cached."
            : "Nothing in the messages read so far is a recommendation. Fetch reads further back." }),
          el("button", { class: "act", text: "Fetch…", onclick: () => document.getElementById("fetch-open")?.click() }),
        ]),
    ]));
}

/* ---------- finding a card ---------- */

function cardNode(id) {
  const at = view.where.get(id);
  const row = at && view.live.get(at[0]);
  return row ? row.querySelector(`.card[data-id="${CSS.escape(id)}"]`) : null;
}

const postOf = (id) => {
  const at = view.where.get(id);
  return at ? view.rows[at[0]].posts[at[1]] : null;
};

/* Covers arrived for these posts: redraw the ones on screen. The size does not
 * change: a card is sized by the stylesheet, not by its cover. */
export function refreshCards(ids) {
  for (const id of ids) {
    const node = cardNode(id);
    if (node) fillCard(node, postOf(id));
  }
}

/* The same, keyed by job rather than by message: the download queue reports what
 * it is doing per job, and a card wears that as a word and a bar. */
export function refreshJobs(jobs) {
  const asked = new Set(jobs);
  for (const [i, node] of view.live) {
    const row = view.rows[i];
    if (!row || row.t !== "cards") continue;
    for (const post of row.posts) {
      if (!asked.has(post.job)) continue;
      const card = node.querySelector(`.card[data-id="${CSS.escape(post.id)}"]`);
      if (card) fillCard(card, post);
    }
  }
}

export function markSaved(id, on) {
  const node = cardNode(id);
  if (!node) return;
  node.classList.toggle("saved", on);
  const button = node.querySelector(".save");
  if (button) {
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.title = on ? "Remove the bookmark (b)" : "Bookmark this (b)";
  }
}

/* ---------- moving about ---------- */

const barH = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar-h")) || 132;

/* Bring a row into view, moving as little as possible: a row already on screen
 * stays where it is. `where` "start" or "end" puts it at that edge instead. */
export function scrollToRow(i, where = "nearest") {
  const feed = feedEl();
  const top = feed.offsetTop + view.tops[i];
  const bottom = top + view.heights[i];
  const above = window.scrollY + barH() + 8;
  const below = window.scrollY + window.innerHeight - 12;
  let want = null;
  if (where === "start" || (where === "nearest" && top < above)) want = top - barH() - 8;
  else if (where === "end" || (where === "nearest" && bottom > below)) want = bottom - window.innerHeight + 12;
  if (want !== null) window.scrollTo({ top: Math.max(0, want), behavior: "instant" });
  paint();
}

/* Choose a post. Its card is marked at once; the dock and anyone else listening
 * hear about it through `onHere`. */
export function setHere(id, scroll = true) {
  if (id === view.here) {
    if (scroll && view.where.has(id)) scrollToRow(view.where.get(id)[0]);
    return;
  }
  cardNode(view.here)?.classList.remove("here");
  view.here = id;
  if (id && scroll && view.where.has(id)) scrollToRow(view.where.get(id)[0]);
  cardNode(id)?.classList.add("here");
  for (const hook of hereHooks) hook(id);
}

/* j / k and ← / →: the next or previous card in reading order. */
export function step(direction) {
  if (!view.order.length) return;
  const at = view.order.indexOf(view.here);
  const next = at < 0 ? (direction > 0 ? 0 : view.order.length - 1) : at + direction;
  if (next < 0 || next >= view.order.length) return;
  setHere(view.order[next]);
}

/* ↑ / ↓: the card in the same column of the next row of cards, over a day
 * heading if need be; the row's last card if it is shorter. */
export function stepRow(direction) {
  if (!view.order.length) return;
  const at = view.where.get(view.here);
  if (!at) { step(direction); return; }
  let [i, c] = at;
  do { i += direction; } while (i >= 0 && i < view.rows.length && view.rows[i].t !== "cards");
  if (i < 0 || i >= view.rows.length) return;
  const posts = view.rows[i].posts;
  setHere(posts[Math.min(c, posts.length - 1)].id);
}

export function focused() {
  return view.here ? postOf(view.here) : null;
}

export const countShown = () => view.order.length;

export const rowOfPost = (id) => (view.where.has(id) ? view.where.get(id)[0] : -1);

export const rowOfMonth = (key) =>
  view.rows.findIndex((row) => row.t === "cards" && row.posts.some((post) => monthOf(post.ts) === key));

/* The month the viewport is reading, for the rail to mark. */
export function monthInView() {
  const from = lowerBound(window.scrollY - feedEl().offsetTop + barH());
  for (let i = from; i < view.rows.length; i++) {
    if (view.rows[i].t === "cards") return monthOf(view.rows[i].posts[0].ts);
  }
  return null;
}

/* ---------- rebuilding ---------- */

function clearLive() {
  for (const [, node] of view.live) node.remove();
  view.live.clear();
}

export function redraw() {
  clearLive();
  buildRows();
  // A chosen post that the filters now hide is no longer chosen.
  if (view.here && !view.where.has(view.here)) setHere(null, false);
  paint();
  changed();
}

/* Narrowing keeps your place; searching does not. A chip trims the list you are
 * already reading, so the card you chose should stay in view. A query builds a
 * different list, and the useful place in a different list is the top. */
export function applyFilter() {
  redraw();
  if (view.here && view.where.has(view.here)) scrollToRow(view.where.get(view.here)[0], "start");
  else window.scrollTo({ top: 0, behavior: "instant" });
}

export function newQuery() {
  redraw();
  window.scrollTo({ top: 0, behavior: "instant" });
  paint();
}

/* Rebuild while keeping the card you were looking at where it was. Adding older
 * or newer posts moves every offset after them, so the first post at the top of
 * the viewport is remembered by id and put back exactly where it was. */
export function anchored(rebuild) {
  const feed = feedEl();
  const viewTop = window.scrollY - feed.offsetTop + barH();
  let at = lowerBound(Math.max(0, viewTop));
  while (at < view.rows.length && view.rows[at].t !== "cards") at++;
  const row = view.rows[at];
  const key = row ? row.posts[0].id : null;
  const into = viewTop - (view.tops[at] || 0);

  clearLive();
  rebuild();

  const now = key === null ? -1 : rowOfPost(key);
  if (now < 0) { paint(); return; }
  window.scrollTo({ top: Math.max(0, feed.offsetTop + view.tops[now] + into - barH()), behavior: "instant" });
  paint();
}

/* The width changed (the window, or the dock): the columns may have too. */
export function relayout() {
  const before = view.cols;
  readMetrics();
  if (view.cols === before) return;
  anchored(buildRows);
  changed();
}

export function resetView() {
  clearLive();
  view.rows = [];
  view.tops = [];
  view.heights = [];
  view.order = [];
  view.where = new Map();
  view.here = null;
  grow.older = grow.newer = false;
  grow.streak = 0;
  for (const hook of hereHooks) hook(null);
}

export function mergeIndex(incoming) {
  const at = new Map(state.index.map((post, i) => [post.id, i]));
  let fresh = 0;
  for (const post of incoming) {
    indexPost(post);
    const i = at.get(post.id);
    if (i === undefined) { state.index.push(post); fresh++; } else { state.index[i] = post; }
  }
  if (fresh) state.index.sort(byIdAsc);
  return fresh;
}

/* ---------- growing ---------- */

/* Not enough drawn to scroll. Until this is false nothing else will ask for
 * more, because asking is what scrolling does. */
const tooShort = () =>
  document.documentElement.scrollHeight <= window.innerHeight + SHORT_PAGE;

function setGrowing(direction, on) {
  const node = $("#growing");
  if (!node) return;
  show(node, on);
  node.textContent = on
    ? (direction === "older" ? "Loading earlier shares…" : "Checking for newer shares…")
    : "";
}

export async function reachOut(direction) {
  if (grow.busy || grow[direction] || state.meta.offline) return;
  grow.busy = true;
  setGrowing(direction, true);
  try {
    const data = await apiPost("api/reach", {
      dir: direction,
      // Empty on a cold page: the server then walks back from the newest, which
      // is the same operation as reaching further into the past.
      oldest: state.index.length ? state.index[0].id : "",
      newest: state.index.length ? state.index[state.index.length - 1].id : "",
    });
    if (data.done) grow[direction] = true;
    for (const [job, where] of Object.entries(data.held || {})) state.held.set(job, where);
    const fresh = mergeIndex(data.posts || []);
    state.meta.coverage = data.coverage || state.meta.coverage;
    state.meta.categories = data.categories || state.meta.categories;
    state.meta.display = data.display || state.meta.display;
    if (fresh) {
      anchored(buildRows);
      // The months and the categories are drawn from the index, so shares that
      // arrive by growing have to be drawn into them too.
      grewBy(fresh);
    }
    changed();
  } catch (err) {
    // One failure should not turn into a request loop at the end of the list.
    grow[direction] = true;
    alarm("Could not load more (" + direction + "). " + err.message);
  } finally {
    grow.busy = false;
    setGrowing(direction, false);
  }

  // Filling a short page takes several pages, and no scroll event will arrive to
  // ask for them, so the chain keeps itself going -- bounded.
  if (tooShort() && !grow.older && grow.streak < GROW_STREAK) {
    grow.streak++;
    reachOut("older");
  } else {
    grow.streak = 0;
    changed();
  }
}

/* Called from paint: near either end, and there is more to have. Which end is
 * older depends on the order the feed is read in. */
function maybeGrow(first, last) {
  if (filtering() || state.filters.sort === "love") return;
  // A crawl is already walking this channel: two walkers would fetch the same
  // pages twice and race each other to the same edge.
  if (state.job.active) return;
  if (!view.rows.length || tooShort()) { reachOut("older"); return; }
  const top = newestFirst() ? "newer" : "older";
  const bottom = newestFirst() ? "older" : "newer";
  if (first <= GROW_ROWS) reachOut(top);
  if (last >= view.rows.length - 1 - GROW_ROWS) reachOut(bottom);
}
