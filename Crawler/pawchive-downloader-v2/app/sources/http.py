"""One HTTP client per source: its own session, headers, failure table and throttle.

Ported from v1's `API`: the retry loop consults a policy table instead of an
if-ladder, every file transfer holds one of the throttle's global slots and is
charged against its rate and quota, and a download is verified and moved into
place atomically, so a short read can never pose as a complete file.
"""

import os
import threading
import uuid
from collections.abc import Callable
from http.cookiejar import DefaultCookiePolicy
from pathlib import Path
from typing import Any

import requests
from curl_cffi import requests as curl_requests
from curl_cffi.requests import exceptions as curl_exceptions
from requests.adapters import HTTPAdapter

from ..net import backoff
from ..net.limiter import Throttle
from ..net.policy import StatusPolicies


class PermanentError(Exception):
    """The resource does not exist (by this source's policy). Retrying cannot help."""


class TransientError(Exception):
    """Well-formed HTTP but unusable: wrong shape, truncated body. Retried."""


class Cancelled(Exception):
    """The client was stopped while a request was waiting or in flight."""


class RetryShape:
    def __init__(self, delay: float, factor: float, cap: float, jitter: float, attempts: int):
        self.delay, self.factor, self.cap, self.jitter = delay, factor, cap, jitter
        self.attempts = attempts


