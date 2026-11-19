/* The wiring: what the controls do, and what happens on the way in.
 *
 * Every module below this one points downwards -- the feed does not know about
 * the bar, the bar does not know how to reload a channel -- so this file is the
 * only place that knows about all of them. */

import { $, $$, alarm, clearAlarm, copy, show, sizeBar, toast } from "./dom.js";
import * as chrome from "./chrome.js";
import * as feed from "./feed.js";
import { onDetail, onSaved, setSaved } from "./detail.js";
import { closeDock, currentTab, dockFixed, dockShown, openDock, paintDetail, showTab } from "./dock.js";
import { bindFetch, checkFetch, onFetchDone, onFetchProgress, showFetch } from "./fetch.js";
import { checkGrabs, clearGrabs, grab, grabMany, onGrabs, paintSheet, peek } from "./grabs.js";
import { closeLightbox, isLightboxOpen, stepLightbox } from "./lightbox.js";
import { getIndex, post } from "./net.js";
import { indexPost, loadPrefs, rememberChannel, savePrefs, state } from "./store.js";

const SEARCH_PAUSE = 130;   // ms after the last keystroke before the grid moves
// A batch this large asks first: the bot is pressed one job at a time.
const ASK_ABOVE = 10;

/* ---------- taking delivery of an archive ---------- */

function adopt(data) {
  state.meta = data;
  state.index = (data.posts || []).map(indexPost);
  state.detail.clear();
  state.taken = new Set(data.taken || []);
  state.held = new Map(Object.entries(data.held || {}));
  state.bookmarks = data.bookmarks || [];
  state.saved = new Set(state.bookmarks.map((mark) => mark.id));
  // A remembered type the channel no longer uses would silently empty the
  // page, so it is dropped rather than left to look like a bug.
  if (state.filters.kind && !(state.meta.categories || []).includes(state.filters.kind)) {
    state.filters.kind = "";
  }
  chrome.paintChips();
  chrome.paintSegs();
  chrome.paintRail();
  feed.resetView();
  feed.redraw();
  chrome.paintMarks();
  if (state.meta.error) alarm(state.meta.error);
}

const reload = async () => adopt(await getIndex());

/* The bot writes recommenders as mentions with pings suppressed, so the id is
 * all Discord sends. Names come from a separate lookup, asked for once per
 * channel and only when there is something to ask about. */
const asked = new Set();
async function learnNames() {
  const channel = state.channel || "-";
  if (asked.has(channel) || state.meta.offline) return;
  if (!state.index.some((p) => p.who && p.who.startsWith("<@"))) return;
  asked.add(channel);
  try {
    const data = await post("api/names");
    if (!data.added) return;
    // Only the recommender line changes, so the index is patched rather than
    // rebuilt: a reload here would throw away the reader's place.
    const named = new Map((data.posts || []).map((p) => [p.id, p.who]));
    for (const item of state.index) {
      const who = named.get(item.id);
      if (who && who !== item.who) { item.who = who; indexPost(item); }
    }
    feed.redraw();
  } catch (err) { /* a mention that stays an id is not worth an alert */ }
}

/* Switching is a full reload of a different archive: every filter, cursor and
 * cached cover belongs to the channel it came from, so none of it carries. */
async function switchChannel(id) {
  if (!id || id === state.channel) return;
  rememberChannel(id);
  feed.resetView();
  state.index = [];
  state.detail.clear();
  state.meta = { ...state.meta, channel: { ...state.meta.channel, channel_id: id } };
  clearAlarm();
  feed.paint();
  window.scrollTo({ top: 0, behavior: "instant" });
  try {
    await reload();
  } catch (err) {
    alarm("Could not open that channel. " + err.message);
  }
  openAtTheEnd();
  // A crawl belongs to a channel, so the page asks again about the new one.
  checkFetch();
  learnNames();
  if (!state.index.length) feed.reachOut("older");
}

