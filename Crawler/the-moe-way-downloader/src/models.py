"""What a post is, once a run of Discord messages has been read as one share.

Discord hands back messages; this channel deals in shares -- a title, its covers
and the files under it. A set of volumes too large for one upload is posted as
several messages, so a Post can span more than one message id.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import List, Optional
from urllib.parse import parse_qs, urlparse

DISCORD_EPOCH_MS = 1420070400000

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"}


def snowflake_time(message_id: str) -> datetime:
    """A Discord id carries its own creation time, so ordering needs no lookup."""
    ms = (int(message_id) >> 22) + DISCORD_EPOCH_MS
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def snowflake_for(moment: datetime) -> str:
    """A date as a cursor: `before`/`after` take ids, not dates, but an id is a
    timestamp with 22 low bits, so zeroing those gives an exact boundary."""
    ms = int(moment.timestamp() * 1000) - DISCORD_EPOCH_MS
    return str(max(0, ms) << 22)


def human_size(size: int) -> str:
    if not size:
        return ""
    step = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if step < 1024 or unit == "GB":
            return f"{step:.0f} B" if unit == "B" else f"{step:.2f} {unit}"
        step /= 1024
    return ""  # unreachable: the loop always returns at GB


def expiry_of(url: str) -> Optional[datetime]:
    """When a signed CDN link dies. `ex` is hex unix seconds; unsigned is None."""
    value = parse_qs(urlparse(url or "").query).get("ex", [None])[0]
    if not value:
        return None
    try:
        return datetime.fromtimestamp(int(value, 16), tz=timezone.utc)
    except ValueError:
        return None


def _ext(name: str) -> str:
    dot = name.rfind(".")
    return name[dot:].lower() if dot > 0 else ""


@dataclass
class FileEntry:
    """One attachment. `url` is signed and expires -- see `expires_at`."""

    attachment_id: str
    filename: str
    size: int = 0
    url: str = ""
    content_type: str = ""
    width: int = 0
    height: int = 0

    @classmethod
    def from_attachment(cls, raw: dict) -> "FileEntry":
        return cls(
            attachment_id=str(raw.get("id", "")),
            filename=raw.get("filename", "") or "",
            size=int(raw.get("size") or 0),
            url=raw.get("url", "") or "",
            content_type=raw.get("content_type", "") or "",
            width=int(raw.get("width") or 0),
            height=int(raw.get("height") or 0),
        )

    @property
    def ext(self) -> str:
        return _ext(self.filename)

    @property
    def is_image(self) -> bool:
        return self.ext in IMAGE_EXTS or self.content_type.startswith("image/")

    @property
    def expires_at(self) -> Optional[datetime]:
        return expiry_of(self.url)

    def is_fresh(self, margin_seconds: int = 900) -> bool:
        expiry = self.expires_at
        if expiry is None:
            return True
        return (expiry - datetime.now(timezone.utc)).total_seconds() > margin_seconds

    def to_json(self) -> dict:
        return {
            "id": self.attachment_id,
            "filename": self.filename,
            "size": self.size,
            "size_human": human_size(self.size),
            "url": self.url,
            "ext": self.ext.lstrip("."),
        }


@dataclass
class Link:
    """A URL found in the message body -- MEGA and friends, not a Discord upload."""

    url: str

    @property
    def host(self) -> str:
        return urlparse(self.url).netloc.replace("www.", "")

    def to_json(self) -> dict:
        return {"url": self.url, "host": self.host}


@dataclass
class Post:
    message_id: str
    author: str = ""
    author_id: str = ""
    timestamp: Optional[datetime] = None

    category: str = ""
    book_author: str = ""
    title: str = ""
    body: str = ""

    covers: List[FileEntry] = field(default_factory=list)
    files: List[FileEntry] = field(default_factory=list)
    links: List[Link] = field(default_factory=list)

    reactions: int = 0
    part_ids: List[str] = field(default_factory=list)

    @property
    def total_size(self) -> int:
        return sum(f.size for f in self.files)

    @property
    def has_payload(self) -> bool:
        return bool(self.files or self.links or self.covers)

    def to_index(self) -> dict:
        """Everything the page needs to lay out and search a post -- but no URLs.

        A complete archive is ~11k posts holding ~26k signed attachment links, and
        those links are most of the weight: with them the index is 17 MB, without
        them it is under two. They are fetched per screenful by `to_detail`, which
        is also when they are worth signing.
        """
        return {
            "id": self.message_id,
            "poster": self.author,
            "ts": self.timestamp.isoformat() if self.timestamp else None,
            "category": self.category,
            "author": self.book_author,
            "title": self.title,
            "body": self.body,
            "n_covers": len(self.covers),
            "n_files": len(self.files),
            "n_links": len(self.links),
            "names": [f.filename for f in self.files],
            "reactions": self.reactions,
            "parts": len(self.part_ids),
            "size": human_size(self.total_size),
        }

    def to_detail(self, config) -> dict:
        # The soonest expiry in the post, so the page can tell when the copy it
        # is holding has gone stale and ask for a fresh one.
        stamps = [e.expires_at for e in list(self.files) + list(self.covers)]
        stamps = [s for s in stamps if s]
        return {
            "id": self.message_id,
            "covers": [{"url": c.url, "name": c.filename} for c in self.covers],
            "files": [f.to_json() for f in self.files],
            "links": [l.to_json() for l in self.links],
            "expires": int(min(stamps).timestamp()) if stamps else 0,
            "discord_url": config.channel_url(self.message_id),
        }
