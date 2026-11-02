"""Read models for the UI: creator summaries, post rows with their six facts, post detail."""

import sqlite3
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path

from ..domain.filters import FilterTarget, combined, reason
from ..domain.status import (
    PostFacts,
    coverage,
    has_site,
    headline,
    planned_source,
    shown_via,
    site_currency,
    site_label,
    subscription,
)
from ..domain.timefmt import now_utc
from ..store.db import load
from .context import Context
from .download import filter_reason, post_dir
from .sync import plan_fee

# Counts are over the main files only: the cover and the text are tracked beside them
# (`cover`, `text_at`) and never decide whether a post is done or where it came from.
POST_ROWS = """
SELECT p.*,
       COUNT(f.id) AS files,
       IFNULL(SUM(f.role<>'cover'), 0) AS total,
       IFNULL(SUM(f.role<>'cover' AND f.state='done'), 0) AS done,
       IFNULL(SUM(f.role<>'cover' AND f.state='failed'), 0) AS failed,
       IFNULL(SUM(f.role<>'cover' AND f.state<>'done' AND d.key IS NOT NULL), 0) AS missing,
       IFNULL(SUM(f.role<>'cover' AND f.state='done' AND f.verified IS NULL
                  AND f.via='adopted'), 0) AS unverified,
       IFNULL(SUM(f.role<>'cover' AND f.state='done' AND f.verified=0), 0) AS mismatched,
       GROUP_CONCAT(DISTINCT CASE WHEN f.role<>'cover' AND f.state='done' THEN f.via END)
         AS vias,
       MAX(CASE WHEN f.role='cover' THEN f.state END) AS cover,
       (SELECT COUNT(*) FROM links l WHERE l.creator_id=p.creator_id AND l.post_id=p.post_id)
         AS links,
       (SELECT COUNT(*) FROM links l WHERE l.creator_id=p.creator_id AND l.post_id=p.post_id
          AND l.state='new') AS links_new
FROM posts p
LEFT JOIN files f ON f.creator_id=p.creator_id AND f.post_id=p.post_id
LEFT JOIN deferrals d ON d.source='pawchive' AND d.key=f.p_path AND f.present_p=1
WHERE p.creator_id=:cid {extra}
GROUP BY p.creator_id, p.post_id
"""


def _facts(
    row: sqlite3.Row, creator: sqlite3.Row, fee_cap: int | None, cfg: dict, origin: dict
) -> PostFacts:
    via = [v for v in (row["vias"] or "").split(",") if v]
    if row["origin"] == "adopted" and "adopted" not in via:
        via.append("adopted")
    return PostFacts(
        p=row["p_state"],
        f=row["f_state"],
        fee=row["fee"],
        plan_fee=fee_cap,
        ignored=bool(creator["ignore"]),
        filtered=reason(
            FilterTarget(row["title"], row["published"], row["files"], row["total"]),
            cfg,
            origin,
        ),
        local_done=bool(row["local_done"]),
        total=row["total"],
        done=row["done"],
        failed=row["failed"],
        missing=row["missing"],
        stale=row["stale"] or "",
        via=via,
        unverified=row["unverified"]
        + (1 if row["origin"] == "adopted" and not row["total"] else 0),
    )


