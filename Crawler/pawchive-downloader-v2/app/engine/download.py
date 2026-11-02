"""Download a creator's undone posts, choosing a source per file.

Order of sources comes from the preference (`fanbox-first` by default; "fanbox" is the
creator's own site, Fanbox or Patreon). A file the first source cannot deliver is tried
from the other one in the same run, so a post the site locks or lost is fetched from
Pawchive at once, and a Pawchive 404 on a post you subscribe to is fetched from the site.
A file Pawchive answered 404 for is asked for again only by a download of chosen posts.
A spent quota pauses the run; nothing is marked failed for it.
"""

import filecmp
import hashlib
import os
import shutil
import sqlite3
import threading
from collections import Counter
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import requests

from ..domain.filters import FilterTarget, combined, reason
from ..domain.status import shown_via, site_label, source_order
from ..domain.timefmt import now_utc
from ..net.limiter import QuotaExceeded
from ..sources.http import Cancelled, PermanentError, TransientError, carry
from ..sources.patreon import find_ffmpeg, is_stream, save_stream
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
            parts.append(f"{self.unavailable} files not available (Pawchive 404 or no source)")
        if self.paused:
            parts.append(self.paused)
        return " · ".join(parts)


def post_dir(ctx: Context, creator: sqlite3.Row, post: sqlite3.Row) -> Path:
    """Where a post's files were last seen, for reading (thumbnails, the post page)."""
    if post["local_dir"]:
        return Path(post["local_dir"])
    return save_dir(ctx, creator, post)


def save_dir(ctx: Context, creator: sqlite3.Row, post: sqlite3.Row) -> Path:
    """Where a post's files are saved: always the download folder's layout, as in v1. Folders
    are moved elsewhere by hand once looked at (to an archive drive), so a recorded folder
    outside this layout is never written to."""
    return ctx.creator_dir(creator) / ctx.post_folder_name(creator, post)


def filter_reason(
    ctx: Context, creator: sqlite3.Row, post: sqlite3.Row, files: int, attachments: int
) -> str | None:
    cfg, origin = combined(ctx.settings.global_filter, load(creator["filter"], {}) or {})
    return reason(FilterTarget(post["title"], post["published"], files, attachments), cfg, origin)


def cover_preference(main: list[sqlite3.Row], preference: str) -> str:
    """The cover comes from the source most of the post's files came from; for a post
    without files, from the preferred one."""
    got = Counter(shown_via(r["via"]) for r in main if r["state"] == "done" and r["via"])
    if got["fanbox"] != got["pawchive"]:
        return "fanbox-first" if got["fanbox"] > got["pawchive"] else "pawchive-first"
    return preference


def verify(path: Path, row: sqlite3.Row, via: str) -> int | None:
    """1 if the file matches what the sources say about it, 0 if not, None if nothing to check."""
    from ..library.imagesize import image_size

    if row["role"] == "cover":
        # Pawchive's cover is Fanbox's 1200x630 preview and Fanbox's is the original:
        # either one is the cover, and nothing about it can be checked.
        return None
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


class OldVersion:
    """Under the `keep` update policy, copies a post's folder aside once, before the first
    file in it is replaced by different bytes. The copy is named after the date of the
    newest file it holds: "<folder> [old 2022.12.19]"."""

    def __init__(self, folder: Path, keep: bool, date_format: str):
        self.folder = folder
        self.keep = keep
        self.date_format = date_format
        self.saved: Path | None = None
        self._lock = threading.Lock()

    def __call__(self) -> None:
        with self._lock:
            if not self.keep or self.saved or not self.folder.is_dir():
                return
            # Dot files are other downloads' temporaries.
            held = [p for p in self.folder.iterdir() if p.is_file() and not p.name.startswith(".")]
            if not held:
                return
            stamp = datetime.fromtimestamp(max(p.stat().st_mtime for p in held))
            base = f"{self.folder.name} [old {stamp.strftime(self.date_format)}]"
            target, n = self.folder.with_name(base), 2
            while target.exists():
                target, n = self.folder.with_name(f"{base} ({n})"), n + 1
            shutil.copytree(self.folder, target, ignore=shutil.ignore_patterns(".*"))
            self.saved = target


