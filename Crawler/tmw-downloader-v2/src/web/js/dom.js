/* Nodes, text and the two ways the page talks back: a toast for what worked,
 * the alert bar for what did not. Nothing here knows about the archive. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* Attributes, text, HTML and listeners in one call: `class`, `text` and `html`
 * are handled by name, `on*` becomes a listener, everything else is an
 * attribute. A null or false value is skipped, so a caller can pass a
 * conditional attribute without building the object twice. */
export function el(tag, attrs, kids) {
  const node = document.createElement(tag);
  for (const key in attrs || {}) {
    const value = attrs[key];
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const kid of [].concat(kids || [])) if (kid) node.appendChild(kid);
  return node;
}

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ENTITIES[c]);

/* The one place the page builds HTML rather than text: a match has to be
 * wrapped mid-string, and everything around it is escaped on the way. */
export function hi(text, needle) {
  const source = String(text == null ? "" : text);
  if (!needle) return esc(source);
  const at = source.toLowerCase().indexOf(needle);
  if (at < 0) return esc(source);
  return esc(source.slice(0, at)) +
         "<mark>" + esc(source.slice(at, at + needle.length)) + "</mark>" +
         esc(source.slice(at + needle.length));
}

export const show = (node, on) => { if (node) node.hidden = !on; };

/* ---------- dates ---------- */

const at = (iso) => new Date(iso);
export const fmtTime = (iso) =>
  at(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
export const fmtDay = (iso) =>
  at(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
export const fmtFull = (iso) => fmtDay(iso) + " " + fmtTime(iso);
export const dayOf = (iso) => at(iso).toDateString();
export const monthOf = (iso) => {
  const when = at(iso);
  return when.getFullYear() + "-" + String(when.getMonth() + 1).padStart(2, "0");
};

/* ---------- the bar, and saying things ---------- */

/* The bar grows a row when there is a note, and its controls wrap on a narrow
 * window, so its height is measured rather than assumed -- everything below it
 * is offset by --bar-h. */
export function sizeBar() {
  const bar = $(".bar");
  const height = bar && Math.round(bar.getBoundingClientRect().height);
  if (height) document.documentElement.style.setProperty("--bar-h", height + "px");
}

let toastTimer = null;
export function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("on"), 1900);
}

/* A toast for things that worked, the alert bar for things that did not: a
 * failure that vanishes after two seconds is a failure you never saw. */
export function alarm(message) {
  $("#alert-text").textContent = message;
  show($("#alert"), true);
  sizeBar();
}

export function clearAlarm() {
  show($("#alert"), false);
  sizeBar();
}

export async function copy(text, said) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    // The clipboard API needs a secure context and a live user gesture; when
    // either is missing the old selection trick still works.
    const pad = el("textarea", { style: "position:fixed;top:-1000px;opacity:0" });
    pad.value = text;
    document.body.appendChild(pad);
    pad.select();
    let copied = false;
    try { copied = document.execCommand("copy"); } catch (e) { copied = false; }
    pad.remove();
    if (!copied) { toast("Could not reach the clipboard"); return false; }
  }
  toast(said);
  return true;
}
