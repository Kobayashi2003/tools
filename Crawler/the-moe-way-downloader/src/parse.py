"""Turn raw messages into posts.

The channel has a house format the parsing leans on -- a bracketed kind on its
own line, the title under it, then the files:

    (Manga / マンガ)
    フリージア愛蔵版 1 (1) - 6 (2)
    [ フリージア愛蔵版 1 （1）.epub, ... ]

Nothing enforces it, so every step degrades rather than fails: no bracket means
no category, no text at all reads as a continuation of the message above, and
anything else is still shown with whatever it has.
"""

import re
from collections import Counter
from datetime import timedelta
from typing import List, Optional

from .models import FileEntry, Link, Post, snowflake_time

# A kind on its own line: (Manga / マンガ), （Light Novel）. Round brackets only --
# square ones open a title and name its author, `[水無月はな] タイトル`.
CATEGORY_RE = re.compile(r"^[\s>*_]*[（(]\s*([^()（）]{1,60}?)\s*[)）]\s*(.*)$")
AUTHOR_RE = re.compile(r"^\s*[\[［]\s*([^\]］]{1,60}?)\s*[\]］]\s*(.+)$")
URL_RE = re.compile(r"https?://[^\s<>()\[\]『』「」]+")
DECORATION_RE = re.compile(r"^[\s>*_~`]+|[\s*_~`]+$")

# Uploads to Discord itself are the files; only foreign hosts are "links".
OWN_HOSTS = ("cdn.discordapp.com", "media.discordapp.net", "discord.com",
             "discordapp.net", "images-ext-1.discordapp.net")

# 0 default, 19 reply. The rest are joins, pins, boosts -- channel furniture.
CONTENT_TYPES = {0, 19}


def _clean(line: str) -> str:
    return DECORATION_RE.sub("", line).strip()


def _split_content(content: str):
    """-> (category, book_author, title, body, links)"""
    links = [Link(u) for u in URL_RE.findall(content or "")
             if not any(h in u for h in OWN_HOSTS)]

    lines = []
    for raw in (content or "").splitlines():
        line = _clean(URL_RE.sub("", raw))
        if line:
            lines.append(line)

    category = ""
    if lines:
        match = CATEGORY_RE.match(lines[0])
        if match:
            candidate, remainder = match.group(1).strip(), match.group(2).strip()
            # A title may legitimately open with a bracket -- "(1) 巻" -- so only
            # treat it as a kind when it reads like words rather than a number.
            if candidate and not candidate.replace(".", "").isdigit():
                category = candidate
                lines = ([remainder] if remainder else []) + lines[1:]

    title = lines[0] if lines else ""
    book_author = ""
    author_match = AUTHOR_RE.match(title)
    if author_match:
        book_author, title = author_match.group(1), author_match.group(2)

    body = "\n".join(lines[1:])
    return category, book_author, title, body, links


def _unwrap(raw: dict):
    """A message's own content, plus anything it is carrying for another one.

    Discord forwards a message by reference: the wrapper has empty content and
    no attachments, and the original sits in a snapshot. A channel migrated by
    forwarding therefore looks completely empty unless the snapshot is opened.
    """
    content = raw.get("content") or ""
    attachments = list(raw.get("attachments") or [])
    embeds = list(raw.get("embeds") or [])
    for snap in raw.get("message_snapshots") or []:
        inner = snap.get("message") or {}
        if not content:
            content = inner.get("content") or ""
        attachments += list(inner.get("attachments") or [])
        embeds += list(inner.get("embeds") or [])
    return content, attachments, embeds


def _from_embeds(embeds, seen_urls):
    """Covers and links an embed carries. Embed images are not attachments and
    cannot be re-signed, so they are keyed by their own URL."""
    covers, links = [], []
    for embed in embeds:
        for key in ("image", "thumbnail"):
            url = (embed.get(key) or {}).get("url")
            if url and url not in seen_urls:
                seen_urls.add(url)
                name = url.split("?")[0].rsplit("/", 1)[-1] or "image"
                covers.append(FileEntry(attachment_id="e:" + name, filename=name, url=url))
        url = embed.get("url")
        if url and not any(h in url for h in OWN_HOSTS) and url not in seen_urls:
            seen_urls.add(url)
            links.append(Link(url))
    return covers, links


def build_post(raw: dict) -> Post:
    author = raw.get("author") or {}
    content, raw_attachments, embeds = _unwrap(raw)
    category, book_author, title, body, links = _split_content(content)

    attachments = [FileEntry.from_attachment(a) for a in raw_attachments]
    covers = [a for a in attachments if a.is_image]
    files = [a for a in attachments if not a.is_image]

    seen = {e.url for e in attachments} | {l.url for l in links}
    more_covers, more_links = _from_embeds(embeds, seen)
    covers += more_covers
    links += more_links

    return Post(
        message_id=str(raw.get("id", "")),
        author=author.get("global_name") or author.get("username", "") or "unknown",
        author_id=str(author.get("id", "")),
        timestamp=snowflake_time(str(raw["id"])),
        category=category,
        book_author=book_author,
        title=title,
        body=body,
        covers=covers,
        files=files,
        links=links,
        reactions=sum(int(r.get("count") or 0) for r in raw.get("reactions") or []),
        part_ids=[str(raw.get("id", ""))],
    )


