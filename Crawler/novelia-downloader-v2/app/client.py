"""Novelia HTTP client: shared adaptive pacing, rate-limit backoff, atomic validated EPUB downloads."""

import hashlib
import json
import math
import os
import random
import re
import threading
import time
import zipfile
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import quote

import requests

from .schema import SITE

RATE_LIMIT_CODES = (429, 503)
INTERACTIVE_PATIENCE = 15  # seconds a catalog page view may wait for a cooldown


class Cancelled(Exception):
    pass


class Deferred(Exception):
    """Stop the task now and queue it again at `until`. `counts` marks rate-limit pauses."""

    def __init__(self, message, until, counts=True):
        super().__init__(message)
        self.until, self.counts = until, counts


class TransientError(RuntimeError):
    """A failure that may succeed later: network errors, server errors, interrupted transfers."""


class IncompleteTransfer(TransientError):
    pass


class Rejected(RuntimeError):
    """A permanent HTTP refusal such as 404; retrying will not help."""


def fingerprint(data):
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def component(text, limit=65):
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", text).strip(" .")[:limit].rstrip(" .")
    if re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM\d|LPT\d)(?:\..*)?", text):
        text = "_" + text
    return text or "untitled"


def validate_epub(path):
    try:
        with zipfile.ZipFile(path) as z:
            if z.read("mimetype").strip() != b"application/epub+zip":
                raise ValueError("The response is not an EPUB.")
            if "META-INF/container.xml" not in z.namelist() or not any(n.endswith(".opf") for n in z.namelist()):
                raise ValueError("EPUB package metadata is missing.")
            if z.testzip():
                raise ValueError("EPUB archive is corrupt.")
    except (zipfile.BadZipFile, KeyError):
        raise ValueError("The response is not a valid EPUB.") from None


def retry_after(value, limit=86400):
    """Seconds from a Retry-After header (delta-seconds or HTTP date), or None."""
    value = (value or "").strip()
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()
        except (TypeError, ValueError):
            return None
    return min(limit, max(0.0, seconds))


class Throttle:
    """Pacing shared by every client in the process, so separate tasks and catalog browsing
    cannot keep hitting the site while it is refusing requests."""

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.next_at = 0.0  # monotonic time the next request may start
        self.cooldown_until = 0.0
        self.penalty = 0.0  # extra delay added after rate limiting, decays on success
        self.strikes = 0  # consecutive rate-limit responses

    def cooling(self):
        return max(0.0, self.cooldown_until - self.clock())

    def reserve(self, config, limit=None):
        """Book the next request slot and return how long to wait for it,
        or None without booking when the wait would exceed `limit`."""
        with self.lock:
            now = self.clock()
            start = max(now, self.next_at, self.cooldown_until)
            if limit is not None and start - now > limit:
                return None
            spread = config.request_jitter / 100
            gap = (config.request_delay + self.penalty) * random.uniform(1 - spread, 1 + spread)
            self.next_at = start + max(0.0, gap)
            return start - now

    def success(self):
        with self.lock:
            self.strikes = 0
            self.penalty = max(0.0, self.penalty * 0.9 - 0.05)

    def limited(self, config, hint=None):
        """Record a rate-limit response; return the cooldown in seconds."""
        with self.lock:
            self.strikes += 1
            if config.adaptive_delay:
                ceiling = max(0.0, config.max_delay - config.request_delay)
                self.penalty = min(ceiling, max(config.request_delay, self.penalty * 2))
            backoff = backoff_delay(config, self.strikes)
            if hint is not None:
                backoff = max(backoff, hint)
            self.cooldown_until = max(self.cooldown_until, self.clock() + backoff)
            return backoff


def backoff_delay(config, attempt):
    """Exponential backoff with equal jitter: half fixed, half random."""
    ceiling = min(config.backoff_max, config.backoff_base * 2 ** (attempt - 1))
    return random.uniform(ceiling / 2, ceiling)


THROTTLE = Throttle()


