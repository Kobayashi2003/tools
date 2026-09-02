/* The feed itself.
 *
 * The archive is ~11k shares, so nothing here renders a list: it is a flat row
 * model (day headings and cards) laid out by measured offsets, with only the
 * rows near the viewport in the DOM. A card is sized from counts the index
 * already carried, so scrolling never reflows behind you.
 *
 * Chronological by default, newest at the bottom, the way the channel reads. */

import { $, alarm, dayOf, el, fmtDay, monthOf, show } from "./dom.js";
import { drawCard, fillCard } from "./card.js";
import { post as apiPost } from "./net.js";
import { byIdAsc, filtering, indexPost, passes, state } from "./store.js";

const OVERSCAN = 6;
const GROW_STREAK = 40;   // pages to pull unattended before waiting to be asked
const SHORT_PAGE = 240;   // px of slack that still counts as "nothing to scroll"

/* What the feed is made of, after filters. Exported as one object so callers
 * read the live values rather than a copy taken at import time. */
export const view = {
  rows: [],        // {t: "day"|"post", ...}
  tops: [],        // row offsets, cumulative
  heights: [],     // row heights, estimated then measured
  live: new Map(), // row index -> element
  here: -1,        // the j/k cursor
};

/* The archive grows as you arrive at either end, rather than being decided up
 * front. `done` is latched per direction so a channel with no more to give is
 * not asked twice, and only one request is ever in flight. */
const grow = { busy: false, older: false, newer: false, rows: 10, streak: 0 };

const changeHooks = [];
const grewHooks = [];
/* The header counts what the feed holds, but the feed should not know there is
 * a header: the wiring joins them. `onChange` is every repaint; `onGrew` is
 * the rarer case where posts the page had never seen arrived, which is what
 * the month rail and the category chips are built from. */
export const onChange = (fn) => changeHooks.push(fn);
export const onGrew = (fn) => grewHooks.push(fn);
const changed = () => { for (const hook of changeHooks) hook(); };
const grewBy = (n) => { for (const hook of grewHooks) hook(n); };

const feedEl = () => $("#feed");

/* ---------- heights ---------- */

/* Height without measuring. Every part of a card that could vary is pinned in
 * CSS -- the cover plate, the file rows, the title at two lines -- so this is
 * arithmetic over counts the index already carried, not a guess the measure
 * pass has to keep correcting. The numbers come from the stylesheet so the two
 * cannot drift apart, which is also what makes a breakpoint safe: a taller file
 * row on a narrow window changes --row-h, and the estimate follows. */
const metrics = { plate: 146, row: 32, gap: 2, title: 22, day: 52, chrome: 40, text: 900 };

function readMetrics() {
  const style = getComputedStyle(document.documentElement);
  const px = (name, fallback) => parseFloat(style.getPropertyValue(name)) || fallback;
  metrics.plate = px("--plate-h", 146);
  metrics.row = px("--row-h", 32);
  metrics.gap = px("--row-gap", 2);
  metrics.title = px("--title-line", 22);
  metrics.day = px("--day-h", 52);
  metrics.chrome = px("--card-chrome", 40);
  const column = document.querySelector(".card .col");
  if (column && column.clientWidth) metrics.text = column.clientWidth;
}

/* CJK glyphs are full-width and Latin roughly half, and these titles mix them,
 * so counting characters would misjudge the wrap by a factor of two. */
function visualWidth(text) {
  let width = 0;
  for (const ch of text || "") {
    const code = ch.codePointAt(0);
    width += (code >= 0x1100 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xff60) ? 2 : 1;
  }
  return width;
}

