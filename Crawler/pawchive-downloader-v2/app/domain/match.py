"""How Pawchive and Fanbox refer to the same creators, posts and files.

Creators: Pawchive's `user_id` is the pixiv `userId`; Fanbox's URL handle is a
`creatorId` the creator can rename, so it is only ever a cached lookup.
Posts: the id is the same on both sides.
Files: Pawchive names an image `{fanboxImageId}.{ext}` and an attachment
`{name}.{extension}`, exactly as Fanbox describes them, so the file name is the
join key. The cover is the one exception: each source lists at most one, so it is
joined by role, whatever it is named.
"""

import html
import re
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any

IMAGE_EXTS = {".gif", ".jpe", ".jpeg", ".jpg", ".png", ".webp", ".bmp"}
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


@dataclass
class Entry:
    """One file of a post as one source (or both, after `merge`) describes it."""

    key: str
    role: str
    """`cover`, `image` or `file`."""
    name: str
    path: str = ""
    """Pawchive content path, `/ab/cd/<sha256>.<ext>`."""
    url: str = ""
    """Fanbox download URL."""
    size: int | None = None
    width: int | None = None
    height: int | None = None
    sha256: str = ""
    sources: set[str] = field(default_factory=set)


def _role_of(name: str) -> str:
    return "image" if PurePosixPath(name).suffix.lower() in IMAGE_EXTS else "file"


def sha_of(path: str) -> str:
    """The content hash a Pawchive path is named after, or "" for any other path."""
    stem = PurePosixPath(path).stem
    return stem if _SHA256.match(stem) else ""


def pawchive_entries(raw_file: Any, attachments: Any) -> list[Entry]:
    """The cover and attachments, one entry per attachment Pawchive lists.

    `file` is the cover, whatever it is named (`cover.*`, or Fanbox's own id for it).
    Pawchive repeats it as `attachments[0]` on some posts; `path` is a content hash, so
    the repeat is the same bytes and is dropped. An image the post shows twice is two
    attachments with one path but two names, as on Fanbox, so both are kept. An entry
    without a path is kept with an empty path so the post cannot look complete.
    """
    seen: set[tuple[str, str]] = set()
    cover_path = None
    out: list[Entry] = []
    if isinstance(raw_file, dict) and raw_file:
        path = str(raw_file.get("path") or "")
        cover_path = path
        out.append(
            Entry(
                key="cover",
                role="cover",
                name=str(raw_file.get("name") or "").strip() or PurePosixPath(path).name,
                path=path,
                sha256=sha_of(path),
                sources={"pawchive"},
            )
        )
    for item in [a for a in (attachments or []) if isinstance(a, dict) and a]:
        path = str(item.get("path") or "")
        name = str(item.get("name") or "").strip() or PurePosixPath(path).name or "attachment"
        if path and (path == cover_path or (path, name) in seen):
            continue
        seen.add((path, name))
        out.append(
            Entry(
                key="n:" + name if name else "h:" + sha_of(path),
                role=_role_of(name),
                name=name,
                path=path,
                sha256=sha_of(path),
                sources={"pawchive"},
            )
        )
    return out


def original_cover_url(url: str) -> str:
    """Fanbox serves the cover resized under `/c/<size>/`; without it is the original."""
    return re.sub(r"/c/[^/]+/(fanbox/)", r"/\1", url or "")


def _ext_of(url: str) -> str:
    return PurePosixPath(url.split("?", 1)[0]).suffix


