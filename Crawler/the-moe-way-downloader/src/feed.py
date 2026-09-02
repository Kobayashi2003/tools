"""Cache, API and parser tied together into the one object the page talks to.

Two axes, deliberately separate. *Reach* is how much of the channel is cached:
it only grows, and only two operations exist -- forward from the newest id held,
backward from the oldest -- which keeps the cache contiguous. *Scope* is how
much of that cache the page draws, and never touches disk.
"""

import functools
import threading
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from .api import Discord
from .cache import MessageCache
from .config import parse_history
from .links import LinkStore
from .models import snowflake_for, snowflake_time
from .parse import build_posts, category_key as _title_key
from .state import ChannelState


def guarded(method):
    """Serialise a Feed operation against the others.

    A crawl now runs on its own thread while the page reads, and the two share a
    message cache, a parse and a link overlay. One lock per Feed rather than one
    for the server: two channels have nothing in common, and a crawl of one
    should not stall a page reading the other.
    """
    @functools.wraps(method)
    def run(self, *args, **kwargs):
        with self.lock:
            return method(self, *args, **kwargs)
    return run


class Feed:
    def __init__(self, config):
        self.config = config
        self.lock = threading.RLock()
        self.cache = MessageCache(config.cache_path)
        self.links = LinkStore(config.links_path)
        self.state = ChannelState(config.state_path, config.channel_id)
        # Only ever a name something vouched for -- the config for its own
        # channel, or Discord for any of them. `note_name` refuses an id.
        self.state.note_name(config.channel_name)
        # Parsing 21k messages into 11k posts costs a third of a second, and
        # every request wanted it. Held until the message cache actually grows.
        self._posts: Optional[List] = None
        self._by_id: Dict[str, object] = {}
        self.client: Optional[Discord] = None if config.offline else Discord(config)
        self.launched_at = datetime.now(timezone.utc)
        self.synced_at: Optional[datetime] = None
        self.last_error: str = ""

    # -- reach ------------------------------------------------------------

    @guarded
    def sync(self, limit: int = 0, on_progress=None) -> Dict[str, int]:
        """Fill forward: everything newer than the newest message held. An empty
        cache has no forward edge, so that whole job belongs to `backfill`."""
        if self.client is None:
            return {"added": 0, "fetched": 0, "offline": 1}
        newest = self.cache.newest_id
        if not newest:
            return {"added": 0, "fetched": 0, "offline": 0}

        fetched = self.client.newer_than(newest, max_messages=limit, on_page=on_progress)
        added = self.cache.add(fetched)
        if added:
            self.cache.save()
            self._forget_posts()
        self.synced_at = datetime.now(timezone.utc)
        self.state.note_sync()
        return {"added": added, "fetched": len(fetched), "offline": 0}

    @guarded
    def backfill(self, spec: str = None, limit: int = None,
                 on_progress=None) -> Dict[str, int]:
        """Fill backward to a date floor, a message budget, or the beginning.

        `done` means the beginning was reached; if a budget stopped it instead,
        running again continues from the new oldest message.
        """
        if self.client is None:
            return {"added": 0, "fetched": 0, "offline": 1, "done": 0}

        spec = self.config.history if spec is None else spec
        budget = self.config.fetch_limit if limit is None else limit
        reach = parse_history(spec)
        if reach is None and not budget:
            return {"added": 0, "fetched": 0, "offline": 0, "done": 0}

        floor, count = reach if reach else (None, None)
        # A date floor and a budget compose; the tighter one stops the walk.
        if budget:
            count = min(count, budget) if count else budget

        oldest = self.cache.oldest_id or ""
        floor_id = snowflake_for(floor) if floor else ""

        if oldest and self.state.history_complete:
            return {"added": 0, "fetched": 0, "offline": 0, "done": 1}
        if oldest and floor_id and int(oldest) <= int(floor_id):
            return {"added": 0, "fetched": 0, "offline": 0, "done": 0}

        fetched, reached_start = self.client.walk_back(
            before=oldest, floor_id=floor_id, max_messages=count or 0,
            on_page=on_progress)
        added = self.cache.add(fetched)
        if added:
            self.cache.save()
            self._forget_posts()
        self.synced_at = datetime.now(timezone.utc)
        self.state.note_sync(complete=reached_start)
        return {"added": added, "fetched": len(fetched), "offline": 0,
                "done": int(reached_start)}

    def reach(self, direction: str, count: int = 0) -> Dict:
        """Grow the cache one page in one direction, for the page to call.

        Browsing is how you find out you want more, so the page asks as you
        arrive at either end rather than making you predict a reach up front.
        Each call is one walk of at most `count` messages, and `done` says the
        channel has no more in that direction.
        """
        budget = count or self.config.page_size
        if direction == "older":
            result = self.backfill(spec="", limit=budget)
            result["done"] = bool(result.get("done") or self.state.history_complete)
            return result
        result = self.sync(limit=budget)
        # Forward has no "beginning" to reach: it is done when nothing came back.
        result["done"] = result.get("added", 0) == 0
        return result

    @guarded
    def since(self, oldest: str = "", newest: str = "") -> List[dict]:
        """Index entries outside the range the page already holds.

        The boundary posts are included, not skipped: a newly fetched message
        can merge into the share that was previously the edge, so the page has
        to be given the grown version to replace what it has.
        """
        out = []
        for post in self.posts():
            mid = int(post.message_id)
            if oldest and mid <= int(oldest):
                out.append(post)
            elif newest and mid >= int(newest):
                out.append(post)
            elif not oldest and not newest:
                out.append(post)
        return [p.to_index() for p in out]

    @guarded
    def carry_over(self, other: "Feed") -> Dict[str, int]:
        """Bring bookmarks and download ticks across from another channel.

        A migrated channel shares no ids with the one it came from -- every
        message and every attachment was created afresh -- so nothing can be
        matched by key. Files are matched on name and byte size, which for a
        re-upload of the same file is exact and for two different files is
        vanishingly unlikely to collide. A share is matched by any of its files
        landing in the same place; a share with no files at all falls back to
        its title, folded the way category labels are.

        Additive and repeatable: run it again once more of the archive has
        arrived and it picks up what it could not match the first time.
        """
        mine_by_file, mine_by_title = {}, {}
        for post in self.posts():
            for entry in post.files:
                mine_by_file.setdefault((entry.filename.casefold(), entry.size),
                                        (post, entry))
            key = _title_key(post.title)
            if key:
                mine_by_title.setdefault(key, post)

        theirs = {p.message_id: p for p in other.posts()}
        moved = {"taken": 0, "bookmarks": 0, "taken_missed": 0, "bookmarks_missed": 0}
        ticks = set()

        wanted = other.state.taken
        for post in theirs.values():
            for entry in post.files:
                if entry.attachment_id not in wanted:
                    continue
                match = mine_by_file.get((entry.filename.casefold(), entry.size))
                if match and match[1].attachment_id not in self.state.taken:
                    ticks.add(match[1].attachment_id)
                    moved["taken"] += 1
                elif not match:
                    moved["taken_missed"] += 1

        for mid in other.state.bookmarks:
            post = theirs.get(mid)
            if post is None:
                continue
            found = None
            for entry in post.files:
                match = mine_by_file.get((entry.filename.casefold(), entry.size))
                if match:
                    found = match[0]
                    break
            if found is None:
                found = mine_by_title.get(_title_key(post.title))
            if found is None:
                moved["bookmarks_missed"] += 1
                moved.setdefault("missed", []).append(post.title or "(untitled)")
            elif found.message_id not in self.state.bookmarks:
                # Through the state's own path so the write is recorded as a
                # change and survives being merged with the file on disk.
                self.state.bookmark(found.message_id, True,
                                    at=other.state.bookmarks[mid])
                moved["bookmarks"] += 1
                moved.setdefault("matched", []).append(post.title or "(untitled)")

        if ticks:
            self.state.take(ticks, True)
        return moved

    # -- links ------------------------------------------------------------

    def _apply_refresh(self, mapping: Dict[str, str]) -> None:
        """Record fresh signatures and put them on the live entries.

        Nothing is written back to the message cache: the posts handed out are
        the same objects every time, so updating them in place updates the whole
        page, and the overlay is what survives a restart.
        """
        if not mapping:
            return
        for post in self.posts():
            for entry in list(post.files) + list(post.covers):
                fresh = mapping.get(entry.url)
                if fresh:
                    entry.url = fresh
                    self.links.put(entry.attachment_id, fresh)
        self.links.save()

    def _stale_urls(self, posts: List) -> List[str]:
        """Only what is close to expiring -- a link with hours left is reused."""
        margin = self.config.link_margin_minutes * 60
        urls = []
        for post in posts:
            for entry in list(post.files) + list(post.covers):
                if entry.url and not entry.is_fresh(margin):
                    urls.append(entry.url)
        return urls

    @guarded
    def refresh_links(self, posts: List) -> int:
        """Re-sign the links of these posts. Returns how many were replaced."""
        if self.client is None:
            return 0
        urls = self._stale_urls(posts)
        if not urls:
            return 0
        mapping = self.client.refresh_urls(urls)
        self._apply_refresh(mapping)
        return len(mapping)

    @guarded
    def flush(self) -> None:
        """Write out whatever the batching held back.

        Both stores write on a timer while work is in flight, so this is what
        makes a finished unit of work durable: the end of a crawl, the end of a
        CLI run, the way out of the process.
        """
        self.cache.save(force=True)
        self.links.save(force=True)

    def close(self) -> None:
        self.flush()

    # -- scope ------------------------------------------------------------

    @property
    def display_name(self) -> str:
        """What to call this channel: the config for its own channel, then
        whatever a previous run was told, and an id when nothing knows."""
        return (self.config.channel_name or self.state.name
                or str(self.config.channel_id))

    def _forget_posts(self) -> None:
        self._posts = None
        self._by_id = {}

    @guarded
    def posts(self) -> List:
        if self._posts is None:
            posts = build_posts(self.cache.all(), self.config)
            for post in posts:
                for entry in list(post.files) + list(post.covers):
                    entry.url = self.links.get(entry.attachment_id, entry.url)
            self._posts = posts
            # A post can span several messages; every part points at it.
            self._by_id = {mid: p for p in posts for mid in p.part_ids}
        return self._posts

    @guarded
    def posts_by_id(self, message_ids) -> List:
        self.posts()
        out, seen = [], set()
        for mid in message_ids:
            post = self._by_id.get(str(mid))
            if post is not None and post.message_id not in seen:
                seen.add(post.message_id)
                out.append(post)
        return out

    def _window(self, posts: List, cap: int) -> Tuple[List, bool]:
        """Trim to what the page can render: the newest slice."""
        if not cap or len(posts) <= cap:
            return posts, False
        return posts[-cap:], True

    @guarded
    def bookmarks(self) -> List[dict]:
        """Bookmarks with enough of each share to list them without the index.

        Kept resolved here rather than looked up in the page, so a bookmark on a
        share that a filter is hiding still has a title to show.
        """
        out = []
        for mid, at in self.state.bookmarks.items():
            post = self._by_id.get(mid) if self._by_id else None
            if post is None:
                self.posts()
                post = self._by_id.get(mid)
            if post is None:
                continue          # bookmarked before a cache was rebuilt smaller
            out.append({
                "id": post.message_id,
                "at": at,
                "ts": post.timestamp.isoformat() if post.timestamp else None,
                "title": post.title,
                "author": post.book_author,
                "category": post.category,
                "n_files": len(post.files),
                "n_links": len(post.links),
            })
        out.sort(key=lambda b: b["ts"] or "", reverse=True)
        return out

    @guarded
    def coverage(self) -> dict:
        oldest, newest = self.cache.oldest_id, self.cache.newest_id
        return {
            "messages": len(self.cache),
            "oldest_id": oldest,
            "newest_id": newest,
            "oldest_at": snowflake_time(oldest).isoformat() if oldest else None,
            "newest_at": snowflake_time(newest).isoformat() if newest else None,
            "complete": self.state.history_complete,
            "last_sync": self.state.last_sync.isoformat() if self.state.last_sync else None,
        }

    @guarded
    def detail(self, message_ids) -> List[dict]:
        """Covers, files and links for a screenful, signed on the way out."""
        posts = self.posts_by_id(message_ids)
        try:
            self.refresh_links(posts)
        except Exception as exc:
            self.last_error = f"link refresh failed: {exc}"
        return [p.to_detail(self.config) for p in posts]

    @guarded
    def payload(self, tail: Optional[bool] = None,
                cap: Optional[int] = None) -> dict:
        """The index. Touches no network: links are signed by `detail`."""
        tail = self.config.tail if tail is None else tail
        cap = self.config.display_cap if cap is None else cap

        posts = self.posts()
        held = len(posts)

        # Scope, step one: `tail` hides everything older than this launch. The
        # cache is untouched, so turning it off brings the archive straight back.
        floor = self.launched_at if tail else None
        if floor:
            posts = [p for p in posts if p.timestamp > floor]

        in_scope = len(posts)
        # Scope, step two: the render cap. Both counts are reported so the page
        # can say what it is not showing rather than quietly dropping it.
        posts, capped = self._window(posts, cap)

        rendered = [post.to_index() for post in posts]
        seen = set()
        categories = [p.category for p in posts
                      if p.category and not (p.category in seen or seen.add(p.category))]
        return {
            "channel": {
                "name": self.display_name,
                "url": self.config.channel_url(),
                "guild_id": self.config.guild_id,
                "channel_id": self.config.channel_id,
            },
            "coverage": self.coverage(),
            "display": {
                "tail": bool(tail),
                "cap": cap,
                "held": held,          # posts in the cache
                "in_scope": in_scope,  # after the tail floor
                "shown": len(rendered),
                "capped": capped,
                "launched_at": self.launched_at.isoformat(),
            },
            "posts": rendered,
            "categories": sorted(categories),
            "taken": sorted(self.state.taken),
            "bookmarks": self.bookmarks(),
            "link_margin": self.config.link_margin_minutes * 60,
            "message_count": len(self.cache),
            "synced_at": self.synced_at.isoformat() if self.synced_at else None,
            "offline": self.client is None,
            "error": self.last_error,
        }
