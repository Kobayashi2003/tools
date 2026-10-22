"use strict";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const store = {
  get(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  },
};

const SITE = "https://n.novelia.cc";
const ENGINES = ["sakura", "gpt", "youdao", "baidu"];
const EDITIONS = { japanese: "Japanese original", bilingual: "Bilingual", chinese: "Chinese" };
const MODE_LABELS = { "jp-original": "Japanese original", "jp-zh": "Bilingual", "zh-jp": "Bilingual", zh: "Chinese", "zh-original": "Chinese upload" };
// Library counts of volumes per edition: [field, badge, description].
const EDITION_COUNTS = [
  ["ja_count", "JA", "Volumes with a Japanese edition"],
  ["bilingual_count", "BI", "Volumes with a bilingual file"],
  ["zh_count", "ZH", "Volumes with a Chinese edition"],
];
const KINDS = {
  full: "Full collection",
  range: "Catalog pages",
  incremental: "Update sweep",
  manual: "Specific works",
  convert: "Japanese conversion",
};
const STATUSES = {
  completed: ["Completed", "ok"],
  completed_with_errors: ["Completed with errors", "warn"],
  interrupted: ["Interrupted", "warn"],
  cancelled: ["Cancelled", "warn"],
  running: ["Running", "live"],
  queued: ["Queued", "live"],
  paused: ["Paused", "warn"],
  failed: ["Failed", "error"],
};
const PACING_PRESETS = {
  gentle: { request_delay: 3, request_jitter: 40, adaptive_delay: true, max_delay: 60, rest_every: 20, rest_seconds: 180, backoff_base: 15, backoff_max: 900 },
  standard: { request_delay: 1, request_jitter: 30, adaptive_delay: true, max_delay: 30, rest_every: 0, rest_seconds: 120, backoff_base: 5, backoff_max: 300 },
  fast: { request_delay: 0.5, request_jitter: 20, adaptive_delay: true, max_delay: 15, rest_every: 0, rest_seconds: 60, backoff_base: 3, backoff_max: 120 },
};
const TASK_FILTERS = {
  all: () => true,
  active: (j) => ["queued", "running"].includes(j.status),
  attention: (j) => ["failed", "interrupted", "cancelled", "completed_with_errors"].includes(j.status),
  done: (j) => j.status === "completed",
};

const state = {
  view: "library",
  categories: {},
  library: { page: 1, total: 0, pageSize: 48, items: [], filter: "", signature: "" },
  layout: store.get("layout", "grid"),
  selected: new Set(),
  catalog: { page: 1, pages: 0, items: [], loaded: false },
  catalogSelected: new Set(),
  taskFilter: "all",
  jobs: [],
  log: { id: null, after: 0 },
  order: { engines: [], editions: [] },
  titleLang: store.get("title-lang", "ja"),
  busy: false,
};

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const when = (value) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never";
const day = (value) => (value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—");
const size = (bytes) =>
  bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : `${Math.round(bytes / (1 << 20)).toLocaleString()} MB`;
const pct = (part, whole) => (whole ? Math.min(100, (part / whole) * 100) : 0);
const secondsUntil = (value) => (value ? Math.max(0, Math.round((new Date(value) - Date.now()) / 1000)) : 0);
const countdown = (value) => {
  const s = secondsUntil(value);
  return s >= 5400 ? `${(s / 3600).toFixed(1)} h` : s >= 90 ? `${Math.ceil(s / 60)} min` : `${s} s`;
};
// A queued task with resume_at was paused by a rate limit or active hours.
const jobStatus = (j) => (j.status === "queued" && j.resume_at ? "paused" : j.status);
const waiting = (j) => j.status === "running" && j.wait_until && secondsUntil(j.wait_until) > 0;
const workUrl = (key) => `${SITE}/${key.startsWith("wenku/") ? key : "novel/" + key}`;
// The title in the chosen language (Japanese when there is no Chinese one), and the other one.
function titles(ja, zh) {
  const [shown, other] = state.titleLang === "zh" && zh ? [zh, ja] : [ja, zh];
  return [shown, other && other !== shown ? other : ""];
}
const editionBadges = (w) =>
  EDITION_COUNTS.filter(([field]) => w[field]).map(([field, badge, hint]) => `<span class="pill ok" title="${hint}">${badge} ${w[field]}</span>`).join("");

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 404 && payload.detail === "Not Found" &&
        (url.startsWith("/api/library/") || url === "/api/storage")) {
      throw new Error("The running server is outdated. Restart it with stop.ps1 and start.ps1, then refresh this page.");
    }
    const detail = Array.isArray(payload.detail) ? payload.detail.map((d) => d.msg).join("; ") : payload.detail;
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return payload;
}

