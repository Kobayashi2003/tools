from pathlib import Path
from typing import List

from ..common.hotreload import plugin_hook
from ..common.naming import format_date, sanitize_component, sanitize_path
from .models import Artist, Post

# Hooks resolve per call, so edits hot-reload. No-ops by default.
_FORMAT_PLUGIN = 'src/plugins/format_plugin.py'


def group_values(group: str) -> dict:
    """The `{group*}` variables: the creator's path under `data/artists/` minus
    the `.json` (see `Storage.artist_groups`). `artists.json` gives `''`, so
    they all come out empty and drop out of the path.

    Path-valued, unlike every other variable: their `/` is real hierarchy.
    """
    parts = [p for p in group.split('/') if p]
    return {
        'group': sanitize_path(group),
        'group_top': sanitize_path(parts[0]) if parts else '',
        'group_tail': sanitize_path('/'.join(parts[1:])),
        'group_leaf': sanitize_path(parts[-1]) if parts else '',
    }


class Formatter:
    """Builds `download_dir / artist_folder / post_folder / file_name`.

    Every segment is sanitized for use as a Windows path component. Each level
    can be customised by a hot-reloaded plugin.
    """

    @staticmethod
    def artist_dir(download_dir: str, artist: Artist, template: str, group: str = "") -> Path:
        return Path(download_dir) / Formatter.artist_folder(artist, template, group)

    @staticmethod
    @plugin_hook('format_artist_plugin', _FORMAT_PLUGIN)
    def artist_folder(artist: Artist, template: str, group: str = "") -> Path:
        # Name values are sanitized *before* substitution: only a '/' written in
        # the template, or a path-valued {group*}, may create a directory. An
        # alias like "hans.B / 藩滑るめる" would otherwise split into two levels.
        raw = template.format(
            service=sanitize_component(artist.service),
            name=sanitize_component(artist.name),
            alias=sanitize_component(artist.alias or artist.name),
            user_id=sanitize_component(artist.user_id),
            last_date=(artist.last_date[:10] if artist.last_date else ""),
            **group_values(group),
        )
        return Path(sanitize_path(raw))

    @staticmethod
    @plugin_hook('format_post_plugin', _FORMAT_PLUGIN)
    def post_folder(post: Post, template: str, date_format: str) -> str:
        raw = template.format(
            id=post.id,
            user=post.user,
            service=post.service,
            title=post.title,
            published=format_date(post.published, date_format),
        )
        return sanitize_component(raw)

    @staticmethod
    @plugin_hook('format_file_plugin', _FORMAT_PLUGIN)
    def format_file(name: str, idx: int, template: str) -> str:
        """Fields: `idx`, `name`."""
        out = template.format(idx=idx, name=name)
        if '.' not in out and '.' in name:
            out = f"{out}.{name.rsplit('.', 1)[-1]}"
        return sanitize_component(out)

    @staticmethod
    def file_names(names: List[str], template: str,
                   rename_images_only: bool, image_extensions: set) -> List[str]:
        """With `rename_images_only`, non-images keep their original name and
        images get a 0-based `{idx}`."""
        result = []
        image_index = 0
        for i, original in enumerate(names):
            is_image = Path(original).suffix.lower() in image_extensions
            if not rename_images_only or is_image:
                idx = image_index if (rename_images_only and is_image) else i
                if is_image:
                    image_index += 1
                result.append(Formatter.format_file(original, idx, template))
            else:
                result.append(sanitize_component(original))
        return result
