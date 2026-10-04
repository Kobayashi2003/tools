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
  failed: ["Failed", "error"],
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
  engines: [],
  busy: false,
};

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const when = (value) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never";
const day = (value) => (value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—");
const clock = (value) => new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const size = (bytes) =>
  bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : `${Math.round(bytes / (1 << 20)).toLocaleString()} MB`;
const pct = (part, whole) => (whole ? Math.min(100, (part / whole) * 100) : 0);
const workUrl = (key) => `${SITE}/${key.startsWith("wenku/") ? key : "novel/" + key}`;

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
    state.engines.map(engine => [engine.name, engine.on]),
  ]);
}
function updateSettingsFeedback() {
  const dirty = settingsLoaded && settingsSnapshot() !== settingsBaseline;
  $("#settings-form").dataset.dirty = dirty;
  $("#settings-feedback").textContent = settingsSaving ? "Saving changes…" : dirty ? "Unsaved changes" : "All changes saved";
  $("#save-settings").disabled = !dirty || settingsSaving;
  $("#discard-settings").disabled = !dirty || settingsSaving;
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
  const raw = w.file_count - w.ja_count;
  const badges = [
    w.unverified_count ? `<span class="pill warn" title="Unverified Japanese editions">⚠ ${w.unverified_count}</span>` : "",
    w.ja_count ? `<span class="pill ok" title="Japanese editions">JA ${w.ja_count}</span>` : "",
  ].join("");
  return `<article class="book${picked ? " picked" : ""}">
    <label class="pick"><input type="checkbox" data-key="${esc(w.key)}" aria-label="Select ${esc(w.title)}" ${picked ? "checked" : ""}></label>
    <button class="book-open" data-work="${esc(w.key)}">
      ${cover(w.cover, w.title)}
      <h3 title="${esc(w.title)}">${esc(w.title)}</h3>
      <p class="by">${esc(w.authors.join(", ") || w.title_zh || w.key)}</p>
      <span class="meter" aria-hidden="true"><span class="m-ja" data-w="${pct(w.ja_count, w.volume_count)}"></span><span data-w="${pct(raw, w.volume_count)}"></span></span>
      <span class="count"><span>${w.file_count} / ${w.volume_count} saved</span><span class="ribbon-inline">${badges}</span></span>
    </button>
  </article>`;
}

function libraryRow(w) {
  const picked = state.selected.has(w.key);
  const src = safeImage(w.cover);
  return `<tr>
    <td><input type="checkbox" data-key="${esc(w.key)}" aria-label="Select ${esc(w.title)}" ${picked ? "checked" : ""}></td>
    <td><div class="row-work">${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="thumb"></span>'}
      <div><button data-work="${esc(w.key)}">${esc(w.title)}</button><small>${esc(w.authors.join(", ") || w.title_zh || w.key)}</small></div></div></td>
    <td>${esc(collectionName(w))}</td>
    <td class="num">${w.file_count} / ${w.volume_count}</td>
    <td>${w.ja_count ? `<span class="pill ok">${w.ja_count} Japanese</span>` : '<span class="pill">None</span>'}
      ${w.unverified_count ? `<span class="pill warn">${w.unverified_count} unverified</span>` : ""}</td>
    <td class="num">${esc(day(w.checked_at))}</td>
  </tr>`;
}

