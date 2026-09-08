"""What a post is, once a bot message has been read as one recommendation.

The channel no longer carries files. Every post is written by 田中先生 to a fixed
shape -- a blurb, some labelled fields, one or more cover collages, and a job id
-- and the files sit behind a button on the message. So a Rec is that record:
what the book is, who put it up, and the job id the button trades for a link.
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
    """One attachment -- here always a cover. `url` is signed and expires."""

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
        return {"id": self.attachment_id, "name": self.filename, "url": self.url}


@dataclass
class Rec:
    """One recommendation: a book, and the job id that leads to its files."""

    message_id: str
    author: str = ""            # the bot that posted it
    author_id: str = ""
    timestamp: Optional[datetime] = None

    blurb: str = ""             # "This one was pretty fun"
    recommender: str = ""       # "Anon", a name, or a raw <@id>
    recommender_id: str = ""
    kind: str = ""              # as written: "Light Novel LN ラノベ ライトノベル"
    label: str = ""             # folded for the chips: "Light Novel"
    title: str = ""             # Series title
    titles: List[str] = field(default_factory=list)   # Book titles, when listed
    volumes: str = ""
    description: str = ""

    job: str = ""
    custom_id: str = ""         # the button on the message, verbatim

    covers: List[FileEntry] = field(default_factory=list)
    reactions: int = 0

    @property
    def hosted(self) -> bool:
        """Whether the files are on the bot's own reader rather than elsewhere.

        The button says so outright; the `tp_` prefix on the job id is the same
        fact written twice, and is only a fallback for a message whose
        components were dropped somewhere along the way.
        """
        if self.custom_id:
            return self.custom_id != "third_party_download"
        return not self.job.startswith("tp_")

    @property
    def has_payload(self) -> bool:
        return bool(self.job)

    def to_index(self) -> dict:
        """Everything the page needs to lay out and search a post -- but no
        cover URLs, which are signed, expire, and are most of the weight."""
        return {
            "id": self.message_id,
            "ts": self.timestamp.isoformat() if self.timestamp else None,
            "poster": self.author,
            "blurb": self.blurb,
            "who": self.recommender,
            "who_id": self.recommender_id,
            "kind": self.label,
            "kind_full": self.kind,
            "title": self.title,
            "titles": self.titles,
            "volumes": self.volumes,
            "body": self.description,
            "job": self.job,
            "hosted": self.hosted,
            "n_covers": len(self.covers),
            "n_titles": len(self.titles),
            "reactions": self.reactions,
        }

    def to_detail(self, config) -> dict:
        # The soonest expiry among the covers, so the page can tell when the
        # copy it is holding has gone stale and ask for a fresh one.
        stamps = [c.expires_at for c in self.covers]
        stamps = [s for s in stamps if s]
        return {
            "id": self.message_id,
            "covers": [c.to_json() for c in self.covers],
            "expires": int(min(stamps).timestamp()) if stamps else 0,
            "discord_url": config.channel_url(self.message_id),
        }