class Client:
    def __init__(self, config, check=lambda: None, on_wait=None, throttle=None, interactive=False):
        self.config, self.check, self.on_wait = config, check, on_wait
        self.throttle = throttle or THROTTLE
        self.interactive = interactive
        self.downloads = 0
        self.rest_due = False
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

    def close(self):
        self.session.close()

    def sleep(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.check()
            time.sleep(min(0.2, max(0, deadline - time.monotonic())))

    def wait(self, seconds, reason):
        """Sleep while publishing the reason, so long pauses are visible in the task list."""
        if seconds <= 0:
            return
        visible = self.on_wait and seconds >= 2
        if visible:
            self.on_wait(datetime.now(timezone.utc) + timedelta(seconds=seconds), reason)
        try:
            self.sleep(seconds)
        finally:
            if visible:
                self.on_wait(None, None)

    def deferral(self, cooling):
        if self.interactive:
            return Deferred(f"Novelia is rate limiting requests; try again in about {math.ceil(cooling)} s.",
                            datetime.now(timezone.utc) + timedelta(seconds=cooling))
        # Never wake before the site's own cooldown (e.g. a long Retry-After) has passed.
        seconds = max(self.config.rate_limit_pause * 60, cooling)
        return Deferred(f"Novelia kept refusing requests for {self.config.rate_limit_patience:g} min; "
                        f"pausing the task for {math.ceil(seconds / 60)} min.",
                        datetime.now(timezone.utc) + timedelta(seconds=seconds))

    def get(self, path, **kwargs):
        patience = INTERACTIVE_PATIENCE if self.interactive else self.config.rate_limit_patience * 60
        limited = 0.0  # time this request has spent cooling down after rate limits
        failures = 0
        if self.rest_due:
            self.rest_due = False
            self.wait(self.config.rest_seconds, f"Resting after {self.downloads} downloads")
        while True:
            self.check()
            if cooling := self.throttle.cooling():
                if limited + cooling > patience:
                    raise self.deferral(cooling)
                self.wait(cooling, "Novelia is rate limiting requests; backing off")
                limited += cooling
            wait = self.throttle.reserve(self.config, INTERACTIVE_PATIENCE if self.interactive else None)
            if wait is None:
                raise Deferred("Novelia requests are being slowed down; try again shortly.",
                               datetime.now(timezone.utc) + timedelta(seconds=INTERACTIVE_PATIENCE))
            self.sleep(wait)
            if self.throttle.cooling():
                continue  # another request was rate limited while this one waited for its slot
            try:
                response = self.session.get(SITE + path, timeout=(self.config.connect_timeout, self.config.timeout),
                                            **kwargs)
            except requests.RequestException as exc:  # includes failures while reading a non-streamed body
                # Request exceptions can embed credentials from a proxy URL; keep diagnostics generic.
                failures += 1
                if failures >= self.config.retries:
                    raise TransientError(f"Network {type(exc).__name__} after {failures} attempts") from None
                self.wait(backoff_delay(self.config, failures), f"Network {type(exc).__name__}; retrying")
                continue
            code = response.status_code
            if code < 400:
                self.throttle.success()
                return response
            hint = retry_after(response.headers.get("Retry-After"))
            response.close()
            if code in RATE_LIMIT_CODES:
                self.throttle.limited(self.config, hint)
                continue
            if code in (401, 403):
                raise PermissionError(f"HTTP {code}: access was refused. Check the login token or network access.")
            if code >= 500 or code == 408:
                failures += 1
                if failures >= self.config.retries:
                    raise TransientError(f"HTTP {code} after {failures} attempts")
                self.wait(max(hint or 0, backoff_delay(self.config, failures)), f"HTTP {code}; retrying")
                continue
            raise Rejected(f"HTTP {code}: " + ("not found on Novelia." if code == 404 else "Novelia rejected the request."))

    def json(self, path, params=None):
        with self.get(path, params=params) as response:
            try:
                payload = response.json()
            except ValueError:
                # Truncated bodies and interstitial HTML pages; a later request may succeed.
                raise TransientError("The API response was not valid JSON.") from None
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

    def transfer(self, path, temp, params):
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
                raise IncompleteTransfer("Empty download.")
            if expected and not response.headers.get("Content-Encoding") and size != int(expected):
                raise IncompleteTransfer("Download was truncated.")
            verified_length = bool(expected and not response.headers.get("Content-Encoding"))
        try:
            validate_epub(temp)
        except ValueError as exc:
            if verified_length:
                raise  # the complete file arrived and is not an EPUB: retrying will not help
            # Without a length to compare, a cut-off transfer only shows up as a broken archive.
            raise IncompleteTransfer(str(exc)) from None
        return size, digest.hexdigest()

    def download(self, path, destination, params=None):
        destination.parent.mkdir(parents=True, exist_ok=True)
        temp = destination.with_suffix(destination.suffix + ".part")
        try:
            for attempt in range(1, self.config.retries + 1):
                try:
                    size, digest = self.transfer(path, temp, params)
                    break
                except (requests.RequestException, IncompleteTransfer) as exc:
                    detail = str(exc) if isinstance(exc, IncompleteTransfer) else type(exc).__name__
                    if attempt >= self.config.retries:
                        raise TransientError(f"Transfer failed after {attempt} attempts: {detail}") from None
                    self.wait(backoff_delay(self.config, attempt), f"Transfer interrupted ({detail}); retrying")
            self.check()
            temp.replace(destination)
        finally:
            temp.unlink(missing_ok=True)
        # The rest happens before the next request, so the caller can record this file first.
        self.downloads += 1
        self.rest_due = bool(self.config.rest_every and self.downloads % self.config.rest_every == 0)
        return size, digest

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