async function loadLibrary(force = false) {
  const lib = state.library;
  const params = new URLSearchParams({
    page: lib.page,
    page_size: lib.pageSize,
    query: $("#library-query").value.trim(),
    sort: $("#library-sort").value,
    state: lib.filter,
  });
  if ($("#library-category").value) params.set("category", $("#library-category").value);
  const result = await latestList("library", "/api/works?" + params, $("#library-list"), force);
  if (!result) return;
  const signature = JSON.stringify([result, [...state.selected], state.layout]);
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
      <th>Work</th><th>Collection</th><th>Saved</th><th>Japanese</th><th>Checked</th></tr></thead>
      <tbody>${result.items.map(libraryRow).join("")}</tbody></table></div>`;
  } else {
    list.innerHTML = `<div class="books">${result.items.map(libraryCard).join("")}</div>`;
  }
  applyWidths(list);
  if (force) UI.reveal(list);
  selectionBar();
}

function selectionBar() {
  const onCatalog = state.view === "catalog";
  const set = onCatalog ? state.catalogSelected : state.selected;
  const visible = (state.view === "library" || onCatalog) && set.size > 0;
  UI.show($("#selection-bar"), visible);
  $("#selection-count").textContent = `${plural(set.size, "work")} selected`;
  $("#convert-selected").hidden = onCatalog;
  $("#remove-selected").hidden = onCatalog;
  $("#library-list").classList.toggle("selecting", state.selected.size > 0);
  $("#catalog-list").classList.toggle("selecting", state.catalogSelected.size > 0);
}

/* Catalog */

function catalogCard(w) {
  const key = `wenku/${String(w.id).toLowerCase()}`;
  const picked = state.catalogSelected.has(key);
  const local = w.local
    ? `<span class="pill ${w.local.file_count >= w.local.volume_count && w.local.volume_count ? "ok" : ""}">In library ${w.local.file_count}/${w.local.volume_count}</span>`
    : "";
  return `<article class="book${picked ? " picked" : ""}">
    <label class="pick"><input type="checkbox" data-catalog-key="${esc(key)}" aria-label="Select ${esc(w.title)}" ${picked ? "checked" : ""}></label>
    <button class="book-open" ${w.local ? `data-work="${esc(key)}"` : `data-toggle="${esc(key)}"`}>
      ${cover(w.cover, w.title)}
      <h3 title="${esc(w.title)}">${esc(w.title)}</h3>
      <p class="by" title="${esc(w.titleZh || "")}">${esc(w.titleZh || "")}</p>
    </button>
    <span class="count">${local || "<span></span>"}<a href="${SITE}/wenku/${esc(w.id)}" target="_blank" rel="noopener">Novelia ↗</a></span>
  </article>`;
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
      ? `${plural(result.items.length, "work")} on this page, ${owned} already in your library. Click a cover to select it.`
      : "";
    $("#catalog-page").value = cat.page;
    $("#catalog-page").max = Math.max(1, cat.pages);
    $("#catalog-pages").textContent = `of ${Math.max(1, cat.pages).toLocaleString()}`;
    $("#catalog-total").textContent = `${plural(cat.pages, "page")} at ${result.items.length || "—"} per page`;
    $('[data-action="catalog-prev"]').disabled = cat.page <= 1;
    $('[data-action="catalog-next"]').disabled = cat.page >= cat.pages;
    $("#catalog-list").innerHTML = result.items.length
      ? `<div class="books">${result.items.map(catalogCard).join("")}</div>`
      : '<div class="empty"><h3>No matching works</h3><p>Try another keyword or category.</p></div>';
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
  const extras = [r.volumes && `volumes ${r.volumes}`, r.download === false && j.kind !== "convert" && "metadata only", r.force && "re-download"];
  return [scope, ...extras.filter(Boolean)].join(", ");
}

function taskCard(j) {
  const [, tone] = STATUSES[j.status] || ["", ""];
  const discovering = !j.listing_done && ["full", "range", "incremental"].includes(j.kind) && j.status === "running";
  const progress = discovering
    ? `Reading catalog page ${j.cursor}${j.page_count ? ` of ${j.page_count}` : ""}`
    : j.total ? `${j.done} of ${j.total} done${j.failed ? `, ${j.failed} failed` : ""}`
      : ["running", "queued"].includes(j.status) ? "Waiting to start" : "No items processed";
  const action = ["queued", "running"].includes(j.status)
    ? `<button class="danger" data-cancel="${j.id}" ${j.cancel_requested ? "disabled" : ""}>${j.cancel_requested ? "Stopping…" : "Cancel"}</button>`
    : `${j.status !== "completed" ? `<button data-resume="${j.id}">Resume</button>` : ""}<button class="ghost" data-delete="${j.id}" title="Remove from the list" aria-label="Remove task ${j.id}">✕</button>`;
  return `<article class="task" data-job-id="${j.id}" data-tone="${tone}">
    <div>
      <h3><span class="id">#${j.id}</span>${esc(KINDS[j.kind])} ${pill(j.status)}${j.scheduled ? '<span class="pill">Scheduled</span>' : ""}</h3>
      <p class="meta">${esc(taskScope(j))}. Created ${esc(when(j.created_at))}${j.finished_at ? `, finished ${esc(when(j.finished_at))}` : ""}.</p>
      ${j.error ? `<p class="error-text">${esc(j.error)}</p>` : ""}
    </div>
    <div class="task-progress">
      <span>${esc(progress)}</span>
      <span class="meter"><span data-w="${pct(j.done, j.total)}"></span><span class="m-fail" data-w="${pct(j.failed, j.total)}"></span></span>
      <span class="current">${j.current ? esc(j.current) : "&nbsp;"}</span>
    </div>
    <div class="task-actions"><button data-log="${j.id}">Log</button>${action}</div>
  </article>`;
}

function renderTasks() {
  const signature = JSON.stringify([state.jobs, state.taskFilter]);
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

async function openLog(id) {
  state.log = { id, after: 0 };
  $("#log-content").innerHTML = "";
  $("#task-errors").innerHTML = "";
  $("#log-title").textContent = `#${id} Task log`;
  $("#log-status").textContent = "Loading…";
  UI.openDialog($("#log-dialog"));
  await loadLog();
}

