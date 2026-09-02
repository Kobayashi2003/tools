/* Everything around the feed: the bar, the month rail, and the two sheets.
 *
 * All of it reads the feed and none of it is read by the feed -- the wiring
 * hands the feed a callback instead, so the dependency only points one way. */

import { $, $$, el, fmtDay, monthOf, show, sizeBar, toast } from "./dom.js";
import { setSaved } from "./detail.js";
import * as feed from "./feed.js";
import { filtering, savePrefs, state } from "./store.js";

/* Filled in by the wiring: the bar offers actions this module cannot perform. */
export const actions = { showEverything: () => {}, pickChannel: () => {} };

/* ---------- the bar ---------- */

function paintChannels() {
  const pick = $("#channel-pick");
  const list = state.meta.channels || [];
  const open = (state.meta.channel && state.meta.channel.channel_id) || state.channel;
  const same = list.length === pick.options.length &&
    list.every((entry, i) => pick.options[i].value === entry.id);
  if (!same) {
    pick.textContent = "";
    for (const entry of list) {
      // A dot marks the channels already read down; the rest are offered but
      // start empty, which switching to will say for itself.
      pick.appendChild(el("option", {
        value: entry.id, text: entry.name + (entry.cached ? " ·" : ""),
      }));
    }
    if (!list.length && open) {
      pick.appendChild(el("option", { value: open, text: state.meta.channel.name || open }));
    }
  }
  pick.value = open || "";
  // Adopt what the server says it served: on a cold page the channel is empty
  // and the default is whatever the command line named.
  if (open) state.channel = open;
}

function counts() {
  const total = state.meta.display.in_scope ?? state.index.length;
  const shown = feed.countShown();
  const bits = [`<b>${total.toLocaleString()}</b> shares`];
  if (shown !== total) bits.push(`<b>${shown.toLocaleString()}</b> shown`);
  if (state.saved.size) bits.push(`${state.saved.size} bookmarked`);
  const cover = state.meta.coverage || {};
  if (cover.messages) {
    bits.push(`${fmtDay(cover.oldest_at).slice(-4)}–${fmtDay(cover.newest_at).slice(-4)} ` +
              `${cover.messages.toLocaleString()} msgs ${cover.complete ? "●" : "○"}`);
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
      `<b>${(state.meta.display.held || 0).toLocaleString()}</b> older shares are cached`;
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
  Object.assign(state.filters, { q: "", kind: "", source: "", savedOnly: false });
  $("#search").value = "";
  $("#saved-only").checked = false;
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
  if (row < 0) { toast("No shares from that month in this filter"); return; }
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
      text: "No bookmarks yet. Press b on a share, or Save on its card.",
    }));
    return;
  }
  for (const mark of state.bookmarks) {
    const bits = [mark.category, mark.author].filter(Boolean);
    if (mark.n_files) bits.push(`${mark.n_files} file${mark.n_files > 1 ? "s" : ""}`);
    if (mark.n_links) bits.push(`${mark.n_links} link${mark.n_links > 1 ? "s" : ""}`);
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

/* Jump to a bookmarked share. If a filter is hiding it, the filter loses --
 * "take me there" that quietly does nothing is worse than one that clears a
 * chip you can see. */
export function gotoShare(id) {
  showMarks(false);
  let row = feed.rowOfPost(id);
  if (row < 0) {
    resetFilters();
    row = feed.rowOfPost(id);
  }
  if (row < 0) { toast("That share is not in the archive"); return; }
  feed.scrollToRow(row);
  feed.setHere(row, false);
  markRail();
}

/* ---------- help ---------- */

export const showHelp = (on) => show($("#help"), on);
export const helpOpen = () => !$("#help").hidden;