let toastTimer;
let toastSequence = 0;
function toast(message, error = false) {
  const sequence = ++toastSequence;
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", error);
  el.hidden = false;
  if (el.showPopover) {
    if (el.matches(":popover-open")) el.hidePopover();
    el.showPopover();
  }
  UI.reveal(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(async () => {
    await UI.animate(el, [{ opacity: 1 }, { opacity: 0 }], 120);
    if (sequence === toastSequence) {
      el.hidePopover?.();
      el.hidden = true;
    }
  }, error ? 9000 : 3500);
}

const listRequests = new Map();
async function latestList(name, url, root, feedback = true) {
  listRequests.get(name)?.controller.abort();
  const request = { controller: new AbortController() };
  listRequests.set(name, request);
  const finish = feedback ? UI.loading(root) : () => {};
  try {
    const result = await api(url, { signal: request.controller.signal });
    return listRequests.get(name) === request ? result : null;
  } catch (error) {
    if (error.name === "AbortError" || listRequests.get(name) !== request) return null;
    throw error;
  } finally {
    if (listRequests.get(name) === request) {
      listRequests.delete(name);
    }
    finish();
  }
}

let settingsBaseline = "";
let settingsLoaded = false;
let settingsSaving = false;
function settingsSnapshot() {
  return JSON.stringify([
    [...$("#settings-form").elements].filter(input => input.name).map(input => [input.name, input.type === "checkbox" ? input.checked : input.value]),
    state.order,
  ]);
}
function updateSettingsFeedback() {
  const dirty = settingsLoaded && settingsSnapshot() !== settingsBaseline;
  $("#settings-form").dataset.dirty = dirty;
  $("#settings-feedback").textContent = settingsSaving ? "Saving changes…" : dirty ? "Unsaved changes" : "All changes saved";
  $("#save-settings").disabled = !dirty || settingsSaving;
  $("#discard-settings").disabled = !dirty || settingsSaving;
  const form = $("#settings-form");
  $$("[data-preset]").forEach((button) => {
    const matches = Object.entries(PACING_PRESETS[button.dataset.preset]).every(([name, value]) => {
      const input = form.elements.namedItem(name);
      return input.type === "checkbox" ? input.checked === value : Number(input.value) === value;
    });
    button.setAttribute("aria-pressed", matches);
  });
}

// The page CSP forbids inline style attributes, so widths are applied through the CSSOM.
function applyWidths(root = document) {
  $$("[data-w]", root).forEach((el) => (el.style.width = `${el.dataset.w}%`));
}

function safeImage(url) {
  try {
    const u = new URL(url);
    return ["https:", "http:"].includes(u.protocol) ? u.href : "";
  } catch {
    return "";
  }
}

function cover(url, title) {
  const src = safeImage(url);
  return `<div class="cover-frame">${
    src
      ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<span class="cover-blank">${esc(title)}</span>`
  }</div>`;
}

function pill(status) {
  const [label, tone] = STATUSES[status] || [status, ""];
  return `<span class="pill ${tone}">${esc(label)}</span>`;
}

function collectionName(work) {
  return work.kind === "web" ? "Web novel" : state.categories[work.category] || "Library novel";
}

/* Library */

function libraryCard(w) {
  const picked = state.selected.has(w.key);
  const [title, other] = titles(w.title, w.title_zh);
  return `<article class="book${picked ? " picked" : ""}">
    <label class="pick"><input type="checkbox" data-key="${esc(w.key)}" aria-label="Select ${esc(title)}" ${picked ? "checked" : ""}></label>
    <button class="book-open" data-work="${esc(w.key)}">
      ${cover(w.cover, title)}
      <h3 title="${esc([title, other].filter(Boolean).join("\n"))}">${esc(title)}</h3>
      <p class="by">${esc(w.authors.join(", ") || other || w.key)}</p>
      <span class="meter" aria-hidden="true"><span data-w="${pct(w.file_count, w.volume_count)}"></span></span>
      <span class="count"><span>${w.file_count} / ${w.volume_count} saved</span><span class="ribbon-inline">${editionBadges(w)}</span></span>
    </button>
  </article>`;
}

function libraryRow(w) {
  const picked = state.selected.has(w.key);
  const src = safeImage(w.cover);
  const [title, other] = titles(w.title, w.title_zh);
  return `<tr>
    <td><input type="checkbox" data-key="${esc(w.key)}" aria-label="Select ${esc(title)}" ${picked ? "checked" : ""}></td>
    <td><div class="row-work">${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="thumb"></span>'}
      <div><button data-work="${esc(w.key)}">${esc(title)}</button><small>${esc(w.authors.join(", ") || other || w.key)}</small></div></div></td>
    <td>${esc(collectionName(w))}</td>
    <td class="num">${w.file_count} / ${w.volume_count}</td>
    <td><span class="ribbon-inline">${editionBadges(w) || '<span class="pill">None</span>'}</span></td>
    <td class="num">${esc(day(w.checked_at))}</td>
  </tr>`;
}

async function loadLibrary(force = false) {
  const lib = state.library;
  const params = new URLSearchParams({
    page: lib.page,
    page_size: lib.pageSize,
    query: $("#library-query").value.trim(),
    sort: $("#library-sort").value === "title" && state.titleLang === "zh" ? "title_zh" : $("#library-sort").value,
    state: lib.filter,
  });
  if ($("#library-category").value) params.set("category", $("#library-category").value);
  const result = await latestList("library", "/api/works?" + params, $("#library-list"), force);
  if (!result) return;
  const signature = JSON.stringify([result, [...state.selected], state.layout, state.titleLang]);
  if (!force && signature === lib.signature) return;
  lib.signature = signature;
  lib.total = result.total;
  lib.items = result.items;
  const pages = Math.max(1, Math.ceil(result.total / lib.pageSize));
  if (lib.page > pages) {
    lib.page = pages;
    return loadLibrary(force);
  }
  $("#library-total").textContent = plural(result.total, "work");
  $("#library-page").textContent = `Page ${lib.page} of ${pages}`;
  $('[data-action="library-prev"]').disabled = lib.page <= 1;
  $('[data-action="library-next"]').disabled = lib.page >= pages;
  $$("[data-layout]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.layout === state.layout));

  const list = $("#library-list");
  if (!result.items.length) {
    const filtered = lib.filter || params.get("query") || params.get("category");
    list.innerHTML = filtered
      ? `<div class="empty"><h3>No works match</h3><p>Clear the search or choose another filter.</p></div>`
      : `<div class="empty"><h3>Your shelf is empty</h3><p>Download a page of the light novel catalog, or add a work by its Novelia URL.</p><button class="primary" data-action="open-crawl">New download</button></div>`;
  } else if (state.layout === "list") {
    const all = result.items.every((w) => state.selected.has(w.key));
    list.innerHTML = `<div class="table-wrap"><table><thead><tr>
      <th><input type="checkbox" id="select-page" aria-label="Select every work on this page" ${all ? "checked" : ""}></th>
      <th>Work</th><th>Collection</th><th>Saved</th><th>Editions</th><th>Checked</th></tr></thead>
      <tbody>${result.items.map(libraryRow).join("")}</tbody></table></div>`;
  } else {
    list.innerHTML = `<div class="books">${result.items.map(libraryCard).join("")}</div>`;
  }
  applyWidths(list);
  if (force) UI.reveal(list);
  selectionBar();
}

// The pager sits below the grid, so a new page starts from the top of the grid.
async function turnPage(load, selector) {
  await load();
  const list = $(selector);
  list.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  list.focus({ preventScroll: true });
}

function selectionBar() {
  const onCatalog = state.view === "catalog";
  const set = onCatalog ? state.catalogSelected : state.selected;
  const visible = (state.view === "library" || onCatalog) && set.size > 0;
  UI.show($("#selection-bar"), visible);
  $("#selection-count").textContent = `${plural(set.size, "work")} selected`;
  const page = onCatalog ? state.catalog.items.map(catalogKey) : state.library.items.map((w) => w.key);
  $("#select-page-button").hidden = page.every((key) => set.has(key));
  $("#convert-selected").hidden = onCatalog;
  $("#remove-selected").hidden = onCatalog;
  $("#library-list").classList.toggle("selecting", state.selected.size > 0);
  $("#catalog-list").classList.toggle("selecting", state.catalogSelected.size > 0);
}

/* Catalog */

const catalogKey = (w) => `wenku/${String(w.id).toLowerCase()}`;

function catalogCard(w) {
  const key = catalogKey(w);
  const picked = state.catalogSelected.has(key);
  const local = w.local
    ? `<span class="pill ${w.local.file_count >= w.local.volume_count && w.local.volume_count ? "ok" : ""}">In library ${w.local.file_count}/${w.local.volume_count}</span>`
    : "";
  const [title, other] = titles(w.title, w.titleZh);
  return `<article class="book${picked ? " picked" : ""}">
    <label class="pick"><input type="checkbox" data-catalog-key="${esc(key)}" aria-label="Select ${esc(title)}" ${picked ? "checked" : ""}></label>
    <button class="book-open" data-work="${esc(key)}" data-live="true">
      ${cover(w.cover, title)}
      <h3 title="${esc(title)}">${esc(title)}</h3>
      <p class="by" title="${esc(other)}">${esc(other)}</p>
    </button>
    <span class="count">${local || "<span></span>"}<a href="${SITE}/wenku/${esc(w.id)}" target="_blank" rel="noopener">Novelia ↗</a></span>
  </article>`;
}

function renderCatalog() {
  $("#catalog-list").innerHTML = state.catalog.items.length
    ? `<div class="books">${state.catalog.items.map(catalogCard).join("")}</div>`
    : '<div class="empty"><h3>No matching works</h3><p>Try another keyword or category.</p></div>';
}

async function loadCatalog() {
  const cat = state.catalog;
  $("#catalog-caption").textContent = "Loading the live catalog…";
  const params = new URLSearchParams({ page: cat.page, category: $("#catalog-category").value, query: $("#catalog-query").value.trim() });
  try {
    const result = await latestList("catalog", "/api/catalog?" + params, $("#catalog-list"));
    if (!result) return;
    cat.loaded = true;
    cat.pages = result.pageNumber;
    cat.items = result.items;
    const owned = result.items.filter((w) => w.local).length;
    $("#catalog-caption").textContent = result.items.length
      ? `${plural(result.items.length, "work")} on this page, ${owned} already in your library. Click a cover for its volumes and editions; tick its box or Ctrl-click to select, Shift-click to select a run.`
      : "";
    $("#catalog-page").value = cat.page;
    $("#catalog-page").max = Math.max(1, cat.pages);
    $("#catalog-pages").textContent = `of ${Math.max(1, cat.pages).toLocaleString()}`;
    $("#catalog-total").textContent = `${plural(cat.pages, "page")} at ${result.items.length || "—"} per page`;
    $('[data-action="catalog-prev"]').disabled = cat.page <= 1;
    $('[data-action="catalog-next"]').disabled = cat.page >= cat.pages;
    renderCatalog();
    UI.reveal($("#catalog-list"));
    selectionBar();
  } catch (error) {
    $("#catalog-caption").textContent = `The catalog could not be loaded: ${error.message}`;
  }
}

/* Tasks */

function taskScope(j) {
  const r = j.request;
  const scope =
    j.kind === "range"
      ? `Pages ${r.start_page}–${r.end_page} of ${state.categories[r.category] || "catalog"}${r.query ? `, “${r.query}”` : ""}`
      : j.kind === "manual"
        ? plural(r.keys.length, "work")
        : j.kind === "convert"
          ? r.keys.length ? `Volumes of ${plural(r.keys.length, "work")}` : r.file_ids.length ? plural(r.file_ids.length, "volume") : "Every bilingual volume"
          : "Light novel collection";
  const extras = [
    r.volumes && `volumes ${r.volumes}`,
    r.editions?.length && r.editions.map((e) => EDITIONS[e]).join(", "),
    r.download === false && j.kind !== "convert" && "metadata only",
    r.force && "re-download",
    r.restore && "restoring deleted files",
  ];
  return [scope, ...extras.filter(Boolean)].join(", ");
}

function taskNote(j) {
  if (jobStatus(j) === "paused") return `${j.wait_reason || "Paused."} Resumes ${when(j.resume_at)} (in ${countdown(j.resume_at)}).`;
  if (waiting(j)) return `${j.wait_reason}: ${countdown(j.wait_until)} left.`;
  return "";
}

function taskActions(j) {
  const status = jobStatus(j);
  const remove = `<button class="ghost" data-delete="${j.id}" title="Remove from the list" aria-label="Remove task ${j.id}">✕</button>`;
  const armed = state.cancelArmed === j.id;
  const cancel = j.cancel_requested
    ? '<button class="danger" disabled>Stopping…</button>'
    : `<button class="danger" data-cancel="${j.id}" data-confirmed="${armed}" title="${armed ? "Click again to stop the task" : "Stop the task; Resume continues where it stopped"}">${armed ? "Confirm cancel" : "Cancel"}</button>`;
  // A running task picks retried items up next, so failures can be retried at any time.
  const retry = j.failed
    ? `<button data-retry="${j.id}" title="Put failed items back in the queue">Retry ${j.failed} failed</button>`
    : "";
  if (status === "paused") return `<button data-resume="${j.id}">Start now</button>${retry}${cancel}`;
  if (["queued", "running"].includes(status)) return `${retry}${cancel}`;
  if (status === "completed_with_errors") return `${retry}${remove}`;
  if (status !== "completed") return `<button data-resume="${j.id}">Resume</button>${remove}`;
  return remove;
}

function taskCard(j) {
  const status = jobStatus(j);
  const [, tone] = STATUSES[status] || ["", ""];
  const discovering = !j.listing_done && ["full", "range", "incremental"].includes(j.kind) && j.status === "running";
  const progress = discovering
    ? `Reading catalog page ${j.cursor}${j.page_count ? ` of ${j.page_count}` : ""}`
    : j.total ? `${j.done} of ${j.total} done${j.failed ? `, ${j.failed} failed` : ""}`
      : ["running", "queued"].includes(j.status) ? "Waiting to start" : "No items processed";
  const note = taskNote(j);
  return `<article class="task" data-job-id="${j.id}" data-tone="${tone}">
    <div>
      <h3><span class="id">#${j.id}</span>${esc(KINDS[j.kind])} ${pill(status)}${j.scheduled ? '<span class="pill">Scheduled</span>' : ""}</h3>
      <p class="meta">${esc(taskScope(j))}. Created ${esc(when(j.created_at))}${j.finished_at ? `, finished ${esc(when(j.finished_at))}` : ""}.</p>
      ${note ? `<p class="note-text">${esc(note)}</p>` : j.error ? `<p class="error-text">${esc(j.error)}</p>` : ""}
    </div>
    <div class="task-progress">
      <span>${esc(progress)}</span>
      <span class="meter"><span data-w="${pct(j.done, j.total)}"></span><span class="m-fail" data-w="${pct(j.failed, j.total)}"></span></span>
      <span class="current">${j.current ? esc(j.current) : "&nbsp;"}</span>
    </div>
    <div class="task-actions"><button data-log="${j.id}">Log</button>${taskActions(j)}</div>
  </article>`;
}

function renderTasks() {
  // Countdowns change without new data, so waiting tasks re-render every refresh.
  const ticking = state.jobs.some((j) => jobStatus(j) === "paused" || waiting(j));
  const signature = JSON.stringify([state.jobs, state.taskFilter, state.cancelArmed, ticking && Date.now()]);
  if (state.taskSignature === signature) return;
  state.taskSignature = signature;
  const jobs = state.jobs.filter(TASK_FILTERS[state.taskFilter]);
  $("#task-list").innerHTML = jobs.length
    ? jobs.map(taskCard).join("")
    : state.jobs.length
      ? '<div class="empty"><h3>Nothing here</h3><p>No tasks match this filter.</p></div>'
      : '<div class="empty"><h3>No tasks yet</h3><p>Start a download to collect volumes or index the catalog.</p><button class="primary" data-action="open-crawl">New download</button></div>';
  applyWidths($("#task-list"));
  $('[data-action="clear-tasks"]').disabled = !state.jobs.some((j) => j.status === "completed");
}

async function loadTasks() {
  const jobs = await latestList("tasks", "/api/jobs", $("#task-list"));
  if (!jobs) return;
  state.jobs = jobs;
  renderTasks();
}

async function queue(request, { go = true } = {}) {
  const job = await api("/api/jobs", { method: "POST", body: JSON.stringify(request) });
  toast(`Task #${job.id} started.`);
  if (go) await switchView("tasks");
  await loadStatus();
  return job;
}

/* Task log: opens on the latest lines, follows new ones while scrolled to the bottom,
   and pages back on request. At most LOG_CAP lines stay in the page. */

const LOG_CAP = 2000;
const logTime = (value) => new Date(value).toLocaleTimeString(undefined, { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const logDay = (value) => new Date(value).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const kilobytes = (kb) => (kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`);
const LOG_KINDS = [
  [/^Checking (\S+)$/, (m) => ({ kind: "log-work", text: m[1] })],
  [/^Downloaded (.+) \((\d+) KB\)\.$/s, (m) => ({ kind: "log-ok", text: m[1], size: kilobytes(Number(m[2])) })],
  [/^Saved the Japanese original of (.+) \((\d+) KB\)\.$/s, (m) => ({ kind: "log-ok", text: `Japanese original: ${m[1]}`, size: kilobytes(Number(m[2])) })],
  [/^Unchanged: (.+)$/s, (m) => ({ kind: "log-quiet", text: `Unchanged · ${m[1]}` })],
];

function describeLog(line) {
  for (const [pattern, shape] of LOG_KINDS) {
    const match = line.message.match(pattern);
    if (match) return shape(match);
  }
  return { kind: "", text: line.message };
}

function logRows(lines, previous) {
  let day = previous ? logDay(previous.created_at) : "";
  let work = "";
  return lines.map((line) => {
    const shape = describeLog(line);
    const { kind, size } = shape;
    // Lines inside a "Checking <work>" group drop the repeated "<work>: " prefix.
    if (kind === "log-work") work = shape.text;
    const text = work && kind !== "log-work" && shape.text.startsWith(`${work}: `) ? shape.text.slice(work.length + 2) : shape.text;
    const lineDay = logDay(line.created_at);
    const divider = lineDay !== day ? `<li class="log-day">${esc(lineDay)}</li>` : "";
    day = lineDay;
    return `${divider}<li class="${kind} ${esc(line.level)}"><time datetime="${esc(line.created_at)}" title="${esc(when(line.created_at))}">${esc(logTime(line.created_at))}</time><span class="mark" aria-hidden="true"></span><span class="msg">${esc(text)}</span>${size ? `<span class="log-size">${esc(size)}</span>` : "<span></span>"}</li>`;
  }).join("");
}

function renderLog() {
  const { lines, problems } = state.log;
  $("#log-content").innerHTML = lines.length
    ? logRows(lines)
    : `<li class="log-empty">${problems ? "No warnings or errors." : "No log lines yet."}</li>`;
  $("#log-earlier").hidden = !state.log.earlier;
  $("#log-count").textContent = lines.length ? `${plural(lines.length, "line")} shown${state.log.earlier ? ", earlier lines available" : ""}` : "";
}

const logArea = () => $("#log-dialog");
const atLogBottom = () => logArea().scrollHeight - logArea().scrollTop - logArea().clientHeight < 80;

function logUrl(params) {
  return `/api/jobs/${state.log.id}?${new URLSearchParams({ ...params, problems: state.log.problems })}`;
}

async function openLog(id, problems = false) {
  state.log = { id, lines: [], earlier: false, problems, unseen: 0, ready: false };
  $$("[data-log-filter]").forEach((b) => b.setAttribute("aria-checked", String((b.dataset.logFilter === "problems") === problems)));
  $("#log-content").innerHTML = "";
  $("#log-latest").hidden = true;
  $("#task-errors").innerHTML = "";
  delete $("#task-errors").dataset.signature;
  $("#log-title").textContent = `#${id} Task log`;
  $("#log-status").textContent = "Loading…";
  UI.openDialog($("#log-dialog"));
  const j = await api(logUrl({}));
  if (state.log.id !== id) return;
  Object.assign(state.log, { lines: j.logs, earlier: j.log_earlier, ready: true });
  renderLogHeader(j);
  renderLog();
  logArea().scrollTop = logArea().scrollHeight;
}

function renderLogHeader(j) {
  $("#log-title").textContent = `#${j.id} ${KINDS[j.kind]}`;
  const items = j.items.filter((i) => i.status === "failed").length;
  const running = j.items.find((i) => i.status === "running");
  $("#log-status").innerHTML = `${pill(jobStatus(j))}<span>${esc(taskScope(j))}</span>${running ? `<span>Now: ${esc(running.title || running.target)}</span>` : ""}${items ? `<span class="error-text">${plural(items, "failed item")}</span>` : ""}`;
  renderFailures(j);
}

async function loadLog() {
  const log = state.log;
  if (!log.id || !log.ready || !$("#log-dialog").open) return;
  const last = log.lines.at(-1);
  const j = await api(logUrl(last ? { after: last.id } : {}));
  if (state.log !== log || !$("#log-dialog").open) return;
  renderLogHeader(j);
  if (!j.logs.length) return;
  const follow = atLogBottom();
  if (!last) {
    log.lines = j.logs;
    renderLog();
  } else {
    log.lines.push(...j.logs);
    $("#log-content").insertAdjacentHTML("beforeend", logRows(j.logs, last));
    const extra = log.lines.length - LOG_CAP;
    if (extra > 0 && follow) {
      log.lines.splice(0, extra);
      log.earlier = true;
      renderLog();
    }
    $("#log-count").textContent = `${plural(log.lines.length, "line")} shown${log.earlier ? ", earlier lines available" : ""}`;
  }
  if (follow) {
    logArea().scrollTop = logArea().scrollHeight;
  } else {
    log.unseen += j.logs.length;
    const latest = $("#log-latest");
    latest.textContent = `↓ ${plural(log.unseen, "new line")}`;
    latest.hidden = false;
  }
}

$$("[data-log-filter]").forEach((button) => button.addEventListener("click", () => {
  const problems = button.dataset.logFilter === "problems";
  if (problems !== state.log.problems) openLog(state.log.id, problems).catch((e) => toast(e.message, true));
}));
$("#log-earlier").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  UI.pending(button, true, "Loading…");
  try { await loadEarlierLog(); } catch (error) { toast(error.message, true); } finally { UI.pending(button, false); }
});
$("#log-latest").addEventListener("click", () => {
  logArea().scrollTo({ top: logArea().scrollHeight, behavior: "smooth" });
});
$("#log-dialog").addEventListener("scroll", () => {
  if (!$("#log-latest").hidden && atLogBottom()) {
    state.log.unseen = 0;
    $("#log-latest").hidden = true;
  }
}, { passive: true });

async function loadEarlierLog() {
  const log = state.log;
  const first = log.lines[0];
  if (!first) return;
  const j = await api(logUrl({ before: first.id }));
  if (state.log !== log) return;
  const area = logArea();
  const fromBottom = area.scrollHeight - area.scrollTop;
  log.lines.unshift(...j.logs);
  log.earlier = j.log_earlier;
  renderLog();
  area.scrollTop = area.scrollHeight - fromBottom; // keep the line you were reading in place
}

function failureRow(j, item) {
  const volumes = Object.entries(item.parts?.failed || {});
  const done = item.parts?.done?.length || 0;
  const tag = item.retryable
    ? '<span class="pill warn" title="Network, server or rate-limit error">Temporary</span>'
    : '<span class="pill error" title="Retrying is unlikely to help until the cause is fixed">Permanent</span>';
  return `<li>
    <div class="failure-main">
      <strong>${esc(item.title || item.target)}</strong>
      <span class="failure-tags">${tag}<span class="pill">${plural(item.attempts || 1, "attempt")}</span>${done ? `<span class="pill ok">${done} volume${done === 1 ? "" : "s"} saved</span>` : ""}</span>
      <button data-retry="${j.id}" data-target="${esc(item.target)}">Retry</button>
    </div>
    ${volumes.length
      ? `<ul class="failure-volumes">${volumes.map(([volume, error]) => `<li><span>${esc(volume)}</span> ${esc(error)}</li>`).join("")}</ul>`
      : `<p class="error-text">${esc(item.error)}</p>`}
  </li>`;
}

function renderFailures(j) {
  const failed = j.items.filter((i) => i.status === "failed");
  const panel = $("#task-errors");
  const signature = JSON.stringify([j.status, failed]);
  if (panel.dataset.signature === signature) return;
  panel.dataset.signature = signature;
  if (!failed.length) {
    panel.innerHTML = "";
    return;
  }
  const temporary = failed.filter((i) => i.retryable).length;
  const running = ["queued", "running"].includes(j.status);
  panel.innerHTML = `<div class="failures-head">
      <div><strong>${plural(failed.length, "failed item")}</strong><p class="hint">${temporary} temporary, ${failed.length - temporary} permanent. Retrying skips volumes that were already saved${running ? "; this task picks retried items up next" : ""}.</p></div>
      <div class="failures-actions">
        ${temporary && temporary < failed.length ? `<button data-retry="${j.id}" data-only-retryable="true">Retry ${temporary} temporary</button>` : ""}
        <button class="primary" data-retry="${j.id}">Retry all ${failed.length}</button>
      </div>
    </div>
    <ul class="failures">${failed.map((i) => failureRow(j, i)).join("")}</ul>`;
}

/* Work detail */

const convertible = (f) => ["jp-zh", "zh-jp"].includes(f.mode);
const EDITION_MODES = { japanese: ["jp-original"], bilingual: ["jp-zh", "zh-jp"], chinese: ["zh"] };
const FOLDER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const volumeName = (volume) => volume.volume_id.replace(/\.(epub|txt)$/i, "");
// The editions in the order the strategy tries them, then the ones it leaves out.
const editionOrder = (strategy) => [...strategy.editions, ...Object.keys(EDITIONS).filter((e) => !strategy.editions.includes(e))];
// Converted editions recorded on a file; an original is its own Japanese edition.
const conversions = (f) => [["ja", "Japanese (converted)"], ["zh", "Chinese (converted)"]]
  .filter(([variant]) => f[`${variant}_path`] && f[`${variant}_path`] !== f.raw_path);
// As the server's Storage.gone: a record stays while anything converted from it is on disk.
const forgettable = (f) => !f.raw_available && conversions(f).every(([v]) => !f[`${v}_available`]);
const goneCount = (files) => files.reduce((n, f) => n + forgettable(f) + conversions(f).filter(([v]) => !f[`${v}_available`]).length, 0);

// A saved file opens on click, with a copy through the browser beside it. One
// deleted from disk stays recorded as downloaded; clicking it asks what to do.
function fileChip(f, variant, label, present, context) {
  const keep = variant === "raw" && !forgettable(f);
  const open = `data-open="${f.id}" data-variant="${variant}" data-label="${esc(label)}" data-pinned="${f.pinned ? "true" : ""}" data-keep="${keep ? "true" : ""}" ${context}`;
  if (!present) return `<button class="edition warn" ${open} title="Recorded as downloaded, but no longer on disk">${esc(label)} · not on disk</button>`;
  return `<span class="edition ok"><button ${open} title="Open">${esc(label)}</button><a href="/api/files/${f.id}/${variant}" download title="Save a copy" aria-label="Save a copy of ${esc(label)}">↓</a></span>`;
}

// Every edition Novelia offers for the volume, numbered in the strategy's order: saved ones
// open, the others download on click.
function volumeEditions(w, volume, files) {
  const { strategy } = w;
  const t = volume.translated || {};
  const untranslated = t.total && !strategy.translations.some((e) => t[e]);
  const context = (edition) => `data-key="${esc(w.key)}" data-index="${volume.index}" data-edition="${edition}" data-volume="${esc(volumeName(volume))}"`;
  const editions = volume.chinese_only
    ? [["", ["zh-original"], "Chinese upload"]]
    : editionOrder(strategy).map((e) => [e, EDITION_MODES[e], EDITIONS[e]]);
  const slots = editions.map(([edition, modes, label]) => {
    const rank = strategy.editions.indexOf(edition) + 1;
    const records = files.filter((f) => modes.includes(f.mode));
    let chips = records.flatMap((f) => [
      fileChip(f, "raw", MODE_LABELS[f.mode], f.raw_available, context(edition)),
      ...conversions(f).map(([variant, name]) => fileChip(f, variant, name, f[`${variant}_available`], context(edition))),
    ]).join("");
    const error = modes.map((m) => volume.unavailable?.[m]).find(Boolean);
    if (!chips && volume.index) {
      const note = !volume.chinese_only && edition !== "japanese" && untranslated ? " · not translated yet" : "";
      chips = error
        ? `<button class="edition warn" data-get="${edition}" data-force="true" ${context(edition)} title="${esc(error)} Click to try again.">${esc(label)} · unavailable</button>`
        : `<button class="edition idle" data-get="${edition}" ${context(edition)} title="Download this edition${rank ? "" : " (not in your download strategy)"}">↓ ${esc(label)}${note}</button>`;
    }
    if (!chips) return "";
    return `<span class="edition-slot${rank || volume.chinese_only ? "" : " extra"}">${rank ? `<span class="rank" title="Choice ${rank} of your download strategy">${rank}</span>` : ""}${chips}</span>`;
  });
  return slots.join("");
}

function volumeRow(w, volume, files) {
  const t = volume.translated;
  const coverage = t.total ? ENGINES.filter((e) => t[e]).map((e) => `${e} ${t[e]}/${t.total}`).join(", ") : "";
  const download = volume.index && !files.length
    ? `<button data-get="" data-key="${esc(w.key)}" data-index="${volume.index}" title="Download the editions your strategy picks">Download</button>`
    : "";
  const actions = files
    .filter((f) => convertible(f) && f.raw_available)
    .map((f) => `<button data-convert-file="${f.id}">${f.ja_available || f.zh_available ? "Reconvert" : "Convert"}</button>`)
    .join("") + download;
  const sizes = files.map((f) => `${(f.size / 1048576).toFixed(1)} MB`).join(" + ");
  return `<div class="volume">
    <div>
      <div class="name">${volume.index ? `<span class="muted">${volume.index}.</span> ` : ""}${esc(volumeName(volume))}</div>
      <div class="editions">${volumeEditions(w, volume, files)}</div>
      <div class="detail">${coverage ? `<span>${esc(coverage)}</span>` : ""}${sizes ? `<span>${sizes}</span>` : ""}${volume.index ? "" : "<span>No longer listed on Novelia</span>"}</div>
    </div>
    <div class="volume-actions">${actions}</div>
  </div>`;
}

async function openWork(key, show = true, live = state.detail?.key === key && state.detail.live) {
  const w = await latestList("detail", `/api/works/${key}${live ? "?live=true" : ""}`, $("#work-detail"));
  if (!w) return;
  state.detail = { key, live, strategy: w.strategy.editions };
  const m = w.metadata;
  const listed = new Set(w.volumes.map((v) => v.volume_id));
  const orphans = [...new Set(w.files.filter((f) => !listed.has(f.volume_id)).map((f) => f.volume_id))];
  const volumes = [...w.volumes, ...orphans.map((volume_id) => ({ volume_id, index: 0, translated: {} }))];
  const facts = [
    ["Authors", w.authors.join(", ")],
    ["Artists", (m.artists || []).join(", ")],
    ["Publisher", [w.publisher, m.imprint !== w.publisher && m.imprint].filter(Boolean).join(" / ")],
    ["Collection", collectionName(w)],
    ["ID", w.key],
    ["Checked", when(w.checked_at)],
  ].filter(([, v]) => v);
  const intro = m.introductionJp || m.introduction || "";
  const bilingual = w.files.some(convertible);
  const saved = new Set(w.files.map((f) => f.volume_id));
  const gone = goneCount(w.files);
  const strategy = w.strategy.editions.map((e) => EDITIONS[e]).join(" → ");
  const [title, other] = titles(w.title, w.title_zh);
  $("#work-detail").innerHTML = `
    <div class="work-summary">
      ${cover(w.cover, title)}
      <div class="work-info">
        <h2>${esc(title)}</h2>
        ${other ? `<p class="alt">${esc(other)}</p>` : ""}
      </div>
      <dl class="work-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      <div class="work-actions">
          <button class="primary" data-download-work="${esc(w.key)}">${w.local ? "Check and download" : "Add and download"}</button>
          ${w.folders.map((f) => `<button class="folder-button" data-folder="${esc(f.path)}" data-key="${esc(w.key)}" title="${esc(f.path)}">${FOLDER_ICON}${w.folders.length > 1 ? esc(f.name) : "Open folder"}</button>`).join("")}
          ${bilingual ? `<button data-convert-work="${esc(w.key)}">Convert all volumes</button>` : ""}
          ${w.local ? `<button class="danger" data-remove-work="${esc(w.key)}">Remove from library</button>` : ""}
          <a class="button-link" href="${esc(workUrl(w.key))}" target="_blank" rel="noopener">Novelia ↗</a>
      </div>
    </div>
    ${w.local ? "" : '<p class="note-text live-note">Not in your library yet. Read live from Novelia; downloading adds it.</p>'}
    ${intro ? `<section class="introduction"><div id="intro-wrap" class="intro-wrap"><p class="intro" id="intro">${esc(intro)}</p></div><button class="link intro-toggle" id="intro-toggle" aria-expanded="false" aria-controls="intro-wrap">Read more</button></section>` : ""}
    <section class="volumes">
      <h3>${[plural(w.volumes.length, "volume"), `${saved.size} saved`].join(", ")}${gone ? `, <button class="link" data-missing-work="${esc(w.key)}">${plural(gone, "file")} not on disk</button>` : ""}</h3>
      <p class="hint volumes-hint">Editions in your download order (${esc(strategy)}, ${w.strategy.per_volume === 1 ? "first available kept" : `first ${w.strategy.per_volume} available kept`}). Click a saved one to open it, ↓ to save a copy; click any other to download just that edition.</p>
      ${volumes.length ? volumes.map((v) => volumeRow(w, v, w.files.filter((f) => f.volume_id === v.volume_id))).join("") : '<p class="hint">Novelia lists no uploaded volumes for this work.</p>'}
    </section>`;
  const introElement = $("#intro");
  if (introElement) {
    state.introFull = intro;
    state.introShort = intro.length > 240 ? intro.slice(0, 240) + "…" : intro;
    introElement.textContent = state.introShort;
    $("#intro-toggle").hidden = intro.length <= 240;
  }
  if (show) UI.openDialog($("#work-dialog"));
}

/* Status and settings */

async function loadStatus() {
  const s = await api("/api/status");
  state.categories = s.categories;
  $("#stat-works").textContent = s.works.toLocaleString();
  $("#stat-files").textContent = s.files.toLocaleString();
  $("#stat-ja").textContent = s.converted.toLocaleString();
  $("#stat-size").textContent = size(s.bytes);
  const badge = $("#active-count");
  badge.textContent = s.active_jobs;
  badge.hidden = !s.active_jobs;

  const { running, paused } = s;
  const banner = $("#now-running");
  UI.show(banner, Boolean(running || paused));
  banner.classList.toggle("is-waiting", Boolean((running && waiting(running)) || (!running && paused)));
  if (running) {
    const counts = running.total ? `${running.done + running.failed}/${running.total}` : `catalog page ${running.cursor}`;
    const detail = waiting(running) ? `${running.wait_reason} (${countdown(running.wait_until)})` : running.current;
    $("#now-running-text").textContent = `#${running.id} ${KINDS[running.kind]}: ${counts}${detail ? ` · ${detail}` : ""}`;
    $("#now-running-bar").dataset.w = pct(running.done + running.failed, running.total);
    applyWidths(banner);
  } else if (paused) {
    $("#now-running-text").textContent = `#${paused.id} ${KINDS[paused.kind]} paused · resumes in ${countdown(paused.resume_at)} · ${paused.wait_reason || ""}`;
    $("#now-running-bar").dataset.w = 0;
    applyWidths(banner);
  }

  const schedule = s.incremental_enabled
    ? `Sweeps every ${s.interval_hours} h. Last ${when(s.last_incremental_at)}, next ${when(s.next_incremental_at)}.`
    : `Automatic sweeps are off. Last sweep ${when(s.last_incremental_at)}.`;
  $("#schedule-label").textContent = schedule;
  $("#schedule-detail").textContent = s.incremental_enabled
    ? `Next sweep ${when(s.next_incremental_at)}.`
    : "Turning sweeps on starts the first one immediately.";
  $("#storage-path").textContent = `Files are saved in ${s.download_root}`;
  return s;
}

// Ordered, tickable settings lists: the list element and each entry's label.
const ORDER_LISTS = {
  engines: ["#engine-list", (name) => name],
  editions: ["#edition-list", (name) => EDITIONS[name]],
};
// Ticked entries first, in their saved order, then the rest.
const orderOf = (ticked, all) => [
  ...ticked.map((name) => ({ name, on: true })),
  ...all.filter((name) => !ticked.includes(name)).map((name) => ({ name, on: false })),
];
const ticked = (name) => state.order[name].filter((item) => item.on).map((item) => item.name);

function renderOrder(name) {
  const [selector, label] = ORDER_LISTS[name];
  const list = $(selector);
  const items = state.order[name];
  UI.reorder(list, () => items.forEach((item, index) => {
    let row = $(`[data-item="${item.name}"]`, list);
    if (!row) {
      const text = esc(label(item.name));
      row = document.createElement("li");
      row.dataset.item = item.name;
      row.innerHTML = `<label><input type="checkbox"> ${text}</label><button type="button" data-dir="-1" aria-label="Move ${text} up">↑</button><button type="button" data-dir="1" aria-label="Move ${text} down">↓</button>`;
    }
    const input = $("input", row);
    Object.assign(input.dataset, { order: name, index });
    input.checked = item.on;
    row.classList.toggle("off", !item.on);
    $$("button", row).forEach(button => {
      Object.assign(button.dataset, { order: name, move: index });
      button.disabled = Number(button.dataset.dir) < 0 ? index === 0 : index === items.length - 1;
    });
    list.append(row);
  }));
  updateSettingsFeedback();
}

async function loadSettings(force = false) {
  if (settingsLoaded && !force) return;
  const settings = await api("/api/settings");
  const storageStatus = await api("/api/status");
  $("#download-directory").value = storageStatus.download_root;
  const form = $("#settings-form");
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements.namedItem(key);
    if (!input || key === "translations") continue;
    if (input.type === "checkbox") input.checked = value;
    else input.value = value;
  }
  state.order = {
    engines: orderOf(settings.translations, ENGINES),
    editions: orderOf(settings.editions, Object.keys(EDITIONS)),
  };
  Object.keys(ORDER_LISTS).forEach(renderOrder);
  settingsLoaded = true;
  settingsBaseline = settingsSnapshot();
  updateSettingsFeedback();
  await loadStatus();
}