def post_rows(ctx: Context, creator_id: str, post_id: str | None = None) -> list[dict]:
    creator = ctx.require_creator(creator_id)
    fee_cap = plan_fee(ctx, creator_id)
    cfg, origin = combined(ctx.settings.global_filter, load(creator["filter"], {}) or {})
    pref = ctx.preference(creator)
    params = {"cid": creator_id, "now": now_utc()}
    extra = ""
    if post_id:
        extra, params["pid"] = "AND p.post_id=:pid", post_id
    out = []
    for r in ctx.db.all(POST_ROWS.format(extra=extra), params):
        facts = _facts(r, creator, fee_cap, cfg, origin)
        head = headline(facts, pref, creator["service"])
        out.append(
            {
                "id": r["post_id"],
                "title": r["title"],
                "published": r["published"],
                "edited": r["edited"],
                "fee": r["fee"],
                "p": r["p_state"],
                "f": r["f_state"],
                "cov": coverage(r["p_state"], r["f_state"]),
                "sub": subscription(r["fee"], fee_cap, r["f_state"]),
                "total": r["total"],
                "done": r["done"],
                "failed": r["failed"],
                "via": list(dict.fromkeys(shown_via(v) for v in facts.via)),
                "filtered": facts.filtered,
                "head": head,
                "planned": planned_source(facts, pref),
                "mismatch": bool(r["time_mismatch"]),
                "verified_bad": r["mismatched"],
                "origin": r["origin"],
                # None when the post has no cover; else its file state.
                "cover": r["cover"],
                "text": bool(r["text_at"]) if r["content"] else None,
                "links": r["links"],
                "links_new": r["links_new"],
            }
        )
    out.sort(key=lambda x: x["published"], reverse=True)
    return out


CREATOR_ROWS = """
SELECT c.*, COUNT(p.post_id) AS total, IFNULL(SUM(p.local_done), 0) AS done,
       IFNULL(SUM(p.p_state='full'), 0) AS p_full,
       IFNULL(SUM(p.p_state='meta'), 0) AS p_meta,
       IFNULL(SUM(p.f_state='open'), 0) AS f_open,
       IFNULL(SUM(p.f_state='locked'), 0) AS f_locked,
       IFNULL(SUM(p.local_done=0 AND (p.p_state='full' OR p.f_state='open')), 0) AS fetchable,
       -- Posts a source could deliver whose files failed.
       (SELECT COUNT(DISTINCT f.post_id) FROM files f
          JOIN posts q ON q.creator_id=f.creator_id AND q.post_id=f.post_id
          WHERE f.creator_id=c.id AND f.role<>'cover' AND f.state='failed' AND q.local_done=0
            AND (q.p_state='full' OR q.f_state='open'))
         AS failed,
       (SELECT COUNT(*) FROM links l WHERE l.creator_id=c.id AND l.state='new') AS links_new
FROM creators c LEFT JOIN posts p ON p.creator_id=c.id
{where}
GROUP BY c.id ORDER BY c.group_path, LOWER(COALESCE(NULLIF(c.alias,''), c.name))
"""


def _filtered_out(ctx: Context, c: sqlite3.Row) -> int:
    """Fetchable posts a filter keeps out of downloads, which therefore are not waiting."""
    if not ctx.settings.global_filter and not load(c["filter"], {}):
        return 0
    rows = ctx.db.all(
        """SELECT p.*, COUNT(f.id) AS files, IFNULL(SUM(f.role<>'cover'), 0) AS att
           FROM posts p LEFT JOIN files f USING(creator_id, post_id)
           WHERE p.creator_id=? AND p.local_done=0 AND (p.p_state='full' OR p.f_state='open')
           GROUP BY p.post_id""",
        (c["id"],),
    )
    return sum(1 for p in rows if filter_reason(ctx, c, p, p["files"], p["att"]))


def _summary(ctx: Context, c: sqlite3.Row) -> dict:
    if not has_site(c["service"]):
        f_dot = "na"
    elif c["f_open"]:
        f_dot = "open"
    elif c["f_locked"]:
        f_dot = "locked"
    elif c["fanbox_state"] == "none":
        f_dot = "none"
    else:
        f_dot = "unknown"
    return {
        "id": c["id"],
        "service": c["service"],
        # The creator's own site, as the UI names it ("Fanbox" or "Patreon").
        "site": site_label(c["service"]),
        "user_id": c["user_id"],
        "name": c["name"],
        "alias": c["alias"],
        "group": c["group_path"],
        "ignore": bool(c["ignore"]),
        "completed": bool(c["completed"]),
        "p_dot": "full" if c["p_full"] else ("meta" if c["p_meta"] else "none"),
        "f_dot": f_dot,
        "f_checked": bool(c["fanbox_listed_at"]),
        "fetchable": c["fetchable"] - (_filtered_out(ctx, c) if c["fetchable"] else 0),
        "failed": c["failed"],
        "links_new": c["links_new"],
        "total": c["total"],
        "done": c["done"],
    }


