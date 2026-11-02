"""The links table: filled from post text on every sync, checked and fetched by the hosts
that plug in, marked by hand or by a fetch."""

import sqlite3
import threading
from collections.abc import Callable

import requests

from ..domain.links import (
    STATES,
    LinkChecker,
    LinkError,
    LinkFetcher,
    LinkKeyed,
    find_links,
    link_folder,
    pick,
)
from ..domain.timefmt import now_utc
from ..sources.http import Cancelled
from ..sources.linkhosts.dropbox import Dropbox
from ..sources.linkhosts.gdrive import GoogleDrive
from ..sources.linkhosts.gigafile import GigaFile
from ..sources.linkhosts.mega import Mega
from .context import Context

# The hosts that plug in. A host may check, fetch, or both, and may need a key; a new one
# goes in the lists for what it does.
_DRIVE, _MEGA, _DROPBOX = GoogleDrive(), Mega(), Dropbox()
CHECKERS: list[LinkChecker] = [_DRIVE, _MEGA, _DROPBOX, GigaFile()]
FETCHERS: list[LinkFetcher] = [_DRIVE, _MEGA, _DROPBOX]
KEYED: list[LinkKeyed] = [_MEGA]


def _post_text(ctx: Context, creator_id: str, post_id: str) -> str:
    """Every text the sources gave for a post, raw: Pawchive's HTML may show the full link
    in the text while linking the bare address."""
    rows = ctx.db.all(
        "SELECT content FROM post_obs WHERE creator_id=? AND post_id=? AND content IS NOT NULL "
        "UNION ALL SELECT content FROM posts WHERE creator_id=? AND post_id=? AND content IS NOT NULL",
        (creator_id, post_id, creator_id, post_id),
    )
    return "\n".join(r["content"] for r in rows)


def usable_url(row: sqlite3.Row) -> str:
    """The link with the key it was given, when it was posted without one."""
    keyed = pick(KEYED, row["url"])
    if keyed and row["key"] and keyed.needs_key(row["url"]):
        return keyed.with_key(row["url"], row["key"])
    return row["url"]


def _find_key(ctx: Context, row: sqlite3.Row, progress: Callable[[str], None]) -> str:
    """The usable link; for one without a key, the first key from the post's text that
    opens it is tried and kept."""
    url = usable_url(row)
    keyed = pick(KEYED, url)
    if keyed is None or not keyed.needs_key(url):
        return url
    for key in keyed.key_candidates(url, _post_text(ctx, row["creator_id"], row["post_id"])):
        progress(f"Trying a key from the post's text for {url[:50]}")
        candidate = keyed.with_key(url, key)
        if keyed.key_works(candidate):
            ctx.db.run("UPDATE links SET key=?, key_source='text' WHERE id=?", (key, row["id"]))
            return candidate
    return url


def set_key(ctx: Context, link_id: int, key: str) -> sqlite3.Row:
    """Keep the key typed for a link; what was checked or failed without it starts over."""
    key = key.strip().lstrip("#!")
    row = ctx.db.one("SELECT * FROM links WHERE id=?", (link_id,))
    if row is None:
        raise KeyError(f"no link {link_id}")
    keyed = pick(KEYED, row["url"])
    if keyed is None or not keyed.needs_key(row["url"]):
        raise ValueError("this link does not take a key")
    if not key:
        raise ValueError("empty key")
    ctx.db.run(
        "UPDATE links SET key=?, key_source='manual', check_state=NULL, check_note=NULL, "
        "fetch_error=NULL WHERE id=?",
        (key, link_id),
    )
    return row


def refresh_links(conn: sqlite3.Connection, creator_id: str, domains: list[str], now: str) -> int:
    """Record the links in each post's text, from either source. Returns how many are new.
    A link already recorded keeps its state; one the text no longer has stays listed."""
    added = 0
    for row in conn.execute(
        "SELECT post_id, content FROM post_obs WHERE creator_id=? AND content IS NOT NULL",
        (creator_id,),
    ).fetchall():
        for link in find_links(row["content"], domains):
            added += conn.execute(
                "INSERT OR IGNORE INTO links(creator_id, post_id, url, host, first_seen) "
                "VALUES(?,?,?,?,?)",
                (creator_id, row["post_id"], link.url, link.host, now),
            ).rowcount
    return added


