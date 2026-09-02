/* Covers at full size. Opened from a card, stepped with the arrow keys. */

import { $, el, show } from "./dom.js";

let lit = { covers: [], at: 0 };

export const isLightboxOpen = () => !$("#light").hidden;

export function openLightbox(covers, at = 0) {
  lit = { covers: covers || [], at };
  paint();
  show($("#light"), true);
}

export function closeLightbox() {
  show($("#light"), false);
  $("#light-body").textContent = "";   // stop the download, drop the bitmap
}

export function stepLightbox(by) {
  if (!lit.covers.length) return;
  lit.at = (lit.at + by + lit.covers.length) % lit.covers.length;
  paint();
}

function paint() {
  const box = $("#light-body");
  box.textContent = "";
  const cover = lit.covers[lit.at];
  if (!cover) return;
  box.appendChild(el("img", { src: cover.url, alt: cover.name || "" }));
  const many = lit.covers.length > 1;
  $("#light-count").textContent = many ? `${lit.at + 1} / ${lit.covers.length}` : "";
  show($("#light-prev"), many);
  show($("#light-next"), many);
  $("#light-open").href = cover.url;
}