/* Navigation */

async function switchView(view) {
  const changed = state.view !== view;
  if (changed) state.scrollPosition = { ...state.scrollPosition, [state.view]: scrollY };
  state.view = view;
  $$(".view").forEach((el) => (el.hidden = el.id !== view));
  $$(".nav").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === view);
    if (el.dataset.view === view) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
  if (changed) {
    scrollTo({ top: state.scrollPosition?.[view] || 0, behavior: "instant" });
    UI.reveal($("#" + view));
  }
  selectionBar();
  // Coming back shows the last page at once and refreshes it quietly; a forced load would
  // dim and fade the grid again right after the view itself fades in.
  if (view === "library") await loadLibrary(!state.library.signature);
  if (view === "tasks") await loadTasks();
  if (view === "settings") await loadSettings();
  if (view === "catalog" && !state.catalog.loaded) await loadCatalog();
}

function crawlFields() {
  const kind = $("#crawl-form").elements.kind.value;
  $("#range-fields").hidden = kind !== "range";
  $("#manual-fields").hidden = kind !== "manual";
  $("#volume-field").hidden = !["range", "manual"].includes(kind);
  $("#full-hint").hidden = ["range", "manual"].includes(kind);
}

function fillCategories() {
  const entries = Object.entries(state.categories);
  const options = (list) => list.map(([v, label]) => `<option value="${v}">${esc(label)}</option>`).join("");
  const lightFirst = [entries.find(([v]) => v === "1"), ...entries.filter(([v]) => v !== "1")].filter(Boolean);
  $("#library-category").insertAdjacentHTML("beforeend", options(entries.filter(([v]) => v !== "0")));
  $("#catalog-category").innerHTML = options(lightFirst);
  $("#crawl-category").innerHTML = options(lightFirst);
}

