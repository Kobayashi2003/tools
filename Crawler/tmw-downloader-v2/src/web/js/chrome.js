/* Everything around the feed: the bar, the month rail, and the two sheets.
 *
 * All of it reads the feed and none of it is read by the feed -- the wiring
 * hands the feed a callback instead, so the dependency only points one way. */

import { $, $$, el, fmtDay, monthOf, show, sizeBar, toast } from "./dom.js";
import { setSaved } from "./detail.js";
import * as feed from "./feed.js";
import { filtering, savePrefs, state } from "./store.js";

/* Filled in by the wiring: the bar offers an action this module cannot
 * perform itself. */
export const actions = { showEverything: () => {} };

/* ---------- the channel picker ---------- */

let channelsDrawn = "";
let picked = () => {};

const pickOptions = () => $$(".pick-opt", $("#channel-list"));
const pickerOpen = () => !$("#channel-list").hidden;

function paintChannels() {
  const box = $("#channel-list");
  const open = (state.meta.channel && state.meta.channel.channel_id) || state.channel;
  let list = state.meta.channels || [];
  if (!list.length && open) list = [{ id: open, name: state.meta.channel.name || open, cached: true }];

  // The head repaints on every crawl tick; rebuilding an open list under the
  // pointer would throw away where the reader had got to in it.
  const drawn = JSON.stringify(list.map((entry) => [entry.id, entry.name, !!entry.cached]));
  if (drawn !== channelsDrawn) {
    channelsDrawn = drawn;
    box.textContent = "";
    list.forEach((entry, i) => {
      // Channels already read down say so; the rest are offered but start
      // empty, which switching to will say for itself.
      box.appendChild(el("div", {
        class: "pick-opt" + (entry.cached ? " read" : ""),
        id: "channel-" + entry.id,
        role: "option",
        "data-id": entry.id,
        onclick: () => choose(entry.id),
        onpointermove: () => setActive(i, false),
      }, [
        el("span", { class: "pick-name", text: entry.name }),
        entry.cached ? el("span", { class: "pick-tag", text: "read" }) : null,
      ]));
    });
  }
  for (const option of pickOptions()) {
    option.setAttribute("aria-selected", option.dataset.id === open ? "true" : "false");
  }
  const current = list.find((entry) => entry.id === open);
  $("#channel-name").textContent = current ? current.name : "";
  // Adopt what the server says it served: on a cold page the channel is empty
  // and the default is whatever the command line named.
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
  const box = $("#channel-list");
  show(box, on);
  $("#channel-pick").setAttribute("aria-expanded", on ? "true" : "false");
  if (on) {
    const options = pickOptions();
    setActive(options.findIndex((option) => option.getAttribute("aria-selected") === "true"));
    box.focus({ preventScroll: true });
  } else if (refocus) {
    $("#channel-pick").focus();
  }
}

function choose(id) {
  showPicker(false, true);
  picked(id);
}

/* Type a letter to jump to the next channel that starts with it, the one
 * native-select habit worth keeping with twenty-odd names in the list. */
function jumpTo(letter) {
  const options = pickOptions();
  const from = activeIndex();
  for (let step = 1; step <= options.length; step++) {
    const i = (from + step) % options.length;
    if (options[i].textContent.toLowerCase().startsWith(letter)) { setActive(i); return; }
  }
}

export function bindChannels(onPick) {
  picked = onPick;
  const button = $("#channel-pick");
  const box = $("#channel-list");

  button.onclick = () => showPicker(!pickerOpen());
  // Kept from the page's own keys: Enter there means "peek", and j / k would
  // move the feed under an open list.
  button.addEventListener("keydown", (ev) => {
    if (["ArrowDown", "ArrowUp"].includes(ev.key)) {
      ev.preventDefault();
      showPicker(true);
    }
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
    if (pickerOpen() && !ev.target.closest(".channel")) showPicker(false);
  });
  box.addEventListener("focusout", (ev) => {
    if (pickerOpen() && !(ev.relatedTarget && ev.relatedTarget.closest(".channel"))) showPicker(false);
  });
}

/* ---------- the bar ---------- */

function counts() {
  const total = state.meta.display.in_scope ?? state.index.length;
  const shown = feed.countShown();
  const bits = [`<b>${total.toLocaleString()}</b> recommendations`];
  if (shown !== total) bits.push(`<b>${shown.toLocaleString()}</b> shown`);
  if (state.taken.size) bits.push(`${state.taken.size.toLocaleString()} fetched`);
  if (state.saved.size) bits.push(`${state.saved.size} bookmarked`);
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
  paintMarksButton();

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

export function paintSource() {
  for (const chip of $$("#source .chip")) {
    chip.setAttribute("aria-pressed",
      chip.dataset.source === state.filters.source ? "true" : "false");
  }
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

export function resetFilters() {
  Object.assign(state.filters, {
    q: "", kind: "", source: "", savedOnly: false, missingOnly: false,
  });
  $("#search").value = "";
  $("#saved-only").checked = false;
  $("#missing-only").checked = false;
  savePrefs();
  paintChips();
  paintSource();
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
  if (state.filters.desc) keys.reverse();
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
  const row = feed.rowOfMonth(key);
  if (row < 0) { toast("Nothing from that month in this filter"); return; }
  feed.scrollToRow(row);
  markRail();
}

/* ---------- bookmarks ---------- */

export function paintMarksButton() {
  $("#marks-count").textContent = state.saved.size;
  $("#marks-open").dataset.any = state.saved.size ? "1" : "0";
}

export function paintMarks() {
  const box = $("#marks-list");
  box.textContent = "";
  if (!state.bookmarks.length) {
    box.appendChild(el("div", {
      class: "sheet-empty",
      text: "No bookmarks yet. Press b on a recommendation, or Save on its card.",
    }));
    return;
  }
  for (const mark of state.bookmarks) {
    const bits = [mark.kind, mark.volumes].filter(Boolean);
    if (state.taken.has(mark.job) || state.held.has(mark.job)) bits.push("fetched");
    box.appendChild(el("button", { class: "bm", onclick: () => gotoShare(mark.id) }, [
      el("span", { class: "when", text: mark.ts ? fmtDay(mark.ts) : "" }),
      el("span", { class: "what" }, [
        el("span", { class: "t", text: mark.title || "untitled" }),
        el("span", { class: "sub", text: bits.join("  ·  ") }),
      ]),
      el("span", {
        class: "drop", text: "remove", role: "button", tabindex: "0",
        onclick: (ev) => { ev.stopPropagation(); setSaved(mark.id, false); },
      }),
    ]));
  }
}

export function showMarks(on) {
  show($("#marks"), on);
  if (on) paintMarks();
}

export const marksOpen = () => !$("#marks").hidden;

/* Jump to a bookmarked post. If a filter is hiding it, the filter loses --
 * "take me there" that quietly does nothing is worse than one that clears a
 * chip you can see. */
export function gotoShare(id) {
  showMarks(false);
  let row = feed.rowOfPost(id);
  if (row < 0) {
    resetFilters();
    row = feed.rowOfPost(id);
  }
  if (row < 0) { toast("That one is not in the archive"); return; }
  feed.scrollToRow(row);
  feed.setHere(row, false);
  markRail();
}

/* ---------- help ---------- */

export const showHelp = (on) => show($("#help"), on);
export const helpOpen = () => !$("#help").hidden;
