/* Everything around the grid: the bar (channel tabs, search, filters), the month
 * rail and the bookmarks.
 *
 * All of it reads the feed and none of it is read by the feed -- the wiring hands
 * the feed a callback instead, so the dependency only points one way. */

import { $, $$, el, fmtDay, monthOf, show, sizeBar, toast } from "./dom.js";
import { setSaved } from "./detail.js";
import * as feed from "./feed.js";
import { filtering, have, passes, savePrefs, state } from "./store.js";

/* Filled in by the wiring: the bar offers actions this module cannot perform. */
export const actions = { showEverything: () => {}, getShown: () => {} };

/* ---------- channels: tabs, and the rest under More ---------- */

let channelsDrawn = "";
let picked = () => {};

const pickOptions = () => $$(".pick-opt", $("#channel-list"));
const pickerOpen = () => !$("#channel-list").hidden;

/* The clubs' recommendation channels, and any already read, are tabs; the
 * server's other channels wait under More. A channel opened from More is shown as
 * a tab while it is open. */
const isTab = (entry) => entry.cached || /recommendation/.test(entry.name);
const tabLabel = (name) => name.replace(/-recommendations?$/, "").replace(/-/g, " ");

function paintChannels() {
  const open = (state.meta.channel && state.meta.channel.channel_id) || state.channel;
  let list = state.meta.channels || [];
  if (!list.length && open) list = [{ id: open, name: state.meta.channel.name || open, cached: true }];
  const tabs = list.filter((entry) => isTab(entry) || entry.id === open);
  const rest = list.filter((entry) => !tabs.includes(entry));

  // The head repaints on every crawl tick; rebuilding the lists under the
  // pointer would throw away where the reader had got to in them.
  const drawn = JSON.stringify([open, list.map((entry) => [entry.id, entry.name, !!entry.cached])]);
  if (drawn !== channelsDrawn) {
    channelsDrawn = drawn;
    $("#tabs").replaceChildren(...tabs.map((entry) => el("button", {
      class: "ch-tab", role: "tab", "aria-selected": entry.id === open ? "true" : "false",
      title: "#" + entry.name + (entry.cached ? "" : " · not read yet"),
      onclick: () => picked(entry.id),
    }, [el("span", { text: tabLabel(entry.name) })])));
    const box = $("#channel-list");
    box.textContent = "";
    rest.forEach((entry, i) => {
      box.appendChild(el("div", {
        class: "pick-opt",
        id: "channel-" + entry.id,
        role: "option",
        "data-id": entry.id,
        onclick: () => choose(entry.id),
        onpointermove: () => setActive(i, false),
      }, [el("span", { class: "pick-name", text: "#" + entry.name })]));
    });
    show($("#channel-more"), rest.length > 0);
  }
  if (open) state.channel = open;
}

function setActive(index, scroll = true) {
  const options = pickOptions();
  if (!options.length) return;
  const at = Math.max(0, Math.min(options.length - 1, index));
  options.forEach((option, i) => option.classList.toggle("on", i === at));
  $("#channel-list").setAttribute("aria-activedescendant", options[at].id);
  if (scroll) options[at].scrollIntoView({ block: "nearest" });
}

const activeIndex = () => pickOptions().findIndex((option) => option.classList.contains("on"));

function showPicker(on, refocus = false) {
  if (on === pickerOpen()) return;
  show($("#channel-list"), on);
  $("#channel-pick").setAttribute("aria-expanded", on ? "true" : "false");
  if (on) {
    setActive(0);
    $("#channel-list").focus({ preventScroll: true });
  } else if (refocus) {
    $("#channel-pick").focus();
  }
}

function choose(id) {
  showPicker(false, true);
  picked(id);
}

