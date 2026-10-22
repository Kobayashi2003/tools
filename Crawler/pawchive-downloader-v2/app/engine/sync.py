"""Fetch each source's view of a creator into `post_obs`, then reconcile.

Each source writes only its own observations. A post missing from a complete
listing becomes `gone` (reversibly: it is restored the next time it is listed);
an incomplete listing marks nothing.
"""

import sqlite3
import threading
from collections.abc import Callable
from dataclasses import dataclass, field

import requests

from ..domain.match import Entry
from ..domain.timefmt import now_utc
from ..sources.fanbox import FanboxListItem, SessionRejected
from ..sources.http import PermanentError, TransientError
from .context import Context
from .reconcile import entries_json, reconcile_creator


class Stopped(Exception):
    """The job was cancelled between two steps."""


@dataclass
class SyncResult:
    pawchive: int = 0
    fanbox: int = 0
    details: int = 0
    new: int = 0
    reopened: int = 0
    gone: dict[str, int] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def summary(self) -> str:
        parts = []
        if self.pawchive:
            parts.append(f"Pawchive {self.pawchive}")
        if self.fanbox:
            parts.append(f"Fanbox {self.fanbox}")
        if self.details:
            parts.append(f"{self.details} bodies")
        if self.new:
            parts.append(f"{self.new} new")
        if self.reopened:
            parts.append(f"{self.reopened} gained files")
        for source, n in self.gone.items():
            if n:
                parts.append(f"{n} gone from {source}")
        return " · ".join(parts + self.notes) or "no changes"


Progress = Callable[[str], None]


def _upsert_obs(
    conn: sqlite3.Connection,
    creator_id: str,
    post_id: str,
    source: str,
    state: str,
    now: str,
    *,
    title: str,
    published: str,
    edited: str,
    fee: int | None = None,
    content: str | None = None,
    entries: list[Entry] | None = None,
    detail_at: str | None = None,
    keep_entries_if_empty: bool = True,
):
    old = conn.execute(
        "SELECT entries, content, detail_at FROM post_obs WHERE creator_id=? AND post_id=? AND source=?",
        (creator_id, post_id, source),
    ).fetchone()
    new_entries = entries_json(entries) if entries is not None else None
    if old is not None:
        # One bad response must never erase what a post is known to contain.
        if new_entries is None or (
            keep_entries_if_empty and not entries and old["entries"] and old["entries"] != "[]"
        ):
            new_entries = old["entries"]
        if content is None:
            content = old["content"]
        if detail_at is None:
            detail_at = old["detail_at"]
    conn.execute(
        """INSERT INTO post_obs(creator_id, post_id, source, state, title, published, edited, fee,
           content, entries, detail_at, first_seen, last_seen, gone_since)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
           ON CONFLICT(creator_id, post_id, source) DO UPDATE SET
             state=excluded.state, title=excluded.title,
             published=CASE WHEN excluded.published<>'' THEN excluded.published ELSE post_obs.published END,
             edited=CASE WHEN excluded.edited<>'' THEN excluded.edited ELSE post_obs.edited END,
             fee=COALESCE(excluded.fee, post_obs.fee), content=excluded.content,
             entries=excluded.entries, detail_at=excluded.detail_at,
             last_seen=excluded.last_seen, gone_since=NULL""",
        (
            creator_id,
            post_id,
            source,
            state,
            title,
            published,
            edited,
            fee,
            content,
            new_entries,
            detail_at,
            now,
            now,
        ),
    )


def _mark_gone(
    conn: sqlite3.Connection, creator_id: str, source: str, seen: set[str], now: str
) -> int:
    rows = conn.execute(
        "SELECT post_id FROM post_obs WHERE creator_id=? AND source=? AND state<>'gone'",
        (creator_id, source),
    ).fetchall()
    missing = [r["post_id"] for r in rows if r["post_id"] not in seen]
    conn.executemany(
        "UPDATE post_obs SET state='gone', gone_since=? WHERE creator_id=? AND post_id=? AND source=?",
        [(now, creator_id, pid, source) for pid in missing],
    )
    return len(missing)