def _is_continuation(post: Post, parent: Optional[Post], window: timedelta) -> bool:
    if parent is None or post.title or post.category or post.book_author:
        return False
    if post.author_id != parent.author_id:
        return False
    if not post.has_payload:
        return False
    last_part = snowflake_time(parent.part_ids[-1])
    return post.timestamp - last_part <= window


def _absorb(parent: Post, child: Post) -> None:
    parent.files.extend(child.files)
    parent.covers.extend(child.covers)
    parent.links.extend(child.links)
    parent.reactions += child.reactions
    parent.part_ids.append(child.message_id)
    if child.body:
        parent.body = f"{parent.body}\n{child.body}".strip()


# The channel writes one kind a dozen ways: `Manga`, `MANGA`, `Manga / マンガ`,
# `Manga/マンガ`. Folding is structural -- take the side before the slash and
# case it once -- with a short table only for the labels written in Japanese
# alone, which have no English side to keep.
JAPANESE_KINDS = {
    "マンガ": "Manga", "漫画": "Manga", "ラノベ": "Light novel",
    "ライトノベル": "Light novel", "小説": "Novel", "画集": "Artbook",
    "雑誌": "Magazine", "カタログ": "Catalog", "ノンフィクション": "Non-fiction",
}


def _category_head(text: str) -> str:
    head = (text or "").split("/")[0].strip(" 　-–—_")
    return JAPANESE_KINDS.get(head, head)


def category_key(text: str) -> str:
    """`Non-fiction`, `Non fiction` and `Nonfiction` are one kind."""
    return re.sub(r"[^0-9a-z぀-ヿ一-鿿]", "", text.casefold())


def _settle_categories(posts: List[Post], minimum: int) -> None:
    """Keep the labels the channel actually uses; demote the one-offs.

    A bracketed first line is usually a kind, but sometimes it is an aside --
    `(Anyone have this one?)`, `(not my folder)`. Telling them apart by wording
    is guesswork; telling them apart by how often the channel repeats them is
    not. Of 110 distinct values here, 8 account for nearly all posts and 89
    appear under five times between them.
    """
    heads = {p.message_id: _category_head(p.category) for p in posts}
    counts = Counter()
    spellings = {}
    for post in posts:
        head = heads[post.message_id]
        if not head:
            continue
        key = category_key(head)
        counts[key] += 1
        spellings.setdefault(key, Counter())[head] += 1

    for post in posts:
        head = heads[post.message_id]
        key = category_key(head)
        if head and counts[key] >= minimum:
            # Spelled the way the channel spells it most often.
            post.category = spellings[key].most_common(1)[0][0]
        elif post.category:
            # Demoted, not discarded: if it was the only text, it was the title.
            if not post.title:
                post.title = post.category
            post.category = ""

    # Some posts write the kind on a bare line -- `Light Novel` then the real
    # title under it, no brackets. Promoting that would be guesswork on its own, so
    # it only happens when the line matches a kind the channel already uses in
    # brackets often enough to be in `counts`.
    for post in posts:
        if post.category:
            continue
        # Through the same folding as a bracketed label, so
        # `light novel/ラノベ` reaches the key `lightnovel` too.
        key = category_key(_category_head(post.title))
        if not key or counts.get(key, 0) < minimum:
            continue
        # The kind on a bare line. Whatever follows it is the title -- and
        # when nothing does, the post simply has no title, which is better
        # said than papered over by showing the genre in the title's place.
        parts = post.body.splitlines() if post.body else []
        post.category = spellings[key].most_common(1)[0][0]
        post.title = parts[0].strip() if parts else ""
        post.body = "\n".join(parts[1:]).strip()


def why_dropped(messages: List[dict]) -> dict:
    """Count what never became a share, and for which reason.

    A channel that yields two shares from a hundred messages is either quiet or
    being misread, and the difference matters: a migration reposted by a webhook
    would be dropped wholesale by the `bot` rule below.
    """
    tally = {"total": len(messages), "system": 0, "bot": 0, "no_payload": 0, "kept": 0}
    for raw in messages:
        if (raw.get("author") or {}).get("bot"):
            tally["bot"] += 1
        if raw.get("type", 0) not in CONTENT_TYPES:
            tally["system"] += 1
        elif not build_post(raw).has_payload:
            tally["no_payload"] += 1
        else:
            tally["kept"] += 1
    return tally


def build_posts(messages: List[dict], config) -> List[Post]:
    """Oldest first, in, oldest first out. Bots and chatter are dropped."""
    window = timedelta(minutes=config.merge_window_minutes)
    posts: List[Post] = []

    for raw in sorted(messages, key=lambda m: int(m["id"])):
        if raw.get("type", 0) not in CONTENT_TYPES:
            continue

        # Who posted it is not the question -- whether it carries anything is.
        # The old rule dropped every bot, which silently lost the shares a
        # `File Uploader` bot posted, and would lose a whole channel migrated
        # by one.
        post = build_post(raw)
        if not post.has_payload:
            # No file, no link, no cover -- a comment in an upload-only channel.
            continue

        parent = posts[-1] if posts else None
        if config.merge_continuations and _is_continuation(post, parent, window):
            _absorb(parent, post)
        else:
            posts.append(post)

    _settle_categories(posts, config.category_min)
    return posts