class HttpClient:
    def __init__(
        self,
        name: str,
        headers: dict[str, str],
        throttle: Throttle,
        policies: StatusPolicies,
        shape: RetryShape,
        timeout: int,
        log: Callable[[str, str], None],
        api_requests_per_second: float = 0.0,
        keep_cookies: bool = True,
        impersonate: str | None = None,
    ):
        self.keep_cookies = keep_cookies
        # JSON calls through curl_cffi, which shakes hands like the named browser: Fanbox
        # answers a signed-in API call from Python's own TLS handshake with 403.
        self.json_session = curl_requests.Session(impersonate=impersonate) if impersonate else None
        self.name = name
        self.headers = headers
        self.throttle = throttle
        self.policies = policies
        self.shape = shape
        self.timeout = timeout
        self.log = log
        self._stop = threading.Event()
        # API calls are paced too when asked: Fanbox counts them against your account.
        self.api_pace = Throttle(requests_per_second=api_requests_per_second, request_burst=1)
        self.session = self._new_session()

    def _new_session(self) -> requests.Session:
        # Pool at least as large as the transfer cap, or the pool silently churns sockets.
        size = max(self.throttle.max_concurrent, 10)
        session = requests.Session()
        if not self.keep_cookies:
            session.cookies.set_policy(DefaultCookiePolicy(allowed_domains=[]))
        adapter = HTTPAdapter(pool_connections=size, pool_maxsize=size)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        return session

    # ---- lifecycle ----

    def stop(self):
        self._stop.set()
        for session in (self.session, self.json_session):
            try:
                if session is not None:
                    session.close()
            except Exception:
                pass

    def _check(self):
        if self._stop.is_set():
            raise Cancelled()

    # ---- requests ----

    def get_json(self, url: str, params: dict | None = None, headers: dict | None = None) -> Any:
        self._check()
        if not self.api_pace.request(self._stop.is_set):
            raise Cancelled()
        merged = {**self.headers, **(headers or {})}
        if self.json_session is not None:
            return self._json_impersonated(url, params, merged)
        resp = self.session.get(url, params=params, headers=merged, timeout=self.timeout)
        resp.raise_for_status()
        try:
            return resp.json()
        except ValueError as e:
            raise TransientError(f"not JSON: {e}") from e

    def _json_impersonated(self, url: str, params: dict | None, headers: dict) -> Any:
        """curl_cffi's failures re-raised as their `requests` kind, so the retry policies
        and callers see one family of errors."""
        assert self.json_session is not None
        # The impersonated browser sends its own matching User-Agent.
        headers = {k: v for k, v in headers.items() if k.lower() != "user-agent"}
        try:
            resp = self.json_session.get(url, params=params, headers=headers, timeout=self.timeout)
        except curl_exceptions.Timeout as e:
            raise requests.exceptions.Timeout(str(e)) from e
        except curl_exceptions.RequestException as e:
            raise requests.exceptions.ConnectionError(str(e)) from e
        finally:
            if not self.keep_cookies:
                self.json_session.cookies.clear()
        if resp.status_code >= 400:
            status = requests.Response()
            status.status_code, status.url = resp.status_code, url
            raise requests.HTTPError(f"{resp.status_code} for url: {url}", response=status)
        try:
            return resp.json()
        except ValueError as e:
            raise TransientError(f"not JSON: {e}") from e

    def get(self, url: str, **kwargs) -> requests.Response:
        """A plain request outside the retry loop, e.g. reading a redirect."""
        self._check()
        if not self.api_pace.request(self._stop.is_set):
            raise Cancelled()
        return self.session.get(url, headers=self.headers, timeout=self.timeout, **kwargs)

    @staticmethod
    def status_of(e: Exception) -> int | None:
        return getattr(getattr(e, "response", None), "status_code", None)

    @staticmethod
    def _kind_of(e: Exception) -> str:
        if isinstance(e, TransientError):
            return "invalid"
        if isinstance(e, requests.exceptions.Timeout):
            return "timeout"
        if isinstance(e, requests.exceptions.ConnectionError):
            return "connection"
        return "network"

    def retry(self, func: Callable[[], Any], describe: str, attempts: int | None = None) -> Any:
        """Retry until the failure's own rule says stop. Counting is per rule, so a 429
        ladder is not advanced by unrelated 500s. `attempts=0` retries forever."""
        bound = int(self.shape.attempts if attempts is None else attempts) or 0
        seen: dict[str, int] = {}

        def decide(e: Exception, _n: int) -> float | None:
            rule = self.policies.match(self.status_of(e), self._kind_of(e))
            count = seen[rule.key] = seen.get(rule.key, 0) + 1
            limit = rule.limit() or bound
            if limit > 0 and count >= limit:
                if rule.action == "permanent":
                    raise PermanentError(
                        f"{describe}: {rule.describe()} after {count} attempts"
                    ) from e
                return None
            return backoff.wait_for(
                count,
                rule.delay if rule.delay is not None else self.shape.delay,
                rule.backoff if rule.backoff is not None else self.shape.factor,
                rule.cap if rule.cap is not None else self.shape.cap,
                rule.jitter if rule.jitter is not None else self.shape.jitter,
            )

        def on_retry(e: Exception, n: int, wait: float):
            status = self.status_of(e)
            self.log(
                "warning",
                f"{self.name} {describe}: {status or type(e).__name__} · attempt {n} failed, "
                f"retrying in {wait:.0f}s",
            )

        try:
            return backoff.retry(
                func,
                retry_on=(requests.exceptions.RequestException, TransientError),
                decide=decide,
                should_stop=self._stop.is_set,
                on_retry=on_retry,
            )
        except backoff.Cancelled:
            raise Cancelled() from None

    # ---- downloads ----

    def download(
        self,
        url: str,
        target: Path,
        headers: dict | None = None,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> int:
        """Download to `target`; returns bytes written. Raises on any failure."""
        temp: Path | None = None
        try:
            self._check()
            # Before the request: once the budget is spent, the cheapest failure is one
            # that used no bandwidth.
            self.throttle.quota.check()
            target.parent.mkdir(parents=True, exist_ok=True)
            # Unique per call: concurrent downloads must never share a temp file.
            temp = target.parent / f".{target.name}.{uuid.uuid4().hex[:12]}.part"
            with self.throttle.slot():
                self._check()
                if not self.throttle.request(self._stop.is_set):
                    raise Cancelled()
                resp = self.session.get(
                    url,
                    headers={**self.headers, **(headers or {})},
                    stream=True,
                    timeout=max(60, self.timeout),
                )
                resp.raise_for_status()
                expected = int(resp.headers.get("content-length", 0) or 0)
                written = 0
                with open(temp, "wb") as f:
                    for chunk in resp.iter_content(chunk_size=65536):
                        if self._stop.is_set():
                            raise Cancelled()
                        if chunk:
                            f.write(chunk)
                            written += len(chunk)
                            if not self.throttle.charge(len(chunk), self._stop.is_set):
                                raise Cancelled()
                            if on_progress:
                                on_progress(written, expected)
            if expected and written != expected:
                raise TransientError(f"truncated download: got {written} of {expected} bytes")
            if not written:
                raise TransientError("empty response body")
            os.replace(temp, target)
            temp = None
            return written
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)
