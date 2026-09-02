import threading
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from ..common.jsonio import CorruptJSON, coerce, read_json, write_json
from ..common.logger import Logger
from .filters import PostFilter
from .models import Artist, Config, Post, Profile
from .storage import Storage


class Cache:
    """Per-artist on-disk cache of the post list and profile.

    Each artist has two files under `cache_dir`:
        {artist_id}_posts.json    - list of Post dicts incl. `done` state
        {artist_id}_profile.json  - last seen Profile (used for change detection)

    Mutations always operate on the *unfiltered* post list; filters are a
    read-time view so filtered-out posts are never dropped from disk.
    """

    def __init__(self, cache_dir: str, logger: Logger, config: Config, storage: Storage):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.logger = logger
        self.config = config
        self.storage = storage
        self.lock = threading.RLock()

    def _posts_path(self, artist_id: str) -> Path:
        return self.cache_dir / f"{artist_id}_posts.json"

    def _profile_path(self, artist_id: str) -> Path:
        return self.cache_dir / f"{artist_id}_profile.json"

    # ==================== Profile ====================

    def save_profile(self, artist_id: str, data: Dict):
        with self.lock:
            profile = coerce(Profile, data)
            profile.cached_at = datetime.now().isoformat()
            write_json(self._profile_path(artist_id), profile.__dict__)

    def load_profile(self, artist_id: str) -> Optional[Profile]:
        with self.lock:
            data = read_json(self._profile_path(artist_id))
            return coerce(Profile, data) if data else None

    # ==================== Posts ====================

    def _save_posts(self, artist_id: str, posts: List[Post]):
        write_json(self._posts_path(artist_id), [p.__dict__ for p in posts])

    def save_posts(self, artist_id: str, posts: List[Post]):
        with self.lock:
            self._save_posts(artist_id, posts)

    def _load_posts_raw(self, artist_id: str) -> List[Post]:
        # A corrupt file must raise, never read as []: callers overwrite what
        # they read, and an empty read makes an artist look brand new.
        return [coerce(Post, item) for item in read_json(self._posts_path(artist_id), [])]

    def load_posts(self, artist_id: str, apply_filters: bool = True) -> List[Post]:
        with self.lock:
            posts = self._load_posts_raw(artist_id)
            if not apply_filters or not posts:
                return posts

            artist = self.storage.get_artist(artist_id)
            if not isinstance(artist, Artist):
                return posts
            filter_cfg = {**self.config.global_filter, **artist.filter}
            if not filter_cfg:
                return posts

            filtered = PostFilter.apply(posts, filter_cfg)
            removed = len(posts) - len(filtered)
            if removed:
                self.logger.cache_filtered(artist=artist.display_name(), removed=removed)
            return filtered

    def update_post(self, artist_id: str, post_id: str, done: bool,
                    failed_files: List[str] = None, content: str = None):
        with self.lock:
            posts = self._load_posts_raw(artist_id)
            for p in posts:
                if p.id == post_id:
                    p.done = done
                    if done:
                        # A downloaded post is never lost: its bytes are on disk.
                        p.lost = False
                    if failed_files is not None:
                        p.failed_files = failed_files
                    if content is not None:
                        p.content = content
                    break
            self._save_posts(artist_id, posts)

    # ==================== Queries ====================

    def get_undone(self, artist_id: str) -> List[Post]:
        # Lost posts are excluded: the server has no files for them, so a retry
        # is wasted. `download:lost` is the deliberate way to try them anyway.
        return [p for p in self.load_posts(artist_id)
                if (not p.done or p.failed_files) and not p.lost]

    def get_lost(self, artist_id: str) -> List[Post]:
        return [p for p in self.load_posts(artist_id) if p.lost and not p.done]

    def stats(self, artist_id: str) -> Dict:
        try:
            posts = self.load_posts(artist_id)
        except CorruptJSON as e:
            self.logger.cache_corrupt(artist_id=artist_id, error=str(e), level='error')
            return {'total': 0, 'done': 0, 'pending': 0, 'failed': 0, 'lost': 0,
                    'corrupt': True}
        total = len(posts)
        done = sum(1 for p in posts if p.done)
        lost = sum(1 for p in posts if p.lost and not p.done)
        failed = sum(1 for p in posts if p.failed_files and not p.lost)
        # `pending` is work that can actually make progress: lost is set aside.
        return {'total': total, 'done': done, 'pending': total - done - lost,
                'failed': failed, 'lost': lost, 'corrupt': False}

    # ==================== Maintenance ====================

    def reset_after_date(self, artist_id: str, after_date: str = None) -> int:
        with self.lock:
            posts = self._load_posts_raw(artist_id)
            count = 0
            for p in posts:
                if not p.published or not p.done:
                    continue
                if after_date is None or p.published > after_date:
                    p.done = False
                    p.failed_files = []
                    count += 1
            if count:
                self._save_posts(artist_id, posts)
                self.logger.cache_reset(artist_id=artist_id, after=after_date or 'all', count=count)
            return count

    def deduplicate(self, artist_id: str) -> int:
        with self.lock:
            posts = self._load_posts_raw(artist_id)
            seen = set()
            unique = []
            for p in posts:
                if p.id not in seen:
                    seen.add(p.id)
                    unique.append(p)
            removed = len(posts) - len(unique)
            if removed:
                self._save_posts(artist_id, unique)
                self.logger.cache_dedupe(artist_id=artist_id, removed=removed)
            return removed
