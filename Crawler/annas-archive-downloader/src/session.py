"""HTTP session: shared headers, proxy, retries, optional browser cookies.

Anna's Archive serves /search and /md5 to a plain client, but puts /dyn/... and
/slow_download behind DDoS-Guard. Exporting those cookies from a browser into
`cookies.json` lets the plain client through as well; without them those paths
answer 403 and the caller falls back to another backend.
"""

import json
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import requests

from .config import USER_AGENT


def create_session(config) -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    })
    if config.proxy:
        session.proxies = {"http": config.proxy, "https": config.proxy}
    load_cookies(session, config.cookies_file, config.mirror)
    return session


def load_cookies(session: requests.Session, path: str, mirror: str) -> int:
    """Load a cookie file into the session. Accepts either a flat
    `{"name": "value"}` map or the list-of-objects a browser extension exports.
    Returns how many cookies were loaded."""
    cookie_path = Path(path or "")
    if not cookie_path.exists():
        return 0
    try:
        data = json.loads(cookie_path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"[cookies] ignoring {cookie_path}: {exc}")
        return 0

    default_domain = urlparse(mirror).hostname or ""
    count = 0
    if isinstance(data, dict):
        for name, value in data.items():
            session.cookies.set(name, str(value), domain=default_domain)
            count += 1
    elif isinstance(data, list):
        for item in data:
            if not isinstance(item, dict) or "name" not in item:
                continue
            session.cookies.set(
                item["name"], str(item.get("value", "")),
                domain=(item.get("domain") or default_domain).lstrip("."),
                path=item.get("path", "/"),
            )
            count += 1
    return count


def get(session: requests.Session, url: str, config, **kwargs) -> Optional[requests.Response]:
    """GET with retries. Returns None once the attempts are used up."""
    last_error = None
    for attempt in range(1, max(1, config.retry) + 1):
        try:
            response = session.get(url, timeout=config.timeout, **kwargs)
            if response.status_code == 429 or 500 <= response.status_code < 600:
                last_error = f"HTTP {response.status_code}"
                throttled = response.status_code == 429
                # Being rate-limited is not a transient blip: coming back in two
                # seconds just spends another request on the same refusal, and
                # the caller then records a real result as "not found".
                delay = _retry_after(response) if throttled else 0
                if throttled and not delay:
                    delay = min(15 * attempt, 60)
            else:
                return response
        except Exception as exc:
            last_error = exc
            delay = 0
        if attempt < config.retry:
            time.sleep(delay or min(2 ** attempt, 10))
    print(f"[http] giving up on {url}: {last_error}")
    return None


def _retry_after(response) -> int:
    """Honour `Retry-After` when the server sends one."""
    raw = response.headers.get("Retry-After", "")
    try:
        return max(0, min(int(raw), 120))
    except (TypeError, ValueError):
        return 0