def adopt_v1_review(ctx: Context, links_filter: dict) -> int:
    """v1 marked a creator's links reviewed as a whole, with a date after which new posts
    showed again. Those links count as done here. Returns how many were marked."""
    reviewed = list(links_filter.get("reviewed_artists") or [])
    cutoff = str(links_filter.get("reviewed_before") or "")
    if not reviewed:
        return 0
    marks = ",".join("?" * len(reviewed))
    # v1 compared the post's edit date (or its publish date) with the cutoff, as text.
    return ctx.db.run(
        f"""UPDATE links SET state='done', decided_at=? WHERE state='new'
            AND creator_id IN ({marks}) AND (? = '' OR EXISTS (
              SELECT 1 FROM posts p WHERE p.creator_id=links.creator_id
                AND p.post_id=links.post_id
                AND COALESCE(NULLIF(p.edited,''), p.published) <= ?))""",
        (now_utc(), *reviewed, cutoff, cutoff),
    )


def list_links(ctx: Context, state: str | None = None, creator_id: str | None = None) -> list[dict]:
    where, args = ["1=1"], []
    if state:
        where.append("l.state=?")
        args.append(state)
    if creator_id:
        where.append("l.creator_id=?")
        args.append(creator_id)
    rows = ctx.db.all(
        f"""SELECT l.*, p.title, p.published, p.local_dir,
                   COALESCE(NULLIF(c.alias,''), c.name) AS creator_name
            FROM links l
            JOIN posts p ON p.creator_id=l.creator_id AND p.post_id=l.post_id
            JOIN creators c ON c.id=l.creator_id
            WHERE {" AND ".join(where)} ORDER BY creator_name, p.published DESC, l.id""",
        tuple(args),
    )
    domains = [d.lower() for d in ctx.settings.link_domains]
    out = []
    for r in rows:
        # A domain taken off the list hides its links without forgetting their state.
        if not any(d in r["host"] or d in r["url"].lower() for d in domains):
            continue
        checker, fetcher = pick(CHECKERS, r["url"]), pick(FETCHERS, r["url"])
        keyed = pick(KEYED, r["url"])
        needs_key = bool(keyed and keyed.needs_key(r["url"]) and not r["key"])
        out.append(
            {
                **dict(r),
                "checker": checker.name if checker else None,
                "fetcher": fetcher.name if fetcher else None,
                # Whether the link waits for a key, and what the post's text offers for one
                # (untested: a check tries them against the host).
                "needs_key": needs_key,
                "key_hints": (
                    keyed.key_candidates(r["url"], _post_text(ctx, r["creator_id"], r["post_id"]))
                    if keyed and needs_key
                    else []
                ),
            }
        )
    return out


def set_state(ctx: Context, ids: list[int], state: str) -> int:
    if state not in STATES:
        raise ValueError(f"unknown link state {state!r}")
    marks = ",".join("?" * len(ids))
    return ctx.db.run(
        f"UPDATE links SET state=?, decided_at=? WHERE id IN ({marks})",
        (state, None if state == "new" else now_utc(), *ids),
    )


def settle(ctx: Context, row: sqlite3.Row, check_state: str) -> None:
    """What a check means for the link's state: a dead link is failed, whether new or
    marked done by hand (one whose files were fetched stays done, a skipped one skipped),
    and a failed link found alive again is new."""
    if check_state == "dead" and row["state"] in ("new", "done") and not row["fetched_at"]:
        state = "failed"
    elif check_state == "alive" and row["state"] == "failed":
        state = "new"
    else:
        return
    ctx.db.run(
        "UPDATE links SET state=?, decided_at=? WHERE id=?",
        (state, None if state == "new" else now_utc(), row["id"]),
    )