class Downloader:
    def __init__(self, ctx: Context, cancel: threading.Event, progress):
        self.ctx = ctx
        self.cancel = cancel
        self.progress = progress
        # Set for a download of chosen posts: files Pawchive 404ed are asked for again.
        self.by_hand = False

    def _candidates(
        self, creator: sqlite3.Row, row: sqlite3.Row, preference: str, force: str | None
    ) -> list[str]:
        out = []
        for source in [force] if force else source_order(preference):
            if source == "pawchive" and row["present_p"] and row["p_path"]:
                if self.by_hand or not self.ctx.deferrals.missing("pawchive", row["p_path"]):
                    out.append(source)
            elif source == "fanbox" and row["present_f"] and row["f_url"]:
                # "fanbox" is the creator's own site: Fanbox or Patreon.
                if self.ctx.site_usable(creator["service"]):
                    out.append(source)
        return out

    def _fetch(self, creator: sqlite3.Row, source: str, row: sqlite3.Row, target: Path) -> None:
        ctx = self.ctx
        if source == "pawchive":
            url = ctx.pawchive.file_url(row["p_path"], row["name"])
            http, headers = ctx.pawchive_http, None
        elif creator["service"] == "patreon":
            url, http, headers = row["f_url"], ctx.patreon_http, None
            if is_stream(url):
                ffmpeg = find_ffmpeg(ctx.settings.ffmpeg_path)
                if not ffmpeg:
                    raise OSError("a Patreon video needs ffmpeg (on PATH, or set ffmpeg_path)")
                with http.throttle.slot():
                    save_stream(url, target, ffmpeg, lambda: self.cancel.is_set())
                return
        else:
            url, http, headers = row["f_url"], ctx.fanbox_http, ctx.fanbox.download_headers()
        http.retry(
            lambda: http.download(url, target, headers=headers),
            f"download {row['local_name']}",
            attempts=ctx.settings.download_max_retries,
        )

    def _refresh_patreon(self, creator: sqlite3.Row, post: sqlite3.Row) -> None:
        """Patreon's file addresses are signed and expire; take fresh ones for the post
        before fetching it. Without them the stored ones are tried, which may still work."""
        try:
            fresh = self.ctx.patreon.post(post["post_id"])
        except (requests.RequestException, TransientError, PermanentError) as e:
            self.ctx.events.log(
                "warning",
                f"Patreon post {post['post_id']}: could not renew its file addresses: {e}",
                creator["id"],
            )
            return
        with self.ctx.db.tx() as conn:
            conn.executemany(
                "UPDATE files SET f_url=? WHERE creator_id=? AND post_id=? AND key=?",
                [(e.url, creator["id"], post["post_id"], e.key) for e in fresh.entries if e.url],
            )

    def _file(
        self,
        creator: sqlite3.Row,
        folder: Path,
        row: sqlite3.Row,
        preference: str,
        force: str | None,
        redownload: bool,
        keep_old: Callable[[], None],
        held: list[Path],
    ) -> str:
        """`done`, `failed`, `unavailable` or `quota` for one file. `held`: the folders the
        post's saved files are in."""
        ctx = self.ctx
        target = folder / row["local_name"]
        replacing = target.exists() and target.stat().st_size > 0
        if not redownload and replacing:
            checked = verify(target, row, "local")
            if checked != 0:
                self._mark(row, "done", "local", target, checked)
                return "done"
        # A post can show one image twice under two names. Pawchive keeps the bytes once
        # and may never serve the second name, while Fanbox lists both: the copy already
        # saved stands for both, and is not fetched or kept a second time.
        if row["sha256"] and not redownload:
            twin = self._twin(row, held, lambda f, _p: f["sha256"] == row["sha256"])
            if twin:
                self._same_as(row, twin)
                return "done"
        sources = self._candidates(creator, row, preference, force)
        if not sources:
            return "unavailable"
        # A file already here is fetched beside it and swapped in only if it differs, so
        # an unchanged file never costs the old version a copy.
        incoming = target.with_name(f".{target.name}.incoming") if replacing else target
        errors = []
        for source in sources:
            if self.cancel.is_set():
                raise Stopped()
            try:
                self._fetch(creator, source, row, incoming)
            except QuotaExceeded as e:
                return "quota:" + str(e)
            except Cancelled:
                raise Stopped() from None
            except PermanentError as e:
                if source == "pawchive":
                    ctx.deferrals.miss("pawchive", row["p_path"], row["name"])
                    errors.append("Pawchive 404")
                else:
                    errors.append(f"{site_label(creator['service'])}: {e}")
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
            if replacing:
                if filecmp.cmp(incoming, target, shallow=False):
                    incoming.unlink()
                else:
                    # Covers differ between the sources without the post changing.
                    if row["role"] != "cover":
                        keep_old()
                    os.replace(incoming, target)
            elif twin := self._twin(row, held, lambda _f, p: filecmp.cmp(p, target, False)):
                target.unlink()
                self._same_as(row, twin)
                return "done"
            self._mark(row, "done", source, target, verify(target, row, source))
            return "done"
        self.ctx.db.run(
            "UPDATE files SET state='failed', error=? WHERE id=?", ("; ".join(errors), row["id"])
        )
        return "failed"

    def _twin(
        self, row: sqlite3.Row, held: list[Path], same: Callable[[sqlite3.Row, Path], bool]
    ) -> sqlite3.Row | None:
        """A saved file of the same post, still on disk, that `same` says has this row's
        bytes. Covers are never compared: the two sources' covers always differ."""
        if row["role"] == "cover":
            return None
        for f in self.ctx.db.all(
            "SELECT * FROM files WHERE creator_id=? AND post_id=? AND state='done' "
            "AND role<>'cover' AND id<>? AND local_name IS NOT NULL ORDER BY ordinal",
            (row["creator_id"], row["post_id"], row["id"]),
        ):
            path = next(
                (d / f["local_name"] for d in held if (d / f["local_name"]).is_file()), None
            )
            if path and path.stat().st_size and same(f, path):
                return f
        return None

    def _same_as(self, row: sqlite3.Row, twin: sqlite3.Row) -> None:
        """Record `row` as held by `twin`'s file: same name, source and check."""
        self.ctx.db.run(
            """UPDATE files SET state='done', local_name=?, via=?, local_size=?, verified=?,
               done_at=?, error=NULL WHERE id=?""",
            (
                twin["local_name"],
                twin["via"],
                twin["local_size"],
                twin["verified"],
                now_utc(),
                row["id"],
            ),
        )

    def _mark(self, row: sqlite3.Row, state: str, via: str, target: Path, verified: int | None):
        self.ctx.db.run(
            """UPDATE files SET state=?, via=?, local_size=?, verified=?, done_at=?, error=NULL
               WHERE id=?""",
            (state, via, target.stat().st_size, verified, now_utc(), row["id"]),
        )

    def _text(
        self,
        creator: sqlite3.Row,
        post: sqlite3.Row,
        folder: Path,
        redownload: bool,
        keep_old: Callable[[], None],
    ):
        """content.txt is written once, and again only when the post changed upstream."""
        if not self.ctx.value(creator, "save_content") or not post["content"]:
            return
        target = folder / "content.txt"
        if post["text_at"] and target.exists() and not post["stale"] and not redownload:
            return
        held = target.read_text(encoding="utf-8", errors="ignore") if target.exists() else None
        if held != post["content"]:
            if held is not None:
                keep_old()
            target.write_text(post["content"], encoding="utf-8", errors="ignore")
        self.ctx.db.run(
            "UPDATE posts SET text_at=? WHERE creator_id=? AND post_id=?",
            (now_utc(), creator["id"], post["post_id"]),
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
        folder = save_dir(ctx, creator, post)
        rows = ctx.db.all(
            "SELECT * FROM files WHERE creator_id=? AND post_id=? ORDER BY ordinal",
            (creator["id"], post["post_id"]),
        )
        wanted = [r for r in rows if redownload or r["state"] != "done"]
        if (
            creator["service"] == "patreon"
            and force != "pawchive"
            and any(r["present_f"] for r in wanted)
            and ctx.site_usable("patreon")
        ):
            self._refresh_patreon(creator, post)
            rows = ctx.db.all(
                "SELECT * FROM files WHERE creator_id=? AND post_id=? ORDER BY ordinal",
                (creator["id"], post["post_id"]),
            )
        main = [r for r in rows if r["role"] != "cover"]
        cover = next((r for r in rows if r["role"] == "cover"), None)
        todo = [r for r in main if redownload or r["state"] != "done"]
        tally = {"done": 0, "failed": 0, "unavailable": 0}
        known_files = post["p_state"] == "full" or post["f_state"] == "open" or bool(main)
        if not rows and not known_files:
            return tally
        # The folder appears with the first file saved into it (`HttpClient.download`
        # makes it): a post with nothing to fetch leaves no empty folder behind.
        preference = ctx.preference(creator)
        keep_old = OldVersion(
            folder, ctx.settings.update_policy == "keep", ctx.value(creator, "date_format")
        )
        held = list(dict.fromkeys([folder, post_dir(ctx, creator, post)]))
        quota_note = ""
        workers = max(1, ctx.settings.max_concurrent_files)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            outcomes = list(
                pool.map(
                    carry(
                        lambda r: self._file(
                            creator, folder, r, preference, force, redownload, keep_old, held
                        )
                    ),
                    todo,
                )
            )
        for outcome in outcomes:
            if outcome.startswith("quota:"):
                quota_note = outcome[6:]
                tally["unavailable"] += 1
            else:
                tally[outcome] += 1
        left = ctx.db.one(
            "SELECT COUNT(*) AS n, IFNULL(SUM(state='done'), 0) AS got FROM files "
            "WHERE creator_id=? AND post_id=? AND role<>'cover'",
            (creator["id"], post["post_id"]),
        )
        got = left["got"] if left else 0
        done = (left["n"] if left else 0) == got and known_files
        # The cover and the text go with the files: once one of them is saved, or at once
        # for a post that has none. A missing cover never fails the post.
        if got or (not main and known_files):
            if cover is not None and (redownload or cover["state"] != "done") and not quota_note:
                outcome = self._file(
                    creator,
                    folder,
                    cover,
                    cover_preference(main, preference),
                    force,
                    redownload,
                    keep_old,
                    held,
                )
                if outcome.startswith("quota:"):
                    quota_note = outcome[6:]
            folder.mkdir(parents=True, exist_ok=True)
            self._text(creator, post, folder, redownload, keep_old)
        if keep_old.saved:
            ctx.events.log(
                "info",
                f"{post['title']}: updated; the old version is kept as {keep_old.saved.name}",
                creator["id"],
            )
        # The record follows the files only when something landed in the folder.
        ctx.db.run(
            "UPDATE posts SET local_dir=COALESCE(?, local_dir), local_done=?, "
            "done_at=CASE WHEN ? THEN ? ELSE done_at END, "
            "stale=CASE WHEN ? THEN NULL ELSE stale END WHERE creator_id=? AND post_id=?",
            (
                str(folder) if folder.is_dir() else None,
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
        creator = ctx.require_creator(creator_id)
        result = DownloadResult()
        self.by_hand = bool(post_ids)
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
