"""The raw messages, kept on disk between runs.

Raw is the point: a parsing change should be a restart, not a refetch of a
year's history. Stored as Discord returned it, minus the fields nothing reads.
"""

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Dict, List, Optional

# A crawl adds messages a page at a time, and this file is megabytes: writing on
# every page would spend the whole crawl rewriting the archive. Batched, with a
# forced write whenever a unit of work finishes -- see `Feed.flush`.
WRITE_EVERY = 15.0

# Discord returns a great deal per message; these are the fields the parser and
# the page actually read.
KEEP = ("id", "type", "content", "author", "attachments", "reactions",
        "embeds", "message_snapshots")


def _slim(raw: dict) -> dict:
    message = {k: raw[k] for k in KEEP if k in raw}
    author = message.get("author") or {}
    message["author"] = {k: author.get(k) for k in
                         ("id", "username", "global_name", "bot")}
    message["attachments"] = [
        {k: a.get(k) for k in ("id", "filename", "size", "url", "content_type",
                               "width", "height")}
        for a in raw.get("attachments") or []
    ]
    message["reactions"] = [{"count": r.get("count")} for r in raw.get("reactions") or []]
    message["embeds"] = [_slim_embed(e) for e in raw.get("embeds") or []]
    # A forwarded message carries its original in a snapshot rather than in its
    # own content, so a channel migrated by forwarding would otherwise arrive
    # completely empty.
    snaps = []
    for snap in raw.get("message_snapshots") or []:
        inner = snap.get("message") or {}
        snaps.append({"message": {
            "content": inner.get("content"),
            "attachments": [{k: a.get(k) for k in
                             ("id", "filename", "size", "url", "content_type")}
                            for a in inner.get("attachments") or []],
            "embeds": [_slim_embed(e) for e in inner.get("embeds") or []],
        }})
    if snaps:
        message["message_snapshots"] = snaps
    else:
        message.pop("message_snapshots", None)
    return message


def _slim_embed(embed: dict) -> dict:
    out = {k: embed.get(k) for k in ("url", "title", "description") if embed.get(k)}
    for key in ("image", "thumbnail"):
        src = (embed.get(key) or {}).get("url")
        if src:
            out[key] = {"url": src}
    return out


class MessageCache:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.messages: Dict[str, dict] = {}
        self._dirty = False
        self._saved_at = 0.0
        self.load()

    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            # A half-written cache is worth less than a clean refetch.
            return
        for message in data.get("messages", []):
            self.messages[str(message["id"])] = message

    def save(self, force: bool = False) -> None:
        """Write the archive out. Throttled unless forced: a crawl calls this
        after every page, and only the last of them has to land."""
        if not self._dirty:
            return
        if not force and time.time() - self._saved_at < WRITE_EVERY:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "messages": [self.messages[i] for i in self.sorted_ids()],
        }
        # Written aside and moved into place: an interrupted run must not leave
        # the cache truncated.
        handle, temp = tempfile.mkstemp(dir=str(self.path.parent), suffix=".tmp")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as file:
                json.dump(payload, file, ensure_ascii=False)
            os.replace(temp, self.path)
        except BaseException:
            Path(temp).unlink(missing_ok=True)
            raise
        self._dirty = False
        self._saved_at = time.time()

    def sorted_ids(self) -> List[str]:
        return sorted(self.messages, key=int)

    def add(self, messages: List[dict]) -> int:
        """Store messages, returning how many were not already held."""
        added = 0
        for raw in messages:
            key = str(raw["id"])
            if key not in self.messages:
                added += 1
            self.messages[key] = _slim(raw)
        if messages:
            self._dirty = True
        return added

    def all(self) -> List[dict]:
        return [self.messages[i] for i in self.sorted_ids()]

    # Both edges are read on every payload; sorting 22k ids to look at one of
    # them was pure waste, and `max`/`min` answer in one pass.
    @property
    def newest_id(self) -> Optional[str]:
        return max(self.messages, key=int, default=None)

    @property
    def oldest_id(self) -> Optional[str]:
        return min(self.messages, key=int, default=None)

    def __len__(self) -> int:
        return len(self.messages)