def fanbox_entries(post: dict) -> list[Entry]:
    """Files of a `post.info` body, in reading order: cover, then the body."""
    out: list[Entry] = []
    cover = original_cover_url(str(post.get("coverImageUrl") or ""))
    if cover:
        out.append(
            Entry(
                key="cover",
                role="cover",
                name="cover" + _ext_of(cover),
                url=cover,
                sources={"fanbox"},
            )
        )
    body = post.get("body") or {}
    if not isinstance(body, dict):
        return out

    def image(img: dict) -> Entry:
        name = f"{img.get('id')}.{img.get('extension')}"
        return Entry(
            key="n:" + name,
            role="image",
            name=name,
            url=str(img.get("originalUrl") or ""),
            width=img.get("width"),
            height=img.get("height"),
            sources={"fanbox"},
        )

    def attachment(f: dict) -> Entry:
        name = f"{f.get('name')}.{f.get('extension')}"
        return Entry(
            key="n:" + name,
            role=_role_of(name),
            name=name,
            url=str(f.get("url") or ""),
            size=f.get("size"),
            sources={"fanbox"},
        )

    # `image` / `file` posts list their files directly.
    out += [image(i) for i in body.get("images") or [] if isinstance(i, dict)]
    out += [attachment(f) for f in body.get("files") or [] if isinstance(f, dict)]
    # An `article` interleaves images and files in its blocks; keep reading order.
    image_map = body.get("imageMap") or {}
    file_map = body.get("fileMap") or {}
    used_images, used_files = set(), set()
    for block in body.get("blocks") or []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "image" and block.get("imageId") in image_map:
            used_images.add(block["imageId"])
            out.append(image(image_map[block["imageId"]]))
        elif block.get("type") == "file" and block.get("fileId") in file_map:
            used_files.add(block["fileId"])
            out.append(attachment(file_map[block["fileId"]]))
    # Map entries no block points at still belong to the post.
    out += [image(v) for k, v in image_map.items() if k not in used_images]
    out += [attachment(v) for k, v in file_map.items() if k not in used_files]
    return _dedupe(out)


def _dedupe(entries: list[Entry]) -> list[Entry]:
    seen, out = set(), []
    for e in entries:
        if e.key not in seen:
            seen.add(e.key)
            out.append(e)
    return out


def fanbox_text(post: dict) -> str:
    """Plain text of a `post.info` body; an article's text blocks joined by lines."""
    body = post.get("body") or {}
    if not isinstance(body, dict):
        return ""
    if body.get("text"):
        return str(body["text"])
    lines = []
    for block in body.get("blocks") or []:
        if isinstance(block, dict) and block.get("type") in ("p", "header") and "text" in block:
            lines.append(str(block.get("text") or ""))
    for embed in (body.get("urlEmbedMap") or {}).values():
        if isinstance(embed, dict) and embed.get("url"):
            lines.append(str(embed["url"]))
    return "\n".join(lines)


_BLOCK_END = re.compile(r"<br\s*/?>|</(?:p|div|h\d|li)>", re.I)
_TAG = re.compile(r"<[^>]+>")


def plain_text(text: str) -> str:
    """Pawchive keeps a post's text as Fanbox's editor HTML; Fanbox's API gives plain
    lines. Both become the same plain lines, so either source writes the same file.
    Pawchive escapes `&` even in its plain text; blank lines around the text are dropped,
    as the two sides disagree on them."""
    if re.search(r"<(?:p|br|div|a|span|h\d)\b", text, re.I):
        # `<p><br></p>` is one empty line, not two.
        text = re.sub(r"<p>\s*<br\s*/?>\s*</p>", "\n", text, flags=re.I)
        text = _TAG.sub("", _BLOCK_END.sub("\n", text))
    return html.unescape(text).strip()


def merge(pawchive: list[Entry], fanbox: list[Entry]) -> list[Entry]:
    """One list in Pawchive's order with Fanbox-only files after, so a change of source
    never renumbers files already on disk. Without Pawchive entries, Fanbox's order."""
    by_key = {e.key: e for e in fanbox}
    # Old posts (Pawchive imported them from kemono) name files by UUID and have no
    # `file`, so names cannot join them. What is left unjoined on both sides is paired in
    # reading order, Fanbox's cover first: the first of those files is the cover.
    name_joined = {p.key for p in pawchive} & set(by_key)
    left_p = [i for i, p in enumerate(pawchive) if p.key not in name_joined]
    left_f = [f for f in fanbox if f.key not in name_joined]
    paired = dict(zip(left_p, left_f, strict=False))

    out: list[Entry] = []
    seen: set[str] = set()
    for i, p in enumerate(pawchive):
        f = by_key.get(p.key) if p.key in name_joined else paired.get(i)
        # A file paired with Fanbox's cover becomes the cover, so there is only ever one.
        key = "cover" if f and f.key == "cover" else p.key
        merged = Entry(
            key=key,
            role="cover" if key == "cover" else p.role,
            name=p.name,
            path=p.path,
            sha256=p.sha256,
            sources=set(p.sources),
        )
        if f:
            merged.url, merged.size, merged.width, merged.height = f.url, f.size, f.width, f.height
            merged.sources |= f.sources
        if key in seen:
            continue
        seen.add(key)
        out.append(merged)
    used = name_joined | {f.key for f in paired.values()}
    out += [f for f in fanbox if f.key not in used and f.key not in seen]
    return out


