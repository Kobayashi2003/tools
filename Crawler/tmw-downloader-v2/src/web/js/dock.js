/* The dock: the panel beside the grid, with three tabs.
 *
 * Details is the chosen recommendation in full -- its covers at a size you can read,
 * its blurb, its files and what a press found. Queue is the download queue, Marks
 * the bookmarks. Wide, the dock is always there; narrower, it slides over the grid
 * when a card or a tab asks for it. */

import { $, $$, copy, el, fmtFull, hi } from "./dom.js";
import { setSaved } from "./detail.js";
import { grab, peek, reveal } from "./grabs.js";
import { openLightbox } from "./lightbox.js";
import { have, state } from "./store.js";
import { statusBits, thumb, WORKING } from "./card.js";
import * as feed from "./feed.js";

const WIDE = "(min-width: 1500px)";
let tab = "detail";

export const dockFixed = () => matchMedia(WIDE).matches;
export const dockShown = () => dockFixed() || document.body.classList.contains("dock-open");
export const currentTab = () => tab;

export function showTab(name) {
  tab = name;
  for (const button of $$(".dock-tab")) button.setAttribute("aria-selected", button.dataset.tab === name ? "true" : "false");
  for (const panel of $$(".dock-panel")) panel.hidden = panel.dataset.tab !== name;
}

export function openDock(name) {
  if (name) showTab(name);
  document.body.classList.add("dock-open");
}

export function closeDock() {
  document.body.classList.remove("dock-open");
}