const CONVERSION_FIELDS = ["convert_japanese", "convert_chinese"];
let conversion = { request: {}, go: true, after: null };
async function openConversion(request, description, { go = true, after = null } = {}) {
  const settings = await api("/api/settings");
  conversion = { request, go, after };
  const form = $("#convert-form");
  for (const name of CONVERSION_FIELDS) form.elements[name].checked = settings[name];
  $("#convert-description").textContent = description;
  UI.openDialog($("#convert-dialog"));
}
$("#convert-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('[type="submit"]', form);
  if (button.getAttribute("aria-busy") === "true") return;
  const picked = Object.fromEntries(CONVERSION_FIELDS.map(name => [name, form.elements[name].checked]));
  if (!picked.convert_japanese && !picked.convert_chinese) {
    toast("Choose at least one edition.", true);
    return;
  }
  UI.pending(button, true, "Starting…");
  try {
    await queue({ ...conversion.request, ...picked }, { go: conversion.go });
    await UI.closeDialog($("#convert-dialog"));
    conversion.after?.();
  } catch (error) { toast(error.message, true); }
  finally { UI.pending(button, false); }
});

let removal = { keys: [] };
function openRemoval(keys, works = state.library.items) {
  removal = { keys };
  $("#remove-description").textContent = `Remove ${plural(keys.length, "work")} from your library? Local files are kept unless you select the option below.`;
  $("#remove-items").innerHTML = keys.map(key => `<li>${esc(works.find(w => w.key === key)?.title || key)}</li>`).join("");
  $("#delete-local-files").checked = false;
  UI.openDialog($("#remove-dialog"));
}

