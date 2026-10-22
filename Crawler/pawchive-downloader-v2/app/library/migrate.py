"""Migrations: plan first (with conflicts and evidence), look, then execute.

`adopt`     claim folders another tool downloaded, map each to a post id and rename it
            to this project's layout. The one preset is the "Pixiv Fanbox Downloader"
            Chrome extension: `{feeRequired}/[YYYY.MM.DD] {title}/{n}.{ext}`, where `0.*`
            is the cover, `1..n` every other file in reading order and `0.txt` the text.
            Its dates are the browser's local time, so the offset is inferred from the
            data, never assumed.
`relayout`  rename post folders to the current template, with the folder date rendered
            at a chosen UTC offset (0 by default).

A plan is stored in `migrations`; executing it records the outcome of every item.
"""

import os
import re
import shutil
import sqlite3
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from ..domain.timefmt import format_offset, infer_offset, local_date, now_utc, shift
from ..engine.context import Context
from ..store.db import dump, load
from .imagesize import image_size

_FOLDER = re.compile(r"^\[(\d{4})\.(\d{2})\.(\d{2})\] ?(.*)$")
_NUMBERED = re.compile(r"^(\d+)(?: \(\d+\))?(\.[^.]+)$")


def norm_title(text: str) -> str:
    """Comparable form of a title: the extension and this project sanitise names
    differently, so only letters and digits are compared, width- and case-folded."""
    text = unicodedata.normalize("NFKC", text).casefold()
    return "".join(ch for ch in text if ch.isalnum())


@dataclass
class Folder:
    path: Path
    fee: int
    date: str
    title: str


def scan_extension_layout(root: Path) -> list[Folder]:
    base = root / "fanbox" if (root / "fanbox").is_dir() else root
    out = []
    for fee_dir in sorted(base.iterdir()):
        if not (fee_dir.is_dir() and fee_dir.name.isdigit()):
            continue
        for d in sorted(fee_dir.iterdir()):
            m = _FOLDER.match(d.name)
            if d.is_dir() and m:
                out.append(Folder(d, int(fee_dir.name), f"{m[1]}-{m[2]}-{m[3]}", m[4]))
    return out


def _numbered_files(folder: Path) -> tuple[list[tuple[int, Path]], Path | None]:
    files, text = [], None
    for p in folder.iterdir():
        if not p.is_file():
            continue
        m = _NUMBERED.match(p.name)
        if p.suffix.lower() == ".txt" and m and m[1] == "0":
            text = text or p
        elif m:
            files.append((int(m[1]), p))
    return sorted(files, key=lambda x: x[0]), text


def _file_plan(folder: Path, rows: list[sqlite3.Row]) -> tuple[list[dict], str]:
    """Pair the extension's numbered files with the post's files by position. Returns the
    pairs and a note; an empty note means the counts agree."""
    numbered, text = _numbered_files(folder)
    pairs = []
    if rows and len(numbered) == len(rows):
        for (_, src), row in zip(numbered, rows, strict=True):
            check = None
            if row["size"]:
                check = int(src.stat().st_size == row["size"])
            elif row["width"] and row["height"]:
                dims = image_size(src)
                check = int(dims == (row["width"], row["height"])) if dims else 0
            pairs.append(
                {"src": src.name, "dst": row["local_name"], "file_id": row["id"], "verified": check}
            )
        note = ""
    else:
        pairs = [
            {"src": p.name, "dst": p.name, "file_id": None, "verified": None} for _, p in numbered
        ]
        note = (
            "file list unknown"
            if not rows
            else f"file count differs: {len(numbered)} here, {len(rows)} in the post"
        )
    if text:
        pairs.append({"src": text.name, "dst": "content.txt", "file_id": None, "verified": None})
    return pairs, note


