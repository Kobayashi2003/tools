"""HTTP session: shared headers, proxy, retries, bearer auth."""

import threading
import time
from typing import Optional

import requests

from .config import USER_AGENT


class SessionPool:
    """One session per thread.

    `requests.Session` is not documented as thread-safe — its cookie jar and
    connection pool are shared mutable state — and downloads here run several
    works, and several volumes of one work, in parallel. Handing every thread
    its own session keeps connection reuse without sharing that state.
    """

    def __init__(self, config):
        self.config = config
        self._local = threading.local()

    def get(self) -> requests.Session:
        session = getattr(self._local, "session", None)
        if session is None:
            session = create_session(self.config)
            self._local.session = session
        return session


def create_session(config) -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "ja,en;q=0.9",
    })
    if config.token:
        session.headers["Authorization"] = f"Bearer {config.token}"
    if config.proxy:
        session.proxies = {"http": config.proxy, "https": config.proxy}
    return session


def get(session: requests.Session, url: str, config, **kwargs) -> Optional[requests.Response]:
    """GET with retries. Returns None once the attempts are used up."""
    last_error = None
    for attempt in range(1, max(1, config.retry) + 1):
        try:
            response = session.get(url, timeout=config.timeout, **kwargs)
            if response.status_code == 429 or 500 <= response.status_code < 600:
                last_error = f"HTTP {response.status_code}"
            else:
                return response
        except Exception as exc:
            last_error = exc
        if attempt < config.retry:
            time.sleep(min(2 ** attempt, 10))
    print(f"[http] giving up on {url}: {last_error}")
    return None
