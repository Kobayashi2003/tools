"""Patreon's own JSON API (`www.patreon.com/api`), under your `session_id` cookie when one
is configured.

The API is not behind the Cloudflare challenge Patreon's pages sit behind, so nothing here
reads a page. Anonymous calls are enough for the creator lookup and the post list: a post
you cannot view still lists its title, times and its attachments' names, but no download
address. Files of a post you can view come with signed addresses that expire, so a
download asks for the post again right before it starts (`post`).

Files of a post, in reading order (`patreon_entries`): the header image as the cover, the
images, the attachments, the post file (a video is an HLS stream), and images inlined in
the text that none of those already are. The join key with Pawchive is the file name,
which both take from Patreon's `file_name`.
"""

import html
import re
import shutil
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote, urlparse

import requests

from ..domain.match import Entry, plain_text
from ..domain.timefmt import to_utc
from .fanbox import SessionRejected
from .http import Cancelled, HttpClient

PAGE_SIZE = 50
INCLUDE = "images,media,attachments_media,audio,campaign,user"
POST_FIELDS = (
    "title,published_at,edited_at,current_user_can_view,post_type,post_file,image,content,"
    "min_cents_pledged_to_view,is_paid,url,embed"
)
MEDIA_FIELDS = "id,image_urls,download_url,metadata,file_name,size_bytes,mimetype"
IMAGE_EXTS = {".gif", ".jpe", ".jpeg", ".jpg", ".png", ".webp", ".bmp"}
_INLINE = re.compile(r"<img\b[^>]*>", re.I)
_ATTR = re.compile(r'([\w-]+)="([^"]*)"')


@dataclass
class PatreonPost:
    id: str
    title: str
    fee: int
    """The lowest pledge that opens it, in whole currency units; 1 when Patreon gives no
    amount for a post you cannot view, 0 for a free one."""
    published: str
    updated: str
    restricted: bool
    user_id: str
    text: str
    entries: list[Entry]


def _ext(name: str) -> str:
    return PurePosixPath(name.split("?", 1)[0]).suffix.lower()


def _url_name(url: str) -> str:
    return unquote(PurePosixPath(urlparse(url).path).name)


_HASH = re.compile(r"^[0-9a-f]{32}$")


def content_hash(url: str) -> str:
    """The 32-hex segment Patreon's media addresses carry for their content, or ""."""
    return next((s for s in urlparse(url).path.split("/") if _HASH.match(s)), "")


def is_stream(url: str) -> bool:
    """Patreon's own videos are HLS playlists on Mux."""
    return _ext(urlparse(url).path) == ".m3u8"


def identity(url: str) -> str:
    """What a media address points at: its content hash, else the address without query."""
    return content_hash(url) or url.split("?", 1)[0]


MIME_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}