def plan_adopt(ctx: Context, creator_id: str, root: Path, offset: int | None = None) -> int:
    creator = ctx.require_creator(creator_id)
    if not root.is_dir():
        raise FileNotFoundError(f"No such folder: {root}")
    posts = ctx.db.all("SELECT * FROM posts WHERE creator_id=?", (creator_id,))
    if not ctx.db.one(
        "SELECT 1 FROM post_obs WHERE creator_id=? AND source='fanbox'", (creator_id,)
    ):
        raise RuntimeError("Sync Fanbox first: adopting matches folders against Fanbox's post list")
    folders = scan_extension_layout(root)
    by_key: dict[tuple[int, str], list[sqlite3.Row]] = defaultdict(list)
    by_title: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for p in posts:
        by_key[(p["fee"], norm_title(p["title"]))].append(p)
        by_title[norm_title(p["title"])].append(p)

    candidates = []
    for f in folders:
        exact = by_key.get((f.fee, norm_title(f.title)), [])
        loose = [p for p in by_title.get(norm_title(f.title), []) if p not in exact]
        candidates.append((f, exact, loose))

    samples = [
        (f.title, f.date, exact[0]["published"]) for f, exact, _ in candidates if len(exact) == 1
    ]
    guesses = infer_offset(samples)
    chosen = offset if offset is not None else (guesses[0].minutes if guesses else 0)

    items = []
    claimed: dict[str, list[int]] = defaultdict(list)
    for f, exact, loose in candidates:
        pool = exact or loose
        on_date = [p for p in pool if local_date(p["published"], chosen) == f.date]
        near = [
            p
            for p in pool
            if abs((shift(p["published"], chosen).date() - date.fromisoformat(f.date)).days) <= 1
        ]
        pick = on_date if len(on_date) == 1 else []
        if not pick and len(pool) == 1 and near:
            pick = pool
        item = {
            "folder": str(f.path),
            "name": f.path.name,
            "fee": f.fee,
            "date": f.date,
            "title": f.title,
            "candidates": [_cand(p) for p in (on_date or near or pool)[:6]],
        }
        if pick:
            item.update(
                status="matched",
                post_id=pick[0]["post_id"],
                note="" if exact else "different fee; matched by title",
            )
            claimed[pick[0]["post_id"]].append(len(items))
        elif pool:
            item.update(
                status="ambiguous", post_id=None, note=f"{len(on_date or near or pool)} candidates"
            )
        else:
            item.update(status="unmatched", post_id=None, note="not on Fanbox (deleted?)")
        items.append(item)
    for post_id, idxs in claimed.items():
        if len(idxs) > 1:
            for i in idxs:
                items[i].update(
                    status="ambiguous",
                    post_id=None,
                    note=f"{len(idxs)} folders match post {post_id}",
                )
    for item in items:
        if item["status"] == "matched":
            _attach_files(ctx, creator, item)

    matched_ids = {i["post_id"] for i in items if i.get("post_id")}
    missing = [
        p["post_id"]
        for p in posts
        if p["post_id"] not in matched_ids
        and p["f_state"] in ("open", "locked")
        and not p["local_done"]
    ]
    summary = {
        "root": str(root),
        "offset": chosen,
        "offset_label": format_offset(chosen),
        "offset_given": offset is not None,
        "evidence": [
            {
                "minutes": g.minutes,
                "label": format_offset(g.minutes),
                "agree": g.agree,
                "total": g.total,
                "witnesses": g.witnesses,
            }
            for g in guesses[:4]
        ],
        "counts": _counts(items),
        "missing_locally": len(missing),
    }
    return _save_plan(
        ctx, "adopt", creator_id, {"root": str(root), "offset": offset}, summary, items
    )


# ---------------------------------------------------------------- plans


def _save_plan(
    ctx: Context, kind: str, creator_id: str, params: dict, summary: dict, items: list[dict]
) -> int:
    with ctx.db.tx() as conn:
        plan_id = conn.execute(
            "INSERT INTO migrations(kind, creator_id, params, created_at, summary, items) "
            "VALUES(?,?,?,?,?,?)",
            (kind, creator_id, dump(params), now_utc(), dump(summary), dump(items)),
        ).lastrowid
    assert plan_id is not None
    return plan_id


def _open_plan(ctx: Context, plan_id: int) -> sqlite3.Row:
    """A plan that can still change: KeyError if there is none, RuntimeError once run."""
    plan = ctx.db.one("SELECT * FROM migrations WHERE id=?", (plan_id,))
    if plan is None:
        raise KeyError(plan_id)
    if plan["executed_at"]:
        raise RuntimeError("This plan has already been executed")
    return plan


def _finish(ctx: Context, plan_id: int, items: list[dict], done: int, failed: int) -> dict:
    result = {"done": done, "failed": failed}
    ctx.db.run(
        "UPDATE migrations SET items=?, executed_at=?, result=? WHERE id=?",
        (dump(items), now_utc(), dump(result), plan_id),
    )
    return result