def creators(ctx: Context) -> list[dict]:
    return [_summary(ctx, c) for c in ctx.db.all(CREATOR_ROWS.format(where=""), {"now": now_utc()})]


def creator_detail(ctx: Context, creator_id: str) -> dict:
    creator = ctx.require_creator(creator_id)
    row = ctx.db.one(
        CREATOR_ROWS.format(where="WHERE c.id=:cid"), {"cid": creator_id, "now": now_utc()}
    )
    assert row is not None
    summary = _summary(ctx, row)
    local = ctx.db.one(
        """SELECT IFNULL(SUM(via IN ('fanbox','adopted')),0) AS fanbox,
                  IFNULL(SUM(via='pawchive'),0) AS pawchive,
                  IFNULL(SUM(via='local'),0) AS found, IFNULL(SUM(state='failed'),0) AS failed
           FROM files WHERE creator_id=? AND role<>'cover'""",
        (creator_id,),
    )
    plans = [
        dict(r)
        for r in ctx.db.all(
            "SELECT plan_id, fee, title FROM subscriptions WHERE creator_id=? ORDER BY fee",
            (creator_id,),
        )
    ]
    return {
        **summary,
        "fanbox_creator_id": creator["fanbox_creator_id"],
        "fanbox_state": creator["fanbox_state"],
        "fanbox_checked_at": creator["fanbox_checked_at"],
        "fanbox_listed_at": creator["fanbox_listed_at"],
        "pawchive_state": creator["pawchive_state"],
        "pawchive_checked_at": creator["pawchive_checked_at"],
        "synced_at": creator["synced_at"],
        "last_date": creator["last_date"],
        "plans": plans,
        "plan_fee": plan_fee(ctx, creator_id),
        "session": ctx.session(creator["service"]).get("state"),
        "currency": site_currency(creator["service"]),
        "local": dict(local) if local else {},
        "dir": str(ctx.creator_dir(creator)),
        "config": load(creator["config"], {}) or {},
        "filter": load(creator["filter"], {}) or {},
        "timer": load(creator["timer"]),
        "preference": ctx.preference(creator),
    }


def post_detail(ctx: Context, creator_id: str, post_id: str) -> dict:
    creator = ctx.creator(creator_id)
    post = ctx.db.one("SELECT * FROM posts WHERE creator_id=? AND post_id=?", (creator_id, post_id))
    if creator is None or post is None:
        raise KeyError(post_id)
    rows = post_rows(ctx, creator_id, post_id)
    obs = {
        r["source"]: {
            "state": r["state"],
            "title": r["title"],
            "published": r["published"],
            "edited": r["edited"],
            "fee": r["fee"],
            "detail_at": r["detail_at"],
            "first_seen": r["first_seen"],
            "last_seen": r["last_seen"],
            "gone_since": r["gone_since"],
        }
        for r in ctx.db.all(
            "SELECT * FROM post_obs WHERE creator_id=? AND post_id=?", (creator_id, post_id)
        )
    }
    files = []
    for f in ctx.db.all(
        """SELECT f.*, d.misses FROM files f
           LEFT JOIN deferrals d ON d.source='pawchive' AND d.key=f.p_path
           WHERE f.creator_id=? AND f.post_id=? ORDER BY f.ordinal""",
        (creator_id, post_id),
    ):
        files.append(
            {
                "id": f["id"],
                "key": f["key"],
                "role": f["role"],
                "name": f["name"],
                "local_name": f["local_name"],
                "state": f["state"],
                "via": f["via"] and shown_via(f["via"]),
                "present_p": bool(f["present_p"]),
                "present_f": bool(f["present_f"]),
                "has_p": bool(f["p_path"]),
                "has_f": bool(f["f_url"]),
                "size": f["size"],
                "width": f["width"],
                "height": f["height"],
                "local_size": f["local_size"],
                "verified": f["verified"],
                "error": f["error"],
                "misses": f["misses"],
            }
        )
    folder = post_dir(ctx, creator, post)
    return {
        **(rows[0] if rows else {}),
        "content": (post["content"] or "")[:4000],
        "obs": obs,
        "files": files,
        "dir": str(folder),
        "dir_exists": Path(folder).is_dir(),
        "done_at": post["done_at"],
        "stale": post["stale"],
    }