def _full_list[T](
    ctx: Context,
    creator: sqlite3.Row,
    source: str,
    read: Callable[[], list[T]],
    key: Callable[[T], str],
    label: str,
) -> tuple[list[T], bool]:
    """A source's whole post list, and whether it is complete enough to mark the posts
    missing from it as gone.

    Neither source gives a post count, so a list shorter than what is known is the only
    sign of a truncated read. It is read once more: if both reads agree, the posts really
    were deleted; otherwise the longer read is kept and nothing is marked gone."""
    items = read()
    row = ctx.db.one(
        "SELECT COUNT(*) AS n FROM post_obs WHERE creator_id=? AND source=? AND state<>'gone'",
        (creator["id"], source),
    )
    known = row["n"] if row else 0
    if len(items) >= known:
        return items, True
    ctx.events.log(
        "warning",
        f"{label} listed {len(items)} posts, fewer than the {known} known; reading again",
        creator["id"],
    )
    again = read()
    if {key(i) for i in again} == {key(i) for i in items}:
        return again, True
    return max(items, again, key=len), len(again) >= known


# ---------------------------------------------------------------- Pawchive


def sync_pawchive(ctx: Context, creator: sqlite3.Row, result: SyncResult, progress: Progress):
    progress("Pawchive: reading the post list")
    try:
        ctx.pawchive.profile(creator["service"], creator["user_id"])
    except PermanentError as e:
        # Gone upstream: what we have stays downloadable, and a later run picks it up again.
        ctx.db.run(
            "UPDATE creators SET pawchive_state='gone', pawchive_error=?, pawchive_checked_at=? WHERE id=?",
            (str(e), now_utc(), creator["id"]),
        )
        result.notes.append("creator not found on Pawchive")
        return
    anomalies = 0

    def read() -> list[dict]:
        nonlocal anomalies
        posts, seen = ctx.pawchive.all_posts(creator["service"], creator["user_id"])
        anomalies += seen
        return posts

    raw, complete = _full_list(
        ctx, creator, "pawchive", read, lambda p: str(p.get("id")), "Pawchive"
    )
    now = now_utc()
    parsed = [ctx.pawchive.parse(item) for item in raw]
    with ctx.db.tx() as conn:
        for post in parsed:
            _upsert_obs(
                conn,
                creator["id"],
                post.id,
                "pawchive",
                "full" if post.has_full else "meta",
                now,
                title=post.title,
                published=post.published,
                edited=post.edited,
                content=post.content or None,
                entries=post.entries,
            )
        if complete:
            result.gone["Pawchive"] = _mark_gone(
                conn, creator["id"], "pawchive", {p.id for p in parsed}, now
            )
        conn.execute(
            "UPDATE creators SET pawchive_state='ok', pawchive_error=NULL, pawchive_checked_at=? WHERE id=?",
            (now, creator["id"]),
        )
    result.pawchive = len(parsed)
    if anomalies:
        result.notes.append(f"{anomalies} paging anomalies")


# ---------------------------------------------------------------- Fanbox


def resolve_creator_id(ctx: Context, creator: sqlite3.Row) -> str | None:
    if creator["fanbox_creator_id"]:
        return creator["fanbox_creator_id"]
    handle = ctx.fanbox.creator_id_of(creator["user_id"])
    ctx.db.run(
        "UPDATE creators SET fanbox_creator_id=?, fanbox_state=?, fanbox_checked_at=? WHERE id=?",
        (handle, "ok" if handle else "none", now_utc(), creator["id"]),
    )
    return handle


