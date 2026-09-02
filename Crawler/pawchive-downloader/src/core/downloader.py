import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Optional

from ..common.logger import Logger
from ..common.naming import unique_names
from ..common.notifier import Notifier
from .api import API, PermanentAPIError
from .cache import Cache
from .files import (distinct, entries_of, entries_of_parts, extract_files,
                    get_config_value, unusable_files)
from .formatter import Formatter
from .models import Artist, Config, DownloadResult, Post
from .storage import Storage


class Downloader:
    """Drives the fetch -> cache -> download pipeline for artists."""

    def __init__(self, config: Config, logger: Logger, storage: Storage, cache: Cache,
                 api: API, notifier: Optional[Notifier] = None):
        self.config = config
        self.logger = logger
        self.storage = storage
        self.cache = cache
        self.api = api
        self.notifier = notifier or Notifier(enabled=False)
        self._cancel_lock = threading.Lock()
        self._cancelled: set = set()

    # ==================== Cancellation ====================
    # A cancelled id stays in `_cancelled` until its own run clears it on exit,
    # so no timeout elsewhere can un-cancel a task that has not stopped yet.
    # Aborting requests is only a nudge to unblock in-flight HTTP; it is never
    # the source of truth, which is why resuming them afterwards is safe.

    def cancel(self, *artist_ids: str):
        with self._cancel_lock:
            self._cancelled.update(artist_ids)

    def uncancel(self, artist_id: str):
        with self._cancel_lock:
            self._cancelled.discard(artist_id)

    def is_cancelled(self, artist_id: str) -> bool:
        with self._cancel_lock:
            return artist_id in self._cancelled

    def abort_requests(self):
        self.api.stop()

    def resume_requests(self):
        self.api.resume()

    # ==================== Cache refresh ====================

    def update_posts(self, artist: Artist, detect_edits: bool = False,
                     recover_lost: bool = False) -> Dict[str, int]:
        """Refresh the cached post list; returns counts keyed
        `new`/`edited`/`lost`/`recovered`.

        Re-pages every time by default: the profile's `updated` is a bulk-import
        batch timestamp and posts get inserted after it, so trusting it silently
        skips new posts. `trust_updated_timestamp` opts into the lossy fast path.

        `recover_lost` (from `sync-lost`) reclaims restored posts; see `_apply_lost`.
        """
        empty = {'new': 0, 'edited': 0, 'lost': 0, 'recovered': 0}
        if self.is_cancelled(artist.id) or artist.completed or artist.ignore:
            return empty

        try:
            profile = self.api.get_profile_until_success(artist.service, artist.user_id)
        except PermanentAPIError as e:
            # Gone upstream. Leave the cache untouched -- what we already have
            # stays downloadable, and a later run picks it up if it returns.
            self.logger.downloader_creator_unavailable(
                artist=artist.display_name(), error=str(e), level='error')
            return empty

        cached_posts = self.cache.load_posts(artist.id, apply_filters=False)
        cached_profile = self.cache.load_profile(artist.id)

        if (getattr(self.config, 'trust_updated_timestamp', False)
                and not detect_edits and not recover_lost):
            unchanged = bool(cached_posts and cached_profile and cached_profile.updated
                             and cached_profile.updated == profile.get('updated'))
            if unchanged:
                self.logger.downloader_no_new(artist=artist.display_name())
                return empty

        try:
            by_id = self._fetch_index(artist)
        except PermanentAPIError as e:
            self.logger.downloader_creator_unavailable(
                artist=artist.display_name(), error=str(e), level='error')
            return empty

        # No post_count exists, so a shortfall is the only truncation signal.
        # Don't accept it first time: refetch and keep whichever scan saw more.
        if cached_posts and len(by_id) < len(cached_posts):
            self.logger.downloader_list_shortfall(
                artist=artist.display_name(), fetched=len(by_id),
                cached=len(cached_posts), level='warning')
            retry = self._fetch_index(artist)
            if len(retry) > len(by_id):
                self.logger.downloader_shortfall_recovered(
                    artist=artist.display_name(), was=len(by_id), now=len(retry), level='warning')
                by_id = retry

        api_ids = set(by_id)
        existing = {str(p.id): p for p in cached_posts}
        is_new_artist = not cached_posts
        merged: List[Post] = []
        new_count = edited_count = lost_count = recovered_count = 0

        for data in by_id.values():
            post = existing.get(str(data['id']))
            if post is None:
                post = self._post_from_data(data, artist)
                # Only on first add; an existing artist must download backfill.
                if is_new_artist and artist.last_date and post.published <= artist.last_date:
                    post.done = True
                else:
                    new_count += 1
            elif self._refresh(post, data, detect_edits):
                edited_count += 1
            change = self._apply_lost(post, data, recover_lost)
            if change == 'lost':
                lost_count += 1
            elif change == 'recovered':
                recovered_count += 1
            merged.append(post)

        # Keep posts the API omitted this time (transient gaps).
        missing = [p for p in cached_posts if str(p.id) not in api_ids]
        if missing:
            merged.extend(missing)
            self.logger.downloader_list_incomplete(
                artist=artist.display_name(), missing=len(missing), level='warning')

        self.cache.save_posts(artist.id, merged)
        self.cache.save_profile(artist.id, profile)

        if new_count or edited_count or missing or lost_count or recovered_count:
            self.logger.downloader_cached(
                artist=artist.display_name(), total=len(merged), new=new_count,
                edited=edited_count, lost=lost_count, recovered=recovered_count)
        else:
            self.logger.downloader_no_new(artist=artist.display_name())
        return {'new': new_count, 'edited': edited_count,
                'lost': lost_count, 'recovered': recovered_count}

    @staticmethod
    def _apply_lost(post: Post, data: Dict, recover_lost: bool) -> Optional[str]:
        """Reconcile `post.lost` with the server's `has_full`.

        Returns 'lost' when a post is newly marked, 'recovered' when un-marked,
        else None. A done post is never lost. Marking (available -> lost) happens
        on every sync; un-marking (lost -> available) only when `recover_lost`,
        so a normal sync leaves the lost set untouched once it exists.
        """
        if post.done:
            post.lost = False
            return None
        # Absent key -> treat as available: never invent a loss from missing data.
        has_full = data.get('has_full', True)
        if not has_full:
            if not post.lost:
                post.lost = True
                post.failed_files = []   # a lost post is not a failed one
                return 'lost'
        elif post.lost and recover_lost:
            post.lost = False
            return 'recovered'
        return None

    def _fetch_index(self, artist: Artist) -> Dict[str, Dict]:
        """The creator's whole list, de-duped by id, first-seen order kept."""
        raw = self.api.get_all_posts(artist.service, artist.user_id)
        by_id: Dict[str, Dict] = {}
        for item in raw:
            by_id.setdefault(str(item.get('id')), item)
        duplicates = len(raw) - len(by_id)
        if duplicates:
            self.logger.downloader_list_deduped(
                artist=artist.display_name(), duplicates=duplicates, level='warning')
        return by_id

    @staticmethod
    def _post_from_data(data: Dict, artist: Artist) -> Post:
        return Post(
            id=str(data['id']),
            user=str(data.get('user', artist.user_id)),
            service=data.get('service', artist.service),
            title=data.get('title', ''),
            content=data.get('content', ''),
            published=data.get('published') or '',
            added=data.get('added') or '',
            edited=data.get('edited'),
            file=data.get('file') or None,
            attachments=data.get('attachments') or [],
        )

    def _refresh(self, post: Post, data: Dict, detect_edits: bool) -> bool:
        """Update a cached post from the list; True if it needs re-downloading.

        Paths are always refreshed: a re-scrape rewrites every content-hash path
        and a stale one 404s forever. Re-download is triggered only by a *larger*
        file count -- paths change on re-scrape and names differ between a kemono
        import and Pawchive, so the count is the only comparable quantity. Counts
        are of *distinct* paths: Pawchive repeats the cover as `attachments[0]`,
        and counting it twice re-flags a post that is already complete. A
        same-count replacement is caught by `detect_edits` via `edited`.
        """
        remote = distinct(entries_of_parts(data.get('file') or None,
                                           data.get('attachments') or []))
        local = distinct(entries_of(post))

        if local and not remote:
            # One bad response must never erase a post's files.
            self.logger.downloader_empty_file_set(post_id=post.id, level='warning')
            return False

        if len(remote) < len(local):
            # Forgetting a file we never fetched would lose it silently;
            # `detect_edits` is the explicit way to accept an upstream removal.
            self.logger.downloader_fewer_files(
                post_id=post.id, had=len(local), now=len(remote), level='warning')
            if not detect_edits:
                return False

        has_more_files = len(remote) > len(local)

        # Pawchive returns a null `edited` on many imported posts: a missing
        # field, not an edit. It must neither re-download nor erase what we know.
        remote_edited = data.get('edited') or ''
        edited_changed = bool(remote_edited) and remote_edited != (post.edited or '')

        post.file = data.get('file') or None
        post.attachments = data.get('attachments') or []
        post.content = data.get('content', post.content)
        post.title = data.get('title', post.title)
        if remote_edited:
            post.edited = data['edited']
        # Pawchive can serve a post before `published` is filled in and set it on
        # a later scrape; adopt a present value, never null out one we have.
        if data.get('published'):
            post.published = data['published']
        if data.get('added'):
            post.added = data['added']

        if post.done and (has_more_files or (detect_edits and edited_changed)):
            post.done = False
            post.failed_files = []
            return True
        return False

    # ==================== Download ====================

    def download_artist(self, artist: Artist, from_date: Optional[str] = None,
                        until_date: Optional[str] = None, lost: bool = False,
                        pending: bool = False, failed: bool = False) -> DownloadResult:
        try:
            if self.is_cancelled(artist.id):
                return DownloadResult(artist.id, success=True)
            if artist.completed or artist.ignore:
                self.logger.downloader_skipped(
                    artist=artist.display_name(),
                    status='completed' if artist.completed else 'ignored')
                return DownloadResult(artist.id, success=True)

            # `lost` refreshes with recovery, so any post the server has restored
            # rejoins the undone set here rather than needing a separate sync.
            self.update_posts(artist, recover_lost=lost)

            if lost:
                # Force a retry of everything still undownloaded, lost included.
                posts = [p for p in self.cache.load_posts(artist.id) if not p.done]
            elif from_date or until_date:
                posts = [
                    p for p in self.cache.load_posts(artist.id)
                    if (not from_date or p.published > from_date)
                    and (not until_date or p.published <= until_date)
                ]
            else:
                posts = self.cache.get_undone(artist.id)
                # One flag alone halves the undone set; neither or both is all of
                # it, since a post either carries failed files or does not.
                if pending != failed:
                    posts = [p for p in posts if bool(p.failed_files) == failed]

            if not posts:
                self.logger.downloader_nothing(artist=artist.display_name())
                result = DownloadResult(artist.id, success=True)
            else:
                result = self._download_posts(artist, posts)

            new_last = self._calc_last_date(artist)
            if new_last and new_last > (artist.last_date or ""):
                artist.last_date = new_last
                self.storage.save_artist(artist)
                self.logger.downloader_last_date(artist=artist.display_name(), last_date=new_last)

            return result
        except InterruptedError:
            return DownloadResult(artist.id, success=True)
        except Exception as e:
            self.logger.downloader_artist_failed(
                artist=artist.display_name(), error=str(e), level='error')
            return DownloadResult(artist.id, success=False)
        finally:
            # Only the run itself clears its flag -- see Cancellation above.
            self.uncancel(artist.id)

    def _download_posts(self, artist: Artist, posts: List[Post]) -> DownloadResult:
        self.logger.downloader_processing(artist=artist.display_name(), count=len(posts))
        # Resolved once per run, not per post: it reads the artists/ tree for
        # `{group}`, and every post of a run shares the same directory.
        artist_dir = self._artist_dir(artist)
        self._sweep_partials(artist_dir)
        downloaded = failed = 0

        def process(post):
            if self.is_cancelled(artist.id):
                return False
            try:
                ok = self._download_post(artist, post, artist_dir)
                if ok:
                    self.cache.update_post(artist.id, post.id, done=True, failed_files=[],
                                           content=(post.content or None))
                return ok
            except Exception as e:
                self.logger.downloader_post_error(post_id=post.id, error=str(e), level='error')
                return False

        with ThreadPoolExecutor(max_workers=self.config.max_concurrent_posts) as executor:
            futures = [executor.submit(process, p) for p in posts]
            for future in as_completed(futures):
                if future.result():
                    downloaded += 1
                else:
                    failed += 1

        self.logger.downloader_completed(
            artist=artist.display_name(), succeeded=downloaded, failed=failed)
        return DownloadResult(artist.id, success=(failed == 0),
                              posts_downloaded=downloaded, posts_failed=failed)

    def _download_post(self, artist: Artist, post: Post, artist_dir: Path) -> bool:
        cv = lambda k: get_config_value(artist, self.config, k)
        save_content = cv('save_content')

        files = extract_files(post)
        # Reported, not dropped: the post stays undone and shows in `list-failed`.
        unusable = unusable_files(post)
        if unusable:
            self.logger.downloader_file_unusable(
                post_id=post.id, count=len(unusable), sample=';'.join(unusable[:3]), level='warning')

        if not files and not unusable and not cv('save_empty_posts') and not save_content:
            return True

        save_dir = (artist_dir
                    / Formatter.post_folder(post, cv('post_folder_template'), cv('date_format')))
        save_dir.mkdir(parents=True, exist_ok=True)

        if save_content and post.content:
            (save_dir / "content.txt").write_text(post.content, encoding='utf-8', errors='ignore')

        if not files:
            # A lost post forced through `download-lost` stays lost on failure,
            # rather than turning into an ordinary failed post.
            if unusable and not post.lost:
                self.cache.update_post(artist.id, post.id, done=False, failed_files=unusable)
            return not unusable

        # Two files resolving to one name would race on the same target path.
        names = unique_names(Formatter.file_names(
            [f['name'] for f in files], cv('file_template'),
            cv('rename_images_only'), self.config.image_extensions))

        failed_files: List[str] = list(unusable)

        def dl(pair):
            file, name = pair
            if self.is_cancelled(artist.id):
                return (False, name)
            try:
                url = self.api.file_url(file['path'], file['name'])
                self.api.download_file_until_success(
                    url, str(save_dir / name), on_progress=self.notifier.on_download_progress)
                self.logger.downloader_file_ok(file=name)
                return (True, name)
            except Exception as e:
                self.logger.downloader_file_failed(file=name, error=str(e), level='warning')
                return (False, name)

        with ThreadPoolExecutor(max_workers=self.config.max_concurrent_files) as executor:
            futures = [executor.submit(dl, pair) for pair in zip(files, names)]
            for future in as_completed(futures):
                ok, name = future.result()
                if not ok:
                    failed_files.append(name)

        if failed_files:
            # See above: a forced lost post that still 404s remains lost.
            if not post.lost:
                self.cache.update_post(artist.id, post.id, done=False, failed_files=failed_files)
            return False
        return True

    # ==================== Helpers ====================

    def _artist_dir(self, artist: Artist) -> Path:
        cv = lambda k: get_config_value(artist, self.config, k)
        return Formatter.artist_dir(cv('download_dir'), artist,
                                    cv('artist_folder_template'),
                                    self.storage.artist_group(artist.id))

    def _sweep_partials(self, artist_dir: Path):
        """Delete `.part` files left by an earlier run.

        Swept once, before any post thread starts. Two posts can resolve to one
        folder and posts download concurrently, so sweeping per-post could delete
        another thread's in-flight `.part` -- silently losing that file on any
        filesystem that permits unlinking an open file.
        """
        if not artist_dir.is_dir():
            return
        for leftover in artist_dir.rglob('.*.part'):
            try:
                leftover.unlink()
                self.logger.downloader_swept_partial(file=leftover.name)
            except OSError:
                pass

    def _calc_last_date(self, artist: Artist) -> Optional[str]:
        """Advance last_date over the run of oldest->newest posts that are settled.

        A filtered-out post is intentionally skipped, so it never blocks; but it
        must not let last_date jump over an undone post it was concealing. A lost
        post counts as settled: the server has no files, so it would otherwise
        stall the watermark forever behind content that cannot be fetched.
        """
        posts = sorted(self.cache.load_posts(artist.id, apply_filters=False),
                       key=lambda p: p.published or "")
        visible = {p.id for p in self.cache.load_posts(artist.id)}
        start = artist.last_date or ""
        new_last = start
        for post in posts:
            if (post.published or "") <= start:
                continue
            if post.id in visible and not post.done and not post.lost:
                break
            new_last = post.published
        return new_last if new_last != start else None