def by_creator(ctx: Context, ids: list[int]) -> dict[str, list[int]]:
    """Link ids grouped by creator: a job runs for one creator at a time."""
    marks = ",".join("?" * len(ids))
    out: dict[str, list[int]] = {}
    for r in ctx.db.all(f"SELECT id, creator_id FROM links WHERE id IN ({marks})", tuple(ids)):
        out.setdefault(r["creator_id"], []).append(r["id"])
    return out


# ---------------------------------------------------------------- jobs


def _rows(ctx: Context, creator_id: str, ids: list[int]) -> list[sqlite3.Row]:
    marks = ",".join("?" * len(ids))
    return ctx.db.all(
        f"SELECT * FROM links WHERE creator_id=? AND id IN ({marks}) ORDER BY id",
        (creator_id, *ids),
    )


def check_links(
    ctx: Context,
    creator_id: str,
    ids: list[int],
    progress: Callable[[str], None],
    cancel: threading.Event,
) -> str:
    tally = {"alive": 0, "dead": 0, "unknown": 0, "no checker": 0}
    rows = _rows(ctx, creator_id, ids)
    for n, row in enumerate(rows, 1):
        if cancel.is_set():
            raise Cancelled()
        checker = pick(CHECKERS, row["url"])
        if checker is None:
            tally["no checker"] += 1
            continue
        progress(f"Checking {n}/{len(rows)}: {row['url'][:60]}")
        result = checker.check(_find_key(ctx, row, progress))
        tally[result.state] += 1
        ctx.db.run(
            "UPDATE links SET check_state=?, check_note=?, checked_at=? WHERE id=?",
            (result.state, result.note, now_utc(), row["id"]),
        )
        settle(ctx, row, result.state)
    return " · ".join(f"{v} {k}" for k, v in tally.items() if v)


def fetch_links(
    ctx: Context,
    creator_id: str,
    ids: list[int],
    progress: Callable[[str], None],
    cancel: threading.Event,
) -> str:
    """Save each link's files into its post's download folder (on the download drive, as
    every download is) under `links/`; a fetched link is done, a failed one keeps its error."""
    # Imported here: download imports sync, which imports this module.
    from .download import save_dir

    creator = ctx.require_creator(creator_id)
    tally = {"fetched": 0, "files": 0, "failed": 0, "no fetcher": 0}
    rows = _rows(ctx, creator_id, ids)
    for n, row in enumerate(rows, 1):
        if cancel.is_set():
            raise Cancelled()
        fetcher = pick(FETCHERS, row["url"])
        if fetcher is None:
            tally["no fetcher"] += 1
            continue
        post = ctx.db.one(
            "SELECT * FROM posts WHERE creator_id=? AND post_id=?", (creator_id, row["post_id"])
        )
        if post is None:
            continue
        folder = link_folder(save_dir(ctx, creator, post))
        progress(f"Link {n}/{len(rows)}: {row['url'][:60]}")
        try:
            saved = fetcher.fetch(
                _find_key(ctx, row, progress),
                folder,
                lambda m, n=n: progress(f"Link {n}/{len(rows)}: {m}"),
                cancel.is_set,
            )
        except (LinkError, requests.RequestException, OSError) as e:
            tally["failed"] += 1
            ctx.db.run("UPDATE links SET fetch_error=? WHERE id=?", (str(e), row["id"]))
            ctx.events.log("warning", f"Link {row['url']}: {e}", creator_id)
            continue
        tally["fetched"] += 1
        tally["files"] += len(saved)
        ctx.db.run(
            "UPDATE links SET state='done', decided_at=?, fetched_at=?, fetch_error=NULL, "
            "check_state='alive' WHERE id=?",
            (now_utc(), now_utc(), row["id"]),
        )
    return " · ".join(f"{v} {k}" for k, v in tally.items() if v)
