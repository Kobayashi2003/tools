import threading
from pathlib import Path
from typing import Dict, List, Optional

from ..common import env
from ..common.jsonio import coerce, read_json, write_json
from .models import Artist, Config, HistoryRecord


class Storage:
    """Persists artists, config and command history as JSON under `data_dir`.

    Artists live in `artists.json`. As a convenience, any `*.json` files under
    `data/artists/` are also loaded (read-only, deduped by id) so creators can
    be organised into folders; `artists.json` always wins on conflicts. That
    folder layout is also what the `{group}` path template variable mirrors into
    the download tree -- see `artist_groups`.
    """

    def __init__(self, data_dir: str = None):
        # Bootstrap path: it says where config.json is, so it can't come from it.
        self.data_dir = Path(data_dir or env.get('DATA_DIR', 'data'))
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.artists_dir = self.data_dir / "artists"
        self.artists_file = self.data_dir / "artists.json"
        self.config_file = self.data_dir / "config.json"
        self.history_file = self.data_dir / "history.json"
        self.lock = threading.RLock()
        self._ensure_files()

    def _ensure_files(self):
        for path, default in ((self.artists_file, []), (self.config_file, {}),
                              (self.history_file, [])):
            if not path.exists():
                write_json(path, default)

    # ==================== Config ====================

    def load_config(self) -> Config:
        """Config, with `PAWCHIVE_*` env vars overlaid on top of the file."""
        with self.lock:
            data = read_json(self.config_file, {})
            if isinstance(data.get('image_extensions'), list):
                data['image_extensions'] = set(data['image_extensions'])
            config = coerce(Config, data)

        env.apply_overrides(config)
        config.data_dir = str(self.data_dir)  # never disagree with the real path
        return config

    def save_config(self, config: Config):
        """Write the file, keeping the on-disk value of anything env overrode.

        Persisting an override would bake one machine's paths into a file meant
        to be shared -- and would silently discard what the user had configured.
        """
        with self.lock:
            on_disk = read_json(self.config_file, {})
            data = dict(config.__dict__)
            if isinstance(data.get('image_extensions'), set):
                data['image_extensions'] = sorted(data['image_extensions'])
            for field in env.OVERRIDABLE:
                if not env.get(field):
                    continue
                if field in on_disk:
                    data[field] = on_disk[field]
                else:
                    data.pop(field, None)
            write_json(self.config_file, data)

    # ==================== Artists ====================

    def _read_primary(self) -> List[Artist]:
        return [coerce(Artist, item) for item in read_json(self.artists_file, [])]

    def _write_primary(self, artists: List[Artist]):
        write_json(self.artists_file, [a.__dict__ for a in artists])

    def get_artists(self) -> List[Artist]:
        with self.lock:
            artists = self._read_primary()
            seen = {a.id for a in artists}
            for _group, item in self._read_subdir_items():
                aid = item.get('id')
                if aid and aid not in seen:
                    artists.append(coerce(Artist, item))
                    seen.add(aid)
            return artists

    def _read_subdir_items(self):
        """Every artist dict under `artists/`, with the group path it came from.

        The group is the file's own location relative to `artists/`, minus the
        `.json`: `artists/絵師/ロリメイン/T0.json` -> `絵師/ロリメイン/T0`.

        A corrupt file raises rather than being skipped: skipping it would drop
        every artist it holds, and `save_artist` would then append a duplicate.
        """
        if not self.artists_dir.is_dir():
            return
        for path in sorted(self.artists_dir.rglob('*.json')):
            group = path.relative_to(self.artists_dir).with_suffix('').as_posix()
            content = read_json(path, [])
            items = content if isinstance(content, list) else [content]
            for item in items:
                if isinstance(item, dict):
                    yield group, item

    def artist_groups(self) -> Dict[str, str]:
        """`artist_id -> group path`, feeding the `{group}` template variables.

        Artists in `artists.json` map to `''` (the download root); it wins on
        conflicts, matching `get_artists`. Callers looping over many artists
        should read this map once rather than calling `artist_group` per artist.
        """
        with self.lock:
            groups: Dict[str, str] = {}
            for group, item in self._read_subdir_items():
                aid = item.get('id')
                if aid and aid not in groups:
                    groups[aid] = group
            for artist in self._read_primary():
                groups[artist.id] = ""
            return groups

    def artist_group(self, artist_id: str) -> str:
        return self.artist_groups().get(artist_id, "")

    def get_artist(self, artist_id: str) -> Optional[Artist]:
        return next((a for a in self.get_artists() if a.id == artist_id), None)

    def save_artist(self, artist: Artist):
        with self.lock:
            # Update in place if present in artists.json.
            artists = self._read_primary()
            for i, a in enumerate(artists):
                if a.id == artist.id:
                    artists[i] = artist
                    self._write_primary(artists)
                    return

            # Otherwise, try to update within the artists/ folder tree.
            if self._update_in_subdir(artist):
                return

            # New artist: append to artists.json.
            artists.append(artist)
            self._write_primary(artists)

    def _update_in_subdir(self, artist: Artist) -> bool:
        if not self.artists_dir.is_dir():
            return False
        for path in sorted(self.artists_dir.rglob('*.json')):
            content = read_json(path, [])
            changed = False
            if isinstance(content, dict) and content.get('id') == artist.id:
                content = artist.__dict__
                changed = True
            elif isinstance(content, list):
                for idx, item in enumerate(content):
                    if isinstance(item, dict) and item.get('id') == artist.id:
                        content[idx] = artist.__dict__
                        changed = True
                        break
            if changed:
                write_json(path, content)
                return True
        return False

    def remove_artist(self, artist_id: str):
        with self.lock:
            artists = self._read_primary()
            remaining = [a for a in artists if a.id != artist_id]
            if len(remaining) != len(artists):
                self._write_primary(remaining)
                return

            if not self.artists_dir.is_dir():
                return
            for path in sorted(self.artists_dir.rglob('*.json')):
                content = read_json(path, [])
                if isinstance(content, dict) and content.get('id') == artist_id:
                    path.unlink(missing_ok=True)
                    return
                if isinstance(content, list):
                    new = [i for i in content if not (isinstance(i, dict) and i.get('id') == artist_id)]
                    if len(new) != len(content):
                        write_json(path, new)
                        return

    # ==================== History ====================

    def add_history(self, command: str, success: bool = True, artist_id: str = None,
                    params: dict = None, note: str = ""):
        with self.lock:
            data = read_json(self.history_file, [])
            data.append(HistoryRecord(
                command=command, success=success, artist_id=artist_id,
                params=params or {}, note=note,
            ).__dict__)
            write_json(self.history_file, data[-500:])

    def get_history(self, limit: int = 10) -> List[HistoryRecord]:
        with self.lock:
            data = read_json(self.history_file, [])
            return [coerce(HistoryRecord, item) for item in data[-limit:]][::-1]
