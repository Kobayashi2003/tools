/* The download queue, from the page's side.
 *
 * Pressing Get does not download anything by itself: it puts the job in a queue
 * on the server, which presses the recommendation's button when it reaches it.
 * That indirection is the whole point -- a claim is one-time and expires in
 * about ten minutes, so twenty claims taken at once would be nineteen wasted.
 *
 * So this asks, then watches. It polls while anything is moving and stops when
 * nothing is, and it tells the cards what changed rather than redrawing the
 * feed itself. */

import { $, alarm, copy, el, show, sizeBar, toast } from "./dom.js";
import { get, post } from "./net.js";
import { state } from "./store.js";

const POLL_MS = 900;
let timer = null;

const changeHooks = [];
/* The cards and the bar listen; this module knows what the queue is doing and
 * nothing about what is on screen. */
export const onGrabs = (fn) => changeHooks.push(fn);
const announce = (jobs) => { for (const hook of changeHooks) hook(jobs); };

/* ---------- polling ---------- */

/* A job that finished put files on disk, and the card should say so at once.
 *
 * The index carries `taken` and `held`, but only when it is fetched -- so
 * without this the card went blank the moment a download finished: the word
 * "downloading" stopped applying, and the tick that replaces it lives in state
 * the poll never touched. It came back on the next reload, which is exactly the
 * moment you should not have to ask for.
 *
 * The server has already recorded this; mirroring it is what makes the mark
 * appear as the last byte lands rather than afterwards. */
function landed(task) {
  if (task.state !== "done") return;
  const got = (task.files || []).filter((f) => f.state === "done" || f.state === "held");
  // A job that answered with nothing but a link has nothing on disk to claim.
  if (!got.length) return;
  state.taken.add(task.job);
  state.held.set(task.job, { dir: task.folder, n: got.length });
}

function adopt(data) {
  const before = state.jobState;
  state.grabs = data || { tasks: [], active: 0, queued: 0, failed: 0 };
  const now = new Map();
  for (const task of state.grabs.tasks || []) {
    now.set(task.job, task.state);
    landed(task);
  }
  state.jobState = now;

  // Only the jobs whose word changed are worth telling anyone about: a poll
  // every second that redrew every visible card would be the page's whole cost.
  const moved = [];
  for (const [job, word] of now) if (before.get(job) !== word) moved.push(job);
  for (const job of before.keys()) if (!now.has(job)) moved.push(job);

  paintQueueRow();
  paintSheet();
  if (moved.length) announce(moved);
  if (state.grabs.error && !state.grabs.active) alarm(state.grabs.error);
  return state.grabs;
}

function startPolling() {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      const data = await adopt(await get("/api/grabs"));
      if (!data.active && !data.queued) stopPolling();
    } catch (err) {
      stopPolling();
      alarm("Lost track of the downloads: " + err.message);
    }
  }, POLL_MS);
}

function stopPolling() {
  clearInterval(timer);
  timer = null;
}

/* A queue outlives the tab it was started from, so the page asks on arrival
 * what is already running rather than assuming nothing is. */
export async function checkGrabs() {
  try {
    const data = adopt(await get("/api/grabs"));
    if (data.active || data.queued) startPolling();
  } catch (err) {
    paintQueueRow();
  }
}

/* ---------- acting ---------- */

export async function grab(post_, { force = false } = {}) {
  try {
    const data = await post("/api/grab", { id: post_.id, force });
    adopt(data.grabs);
    startPolling();
    const task = data.task || {};
    const name = task.title || post_.title || post_.job;
    // A job the server finished on the spot never went near the bot: say that
    // rather than "already done", which reads as though something was skipped.
    toast(task.note === "already on disk" ? `${name} is already on disk`
      : task.state === "queued" ? `Queued ${name}`
      : `${name} is already ${task.state}`);
    return task;
  } catch (err) {
    alarm("Could not queue that one: " + err.message);
    return null;
  }
}

/* Press the button and say what is behind it, without fetching. The claim
 * stays live on the server, so a Get straight afterwards costs no second
 * press -- which matters, because presses are rate-limited and counted. */
export async function peek(post_) {
  try {
    const data = await post("/api/peek", { id: post_.id });
    const claim = data.claim || {};
    state.claims.set(post_.job, claim);
    announce([post_.job]);
    return claim;
  } catch (err) {
    alarm("The bot did not open that one: " + err.message);
    return null;
  }
}

export async function cancelGrab(job) {
  try { adopt(await post("/api/grab/cancel", { job })); }
  catch (err) { alarm("Could not stop it: " + err.message); }
}

export async function retryGrab(job) {
  try {
    adopt(await post("/api/grab/retry", { job }));
    startPolling();
  } catch (err) { alarm("Could not start it again: " + err.message); }
}

export async function clearGrabs() {
  try { adopt(await post("/api/grabs/clear")); }
  catch (err) { alarm("Could not clear the list: " + err.message); }
}