/* Type a letter to jump to the next channel that starts with it. */
function jumpTo(letter) {
  const options = pickOptions();
  const from = activeIndex();
  for (let step = 1; step <= options.length; step++) {
    const i = (from + step) % options.length;
    if (options[i].textContent.replace(/^#/, "").toLowerCase().startsWith(letter)) { setActive(i); return; }
  }
}

export function bindChannels(onPick) {
  picked = onPick;
  const button = $("#channel-pick");
  const box = $("#channel-list");

  button.onclick = () => showPicker(!pickerOpen());
  // Kept from the page's own keys: Enter there means "look", and j / k would
  // move the grid under an open list.
  button.addEventListener("keydown", (ev) => {
    if (["ArrowDown", "ArrowUp"].includes(ev.key)) { ev.preventDefault(); showPicker(true); }
    if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(ev.key)) ev.stopPropagation();
  });

  box.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    const last = pickOptions().length - 1;
    const moves = {
      ArrowDown: () => setActive(activeIndex() + 1),
      ArrowUp: () => setActive(activeIndex() - 1),
      Home: () => setActive(0),
      End: () => setActive(last),
      PageDown: () => setActive(activeIndex() + 8),
      PageUp: () => setActive(activeIndex() - 8),
      Enter: () => { const at = pickOptions()[activeIndex()]; if (at) choose(at.dataset.id); },
      Escape: () => showPicker(false, true),
    };
    moves[" "] = moves.Enter;
    if (moves[ev.key]) { ev.preventDefault(); moves[ev.key](); return; }
    if (ev.key === "Tab") { showPicker(false); return; }
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) jumpTo(ev.key.toLowerCase());
  });

  document.addEventListener("pointerdown", (ev) => {
    if (pickerOpen() && !ev.target.closest(".channel-more")) showPicker(false);
  });
  box.addEventListener("focusout", (ev) => {
    if (pickerOpen() && !(ev.relatedTarget && ev.relatedTarget.closest(".channel-more"))) showPicker(false);
  });
}

/* ---------- the bar ---------- */

function counts() {
  const total = state.meta.display.in_scope ?? state.index.length;
  const shown = feed.countShown();
  const bits = [`<b>${total.toLocaleString()}</b> recommendations`];
  if (shown !== total) bits.push(`<b>${shown.toLocaleString()}</b> shown`);
  if (state.taken.size) bits.push(`${state.taken.size.toLocaleString()} fetched`);
  const cover = state.meta.coverage || {};
  if (cover.messages) {
    const from = fmtDay(cover.oldest_at).slice(-4);
    const to = fmtDay(cover.newest_at).slice(-4);
    const mark = cover.complete
      ? `<span class="cover-mark" title="Read back to the channel's first message">●</span>`
      : `<span class="cover-mark" title="Older messages not read yet — Fetch reads more">○</span>`;
    bits.push(`${cover.messages.toLocaleString()} msgs ${from === to ? from : from + "–" + to} ${mark}`);
  }
  if (state.meta.offline) bits.push("offline");
  return bits.join("  ·  ");
}

/* What a batch Get would queue: shown, with a job, not on disk, not in the queue. */
export function gettable() {
  return state.index.filter((post) => passes(post) && post.job && !have(post)
    && !["queued", "opening", "working"].includes(state.jobState.get(post.job)));
}

export function paintHead() {
  paintChannels();
  $("#channel-link").href = state.meta.channel.url || "#";
  const name = state.meta.channel.name || "";
  if (name) document.title = "#" + name + " — the moe way";
  $("#counts").innerHTML = counts();

  // Nothing bookmarked means the filter would empty the page; say so, and do
  // not leave the page filtered to a set that no longer exists.
  const none = state.saved.size === 0;
  $("#saved-only").disabled = none;
  if (none && state.filters.savedOnly) {
    state.filters.savedOnly = false;
    $("#saved-only").checked = false;
    savePrefs();
    feed.redraw();
  }
  show($("#reset"), filtering());
  paintWho();
  paintMarksCount();
  paintGetShown();

  const note = $("#note");
  if (state.meta.display.tail) {
    $("#note-text").innerHTML =
      "Showing only what has arrived since launch · " +
      `<b>${(state.meta.display.held || 0).toLocaleString()}</b> older ones are cached`;
    $("#note-act").textContent = "Show everything";
    $("#note-act").onclick = () => actions.showEverything();
    show(note, true);
  } else {
    show(note, false);
  }
  sizeBar();
}

/* Only with a filter on: "Get everything in the channel" is not a button to have
 * lying around. */
export function paintGetShown() {
  const button = $("#get-shown");
  const n = filtering() ? gettable().length : 0;
  show(button, n > 0);
  if (n) {
    button.textContent = `Get ${n.toLocaleString()} shown`;
    button.title = `Queue the ${n.toLocaleString()} shown recommendations that are not on disk yet`;
  }
}

/* The segmented choices: where the files are, whether they are here, the order. */
export function paintSegs() {
  const f = state.filters;
  for (const [box, key] of [["#source", "source"], ["#have", "have"], ["#sort", "sort"]]) {
    for (const chip of $$(`${box} [data-value]`)) chip.setAttribute("aria-pressed", chip.dataset.value === f[key] ? "true" : "false");
  }
  $("#rail").classList.toggle("off", f.sort === "love");
}

export function paintChips() {
  const box = $("#chips");
  box.textContent = "";
  for (const name of state.meta.categories || []) {
    box.appendChild(el("button", {
      class: "chip",
      "aria-pressed": state.filters.kind === name ? "true" : "false",
      text: name,
      onclick: () => {
        state.filters.kind = state.filters.kind === name ? "" : name;
        savePrefs();
        paintChips();
        feed.applyFilter();
      },
    }));
  }
}