function estimate(row) {
  if (row.t === "day") return metrics.day;
  const post = row.p;
  const perLine = Math.max(20, metrics.text / 7.6);
  const lines = Math.min(2, Math.max(1, Math.ceil(visualWidth(post.title) / perLine)));
  const count = post.n_files + post.n_links;
  const column = 22                                        // kind / author line
    + lines * metrics.title + 3                            // title, clamped at two
    + 5 + 17                                               // meta line
    + (post.body ? 8 + 36 : 0)                             // body, clamped at two
    + (count ? 9 + count * metrics.row + (count - 1) * metrics.gap : 0)
    + 7 + 19;                                              // tools row
  return Math.max(column, post.n_covers ? metrics.plate : 0) + metrics.chrome;
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

export function buildRows() {
  let list = state.index.filter(passes);
  if (state.filters.desc) list = list.slice().reverse();

  const rows = [];
  let day = "";
  for (const post of list) {
    const key = dayOf(post.ts);
    if (key !== day) { day = key; rows.push({ t: "day", ts: post.ts }); }
    rows.push({ t: "post", p: post });
  }

  view.rows = rows;
  readMetrics();
  view.heights = rows.map(estimate);
  reflow();
}

/* ---------- drawing ---------- */

function drawRow(i) {
  const row = view.rows[i];
  if (row.t === "day") {
    return el("div", { class: "row" }, [el("div", { class: "day", text: fmtDay(row.ts) })]);
  }
  return el("div", { class: "row" }, [drawCard(row.p, i === view.here)]);
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

export function paint(compensate = true) {
  const feed = feedEl();
  if (!view.rows.length) {
    for (const [, node] of view.live) node.remove();
    view.live.clear();
    if (!feed.querySelector(".nothing")) {
      const waiting = !filtering() && !grow.older && !state.meta.offline;
      feed.appendChild(el("div", {
        class: "nothing row",
        text: waiting ? "Reading the channel…" : "Nothing matches.",
      }));
    }
    return;
  }
  const empty = feed.querySelector(".nothing");
  if (empty) empty.remove();

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
  measure(top, compensate);
  maybeGrow(first, last);
}

/* Correct the guessed heights against what actually rendered. Rows above the
 * viewport are compensated for in scrollTop, so growing a title two lines up
 * does not shove the page under the reader. */
function measure(viewTop, compensate) {
  // Pin the row that owns the top of the viewport. Summing the drift of rows
  // "above the window" was subtly wrong -- the window starts OVERSCAN rows
  // early, so corrections in that gap moved the page without being counted,
  // which is exactly what the judder was.
  const anchor = lowerBound(viewTop);
  const was = view.tops[anchor];

  let moved = false;
  for (const [i, node] of view.live) {
    // The row wrapper, not its child: the cards carry margins, and measuring
    // the child alone lets the next row sit on top of them.
    const height = node.offsetHeight;
    if (Math.abs(height - view.heights[i]) > 0.5) {
      view.heights[i] = height;
      moved = true;
    }
  }
  if (!moved) return;
  reflow();
  for (const [i, node] of view.live) place(node, view.tops[i]);

  // Only while scrolling organically. A deliberate jump re-aims itself instead,
  // otherwise the two corrections chase each other.
  const drift = view.tops[anchor] - was;
  if (drift && compensate) window.scrollBy(0, drift);
}

/* Links arrived for these posts: redraw the ones on screen. Heights do not
 * change, because a card is sized from counts, not from its links. */
export function refreshCards(ids) {
  const asked = new Set(ids);
  for (const [i, node] of view.live) {
    const row = view.rows[i];
    if (row && row.t === "post" && asked.has(row.p.id)) fillCard(node, row.p);
  }
}

export function markSaved(id, on) {
  for (const [i, node] of view.live) {
    const row = view.rows[i];
    if (!row || row.t !== "post" || row.p.id !== id) continue;
    node.firstElementChild.classList.toggle("saved", on);
    const button = node.querySelector(".save");
    if (button) button.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

/* ---------- moving about ---------- */

/* Aim, redraw, and aim again. Most rows are still estimated when a jump is
 * made, and drawing the destination corrects the heights around it -- which
 * moves the destination. Two or three passes converge; the alternative is
 * landing a screenful away from what you asked for. */
export function scrollToRow(i, where = "start") {
  const feed = feedEl();
  const barH = parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue("--bar-h")) || 132;
  const aim = () => (where === "end"
    ? feed.offsetTop + view.tops[i] + view.heights[i] - window.innerHeight + 24
    : feed.offsetTop + view.tops[i] - barH - 24);

  let want = 0;
  for (let pass = 0; pass < 4; pass++) {
    want = Math.max(0, aim());
    window.scrollTo({ top: want, behavior: "instant" });
    paint(false);
    if (Math.abs(Math.max(0, aim()) - want) < 2) break;
  }
  window.scrollTo({ top: Math.max(0, aim()), behavior: "instant" });
  paint(false);
}

export function setHere(i, scroll = true) {
  if (i < 0 || i >= view.rows.length) return;
  const was = view.live.get(view.here);
  if (was) was.firstElementChild.classList.remove("here");
  view.here = i;
  if (scroll) scrollToRow(i);
  const now = view.live.get(view.here);
  if (now) now.firstElementChild.classList.add("here");
}

export function step(direction) {
  let i = view.here;
  do { i += direction; } while (i >= 0 && i < view.rows.length && view.rows[i].t !== "post");
  if (i < 0 || i >= view.rows.length) return;
  setHere(i);
}

export function focused() {
  const row = view.rows[view.here];
  return view.here >= 0 && row && row.t === "post" ? row.p : null;
}

export const countShown = () =>
  view.rows.reduce((n, row) => n + (row.t === "post" ? 1 : 0), 0);

export const rowOfPost = (id) =>
  view.rows.findIndex((row) => row.t === "post" && row.p.id === id);

export const rowOfMonth = (key) =>
  view.rows.findIndex((row) => row.t === "post" && monthOf(row.p.ts) === key);

/* The month the viewport is reading, for the rail to mark. */
export function monthInView() {
  const from = lowerBound(window.scrollY - feedEl().offsetTop + 80);
  for (let i = from; i < view.rows.length; i++) {
    if (view.rows[i].t === "post") return monthOf(view.rows[i].p.ts);
  }
  return null;
}

/* ---------- rebuilding ---------- */

export function redraw() {
  // Keep the cursor on the same share across a filter change; losing your place
  // every time you narrow the list is the annoying part of j/k navigation.
  const row = view.rows[view.here];
  const anchor = view.here >= 0 && row && row.t === "post" ? row.p.id : null;
  for (const [, node] of view.live) node.remove();
  view.live.clear();
  buildRows();
  view.here = anchor ? rowOfPost(anchor) : -1;
  paint();
  changed();
}

/* Narrowing keeps your place; searching does not. A chip trims the list you are
 * already reading, so the share under the cursor should stay under it. A query
 * builds a different list, and the useful place in a different list is the top. */
export function applyFilter() {
  redraw();
  if (view.here >= 0) scrollToRow(view.here);
  else window.scrollTo({ top: 0, behavior: "instant" });
}

export function newQuery() {
  view.here = -1;
  redraw();
  window.scrollTo({ top: 0, behavior: "instant" });
}

/* Rebuild while keeping the pixel you were looking at. Prepending older shares
 * moves every offset below them, so the row at the top of the viewport is
 * remembered by id and put back exactly where it was. */
export function anchored(rebuild) {
  const feed = feedEl();
  const viewTop = window.scrollY - feed.offsetTop;
  // Anchor on a post, not on whatever row happens to straddle the viewport top:
  // that is usually a date heading, and only posts survive a rebuild with an
  // identity to find them by.
  let at = lowerBound(viewTop);
  while (at < view.rows.length && view.rows[at].t !== "post") at++;
  const row = view.rows[at];
  const key = row ? row.p.id : null;
  const into = viewTop - (view.tops[at] || 0);

  rebuild();

  const now = key === null ? -1 : rowOfPost(key);
  if (now < 0) { paint(false); return; }
  window.scrollTo({ top: feed.offsetTop + view.tops[now] + into, behavior: "instant" });
  paint(false);
}

/* A resize changes every estimate, so the model is rebuilt -- but the reader is
 * still looking at a share, and should still be looking at it afterwards. */
export function relayout() {
  anchored(() => {
    for (const [, node] of view.live) node.remove();
    view.live.clear();
    buildRows();
  });
}

export function resetView() {
  for (const [, node] of view.live) node.remove();
  view.live.clear();
  view.rows = [];
  view.tops = [];
  view.heights = [];
  view.here = -1;
  grow.older = grow.newer = false;
  grow.streak = 0;
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
 * more, because asking is what scrolling does -- which is how a channel that
 * yields two shares per hundred messages used to stall on arrival. */
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
    const data = await apiPost("/api/reach", {
      dir: direction,
      // Empty on a cold page: the server then walks back from the newest, which
      // is the same operation as reaching further into the past.
      oldest: state.index.length ? state.index[0].id : "",
      newest: state.index.length ? state.index[state.index.length - 1].id : "",
    });
    if (data.done) grow[direction] = true;
    const fresh = mergeIndex(data.posts || []);
    state.meta.coverage = data.coverage || state.meta.coverage;
    state.meta.categories = data.categories || state.meta.categories;
    state.meta.display = data.display || state.meta.display;
    if (fresh) {
      anchored(buildRows);
      // The months and the categories are drawn from the index, so shares that
      // arrive by growing have to be drawn into them too. Without this a
      // channel whose posts all arrive this way keeps an empty rail.
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

  // Filling a short page takes several pages, and no scroll event will arrive
  // to ask for them, so the chain has to keep itself going -- bounded, so a
  // channel that never fills a screen stops asking rather than reading itself
  // to the end.
  if (tooShort() && !grow.older && grow.streak < GROW_STREAK) {
    grow.streak++;
    reachOut("older");
  } else {
    grow.streak = 0;
    changed();
  }
}

/* Called from paint: near either end, and there is more to have. */
function maybeGrow(first, last) {
  if (filtering()) return;          // a filtered view is not the end of the channel
  // A crawl is already walking this channel: two walkers would fetch the same
  // pages twice and race each other to the same edge.
  if (state.job.active) return;
  if (!view.rows.length || tooShort()) { reachOut("older"); return; }
  if (first <= grow.rows) reachOut("older");
  if (last >= view.rows.length - 1 - grow.rows) reachOut("newer");
}
