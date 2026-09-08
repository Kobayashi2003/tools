/* The wiring: what the controls do, and what happens on the way in.
 *
 * Every module below this one points downwards -- the feed does not know about
 * the bar, the bar does not know how to reload a channel -- so this file is the
 * only place that knows about all of them. */

import { $, alarm, clearAlarm, copy, show, sizeBar, toast } from "./dom.js";
import * as chrome from "./chrome.js";
import * as feed from "./feed.js";
import { onDetail, onSaved, setSaved } from "./detail.js";
import { bindFetch, checkFetch, onFetchDone, onFetchProgress, showFetch } from "./fetch.js";
import { bindGrabs, checkGrabs, grab, onGrabs, peek, showGrabs } from "./grabs.js";
import { closeLightbox, isLightboxOpen, stepLightbox } from "./lightbox.js";
import { getIndex, post } from "./net.js";
import { indexPost, loadPrefs, rememberChannel, savePrefs, state } from "./store.js";

const SEARCH_PAUSE = 130;   // ms after the last keystroke before the list moves
const BOOT_FADE = 260;

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
  chrome.paintSource();
  chrome.paintRail();
  feed.resetView();
  feed.redraw();
  if (state.meta.error) alarm(state.meta.error);
}

const reload = async () => adopt(await getIndex());

function bootAway() {
  const boot = $("#boot");
  boot.classList.add("gone");
  setTimeout(() => show(boot, false), BOOT_FADE);
}

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
    const data = await post("/api/names");
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
  clearAlarm();
  const boot = $("#boot");
  boot.classList.remove("gone");
  show(boot, true);
  try {
    await reload();
  } catch (err) {
    alarm("Could not open that channel. " + err.message);
  }
  bootAway();
  window.scrollTo({ top: 0, behavior: "instant" });
  // A crawl belongs to a channel, so the page asks again about the new one.
  checkFetch();
  learnNames();
  if (!state.index.length) feed.reachOut("older");
}

async function sync() {
  const button = $("#sync");
  button.disabled = true;
  button.textContent = "Syncing";
  try {
    const data = await post("/api/sync");
    adopt(data);
    const added = (data.synced || {}).added || 0;
    toast(added ? `${added} new message${added > 1 ? "s" : ""}` : "Nothing new");
  } catch (err) {
    // The alert bar, not a toast: a refusal names a cause worth reading twice,
    // and two seconds is not long enough to read it once.
    alarm("Sync failed. " + err.message);
  } finally {
    button.disabled = false;
    button.textContent = "Refresh";
  }
}

/* ---------- the keyboard actions ---------- */

function focused() {
  const post_ = feed.focused();
  if (!post_) { toast("No recommendation selected — press j first"); return null; }
  return post_;
}

function grabFocused() {
  const post_ = focused();
  if (post_) grab(post_);
}

function peekFocused() {
  const post_ = focused();
  if (post_) peek(post_).then((claim) => {
    if (claim) feed.refreshJobs([post_.job]);
  });
}