# Files fetched per day on the overview, and how long a creator may go unsynced before it
# is listed as stale.
DAYS_SHOWN = 14
SYNC_STALE_DAYS = 30
FAILED_SHOWN = 12


def overview(ctx: Context) -> dict:
    """The overview page's panels: every kept post by its headline state, what needs a
    look and where, and what was fetched day by day."""
    status: Counter[str] = Counter()
    # Per issue: how many posts, and which creators hold them.
    issues: dict[str, Counter[str]] = defaultdict(Counter)
    failed: list[tuple[str, dict]] = []
    for c in ctx.db.all("SELECT id FROM creators WHERE ignore=0"):
        for r in post_rows(ctx, c["id"]):
            k = r["head"]["k"]
            status[k] += 1
            why = r["head"]["why"] or ""
            if k == "failed":
                issues["failed"][c["id"]] += 1
                failed.append((c["id"], r))
            if r["verified_bad"]:
                issues["mismatch"][c["id"]] += 1
            if "unverified" in why:
                issues["unverified"][c["id"]] += 1
            if why.startswith("Updated upstream"):
                issues["stale"][c["id"]] += 1
    since = (datetime.now(UTC) - timedelta(days=SYNC_STALE_DAYS)).replace(tzinfo=None).isoformat()
    for r in ctx.db.all(
        "SELECT creator_id, COUNT(*) AS n FROM links WHERE state='new' GROUP BY creator_id"
    ):
        issues["links"][r["creator_id"]] = r["n"]
    for c in ctx.db.all(
        "SELECT id FROM creators WHERE ignore=0 AND completed=0 AND (synced_at IS NULL OR synced_at<?)",
        (since,),
    ):
        issues["unsynced"][c["id"]] = 1
    first_day = (datetime.now(UTC) - timedelta(days=DAYS_SHOWN - 1)).date().isoformat()
    # Downloads only: imported and adopted files carry no size of their own fetch.
    daily = [
        dict(r)
        for r in ctx.db.all(
            "SELECT substr(done_at,1,10) AS day, via, COUNT(*) AS files, "
            "SUM(local_size) AS bytes FROM files WHERE state='done' AND role<>'cover' "
            "AND via IN ('pawchive','fanbox') AND local_size IS NOT NULL AND done_at>=? "
            "GROUP BY day, via ORDER BY day",
            (first_day,),
        )
    ]
    got = Counter()
    for r in ctx.db.all(
        "SELECT via, COUNT(*) AS n FROM files WHERE state='done' AND role<>'cover' GROUP BY via"
    ):
        got[shown_via(r["via"]) if r["via"] else "unknown"] += r["n"]
    failed.sort(key=lambda x: x[1]["published"], reverse=True)
    failed_posts = []
    for cid, r in failed[:FAILED_SHOWN]:
        err = ctx.db.one(
            "SELECT error, COUNT(*) AS n FROM files WHERE creator_id=? AND post_id=? "
            "AND state='failed' AND role<>'cover'",
            (cid, r["id"]),
        )
        failed_posts.append(
            {
                "creator_id": cid,
                "post_id": r["id"],
                "title": r["title"],
                "published": r["published"],
                "files": err["n"] if err else 0,
                "error": (err["error"] if err else "") or "",
            }
        )
    return {
        "status": dict(status),
        "got": dict(got),
        "failed": failed_posts,
        "issues": {
            k: {
                "posts": sum(v.values()),
                "creators": [cid for cid, _ in v.most_common(3)],
                "n": len(v),
            }
            for k, v in issues.items()
        },
        "daily": daily,
        "first_day": first_day,
        "days": DAYS_SHOWN,
    }
