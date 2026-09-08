/* One recommendation, drawn.
 *
 * A card is built in two passes. `drawCard` lays out everything the index
 * carries -- title, type, the filenames it lists -- so the card is the right
 * height before its cover exists. `fillCard` puts the cover and the tools in
 * when they arrive, without changing that height. */

import { copy, el, fmtFull, hi, toast } from "./dom.js";
import { needDetail, setSaved } from "./detail.js";
import { grab, peek, reveal } from "./grabs.js";
import { openLightbox } from "./lightbox.js";
import { have, state } from "./store.js";

const COVER_PX = 360;

/* Collages are full-size scans; the media host will resize them under the same
 * signature, which is the difference between 40 MB of thumbnails and 400 KB. */
function thumb(url, px) {
  try {
    const at = new URL(url);
    at.hostname = "media.discordapp.net";
    at.searchParams.set("format", "webp");
    at.searchParams.set("width", px);
    at.searchParams.set("height", px);
    return at.toString();
  } catch (err) { return url; }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const seq = (i) => String(i + 1).padStart(2, "0");

/* ---------- the pieces ---------- */

function drawPlate(plate, covers) {
  // One collage at the full width of the column: the bot already lays the
  // volumes out side by side, so a second grid on top of it would only make
  // each cover smaller. The rest live in the lightbox behind the count.
  plate.className = "plate";
  plate.textContent = "";
  const first = covers[0];
  plate.appendChild(el("button", {
    class: "shot",
    title: covers.length > 1 ? `${covers.length} images — click to view` : "View full size",
    onclick: () => openLightbox(covers, 0),
  }, [
    // The resized copy can 404 where the original still works, so fall back
    // once -- and only once. Retrying a link that is simply expired doubles the
    // failures and leaves a broken-image icon either way.
    el("img", {
      src: thumb(first.url, COVER_PX), alt: "", loading: "lazy",
      onerror: (ev) => {
        const img = ev.target;
        if (img.dataset.fell) { img.removeAttribute("src"); img.classList.add("gone"); return; }
        img.dataset.fell = "1";
        img.src = first.url;
      },
    }),
    covers.length > 1 ? el("span", { class: "count", text: "+" + (covers.length - 1) }) : null,
  ]));
}

function titleRows(post) {
  // A post that lists filenames instead of a series title: the list *is* the
  // content, so it is shown rather than folded into a count.
  const rows = [];
  post.titles.forEach((name, i) => {
    rows.push(el("div", { class: "f" }, [
      el("span", { class: "n", text: seq(i) }),
      el("span", { class: "nm", html: hi(name, state.filters.q), title: name }),
    ]));
  });
  return rows;
}

function metaLine(post) {
  const bits = [fmtFull(post.ts)];
  if (post.who) bits.push("rec. " + post.who);
  if (!post.hosted) bits.push("elsewhere");
  if (post.reactions) bits.push("♥ " + post.reactions);
  const out = [];
  bits.forEach((bit, i) => {
    if (i) out.push(el("span", { class: "sep", text: "/" }));
    out.push(el("span", { text: bit }));
  });
  out.push(el("button", {
    class: "job",
    text: post.job,
    title: "The job id — click to copy",
    onclick: () => copy(post.job, "Job id copied"),
  }));
  return out;
}

/* What the queue is doing with this one, if anything. */
const WORKING = { queued: "waiting", opening: "asking the bot", working: "downloading" };

function statusBits(post) {
  const word = state.jobState.get(post.job);
  const task = (state.grabs.tasks || []).find((t) => t.job === post.job);
  if (word && WORKING[word]) {
    const pct = task && task.size ? task.pct : 0;
    return [
      el("span", { class: "state on", text: WORKING[word] + (pct ? ` ${pct}%` : "") }),
      task && task.size ? el("div", { class: "meter" }, [
        el("span", { style: `width:${Math.max(2, pct)}%` }),
      ]) : null,
    ];
  }
  if (word === "failed") {
    return [el("span", { class: "state bad", text: "failed", title: (task || {}).error || "" })];
  }
  if (have(post)) {
    const held = state.held.get(post.job);
    return [el("span", {
      class: "state got",
      text: held ? `have ${plural(held.n, "file")}` : "have it",
      title: held ? held.dir : "",
    })];
  }
  return [];
}

/* ---------- the two passes ---------- */

function saveButton(post) {
  return el("button", {
    class: "save",
    "aria-pressed": state.saved.has(post.id) ? "true" : "false",
    title: "Bookmark this (b)",
    text: "save",
    onclick: () => setSaved(post.id, !state.saved.has(post.id)),
  });
}

/* What a press found, once it has been asked for. Kept beside the card rather
 * than in a dialog: the answer is a short list of filenames, and you asked for
 * it while looking at this card. */
function claimRows(node, post) {
  const claim = state.claims.get(post.job);
  const box = node.querySelector(".claim");
  if (!box) return;
  box.textContent = "";
  if (!claim) return;
  if (claim.files && claim.files.length) {
    for (const file of claim.files) {
      box.appendChild(el("div", { class: "f" }, [
        el("span", { class: "n", text: seq(file.index) }),
        el("span", { class: "nm", text: file.name, title: file.name }),
        el("span", { class: "sz", text: file.size ? human(file.size) : "" }),
      ]));
    }
  }
  for (const url of claim.links || []) {
    box.appendChild(el("div", { class: "f ext" }, [
      el("a", { class: "nm", href: url, target: "_blank", rel: "noreferrer", text: url }),
      el("button", { class: "cp", text: "copy", onclick: () => copy(url, "Link copied") }),
    ]));
  }
  if (!claim.files.length && !(claim.links || []).length && claim.note) {
    box.appendChild(el("div", { class: "note-text", text: claim.note }));
  }
}

function human(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(2) : n} ${units[i]}`;
}

export function fillCard(node, post) {
  const detail = state.detail.get(post.id);
  const plate = node.querySelector(".plate");
  if (plate && detail && detail.covers && detail.covers.length) drawPlate(plate, detail.covers);

  // The card's own class, not only its contents: a download that finishes
  // while you are looking at it should step the card back at once, the way
  // bookmarking colours the edge at once. Left to `drawCard`, it waited for a
  // redraw -- so the tick appeared and the card stayed bright beside it.
  const card = node.classList.contains("card") ? node : node.querySelector(".card");
  if (card) card.classList.toggle("got", have(post));

  const line = node.querySelector(".state-line");
  if (line) {
    line.textContent = "";
    for (const bit of statusBits(post)) if (bit) line.appendChild(bit);
  }
  claimRows(node, post);

  const tools = node.querySelector(".tools-row");
  if (!tools) return;
  tools.textContent = "";
  tools.appendChild(saveButton(post));

  const busy = WORKING[state.jobState.get(post.job)];
  tools.appendChild(el("button", {
    class: "get",
    text: have(post) ? "get again" : "get",
    title: post.hosted
      ? "Press the bot's button and download what it gives"
      : "Press the bot's button; this one is hosted elsewhere",
    disabled: !!busy,
    // "get again" is the deliberate second ask: it presses the button even for
    // a job already on disk, which the plain Get declines to spend.
    onclick: (ev) => {
      ev.currentTarget.disabled = true;
      grab(post, { force: have(post) });
    },
  }));

  tools.appendChild(el("button", {
    text: "look",
    title: "Press the button and list what the job holds, without downloading",
    onclick: async (ev) => {
      const button = ev.currentTarget;
      button.disabled = true;
      button.textContent = "asking…";
      const claim = await peek(post);
      button.disabled = false;
      button.textContent = "look";
      if (claim) toast(claim.files.length
        ? `${plural(claim.files.length, "file")} in this one`
        : "The bot gave a link");
    },
  }));

  if (state.held.has(post.job)) {
    tools.appendChild(el("button", {
      text: "folder", title: state.held.get(post.job).dir,
      onclick: () => reveal(post.job),
    }));
  }

  if (detail && detail.discord_url) {
    tools.appendChild(el("a", {
      href: detail.discord_url, target: "_blank", rel: "noreferrer", text: "in discord",
    }));
  }
}

export function drawCard(post, focused) {
  const card = el("article", {
    class: "card" + (focused ? " here" : "") +
           (state.saved.has(post.id) ? " saved" : "") +
           (have(post) ? " got" : "") + (post.n_covers ? "" : " bare"),
    "data-id": post.id,
  }, [
    post.n_covers ? el("div", { class: "plate empty" }) : null,
    el("div", { class: "col" }, [
      el("div", { class: "top" }, [
        post.kind ? el("span", { class: "kind", text: post.kind }) : null,
        post.volumes ? el("span", { class: "vols", text: post.volumes }) : null,
        el("h2", {
          class: "title" + (post.title ? "" : " none"),
          html: post.title ? hi(post.title, state.filters.q) : "untitled",
        }),
      ]),
      el("div", { class: "line" }, metaLine(post)),
      post.body ? el("p", { class: "body", text: post.body }) : null,
      post.n_titles > 1 ? el("div", { class: "files" }, titleRows(post)) : null,
      el("div", { class: "state-line" }),
      el("div", { class: "claim" }),
      el("div", { class: "tools-row" }, [saveButton(post)]),
    ]),
  ]);

  fillCard(card, post);
  needDetail(post.id);
  return card;
}
