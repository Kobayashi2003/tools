"""Read models for the UI: creator summaries, post rows with their six facts, post detail."""

import sqlite3
from pathlib import Path

from ..domain.filters import FilterTarget, combined, reason
from ..domain.status import (
    PostFacts,
    coverage,
    headline,
    planned_source,
    shown_via,
    subscription,
)
from ..domain.timefmt import now_utc
from ..store.db import load
from .context import Context
from .download import post_dir
from .sync import plan_fee

POST_ROWS = """
SELECT p.*,
       COUNT(f.id) AS total,
       IFNULL(SUM(f.state='done'), 0) AS done,
       IFNULL(SUM(f.state='failed'), 0) AS failed,
       IFNULL(SUM(f.role<>'cover'), 0) AS attachments,
       IFNULL(SUM(f.state<>'done' AND d.next > :now), 0) AS deferred,
       MIN(CASE WHEN f.state<>'done' AND d.next > :now THEN d.next END) AS deferred_until,
       IFNULL(SUM(f.state='done' AND f.verified IS NULL AND f.via='adopted'), 0) AS unverified,
       IFNULL(SUM(f.state='done' AND f.verified=0), 0) AS mismatched,
       GROUP_CONCAT(DISTINCT CASE WHEN f.state='done' THEN f.via END) AS vias
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
            FilterTarget(row["title"], row["published"], row["total"], row["attachments"]),
            cfg,
            origin,
        ),
        local_done=bool(row["local_done"]),
        total=row["total"],
        done=row["done"],
        failed=row["failed"],
        deferred=row["deferred"],
        deferred_until=row["deferred_until"] or "",
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
        head = headline(facts, pref)
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
       IFNULL(SUM(p.local_done=0 AND (p.p_state='full' OR p.f_state='open')), 0) AS fetchable
FROM creators c LEFT JOIN posts p ON p.creator_id=c.id
{where}
GROUP BY c.id ORDER BY c.group_path, LOWER(COALESCE(NULLIF(c.alias,''), c.name))
"""


def _summary(c: sqlite3.Row) -> dict:
    if c["service"] != "fanbox":
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
        "user_id": c["user_id"],
        "name": c["name"],
        "alias": c["alias"],
        "group": c["group_path"],
        "ignore": bool(c["ignore"]),
        "completed": bool(c["completed"]),
        "p_dot": "full" if c["p_full"] else ("meta" if c["p_meta"] else "none"),
        "f_dot": f_dot,
        "f_checked": bool(c["fanbox_listed_at"]),
        "fetchable": c["fetchable"],
        "total": c["total"],
        "done": c["done"],
    }


def creators(ctx: Context) -> list[dict]:
    return [_summary(c) for c in ctx.db.all(CREATOR_ROWS.format(where=""))]


def creator_detail(ctx: Context, creator_id: str) -> dict:
    creator = ctx.require_creator(creator_id)
    row = ctx.db.one(CREATOR_ROWS.format(where="WHERE c.id=?"), (creator_id,))
    assert row is not None
    summary = _summary(row)
    local = ctx.db.one(
        """SELECT IFNULL(SUM(via IN ('fanbox','adopted')),0) AS fanbox,
                  IFNULL(SUM(via='pawchive'),0) AS pawchive,
                  IFNULL(SUM(via='local'),0) AS found, IFNULL(SUM(state='failed'),0) AS failed
           FROM files WHERE creator_id=?""",
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
        "session": ctx.session().get("state"),
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
    now = now_utc()
    files = []
    for f in ctx.db.all(
        """SELECT f.*, d.next AS deferred_until, d.misses FROM files f
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
                "deferred_until": f["deferred_until"]
                if (f["deferred_until"] or "") > now
                else None,
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