function copyFocused() {
  const post_ = focused();
  if (post_) copy(post_.job, "Job id copied");
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
  $("#channel-pick").onchange = (ev) => switchChannel(ev.target.value);

  let typing = null;
  $("#search").addEventListener("input", (ev) => {
    const text = ev.target.value.trim().toLowerCase();
    clearTimeout(typing);
    typing = setTimeout(() => { state.filters.q = text; feed.newQuery(); }, SEARCH_PAUSE);
  });

  $("#saved-only").onchange = (ev) => {
    state.filters.savedOnly = ev.target.checked;
    savePrefs();
    feed.applyFilter();
  };
  $("#missing-only").onchange = (ev) => {
    state.filters.missingOnly = ev.target.checked;
    savePrefs();
    feed.applyFilter();
  };
  $("#descending").onchange = (ev) => {
    state.filters.desc = ev.target.checked;
    savePrefs();
    chrome.paintRail();
    feed.redraw();
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  for (const chip of document.querySelectorAll("#source .chip")) {
    chip.onclick = () => {
      state.filters.source = chip.dataset.source;
      savePrefs();
      chrome.paintSource();
      feed.applyFilter();
    };
  }
  $("#reset").onclick = chrome.resetFilters;
  $("#alert-dismiss").onclick = clearAlarm;

  $("#marks-open").onclick = () => chrome.showMarks(!chrome.marksOpen());
  $("#marks-close").onclick = () => chrome.showMarks(false);
  $("#marks").onclick = (ev) => { if (ev.target === $("#marks")) chrome.showMarks(false); };
  bindFetch();
  bindGrabs();
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

  // A resize changes every estimate and fires in a burst while a window is
  // dragged, so it is coalesced and keeps the reader's place rather than
  // dropping them back at the top.
  let resizing = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizing);
    resizing = setTimeout(() => {
      sizeBar();
      feed.relayout();
      chrome.markRail();
    }, 120);
  });
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

    if (ev.key === "Escape") {
      chrome.showHelp(false);
      chrome.showMarks(false);
      showFetch(false);
      showGrabs(false);
      closeLightbox();
      return;
    }
    if (isLightboxOpen()) {
      if (ev.key === "ArrowLeft") { ev.preventDefault(); stepLightbox(-1); return; }
      if (ev.key === "ArrowRight") { ev.preventDefault(); stepLightbox(1); return; }
    }

    const keys = {
      "?": () => chrome.showHelp(!chrome.helpOpen()),
      "/": () => $("#search").focus(),
      j: () => feed.step(1),
      k: () => feed.step(-1),
      Home: () => { if (feed.view.rows.length) feed.scrollToRow(0); },
      End: () => { if (feed.view.rows.length) feed.scrollToRow(feed.view.rows.length - 1, "end"); },
      Enter: () => peekFocused(),
      d: grabFocused,
      c: () => copyFocused(),
      b: bookmarkFocused,
    };
    const act = keys[ev.key];
    if (!act) return;
    ev.preventDefault();
    act();
  });
}

/* ---------- boot ---------- */

/* Open at the mark. Asserted twice: on a document this tall the browser's own
 * scroll restoration can land after the first attempt and undo it. The second
 * pass is skipped the moment the reader touches anything. */
function openAtTheEnd() {
  let touched = false;
  for (const event of ["wheel", "keydown", "pointerdown"]) {
    window.addEventListener(event, () => { touched = true; }, { once: true, passive: true });
  }
  const open = () => {
    sizeBar();
    // Newest is the bottom running forwards and the top running backwards.
    if (state.filters.desc) { window.scrollTo({ top: 0, behavior: "instant" }); return; }
    if (feed.view.rows.length) feed.scrollToRow(feed.view.rows.length - 1, "end");
  };
  requestAnimationFrame(() => requestAnimationFrame(open));
  setTimeout(() => { if (!touched) open(); }, 350);
}

async function start() {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  loadPrefs();
  $("#descending").checked = state.filters.desc;
  $("#saved-only").checked = state.filters.savedOnly;
  $("#missing-only").checked = state.filters.missingOnly;

  // The feed reports what it holds; the bar and the rail listen.
  feed.onChange(chrome.paintHead);
  feed.onGrew(() => { chrome.paintChips(); chrome.paintRail(); chrome.markRail(); });
  onDetail((ids) => feed.refreshCards(ids));
  onSaved((id, on) => {
    feed.markSaved(id, on);
    chrome.paintMarksButton();
    if (chrome.marksOpen()) chrome.paintMarks();
  });
  onGrabs((jobs) => {
    feed.refreshJobs(jobs);
    // A finished job is a job whose files are now on disk, which is a filter
    // and a count as much as a badge.
    chrome.paintHead();
  });
  chrome.actions.showEverything = () => { state.scope.tail = false; reload(); };

  // A crawl only moves the coverage counts while it runs; the archive itself is
  // worth re-reading once, at the end.
  onFetchProgress(() => chrome.paintHead());
  onFetchDone(() => reload().catch((err) => alarm("Could not re-read the archive: " + err.message)));

  bindControls();
  bindWindow();
  bindKeys();
  chrome.paintSource();

  try {
    await reload();
  } catch (err) {
    $("#boot").textContent = "Could not read the archive: " + err.message;
    return;
  }
  bootAway();
  sizeBar();
  openAtTheEnd();
  chrome.markRail();
  checkFetch();
  checkGrabs();
  learnNames();
  if (!state.index.length) feed.reachOut("older");
}

start();