def _cand(p: sqlite3.Row) -> dict:
    return {
        "post_id": p["post_id"],
        "title": p["title"],
        "published": p["published"],
        "fee": p["fee"],
        "files": None,
    }


def _counts(items: list[dict]) -> dict:
    counts: dict[str, int] = defaultdict(int)
    for i in items:
        counts[i["status"]] += 1
        if i["status"] == "matched" and i.get("file_note"):
            counts["file_mismatch"] += 1
    return dict(counts)


def _target(ctx: Context, creator: sqlite3.Row, post: sqlite3.Row, folder: Path) -> Path:
    """Adopted folders stay where they are (an archive drive is the user's choice); only
    the fee level is dropped and the folder takes this project's name."""
    return folder.parent.parent / ctx.post_folder_name(creator, post)


def _attach_files(ctx: Context, creator: sqlite3.Row, item: dict, accept: bool = False):
    """Add the file pairing and target to a matched item. A folder whose file count does
    not agree with the post is held for review unless `accept`: pairing by position
    would then attach the wrong names."""
    post = ctx.db.one(
        "SELECT * FROM posts WHERE creator_id=? AND post_id=?", (creator["id"], item["post_id"])
    )
    assert post is not None
    rows = ctx.db.all(
        "SELECT * FROM files WHERE creator_id=? AND post_id=? ORDER BY ordinal",
        (creator["id"], item["post_id"]),
    )
    folder = Path(item["folder"])
    pairs, note = _file_plan(folder, rows)
    item["files"] = pairs
    item["file_note"] = note
    item["target"] = str(_target(ctx, creator, post, folder))
    item["verified"] = {
        "ok": sum(1 for p in pairs if p["verified"] == 1),
        "bad": sum(1 for p in pairs if p["verified"] == 0),
        "unknown": sum(1 for p in pairs if p["verified"] is None and p["dst"] != "content.txt"),
    }
    if Path(item["target"]).exists() and Path(item["target"]) != folder:
        item.update(status="conflict", note="target folder exists")
    elif note.startswith("file count differs") and not accept:
        item.update(status="review", note=note)


def resolve(ctx: Context, plan_id: int, folder: str, post_id: str | None) -> dict:
    """Settle an ambiguous item by hand (`post_id=None` leaves it out)."""
    plan = _open_plan(ctx, plan_id)
    creator = ctx.require_creator(plan["creator_id"])
    items = load(plan["items"], [])
    for item in items:
        if item["folder"] == folder:
            if post_id:
                item.update(status="matched", post_id=post_id, note="set by hand")
                _attach_files(ctx, creator, item, accept=True)
            else:
                item.update(status="skipped", post_id=None, note="skipped by hand")
            break
    else:
        raise KeyError(folder)
    summary = load(plan["summary"], {})
    summary["counts"] = _counts(items)
    ctx.db.run(
        "UPDATE migrations SET items=?, summary=? WHERE id=?", (dump(items), dump(summary), plan_id)
    )
    return item


def _move_dir(src: Path, dst: Path):
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.rename(src, dst)
    except OSError:
        # Another drive: copy, compare sizes, then remove the original.
        shutil.copytree(src, dst)
        for f in src.rglob("*"):
            if f.is_file() and (dst / f.relative_to(src)).stat().st_size != f.stat().st_size:
                raise OSError(f"copy check failed: {f}") from None
        shutil.rmtree(src)