const refreshDetail = () => ($("#work-dialog").open && state.detail ? openWork(state.detail.key, false) : null);

// Files recorded as downloaded but gone from disk, for every work or the given ones.
let missing = { keys: [] };
async function openMissing(only = null) {
  const query = only ? "?" + new URLSearchParams(only.map((key) => ["keys", key])) : "";
  const { items: works } = await api("/api/library/missing" + query);
  if (!works.length) return toast("Every recorded file is on disk.");
  missing = { keys: works.map((w) => w.key) };
  const files = works.flatMap((w) => w.files);
  const count = files.reduce((n, f) => n + f.record + f.editions.length, 0);
  $("#missing-description").textContent = `${plural(count, "file")} of ${plural(works.length, "work")} ${count === 1 ? "is" : "are"} recorded as downloaded but no longer on disk. The records stay, and later tasks leave these volumes alone, until you forget them or download them again.`;
  $("#missing-items").innerHTML = works.map((w) => `<li><strong>${esc(titles(w.title, w.title_zh)[0])}</strong><ul>${w.files.map((f) =>
    `<li>${esc(f.volume_id.replace(/\.(epub|txt)$/i, ""))} <span class="muted">${[f.record && MODE_LABELS[f.mode], ...f.editions.map((e) => (e === "ja" ? "Japanese (converted)" : "Chinese (converted)"))].filter(Boolean).join(", ")}</span></li>`).join("")}</ul></li>`).join("");
  $("#missing-download").hidden = !files.some((f) => f.record);
  UI.openDialog($("#missing-dialog"));
}

