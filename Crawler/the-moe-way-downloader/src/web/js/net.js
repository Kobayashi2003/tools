/* The calls to the local server.
 *
 * Which channel the page is looking at is sent on every call, so an action can
 * never land on a channel other than the one on screen -- the server keeps a
 * Feed per channel and would otherwise answer for whichever was loaded first. */

import { state } from "./store.js";

export function query(extra) {
  const parts = [];
  if (state.scope.tail !== null) parts.push("tail=" + (state.scope.tail ? "1" : "0"));
  if (state.channel) parts.push("channel=" + encodeURIComponent(state.channel));
  for (const [key, value] of Object.entries(extra || {})) {
    parts.push(key + "=" + encodeURIComponent(value));
  }
  return parts.length ? "?" + parts.join("&") : "";
}

export async function post(path, body) {
  const response = await fetch(path + query(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
  return data;
}

export async function get(path) {
  const response = await fetch(path + query());
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

/* The whole index. Goes through `query` like everything else, so a reload
 * opens the channel you were last looking at rather than the default one. */
export const getIndex = () => get("/api/feed");

/* How far the crawl behind this channel has got. Cheap enough to poll: it
 * carries the coverage counts, not the archive. */
export const getFetch = () => get("/api/fetch");