/* ---------- Details ---------- */

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function human(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(2) : n} ${units[i]}`;
}
const section = (title, kids, extra = "") => el("section", { class: "d-sec" + extra }, [el("h3", { text: title }), ...kids]);

function emptyDetail() {
  return el("div", { class: "empty-state" }, [
    el("span", { class: "es-mark", text: "◧" }),
    el("span", { class: "es-t", text: "Choose a recommendation" }),
    el("span", { class: "es-h", html: "Click a card, or press <kbd>j</kbd> / <kbd>k</kbd>. Its covers, blurb and files show here." }),
  ]);
}

/* The covers, each at the dock's width. Rebuilt only when the post or its covers
 * change, so the queue's progress ticks never make the images flicker. */
function drawCovers(box, post) {
  const detail = state.detail.get(post.id);
  const covers = (detail && detail.covers) || [];
  const key = `${post.id}|${!post.n_covers ? "text" : detail ? covers.map((c) => c.url).join(" ") || "none" : "wait"}`;
  if (box.dataset.drawn === key) return;
  box.dataset.drawn = key;
  box.textContent = "";
  if (!post.n_covers) {
    box.appendChild(el("div", { class: "d-shot text" }, [el("span", { class: "plate-title", text: post.title || "untitled" })]));
  } else if (!detail) {
    box.appendChild(el("div", { class: "d-shot loading" }));
  } else if (!covers.length) {
    box.appendChild(el("div", { class: "d-shot gone" }, [el("span", { class: "plate-note", text: "The cover links have expired" })]));
  } else {
    covers.forEach((cover, i) => {
      const shot = el("button", { class: "d-shot loading", title: "View full size", onclick: () => openLightbox(covers, i) });
      shot.appendChild(el("img", {
        src: thumb(cover.url, 1200), alt: cover.name || "", decoding: "async",
        onload: () => shot.classList.remove("loading"),
        onerror: (ev) => {
          const img = ev.target;
          if (!img.dataset.fell) { img.dataset.fell = "1"; img.src = cover.url; return; }
          shot.classList.remove("loading");
          shot.classList.add("gone");
          img.remove();
          shot.appendChild(el("span", { class: "plate-note", text: "This cover's link has expired" }));
        },
      }));
      box.appendChild(shot);
    });
  }
}

function actions(post) {
  const detail = state.detail.get(post.id);
  const busy = WORKING[state.jobState.get(post.job)];
  const again = have(post);
  const on = state.saved.has(post.id);
  return el("div", { class: "d-acts" }, [
    el("button", {
      class: "act primary", text: busy ? WORKING[busy] || busy : again ? "Get again" : "Get", disabled: !!busy,
      title: again ? "Press the button again and fetch it anew (d)" : "Press the bot's button and download what it gives (d)",
      onclick: () => grab(post, { force: again }),
    }),
    el("button", {
      class: "act", text: "Look", title: "Press the button and list what the job holds, without downloading (Enter)",
      onclick: async (ev) => { const b = ev.currentTarget; b.disabled = true; b.textContent = "Asking…"; await peek(post); b.disabled = false; b.textContent = "Look"; },
    }),
    state.held.has(post.job) ? el("button", { class: "act", text: "Open folder", title: state.held.get(post.job).dir, onclick: () => reveal(post.job) }) : null,
    detail && detail.discord_url ? el("a", { class: "act", href: detail.discord_url, target: "_blank", rel: "noreferrer", text: "In Discord ↗" }) : null,
    el("button", {
      class: "act save-act", "aria-pressed": on ? "true" : "false", text: on ? "Bookmarked" : "Bookmark",
      title: "Bookmark (b)", onclick: () => setSaved(post.id, !state.saved.has(post.id)),
    }),
  ]);
}

/* What the post lists, what a press found, and where the queue has got to. */
function files(post) {
  const out = [];
  if (post.n_titles > 1) {
    out.push(section(`Files the post lists (${post.n_titles})`, [el("div", { class: "files" }, post.titles.map((name, i) => el("div", { class: "f" }, [
      el("span", { class: "n", text: String(i + 1).padStart(2, "0") }),
      el("span", { class: "nm", html: hi(name, state.filters.q), title: name }),
    ])))]));
  }
  const claim = state.claims.get(post.job);
  if (claim) {
    const rows = [];
    for (const file of claim.files || []) {
      rows.push(el("div", { class: "f" }, [
        el("span", { class: "n", text: String(file.index + 1).padStart(2, "0") }),
        el("span", { class: "nm", text: file.name, title: file.name }),
        el("span", { class: "sz", text: file.size ? human(file.size) : "" }),
      ]));
    }
    for (const url of claim.links || []) {
      rows.push(el("div", { class: "f ext" }, [
        el("span", { class: "n", text: "↗" }),
        el("a", { class: "nm", href: url, target: "_blank", rel: "noreferrer", text: url }),
        el("button", { class: "cp", text: "Copy", onclick: () => copy(url, "Link copied") }),
      ]));
    }
    if (!rows.length && claim.note) rows.push(el("div", { class: "note-text", text: claim.note }));
    out.push(section("What the bot holds", [el("div", { class: "files" }, rows)]));
  }
  const task = (state.grabs.tasks || []).find((t) => t.job === post.job);
  if (task && task.files && task.files.length) {
    out.push(section("Download", [el("div", { class: "files" }, task.files.map((f) => el("div", { class: "f grab-f " + f.state }, [
      el("span", { class: "nm", text: f.name, title: f.path || f.name }),
      el("span", { class: "sz", text: f.size_human || "" }),
      el("span", { class: "st", text: f.state === "held" ? "on disk" : f.state }),
    ])))]));
  }
  return out;
}

function info(post) {
  const facts = [el("span", { text: fmtFull(post.ts) })];
  if (post.who && !post.who.startsWith("<@")) {
    facts.push(el("button", {
      class: "who", text: "rec. " + post.who, title: `Show only what ${post.who} recommended`,
      onclick: () => document.dispatchEvent(new CustomEvent("tmw:who", { detail: post.who })),
    }));
  }
  if (post.reactions) facts.push(el("span", { text: "♥ " + post.reactions }));
  facts.push(el("span", { text: post.hosted ? "hosted" : "hosted elsewhere" }));
  facts.push(el("button", { class: "job", text: post.job, title: "The job id: click to copy (c)", onclick: () => copy(post.job, "Job id copied") }));

  const status = statusBits(post);
  const held = state.held.get(post.job);
  return [
    el("div", { class: "d-kind" }, [
      post.kind_full || post.kind ? el("span", { class: "kind", text: post.kind || post.kind_full, title: post.kind_full || "" }) : null,
      post.volumes ? el("span", { class: "vols", text: "vol " + post.volumes }) : null,
      post.n_titles > 1 ? el("span", { class: "vols", text: plural(post.n_titles, "file") }) : null,
    ]),
    el("h2", { class: "d-title", html: post.title ? hi(post.title, state.filters.q) : "untitled" }),
    post.blurb ? el("blockquote", { class: "d-blurb", text: post.blurb }) : null,
    el("div", { class: "d-facts" }, facts),
    actions(post),
    status.length || held ? el("div", { class: "d-state" }, [
      ...status,
      held ? el("span", { class: "d-dir", text: held.dir, title: held.dir }) : null,
    ]) : null,
    post.body ? section("Description", [el("p", { class: "d-body", text: post.body })]) : null,
    ...files(post),
  ].filter(Boolean);
}

/* Redraws the chosen post. The covers and the text are kept apart, so only the
 * text is rebuilt when the queue or a press says something new. */
export function paintDetail() {
  const box = $("#dock-detail");
  if (!box) return;
  const post = feed.focused();
  if (!post) {
    box.dataset.post = "";
    if (!box.querySelector(".empty-state")) box.replaceChildren(emptyDetail());
    return;
  }
  if (box.dataset.post !== post.id) {
    box.dataset.post = post.id;
    box.replaceChildren(el("div", { class: "d-covers" }), el("div", { class: "d-info" }));
    box.closest(".dock-panel").scrollTop = 0;
  }
  drawCovers(box.querySelector(".d-covers"), post);
  box.querySelector(".d-info").replaceChildren(...info(post));
}