// One file found missing when opened: download or convert it again, or forget the record.
let gone = {};
function openGone(d, path) {
  gone = { ...d };
  const converted = d.variant !== "raw";
  $("#gone-description").textContent = d.keep === "true"
    ? `${d.label} of ${d.volume} is recorded as downloaded, but the file is no longer on disk. Its record stays while an edition converted from it is still on disk.`
    : `${d.label} of ${d.volume} is recorded as downloaded, but the file is no longer on disk. The record is kept, and later tasks leave it alone, until you forget it or ${converted ? "convert" : "download"} it again.`;
  $('[data-action="gone-forget"]').hidden = d.keep === "true";
  $("#gone-path").textContent = path;
  const again = $("#gone-again");
  again.textContent = converted ? "Convert again" : "Download again";
  again.hidden = !converted && !Number(d.index);
  UI.openDialog($("#gone-dialog"));
}

async function getEdition(d, restore = false) {
  // A file asked for by name, or outside the strategy, is fetched by name; otherwise the
  // strategy decides, so a stand-in is not kept for good.
  const named = d.edition && (!restore || d.pinned === "true" || !state.detail?.strategy?.includes(d.edition));
  await queue({
    kind: "manual",
    keys: [d.key],
    volumes: String(d.index),
    editions: named ? [d.edition] : [],
    force: d.force === "true",
    restore,
  }, { go: false });
}
$("#remove-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $('[type="submit"]', event.currentTarget);
  if (button.getAttribute("aria-busy") === "true") return;
  UI.pending(button, true, "Removing…");
  try {
    const result = await api("/api/library/remove", {
      method: "POST", body: JSON.stringify({keys: removal.keys, delete_files: $("#delete-local-files").checked})
    });
    await UI.closeDialog($("#remove-dialog"));
    removal.keys.forEach(key => state.selected.delete(key));
    state.library.page = 1;
    state.catalog.loaded = false;
    await Promise.all([loadLibrary(true), loadStatus()]);
    toast(`Removed ${plural(result.removed, "work")}.`);
  } catch (error) { toast(error.message, true); }
  finally { UI.pending(button, false); }
});
$("#storage-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $('[type="submit"]', event.currentTarget);
  if (button.getAttribute("aria-busy") === "true") return;
  UI.pending(button, true, "Applying…");
  $("#storage-result").textContent = "Applying directory; migrating files may take a while…";
  try {
    const result = await api("/api/storage", {method: "PUT", body: JSON.stringify({
      directory: $("#download-directory").value, migrate: $("#migrate-files").checked
    })});
    $("#download-directory").value = result.download_root;
    $("#storage-result").textContent = `Directory updated. ${plural(result.migrated, "file")} migrated.` + (result.warnings.length ? " " + result.warnings.join(" ") : "");
    await loadStatus();
  } catch (error) { $("#storage-result").textContent = error.message; }
  finally { UI.pending(button, false); }
});

