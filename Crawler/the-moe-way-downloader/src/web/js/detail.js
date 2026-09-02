/* Links, a screenful at a time.
 *
 * The index arrives without any attachment URLs -- they are signed and expire
 * -- so a card knows its own height before it knows its own links. Asking is
 * batched per paint, and answers are kept until the signature is close enough
 * to expiring that the server would re-sign it anyway. */

import { alarm } from "./dom.js";
import { post } from "./net.js";
import { state } from "./store.js";

const wanted = new Set();
let flushTimer = null;

const detailHooks = [];
const savedHooks = [];
/* Registered by the wiring, not by the drawing: this module knows when links
 * arrive, but not what is on screen. */
export const onDetail = (fn) => detailHooks.push(fn);
export const onSaved = (fn) => savedHooks.push(fn);

const announce = (hooks, ...args) => { for (const hook of hooks) hook(...args); };

/* A cached copy is good until its links are close enough to expiring that the
 * server would re-sign them. Asking at *half* the server's margin matters: ask
 * any later and the server would hand back the same link, and the page would
 * ask again on the next paint, forever. */
export function usable(id) {
  const held = state.detail.get(id);
  if (!held) return false;
  // `settled` means we already asked and this is the best the server has --
  // offline, or a re-sign that failed. Without it the page asks on every paint
  // and gets the same expired link back, forever.
  if (held.error || held.settled) return true;
  if (!held.expires) return true;   // nothing signed to go stale
  const margin = (state.meta.link_margin || 7200) * 500;
  return (held.expires * 1000 - Date.now()) > margin;
}

export const expired = (id) => {
  const held = state.detail.get(id);
  return !!(held && held.expires && held.expires * 1000 < Date.now());
};

export function needDetail(id) {
  if (usable(id) || wanted.has(id)) return;
  wanted.add(id);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 50);
}

function keep(entry) {
  state.detail.set(entry.id, entry);
  // Came back no fresher than it went out: stop asking for this one.
  if (!usable(entry.id)) state.detail.set(entry.id, Object.assign(entry, { settled: true }));
}

async function flush() {
  const ids = [...wanted];
  wanted.clear();
  if (!ids.length) return;
  try {
    const data = await post("/api/detail", { ids });
    for (const entry of data.posts || []) keep(entry);
  } catch (err) {
    for (const id of ids) {
      state.detail.set(id, { id, files: [], links: [], covers: [], error: true });
    }
    alarm("Could not fetch links: " + err.message);
  }
  announce(detailHooks, ids);
}

/* One post, awaited -- for the keyboard actions, which have nothing to draw
 * and simply need the links before they can act. */
export async function ensureDetail(id) {
  if (usable(id)) return state.detail.get(id);
  try {
    const data = await post("/api/detail", { ids: [id] });
    for (const entry of data.posts || []) keep(entry);
    announce(detailHooks, [id]);
  } catch (err) {
    alarm("Could not fetch links: " + err.message);
  }
  return state.detail.get(id) || { id, files: [], links: [], covers: [] };
}

/* Ticking a file is fire-and-forget: the mark shows at once and the server is
 * told after, because waiting on a round trip to shade a row would make every
 * download feel slow. */
export function setTaken(ids, on) {
  for (const id of ids) on ? state.taken.add(id) : state.taken.delete(id);
  post("/api/taken", { ids, on })
    .catch((err) => alarm("Could not save the mark: " + err.message));
}

/* Optimistic in the same way, and cheap to redo if the write ever fails. */
export async function setSaved(id, on) {
  on ? state.saved.add(id) : state.saved.delete(id);
  announce(savedHooks, id, on);
  try {
    const data = await post("/api/bookmark", { id, on });
    state.bookmarks = data.bookmarks || [];
    announce(savedHooks, id, on);
  } catch (err) {
    alarm("Could not save the bookmark: " + err.message);
  }
}
