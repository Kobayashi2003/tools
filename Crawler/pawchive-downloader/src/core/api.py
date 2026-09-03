import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, List
from urllib.parse import quote

import requests

from ..common import backoff
from ..common.limiter import QuotaExceeded, Throttle
from ..common.logger import Logger
from .policy import StatusPolicies


class PermanentAPIError(Exception):
    """The resource does not exist. Retrying cannot make it appear."""


class TransientAPIError(Exception):
    """Well-formed HTTP but unusable (wrong shape, truncated body). Retried."""


class API:
    """Client for the Pawchive API.

    The post list already carries each post's content and files, so there is no
    per-post detail request. The profile carries no post count, so a fetch can
    never be checked against an expected size -- see `get_all_posts`.

    Host bases come from config; Pawchive has changed domains before. Proxies
    come from the environment via the session's `trust_env`.

    Every file transfer passes through one `Throttle`, so the concurrency, rate
    and quota caps hold across the whole process rather than per thread pool.
    """

    PAGE_SIZE = 50

    def __init__(self, logger: Logger, config, throttle: Throttle = None):
        self.logger = logger
        self.config = config
        self.api_base = config.api_base.rstrip('/')
        self.file_base = config.file_base.rstrip('/')
        self.throttle = throttle or self._build_throttle(config)
        self.policies = self._build_policies(config)
        self.session = self._new_session()
        self.headers = {
            'User-Agent': config.user_agent,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.5',
        }
        self._stop = threading.Event()

    @staticmethod
    def _build_throttle(config) -> Throttle:
        return Throttle(
            max_concurrent=getattr(config, 'max_concurrent_downloads', 0),
            rate=getattr(config, 'max_download_rate', 0),
            burst=getattr(config, 'download_burst', 0),
            quota=getattr(config, 'daily_download_quota', 0),
            # Under data/, not cache/: a spent budget must survive a cache wipe.
            state_path=Path(getattr(config, 'data_dir', 'data')) / 'quota.json',
            window_hours=getattr(config, 'quota_window_hours', 24.0),
        )

    @staticmethod
    def _build_policies(config) -> StatusPolicies:
        """The failure table, over the built-in rules the operator did not replace.

        `not_found_max_retries` stays the knob for 404 so an existing config
        keeps meaning what it meant; writing an explicit `404` rule takes over.
        """
        return StatusPolicies.parse(
            getattr(config, 'status_policies', None),
            fallback={'404': {'action': 'permanent',
                              'attempts': getattr(config, 'not_found_max_retries', 3)}},
        )

    def _new_session(self) -> requests.Session:
        """A session whose connection pool matches the concurrency cap.

        Left at the default 10, a pool smaller than the number of live
        transfers silently discards and reopens connections underneath them,
        which reads to a server as far more churn than we are actually making.
        """
        session = requests.Session()
        size = max(self.throttle.max_concurrent,
                   int(getattr(self.config, 'page_workers', 4) or 4), 10)
        adapter = requests.adapters.HTTPAdapter(pool_connections=size,
                                                pool_maxsize=size)
        session.mount('https://', adapter)
        session.mount('http://', adapter)
        return session

    # ==================== Lifecycle ====================

    def stop(self):
        self._stop.set()
        try:
            self.session.close()
        except Exception:
            pass

    def resume(self):
        self._stop.clear()
        self.session = self._new_session()

    def _check_stop(self):
        if self._stop.is_set():
            raise InterruptedError("Request cancelled")

    # ==================== Requests ====================

    def file_url(self, path: str, name: str = "") -> str:
        """`/ab/f8/….jpg` -> `<file_base>/data/ab/f8/….jpg?f=<name>`.

        `path` is used verbatim; `f` sets the filename the CDN serves.
        """
        url = f"{self.file_base}/data{path}"
        if name:
            url += f"?f={quote(name)}"
        return url

    def _get_json(self, url: str, timeout: int = None):
        self._check_stop()
        resp = self.session.get(url, headers=self.headers,
                                timeout=timeout or self.config.request_timeout)
        resp.raise_for_status()
        return resp.json()

    def get_profile(self, service: str, user_id: str) -> Dict:
        return self._get_json(f"{self.api_base}/{service}/user/{user_id}/profile")

    def get_posts(self, service: str, user_id: str, offset: int = 0) -> List[Dict]:
        url = f"{self.api_base}/{service}/user/{user_id}"
        if offset:
            url += f"?o={offset}"
        data = self._get_json(url)
        if not isinstance(data, list):
            # Coercing to [] would look like the end of the list and silently
            # truncate the creator's posts.
            raise TransientAPIError(f"expected a list of posts, got {type(data).__name__}")
        return data

    # ==================== Retry ====================

    @staticmethod
    def _status_of(e: Exception):
        return getattr(getattr(e, 'response', None), 'status_code', None)

    @staticmethod
    def _kind_of(e: Exception) -> str:
        """The policy key for a failure that carries no HTTP status."""
        if isinstance(e, TransientAPIError):
            return 'invalid'
        if isinstance(e, requests.exceptions.Timeout):
            return 'timeout'
        if isinstance(e, requests.exceptions.ConnectionError):
            return 'connection'
        return 'network'

    def _retry(self, func, describe: str, max_attempts: int = None):
        """Retry until the failure's own policy says to stop.

        What each failure *means* is a table, not an if-ladder here: see
        `policy.py`. This function only supplies the two things the table cannot
        know -- the caller's own bound, and how many times each rule has already
        matched during this call.

        `max_attempts=0` retries forever (the default for API requests, since
        losing a list response truncates a creator). File downloads pass a
        bound: a give-up is recorded as a failed file, leaving the post undone
        for the next run. A rule with its own `attempts` overrides that bound
        for its own status, which is how a host that wants a long wait on 429
        gets one without loosening everything else.

        Counting is per rule, so a 404 among other errors still has to be seen
        `attempts` times before it is believed, and a 429 ladder is not advanced
        by unrelated 500s.

        `QuotaExceeded` is not in `retry_on` and so passes straight through: no
        number of attempts refills a budget, and burning the backoff ladder on
        one would only delay every other file behind it.
        """
        bound = int(self.config.max_retries if max_attempts is None else max_attempts) or 0
        seen: Dict[str, int] = {}

        def decide(e, _attempt):
            """Seconds to wait, or None to give up. May raise its own verdict."""
            rule = self.policies.match(self._status_of(e), self._kind_of(e))
            count = seen[rule.key] = seen.get(rule.key, 0) + 1
            limit = rule.limit() or bound

            if limit >= 0 and limit and count >= limit:
                if rule.action == 'permanent':
                    raise PermanentAPIError(
                        f"{describe}: {rule.describe()} after {count} attempts") from e
                return None
            return backoff.wait_for(
                count,
                rule.delay if rule.delay is not None else self.config.retry_delay,
                rule.backoff if rule.backoff is not None
                else getattr(self.config, 'retry_backoff', 2.0),
                rule.cap if rule.cap is not None
                else getattr(self.config, 'retry_delay_cap', 60),
                rule.jitter if rule.jitter is not None
                else getattr(self.config, 'retry_jitter', 0.0),
            )

        def on_retry(e, n, d):
            rule = self.policies.match(self._status_of(e), self._kind_of(e))
            self.logger.api_network_error(
                op=describe, status=self._status_of(e), error=str(e),
                policy=rule.describe(), attempt=n, retry_in=d, level='warning')

        try:
            return backoff.retry(
                func,
                retry_on=(requests.exceptions.RequestException, TransientAPIError),
                decide=decide,
                should_stop=self._stop.is_set,
                on_retry=on_retry,
                on_give_up=lambda e, n: self.logger.api_gave_up(
                    op=describe, error=str(e), attempts=n, level='error'),
            )
        except backoff.Cancelled:
            raise InterruptedError("Request cancelled")

    def get_profile_until_success(self, service: str, user_id: str) -> Dict:
        return self._retry(lambda: self.get_profile(service, user_id), f"profile {service}/{user_id}")

    def get_posts_until_success(self, service: str, user_id: str, offset: int = 0) -> List[Dict]:
        return self._retry(lambda: self.get_posts(service, user_id, offset), f"posts o={offset}")

    # ==================== Paging ====================

    def _fetch_pages(self, service: str, user_id: str, offsets: List[int]) -> List[List[Dict]]:
        if len(offsets) == 1:
            return [self.get_posts_until_success(service, user_id, offsets[0])]
        with ThreadPoolExecutor(max_workers=len(offsets)) as pool:
            return list(pool.map(
                lambda o: self.get_posts_until_success(service, user_id, o), offsets))

    def get_all_posts(self, service: str, user_id: str) -> List[Dict]:
        """Fetch every post of a creator.

        There is no post count to check the result against, so the rule is: a
        page that isn't full only *claims* to be the end -- probe one more offset
        to prove it. Otherwise a short middle page or a one-off empty response
        would silently cut off every older post behind it.

        Batches are concurrent for speed only.
        """
        workers = max(1, int(getattr(self.config, 'page_workers', 4)))
        posts: List[Dict] = []
        offset = 0

        while True:
            self._check_stop()
            offsets = [offset + i * self.PAGE_SIZE for i in range(workers)]
            pages = self._fetch_pages(service, user_id, offsets)

            for page_offset, page in zip(offsets, pages):
                if len(page) == self.PAGE_SIZE:
                    posts.extend(page)
                    continue

                posts.extend(page)
                probe_offset = page_offset + self.PAGE_SIZE if page else page_offset
                probe = self.get_posts_until_success(service, user_id, probe_offset)
                if not probe:
                    return posts

                self.logger.api_page_anomaly(
                    creator=f"{service}/{user_id}", offset=page_offset,
                    size=len(page), level='warning')
                if not page:
                    posts.extend(probe)  # the empty page was transient
                # Always advance: resuming *at* this offset could spin forever.
                offset = page_offset + self.PAGE_SIZE
                break
            else:
                offset += workers * self.PAGE_SIZE

    # ==================== File download ====================

    def content_length_of(self, url: str) -> int:
        self._check_stop()
        resp = self.session.head(url, headers=self.headers, allow_redirects=True,
                                 timeout=self.config.request_timeout)
        resp.raise_for_status()
        return int(resp.headers.get('content-length', 0) or 0)

    def download_file(self, url: str, save_path: str, raise_on_error: bool = False,
                      on_progress=None) -> bool:
        """Download to `save_path`, verified and atomically placed.

        Held inside one of the throttle's global transfer slots, so the caller's
        thread pools cannot multiply into more live sockets than configured, and
        every delivered chunk is charged against the rate and quota caps.
        """
        temp_path = None
        try:
            self._check_stop()
            # Checked before the request, not after: once a budget is spent, the
            # cheapest possible failure is the one that used no bandwidth.
            self.throttle.quota.check()
            path = Path(save_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            # Unique per call: concurrent downloads must never share a temp file.
            temp_path = path.parent / f".{path.name}.{uuid.uuid4().hex[:12]}.part"

            with self.throttle.slot():
                self._check_stop()
                resp = self.session.get(url, headers=self.headers, stream=True,
                                        timeout=max(60, self.config.request_timeout))
                resp.raise_for_status()

                content_length = int(resp.headers.get('content-length', 0) or 0)
                if not content_length:
                    try:
                        content_length = self.content_length_of(url)
                    except Exception:
                        content_length = 0

                if content_length and path.exists() and path.stat().st_size == content_length:
                    resp.close()
                    return True

                downloaded = 0
                with open(temp_path, 'wb') as f:
                    for chunk in resp.iter_content(chunk_size=65536):
                        if self._stop.is_set():
                            raise InterruptedError("Download cancelled")
                        if chunk:
                            f.write(chunk)
                            downloaded += len(chunk)
                            # Charged after the write: these bytes are already
                            # off the wire, so they are spent either way.
                            if not self.throttle.charge(len(chunk), self._stop.is_set):
                                raise InterruptedError("Download cancelled")
                            if on_progress:
                                on_progress(path.name, downloaded, content_length)

            if content_length and downloaded != content_length:
                # A short read must never be renamed into place as if complete.
                raise TransientAPIError(
                    f"truncated download: got {downloaded} of {content_length} bytes")

            if path.exists() and not content_length:
                # Unverifiable bytes must not destroy an existing file.
                self._cleanup(temp_path)
                self.logger.api_kept_existing(file=path.name, level='warning')
                return True

            os.replace(temp_path, path)
            return True

        except InterruptedError:
            self._cleanup(temp_path)
            if raise_on_error:
                raise
            return False
        except Exception:
            self._cleanup(temp_path)
            if raise_on_error:
                raise
            return False

    @staticmethod
    def _cleanup(temp_path):
        try:
            if temp_path and temp_path.exists():
                temp_path.unlink()
        except Exception:
            pass

    def download_file_until_success(self, url: str, save_path: str, on_progress=None) -> bool:
        return self._retry(
            lambda: self.download_file(url, save_path, raise_on_error=True, on_progress=on_progress),
            f"download {Path(save_path).name}",
            max_attempts=getattr(self.config, 'download_max_retries', 5),
        )