export async function reveal(job) {
  try {
    await post("/api/reveal", { job });
  } catch (err) {
    alarm("Could not open the folder: " + err.message);
  }
}

/* ---------- the bar row ---------- */

export function paintQueueRow() {
  const row = $("#queue");
  if (!row) return;
  const { active, queued, failed } = state.grabs;
  const busy = (state.grabs.tasks || []).find((t) =>
    t.state === "working" || t.state === "opening");
  const on = !!(active || queued || failed);
  show(row, on);
  if (on) {
    const bits = [];
    if (busy) {
      bits.push(busy.state === "opening"
        ? `Asking the bot for ${busy.title || busy.job}…`
        : `${busy.title || busy.job} — ${busy.pct}% of ${busy.size_human || "?"}`);
    }
    if (queued) bits.push(`${queued} waiting`);
    if (failed) bits.push(`${failed} failed`);
    $("#queue-text").textContent = bits.join("  ·  ") || "Downloading…";
  }
  const count = $("#grabs-count");
  if (count) {
    count.textContent = active + queued ? String(active + queued) : String(
      (state.grabs.tasks || []).length);
    $("#grabs-open").dataset.any = active + queued ? "1" : "0";
  }
  sizeBar();
}

/* ---------- the sheet ---------- */

const WORDS = {
  queued: "waiting", opening: "asking the bot", working: "downloading",
  done: "done", failed: "failed", cancelled: "stopped",
};

function fileRow(file) {
  return el("div", { class: "f grab-f " + file.state }, [
    el("span", { class: "nm", text: file.name, title: file.path || file.name }),
    el("span", { class: "sz", text: file.size_human }),
    el("span", { class: "st", text: file.state === "held" ? "on disk" : WORDS[file.state] || file.state }),
    file.error ? el("span", { class: "why", text: file.error }) : null,
  ]);
}

function taskRow(task) {
  const head = el("div", { class: "grab-head" }, [
    el("span", { class: "t", text: task.title || task.job }),
    el("span", { class: "st", text: WORDS[task.state] || task.state }),
    task.size ? el("span", { class: "sz", text: `${task.got ? task.pct + "% of " : ""}${task.size_human}` }) : null,
  ]);

  const tools = el("div", { class: "grab-tools" }, [
    task.state === "queued" || task.state === "working" || task.state === "opening"
      ? el("button", { class: "quiet-btn", text: "stop", onclick: () => cancelGrab(task.job) })
      : null,
    task.state === "failed" || task.state === "cancelled"
      ? el("button", { class: "quiet-btn", text: "try again", onclick: () => retryGrab(task.job) })
      : null,
    task.folder && task.files.length
      ? el("button", { class: "quiet-btn", text: "open folder", onclick: () => reveal(task.job) })
      : null,
    ...(task.links || []).map((url) => el("a", {
      class: "quiet-btn", href: url, target: "_blank", rel: "noreferrer", text: "open link",
    })),
    (task.links || []).length
      ? el("button", {
          class: "quiet-btn", text: "copy link",
          onclick: () => copy(task.links.join("\n"), "Link copied"),
        })
      : null,
  ]);

  return el("div", { class: "grab " + task.state }, [
    head,
    task.size ? el("div", { class: "meter" }, [
      el("span", { style: `width:${Math.max(2, task.pct)}%` }),
    ]) : null,
    task.error ? el("div", { class: "why", text: task.error }) : null,
    // An external job has no files of ours to list; what it has is a link, and
    // the note is what the bot said about it.
    !task.files.length && task.note
      ? el("div", { class: "note-text", text: task.note })
      : null,
    ...task.files.map(fileRow),
    tools,
  ]);
}

export function paintSheet() {
  if ($("#grabs").hidden) return;
  const box = $("#grabs-list");
  box.textContent = "";
  const tasks = state.grabs.tasks || [];
  if (!tasks.length) {
    box.appendChild(el("div", {
      class: "sheet-empty",
      text: "Nothing queued. Press Get on a card, or d on the one under the cursor.",
    }));
  } else {
    for (const task of tasks) box.appendChild(taskRow(task));
  }
  const { active, queued, failed } = state.grabs;
  $("#grabs-note").textContent = [
    active ? `${active} in flight` : "",
    queued ? `${queued} waiting` : "",
    failed ? `${failed} failed` : "",
  ].filter(Boolean).join("  ·  ");
}

export function showGrabs(on) {
  show($("#grabs"), on);
  if (on) { paintSheet(); checkGrabs(); }
}

export const grabsOpen = () => !$("#grabs").hidden;

export function bindGrabs() {
  $("#grabs-open").onclick = () => showGrabs(!grabsOpen());
  $("#grabs-close").onclick = () => showGrabs(false);
  $("#grabs").onclick = (ev) => { if (ev.target === $("#grabs")) showGrabs(false); };
  $("#grabs-clear").onclick = clearGrabs;
  $("#queue-open").onclick = () => showGrabs(true);
}