function paintWho() {
  const box = $("#who");
  const who = state.filters.who;
  show(box, !!who);
  if (who) $("#who-name").textContent = who;
}

export function setWho(name) {
  state.filters.who = name || "";
  feed.applyFilter();
  paintHead();
}

export function resetFilters() {
  Object.assign(state.filters, { q: "", kind: "", source: "", savedOnly: false, have: "", who: "" });
  $("#search").value = "";
  $("#saved-only").checked = false;
  savePrefs();
  paintChips();
  paintSegs();
  feed.applyFilter();
}

/* ---------- the month rail ---------- */

/* Five years of channel, and where the weight sits in them. */
export function paintRail() {
  const rail = $("#rail");
  rail.textContent = "";
  const months = new Map();
  for (const post of state.index) {
    const key = monthOf(post.ts);
    months.set(key, (months.get(key) || 0) + 1);
  }
  const keys = [...months.keys()].sort();
  if (state.filters.sort !== "old") keys.reverse();
  const peak = Math.max(1, ...months.values());

  let year = "";
  for (const key of keys) {
    const [thisYear, month] = key.split("-");
    if (thisYear !== year) {
      year = thisYear;
      rail.appendChild(el("div", { class: "rail-year", text: year }));
    }
    const count = months.get(key);
    rail.appendChild(el("button", {
      class: "rail-month",
      "data-month": key,
      title: `${count.toLocaleString()} share${count === 1 ? "" : "s"}`,
      onclick: () => gotoMonth(key),
    }, [
      el("span", { class: "rail-name", text: month }),
      el("span", { class: "bar-fill", style: `--fill:${Math.max(8, (count / peak) * 100)}%` }),
    ]));
  }
}

export function markRail() {
  const key = feed.monthInView();
  for (const button of $$(".rail-month")) {
    button.dataset.on = button.dataset.month === key ? "1" : "0";
  }
}

function gotoMonth(key) {
  if (state.filters.sort === "love") { toast("Most ♥ is not by date; switch to Newest or Oldest"); return; }
  const row = feed.rowOfMonth(key);
  if (row < 0) { toast("Nothing from that month in this filter"); return; }
  feed.scrollToRow(row, "start");
  markRail();
}

/* ---------- bookmarks ---------- */

export function paintMarksCount() {
  for (const id of ["#marks-count", "#tab-marks-n"]) {
    const node = $(id);
    if (!node) continue;
    node.textContent = state.saved.size || "";
    node.dataset.any = state.saved.size ? "1" : "0";
  }
}

export function paintMarks() {
  const box = $("#marks-list");
  box.textContent = "";
  if (!state.bookmarks.length) {
    box.appendChild(el("div", { class: "empty-state" }, [
      el("span", { class: "es-mark mark", text: "★" }),
      el("span", { class: "es-t", text: "No bookmarks yet" }),
      el("span", { class: "es-h", html: "Press <kbd>b</kbd> on the chosen recommendation, or the star on its card, to keep it here." }),
    ]));
    return;
  }
  for (const mark of state.bookmarks) {
    const bits = [mark.kind, mark.volumes && "vol " + mark.volumes].filter(Boolean);
    if (state.taken.has(mark.job) || state.held.has(mark.job)) bits.push("fetched");
    box.appendChild(el("div", { class: "bm" }, [
      el("button", { class: "bm-go", onclick: () => gotoShare(mark.id) }, [
        el("span", { class: "when", text: mark.ts ? fmtDay(mark.ts) : "" }),
        el("span", { class: "what" }, [
          el("span", { class: "t", text: mark.title || "untitled" }),
          el("span", { class: "sub", text: bits.join("  ·  ") }),
        ]),
      ]),
      el("button", { class: "drop", text: "Remove", title: "Remove the bookmark", onclick: () => setSaved(mark.id, false) }),
    ]));
  }
  box.appendChild(el("div", { class: "dock-foot", html: "<kbd>b</kbd> bookmarks the chosen recommendation" }));
}

/* Jump to a post. If a filter is hiding it, the filter loses -- "take me there"
 * that quietly does nothing is worse than one that clears a chip you can see. */
export function gotoShare(id) {
  if (feed.rowOfPost(id) < 0) resetFilters();
  if (feed.rowOfPost(id) < 0) { toast("That one is not in the archive"); return false; }
  feed.setHere(id);
  markRail();
  return true;
}

/* ---------- help ---------- */

export const showHelp = (on) => show($("#help"), on);
export const helpOpen = () => !$("#help").hidden;
