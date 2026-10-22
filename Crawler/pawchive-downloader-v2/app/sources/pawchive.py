"""Pawchive: creator profiles, the post list (which already carries each post's files),
and file URLs. No per-post detail request exists or is needed."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from urllib.parse import quote

from ..domain.match import Entry, pawchive_entries
from ..domain.timefmt import to_utc
from .http import HttpClient, TransientError, carry

PAGE_SIZE = 50


@dataclass
class PawchivePost:
    id: str
    title: str
    content: str
    published: str
    edited: str
    has_full: bool
    entries: list[Entry]


class Pawchive:
    def __init__(self, http: HttpClient, api_base: str, file_base: str, page_workers: int):
        self.http = http
        self.api = api_base.rstrip("/")
        self.files = file_base.rstrip("/")
        self.page_workers = max(1, page_workers)

    def file_url(self, path: str, name: str = "") -> str:
        url = f"{self.files}/data{path}"
        return url + (f"?f={quote(name)}" if name else "")

    def profile(self, service: str, user_id: str) -> dict:
        return self.http.retry(
            lambda: self.http.get_json(f"{self.api}/{service}/user/{user_id}/profile"),
            f"profile {service}/{user_id}",
        )

    def _page(self, service: str, user_id: str, offset: int) -> list[dict]:
        def get():
            url = f"{self.api}/{service}/user/{user_id}" + (f"?o={offset}" if offset else "")
            data = self.http.get_json(url)
            if not isinstance(data, list):
                # Coercing to [] would read as the end of the list and truncate the creator.
                raise TransientError(f"expected a list of posts, got {type(data).__name__}")
            return data

        return self.http.retry(get, f"posts {service}/{user_id} o={offset}")

    def all_posts(self, service: str, user_id: str) -> tuple[list[dict], int]:
        """Every post, and how many page anomalies were seen.

        There is no post count to check against, so a page that is not full only
        *claims* to be the end: one more offset is probed to prove it. Otherwise a
        short middle page would silently cut off every older post behind it.
        """
        posts: list[dict] = []
        anomalies = 0
        offset = 0
        while True:
            offsets = [offset + i * PAGE_SIZE for i in range(self.page_workers)]
            if len(offsets) == 1:
                pages = [self._page(service, user_id, offsets[0])]
            else:
                with ThreadPoolExecutor(max_workers=len(offsets)) as pool:
                    pages = list(
                        pool.map(carry(lambda o: self._page(service, user_id, o)), offsets)
                    )
            for page_offset, page in zip(offsets, pages, strict=True):
                posts.extend(page)
                if len(page) == PAGE_SIZE:
                    continue
                probe_offset = page_offset + PAGE_SIZE if page else page_offset
                probe = self._page(service, user_id, probe_offset)
                if not probe:
                    return _dedupe(posts), anomalies
                anomalies += 1
                if not page:
                    posts.extend(probe)  # the empty page was transient
                # Always advance: resuming *at* this offset could spin forever.
                offset = page_offset + PAGE_SIZE
                break
            else:
                offset += self.page_workers * PAGE_SIZE

    @staticmethod
    def parse(item: dict) -> PawchivePost:
        return PawchivePost(
            id=str(item.get("id")),
            title=str(item.get("title") or ""),
            content=str(item.get("content") or ""),
            published=to_utc(item.get("published")),
            edited=to_utc(item.get("edited")),
            # An absent key reads as available: never invent a loss from missing data.
            has_full=bool(item.get("has_full", True)),
            entries=pawchive_entries(item.get("file"), item.get("attachments")),
        )


def _dedupe(items: list[dict]) -> list[dict]:
    seen, out = set(), []
    for item in items:
        key = str(item.get("id"))
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out
