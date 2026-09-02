import json
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

from ..core.cache import Cache
from ..core.formatter import Formatter
from ..common.logger import Logger
from ..core.models import Artist, Config
from ..core.storage import Storage
from ..core.files import extract_files, get_config_value


class Validator:
    """Detects output-path collisions at the artist, post and file level.

    A collision means two items resolve to one path. Acknowledged ones are muted
    via `data/validation_ignore.json`.
    """

    def __init__(self, data_dir: str, cache: Cache, storage: Storage, config: Config, logger: Logger):
        self.data_dir = Path(data_dir)
        self.cache = cache
        self.storage = storage
        self.config = config
        self.logger = logger
        self.ignore_file = self.data_dir / "validation_ignore.json"

    # ==================== Conflict detection ====================

    def _templates(self, artist: Artist, group: str = ""):
        cv = lambda k: get_config_value(artist, self.config, k)
        return {
            'download_dir': cv('download_dir'),
            'artist_folder_template': cv('artist_folder_template'),
            'post_folder_template': cv('post_folder_template'),
            'file_template': cv('file_template'),
            'date_format': cv('date_format'),
            'rename_images_only': cv('rename_images_only'),
            # Must agree with Downloader._artist_dir, or every file looks missing.
            'group': group,
        }

    @staticmethod
    def _artist_dir(artist: Artist, t) -> Path:
        return Formatter.artist_dir(t['download_dir'], artist,
                                    t['artist_folder_template'], t['group'])

    def find_conflicts(self, artists: List[Artist]) -> List[Tuple[str, List[str]]]:
        """`[(path, [ids])]` for every path claimed by more than one item."""
        artist_paths = defaultdict(list)   # path -> [artist_id]
        post_paths = defaultdict(list)     # path -> ["artist:post"]
        file_paths = defaultdict(list)     # path -> ["artist:post:name"]

        groups = self.storage.artist_groups()   # read once, not per artist
        for artist in artists:
            t = self._templates(artist, groups.get(artist.id, ""))
            artist_dir = self._artist_dir(artist, t)
            artist_paths[str(artist_dir)].append(artist.id)

            for post in self.cache.load_posts(artist.id):
                files = extract_files(post)
                if not files:
                    continue
                post_folder = Formatter.post_folder(post, t['post_folder_template'], t['date_format'])
                post_dir = artist_dir / post_folder
                post_paths[str(post_dir)].append(f"{artist.id}:{post.id}")

                names = Formatter.file_names([f['name'] for f in files], t['file_template'],
                                             t['rename_images_only'], self.config.image_extensions)
                for f, name in zip(files, names):
                    file_paths[str(post_dir / name)].append(f"{artist.id}:{post.id}:{f['name']}")

        conflicts = []
        for group in (artist_paths, post_paths, file_paths):
            for path, ids in group.items():
                if len(ids) > 1:
                    conflicts.append((path, ids))
        conflicts.sort(key=lambda x: len(x[1]), reverse=True)
        return self._filter_ignored(conflicts)

    # ==================== Ignore management ====================

    def load_ignores(self) -> Dict:
        if not self.ignore_file.exists():
            return {}
        try:
            data = json.loads(self.ignore_file.read_text(encoding='utf-8'))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def save_ignores(self, data: Dict):
        self.ignore_file.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')

    def _filter_ignored(self, conflicts):
        ignored = set(self.load_ignores().get('ignored_paths', []))
        return [(p, ids) for p, ids in conflicts if p not in ignored]

    def ignore_paths(self, paths: List[str]):
        data = self.load_ignores()
        current = set(data.get('ignored_paths', []))
        current.update(paths)
        data['ignored_paths'] = sorted(current)
        self.save_ignores(data)

    def clear_ignores(self):
        self.save_ignores({'ignored_paths': []})

    # ==================== Cache reset for conflicts ====================

    def reset_conflicts(self, artist: Artist) -> int:
        """Mark every post involved in a conflict as undone (cache only)."""
        conflicts = self.find_conflicts([artist])
        post_ids = set()
        for _path, ids in conflicts:
            for ident in ids:
                parts = ident.split(':')
                if len(parts) >= 2 and parts[0] == artist.id:
                    post_ids.add(parts[1])
        for pid in post_ids:
            self.cache.update_post(artist.id, pid, done=False, failed_files=[])
        if post_ids:
            self.logger.validator_reset(artist=artist.display_name(), posts=len(post_ids))
        return len(post_ids)

    # ==================== Orphan folder cleanup ====================

    def clean_post_folders(self, artist: Artist, quarantine: str = "_invalid",
                           dry: bool = True) -> List[Tuple[str, str]]:
        """Quarantine folders matching no cached post. Returns (from, to) moves."""
        t = self._templates(artist, self.storage.artist_group(artist.id))
        artist_dir = self._artist_dir(artist, t)
        if not artist_dir.is_dir():
            return []

        expected = {
            Formatter.post_folder(p, t['post_folder_template'], t['date_format'])
            for p in self.cache.load_posts(artist.id) if extract_files(p)
        }
        quarantine_dir = artist_dir / quarantine
        moves = []
        for child in artist_dir.iterdir():
            if not child.is_dir() or child.name == quarantine:
                continue
            if child.name not in expected:
                target = quarantine_dir / child.name
                moves.append((str(child), str(target)))
                if not dry:
                    quarantine_dir.mkdir(parents=True, exist_ok=True)
                    child.rename(target)
        if moves and not dry:
            self.logger.validator_quarantined(artist=artist.display_name(), count=len(moves))
        return moves
