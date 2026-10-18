"""Fanbox's own API, under your session cookie when one is configured.

Anonymous calls are enough for search, creator lookup and the post list (a paid
post still lists its title, fee and time). Post bodies of paid posts, and the
list of plans you support, need the `FANBOXSESSID` cookie.
"""

import re
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import requests

from ..domain.match import Entry, fanbox_entries, fanbox_text
from ..domain.timefmt import fanbox_cursor, to_utc
from .http import HttpClient

LIST_LIMIT = 300


class SessionRejected(Exception):
    """Fanbox refused the cookie (or a paid post the plan should cover came back
    restricted). Every Fanbox request stops until the cookie is replaced."""


@dataclass
class FanboxListItem:
    id: str
    title: str
    fee: int
    published: str
    updated: str
    restricted: bool
    user_id: str
    creator_id: str
    cover_url: str = ""


@dataclass
class FanboxDetail:
    id: str
    title: str
    fee: int
    published: str
    updated: str
    restricted: bool
    user_id: str
    text: str
    entries: list[Entry]


class Fanbox:
    def __init__(self, http: HttpClient, api_base: str, sessid: str):
        self.http = http
        self.api = api_base.rstrip("/")
        self.set_session(sessid)

    def set_session(self, sessid: str):
        self.sessid = sessid
        if sessid:
            self.http.headers["Cookie"] = f"FANBOXSESSID={sessid}"
        else:
            self.http.headers.pop("Cookie", None)

    def _get(self, path: str, params: dict | None = None, describe: str = "") -> Any:
        def call():
            try:
                return self.http.get_json(f"{self.api}/{path}", params=params)
            except requests.HTTPError as e:
                if self.sessid and self.http.status_of(e) == 401:
                    raise SessionRejected("Fanbox rejected the cookie (401)") from e
                raise

        data = self.http.retry(call, describe or path)
        return data.get("body") if isinstance(data, dict) else data

    # ---- creators ----

    def creator(self, creator_id: str) -> dict:
        return self._get("creator.get", {"creatorId": creator_id}, f"creator {creator_id}")

    def creator_id_of(self, user_id: str) -> str | None:
        """pixiv's `/fanbox/creator/{userId}` redirects to `{creatorId}.fanbox.cc`;
        Fanbox's own `creator.get` does not accept a userId."""

        def call() -> str | None:
            resp = self.http.get(
                f"https://www.pixiv.net/fanbox/creator/{user_id}", allow_redirects=False
            )
            if resp.status_code in (301, 302, 303, 307, 308):
                location = resp.headers.get("location", "")
                m = re.search(r"https?://([\w-]+)\.fanbox\.cc", location) or re.search(
                    r"fanbox\.cc/@([\w.-]+)", location
                )
                if m and m.group(1) not in ("www", "api"):
                    return m.group(1)
                return None
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return None

        return self.http.retry(call, f"resolve {user_id}")

    def search(self, query: str, page: int = 0) -> list[dict]:
        body = self._get("creator.search", {"q": query, "page": page}, f"search {query}")
        return list((body or {}).get("creators") or [])

    def supporting(self) -> list[dict]:
        """Plans you currently support. Needs the cookie."""
        body = self._get("plan.listSupporting", None, "plan.listSupporting")
        # Once a bare list; now `{"plans": [...]}`.
        plans = body.get("plans") if isinstance(body, dict) else body
        return [p for p in plans or [] if isinstance(p, dict)]

    # ---- posts ----

    @staticmethod
    def _item(raw: dict) -> FanboxListItem:
        return FanboxListItem(
            id=str(raw.get("id")),
            title=str(raw.get("title") or ""),
            fee=int(raw.get("feeRequired") or 0),
            published=to_utc(raw.get("publishedDatetime")),
            updated=to_utc(raw.get("updatedDatetime")),
            restricted=bool(raw.get("isRestricted")),
            user_id=str((raw.get("user") or {}).get("userId") or ""),
            creator_id=str(raw.get("creatorId") or ""),
            # The list gives `cover: {type, url}`; a post body gives `coverImageUrl`.
            cover_url=str((raw.get("cover") or {}).get("url") or raw.get("coverImageUrl") or ""),
        )

    def list_posts(self, creator_id: str) -> Iterator[FanboxListItem]:
        """Newest first. Paged by keyset: a page starts *at* the given post, inclusive."""
        params: dict = {"creatorId": creator_id, "sort": "newest", "limit": LIST_LIMIT}
        seen: set[str] = set()
        while True:
            body = self._get("post.listCreator", params, f"list {creator_id}")
            raw = list((body or {}).get("posts") or [])
            fresh = [self._item(r) for r in raw if str(r.get("id")) not in seen]
            for item in fresh:
                seen.add(item.id)
                yield item
            if len(raw) < LIST_LIMIT or not fresh:
                return
            last = fresh[-1]
            params = {
                **params,
                "firstId": last.id,
                "firstPublishedDatetime": fanbox_cursor(last.published),
            }

    def post(self, post_id: str) -> FanboxDetail:
        body = self._get("post.info", {"postId": post_id}, f"post {post_id}")
        post = body.get("post", body) if isinstance(body, dict) else {}
        item = self._item(post)
        return FanboxDetail(
            id=item.id,
            title=item.title,
            fee=item.fee,
            published=item.published,
            updated=item.updated,
            restricted=item.restricted,
            user_id=item.user_id,
            text=fanbox_text(post),
            entries=[] if item.restricted else fanbox_entries(post),
        )

    @staticmethod
    def download_headers() -> dict:
        return {"Accept": "*/*"}
