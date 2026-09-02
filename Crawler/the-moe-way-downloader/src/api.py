"""The Discord REST calls this needs: read a channel's history, re-sign links.

Cookies do not authenticate this API -- every `/api/v9` call carries the account
token in an `Authorization` header. Attachment URLs are signed and expire after
roughly a day, so `refresh_urls` re-signs them in batches without re-reading the
messages, which is what keeps an old cache useful.
"""

import time
from typing import Dict, Iterable, List, Optional, Tuple

import requests

from .config import API_BASE, USER_AGENT

REFRESH_BATCH = 50


def _why(response) -> str:
    """Discord's own reason for a refusal, when it gave one."""
    try:
        body = response.json()
    except Exception:
        text = (response.text or "").strip()
        return f": {text[:120]}" if text else ""
    if not isinstance(body, dict):
        return ""
    code, message = body.get("code"), body.get("message")
    if code and message:
        return f": {message} [code {code}]"
    return f": {message}" if message else ""


class AuthRequired(Exception):
    """The token is missing, wrong, or no longer valid."""


class NoAccess(Exception):
    """The account cannot see this channel."""


class Discord:
    def __init__(self, config):
        self.config = config
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": config.token,
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": config.channel_url(),
        })
        if config.proxy:
            self.session.proxies = {"http": config.proxy, "https": config.proxy}

    # -- plumbing ---------------------------------------------------------

    def _request(self, method: str, path: str, **kwargs) -> requests.Response:
        url = path if path.startswith("http") else f"{API_BASE}{path}"
        last_error = None
        for attempt in range(1, max(1, self.config.retry) + 1):
            try:
                response = self.session.request(
                    method, url, timeout=self.config.timeout, **kwargs)
            except Exception as exc:
                last_error = exc
                time.sleep(min(2 ** attempt, 10))
                continue

            if response.status_code == 401:
                raise AuthRequired(
                    f"Discord rejected the token (401){_why(response)}. It changes "
                    f"whenever you log out or change your password -- read a fresh "
                    f"one and update TMW_TOKEN in .env.")
            if response.status_code == 403:
                # Say what Discord said. A 403 here can mean the account cannot
                # see the channel, but it can equally mean the credential is an
                # OAuth bearer token, or that the server's rules screening has
                # not been completed -- guessing at one of those is how you send
                # someone looking in the wrong place.
                raise NoAccess(
                    f"Discord refused the request (403){_why(response)}. "
                    f"Run `python main.py --doctor` to see which step fails.")
            if response.status_code == 429:
                # Discord says exactly how long to wait; guessing is worse -- but
                # an edge can answer 429 with HTML, and a rate limit must not
                # turn into a JSONDecodeError.
                try:
                    wait = float(response.json().get("retry_after", 1))
                except Exception:
                    wait = 1.0
                time.sleep(min(wait + 0.25, 60))
                last_error = "HTTP 429"
                continue
            if 500 <= response.status_code < 600:
                last_error = f"HTTP {response.status_code}"
                time.sleep(min(2 ** attempt, 10))
                continue
            return response

        raise RuntimeError(f"{method} {url} failed after {self.config.retry} attempts: {last_error}")

    # -- history ----------------------------------------------------------

    def _page(self, before: str = "", after: str = "", limit: int = 100) -> List[dict]:
        params = {"limit": max(1, min(limit, 100))}
        if before:
            params["before"] = before
        if after:
            params["after"] = after
        response = self._request(
            "GET", f"/channels/{self.config.channel_id}/messages", params=params)
        if not response.ok:
            raise RuntimeError(f"messages: HTTP {response.status_code} {response.text[:200]}")
        return response.json()

    @property
    def _size(self) -> int:
        return max(1, min(int(self.config.page_size), 100))

    def newer_than(self, message_id: str, max_messages: int = 0,
                   on_page=None) -> List[dict]:
        """Everything posted after `message_id`, oldest first.

        `after` returns the oldest slice of what is newer, so walking forward
        means re-anchoring on the highest id seen so far. `max_messages` bounds
        one walk: catching up wants everything, but a page growing as you scroll
        wants a screenful, not the hundred requests that "everything" can be.

        `on_page` may return False to call the walk off; what was collected so
        far is still returned, so a stopped crawl keeps what it read.
        """
        collected: List[dict] = []
        cursor = message_id
        while True:
            want = self._size
            if max_messages:
                want = min(want, max_messages - len(collected))
                if want <= 0:
                    break
            page = self._page(after=cursor, limit=want)
            if not page:
                break
            collected.extend(page)
            cursor = max(page, key=lambda m: int(m["id"]))["id"]
            if on_page and on_page(len(collected), cursor) is False:
                break
            if len(page) < want:
                break
            time.sleep(self.config.page_pause)
        collected.sort(key=lambda m: int(m["id"]))
        return collected

    def walk_back(self, before: str = "", floor_id: str = "",
                  max_messages: int = 0, on_page=None) -> Tuple[List[dict], bool]:
        """Page backwards from `before` (or the newest) until a `floor_id`, a
        `max_messages` budget, or the channel runs out.

        Returns `(messages oldest-first, exhausted)`, where `exhausted` means the
        channel's beginning was reached rather than a limit -- the only way to
        know the archive is complete. `on_page` may return False to call the
        walk off, which ends it without claiming the beginning was reached.
        """
        collected: List[dict] = []
        cursor = before
        exhausted = False

        while True:
            want = self._size
            if max_messages:
                want = min(want, max_messages - len(collected))
                if want <= 0:
                    break

            page = self._page(before=cursor, limit=want)
            if not page:
                exhausted = True
                break

            collected.extend(page)
            cursor = min(page, key=lambda m: int(m["id"]))["id"]
            if on_page and on_page(len(collected), cursor) is False:
                break

            # A short page means there was nothing more to give.
            if len(page) < want:
                exhausted = True
                break
            # The floor is a synthetic id, so this is a date comparison.
            if floor_id and int(cursor) <= int(floor_id):
                break
            time.sleep(self.config.page_pause)

        collected.sort(key=lambda m: int(m["id"]))
        return collected, exhausted

    # -- links ------------------------------------------------------------

    def refresh_urls(self, urls: Iterable[str]) -> Dict[str, str]:
        """Re-sign expired attachment links. Returns {old url: new url}."""
        pending = [u for u in dict.fromkeys(urls) if u]
        mapping: Dict[str, str] = {}
        for start in range(0, len(pending), REFRESH_BATCH):
            batch = pending[start:start + REFRESH_BATCH]
            response = self._request("POST", "/attachments/refresh-urls",
                                     json={"attachment_urls": batch})
            if not response.ok:
                # A stale link still points at the right file; the download just
                # fails. Better to hand back what we have than to lose the page.
                continue
            for item in response.json().get("refreshed_urls", []):
                original, refreshed = item.get("original"), item.get("refreshed")
                if original and refreshed:
                    mapping[original] = refreshed
            time.sleep(self.config.page_pause)
        return mapping

    def guild_channels(self):
        """The guild's text channels, so the page can offer a choice.

        Discord answers with every channel, readable or not -- the client works
        out visibility locally -- so a name appearing here is not a promise that
        it can be read.
        """
        response = self._request("GET", "/guilds/" + self.config.guild_id + "/channels")
        if not response.ok:
            return []
        out = []
        for channel in response.json() or []:
            if channel.get("type") not in (0, 5):
                continue
            out.append({"id": str(channel.get("id")),
                        "name": channel.get("name") or "",
                        "position": channel.get("position", 0)})
        return out

    def whoami(self) -> Optional[dict]:
        response = self._request("GET", "/users/@me")
        return response.json() if response.ok else None

    def probe(self, method: str, path: str, **kwargs):
        """One request that reports instead of raising -- for `--doctor`."""
        url = path if path.startswith("http") else f"{API_BASE}{path}"
        try:
            response = self.session.request(
                method, url, timeout=self.config.timeout, **kwargs)
        except Exception as exc:
            return None, f"{type(exc).__name__}: {exc}", None
        try:
            body = response.json()
        except Exception:
            body = None
        return response.status_code, _why(response).lstrip(": ") or "", body
