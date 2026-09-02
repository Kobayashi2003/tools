import os
import re
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional

from ..core.cache import Cache
from ..core.formatter import Formatter
from ..core.models import Artist, MigrationConfig, MigrationPlan, MigrationResult, MigrationType, Post
from ..core.storage import Storage
from ..core.files import extract_files

# Any `[...]` group in a folder name; one of them is the post id under any
# template that includes `{id}`.
_BRACKETED = re.compile(r'\[([^\[\]]+)\]')


class Migrator:
    """Re-lays out already-downloaded folders/files when path templates change.

    A plan is computed first (with conflict detection) so it can be previewed
    before any rename; ``execute`` then moves the files.
    """

    def __init__(self, storage: Storage, cache: Cache):
        self.storage = storage
        self.cache = cache

    # ==================== Planning ====================

    def plan_posts(self, artist: Artist, old: MigrationConfig, new: MigrationConfig) -> MigrationPlan:
        posts = self.cache.load_posts(artist.id)
        if not posts:
            return MigrationPlan.empty(MigrationType.POST)

        mapping = {}                          # post_id -> (old_path, new_path)
        old_to, new_to = defaultdict(list), defaultdict(list)
        skipped = []

        for post in posts:
            old_path = self._post_path(artist, post, old)
            new_path = self._post_path(artist, post, new)
            if not old_path.exists():
                skipped.append((post.id, "source missing"))
                continue
            mapping[post.id] = (old_path, new_path)
            old_to[str(old_path)].append(post.id)
            new_to[str(new_path)].append(post.id)

        return self._resolve(MigrationType.POST, len(posts), mapping, old_to, new_to, skipped)

    def plan_files(self, artist: Artist, old: MigrationConfig, new: MigrationConfig) -> MigrationPlan:
        posts = [p for p in self.cache.load_posts(artist.id)
                 if self._post_path(artist, p, old).exists()]
        if not posts:
            return MigrationPlan.empty(MigrationType.FILE)

        mapping = {}                          # "post:name" -> (old_path, new_path)
        old_to, new_to = defaultdict(list), defaultdict(list)
        skipped = []
        total = 0

        for post in posts:
            files = extract_files(post)
            names = [f['name'] for f in files]
            old_names = Formatter.file_names(names, old.file_template, old.rename_images_only, old.image_extensions)
            new_names = Formatter.file_names(names, new.file_template, new.rename_images_only, new.image_extensions)
            old_post = self._post_path(artist, post, old)
            new_post = self._post_path(artist, post, new)

            for f, on, nn in zip(files, old_names, new_names):
                total += 1
                key = f"{post.id}:{f['name']}"
                old_path, new_path = old_post / on, new_post / nn
                if not old_path.exists():
                    skipped.append((key, "source missing"))
                    continue
                mapping[key] = (old_path, new_path)
                old_to[str(old_path)].append(key)
                new_to[str(new_path)].append(key)

        return self._resolve(MigrationType.FILE, total, mapping, old_to, new_to, skipped)

    def locate_artist_dirs(self, artists: List[Artist], download_dir: str) -> Dict[str, Path]:
        """`artist_id -> the folder that currently holds their posts`.

        Found by the post ids in folder names rather than by reconstructing the
        old template, which is often unknowable -- a layout left by an older
        buggy version or an external tool matches no template at all.

        Requires `{id}` in `post_folder_template`; without it nothing matches
        and callers fall back to the old/new template diff.
        """
        owner: Dict[str, str] = {}            # post id -> artist id
        for artist in artists:
            for post in self.cache.load_posts(artist.id):
                owner[str(post.id)] = artist.id

        found: Dict[str, Path] = {}
        votes: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
        root = Path(download_dir)
        if not root.is_dir():
            return found

        for dirpath, dirnames, _files in os.walk(root):
            hits = defaultdict(int)
            for name in dirnames:
                for token in _BRACKETED.findall(name):
                    aid = owner.get(token.strip())
                    if aid:
                        hits[aid] += 1
                        break
            if not hits:
                continue
            # Its children are post folders, so stop descending: nothing below
            # belongs to another creator.
            best = max(hits, key=hits.get)
            votes[best][dirpath] += hits[best]
            dirnames[:] = []

        for aid, paths in votes.items():
            found[aid] = Path(max(paths, key=paths.get))
        return found

    def plan_artists(self, artists: List[Artist], config: MigrationConfig) -> MigrationPlan:
        """Move each creator's whole folder to where the current templates say
        it belongs. One rename per creator, rather than one per post."""
        located = self.locate_artist_dirs(artists, config.download_dir)
        mapping = {}                          # artist_id -> (old_path, new_path)
        old_to, new_to = defaultdict(list), defaultdict(list)
        skipped = []

        for artist in artists:
            new_path = self._artist_path(artist, config)
            old_path = located.get(artist.id)
            if old_path is None:
                skipped.append((artist.id, "already correct" if new_path.is_dir()
                                else "nothing downloaded"))
                continue
            mapping[artist.id] = (old_path, new_path)
            old_to[str(old_path)].append(artist.id)
            new_to[str(new_path)].append(artist.id)

        return self._resolve(MigrationType.ARTIST, len(artists), mapping, old_to, new_to, skipped)

    def _resolve(self, kind, total, mapping, old_to, new_to, skipped) -> MigrationPlan:
        """Turn raw mappings into a plan, excluding conflicting/unsafe moves."""
        conflicts, bad = [], set()
        for group in (old_to, new_to):
            for path, ids in group.items():
                if len(ids) > 1:
                    conflicts.append((path, ids))
                    bad.update(ids)

        mappings = []
        for item_id, (old_path, new_path) in mapping.items():
            if item_id in bad:
                skipped.append((item_id, "path conflict"))
            elif old_path == new_path:
                skipped.append((item_id, "same path"))
            elif new_path.exists():
                skipped.append((item_id, "target exists"))
            else:
                mappings.append((str(old_path), str(new_path), item_id))

        return MigrationPlan(migration_type=kind, total_items=total,
                             mappings=mappings, conflicts=conflicts, skipped=skipped)

    # ==================== Execution ====================

    def execute(self, plan: MigrationPlan) -> MigrationResult:
        result = MigrationResult(migration_type=plan.migration_type, total=len(plan.mappings))
        for old_path, new_path, item_id in plan.mappings:
            try:
                Path(new_path).parent.mkdir(parents=True, exist_ok=True)
                Path(old_path).rename(new_path)
                result.success += 1
            except Exception as e:
                result.failed.append((old_path, new_path, item_id, str(e)))
        return result

    # ==================== Helpers ====================

    def _post_path(self, artist: Artist, post: Post, config: MigrationConfig) -> Path:
        post_folder = Formatter.post_folder(post, config.post_folder_template, config.date_format)
        return self._artist_path(artist, config) / post_folder

    def _artist_path(self, artist: Artist, config: MigrationConfig) -> Path:
        return Formatter.artist_dir(config.download_dir, artist,
                                    config.artist_folder_template,
                                    self.storage.artist_group(artist.id))