function setChip(group, button) {
  $$("button", group).forEach((b) => { b.setAttribute("aria-checked", b === button); b.tabIndex = b === button ? 0 : -1; });
}

const actions = {
  "remove-selected": () => openRemoval([...state.selected]),
  "check-files": () => openMissing(),
  "missing-download": async () => {
    const keys = missing.keys.slice(0, 1000);
    await queue({ kind: "manual", keys, restore: true }, { go: false });
    if (keys.length < missing.keys.length) toast(`Started with the first ${keys.length} works; run it again for the rest.`);
    await UI.closeDialog($("#missing-dialog"));
  },
  "missing-forget": async () => {
    const result = await api("/api/library/forget-missing", { method: "POST", body: JSON.stringify({ keys: missing.keys }) });
    await UI.closeDialog($("#missing-dialog"));
    toast(`Forgot ${plural(result.records, "download")}${result.editions ? ` and ${plural(result.editions, "converted edition")}` : ""}.`);
    await Promise.all([loadLibrary(true), loadStatus(), refreshDetail()]);
  },
  "gone-again": async () => {
    if (gone.variant === "raw") await getEdition(gone, true);
    else await queue({ kind: "convert", file_ids: [Number(gone.open)], force: true, convert_japanese: gone.variant === "ja", convert_chinese: gone.variant === "zh" }, { go: false });
    await UI.closeDialog($("#gone-dialog"));
  },
  "gone-forget": async () => {
    const result = await api(`/api/files/${gone.open}/forget`, { method: "POST" });
    await UI.closeDialog($("#gone-dialog"));
    toast(result.records ? "Forgot the download; the next task that checks this work fetches it again." : "Forgot the converted edition.");
    await Promise.all([loadLibrary(true), loadStatus(), refreshDetail()]);
  },
  "select-page": () => {
    const onCatalog = state.view === "catalog";
    const set = onCatalog ? state.catalogSelected : state.selected;
    $$(onCatalog ? "#catalog-list [data-catalog-key]" : "#library-list input[data-key]").forEach((input) => {
      input.checked = true;
      set.add(input.dataset.catalogKey || input.dataset.key);
      input.closest(".book")?.classList.add("picked");
    });
    const all = $("#select-page");
    if (all) all.checked = true;
    selectionBar();
  },
  "open-crawl": () => {
    crawlFields();
    UI.openDialog($("#crawl-dialog"));
  },
  incremental: () => queue({ kind: "incremental" }),
  "convert-all": () => openConversion({ kind: "convert" }, "Every bilingual volume in the library. Volumes already converted the same way are skipped."),
  "download-selected": async () => {
    const set = state.view === "catalog" ? state.catalogSelected : state.selected;
    await queue({ kind: "manual", keys: [...set] });
    set.clear();
    selectionBar();
  },
  "convert-selected": () => openConversion(
    { kind: "convert", keys: [...state.selected] },
    `The bilingual volumes of ${plural(state.selected.size, "selected work")}.`,
    { after: () => { state.selected.clear(); selectionBar(); } },
  ),
  "clear-selection": async () => {
    if (state.view === "catalog") {
      state.catalogSelected.clear();
      $$("[data-catalog-key]").forEach((el) => (el.checked = false));
      $$("#catalog-list .book").forEach((el) => el.classList.remove("picked"));
      selectionBar();
    } else {
      state.selected.clear();
      await loadLibrary(true);
    }
  },
  "library-prev": () => turnPage(() => { state.library.page--; return loadLibrary(true); }, "#library-list"),
  "library-next": () => turnPage(() => { state.library.page++; return loadLibrary(true); }, "#library-list"),
  "catalog-prev": () => turnPage(() => { state.catalog.page--; return loadCatalog(); }, "#catalog-list"),
  "catalog-next": () => turnPage(() => { state.catalog.page++; return loadCatalog(); }, "#catalog-list"),
  "clear-tasks": async () => {
    const { removed } = await api("/api/jobs/clear", { method: "POST" });
    toast(`Removed ${plural(removed, "completed task")}.`);
    await loadTasks();
  },
};

function togglePick(input, set, key) {
  input.checked ? set.add(key) : set.delete(key);
  input.closest(".book")?.classList.toggle("picked", input.checked);
  if (input.closest(".book")) state.lastPick = { view: state.view, input };
  selectionBar();
}
const pickInput = (input) =>
  togglePick(input, input.dataset.catalogKey ? state.catalogSelected : state.selected, input.dataset.catalogKey || input.dataset.key);

// Ctrl-click, or any click once something is selected, picks a cover instead of opening it;
// Shift-click picks every cover from the last one picked.
function pickCard(card, range) {
  const input = $('input[type="checkbox"]', card);
  const inputs = $$('.book input[type="checkbox"]', card.closest(".books"));
  const last = state.lastPick?.view === state.view ? inputs.indexOf(state.lastPick.input) : -1;
  const at = inputs.indexOf(input);
  const picks = range && last >= 0 ? inputs.slice(Math.min(last, at), Math.max(last, at) + 1) : [input];
  const checked = range || !input.checked;
  picks.forEach((el) => {
    el.checked = checked;
    pickInput(el);
  });
  state.lastPick = { view: state.view, input };
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  const d = button.dataset;
  const card = d.work && button.closest(".book");
  if (card && (event.ctrlKey || event.metaKey || event.shiftKey || card.closest(".selecting"))) {
    pickCard(card, event.shiftKey);
    return;
  }
  if (button.id === "sidebar-toggle") {
    setSidebar(document.documentElement.dataset.sidebar !== "collapsed");
    return;
  }
  if (d.close) {
    const dialog = $("#" + d.close);
    if (!dialog.querySelector('[aria-busy="true"]')) await UI.closeDialog(dialog);
    return;
  }
  if (d.cancel && d.confirmed !== "true") {
    // The list re-renders every few seconds, so one stray click must not stop a long task.
    const id = Number(d.cancel);
    state.cancelArmed = id;
    renderTasks();
    $(`[data-cancel="${id}"]`)?.focus();
    setTimeout(() => {
      if (state.cancelArmed !== id) return;
      state.cancelArmed = null;
      renderTasks();
    }, 5000);
    return;
  }
  if (d.cancel) state.cancelArmed = null;
  const mutating = d.cancel || d.resume || d.retry || d.delete || d.downloadWork || d.get !== undefined || d.open || d.folder || d.missingWork || d.convertWork || d.convertFile ||
    ["incremental", "convert-all", "download-selected", "convert-selected", "clear-tasks", "check-files", "missing-download", "missing-forget", "gone-again", "gone-forget"].includes(d.action);
  if (mutating) UI.pending(button, true);
  try {
    if (d.view) await switchView(d.view);
    else if (d.removeWork) {
      const work = await api(`/api/works/${d.removeWork}`);
      await UI.closeDialog($("#work-dialog"));
      openRemoval([d.removeWork], [work]);
    }
    else if (d.work) await openWork(d.work, true, d.live === "true");
    else if (d.open) {
      const result = await api(`/api/files/${d.open}/${d.variant}/open`, { method: "POST" });
      if (result.missing) openGone(d, result.path);
    } else if (d.folder) {
      await api(`/api/works/${d.key}/folder`, { method: "POST", body: JSON.stringify({ folder: d.folder }) });
    } else if (d.get !== undefined) {
      await getEdition(d);
    } else if (d.missingWork) {
      await openMissing([d.missingWork]);
    } else if (d.titleLang) {
      setTitleLang(d.titleLang);
      if (state.catalog.loaded) renderCatalog();
      await loadLibrary(true);
    } else if (d.layout) {
      state.layout = d.layout;
      store.set("layout", d.layout);
      await loadLibrary(true);
    } else if (d.state !== undefined) {
      setChip($("#state-chips"), button);
      state.library.filter = d.state;
      state.library.page = 1;
      await loadLibrary(true);
    } else if (d.taskFilter) {
      setChip($("#task-chips"), button);
      state.taskFilter = d.taskFilter;
      renderTasks();
      UI.reveal($("#task-list"));
    } else if (d.log) await openLog(Number(d.log));
    else if (d.cancel || d.resume) {
      await api(`/api/jobs/${d.cancel || d.resume}/${d.cancel ? "cancel" : "resume"}`, { method: "POST" });
      await Promise.all([loadTasks(), loadStatus()]);
    } else if (d.retry) {
      const { retried } = await api(`/api/jobs/${d.retry}/retry`, {
        method: "POST",
        body: JSON.stringify({ targets: d.target ? [d.target] : [], only_retryable: d.onlyRetryable === "true" }),
      });
      const job = state.jobs.find((j) => j.id === Number(d.retry));
      const next = job && ["queued", "running"].includes(job.status) ? " They run next." : "";
      toast(`Retrying ${plural(retried, "failed item")} in task #${d.retry}.${next}`);
      await Promise.all([loadTasks(), loadStatus(), loadLog()]);
    } else if (d.preset) {
      const form = $("#settings-form");
      for (const [name, value] of Object.entries(PACING_PRESETS[d.preset])) {
        const input = form.elements.namedItem(name);
        if (input.type === "checkbox") input.checked = value;
        else input.value = value;
      }
      updateSettingsFeedback();
    } else if (d.delete) {
      await api(`/api/jobs/${d.delete}`, { method: "DELETE" });
      await loadTasks();
    } else if (d.downloadWork) {
      await UI.closeDialog($("#work-dialog"));
      await queue({ kind: "manual", keys: [d.downloadWork] });
    } else if (d.convertWork) {
      await openConversion({ kind: "convert", keys: [d.convertWork] }, "Every bilingual volume of this work.", { go: false });
    } else if (d.convertFile) {
      await openConversion({ kind: "convert", file_ids: [Number(d.convertFile)], force: true }, "This volume, built again even if already converted.", { go: false });
    } else if (d.move) {
      const items = state.order[d.order];
      const i = Number(d.move), j = i + Number(d.dir);
      [items[i], items[j]] = [items[j], items[i]];
      renderOrder(d.order);
      $(`button[data-order="${d.order}"][data-move="${j}"][data-dir="${d.dir}"]`)?.focus();
    } else if (actions[d.action]) await actions[d.action]();
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (mutating) UI.pending(button, false);
  }
});