def refresh_subscriptions(ctx: Context) -> int:
    """Store the plans you support. Without a cookie there is nothing to read."""
    if not ctx.store.fanbox_sessid():
        return 0
    try:
        plans = ctx.fanbox.supporting()
    except SessionRejected as e:
        ctx.set_session_state(state="rejected", message=str(e))
        raise
    now = now_utc()
    with ctx.db.tx() as conn:
        conn.execute("DELETE FROM subscriptions")
        for plan in plans:
            user_id = str((plan.get("user") or {}).get("userId") or "")
            if not user_id:
                continue
            conn.execute(
                "INSERT OR REPLACE INTO subscriptions(creator_id, plan_id, fee, title, checked_at) VALUES(?,?,?,?,?)",
                (
                    f"fanbox_{user_id}",
                    str(plan.get("id")),
                    int(plan.get("fee") or 0),
                    str(plan.get("title") or ""),
                    now,
                ),
            )
    ctx.set_session_state(state="valid", supporting=len(plans), message="")
    return len(plans)


def plan_fee(ctx: Context, creator_id: str) -> int | None:
    if not ctx.store.fanbox_sessid() or ctx.session().get("state") != "valid":
        return None
    row = ctx.db.one("SELECT MAX(fee) AS fee FROM subscriptions WHERE creator_id=?", (creator_id,))
    return int(row["fee"]) if row and row["fee"] is not None else 0


