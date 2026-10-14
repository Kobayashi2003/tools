"""How a post's declared entries become downloadable files."""

from collections.abc import Mapping
from pathlib import PurePosixPath
from typing import Any

from .models import Artist, Config, Post


def get_config_value(artist: Artist, config: Config, key: str, default=None) -> Any:
    """Resolve a config value, letting the artist override the global config."""
    return artist.config.get(key, getattr(config, key, default))


def file_name_of(entry: Mapping) -> str:
    """Filename for an entry.

    Attachments often arrive with only a `path`. Falling back to a constant
    would give every such file in a post the same name; the content-hash
    basename is unique and carries the real extension.
    """
    name = (entry.get("name") or "").strip()
    if name:
        return name
    return PurePosixPath(entry.get("path") or "").name or "attachment"


def entries_of_parts(file: Mapping | None, attachments: list | None) -> list[Mapping]:
    """A main file plus its attachments, as raw entries."""
    entries = ([file] if file else []) + list(attachments or [])
    return [e for e in entries if isinstance(e, Mapping) and e]


def entries_of(post: Post) -> list[Mapping]:
    """A post's main file plus its attachments."""
    return entries_of_parts(post.file, post.attachments)


def distinct(entries: list[Mapping]) -> list[dict]:
    """One entry per distinct `path`, in order; entries without a path drop out.

    Pawchive lists the cover as both `file` and `attachments[0]` on ~5% of posts.
    `path` is a content hash, so a repeat is the same bytes: fetch it once, and
    never let the repeat inflate a file count.
    """
    seen, out = set(), []
    for e in entries:
        path = e.get("path")
        if path and path not in seen:
            seen.add(path)
            out.append({"name": file_name_of(e), "path": path})
    return out


def extract_files(post: Post) -> list[dict]:
    """`[{'name', 'path'}, ...]` for a post's downloadable files."""
    return distinct(entries_of(post))


def unusable_files(post: Post) -> list[str]:
    """Entries with no `path`. Reported, not dropped, so the post stays undone."""
    return [file_name_of(e) for e in entries_of(post) if not e.get("path")]
