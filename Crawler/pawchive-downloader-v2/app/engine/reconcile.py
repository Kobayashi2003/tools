"""Observations -> conclusions: one `posts` row and its `files` rows per post.

Which source wins, field by field: Fanbox is the original, so its title, times, fee
and text win when it has spoken; Pawchive's file list sets the order (Fanbox-only
files follow), so switching source never renumbers files already on disk. A local
name, once given, is never changed here: renaming is the migrator's job.
"""

import sqlite3
from collections.abc import Callable
from dataclasses import dataclass

from ..domain.match import Entry, merge
from ..domain.naming import file_names, unique_names
from ..store.db import dump, load

ORPHAN_ORDINAL = 10_000


@dataclass
class Naming:
    template: str
    rename_images_only: bool
    is_image: Callable[[str], bool]


def _entries(raw: str | None) -> list[Entry]:
    out = []
    for item in load(raw, []) or []:
        item = dict(item)
        item["sources"] = set(item.get("sources") or [])
        out.append(Entry(**item))
    return out


def entries_json(entries: list[Entry]) -> str:
    return dump([{**e.__dict__, "sources": sorted(e.sources)} for e in entries])


def reconcile_creator(
    conn: sqlite3.Connection,
    creator_id: str,
    is_fanbox: bool,
    naming: Naming,
    now: str,
    only: set[str] | None = None,
) -> dict[str, int]:
    """Rebuild conclusions for a creator's posts (or `only` those ids) inside `conn`'s
    transaction. Returns counts of `new` posts and `reopened` ones (more files appeared)."""
    obs: dict[str, dict[str, sqlite3.Row]] = {}
    for row in conn.execute("SELECT * FROM post_obs WHERE creator_id=?", (creator_id,)):
        if only is None or row["post_id"] in only:
            obs.setdefault(row["post_id"], {})[row["source"]] = row
    posts = {
        r["post_id"]: r
        for r in conn.execute("SELECT * FROM posts WHERE creator_id=?", (creator_id,))
    }
    files: dict[str, dict[str, sqlite3.Row]] = {}
    for r in conn.execute("SELECT * FROM files WHERE creator_id=?", (creator_id,)):
        files.setdefault(r["post_id"], {})[r["key"]] = r

    # Once a complete Fanbox listing was read, a post absent from it is deleted there,
    # not merely unchecked. A listing that failed part way says nothing.
    listed = conn.execute(
        "SELECT fanbox_listed_at FROM creators WHERE id=?", (creator_id,)
    ).fetchone()
    fanbox_listed = bool(listed and listed[0])
    counts = {"new": 0, "reopened": 0}
    for post_id, by_source in obs.items():
        p, f = by_source.get("pawchive"), by_source.get("fanbox")
        old = posts.get(post_id)
        title = (f["title"] if f and f["title"] else None) or (p["title"] if p else "")
        published = (f["published"] if f and f["published"] else "") or (
            p["published"] if p else ""
        )
        edited = (f["edited"] if f and f["edited"] else "") or (p["edited"] if p else "")
        mismatch = int(
            bool(p and f and p["published"] and f["published"] and p["published"] != f["published"])
        )
        fee = int(f["fee"] or 0) if f else (old["fee"] if old else 0)
        content = (f["content"] if f and f["detail_at"] and f["content"] else None) or (
            p["content"] if p else (old["content"] if old else None)
        )
        p_state = p["state"] if p else "none"
        if f:
            f_state = f["state"]
        elif not is_fanbox:
            f_state = "na"
        else:
            f_state = "gone" if fanbox_listed else "unknown"

        p_entries = _entries(p["entries"]) if p else []
        f_entries = _entries(f["entries"]) if f and f["detail_at"] else []
        merged = merge(p_entries, f_entries)
        existing = files.get(post_id, {})
        p_keys = {e.key for e in merged if "pawchive" in e.sources}
        f_keys = {e.key for e in merged if "fanbox" in e.sources}

        # Names for files that have none yet; names already given stay put.
        computed = file_names(
            [e.name for e in merged], naming.template, naming.rename_images_only, naming.is_image
        )
        taken = [r["local_name"] for r in existing.values() if r["local_name"]]
        wanted = [
            (i, computed[i])
            for i, e in enumerate(merged)
            if not (existing.get(e.key) and existing[e.key]["local_name"])
        ]
        fresh = dict(
            zip([i for i, _ in wanted], unique_names([n for _, n in wanted], taken), strict=True)
        )

        had = len(existing)
        for i, e in enumerate(merged):
            row = existing.get(e.key)
            values = (
                e.role,
                i,
                e.name,
                e.path or None,
                e.url or None,
                e.size,
                e.width,
                e.height,
                e.sha256 or None,
                int(p_state == "full" and e.key in p_keys and bool(e.path)),
                int(f_state == "open" and e.key in f_keys and bool(e.url)),
            )
            if row is None:
                conn.execute(
                    """INSERT INTO files(creator_id, post_id, key, role, ordinal, name, p_path,
                       f_url, size, width, height, sha256, present_p, present_f, local_name)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (creator_id, post_id, e.key, *values, fresh[i]),
                )
            else:
                conn.execute(
                    """UPDATE files SET role=?, ordinal=?, name=?, p_path=COALESCE(?, p_path),
                       f_url=COALESCE(?, f_url), size=COALESCE(?, size),
                       width=COALESCE(?, width), height=COALESCE(?, height),
                       sha256=COALESCE(?, sha256), present_p=?, present_f=? WHERE id=?""",
                    (*values, row["id"]),
                )
        # A pending file no source lists any more is dropped; a downloaded one is kept,
        # since forgetting bytes we hold would lose them silently.
        merged_keys = {e.key for e in merged}
        dropped = 0
        if merged:
            for key, row in existing.items():
                if key in merged_keys:
                    continue
                if row["state"] == "done":
                    # Sorted after the listed files; shifted once, not again on every sync.
                    conn.execute(
                        "UPDATE files SET present_p=0, present_f=0, ordinal=? WHERE id=?",
                        (row["ordinal"] % ORPHAN_ORDINAL + ORPHAN_ORDINAL, row["id"]),
                    )
                else:
                    conn.execute("DELETE FROM files WHERE id=?", (row["id"],))
                    dropped += 1

        total, done = conn.execute(
            "SELECT COUNT(*), SUM(state='done') FROM files WHERE creator_id=? AND post_id=?",
            (creator_id, post_id),
        ).fetchone()
        done = done or 0
        if old is None:
            local_done = int(total > 0 and done == total)
            counts["new"] += 1
        elif total and done < total:
            grew = len(merged) > had - dropped
            if old["local_done"] and old["origin"] in ("manual", "adopted") and not grew:
                # Marked done by hand, or adopted with files we could not pair: stays done
                # until the post gains files.
                local_done = 1
            else:
                if old["local_done"] and grew:
                    counts["reopened"] += 1
                local_done = 0
        elif total:
            local_done = 1
        else:
            local_done = old["local_done"]
        stale = None
        if local_done and old and old["done_at"] and edited and edited > old["done_at"]:
            stale = f"Updated upstream {edited[:10]}"

        conn.execute(
            """INSERT INTO posts(creator_id, post_id, title, published, edited, fee, content,
               p_state, f_state, local_done, stale, time_mismatch, first_seen)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(creator_id, post_id) DO UPDATE SET
                 title=excluded.title, published=excluded.published, edited=excluded.edited,
                 fee=excluded.fee, content=excluded.content, p_state=excluded.p_state,
                 f_state=excluded.f_state, local_done=excluded.local_done,
                 stale=excluded.stale, time_mismatch=excluded.time_mismatch""",
            (
                creator_id,
                post_id,
                title,
                published,
                edited,
                fee,
                content,
                p_state,
                f_state,
                local_done,
                stale,
                mismatch,
                now,
            ),
        )
    return counts
