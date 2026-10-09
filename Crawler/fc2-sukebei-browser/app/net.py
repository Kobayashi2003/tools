"""HTTP access shared by every source: one session, per-host pacing, retries with backoff."""

import email.utils
import random
import threading
import time
from urllib.parse import urlsplit

import requests

USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/140.0 Safari/537.36")
RETRY_STATUS = {408, 429, 500, 502, 503, 504, 520, 521, 522, 524}


class FetchError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class NotFound(FetchError):
    pass


def _retry_after(response):
    value = (response.headers.get("Retry-After") or "").strip()
    if not value:
        return None
    if value.isdigit():
        return float(value)
    try:
        return max(0.0, email.utils.parsedate_to_datetime(value).timestamp() - time.time())
    except (TypeError, ValueError):
        return None


class Http:
    """A requests session whose calls to the same host are spaced `delay` seconds apart.

    `delays` overrides the spacing for specific hosts. Pacing is shared by every thread
    using this instance, so parallel workers never burst a single site.
    """

    def __init__(self, delay=0.5, delays=None, attempts=4, timeout=30, proxy=None):
        self.delay = delay
        self.delays = dict(delays or {})
        self.attempts = attempts
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
        })
        if proxy:
            self.session.proxies.update({"http": proxy, "https": proxy})
        self._next_slot = {}
        self._lock = threading.Lock()
        self.on_retry = None          # optional callback(host, error, wait_seconds) for logging

    def _wait_turn(self, host):
        delay = self.delays.get(host, self.delay)
        with self._lock:
            now = time.monotonic()
            slot = max(now, self._next_slot.get(host, 0.0))
            self._next_slot[host] = slot + delay
        if slot > now:
            time.sleep(slot - now)

    def _cool_down(self, host, seconds):
        with self._lock:
            self._next_slot[host] = max(self._next_slot.get(host, 0.0), time.monotonic() + seconds)

    def get(self, url, **kwargs):
        """GET with retries. Raises NotFound on 404/410 and FetchError on other failures."""
        host = urlsplit(url).hostname or ""
        kwargs.setdefault("timeout", self.timeout)
        last_error = None
        for attempt in range(self.attempts):
            self._wait_turn(host)
            try:
                response = self.session.get(url, **kwargs)
            except requests.RequestException as exc:
                last_error = FetchError(f"{type(exc).__name__}: {exc}")
            else:
                status = response.status_code
                if status in (404, 410):
                    response.close()
                    raise NotFound(f"HTTP {status} for {url}", status)
                if status < 400:
                    return response
                response.close()
                last_error = FetchError(f"HTTP {status} for {url}", status)
                if status not in RETRY_STATUS:
                    raise last_error
                wait = _retry_after(response)
                if wait is None and status == 429:
                    wait = 20 * (attempt + 1)        # e.g. paipancon's nginx limit sends no Retry-After
                if wait is not None:
                    self._cool_down(host, min(wait, 120))
            if attempt + 1 < self.attempts:
                backoff = min(30, 2 ** attempt) + random.uniform(0, 0.5)
                if self.on_retry:
                    self.on_retry(host, last_error, max(backoff, self._next_slot.get(host, 0) - time.monotonic()))
                time.sleep(backoff)
        raise last_error

    def text(self, url, **kwargs):
        response = self.get(url, **kwargs)
        if "charset" not in response.headers.get("Content-Type", "").lower():
            response.encoding = "utf-8"  # requests would otherwise assume ISO-8859-1 for text/*
        return response.text

    def json(self, url, **kwargs):
        return self.get(url, **kwargs).json()

    def close(self):
        self.session.close()
