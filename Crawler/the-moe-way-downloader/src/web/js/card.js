/* One share, drawn.
 *
 * A card is built in two passes. `drawCard` lays out everything the index
 * carries -- title, counts, placeholder file rows -- so the card is the right
 * height before its links exist. `fillCard` puts the links in when they
 * arrive, without changing that height. */

import { copy, el, fmtFull, hi, toast } from "./dom.js";
import { expired, needDetail, setSaved, setTaken, usable } from "./detail.js";
import { openLightbox } from "./lightbox.js";
import { state } from "./store.js";

const COVER_PX = 300;
const SEND_GAP_MS = 350;      // a burst of twenty should not look like a runaway

/* Covers are full-size scans; the media host will resize them under the same
 * signature, which is the difference between 40 MB of thumbnails and 400 KB. */
function thumb(url, px) {
  try {
    const at = new URL(url);
    at.hostname = "media.discordapp.net";
    at.searchParams.set("format", "webp");
    at.searchParams.set("width", px);
    at.searchParams.set("height", Math.round(px * 1.4));
    return at.toString();
  } catch (err) { return url; }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const seq = (i) => String(i + 1).padStart(2, "0");

/* ---------- rows ---------- */

function tick(row, file, on) {
  row.classList.toggle("took", on);
  const mark = row.querySelector(".n");
  mark.textContent = on ? "✓" : seq(file.index);
  mark.title = on ? "Fetched — click to clear" : "Mark as fetched";
}

function fileRow(post, file, index) {
  file.index = index;
  const dead = expired(post.id);
  const taken = state.taken.has(file.id);

  const row = el("div", { class: "f" + (dead ? " dead" : "") + (taken ? " took" : "") }, [
    el("button", {
      class: "n",
      text: taken ? "✓" : seq(index),
      title: taken ? "Fetched — click to clear" : "Mark as fetched",
      onclick: () => {
        const on = !state.taken.has(file.id);
        setTaken([file.id], on);
        tick(row, file, on);
      },
    }),
    el("span", { class: "nm", html: hi(file.filename, state.filters.q), title: file.filename }),
    el("span", { class: "sz", text: file.size_human }),
    el("a", {
      class: "get",
      href: file.url,
      target: "_blank",
      rel: "noreferrer",
      text: dead ? "stale" : "get",
      title: dead ? "This link has expired — press Refresh to sign a new one" : null,
      onclick: (ev) => {
        if (!usable(post.id)) {
          // The href is stale; ask for a fresh one rather than open it.
          ev.preventDefault();
          needDetail(post.id);
          toast("Re-signing this link — try again in a moment");
          return;
        }
        if (!state.taken.has(file.id)) {
          setTaken([file.id], true);
          tick(row, file, true);
        }
      },
    }),
    el("button", { class: "cp", text: "copy", onclick: () => copy(file.url, "Link copied") }),
  ]);
  return row;
}

function linkRow(link, index) {
  return el("div", { class: "f ext" }, [
    el("span", { class: "n", text: seq(index) }),
    el("a", { class: "nm", href: link.url, target: "_blank", rel: "noreferrer", text: link.url }),
    el("button", { class: "cp", text: "copy", onclick: () => copy(link.url, "Link copied") }),
  ]);
}

/* Hand each file to the browser in turn, through a hidden iframe.
 *
 * Not an anchor with `download`: that attribute is ignored cross-origin, so the
 * link is followed instead and the whole page navigates to the CDN -- which is
 * exactly what happened the first time this was tried. An iframe cannot take
 * the top-level document with it; Discord serves attachments with a
 * Content-Disposition, so the frame turns into a download and nothing moves. */
async function downloadAll(post, detail, button) {
  const files = detail.files || [];
  if (!files.length) return;
  const label = button.textContent;
  button.disabled = true;
  try {
    for (let i = 0; i < files.length; i++) {
      const frame = el("iframe", {
        src: files[i].url, style: "display:none", "aria-hidden": "true",
      });
      document.body.appendChild(frame);
      setTimeout(() => frame.remove(), 60000);
      button.textContent = `sending ${i + 1}/${files.length}`;
      if (i < files.length - 1) await new Promise((done) => setTimeout(done, SEND_GAP_MS));
    }
  } finally {
    button.disabled = false;
    button.textContent = label;
  }

  const fresh = files.map((f) => f.id).filter((id) => !state.taken.has(id));
  if (fresh.length) setTaken(fresh, true);
  // Last, because redrawing the card replaces the button this is running on.
  const card = button.closest(".card");
  if (card) fillCard(card, post);
  toast(`Sent ${plural(files.length, "file")} to the browser`);
}

function saveButton(post) {
  return el("button", {
    class: "save",
    "aria-pressed": state.saved.has(post.id) ? "true" : "false",
    title: "Bookmark this share (b)",
    text: "save",
    onclick: () => setSaved(post.id, !state.saved.has(post.id)),
  });
}

/* ---------- the two passes ---------- */

function drawPlate(plate, covers) {
  // One cover at the full width of the column. Two or three squeezed side by
  // side were too small to recognise a book by, which is the only thing a cover
  // is for; the rest live in the lightbox behind the count.
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

export function fillCard(node, post) {
  const detail = state.detail.get(post.id);
  if (!detail) return;

  const plate = node.querySelector(".plate");
  const files = node.querySelector(".files");
  const tools = node.querySelector(".tools-row");
  if (!files || !tools) return;

  if (plate && detail.covers && detail.covers.length) drawPlate(plate, detail.covers);

  files.textContent = "";
  (detail.files || []).forEach((file, i) => files.appendChild(fileRow(post, file, i)));
  (detail.links || []).forEach((link, i) => files.appendChild(linkRow(link, i)));

  tools.textContent = "";
  tools.appendChild(saveButton(post));

  if ((detail.files || []).length) {
    tools.appendChild(el("button", {
      text: "download " + plural(detail.files.length, "file"),
      onclick: (ev) => downloadAll(post, detail, ev.currentTarget),
    }));
  }

  const every = (detail.files || []).map((f) => f.url)
    .concat((detail.links || []).map((l) => l.url));
  if (every.length) {
    tools.appendChild(el("button", {
      text: "copy " + plural(every.length, "link"),
      onclick: () => copy(every.join("\n"), "Copied " + plural(every.length, "link")),
    }));
  }
  if (detail.discord_url) {
    tools.appendChild(el("a", {
      href: detail.discord_url, target: "_blank", rel: "noreferrer", text: "in discord",
    }));
  }
}

function metaLine(post) {
  const bits = [fmtFull(post.ts), post.poster];
  if (post.n_files) bits.push(plural(post.n_files, "file") + " " + post.size);
  if (post.n_links) bits.push(plural(post.n_links, "link"));
  if (post.parts > 1) bits.push("+" + plural(post.parts - 1, "follow-up"));
  if (post.reactions) bits.push("♥ " + post.reactions);

  const out = [];
  bits.forEach((bit, i) => {
    if (i) out.push(el("span", { class: "sep", text: "/" }));
    out.push(el("span", { text: bit }));
  });
  return out;
}

export function drawCard(post, focused) {
  // Placeholder rows keep the card the right height while its links are in
  // flight, so arriving detail never pushes the page around.
  const waiting = [];
  for (let i = 0; i < post.n_files + post.n_links; i++) {
    waiting.push(el("div", { class: "f wait" }, [
      el("span", { class: "n", text: seq(i) }),
      el("span", { class: "nm", text: " " }),
    ]));
  }

  const card = el("article", {
    class: "card" + (focused ? " here" : "") +
           (state.saved.has(post.id) ? " saved" : "") + (post.n_covers ? "" : " bare"),
    "data-id": post.id,
  }, [
    post.n_covers ? el("div", { class: "plate empty" }) : null,
    el("div", { class: "col" }, [
      el("div", { class: "top" }, [
        post.category ? el("span", { class: "kind", text: post.category }) : null,
        post.author ? el("span", { class: "by", html: hi(post.author, state.filters.q) }) : null,
        el("h2", {
          class: "title" + (post.title ? "" : " none"),
          html: post.title ? hi(post.title, state.filters.q) : "untitled",
        }),
      ]),
      el("div", { class: "line" }, metaLine(post)),
      post.body ? el("p", { class: "body", text: post.body }) : null,
      el("div", { class: "files" }, waiting),
      el("div", { class: "tools-row" }, [saveButton(post)]),
    ]),
  ]);

  if (state.detail.has(post.id)) fillCard(card, post);
  needDetail(post.id);
  return card;
}
