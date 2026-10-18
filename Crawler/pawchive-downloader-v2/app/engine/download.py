"""Download a creator's undone posts, choosing a source per file.

Order of sources comes from the preference (`pawchive-first` by default). A file
the first source cannot deliver is tried from the other one in the same run, so
a Pawchive 404 on a post you subscribe to is fetched from Fanbox at once rather
than waiting a day. A spent quota pauses the run; nothing is marked failed for it.
"""

import hashlib
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import requests

from ..domain.filters import FilterTarget, combined, reason
from ..domain.naming import post_folder
from ..domain.timefmt import now_utc
from ..net.limiter import QuotaExceeded
from ..sources.http import Cancelled, PermanentError
from ..store.db import load
from .context import Context
from .sync import Stopped

IMAGE_ROLES = ("image", "cover")


@dataclass
class DownloadResult:
    posts_done: int = 0
    posts_failed: int = 0
    files: int = 0
    unavailable: int = 0
    paused: str = ""

    def summary(self) -> str:
        parts = [f"{self.posts_done} posts done", f"{self.files} files"]
        if self.posts_failed:
            parts.append(f"{self.posts_failed} posts incomplete")
        if self.unavailable:
            parts.append(f"{self.unavailable} files not available yet (404 deferral or no source)")
        if self.paused:
            parts.append(self.paused)
        return " · ".join(parts)


def post_dir(ctx: Context, creator: sqlite3.Row, post: sqlite3.Row) -> Path:
    if post["local_dir"]:
        return Path(post["local_dir"])
    return ctx.creator_dir(creator) / post_folder(
        ctx.value(creator, "post_folder_template"),
        post_id=post["post_id"],
        user=creator["user_id"],
        service=creator["service"],
        title=post["title"],
        published=post["published"],
        fmt=ctx.value(creator, "date_format"),
    )


def filter_reason(
    ctx: Context, creator: sqlite3.Row, post: sqlite3.Row, files: int, attachments: int
) -> str | None:
    cfg, origin = combined(ctx.settings.global_filter, load(creator["filter"], {}) or {})
    return reason(FilterTarget(post["title"], post["published"], files, attachments), cfg, origin)


def verify(path: Path, row: sqlite3.Row, via: str) -> int | None:
    """1 if the file matches what the sources say about it, 0 if not, None if nothing to check."""
    from ..library.imagesize import image_size

    size = path.stat().st_size
    if row["size"]:
        return int(size == row["size"])
    if row["width"] and row["height"] and row["role"] in IMAGE_ROLES:
        dims = image_size(path)
        if dims:
            return int(dims == (row["width"], row["height"]))
    if row["sha256"] and via != "pawchive":
        # Pawchive's path is the content hash: a Fanbox copy can be proven identical.
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return int(h.hexdigest() == row["sha256"])
    return None


