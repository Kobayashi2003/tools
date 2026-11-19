// Stable ordering for display; never recommend a torrent that bundles executables.
export function sortedTorrents(torrents) {
  return [...torrents].sort((a, b) => b.seeders - a.seeders
    || Number(!!a.risky) - Number(!!b.risky) || b.size_bytes - a.size_bytes);
}

export function bestTorrent(torrents) {
  return sortedTorrents(torrents).find((torrent) => torrent.seeders > 0 && !torrent.risky) ?? null;
}

// A signature belongs to one region, so changing flags never remounts its sibling media.
const signatures = new WeakMap();
export function updateRegion(region, signature, build) {
  const key = JSON.stringify(signature);
  if (signatures.get(region) === key) return;
  const scroll = region.scrollTop;
  region.replaceChildren(...[build()].flat().filter(Boolean));
  signatures.set(region, key);
  region.scrollTop = scroll;
}