# ---------------------------------------------------------------- references


@dataclass
class Ref:
    """What a pasted link or id points at."""

    kind: str
    """`pawchive` (service + user_id), `fanbox_user`, `fanbox_creator`, `fanbox_post`,
    `patreon_user` (user_id), `patreon_vanity` (creator_id: the name in the address) or
    `patreon_post`."""
    service: str = "fanbox"
    user_id: str = ""
    creator_id: str = ""
    post_id: str = ""


_RESERVED_SUBDOMAINS = {"www", "api", "downloads", "fanbox"}
# patreon.com/<name> is a creator, except for Patreon's own pages.
_PATREON_PATHS = {
    "login",
    "signup",
    "home",
    "posts",
    "user",
    "c",
    "messages",
    "settings",
    "search",
    "explore",
    "collection",
    "membership",
    "notifications",
    "api",
    "about",
    "policy",
    "en",
}


def parse_ref(text: str) -> Ref | None:
    s = text.strip()
    if not s:
        return None
    m = re.search(r"(?:pawchive|kemono)\.\w+/(?:api/v1/)?(\w+)/user/(\d+)(?:/post/(\d+))?", s)
    if m:
        return Ref("pawchive", service=m.group(1), user_id=m.group(2), post_id=m.group(3) or "")
    m = re.search(r"patreon\.com/(?:\w+/)?user(?:/\w+)?\?(?:[^#]*&)?u=(\d+)", s)
    if m:
        return Ref("patreon_user", service="patreon", user_id=m.group(1))
    m = re.search(r"patreon\.com/posts/(?:[^/?#]*-)?(\d+)", s)
    if m:
        return Ref("patreon_post", service="patreon", post_id=m.group(1))
    m = re.search(r"patreon\.com/(?:c/)?([\w.-]+)", s)
    if m and m.group(1).lower() not in _PATREON_PATHS:
        return Ref("patreon_vanity", service="patreon", creator_id=m.group(1))
    m = re.search(r"fanbox\.cc/@([\w.-]+)(?:/posts/(\d+))?", s)
    if m:
        kind = "fanbox_post" if m.group(2) else "fanbox_creator"
        return Ref(kind, creator_id=m.group(1), post_id=m.group(2) or "")
    m = re.search(r"https?://([\w-]+)\.fanbox\.cc(?:/posts/(\d+))?", s)
    if m and m.group(1).lower() not in _RESERVED_SUBDOMAINS:
        kind = "fanbox_post" if m.group(2) else "fanbox_creator"
        return Ref(kind, creator_id=m.group(1), post_id=m.group(2) or "")
    m = re.search(r"pixiv\.net/(?:\w+/)?(?:users/|member\.php\?id=|fanbox/creator/)(\d+)", s)
    if m:
        return Ref("fanbox_user", user_id=m.group(1))
    if re.fullmatch(r"@[\w.-]+", s):
        return Ref("fanbox_creator", creator_id=s[1:])
    if re.fullmatch(r"\d+", s):
        return Ref("fanbox_user", user_id=s)
    m = re.fullmatch(r"(\w+)[_/](\d+)", s)
    if m:
        return Ref("pawchive", service=m.group(1), user_id=m.group(2))
    return None
