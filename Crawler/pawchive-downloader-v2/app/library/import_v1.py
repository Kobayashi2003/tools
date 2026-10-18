"""Bring a v1 installation's state into v2: creators (with their `data/artists/` group
tree), cached posts as Pawchive observations, done/failed state, the 404 ledger, the
traffic quota and the shareable settings. v1's files are not touched or re-checked;
v1's own names are recomputed with the same rules, so they land on the same paths.
"""

import shutil
from dataclasses import fields
from datetime import datetime
from pathlib import Path

from ..config import Settings
from ..domain.match import pawchive_entries
from ..domain.naming import creator_folder, post_folder
from ..domain.timefmt import now_utc, to_utc
from ..engine.context import Context
from ..engine.reconcile import entries_json, reconcile_creator
from ..jsonio import read_json
from ..store.db import dump

# v1 settings that mean the same thing in v2.
_SAME = {f.name for f in fields(Settings)}
_RENAMED = {"max_concurrent_artists": "max_concurrent_creators"}
_DROPPED = {
    "data_dir",
    "cache_dir",
    "logs_dir",
    "links_filter",
    "trust_updated_timestamp",
    "notify",
    "max_concurrent_posts",
}


def _local(value: str | None) -> str:
    """v1's ledger wrote `datetime.now()`: local wall time, not UTC."""
    if not value:
        return ""
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return ""
    return to_utc(moment.astimezone().isoformat())


def _v1_artists(root: Path) -> list[tuple[str, dict]]:
    """`(group, artist)` pairs; `artists.json` wins on duplicate ids, as in v1."""
    out: dict[str, tuple[str, dict]] = {}
    for item in read_json(root / "data" / "artists.json", []) or []:
        if isinstance(item, dict) and item.get("id"):
            out[item["id"]] = ("", item)
    tree = root / "data" / "artists"
    if tree.is_dir():
        for path in sorted(tree.rglob("*.json")):
            group = path.relative_to(tree).with_suffix("").as_posix()
            content = read_json(path, [])
            for item in content if isinstance(content, list) else [content]:
                if isinstance(item, dict) and item.get("id") and item["id"] not in out:
                    out[item["id"]] = (group, item)
    return list(out.values())


def import_settings(ctx: Context, root: Path) -> list[str]:
    v1 = read_json(root / "data" / "config.json", {}) or {}
    changes = {}
    for key, value in v1.items():
        if key in _DROPPED:
            continue
        target = _RENAMED.get(key, key)
        if target in _SAME:
            changes[target] = value
    ctx.store.save(changes)
    # Machine-specific limits live in .env, as in v1; carry them over if v2 has none.
    env_src, env_dst = root / ".env", Path(__file__).resolve().parents[2] / ".env"
    notes = [f"{len(changes)} settings"]
    if env_src.exists() and not env_dst.exists():
        shutil.copyfile(env_src, env_dst)
        notes.append(".env copied (takes effect on restart)")
    quota = root / "data" / "quota.json"
    if quota.exists() and not (ctx.data_dir / "quota.json").exists():
        shutil.copyfile(quota, ctx.data_dir / "quota.json")
    ctx.reload_settings()
    return notes