def sync_fanbox(
    ctx: Context,
    creator: sqlite3.Row,
    result: SyncResult,
    progress: Progress,
    cancel: threading.Event,
    deep: bool = False,
    details: bool = True,
):
    if not ctx.fanbox_usable():
        result.notes.append("Fanbox skipped: cookie rejected")
        return
    progress("Fanbox: resolving creatorId")
    handle = resolve_creator_id(ctx, creator)
    if not handle:
        # No Fanbox page is a complete answer: the creator has no posts there.
        now = now_utc()
        with ctx.db.tx() as conn:
            result.gone["Fanbox"] = _mark_gone(conn, creator["id"], "fanbox", set(), now)
            conn.execute("UPDATE creators SET fanbox_listed_at=? WHERE id=?", (now, creator["id"]))
        result.notes.append("no Fanbox page")
        return
    progress(f"Fanbox: reading @{handle}'s post list")

    def read() -> list[FanboxListItem]:
        items = []
        for item in ctx.fanbox.list_posts(handle):
            if cancel.is_set():
                raise Stopped()
            if item.user_id and item.user_id != creator["user_id"]:
                # A renamed handle now owned by someone else: re-resolve next time.
                ctx.db.run(
                    "UPDATE creators SET fanbox_creator_id=NULL WHERE id=?", (creator["id"],)
                )
                raise RuntimeError(
                    f"@{handle} now belongs to userId {item.user_id}, not {creator['user_id']}; "
                    "the cached creatorId was cleared and is resolved again next sync"
                )
            items.append(item)
        return items

    try:
        items, complete = _full_list(ctx, creator, "fanbox", read, lambda i: i.id, "Fanbox")
    except PermanentError:
        ctx.db.run(
            "UPDATE creators SET fanbox_creator_id=NULL, fanbox_checked_at=? WHERE id=?",
            (now_utc(), creator["id"]),
        )
        result.notes.append(f"@{handle} is gone; resolved again next sync")
        return

    fee_cap = plan_fee(ctx, creator["id"])
    if fee_cap is not None:
        suspicious = [i for i in items if i.restricted and 0 < i.fee <= fee_cap]
        if suspicious:
            message = (
                f"Your ¥{fee_cap} plan covers post {suspicious[0].id} (¥{suspicious[0].fee}), "
                "yet Fanbox says it is restricted: the cookie has probably expired"
            )
            ctx.set_session_state(state="rejected", message=message)
            raise SessionRejected(message)

    now = now_utc()
    previous = {
        r["post_id"]: r
        for r in ctx.db.all(
            "SELECT post_id, edited, detail_at, state FROM post_obs WHERE creator_id=? AND source='fanbox'",
            (creator["id"],),
        )
    }
    with ctx.db.tx() as conn:
        for item in items:
            _upsert_obs(
                conn,
                creator["id"],
                item.id,
                "fanbox",
                "locked" if item.restricted else "open",
                now,
                title=item.title,
                published=item.published,
                edited=item.updated,
                fee=item.fee,
            )
        conn.executemany(
            "UPDATE post_obs SET cover_url=? WHERE creator_id=? AND post_id=? AND source='fanbox'",
            [(i.cover_url, creator["id"], i.id) for i in items if i.cover_url],
        )
        conn.execute(
            "UPDATE creators SET fanbox_state='ok', fanbox_error=NULL, fanbox_checked_at=? WHERE id=?",
            (now, creator["id"]),
        )
        if complete:
            result.gone["Fanbox"] = _mark_gone(
                conn, creator["id"], "fanbox", {i.id for i in items}, now
            )
            conn.execute("UPDATE creators SET fanbox_listed_at=? WHERE id=?", (now, creator["id"]))
        # Shown before the bodies are read: newly opened posts can take hours to read.
        if details:
            reconcile_creator(conn, creator["id"], True, ctx.naming(creator), now)
    result.fanbox = len(items)

    # Bodies are one request each, so only read the ones whose files we do not know yet
    # or that changed since we read them.
    wanted = []
    for item in items if details else []:
        if item.restricted:
            continue
        old = previous.get(item.id)
        if deep or old is None or not old["detail_at"] or (old["edited"] or "") != item.updated:
            wanted.append(item)
    failures = 0
    for n, item in enumerate(wanted, 1):
        if cancel.is_set():
            raise Stopped()
        progress(f"Fanbox: reading post bodies {n}/{len(wanted)}")
        try:
            detail = ctx.fanbox.post(item.id)
            failures = 0
        except PermanentError:
            ctx.db.run(
                "UPDATE post_obs SET state='gone', gone_since=? WHERE creator_id=? AND post_id=? AND source='fanbox'",
                (now_utc(), creator["id"], item.id),
            )
            continue
        except (requests.RequestException, TransientError) as e:
            # One unreadable body costs that post's files until the next sync, not the
            # whole sync; a run of them means Fanbox wants a pause.
            failures += 1
            ctx.events.log(
                "warning", f"Fanbox post {item.id}: could not read the body: {e}", creator["id"]
            )
            if failures >= 5:
                result.notes.append(
                    f"Fanbox refused {failures} bodies in a row; {len(wanted) - n} left for the next sync"
                )
                break
            continue
        with ctx.db.tx() as conn:
            _upsert_obs(
                conn,
                creator["id"],
                item.id,
                "fanbox",
                "locked" if detail.restricted else "open",
                now_utc(),
                title=detail.title,
                published=detail.published,
                edited=detail.updated,
                fee=detail.fee,
                content=detail.text,
                entries=detail.entries,
                detail_at=None if detail.restricted else now_utc(),
                keep_entries_if_empty=detail.restricted,
            )
            # Reconciled as it goes, so a long first read shows progress in the UI.
            if n % 20 == 0:
                reconcile_creator(conn, creator["id"], True, ctx.naming(creator), now_utc())
        result.details += 1


# ---------------------------------------------------------------- entry point


def sync_creator(
    ctx: Context,
    creator_id: str,
    progress: Progress,
    cancel: threading.Event,
    deep: bool = False,
    sources: tuple[str, ...] = ("pawchive", "fanbox"),
    details: bool = True,
) -> SyncResult:
    """`details=False` reads Fanbox's list only: the cheap status check run for every
    saved creator in the background (see JobRunner._probe)."""
    creator = ctx.require_creator(creator_id)
    result = SyncResult()
    is_fanbox = creator["service"] == "fanbox"
    if "pawchive" in sources and creator["pawchive_state"] != "none":
        sync_pawchive(ctx, creator, result, progress)
    if cancel.is_set():
        raise Stopped()
    if "fanbox" in sources and is_fanbox:
        sync_fanbox(ctx, creator, result, progress, cancel, deep, details)
    progress("Reconciling posts and files")
    with ctx.db.tx() as conn:
        counts = reconcile_creator(conn, creator_id, is_fanbox, ctx.naming(creator), now_utc())
        if details or "pawchive" in sources:
            conn.execute("UPDATE creators SET synced_at=? WHERE id=?", (now_utc(), creator_id))
    result.new, result.reopened = counts["new"], counts["reopened"]
    return result