async function loadLog() {
  if (!state.log.id || !$("#log-dialog").open) return;
  const id = state.log.id;
  const j = await api(`/api/jobs/${id}?after=${state.log.after}`);
  if (state.log.id !== id || !$("#log-dialog").open) return;
  $("#log-title").textContent = `#${j.id} ${KINDS[j.kind]}`;
  $("#log-status").innerHTML = `${pill(j.status)} ${esc(taskScope(j))}`;
  $("#task-errors").innerHTML = j.items
    .filter((i) => i.status === "failed")
    .map((i) => `<p class="error-text"><strong>${esc(i.target)}</strong>: ${esc(i.error)}</p>`)
    .join("");
  if (!j.logs.length) return;
  const area = $("#log-dialog");
  const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
  $("#log-content").insertAdjacentHTML(
    "beforeend",
    j.logs.map((l) => `<li class="${esc(l.level)}"><time datetime="${esc(l.created_at)}">${esc(clock(l.created_at))}</time><span>${esc(l.message)}</span></li>`).join(""),
  );
  state.log.after = j.logs[j.logs.length - 1].id;
  if (nearBottom) area.scrollTop = area.scrollHeight;
}

/* Work detail */

function volumeRow(key, volume, files) {
  const name = volume.volume_id.replace(/\.epub$/i, "");
  const t = volume.translated;
  const coverage = t.total ? ENGINES.filter((e) => t[e]).map((e) => `${e} ${t[e]}/${t.total}`).join(", ") : "";
  const status = !files.length
    ? '<span class="pill">Not downloaded</span>'
    : !files.some(f => f.raw_available || f.ja_available)
      ? '<span class="pill warn">Files missing</span>'
    : files.some((f) => f.ja_available && f.verification === "verified")
      ? '<span class="pill ok">Japanese verified</span>'
      : files.some((f) => f.ja_available && f.verification === "unverified")
        ? '<span class="pill warn">Unverified</span>'
        : files.some((f) => f.ja_available)
          ? '<span class="pill ok">Japanese</span>'
          : '<span class="pill">Source only</span>';
  const actions = files.length
    ? files.map((f) => [
        f.raw_available ? `<a href="/api/files/${f.id}/raw" download>${f.mode === "zh-original" ? "Chinese" : "Bilingual"}</a>` : '<span class="error-text">Source missing</span>',
        f.ja_available ? `<a href="/api/files/${f.id}/ja" download>Japanese</a>` : "",
        f.mode !== "zh-original" && f.raw_available ? `<button data-convert-file="${f.id}">${f.ja_available ? "Reconvert" : "Convert"}</button>` : "",
        !f.raw_available && volume.index ? `<button data-download-volume="${volume.index}" data-key="${esc(key)}">Download again</button>` : "",
      ].join("")).join("")
    : volume.index ? `<button data-download-volume="${volume.index}" data-key="${esc(key)}">Download</button>` : "";
  const reports = files
    .filter((f) => f.report?.verification_detail)
    .map((f) => `<p class="report">${esc(f.report.verification_detail)}</p>`)
    .join("");
  const sizes = files.map((f) => `${(f.size / 1048576).toFixed(1)} MB`).join(" + ");
  return `<div class="volume">
    <div>
      <div class="name">${volume.index ? `<span class="muted">${volume.index}.</span> ` : ""}${esc(name)}</div>
      <div class="detail">${status}${volume.chinese_only ? "<span>Chinese upload</span>" : ""}${coverage ? `<span>${esc(coverage)}</span>` : ""}${sizes ? `<span>${sizes}</span>` : ""}${volume.index ? "" : "<span>No longer listed on Novelia</span>"}</div>
    </div>
    <div class="volume-actions">${actions}</div>
    ${reports}
  </div>`;
}

