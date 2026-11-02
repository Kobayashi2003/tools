"""Dropbox shared links: files and folders, without an API key.

Every kind of shared link (`/s/`, `/sh/`, `/scl/fi/`, `/scl/fo/`) downloads with `dl=1`: a
file as itself, a folder as one zip Dropbox builds of everything in it. A link that no
longer works answers 200 with an HTML page instead, whose title says why ("File Deleted",
"Error"). Links copied out of HTML may carry `&amp;`, which would hide `rlkey`.
"""

import html
import re
from collections.abc import Callable
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import requests

from ...domain.links import LinkCheck, LinkError
from .common import CHUNK, TIMEOUT, done_already, filename_of, save, session

_KINDS = re.compile(r"^/(?:s|sh|scl/fi|scl/fo)/[^/]+")
_FOLDER = re.compile(r"^/(?:sh|scl/fo)/")
_TITLE = re.compile(r"<title>\s*Dropbox\s*-\s*(.*?)\s*(?:-\s*Simplify your life)?\s*</title>", re.S)


def download_url(url: str) -> str | None:
    """The link with `dl=1`, or None for anything but a Dropbox shared link."""
    u = urlparse(html.unescape(url))
    host = u.netloc.lower().removeprefix("www.")
    if host != "dropbox.com" or not _KINDS.match(u.path):
        return None
    query = {k: v for k, v in parse_qsl(u.query) if k not in ("dl", "raw")}
    return urlunparse(u._replace(scheme="https", query=urlencode({**query, "dl": "1"})))


def is_folder(url: str) -> bool:
    return bool(_FOLDER.match(urlparse(html.unescape(url)).path))


def why_not(resp: requests.Response) -> str:
    """The reason the page a dead link answers with gives in its title."""
    m = _TITLE.search(resp.text)
    return html.unescape(m.group(1)) if m else "an HTML page instead of the file"


def _size(n: int | None) -> str:
    return f"{n / 1e6:.1f} MB" if n else "size unknown"


class Dropbox:
    name = "Dropbox"

    def __init__(self, http: requests.Session | None = None):
        self.http = http or session()

    def handles(self, url: str) -> bool:
        return download_url(url) is not None

    def _open(self, url: str) -> requests.Response:
        dl = download_url(url)
        if dl is None:
            raise LinkError("not a Dropbox shared link")
        return self.http.get(dl, stream=True, timeout=TIMEOUT)

    # ---- check ----

    def check(self, url: str) -> LinkCheck:
        try:
            resp = self._open(url)
        except requests.RequestException as e:
            return LinkCheck("unknown", f"network: {e}")
        except LinkError as e:
            return LinkCheck("unknown", str(e))
        with resp:
            if resp.status_code == 429 or resp.status_code >= 500:
                return LinkCheck(
                    "unknown", f"HTTP {resp.status_code} (busy or over its traffic limit)"
                )
            if resp.status_code in (404, 410):
                return LinkCheck("dead", "not found")
            if resp.status_code != 200:
                return LinkCheck("unknown", f"HTTP {resp.status_code}")
            if resp.headers.get("content-type", "").startswith("text/html"):
                return LinkCheck("dead", why_not(resp))
            size = int(resp.headers.get("content-length") or 0) or None
            kind = "folder, as " if is_folder(url) else ""
            return LinkCheck("alive", f"{kind}{filename_of(resp, 'download')} ({_size(size)})")

    # ---- fetch ----

    def fetch(
        self,
        url: str,
        folder: Path,
        progress: Callable[[str], None],
        stopped: Callable[[], bool],
    ) -> list[Path]:
        resp = self._open(url)
        if resp.status_code in (404, 410):
            resp.close()
            raise LinkError("not found")
        resp.raise_for_status()
        if resp.headers.get("content-type", "").startswith("text/html"):
            reason = why_not(resp)
            resp.close()
            raise LinkError(f"Dropbox answered {reason!r}")
        target = folder / filename_of(resp, "dropbox.zip" if is_folder(url) else "dropbox")
        size = int(resp.headers.get("content-length") or 0) or None
        if done_already(target, size):
            resp.close()
            return [target]
        progress(f"Dropbox: {target.name}")
        return [save(resp.iter_content(CHUNK), target, stopped, progress, size)]