async function sync() {
  const button = $("#sync");
  button.disabled = true;
  button.textContent = "Refreshing…";
  try {
    const data = await post("api/sync");
    adopt(data);
    const added = (data.synced || {}).added || 0;
    toast(added ? `${added} new message${added > 1 ? "s" : ""}` : "Nothing new");
  } catch (err) {
    // The alert bar, not a toast: a refusal names a cause worth reading twice.
    alarm("Refresh failed. " + err.message);
  } finally {
    button.disabled = false;
    button.textContent = "Refresh";
  }
}

/* ---------- a small question ---------- */

/* Yes or no on a sheet, for the one action that spends many presses at once. */
function confirmSheet({ title, text, ok }) {
  return new Promise((resolve) => {
    $("#confirm-title").textContent = title;
    $("#confirm-text").textContent = text;
    $("#confirm-ok").textContent = ok;
    show($("#confirm"), true);
    $("#confirm-ok").focus();
    const done = (answer) => {
      show($("#confirm"), false);
      $("#confirm-ok").onclick = $("#confirm-cancel").onclick = $("#confirm").onclick = null;
      resolve(answer);
    };
    $("#confirm-ok").onclick = () => done(true);
    $("#confirm-cancel").onclick = () => done(false);
    $("#confirm").onclick = (ev) => { if (ev.target === $("#confirm")) done(false); };
  });
}

async function getShown() {
  const posts = chrome.gettable();
  if (!posts.length) return;
  if (posts.length > ASK_ABOVE) {
    const pause = state.meta.press_pause;
    const ok = await confirmSheet({
      title: `Queue ${posts.length.toLocaleString()} downloads?`,
      text: "They wait in the queue and the bot is asked for them one at a time"
        + (pause ? `, at least ${pause} seconds apart` : "") + ". Anything already on disk is left out.",
      ok: `Queue ${posts.length.toLocaleString()}`,
    });
    if (!ok) return;
  }
  await grabMany(posts);
  chrome.paintGetShown();
}

/* ---------- choosing ---------- */

/* A card chosen by click or key shows in Details; narrower than the dock's
 * breakpoint, the dock slides in to show it. */
function choose(id, scroll = false) {
  feed.setHere(id, scroll);
  showTab("detail");
  if (!dockFixed()) openDock("detail");
}

function focused() {
  const post_ = feed.focused();
  if (!post_) { toast("No recommendation chosen — press j first"); return null; }
  return post_;
}

function bookmarkFocused() {
  const post_ = focused();
  if (!post_) return;
  const on = !state.saved.has(post_.id);
  setSaved(post_.id, on);
  toast(on ? "Bookmarked" : "Bookmark removed");
}

/* ---------- events ---------- */

