/* One recommendation, drawn as a card in the grid.
 *
 * Every card is the same size, pinned in the stylesheet, so the virtual list knows a
 * row's height before it draws it. A card is built in two passes: `drawCard` lays out
 * what the index carries, `fillCard` puts in the cover, the state and the buttons when
 * they arrive, and neither changes its size. Everything else about a recommendation
 * (its blurb, its files, what a press found) is in the dock's Details. */

import { el, fmtDay, hi } from "./dom.js";
import { needDetail, setSaved } from "./detail.js";
import { grab } from "./grabs.js";
import { have, state } from "./store.js";

const COVER_PX = 640;

/* Collages are full-size scans; the media host will resize them under the same
 * signature, which is the difference between 40 MB of thumbnails and 1 MB. */
export function thumb(url, px = COVER_PX) {
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

/* What the queue is doing with this one, if anything: a word, and a bar. */
export const WORKING = { queued: "waiting", opening: "asking the bot", working: "downloading" };

export function statusBits(post) {
  const word = state.jobState.get(post.job);
  const task = (state.grabs.tasks || []).find((t) => t.job === post.job);
  if (word && WORKING[word]) {
    const pct = task && task.size ? task.pct : 0;
    return [
      el("span", { class: "state on", text: WORKING[word] + (pct ? ` ${pct}%` : "") }),
      task && task.size ? el("span", { class: "meter" }, [el("span", { style: `width:${Math.max(2, pct)}%` })]) : null,
    ];
  }
  if (word === "failed") return [el("span", { class: "state bad", text: "failed", title: (task || {}).error || "" })];
  if (have(post)) {
    const held = state.held.get(post.job);
    return [el("span", { class: "state got", text: held ? `have ${plural(held.n, "file")}` : "have it", title: held ? held.dir : "" })];
  }
  return [];
}

/* ---------- the cover plate ---------- */

/* The cover, or while it is on its way a shimmer the same size; a post with no
 * cover gets one made of its own title, so the grid has no holes. */
function drawPlate(plate, post) {
  const detail = state.detail.get(post.id);
  const covers = (detail && detail.covers) || [];
  const key = !post.n_covers ? "text" : covers.length ? covers[0].url : detail ? "none" : "wait";
  if (plate.dataset.drawn === key) return;
  plate.dataset.drawn = key;
  plate.textContent = "";
  plate.className = "plate";
  if (key === "text") {
    plate.classList.add("text");
    plate.appendChild(el("span", { class: "plate-title", text: post.title || "untitled" }));
  } else if (key === "wait") {
    plate.classList.add("loading");
  } else if (key === "none") {
    plate.classList.add("gone");
    plate.appendChild(el("span", { class: "plate-note", text: "cover link expired" }));
  } else {
    // The resized copy can 404 where the original still works, so fall back
    // once -- and only once; an expired link fails either way.
    plate.appendChild(el("img", {
      src: thumb(covers[0].url), alt: "", loading: "lazy", decoding: "async",
      onerror: (ev) => {
        const img = ev.target;
        if (img.dataset.fell) {
          img.remove();
          plate.classList.add("gone");
          plate.appendChild(el("span", { class: "plate-note", text: "cover link expired" }));
          return;
        }
        img.dataset.fell = "1";
        img.src = covers[0].url;
      },
    }));
    if (covers.length > 1) plate.appendChild(el("span", { class: "count", text: "+" + (covers.length - 1) }));
  }
  if (post.kind) plate.appendChild(el("span", { class: "kind", text: post.kind }));
  plate.appendChild(el("span", { class: "ribbon", "aria-hidden": "true" }));
}

/* ---------- the two passes ---------- */

export function fillCard(node, post) {
  if (!post) return;
  drawPlate(node.querySelector(".plate"), post);
  // A download that finishes while you look steps the card back at once.
  node.classList.toggle("got", have(post));
  node.classList.toggle("saved", state.saved.has(post.id));

  const line = node.querySelector(".state-line");
  line.textContent = "";
  for (const bit of statusBits(post)) if (bit) line.appendChild(bit);

  const acts = node.querySelector(".c-acts");
  acts.textContent = "";
  const busy = WORKING[state.jobState.get(post.job)];
  const again = have(post);
  acts.appendChild(el("button", {
    class: "get" + (again ? " again" : ""),
    text: again ? "Get again" : "Get",
    title: again ? "Press the button again and fetch it anew (d)"
      : post.hosted ? "Press the bot's button and download what it gives (d)"
      : "Press the bot's button; this one is hosted elsewhere (d)",
    disabled: !!busy,
    // "Get again" is the deliberate second ask: it presses the button even for a
    // job already on disk, which the plain Get declines to spend.
    onclick: (ev) => { ev.stopPropagation(); ev.currentTarget.disabled = true; grab(post, { force: again }); },
  }));
  const on = state.saved.has(post.id);
  acts.appendChild(el("button", {
    class: "save",
    "aria-pressed": on ? "true" : "false",
    "aria-label": "Bookmark",
    title: on ? "Remove the bookmark (b)" : "Bookmark this (b)",
    onclick: (ev) => { ev.stopPropagation(); setSaved(post.id, !state.saved.has(post.id)); },
  }));
}

export function drawCard(post, here) {
  const q = state.filters.q;
  // A search that matched a filename rather than the title says so, or the card
  // would seem not to match at all.
  const inFiles = q && !(post.title || "").toLowerCase().includes(q)
    && (post.titles || []).some((t) => t.toLowerCase().includes(q));
  const top = [
    post.volumes ? `vol ${post.volumes}` : "",
    post.n_titles > 1 ? plural(post.n_titles, "file") : "",
    post.hosted ? "" : "elsewhere",
  ].filter(Boolean);
  const meta = [el("span", { text: fmtDay(post.ts) })];
  if (post.who && !post.who.startsWith("<@")) {
    meta.push(el("button", {
      class: "who", text: "rec. " + post.who, title: `Show only what ${post.who} recommended`,
      onclick: (ev) => { ev.stopPropagation(); document.dispatchEvent(new CustomEvent("tmw:who", { detail: post.who })); },
    }));
  }
  if (post.reactions) meta.push(el("span", { class: "love", text: "♥ " + post.reactions }));

  const card = el("article", {
    class: "card" + (here ? " here" : ""),
    "data-id": post.id,
  }, [
    el("div", { class: "plate" }),
    el("div", { class: "c-body" }, [
      el("div", { class: "c-top" }, [
        el("span", { text: top.join(" · ") }),
        inFiles ? el("span", { class: "hit", text: "match in files" }) : null,
      ]),
      el("h2", { class: "c-title" + (post.title ? "" : " none"), html: post.title ? hi(post.title, q) : "untitled", title: post.title || "" }),
      el("div", { class: "c-meta" }, meta),
      el("div", { class: "c-foot" }, [el("div", { class: "state-line" }), el("div", { class: "c-acts" })]),
    ]),
  ]);
  fillCard(card, post);
  if (post.n_covers) needDetail(post.id);
  return card;
}
