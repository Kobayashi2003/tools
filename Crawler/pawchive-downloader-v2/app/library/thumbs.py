"""Post cover thumbnails, made once and cached under `data/thumbs/`.

Tried in order, cheapest and most local first:
1. the cover (or first image) already downloaded;
2. the cover thumbnail Fanbox lists for every post, paid or not;
3. the original cover from a Fanbox post body;
4. Pawchive's thumbnail service, paced by the same 1 request/s bucket as Pawchive's file
   downloads, so browsing never adds load the operator did not agree to.

A post with no cover anywhere gets a marker and is not asked about again for a day.
"""

import io
import threading
import time
from pathlib import Path

import requests
from PIL import Image

from ..engine.context import Context
from ..engine.download import post_dir
from ..net.limiter import RequestLimiter

# Sharp on a 2x screen in a grid card, and in the post panel's full-width cover.
WIDTH = 640
RETRY_MISSING = 86400.0
PAWCHIVE_THUMBS = "https://img.pawchive.pw/thumbnail/data"


class Thumbs:
    def __init__(self, ctx: Context):
        self.ctx = ctx
        # Per size, so changing WIDTH never serves a cache made at another size.
        self.root = ctx.data_dir / "thumbs" / str(WIDTH)
        self.session = requests.Session()
        # pximg is a public CDN, but a page of rows asks for dozens at once.
        self.pximg = RequestLimiter(4, 4)
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def _lock(self, key: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(key, threading.Lock())

    def path(self, creator_id: str, post_id: str) -> Path:
        return self.root / creator_id / f"{post_id}.jpg"

    def get(self, creator_id: str, post_id: str) -> Path | None:
        target = self.path(creator_id, post_id)
        if target.exists():
            return target
        missing = target.with_suffix(".none")
        if missing.exists() and time.time() - missing.stat().st_mtime < RETRY_MISSING:
            return None
        with self._lock(f"{creator_id}/{post_id}"):
            if target.exists():
                return target
            data = self._find(creator_id, post_id)
            target.parent.mkdir(parents=True, exist_ok=True)
            if data is None or not self._write(data, target):
                missing.touch()
                return None
            missing.unlink(missing_ok=True)
            return target

    @staticmethod
    def _write(data: bytes | Path, target: Path) -> bool:
        try:
            with Image.open(data if isinstance(data, Path) else io.BytesIO(data)) as im:
                im.draft("RGB", (WIDTH * 2, WIDTH * 2))  # JPEG: decode at a reduced size
                im = im.convert("RGB")
                im.thumbnail((WIDTH, WIDTH * 2), Image.Resampling.LANCZOS)
                tmp = target.with_suffix(".tmp")
                im.save(tmp, "JPEG", quality=82, optimize=True)
                tmp.replace(target)
            return True
        except OSError, ValueError, Image.DecompressionBombError:
            return False

    def _find(self, creator_id: str, post_id: str) -> bytes | Path | None:
        ctx = self.ctx
        creator = ctx.creator(creator_id)
        post = ctx.db.one(
            "SELECT * FROM posts WHERE creator_id=? AND post_id=?", (creator_id, post_id)
        )
        if creator is None or post is None:
            return None
        files = ctx.db.all(
            "SELECT * FROM files WHERE creator_id=? AND post_id=? AND role IN ('cover','image') "
            "ORDER BY role<>'cover', ordinal",
            (creator_id, post_id),
        )
        folder = post_dir(ctx, creator, post)
        for f in files:
            if f["state"] == "done" and f["local_name"] and (folder / f["local_name"]).is_file():
                return folder / f["local_name"]
        obs = ctx.db.one(
            "SELECT cover_url FROM post_obs WHERE creator_id=? AND post_id=? AND source='fanbox'",
            (creator_id, post_id),
        )
        urls = [obs["cover_url"]] if obs and obs["cover_url"] else []
        urls += [f["f_url"] for f in files[:1] if f["role"] == "cover" and f["f_url"]]
        for url in urls:
            data = self._fetch_pximg(url)
            if data:
                return data
        for f in files[:1]:
            if f["p_path"]:
                data = self._fetch_pawchive(f["p_path"])
                if data:
                    return data
        return None

    def _fetch_pximg(self, url: str) -> bytes | None:
        if not self.pximg.acquire():
            return None
        try:
            r = self.session.get(
                url,
                headers={
                    "Referer": "https://www.fanbox.cc/",
                    "User-Agent": self.ctx.settings.fanbox_user_agent,
                },
                timeout=20,
            )
        except requests.RequestException:
            return None
        return r.content if r.ok and r.content else None

    def _fetch_pawchive(self, path: str) -> bytes | None:
        throttle = self.ctx.pawchive_http.throttle
        if not throttle.request():
            return None
        try:
            r = self.session.get(
                PAWCHIVE_THUMBS + path,
                headers={"User-Agent": self.ctx.settings.user_agent},
                timeout=20,
            )
        except requests.RequestException:
            return None
        return r.content if r.ok and r.content else None