function bindControls() {
  $("#sync").onclick = sync;
  chrome.bindChannels(switchChannel);

  let typing = null;
  $("#search").addEventListener("input", (ev) => {
    const text = ev.target.value.trim().toLowerCase();
    clearTimeout(typing);
    typing = setTimeout(() => { state.filters.q = text; feed.newQuery(); chrome.paintHead(); }, SEARCH_PAUSE);
  });

  $("#saved-only").onchange = (ev) => {
    state.filters.savedOnly = ev.target.checked;
    savePrefs();
    feed.applyFilter();
    chrome.paintHead();
  };
  // The segmented choices: where the files are, whether they are here, the order.
  for (const [box, key] of [["#source", "source"], ["#have", "have"], ["#sort", "sort"]]) {
    $(box).addEventListener("click", (ev) => {
      const chip = ev.target.closest("[data-value]");
      if (!chip || state.filters[key] === chip.dataset.value) return;
      state.filters[key] = chip.dataset.value;
      savePrefs();
      chrome.paintSegs();
      if (key === "sort") {
        chrome.paintRail();
        feed.redraw();
        window.scrollTo({ top: 0, behavior: "instant" });
      } else {
        feed.applyFilter();
      }
      chrome.paintHead();
    });
  }
  $("#reset").onclick = () => { chrome.resetFilters(); chrome.paintHead(); };
  $("#who-clear").onclick = () => chrome.setWho("");
  $("#get-shown").onclick = getShown;
  $("#alert-dismiss").onclick = clearAlarm;
  document.addEventListener("tmw:who", (ev) => chrome.setWho(ev.detail));
  document.addEventListener("tmw:job", (ev) => {
    const hit = state.index.find((p) => p.job === ev.detail);
    if (hit && chrome.gotoShare(hit.id)) showTab("detail");
    else toast("That one is not in this channel");
  });

  // The grid: a click on a card (not on one of its buttons) chooses it.
  $("#feed").addEventListener("click", (ev) => {
    const card = ev.target.closest(".card");
    if (!card || ev.target.closest("button, a") || !card.dataset.id) return;
    choose(card.dataset.id);
  });
  $("#feed").addEventListener("dblclick", (ev) => {
    if (ev.target.closest(".plate") && feed.focused()) $(".d-shot")?.click();
  });

  // The dock: its tabs, and (narrow) the buttons that bring it in.
  for (const button of $$(".dock-tab")) button.onclick = () => showTab(button.dataset.tab);
  $("#dock-close").onclick = closeDock;
  $("#dock-veil").onclick = closeDock;
  $("#marks-open").onclick = () => openDock("marks");
  $("#grabs-open").onclick = () => openDock("queue");
  $("#queue-open").onclick = () => openDock("queue");
  $("#grabs-clear").onclick = clearGrabs;

  bindFetch();
  $("#help-open").onclick = () => chrome.showHelp(true);
  $("#help-close").onclick = () => chrome.showHelp(false);
  $("#help").onclick = (ev) => { if (ev.target === $("#help")) chrome.showHelp(false); };

  $("#light-close").onclick = closeLightbox;
  $("#light").onclick = (ev) => { if (ev.target === $("#light")) closeLightbox(); };
  $("#light-prev").onclick = () => stepLightbox(-1);
  $("#light-next").onclick = () => stepLightbox(1);
}

function bindWindow() {
  let painting = false;
  window.addEventListener("scroll", () => {
    if (painting) return;
    painting = true;
    requestAnimationFrame(() => {
      feed.paint();
      chrome.markRail();
      painting = false;
    });
  }, { passive: true });

  // A resize changes how many columns fit; it is coalesced and keeps the
  // reader's place rather than dropping them back at the top.
  let resizing = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizing);
    resizing = setTimeout(() => {
      sizeBar();
      feed.relayout();
      chrome.markRail();
    }, 120);
  });
  // Wide, the dock is part of the page; narrower, it is a panel that comes and goes.
  const wide = matchMedia("(min-width: 1500px)");
  const sync_ = () => {
    document.body.classList.toggle("dock-fixed", wide.matches);
    if (wide.matches) closeDock();
  };
  wide.addEventListener("change", () => { sync_(); sizeBar(); feed.relayout(); });
  sync_();
}