async function openWork(key, show = true) {
  const w = await latestList("detail", "/api/works/" + key, $("#work-detail"));
  if (!w) return;
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
  const bilingual = w.files.some((f) => f.mode !== "zh-original");
  $("#work-detail").innerHTML = `
    <div class="work-summary">
      ${cover(w.cover, w.title)}
      <div class="work-info">
        <h2>${esc(w.title)}</h2>
        ${w.title_zh && w.title_zh !== w.title ? `<p class="alt">${esc(w.title_zh)}</p>` : ""}
      </div>
      <dl class="work-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      <div class="work-actions">
          <button class="primary" data-download-work="${esc(w.key)}">Check and download</button>
          ${bilingual ? `<button data-convert-work="${esc(w.key)}">Convert all volumes</button>` : ""}
          <button class="danger" data-remove-work="${esc(w.key)}">Remove from library</button>
          <a class="button-link" href="${esc(workUrl(w.key))}" target="_blank" rel="noopener">Novelia ↗</a>
      </div>
    </div>
    ${intro ? `<section class="introduction"><div id="intro-wrap" class="intro-wrap"><p class="intro" id="intro">${esc(intro)}</p></div><button class="link intro-toggle" id="intro-toggle" aria-expanded="false" aria-controls="intro-wrap">Read more</button></section>` : ""}
    <section class="volumes">
      <h3>${plural(w.volumes.length, "volume")}, ${new Set(w.files.map((f) => f.volume_id)).size} saved</h3>
      ${volumes.length ? volumes.map((v) => volumeRow(w.key, v, w.files.filter((f) => f.volume_id === v.volume_id))).join("") : '<p class="hint">Novelia lists no uploaded volumes for this work.</p>'}
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

  const running = s.running;
  UI.show($("#now-running"), Boolean(running));
  if (running) {
    const counts = running.total ? `${running.done + running.failed}/${running.total}` : `catalog page ${running.cursor}`;
    $("#now-running-text").textContent = `#${running.id} ${KINDS[running.kind]}: ${counts}${running.current ? ` · ${running.current}` : ""}`;
    $("#now-running-bar").dataset.w = pct(running.done + running.failed, running.total);
    applyWidths($("#now-running"));
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

function renderEngines() {
  const list = $("#engine-list");
  UI.reorder(list, () => state.engines.forEach((engine, index) => {
    let row = $(`[data-engine-name="${engine.name}"]`, list);
    if (!row) {
      row = document.createElement("li");
      row.dataset.engineName = engine.name;
      row.innerHTML = `<label><input type="checkbox"> ${engine.name}</label><button type="button" data-dir="-1" aria-label="Move ${engine.name} up">↑</button><button type="button" data-dir="1" aria-label="Move ${engine.name} down">↓</button>`;
    }
    const input = $("input", row);
    input.dataset.engine = index;
    input.checked = engine.on;
    row.classList.toggle("off", !engine.on);
    $$("button", row).forEach(button => {
      button.dataset.move = index;
      button.disabled = Number(button.dataset.dir) < 0 ? index === 0 : index === state.engines.length - 1;
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
  state.engines = [
    ...settings.translations.map((name) => ({ name, on: true })),
    ...ENGINES.filter((e) => !settings.translations.includes(e)).map((name) => ({ name, on: false })),
  ];
  renderEngines();
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
  if (view === "library") await loadLibrary(true);
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

let removal = { keys: [], cleanup: false };
function openRemoval(keys, cleanup = false, works = state.library.items) {
  removal = { keys, cleanup };
  $("#remove-title").textContent = cleanup ? "Clean missing files" : "Remove from library";
  $("#remove-description").textContent = cleanup
    ? "These works have no remaining source or Japanese EPUBs. Only their library records will be removed; metadata-only works are kept."
    : `Remove ${plural(keys.length, "work")} from your library? Local files are kept unless you select the option below.`;
  $("#remove-items").innerHTML = keys.map(key => `<li>${esc(works.find(w => w.key === key)?.title || key)}</li>`).join("");
  $("#delete-local-files").checked = false;
  $("#delete-files-option").hidden = cleanup;
  UI.openDialog($("#remove-dialog"));
}
$("#remove-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $('[type="submit"]', event.currentTarget);
  if (button.getAttribute("aria-busy") === "true") return;
  UI.pending(button, true, "Removing…");
  try {
    const result = await api(removal.cleanup ? "/api/library/cleanup" : "/api/library/remove", {
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
  "cleanup-library": async () => {
    const { items } = await api("/api/library/missing");
    if (!items.length) return toast("No works with missing local files were found.");
    openRemoval(items.map(w => w.key), true, items);
  },
  "open-crawl": () => {
    crawlFields();
    UI.openDialog($("#crawl-dialog"));
  },
  incremental: () => queue({ kind: "incremental" }),
  "convert-all": () => queue({ kind: "convert" }),
  "download-selected": async () => {
    const set = state.view === "catalog" ? state.catalogSelected : state.selected;
    await queue({ kind: "manual", keys: [...set] });
    set.clear();
    selectionBar();
  },
  "convert-selected": async () => {
    await queue({ kind: "convert", keys: [...state.selected] });
    state.selected.clear();
    selectionBar();
  },
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
  "library-prev": () => { state.library.page--; return loadLibrary(true); },
  "library-next": () => { state.library.page++; return loadLibrary(true); },
  "catalog-prev": () => { state.catalog.page--; return loadCatalog(); },
  "catalog-next": () => { state.catalog.page++; return loadCatalog(); },
  "clear-tasks": async () => {
    const { removed } = await api("/api/jobs/clear", { method: "POST" });
    toast(`Removed ${plural(removed, "completed task")}.`);
    await loadTasks();
  },
};

function togglePick(input, set, key) {
  input.checked ? set.add(key) : set.delete(key);
  input.closest(".book")?.classList.toggle("picked", input.checked);
  selectionBar();
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  const d = button.dataset;
  if (button.id === "sidebar-toggle") {
    setSidebar(document.documentElement.dataset.sidebar !== "collapsed");
    return;
  }
  if (d.close) {
    const dialog = $("#" + d.close);
    if (!dialog.querySelector('[aria-busy="true"]')) await UI.closeDialog(dialog);
    return;
  }
  const mutating = d.cancel || d.resume || d.delete || d.downloadWork || d.downloadVolume || d.convertWork || d.convertFile || ["incremental", "convert-all", "download-selected", "convert-selected", "clear-tasks", "cleanup-library"].includes(d.action);
  if (mutating) UI.pending(button, true);
  try {
    if (d.view) await switchView(d.view);
    else if (d.removeWork) {
      const work = await api(`/api/works/${d.removeWork}`);
      await UI.closeDialog($("#work-dialog"));
      openRemoval([d.removeWork], false, [work]);
    }
    else if (d.work) await openWork(d.work);
    else if (d.toggle) {
      const input = $(`[data-catalog-key="${CSS.escape(d.toggle)}"]`);
      input.checked = !input.checked;
      togglePick(input, state.catalogSelected, d.toggle);
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
    } else if (d.delete) {
      await api(`/api/jobs/${d.delete}`, { method: "DELETE" });
      await loadTasks();
    } else if (d.downloadWork) {
      await UI.closeDialog($("#work-dialog"));
      await queue({ kind: "manual", keys: [d.downloadWork] });
    } else if (d.downloadVolume) {
      await queue({ kind: "manual", keys: [d.key], volumes: d.downloadVolume }, { go: false });
    } else if (d.convertWork) {
      await queue({ kind: "convert", keys: [d.convertWork] }, { go: false });
    } else if (d.convertFile) {
      await queue({ kind: "convert", file_ids: [Number(d.convertFile)], force: true }, { go: false });
    } else if (d.move) {
      const i = Number(d.move), j = i + Number(d.dir);
      [state.engines[i], state.engines[j]] = [state.engines[j], state.engines[i]];
      renderEngines();
      $(`[data-move="${j}"][data-dir="${d.dir}"]`)?.focus();
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
  else if (input.dataset.key && input.type === "checkbox") togglePick(input, state.selected, input.dataset.key);
  else if (input.dataset.catalogKey) togglePick(input, state.catalogSelected, input.dataset.catalogKey);
  else if (input.id === "select-page") {
    state.library.items.forEach((w) => (input.checked ? state.selected.add(w.key) : state.selected.delete(w.key)));
    $$("#library-list [data-key]").forEach((el) => (el.checked = input.checked));
    selectionBar();
  } else if (input.dataset.engine) {
    state.engines[Number(input.dataset.engine)].on = input.checked;
    renderEngines();
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
  const request = { kind, download: form.elements.download.checked, force: form.elements.force.checked };
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
  settings.translations = state.engines.filter(engine => engine.on).map(engine => engine.name);
  if (!settings.translations.length) return toast("Tick at least one translation engine.", true);
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
  if (event.key !== "/" || event.target.matches("input, textarea, select") || $("dialog[open]")) return;
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
  try {
    await loadStatus();
    fillCategories();
    await loadLibrary(true);
  } catch (e) {
    toast(`The local server is not responding: ${e.message}`, true);
  }
  setInterval(refresh, 4000);
})();
