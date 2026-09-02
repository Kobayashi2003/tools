"""What persists about a channel: bookmarks, downloaded files, and fetch reach.

The reach's two edges are *not* stored -- they are the oldest and newest ids in
the cache, and a second copy would drift the first time a run was interrupted.
Only what the cache cannot show is recorded here: whether walking back ever
reached the channel's beginning.
"""

import functools
import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional, Set

def guarded(method):
    """One channel's marks are read and written from more than one thread."""
    @functools.wraps(method)
    def run(self, *args, **kwargs):
        with self.lock:
            return method(self, *args, **kwargs)
    return run


def read_channel_names(path) -> Dict[str, str]:
    """Every channel name this file has been told about, {id: name}.

    Read straight from the file rather than through a ChannelState, because the
    switcher wants the names of channels it has not opened -- and opening one
    means parsing its whole archive.
    """
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    out = {}
    for cid, channel in (data.get("channels") or {}).items():
        name = str((channel or {}).get("name") or "")
        if name:
            out[str(cid)] = name
    return out


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


class ChannelState:
    """One channel's marks, in a file that can hold several. Keyed by channel
    so a second channel does not inherit the first one's place."""

    def __init__(self, path: Path, channel_id: str):
        self.path = Path(path)
        self.channel_id = str(channel_id)
        # Saving is a read-modify-write of a shared file, and a crawl now marks
        # its progress from its own thread while the page ticks files from
        # another. Without this the two interleave and one loses its delta.
        self.lock = threading.RLock()
        self.name: str = ""
        self.taken: Set[str] = set()
        self.bookmarks: Dict[str, str] = {}
        self.history_complete: bool = False
        self.last_sync: Optional[datetime] = None
        # What this instance changed since it last read the file. Saving applies
        # these to whatever is on disk now, rather than overwriting it: a server
        # left running holds a snapshot from when it started, and writing that
        # back wholesale silently discards anything another run did meanwhile.
        self._add_taken: Set[str] = set()
        self._del_taken: Set[str] = set()
        self._add_marks: Dict[str, str] = {}
        self._del_marks: Set[str] = set()
        self.load()

    # -- disk -------------------------------------------------------------

    def _read(self) -> dict:
        if not self.path.exists():
            return {}
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}

    @guarded
    def load(self) -> None:
        channel = self._read().get("channels", {}).get(self.channel_id, {})
        self.name = str(channel.get("name") or "")
        self.taken = set(str(i) for i in channel.get("taken", []))
        self.bookmarks = {str(k): str(v) for k, v in (channel.get("bookmarks") or {}).items()}
        fetch = channel.get("fetch", {})
        self.history_complete = bool(fetch.get("history_complete"))
        self.last_sync = _parse(fetch.get("last_sync"))

    @guarded
    def save(self) -> None:
        """Merge this instance's changes into the file as it stands now.

        Re-reading keeps other channels, and replaying the deltas keeps whatever
        another process wrote to *this* channel while we were holding an older
        picture of it. `history_complete` only ever latches on.
        """
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = self._read()
        channels = data.setdefault("channels", {})
        disk = channels.get(self.channel_id, {})

        taken = set(str(i) for i in disk.get("taken", []))
        taken |= self._add_taken
        taken -= self._del_taken

        marks = {str(k): str(v) for k, v in (disk.get("bookmarks") or {}).items()}
        marks.update(self._add_marks)
        for key in self._del_marks:
            marks.pop(key, None)

        fetch = disk.get("fetch") or {}
        complete = bool(fetch.get("history_complete")) or self.history_complete
        theirs = _parse(fetch.get("last_sync"))
        latest = max([t for t in (theirs, self.last_sync) if t], default=None)

        channels[self.channel_id] = {
            # Whoever last learned a real name wins; nobody ever clears one.
            "name": self.name or str(disk.get("name") or ""),
            "taken": sorted(taken),
            "bookmarks": marks,
            "fetch": {
                "history_complete": complete,
                "last_sync": latest.isoformat() if latest else None,
            },
        }
        # Written aside and moved into place. This is the only file holding
        # anything you cannot re-fetch, and it is rewritten often enough that a
        # process killed mid-write would eventually catch it open.
        handle, temp = tempfile.mkstemp(dir=str(self.path.parent), suffix=".tmp")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as file:
                json.dump(data, file, indent=2, ensure_ascii=False)
            os.replace(temp, self.path)
        except BaseException:
            Path(temp).unlink(missing_ok=True)
            raise

        # Adopt the merged result, so a long-lived process picks up what other
        # runs did instead of drifting further from the file.
        self.taken, self.bookmarks = taken, marks
        self.history_complete, self.last_sync = complete, latest
        self._add_taken.clear(); self._del_taken.clear()
        self._add_marks.clear(); self._del_marks.clear()

    # -- what has been downloaded -----------------------------------------

    @guarded
    def take(self, attachment_ids, on: bool = True) -> int:
        """Tick or untick files. Kept beside the check rather than in the
        browser: clearing site data should not lose what you already fetched."""
        ids = {str(i) for i in attachment_ids if str(i)}
        if not ids:
            return len(self.taken)
        if on:
            self.taken |= ids
            self._add_taken |= ids
            self._del_taken -= ids
        else:
            self.taken -= ids
            self._del_taken |= ids
            self._add_taken -= ids
        self.save()
        return len(self.taken)

    # -- bookmarks ---------------------------------------------------------

    @guarded
    def bookmark(self, message_id: str, on: bool = True, at: str = "") -> dict:
        """A place worth returning to, as many as you like.

        Distinct from the check: the check is one boundary saying where reading
        stopped, a bookmark is a share you want to find again. Keyed by message
        id rather than by time, so it survives anything that shifts the
        timeline around it.
        """
        key = str(message_id)
        if not key:
            return self.bookmarks
        if on:
            stamp = at or self.bookmarks.get(key) or _now().isoformat()
            self.bookmarks[key] = stamp
            self._add_marks[key] = stamp
            self._del_marks.discard(key)
        else:
            self.bookmarks.pop(key, None)
            self._del_marks.add(key)
            self._add_marks.pop(key, None)
        self.save()
        return self.bookmarks

    # -- what this channel is called --------------------------------------

    @guarded
    def note_name(self, name: str) -> None:
        """Remember a name Discord or the config vouched for.

        Names are only knowable online, and only for the guild being read --
        a cached channel from a server you have since left has no other way to
        be anything but a snowflake on screen.
        """
        name = (name or "").strip()
        if not name or name == self.name or name == self.channel_id:
            return
        self.name = name
        self.save()

    # -- the fetch reach --------------------------------------------------

    @guarded
    def note_sync(self, complete: Optional[bool] = None) -> None:
        self.last_sync = _now()
        if complete is not None:
            # Only ever latched on: once the beginning has been seen, a later
            # count-limited backfill stopping early does not un-see it.
            self.history_complete = self.history_complete or complete
        self.save()
