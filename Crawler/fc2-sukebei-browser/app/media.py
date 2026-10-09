"""Disk cache for cover images, sample images and preview clips.

The browser loads media through `/media?u=<url>`, so images survive hotlink rules, load once, and
stay available offline. Only the hosts the sources use are allowed — never an open proxy.
"""

import hashlib
import os
import threading
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import requests

from .net import FetchError

ALLOWED_DOMAINS = ("paipancon.com", "fc2.com")       # the domain itself or any subdomain
MAX_REDIRECTS = 3
EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4"}
MAX_BYTES = 40 * 1024 * 1024
MEDIA_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
               ".gif": "image/gif", ".mp4": "video/mp4"}


def allowed(url):
    parts = urlsplit(url or "")
    host = (parts.hostname or "").lower()
    return (parts.scheme in ("http", "https")
            and any(host == d or host.endswith("." + d) for d in ALLOWED_DOMAINS))


def extension(url):
    suffix = Path(urlsplit(url).path).suffix.lower()
    return suffix if suffix in EXTENSIONS else ".bin"


class MediaCache:
    def __init__(self, root, http):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.http = http
        self._locks = {}
        self._guard = threading.Lock()

    def path_for(self, url):
        digest = hashlib.sha1(url.encode("utf-8")).hexdigest()
        return self.root / digest[:2] / (digest + extension(url))

    def media_type(self, path):
        return MEDIA_TYPES.get(path.suffix, "application/octet-stream")

    def _lock(self, key):
        with self._guard:
            return self._locks.setdefault(key, threading.Lock())

    def get(self, url):
        """Return the cached file for `url`, downloading it first if needed."""
        if not allowed(url):
            raise PermissionError("Host not allowed")
        path = self.path_for(url)
        if path.is_file():
            return path
        with self._lock(path.name):
            try:
                if not path.is_file():
                    self._download(url, path)
            finally:
                with self._guard:                         # keep _locks from growing forever
                    self._locks.pop(path.name, None)
        return path

    def _open(self, url):
        """GET `url`, following redirects only to allowed hosts (an fc2.com blog may redirect anywhere)."""
        response = self.http.get(url, stream=True, allow_redirects=False)
        for _ in range(MAX_REDIRECTS):
            if not getattr(response, "is_redirect", False):
                return response
            target = urljoin(url, response.headers.get("Location", ""))
            response.close()
            if not allowed(target):
                raise FetchError(f"Redirected to a host that is not allowed: {urlsplit(target).hostname}")
            url = target
            response = self.http.get(url, stream=True, allow_redirects=False)
        response.close()
        raise FetchError("Too many redirects")

    def _download(self, url, path):
        # Per thread: a lock dropped from _locks may let a second download of the same file start.
        partial = path.with_name(f"{path.name}.{threading.get_ident()}.part")
        response = self._open(url)
        try:
            content_type = response.headers.get("Content-Type", "")
            if content_type.startswith("text/"):
                raise FetchError(f"Expected media, got {content_type}")
            path.parent.mkdir(parents=True, exist_ok=True)
            size = 0
            with open(partial, "wb") as handle:
                for chunk in response.iter_content(64 * 1024):
                    size += len(chunk)
                    if size > MAX_BYTES:
                        break
                    handle.write(chunk)
            if size > MAX_BYTES or size == 0:
                raise FetchError("Empty or oversized media")
            os.replace(partial, path)
        except requests.RequestException as exc:         # connection dropped mid-download
            raise FetchError(f"{type(exc).__name__}: {exc}") from exc
        finally:
            response.close()
            partial.unlink(missing_ok=True)

    def forget(self, urls):
        """Drop cached copies (used by refresh, e.g. to replace placeholder covers)."""
        for url in urls:
            if url and allowed(url):
                self.path_for(url).unlink(missing_ok=True)