def patreon_entries(post: dict, included: dict[tuple[str, str], dict]) -> list[Entry]:
    attrs = post.get("attributes") or {}
    rels = post.get("relationships") or {}
    out: list[Entry] = []
    # Keys and content identities already listed: Patreon names one picture several ways
    # (the header, an image, the post file, an inline image), and each is kept once.
    seen: set[str] = set()
    media_ids: set[str] = set()

    def add(entry: Entry) -> None:
        ident = identity(entry.url) if entry.url else ""
        if (
            entry.key in seen
            or (ident and ident in seen)
            or not (entry.url or entry.role == "cover")
        ):
            return
        seen.update({entry.key, ident} - {""})
        out.append(entry)

    def media(rel: str) -> Iterator[dict]:
        refs = (rels.get(rel) or {}).get("data") or []
        # `audio` is one item, the others lists.
        for ref in [refs] if isinstance(refs, dict) else refs:
            item = included.get(("media", str(ref.get("id"))))
            if item and str(ref.get("id")) not in media_ids:
                media_ids.add(str(ref.get("id")))
                yield item

    def from_media(item: dict) -> Entry | None:
        a = item.get("attributes") or {}
        url = a.get("download_url") or (a.get("image_urls") or {}).get("original") or ""
        name = str(a.get("file_name") or "").strip()
        if not name or "/" in name:
            # A video's thumbnail is "named" by its address; use the media id instead.
            name = (
                f"{item.get('id')}{MIME_EXT.get(str(a.get('mimetype') or ''), _ext(url) or '.jpg')}"
            )
        dims = (a.get("metadata") or {}).get("dimensions") or {}
        return Entry(
            key="n:" + name,
            role="image" if _ext(name) in IMAGE_EXTS else "file",
            name=name,
            url=url,
            size=a.get("size_bytes") or None,
            width=dims.get("w"),
            height=dims.get("h"),
            sources={"fanbox"},
        )

    found = [
        e
        # `media` lists them all, plus what no other list does (a text post's header).
        for rel in ("images", "attachments_media", "audio", "media")
        for item in media(rel)
        if (e := from_media(item))
    ]
    post_file = attrs.get("post_file") or {}
    # An embedded video's "post file" is its thumbnail, which the header already is.
    if post_file.get("url") and attrs.get("post_type") not in ("video_embed", "link"):
        url = str(post_file["url"])
        name = str(post_file.get("name") or "").strip() or _url_name(url)
        if is_stream(url):
            # An HLS playlist is saved as one .mp4.
            stem = PurePosixPath(name).stem if name and not name.endswith(".m3u8") else ""
            name = (stem or f"video_{post.get('id')}") + ".mp4"
        found.append(
            Entry(
                key="n:" + name,
                role="image" if _ext(name) in IMAGE_EXTS else "file",
                name=name,
                url=url,
                sources={"fanbox"},
            )
        )

    for tag in _INLINE.findall(str(attrs.get("content") or "")):
        a = dict(_ATTR.findall(tag))
        src = html.unescape(a.get("src", ""))
        if not src or a.get("data-media-id", "") in media_ids:
            continue
        # Inline images are named by their content hash: their own names are all "1.png".
        name = (content_hash(src) or _url_name(src)) + (_ext(urlparse(src).path) or ".jpg")
        found.append(Entry(key="n:" + name, role="image", name=name, url=src, sources={"fanbox"}))

    image = attrs.get("image") or {}
    cover = image.get("large_url") or image.get("url") or ""
    # The header is usually one of the post's images (listed, the post file or inline), and
    # then it stays that image: Pawchive lists it either under that name (joined by name)
    # or as the post's `file`, its cover, which `merge` pairs with this image by position.
    # Only a header that is none of them is a cover of its own.
    if cover and not any(identity(e.url) == identity(cover) for e in found):
        add(
            Entry(
                key="cover",
                role="cover",
                name="cover" + (_ext(cover) or ".jpg"),
                url=cover,
                sources={"fanbox"},
            )
        )
    for entry in found:
        add(entry)
    return out


