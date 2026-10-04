"""Rate-limited Novelia HTTP client with atomic, validated EPUB downloads."""

import hashlib
import json
import os
import re
import time
import zipfile
from pathlib import Path
from urllib.parse import quote

import requests

from .schema import SITE


class Cancelled(Exception):
    pass


def fingerprint(data):
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def component(text, limit=65):
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", text).strip(" .")[:limit].rstrip(" .")
    if re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM\d|LPT\d)(?:\..*)?", text):
        text = "_" + text
    return text or "untitled"


def validate_epub(path):
    with zipfile.ZipFile(path) as z:
        if z.read("mimetype").strip() != b"application/epub+zip":
            raise ValueError("The response is not an EPUB.")
        if "META-INF/container.xml" not in z.namelist() or not any(n.endswith(".opf") for n in z.namelist()):
            raise ValueError("EPUB package metadata is missing.")
        if z.testzip():
            raise ValueError("EPUB archive is corrupt.")


class Client:
    def __init__(self, config, check=lambda: None):
        self.config, self.check = config, check
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
                                    "Accept": "application/json, text/plain, */*"})
        token = os.environ.get("NOVELIA_TOKEN", "").strip()
        token_path = Path(os.environ.get("NOVELIA_TOKEN_FILE", "token.txt"))
        if not token and token_path.is_file():
            token = token_path.read_text(encoding="utf-8").strip()
        if token:
            self.session.headers["Authorization"] = "Bearer " + token
        if proxy := os.environ.get("NOVELIA_PROXY"):
            self.session.proxies.update(http=proxy, https=proxy)
        self.last_request = 0.0

    def close(self):
        self.session.close()

    def sleep(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.check()
            time.sleep(min(0.2, max(0, deadline - time.monotonic())))

    def get(self, path, **kwargs):
        error = None
        for attempt in range(self.config.retries):
            self.check()
            self.sleep(max(0, self.last_request + self.config.request_delay - time.monotonic()))
            self.last_request = time.monotonic()
            try:
                response = self.session.get(SITE + path, timeout=(15, self.config.timeout), **kwargs)
                if response.status_code in (401, 403):
                    code = response.status_code
                    response.close()
                    raise PermissionError(f"HTTP {code}: access was refused. Check the login token or network access.")
                if response.status_code == 429 or response.status_code >= 500:
                    retry_after = response.headers.get("Retry-After", "")
                    delay = min(120, float(retry_after)) if retry_after.isdigit() else min(30, 2 ** (attempt + 1))
                    error = RuntimeError(f"HTTP {response.status_code} after {attempt + 1} attempts")
                    response.close()
                    if attempt + 1 < self.config.retries:
                        self.sleep(delay)
                    continue
                response.raise_for_status()
                return response
            except (requests.Timeout, requests.ConnectionError) as exc:
                # Request exceptions can embed credentials from a proxy URL; keep diagnostics generic.
                error = RuntimeError(f"Network {type(exc).__name__} after {attempt + 1} attempts")
                if attempt + 1 < self.config.retries:
                    self.sleep(min(30, 2 ** (attempt + 1)))
        raise error or RuntimeError("Request failed")

    def json(self, path, params=None):
        with self.get(path, params=params) as response:
            payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("Unexpected API response: expected an object.")
        return payload

    def listing(self, page, category, query=""):
        result = self.json("/api/wenku", {"page": page - 1, "pageSize": self.config.page_size,
                                          "query": query, "level": category})
        if not isinstance(result.get("items"), list) or not isinstance(result.get("pageNumber"), int):
            raise ValueError("Unexpected catalog response; task checkpoint has not advanced.")
        return result

    def metadata(self, key):
        path = "/api/" + (key if key.startswith("wenku/") else "novel/" + key)
        data = self.json(path)
        title_field = "title" if key.startswith("wenku/") else "titleJp"
        if title_field not in data or (key.startswith("wenku/") and "volumeJp" not in data):
            raise ValueError("Unexpected work metadata; existing records have been preserved.")
        return data

    def download(self, path, destination, params=None):
        destination.parent.mkdir(parents=True, exist_ok=True)
        temp = destination.with_suffix(destination.suffix + ".part")
        try:
            with self.get(path, params=params, stream=True) as response, temp.open("wb") as out:
                expected = response.headers.get("Content-Length")
                size = 0
                digest = hashlib.sha256()
                for chunk in response.iter_content(65536):
                    self.check()
                    if chunk:
                        out.write(chunk)
                        digest.update(chunk)
                        size += len(chunk)
                if not size:
                    raise ValueError("Empty download.")
                if expected and not response.headers.get("Content-Encoding") and size != int(expected):
                    raise ValueError("Download was truncated.")
            validate_epub(temp)
            self.check()
            temp.replace(destination)
            return size, digest.hexdigest()
        finally:
            temp.unlink(missing_ok=True)

    def source(self, key, volume, destination, original=False):
        parts = key.split("/", 1)
        params = [("mode", self.config.source_mode), ("translationsMode", self.config.translations_mode),
                  ("filename", "download.epub")]
        params.extend(("translations", t) for t in self.config.translations)
        if parts[0] == "wenku":
            path = f"/files-wenku/{parts[1]}/{quote(volume, safe='')}" if original else (
                f"/api/wenku/{parts[1]}/file/{quote(volume, safe='')}")
            if original:
                params = None
        else:
            path = "/api/novel/" + key + "/file"
            params.append(("type", "epub"))
            if original:
                params = [("mode", "jp"), ("type", "epub"), ("filename", "reference.epub")]
        return self.download(path, destination, params)
