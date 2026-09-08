/* Reaching back, from the page.
 *
 * The CLI wants the reach decided before anything is on screen; but you find
 * out you want 2021 while you are reading 2023. So the same walk is asked for
 * here: pick how much, watch how far it has got, stop it when you have had
 * enough. The server runs it on its own thread and this only polls.
 *
 * The archive is only re-read when the crawl finishes -- the index is
 * megabytes, and a poll that reloaded it would cost more than the crawl. What
 * ticks up meanwhile is the coverage line, which the poll carries. */

import { $, $$, alarm, el, fmtDay, show, sizeBar, toast } from "./dom.js";
import { getFetch, post } from "./net.js";
import { state } from "./store.js";

const POLL_MS = 1500;

/* How much to read, offered as a few sensible sizes rather than a free-text
 * box: the units are message counts and dates, and the useful answers are a
 * screenful more, a year, or the lot. */
const AMOUNTS = [
  { spec: "1000", label: "1,000" },
  { spec: "5000", label: "5,000" },
  { spec: "20000", label: "20,000" },
  { spec: "1y", label: "1 year" },
  { spec: "all", label: "Everything" },
];
const DEFAULT_SPEC = "5000";

let want = { spec: DEFAULT_SPEC, dir: "older" };
let timer = null;

const progressHooks = [];
const finishHooks = [];
/* The bar's counts and the archive itself belong to other modules; this one
 * only says when they are worth repainting. */
export const onFetchProgress = (fn) => progressHooks.push(fn);
export const onFetchDone = (fn) => finishHooks.push(fn);

/* ---------- polling ---------- */

function adoptStatus(data) {
  const job = data.fetch;
  const was = state.job.active;
  state.job = job || { active: false, fetched: 0, added: 0, edge: null, error: "" };
  if (data.coverage) state.meta.coverage = data.coverage;
  paintJobRow();
  paintSheet();
  for (const hook of progressHooks) hook(state.job);

  if (was && !state.job.active) {
    stopPolling();
    const { added, stopped, error, done } = state.job;
    if (error) alarm("The crawl stopped: " + error);
    else if (stopped) toast(`Stopped — ${added.toLocaleString()} new message(s) kept`);
    else if (done) toast(`Read to the end — ${added.toLocaleString()} new message(s)`);
    else toast(`${added.toLocaleString()} new message(s)`);
    // Only now is the archive worth re-reading.
    for (const hook of finishHooks) hook(state.job);
  }
  return state.job;
}

function startPolling() {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      adoptStatus(await getFetch());
    } catch (err) {
      stopPolling();
      alarm("Lost track of the crawl: " + err.message);
    }
  }, POLL_MS);
}

function stopPolling() {
  clearInterval(timer);
  timer = null;
}

/* Called on arrival and after a channel switch: a crawl started before this
 * page loaded is still running, and the page should say so. */
export async function checkFetch() {
  stopPolling();
  state.job = { active: false, fetched: 0, added: 0, edge: null, error: "" };
  try {
    const job = adoptStatus(await getFetch());
    if (job.active) startPolling();
  } catch (err) {
    // A status we cannot read is not worth an alert bar on the way in.
    paintJobRow();
  }
}

/* ---------- acting ---------- */

export async function startFetch() {
  try {
    const data = await post("/api/fetch", { spec: want.spec, dir: want.dir });
    adoptStatus(data);
    if (data.already) toast("Already reading this channel");
    startPolling();
    showFetch(false);
  } catch (err) {
    alarm("Could not start reading: " + err.message);
  }
}

export async function stopFetch() {
  try {
    adoptStatus(await post("/api/fetch/stop"));
  } catch (err) {
    alarm("Could not stop the crawl: " + err.message);
  }
}

/* ---------- the bar row ---------- */

function jobLine() {
  const job = state.job;
  const way = job.dir === "newer" ? "newer" : "earlier";
  const read = (job.fetched || 0).toLocaleString();
  const edge = job.edge ? ` · back to ${fmtDay(job.edge)}` : "";
  return `Reading ${way} messages — ${read} read${job.dir === "newer" ? "" : edge}`;
}

export function paintJobRow() {
  const row = $("#job");
  if (!row) return;
  show(row, state.job.active);
  if (state.job.active) $("#job-text").textContent = jobLine();
  sizeBar();
}

/* ---------- the sheet ---------- */

function paintAmounts() {
  const box = $("#fetch-amount");
  box.textContent = "";
  for (const amount of AMOUNTS) {
    box.appendChild(el("button", {
      class: "chip",
      "aria-pressed": want.spec === amount.spec ? "true" : "false",
      text: amount.label,
      onclick: () => { want.spec = amount.spec; paintAmounts(); paintSheet(); },
    }));
  }
}

function coverageLine() {
  const cover = state.meta.coverage || {};
  if (!cover.messages) return "Nothing cached for this channel yet.";
  return `${cover.messages.toLocaleString()} messages cached, ` +
         `${fmtDay(cover.oldest_at)} to ${fmtDay(cover.newest_at)}.`;
}

function noteLine() {
  if (state.meta.offline) return "This run is offline: start it without --offline to read more.";
  const cover = state.meta.coverage || {};
  if (want.dir === "older" && cover.complete) {
    return "This channel is already read to its beginning — there is nothing earlier to fetch.";
  }
  if (want.dir === "newer") return "Reads forward from the newest message held. Refresh does the same, unbounded.";
  if (want.spec === "all") return "Reads to the beginning of the channel. Hundreds of requests; safe to stop and resume.";
  return "Stops when it has read that much, or when the channel runs out. Resumes where it stopped.";
}

export function paintSheet() {
  if ($("#fetch").hidden) return;
  $("#fetch-coverage").textContent = coverageLine();
  $("#fetch-note").textContent = noteLine();
  for (const button of $$("#fetch-dir .chip")) {
    button.setAttribute("aria-pressed", button.dataset.dir === want.dir ? "true" : "false");
  }
  const cover = state.meta.coverage || {};
  // Nothing to ask for: this run cannot reach Discord, or the walk backwards
  // has already touched the first message in the channel.
  const pointless = state.meta.offline || (want.dir === "older" && !!cover.complete);
  $("#fetch-start").disabled = state.job.active || pointless;
  show($("#fetch-start"), !state.job.active);
  show($("#fetch-stop"), state.job.active);
  $("#fetch-progress").textContent = state.job.active ? jobLine() : "";
}

export function showFetch(on) {
  show($("#fetch"), on);
  if (on) { paintAmounts(); paintSheet(); }
}

export const fetchOpen = () => !$("#fetch").hidden;

export function bindFetch() {
  $("#fetch-open").onclick = () => showFetch(!fetchOpen());
  $("#fetch-close").onclick = () => showFetch(false);
  $("#fetch").onclick = (ev) => { if (ev.target === $("#fetch")) showFetch(false); };
  $("#fetch-start").onclick = startFetch;
  $("#fetch-stop").onclick = stopFetch;
  $("#job-stop").onclick = stopFetch;
  for (const button of $$("#fetch-dir .chip")) {
    button.onclick = () => { want.dir = button.dataset.dir; paintSheet(); };
  }
}