document.addEventListener("change", (event) => {
  const input = event.target;
  if (input.id === "theme-select") setTheme(input.value);
  else if ((input.dataset.key || input.dataset.catalogKey) && input.type === "checkbox") pickInput(input);
  else if (input.id === "select-page") {
    state.library.items.forEach((w) => (input.checked ? state.selected.add(w.key) : state.selected.delete(w.key)));
    $$("#library-list [data-key]").forEach((el) => (el.checked = input.checked));
    selectionBar();
  } else if (input.dataset.order) {
    state.order[input.dataset.order][Number(input.dataset.index)].on = input.checked;
    renderOrder(input.dataset.order);
  } else if (input.name === "kind") crawlFields();
  else if (["library-category", "library-sort"].includes(input.id)) {
    state.library.page = 1;
    loadLibrary(true).catch((e) => toast(e.message, true));
  } else if (input.id === "catalog-category") {
    state.catalog.page = 1;
    loadCatalog();
  } else if (input.id === "catalog-page") {
    state.catalog.page = Math.min(Math.max(1, Number(input.value) || 1), Math.max(1, state.catalog.pages));
    loadCatalog();
  }
});

let searchTimer;
$("#library-query").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.library.page = 1;
    loadLibrary(true).catch((e) => toast(e.message, true));
  }, 250);
});
$("#library-filter").addEventListener("submit", (event) => event.preventDefault());
$("#catalog-filter").addEventListener("submit", (event) => {
  event.preventDefault();
  state.catalog.page = 1;
  loadCatalog();
});

$("#crawl-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if ($('button[type="submit"]', form).getAttribute("aria-busy") === "true") return;
  const f = new FormData(form);
  const kind = f.get("kind");
  const request = { kind, download: form.elements.download.checked, force: form.elements.force.checked, restore: form.elements.restore.checked };
  if (kind === "range") {
    Object.assign(request, {
      category: Number(f.get("category")),
      start_page: Number(f.get("start_page")),
      end_page: Number(f.get("end_page")),
      query: f.get("query"),
    });
  }
  if (kind === "manual") request.keys = f.get("keys").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (["range", "manual"].includes(kind)) request.volumes = f.get("volumes").trim();
  const submit = $('button[type="submit"]', form);
  UI.pending(submit, true, "Starting…");
  try {
    await queue(request);
    await UI.closeDialog($("#crawl-dialog"));
  } catch (e) {
    toast(e.message, true);
  } finally {
    UI.pending(submit, false);
  }
});

// Accept quick entries such as "7", "730" or "2330" and store them as 24-hour HH:MM.
$$(".time-range input").forEach((input) => input.addEventListener("change", () => {
  const digits = input.value.replace(/\D/g, "");
  if (!digits || digits.length > 4 || /:/.test(input.value) && input.checkValidity()) return;
  const [hours, minutes] = digits.length <= 2 ? [digits, "0"] : [digits.slice(0, -2), digits.slice(-2)];
  input.value = `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
  updateSettingsFeedback();
}));
$("#settings-form").addEventListener("input", updateSettingsFeedback);
$("#settings-form").addEventListener("change", updateSettingsFeedback);
$("#discard-settings").addEventListener("click", async () => {
  try { await loadSettings(true); toast("Changes discarded."); }
  catch (error) { toast(error.message, true); }
});
$("#settings-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (settingsSaving) return;
  const form = event.currentTarget;
  const settings = {};
  for (const input of form.elements) {
    if (!input.name) continue;
    settings[input.name] = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
  }
  settings.translations = ticked("engines");
  settings.editions = ticked("editions");
  settings.editions_per_volume = Number(settings.editions_per_volume);
  if (!settings.translations.length) return toast("Tick at least one translation engine.", true);
  if (!settings.editions.length) return toast("Tick at least one edition to download.", true);
  const savedSnapshot = settingsSnapshot();
  const button = $("#save-settings");
  settingsSaving = true;
  UI.pending(button, true, "Saving…");
  updateSettingsFeedback();
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
    settingsBaseline = savedSnapshot;
    toast("Settings saved.");
    await loadStatus();
  } catch (error) { toast(error.message, true); }
  finally {
    settingsSaving = false;
    UI.pending(button, false);
    updateSettingsFeedback();
  }
});
$("#work-detail").addEventListener("click", async event => {
  if (event.target.id !== "intro-toggle") return;
  const button = event.target;
  const expanded = button.getAttribute("aria-expanded") !== "true";
  const wrapper = $("#intro-wrap");
  const oldHeight = wrapper.getBoundingClientRect().height;
  $("#intro").textContent = expanded ? state.introFull : state.introShort;
  button.setAttribute("aria-expanded", expanded);
  button.textContent = expanded ? "Show less" : "Read more";
  await UI.animate(wrapper, [{ height: `${oldHeight}px` }, { height: `${wrapper.getBoundingClientRect().height}px` }], 200);
});

document.addEventListener("keydown", (event) => {
  if (event.target.matches("input, textarea, select") || $("dialog[open]")) return;
  const selection = state.view === "catalog" ? state.catalogSelected : state.selected;
  if (event.key === "Escape" && selection.size) {
    actions["clear-selection"]().catch((e) => toast(e.message, true));
    return;
  }
  if (event.key !== "/") return;
  const field = state.view === "library" ? $("#library-query") : state.view === "catalog" ? $("#catalog-query") : null;
  if (field) {
    event.preventDefault();
    field.focus();
  }
});

function setSidebar(collapsed, persist = true) {
  document.documentElement.dataset.sidebar = collapsed ? "collapsed" : "expanded";
  const button = $("#sidebar-toggle");
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  button.setAttribute("aria-expanded", String(!collapsed));
  button.setAttribute("aria-label", label);
  button.title = label;
  if (persist) store.set("sidebar-collapsed", String(collapsed));
}

function setTitleLang(value, persist = true) {
  state.titleLang = value === "zh" ? "zh" : "ja";
  $$("[data-title-lang]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.titleLang === state.titleLang));
  if (persist) store.set("title-lang", state.titleLang);
}

function setTheme(value, persist = true) {
  const theme = ["light", "dark"].includes(value) ? value : "system";
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  $("#theme-select").value = theme;
  if (persist) store.set("theme", theme);
}

async function refresh() {
  if (state.busy || document.hidden) return;
  state.busy = true;
  try {
    const s = await loadStatus();
    if (state.view === "tasks" && (s.active_jobs || state.lastActive) && !$('#task-list [aria-busy="true"]')) await loadTasks();
    state.lastActive = s.active_jobs;
    if (state.view === "library" && !$("dialog[open]") && !listRequests.has("library")) await loadLibrary();
    await loadLog();
  } catch (e) {
    toast(`The local server is not responding: ${e.message}`, true);
  } finally {
    state.busy = false;
  }
}

(async () => {
  setTheme(store.get("theme", "system"), false);
  setSidebar(store.get("sidebar-collapsed", "false") === "true", false);
  setTitleLang(state.titleLang, false);
  try {
    await loadStatus();
    fillCategories();
    await loadLibrary(true);
  } catch (e) {
    toast(`The local server is not responding: ${e.message}`, true);
  }
  setInterval(refresh, 4000);
})();