class Patreon:
    def __init__(self, http: HttpClient, api_base: str, session_id: str):
        self.http = http
        self.api = api_base.rstrip("/")
        self.set_session(session_id)

    def set_session(self, session_id: str):
        self.session_id = session_id

    def _headers(self) -> dict:
        h = {"Content-Type": "application/vnd.api+json"}
        if self.session_id:
            h["Cookie"] = f"session_id={self.session_id}"
        return h

    def _get(self, url: str, params: dict | None = None, describe: str = "") -> Any:
        def call():
            try:
                return self.http.get_json(url, params=params, headers=self._headers())
            except requests.HTTPError as e:
                if self.session_id and self.http.status_of(e) == 401:
                    raise SessionRejected("Patreon rejected the session cookie (401)") from e
                raise

        return self.http.retry(call, describe or url)

    # ---- account and creators ----

    def current_user(self) -> dict:
        """Who the cookie signs in as. Raises SessionRejected for a cookie Patreon refuses."""
        data = self._get(f"{self.api}/current_user", None, "current user")
        return (data or {}).get("data") or {}

    def user(self, user_id: str) -> dict:
        """A user's profile: its campaign id is under relationships.campaign."""
        return (self._get(f"{self.api}/user/{user_id}", None, f"user {user_id}") or {}).get(
            "data"
        ) or {}

    def campaign_of(self, user_id: str) -> str | None:
        rel = (self.user(user_id).get("relationships") or {}).get("campaign") or {}
        return str((rel.get("data") or {}).get("id") or "") or None

    def campaign_by_vanity(self, vanity: str) -> dict | None:
        """`{campaign_id, user_id, name}` for the name in patreon.com/<vanity>."""
        data = self._get(
            f"{self.api}/campaigns",
            {"filter[vanity]": vanity, "include": "creator"},
            f"campaign {vanity}",
        )
        items = (data or {}).get("data") or []
        if not items:
            return None
        c = items[0]
        creator = ((c.get("relationships") or {}).get("creator") or {}).get("data") or {}
        return {
            "campaign_id": str(c.get("id")),
            "user_id": str(creator.get("id") or ""),
            "name": str((c.get("attributes") or {}).get("name") or vanity),
        }

    # ---- posts ----

    def _params(self) -> dict:
        return {
            "include": INCLUDE,
            "fields[post]": POST_FIELDS,
            "fields[media]": MEDIA_FIELDS,
            "json-api-version": "1.0",
        }

    def _post(self, raw: dict, included: dict[tuple[str, str], dict]) -> PatreonPost:
        a = raw.get("attributes") or {}
        viewable = bool(a.get("current_user_can_view", True))
        cents = a.get("min_cents_pledged_to_view")
        fee = int(cents) // 100 if cents else 0
        if not viewable and fee == 0:
            fee = 1
        user = ((raw.get("relationships") or {}).get("user") or {}).get("data") or {}
        return PatreonPost(
            id=str(raw.get("id")),
            title=str(a.get("title") or ""),
            fee=fee,
            published=to_utc(a.get("published_at")),
            updated=to_utc(a.get("edited_at") or a.get("published_at")),
            restricted=not viewable,
            user_id=str(user.get("id") or ""),
            text=plain_text(str(a.get("content") or "")),
            entries=patreon_entries(raw, included) if viewable else [],
        )

    @staticmethod
    def _included(data: dict) -> dict[tuple[str, str], dict]:
        return {(str(i.get("type")), str(i.get("id"))): i for i in data.get("included") or []}

    def list_posts(self, campaign_id: str) -> Iterator[PatreonPost]:
        """Newest first, with the files of every post you can view."""
        url: str | None = f"{self.api}/posts"
        params: dict | None = {
            **self._params(),
            "filter[campaign_id]": campaign_id,
            "filter[contains_exclusive_posts]": "true",
            "filter[is_draft]": "false",
            "sort": "-published_at",
            "page[count]": str(PAGE_SIZE),
        }
        seen: set[str] = set()
        while url:
            data = self._get(url, params, f"posts of campaign {campaign_id}") or {}
            included = self._included(data)
            for raw in data.get("data") or []:
                post = self._post(raw, included)
                if post.id not in seen:
                    seen.add(post.id)
                    yield post
            # The next page's address carries every parameter already.
            url, params = (data.get("links") or {}).get("next"), None

    def post(self, post_id: str) -> PatreonPost:
        data = self._get(f"{self.api}/posts/{post_id}", self._params(), f"post {post_id}") or {}
        return self._post(data.get("data") or {}, self._included(data))


# ---------------------------------------------------------------- video


def find_ffmpeg(configured: str) -> str | None:
    return configured or shutil.which("ffmpeg")


def save_stream(
    url: str,
    target: Path,
    ffmpeg: str,
    stopped: Callable[[], bool],
    timeout: float = 4 * 3600,
) -> None:
    """Join an HLS playlist into `target` (.mp4) without re-encoding."""
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(f".{target.stem}.part.mp4")
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-headers",
        "Referer: https://www.patreon.com/\r\n",
        "-i",
        url,
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        str(temp),
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    errors: list[bytes] = []
    reader = threading.Thread(
        target=lambda: errors.append(proc.stderr.read() if proc.stderr else b""), daemon=True
    )
    reader.start()
    started = time.monotonic()
    try:
        while proc.poll() is None:
            if stopped():
                proc.kill()
                raise Cancelled()
            if time.monotonic() - started > timeout:
                proc.kill()
                raise OSError(f"ffmpeg took over {timeout / 3600:.0f} h")
            time.sleep(0.5)
        reader.join(5)
        if proc.returncode != 0 or not temp.exists() or temp.stat().st_size == 0:
            message = b"".join(errors).decode("utf-8", "replace").strip().splitlines()
            raise OSError(f"ffmpeg failed: {message[-1] if message else proc.returncode}")
        temp.replace(target)
    finally:
        temp.unlink(missing_ok=True)