def import_v1(ctx: Context, root: Path, progress=lambda _m: None) -> dict:
    root = root.resolve()
    if not (root / "data" / "artists.json").exists():
        raise FileNotFoundError(f"{root} is not a v1 folder (no data/artists.json)")
    notes = import_settings(ctx, root)
    settings = ctx.settings
    now = now_utc()
    stats = {"creators": 0, "posts": 0, "done_posts": 0, "files": 0, "deferrals": 0}

    artists = _v1_artists(root)
    for n, (group, a) in enumerate(artists, 1):
        cid = str(a["id"])
        progress(f"Importing {n}/{len(artists)}: {a.get('alias') or a.get('name')}")
        with ctx.db.tx() as conn:
            conn.execute(
                """INSERT INTO creators(id, service, user_id, name, alias, group_path, ignore,
                   completed, config, filter, timer, last_date, added_at, pawchive_state)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'ok')
                   ON CONFLICT(id) DO UPDATE SET name=excluded.name, alias=excluded.alias,
                     group_path=excluded.group_path, ignore=excluded.ignore,
                     completed=excluded.completed, config=excluded.config,
                     filter=excluded.filter, timer=excluded.timer, last_date=excluded.last_date""",
                (
                    cid,
                    a.get("service") or "fanbox",
                    str(a.get("user_id") or ""),
                    a.get("name") or "",
                    a.get("alias") or "",
                    group,
                    int(bool(a.get("ignore"))),
                    int(bool(a.get("completed"))),
                    dump(a.get("config") or {}),
                    dump(a.get("filter") or {}),
                    dump(a["timer"]) if a.get("timer") else None,
                    to_utc(a.get("last_date")) or None,
                    now,
                ),
            )
        stats["creators"] += 1
        cache = read_json(root / "cache" / f"{cid}_posts.json", []) or []
        if not cache:
            continue
        creator = ctx.creator(cid)
        assert creator is not None
        config = a.get("config") or {}
        base = Path(settings.download_dir) / creator_folder(
            config.get("artist_folder_template", settings.artist_folder_template),
            service=creator["service"],
            name=creator["name"],
            alias=creator["alias"],
            user_id=creator["user_id"],
            group=group,
        )
        template = config.get("post_folder_template", settings.post_folder_template)
        fmt = config.get("date_format", settings.date_format)
        with ctx.db.tx() as conn:
            for p in cache:
                pid = str(p.get("id"))
                entries = pawchive_entries(p.get("file"), p.get("attachments"))
                lost = bool(p.get("lost")) and not p.get("done")
                conn.execute(
                    """INSERT OR REPLACE INTO post_obs(creator_id, post_id, source, state, title,
                       published, edited, content, entries, first_seen, last_seen)
                       VALUES(?,?,'pawchive',?,?,?,?,?,?,?,?)""",
                    (
                        cid,
                        pid,
                        "meta" if lost else "full",
                        p.get("title") or "",
                        to_utc(p.get("published")),
                        to_utc(p.get("edited")),
                        p.get("content") or None,
                        entries_json(entries),
                        to_utc(p.get("added")) or now,
                        now,
                    ),
                )
            reconcile_creator(conn, cid, creator["service"] == "fanbox", ctx.naming(creator), now)
            for p in cache:
                pid = str(p.get("id"))
                failed = set(p.get("failed_files") or [])
                folder = base / post_folder(
                    template,
                    post_id=pid,
                    user=creator["user_id"],
                    service=creator["service"],
                    title=p.get("title") or "",
                    published=to_utc(p.get("published")),
                    fmt=fmt,
                )
                if p.get("done") and not failed:
                    conn.execute(
                        "UPDATE files SET state='done', via='v1', done_at=? WHERE creator_id=? AND post_id=?",
                        (now, cid, pid),
                    )
                    conn.execute(
                        "UPDATE posts SET local_done=1, done_at=?, local_dir=? WHERE creator_id=? AND post_id=?",
                        (now, str(folder), cid, pid),
                    )
                    stats["done_posts"] += 1
                elif failed:
                    marks = ",".join("?" * len(failed))
                    conn.execute(
                        f"UPDATE files SET state='failed', error='failed in v1' WHERE creator_id=? "
                        f"AND post_id=? AND local_name IN ({marks})",
                        (cid, pid, *failed),
                    )
                    # Files v1 got before the failure are on disk; its post is undone only
                    # because of the failed ones.
                    conn.execute(
                        f"UPDATE files SET state='done', via='v1', done_at=? WHERE creator_id=? "
                        f"AND post_id=? AND state='pending' AND local_name NOT IN ({marks})",
                        (now, cid, pid, *failed),
                    )
            stats["posts"] += len(cache)
            stats["files"] += conn.execute(
                "SELECT COUNT(*) FROM files WHERE creator_id=?", (cid,)
            ).fetchone()[0]

    ledger = read_json(root / "data" / "not_found.json", {}) or {}
    with ctx.db.tx() as conn:
        for key, entry in ledger.items():
            if not isinstance(entry, dict):
                continue
            conn.execute(
                """INSERT OR REPLACE INTO deferrals(source, key, name, misses, first_seen,
                   last_seen, next) VALUES('pawchive',?,?,?,?,?,?)""",
                (
                    key,
                    entry.get("name") or "",
                    int(entry.get("misses") or 1),
                    _local(entry.get("first_seen")) or now,
                    _local(entry.get("last_seen")) or now,
                    _local(entry.get("next")) or now,
                ),
            )
            stats["deferrals"] += 1
    ctx.events.log(
        "info",
        f"Imported v1: {stats['creators']} creators, {stats['posts']} posts, "
        f"{stats['files']} files, {stats['deferrals']} deferrals; " + ", ".join(notes),
    )
    return {**stats, "notes": notes}