def execute_adopt(ctx: Context, plan_id: int, progress=lambda _m: None) -> dict:
    plan = _open_plan(ctx, plan_id)
    creator_id = plan["creator_id"]
    items = load(plan["items"], [])
    todo = [i for i in items if i["status"] == "matched"]
    done = failed = 0
    now = now_utc()
    for n, item in enumerate(todo, 1):
        progress(f"Adopting {n}/{len(todo)}: {item['name'][:40]}")
        src, dst = Path(item["folder"]), Path(item["target"])
        try:
            if not src.is_dir():
                raise FileNotFoundError("source folder is gone")
            # Rename inside the folder first, through temporary names, so `1.jpeg -> 0.jpeg`
            # style swaps can never overwrite each other.
            staged = []
            for pair in item["files"]:
                if pair["src"] == pair["dst"]:
                    continue
                tmp = src / f".adopt-{pair['src']}"
                os.rename(src / pair["src"], tmp)
                staged.append((tmp, pair))
            for tmp, pair in staged:
                final = src / pair["dst"]
                if final.exists():
                    raise FileExistsError(f"{pair['dst']} exists")
                os.rename(tmp, final)
            if src != dst:
                _move_dir(src, dst)
            with ctx.db.tx() as conn:
                bad = 0
                for pair in item["files"]:
                    if pair["file_id"] is None:
                        continue
                    if pair["verified"] == 0:
                        # Not the post's file (often a preview the extension saved in place
                        # of the original): it stays pending, and a download replaces it.
                        bad += 1
                        continue
                    path = dst / pair["dst"]
                    conn.execute(
                        "UPDATE files SET state='done', via='adopted', local_size=?, verified=?, "
                        "done_at=?, error=NULL WHERE id=?",
                        (path.stat().st_size, pair["verified"], now, pair["file_id"]),
                    )
                conn.execute(
                    "UPDATE posts SET local_dir=?, local_done=?, done_at=?, origin='adopted' "
                    "WHERE creator_id=? AND post_id=?",
                    (str(dst), int(not bad), now, creator_id, item["post_id"]),
                )
            item["result"] = "ok"
            done += 1
        except Exception as e:
            item["result"] = f"failed: {e}"
            failed += 1
    result = _finish(ctx, plan_id, items, done, failed)
    ctx.events.log(
        "info", f"Adopted {done} folders" + (f", {failed} failed" if failed else ""), creator_id
    )
    return result


# ---------------------------------------------------------------- relayout


def plan_relayout(ctx: Context, creator_id: str, offset: int = 0) -> int:
    """Rename each downloaded post folder (in place, under its current parent) to the
    current template, with the folder date taken at `offset` minutes from UTC."""
    creator = ctx.require_creator(creator_id)
    items, targets = [], defaultdict(list)
    for post in ctx.db.all(
        "SELECT * FROM posts WHERE creator_id=? AND local_dir IS NOT NULL ORDER BY published",
        (creator_id,),
    ):
        current = Path(post["local_dir"])
        if not current.is_dir():
            continue
        published = shift(post["published"], offset).isoformat() if post["published"] else ""
        target = current.parent / ctx.post_folder_name(creator, post, published)
        if target == current:
            continue
        items.append(
            {
                "post_id": post["post_id"],
                "folder": str(current),
                "name": current.name,
                "target": str(target),
                "status": "matched",
                "note": "",
            }
        )
        targets[str(target).lower()].append(len(items) - 1)
    for idxs in targets.values():
        if len(idxs) > 1:
            for i in idxs:
                items[i].update(status="conflict", note="several posts would get this name")
    for item in items:
        if item["status"] == "matched" and Path(item["target"]).exists():
            item.update(status="conflict", note="target folder exists")
    summary = {"offset": offset, "offset_label": format_offset(offset), "counts": _counts(items)}
    return _save_plan(ctx, "relayout", creator_id, {"offset": offset}, summary, items)


def execute_relayout(ctx: Context, plan_id: int, progress=lambda _m: None) -> dict:
    plan = _open_plan(ctx, plan_id)
    items = load(plan["items"], [])
    done = failed = 0
    for n, item in enumerate(i for i in items if i["status"] == "matched"):
        progress(f"Renaming {n + 1}: {item['name'][:40]}")
        try:
            _move_dir(Path(item["folder"]), Path(item["target"]))
            ctx.db.run(
                "UPDATE posts SET local_dir=? WHERE creator_id=? AND post_id=?",
                (item["target"], plan["creator_id"], item["post_id"]),
            )
            item["result"] = "ok"
            done += 1
        except Exception as e:
            item["result"] = f"failed: {e}"
            failed += 1
    return _finish(ctx, plan_id, items, done, failed)


def execute(ctx: Context, plan_id: int, progress=lambda _m: None) -> dict:
    plan = ctx.db.one("SELECT kind FROM migrations WHERE id=?", (plan_id,))
    if plan is None:
        raise KeyError(plan_id)
    if plan["kind"] == "adopt":
        return execute_adopt(ctx, plan_id, progress)
    return execute_relayout(ctx, plan_id, progress)