function bindKeys() {
  document.addEventListener("keydown", (ev) => {
    const inField = ev.target && ev.target.matches && ev.target.matches("input, select, textarea");
    if (inField) {
      if (ev.key === "Escape") {
        if (ev.target.value) {
          ev.target.value = "";
          ev.target.dispatchEvent(new Event("input"));
        } else {
          ev.target.blur();
        }
      }
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (!$("#confirm").hidden) {
      if (ev.key === "Escape") $("#confirm-cancel").click();
      return;
    }

    if (ev.key === "Escape") {
      // One thing at a time, innermost first.
      if (isLightboxOpen()) closeLightbox();
      else if (chrome.helpOpen()) chrome.showHelp(false);
      else if (!$("#fetch").hidden) showFetch(false);
      else if (!dockFixed() && dockShown()) closeDock();
      return;
    }
    if (isLightboxOpen()) {
      if (ev.key === "ArrowLeft") { ev.preventDefault(); stepLightbox(-1); }
      if (ev.key === "ArrowRight") { ev.preventDefault(); stepLightbox(1); }
      return;
    }
    if (ev.key === "Enter" && ev.target.closest && ev.target.closest("button, a")) return;

    const onCard = () => { if (feed.focused()) showTab("detail"); };
    const keys = {
      "?": () => chrome.showHelp(!chrome.helpOpen()),
      "/": () => $("#search").focus(),
      j: () => { feed.step(1); onCard(); },
      k: () => { feed.step(-1); onCard(); },
      ArrowRight: () => { feed.step(1); onCard(); },
      ArrowLeft: () => { feed.step(-1); onCard(); },
      ArrowDown: () => { feed.stepRow(1); onCard(); },
      ArrowUp: () => { feed.stepRow(-1); onCard(); },
      Home: () => { if (feed.view.order.length) feed.setHere(feed.view.order[0]); },
      End: () => { if (feed.view.order.length) feed.setHere(feed.view.order[feed.view.order.length - 1]); },
      Enter: () => { const p = focused(); if (p) peek(p).then((claim) => { if (claim) feed.refreshJobs([p.job]); }); },
      d: () => { const p = focused(); if (p) grab(p, { force: false }); },
      c: () => { const p = focused(); if (p) copy(p.job, "Job id copied"); },
      b: bookmarkFocused,
      1: () => (dockFixed() ? showTab("detail") : openDock("detail")),
      2: () => (dockFixed() ? showTab("queue") : openDock("queue")),
      3: () => (dockFixed() ? showTab("marks") : openDock("marks")),
    };
    const act = keys[ev.key];
    if (!act) return;
    ev.preventDefault();
    act();
  });
}

/* ---------- boot ---------- */

/* Open at the newest: the top when newest comes first, else the bottom. Asserted
 * twice: the browser's own scroll restoration can land after the first attempt. */
function openAtTheEnd() {
  let touched = false;
  for (const event of ["wheel", "keydown", "pointerdown"]) {
    window.addEventListener(event, () => { touched = true; }, { once: true, passive: true });
  }
  const open = () => {
    sizeBar();
    if (state.filters.sort !== "old") { window.scrollTo({ top: 0, behavior: "instant" }); feed.paint(); return; }
    if (feed.view.rows.length) feed.scrollToRow(feed.view.rows.length - 1, "end");
  };
  requestAnimationFrame(() => requestAnimationFrame(open));
  setTimeout(() => { if (!touched) open(); }, 350);
}

async function start() {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  loadPrefs();
  $("#saved-only").checked = state.filters.savedOnly;

  // The feed reports what it holds; the bar, the rail and the dock listen.
  feed.onChange(chrome.paintHead);
  feed.onGrew(() => { chrome.paintChips(); chrome.paintRail(); chrome.markRail(); });
  feed.onHere(() => paintDetail());
  onDetail((ids) => {
    feed.refreshCards(ids);
    if (feed.focused() && ids.includes(feed.focused().id)) paintDetail();
  });
  onSaved((id, on) => {
    feed.markSaved(id, on);
    chrome.paintMarksCount();
    chrome.paintMarks();
    if (feed.focused() && feed.focused().id === id) paintDetail();
  });
  onGrabs((jobs) => {
    feed.refreshJobs(jobs);
    // A finished job is a job whose files are now on disk, which is a filter
    // and a count as much as a badge.
    chrome.paintHead();
    const here = feed.focused();
    if (here && jobs.includes(here.job)) paintDetail();
  });
  chrome.actions.showEverything = () => { state.scope.tail = false; reload(); };

  // A crawl only moves the coverage counts while it runs; the archive itself is
  // worth re-reading once, at the end.
  onFetchProgress(() => chrome.paintHead());
  onFetchDone(() => reload().catch((err) => alarm("Could not re-read the archive: " + err.message)));

  bindControls();
  bindWindow();
  bindKeys();
  chrome.paintSegs();
  showTab(currentTab());
  paintDetail();
  paintSheet();
  sizeBar();
  // Placeholder cards the size of real ones while the archive is read.
  feed.paint();

  try {
    await reload();
  } catch (err) {
    alarm("Could not read the archive: " + err.message);
    return;
  }
  sizeBar();
  openAtTheEnd();
  chrome.markRail();
  checkFetch();
  checkGrabs();
  learnNames();
  if (!state.index.length) feed.reachOut("older");
}

start();
