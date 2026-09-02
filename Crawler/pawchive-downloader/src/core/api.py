import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, List
from urllib.parse import quote

import requests

from ..common import backoff
from ..common.logger import Logger


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
    """

    PAGE_SIZE = 50

    def __init__(self, logger: Logger, config):
        self.logger = logger
        self.config = config
        self.api_base = config.api_base.rstrip('/')
        self.file_base = config.file_base.rstrip('/')
        self.session = requests.Session()
        self.headers = {
            'User-Agent': config.user_agent,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.5',
        }
        self._stop = threading.Event()

    # ==================== Lifecycle ====================

    def stop(self):
        self._stop.set()
        try:
            self.session.close()
        except Exception:
            pass

    def resume(self):
        self._stop.clear()
        self.session = requests.Session()

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

    def _retry(self, func, describe: str, max_attempts: int = None):
        """Retry every failure -- connection, timeout, 4xx, 5xx alike.

        `max_attempts=0` retries forever (the default for API requests, since
        losing a list response truncates a creator). File downloads pass a bound:
        a give-up is recorded as a failed file, leaving the post undone for the
        next run.

        A 404 is the one failure retrying cannot fix: a creator removed upstream
        would otherwise stall an unbounded API retry forever, blocking every
        creator behind it. It is retried a few times (a 404 can be a bad edge
        node) and then raised as permanent.
        """
        attempts = int(self.config.max_retries if max_attempts is None else max_attempts) or 0
        seen_404 = 0

        def attempt():
            nonlocal seen_404
            try:
                return func()
            except requests.exceptions.HTTPError as e:
                if self._status_of(e) == 404:
                    seen_404 += 1
                    if seen_404 >= self.config.not_found_max_retries:
                        raise PermanentAPIError(
                            f"{describe}: 404 after {seen_404} attempts") from e
                raise

        try:
            return backoff.retry(
                attempt,
                retry_on=(requests.exceptions.RequestException, TransientAPIError),
                attempts=attempts,
                delay=self.config.retry_delay,
                should_stop=self._stop.is_set,
                on_retry=lambda e, n, d: self.logger.api_network_error(
                    op=describe, status=self._status_of(e), error=str(e),
                    attempt=n, retry_in=d, level='warning'),
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
        """Download to `save_path`, verified and atomically placed."""
        temp_path = None
        try:
            self._check_stop()
            path = Path(save_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            # Unique per call: concurrent downloads must never share a temp file.
            temp_path = path.parent / f".{path.name}.{uuid.uuid4().hex[:12]}.part"

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
