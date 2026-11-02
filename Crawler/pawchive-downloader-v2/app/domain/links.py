"""Cloud-storage links in a post's text, and the two hooks a host plugs into.

Each link is listed with its post and marked done or skipped, by hand or by a fetch. A
host (Google Drive, MEGA…) plugs in through either hook or both:

  LinkChecker  says whether a link still opens (alive / dead / unknown) and what it holds
  LinkFetcher  saves what a link holds into a folder
  LinkKeyed    for links posted without their key: finds candidates in the post's text and
               tells whether one opens the link

Implementations live in `app/sources/linkhosts/`; `app/engine/links.py` lists them. What a
fetch saves goes in the post's folder under `links/`, beside the post's own files.
"""

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from urllib.parse import urlparse

# Only ASCII URL characters (RFC 3986): Japanese text often follows a link with no space,
# and letting the match run into it produces a host that does not exist.
_URL = re.compile(r"https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+")
# Punctuation that ends a sentence rather than the link.
_TRAILING = ".,;:!?)]'"

LINK_FOLDER = "links"
# `failed`: a check found the link dead. Set by the check itself, and undone by one that
# finds it alive again; a link whose files were fetched stays done.
STATES = ("new", "done", "skipped", "failed")


@dataclass(frozen=True)
class Link:
    url: str
    host: str


def host_of(url: str) -> str:
    try:
        host = urlparse(url).netloc
    except ValueError:
        # urlparse refuses a host that changes under NFKC normalisation; the plain split
        # keeps one odd URL from stopping the rest.
        m = re.match(r"https?://([^/?#]*)", url)
        host = m.group(1) if m else ""
    host = host.lower().rsplit("@", 1)[-1].split(":", 1)[0]
    return host[4:] if host.startswith("www.") else host


def find_links(text: str, domains: Iterable[str]) -> list[Link]:
    """The links in `text` whose host or URL contains one of `domains`, first occurrence
    first, each once."""
    wanted = [d.lower() for d in domains if d]
    out: dict[str, Link] = {}
    for raw in _URL.findall(text or ""):
        url = raw.rstrip(_TRAILING)
        host = host_of(url)
        if url in out or not any(d in host or d in url.lower() for d in wanted):
            continue
        out[url] = Link(url, host)
    return list(out.values())


# ---------------------------------------------------------------- hooks

CHECK_STATES = ("alive", "dead", "unknown")


@dataclass(frozen=True)
class LinkCheck:
    state: str
    """alive: it opens; dead: gone, taken down or closed to us; unknown: could not tell
    (the host refused for now, a network error)."""
    note: str = ""
    """What it holds (a name, a size, a file count), or why it is dead or unknown."""


class LinkError(Exception):
    """A fetch or check that failed for a reason worth showing (dead link, no key, quota)."""


class LinkHook(Protocol):
    name: str

    def handles(self, url: str) -> bool: ...


class LinkChecker(LinkHook, Protocol):
    """Tells whether one kind of link still opens."""

    def check(self, url: str) -> LinkCheck: ...


class LinkFetcher(LinkHook, Protocol):
    """Downloads what one kind of link points at."""

    def fetch(
        self,
        url: str,
        folder: Path,
        progress: Callable[[str], None],
        stopped: Callable[[], bool],
    ) -> list[Path]:
        """Save the link's files under `folder` (created as needed) and return them. A file
        already there at its full size is kept, so a fetch run again resumes. Raises
        `LinkError` for a link that cannot be fetched, `Cancelled` once `stopped()`."""
        ...


class LinkKeyed(LinkHook, Protocol):
    """A host whose links can be posted without the key that opens them (MEGA): the key
    may sit elsewhere in the post's text, or the user types it in."""

    def needs_key(self, url: str) -> bool:
        """The link carries no key of its own."""
        ...

    def with_key(self, url: str, key: str) -> str:
        """The link with `key` put in."""
        ...

    def key_candidates(self, url: str, text: str) -> list[str]:
        """Keys `text` may hold for `url`, likeliest first."""
        ...

    def key_works(self, url: str) -> bool:
        """The key in `url` opens it (asks the host)."""
        ...


def pick[T: LinkHook](hooks: Iterable[T], url: str) -> T | None:
    """The first hook that takes `url`."""
    return next((h for h in hooks if h.handles(url)), None)


def link_folder(post_folder: Path) -> Path:
    return post_folder / LINK_FOLDER