class Downloader:
    def __init__(self, ctx: Context, cancel: threading.Event, progress):
        self.ctx = ctx
        self.cancel = cancel
        self.progress = progress

    def _candidates(self, row: sqlite3.Row, preference: str, force: str | None) -> list[str]:
        order = ["fanbox", "pawchive"] if preference == "fanbox-first" else ["pawchive", "fanbox"]
        if force:
            order = [force]
        out = []
        for source in order:
            if source == "pawchive" and row["present_p"] and row["p_path"]:
                if self.ctx.deferrals.due("pawchive", row["p_path"]):
                    out.append(source)
            elif source == "fanbox" and row["present_f"] and row["f_url"]:
                if self.ctx.fanbox_usable():
                    out.append(source)
        return out

    def _fetch(self, source: str, row: sqlite3.Row, target: Path) -> None:
        ctx = self.ctx
        if source == "pawchive":
            url = ctx.pawchive.file_url(row["p_path"], row["name"])
            http, headers = ctx.pawchive_http, None
        else:
            url, http, headers = row["f_url"], ctx.fanbox_http, ctx.fanbox.download_headers()
        http.retry(
            lambda: http.download(url, target, headers=headers),
            f"download {row['local_name']}",
            attempts=ctx.settings.download_max_retries,
        )

    def _file(
        self,
        creator: sqlite3.Row,
        folder: Path,
        row: sqlite3.Row,
        preference: str,
        force: str | None,
        redownload: bool,
    ) -> str:
        """`done`, `failed`, `unavailable` or `quota` for one file."""
        ctx = self.ctx
        target = folder / row["local_name"]
        if not redownload and target.exists() and target.stat().st_size > 0:
            checked = verify(target, row, "local")
            if checked != 0:
                self._mark(row, "done", "local", target, checked)
                return "done"
        sources = self._candidates(row, preference, force)
        if not sources:
            return "unavailable"
        errors = []
        for source in sources:
            if self.cancel.is_set():
                raise Stopped()
            try:
                self._fetch(source, row, target)
            except QuotaExceeded as e:
                return "quota:" + str(e)
            except Cancelled:
                raise Stopped() from None
            except PermanentError as e:
                if source == "pawchive":
                    entry = ctx.deferrals.miss("pawchive", row["p_path"], row["name"])
                    errors.append(f"Pawchive 404 (retry in {entry['wait_days']:g} days)")
                else:
                    errors.append(f"Fanbox: {e}")
                continue
            except (requests.RequestException, OSError) as e:
                errors.append(f"{source}: {e}")
                continue
            if source == "pawchive" and ctx.deferrals.clear("pawchive", row["p_path"]):
                ctx.events.log(
                    "info",
                    f"{row['local_name']}: a file that used to 404 has arrived",
                    creator["id"],
                )
            self._mark(row, "done", source, target, verify(target, row, source))
            return "done"
        self.ctx.db.run(
            "UPDATE files SET state='failed', error=? WHERE id=?", ("; ".join(errors), row["id"])
        )
        return "failed"

    def _mark(self, row: sqlite3.Row, state: str, via: str, target: Path, verified: int | None):
        self.ctx.db.run(
            """UPDATE files SET state=?, via=?, local_size=?, verified=?, done_at=?, error=NULL
               WHERE id=?""",
            (state, via, target.stat().st_size, verified, now_utc(), row["id"]),
        )

    def post(
        self,
        creator: sqlite3.Row,
        post: sqlite3.Row,
        *,
        force: str | None = None,
        redownload: bool = False,
    ) -> dict[str, int]:
        ctx = self.ctx
        folder = post_dir(ctx, creator, post)
        rows = ctx.db.all(
            "SELECT * FROM files WHERE creator_id=? AND post_id=? ORDER BY ordinal",
            (creator["id"], post["post_id"]),
        )
        todo = [r for r in rows if redownload or r["state"] != "done"]
        tally = {"done": 0, "failed": 0, "unavailable": 0}
        known_files = post["p_state"] == "full" or post["f_state"] == "open" or bool(rows)
        if not rows and not known_files:
            return tally
        folder.mkdir(parents=True, exist_ok=True)
        if ctx.value(creator, "save_content") and post["content"]:
            (folder / "content.txt").write_text(post["content"], encoding="utf-8", errors="ignore")
        preference = ctx.preference(creator)
        quota_note = ""
        workers = max(1, ctx.settings.max_concurrent_files)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            outcomes = list(
                pool.map(
                    lambda r: self._file(creator, folder, r, preference, force, redownload), todo
                )
            )
        for outcome in outcomes:
            if outcome.startswith("quota:"):
                quota_note = outcome[6:]
                tally["unavailable"] += 1
            else:
                tally[outcome] += 1
        left = ctx.db.one(
            "SELECT COUNT(*) AS n FROM files WHERE creator_id=? AND post_id=? AND state<>'done'",
            (creator["id"], post["post_id"]),
        )
        remaining = left["n"] if left else 0
        done = remaining == 0 and (bool(rows) or known_files)
        ctx.db.run(
            "UPDATE posts SET local_dir=?, local_done=?, done_at=CASE WHEN ? THEN ? ELSE done_at END, "
            "stale=CASE WHEN ? THEN NULL ELSE stale END WHERE creator_id=? AND post_id=?",
            (
                str(folder),
                int(done),
                int(done),
                now_utc(),
                int(done),
                creator["id"],
                post["post_id"],
            ),
        )
        if quota_note:
            raise QuotaExceeded(quota_note)
        return tally

    def creator(
        self,
        creator_id: str,
        *,
        post_ids: list[str] | None = None,
        force: str | None = None,
        redownload: bool = False,
    ) -> DownloadResult:
        ctx = self.ctx
        creator = ctx.creator(creator_id)
        if creator is None:
            raise KeyError(creator_id)
        result = DownloadResult()
        if creator["ignore"] and not post_ids:
            result.paused = "creator is ignored"
            return result
        if post_ids:
            marks = ",".join("?" * len(post_ids))
            posts = ctx.db.all(
                f"SELECT * FROM posts WHERE creator_id=? AND post_id IN ({marks}) ORDER BY published",
                (creator_id, *post_ids),
            )
        else:
            posts = ctx.db.all(
                "SELECT * FROM posts WHERE creator_id=? AND local_done=0 ORDER BY published",
                (creator_id,),
            )
        counts = {
            r["post_id"]: (r["n"], r["att"])
            for r in ctx.db.all(
                "SELECT post_id, COUNT(*) AS n, SUM(role<>'cover') AS att FROM files "
                "WHERE creator_id=? GROUP BY post_id",
                (creator_id,),
            )
        }
        for n, post in enumerate(posts, 1):
            if self.cancel.is_set():
                raise Stopped()
            files, att = counts.get(post["post_id"], (0, 0))
            if not post_ids and filter_reason(ctx, creator, post, files, att or 0):
                continue
            self.progress(f"Downloading {n}/{len(posts)}: {post['title'][:40]}")
            try:
                tally = self.post(creator, post, force=force, redownload=redownload)
            except QuotaExceeded as e:
                result.paused = f"traffic quota spent: {e}"
                ctx.events.log("error", result.paused, creator_id)
                break
            result.files += tally["done"]
            result.unavailable += tally["unavailable"]
            if tally["failed"] or tally["unavailable"]:
                result.posts_failed += 1
            elif tally["done"] or files == 0:
                result.posts_done += 1
        self._advance_last_date(creator_id)
        return result

    def _advance_last_date(self, creator_id: str):
        """The newest date up to which every kept post is settled, as v1 kept it."""
        creator = self.ctx.creator(creator_id)
        if creator is None:
            return
        rows = self.ctx.db.all(
            "SELECT published, local_done, p_state, f_state FROM posts WHERE creator_id=? "
            "AND published>? ORDER BY published",
            (creator_id, creator["last_date"] or ""),
        )
        last = creator["last_date"] or ""
        for r in rows:
            settled = r["local_done"] or (r["p_state"] != "full" and r["f_state"] != "open")
            if not settled:
                break
            last = r["published"]
        if last and last != (creator["last_date"] or ""):
            self.ctx.db.run("UPDATE creators SET last_date=? WHERE id=?", (last, creator_id))
