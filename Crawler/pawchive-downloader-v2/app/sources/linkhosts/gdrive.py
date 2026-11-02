"""Google Drive links: shared files and folders, without an API key.

A file opens at `drive.google.com/file/d/<id>/view` and downloads from
`drive.usercontent.google.com/download`; a file too big for the virus scan answers with a
page whose form carries the token for the real download. A folder lists its entries at
`embeddedfolderview`, one level at a time.
"""

import html
import re
from collections.abc import Callable
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests

from ...domain.links import LinkCheck, LinkError
from ...domain.naming import sanitize_component
from .common import CHUNK, TIMEOUT, done_already, filename_of, save, session

HOSTS = ("drive.google.com", "drive.usercontent.google.com", "docs.google.com")
_ID = r"([A-Za-z0-9_-]{10,})"
_FILE_PATH = re.compile(rf"/file/(?:u/\d+/)?d/{_ID}")
_FOLDER_PATH = re.compile(rf"/(?:drive/(?:u/\d+/)?folders|folders)/{_ID}")
_ENTRY_START = '<div class="flip-entry" id="entry-'
_TITLE = re.compile(r'class="flip-entry-title">(.*?)</div>', re.S)
_HREF = re.compile(r'href="([^"]+)"')
_PAGE_TITLE = re.compile(r"<title>(.*?)</title>", re.S)
_SUFFIX = re.compile(r"\s+-\s+Google\s*(?:Drive|ドライブ|云端硬盘|雲端硬碟|드라이브)$")
_FORM = re.compile(r'<form[^>]+id="download-form"[^>]+action="([^"]+)"(.*?)</form>', re.S)
_INPUT = re.compile(r'<input type="hidden" name="([^"]+)" value="([^"]*)"')


def parse(url: str) -> tuple[str, str] | None:
    """('file' | 'folder', id) for a Drive link, None for anything else."""
    u = urlparse(url)
    if u.netloc.lower().removeprefix("www.") not in HOSTS:
        return None
    if m := _FOLDER_PATH.search(u.path):
        return "folder", m.group(1)
    if m := _FILE_PATH.search(u.path):
        return "file", m.group(1)
    ids = parse_qs(u.query).get("id")
    if ids and re.fullmatch(_ID, ids[0]):
        kind = "folder" if "folderview" in u.path else "file"
        return kind, ids[0]
    return None


def folder_entries(page: str) -> list[tuple[str, str, bool]]:
    """(id, name, is_folder) of each entry an `embeddedfolderview` page lists."""
    out = []
    for chunk in page.split(_ENTRY_START)[1:]:
        entry_id, _, body = chunk.partition('"')
        title = _TITLE.search(body)
        href = _HREF.search(body)
        name = html.unescape(title.group(1).strip()) if title else entry_id
        is_folder = bool(href and "/folders/" in href.group(1))
        out.append((entry_id, name, is_folder))
    return out


def page_title(page: str) -> str:
    m = _PAGE_TITLE.search(page)
    title = html.unescape(m.group(1).strip()) if m else ""
    # A file page says "<name> - Google Drive", in the page's own language.
    return _SUFFIX.sub("", title)


class GoogleDrive:
    name = "Google Drive"

    def __init__(self, http: requests.Session | None = None):
        self.http = http or session()

    def handles(self, url: str) -> bool:
        return parse(url) is not None

    # ---- check ----

    def check(self, url: str) -> LinkCheck:
        parsed = parse(url)
        if parsed is None:
            return LinkCheck("unknown", "not a Drive file or folder link")
        kind, item = parsed
        try:
            if kind == "folder":
                resp = self.http.get(
                    "https://drive.google.com/embeddedfolderview",
                    params={"id": item},
                    timeout=TIMEOUT,
                )
            else:
                resp = self.http.get(
                    f"https://drive.google.com/file/d/{item}/view", timeout=TIMEOUT
                )
        except requests.RequestException as e:
            return LinkCheck("unknown", f"network: {e}")
        if resp.status_code == 404:
            return LinkCheck("dead", "not found (deleted, or the link was changed)")
        if "accounts.google.com" in resp.url or resp.status_code in (401, 403):
            return LinkCheck("dead", "not shared publicly (sign-in required)")
        if resp.status_code != 200:
            return LinkCheck("unknown", f"HTTP {resp.status_code}")
        if kind == "folder":
            entries = folder_entries(resp.text)
            folders = sum(1 for e in entries if e[2])
            return LinkCheck(
                "alive",
                f"folder {page_title(resp.text)}: {len(entries) - folders} files"
                + (f", {folders} folders" if folders else ""),
            )
        return LinkCheck("alive", page_title(resp.text))

    # ---- fetch ----

    def fetch(
        self,
        url: str,
        folder: Path,
        progress: Callable[[str], None],
        stopped: Callable[[], bool],
    ) -> list[Path]:
        parsed = parse(url)
        if parsed is None:
            raise LinkError("not a Drive file or folder link")
        kind, item = parsed
        if kind == "file":
            return [self._file(item, folder, progress, stopped)]
        return self._folder(item, folder, progress, stopped, top=True)

    def _folder(
        self,
        item: str,
        folder: Path,
        progress: Callable[[str], None],
        stopped: Callable[[], bool],
        top: bool = False,
    ) -> list[Path]:
        resp = self.http.get(
            "https://drive.google.com/embeddedfolderview", params={"id": item}, timeout=TIMEOUT
        )
        if resp.status_code == 404:
            raise LinkError("folder not found")
        if "accounts.google.com" in resp.url or resp.status_code in (401, 403):
            raise LinkError("folder not shared publicly")
        resp.raise_for_status()
        here = folder / sanitize_component(page_title(resp.text) or item)
        saved = []
        for entry_id, name, is_folder in folder_entries(resp.text):
            if is_folder:
                saved += self._folder(entry_id, here, progress, stopped)
            else:
                saved.append(self._file(entry_id, here, progress, stopped, name))
        if top and not saved:
            raise LinkError("the folder is empty")
        return saved

    def _file(
        self,
        item: str,
        folder: Path,
        progress: Callable[[str], None],
        stopped: Callable[[], bool],
        name: str = "",
    ) -> Path:
        params = {"id": item, "export": "download", "confirm": "t"}
        resp = self.http.get(
            "https://drive.usercontent.google.com/download",
            params=params,
            stream=True,
            timeout=TIMEOUT,
        )
        if resp.status_code == 404:
            raise LinkError(f"{name or item}: file not found")
        resp.raise_for_status()
        if resp.headers.get("content-type", "").startswith("text/html"):
            # Too big to scan, or over quota: the page's form, if any, leads on.
            page = resp.text
            form = _FORM.search(page)
            if not form:
                title = page_title(page) or "an HTML page instead of the file"
                raise LinkError(f"{name or item}: Drive answered {title!r} (quota or no access)")
            resp = self.http.get(
                html.unescape(form.group(1)),
                params=dict(_INPUT.findall(form.group(2))),
                stream=True,
                timeout=TIMEOUT,
            )
            resp.raise_for_status()
        target = folder / filename_of(resp, name or item)
        size = int(resp.headers.get("content-length") or 0) or None
        if done_already(target, size):
            resp.close()
            return target
        progress(f"Drive: {target.name}")
        return save(resp.iter_content(CHUNK), target, stopped, progress, size)
