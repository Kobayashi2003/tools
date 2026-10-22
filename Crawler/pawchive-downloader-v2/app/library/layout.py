"""Regrouping creators. The sidebar's groups are folders: the creator folder template puts
`{group}` (and `{alias}`) in the path, so a new group or alias moves the creator's folder,
and every post folder recorded under it follows. Folders outside it, such as adopted ones
on another drive, stay where they are.
"""

import os
import shutil
import sqlite3
from collections.abc import Callable
from pathlib import Path

from ..engine.context import Context


def clean_group(text: str) -> str:
    """`a\\b / c/` -> `a/b/c`: either slash separates levels, and empty levels drop out."""
    return "/".join(s.strip() for s in text.replace("\\", "/").split("/") if s.strip())


def regrouped(group: str, old: str, new: str) -> str | None:
    """`group` after group `old` is renamed to `new`; None when it is not under `old`."""
    if group == old:
        return new
    if group.startswith(old + "/"):
        return clean_group(new + group[len(old) :])
    return None


def preview(ctx: Context, creator: sqlite3.Row, group: str, alias: str) -> dict:
    """Where the creator's folder is and where it would go. Raises ValueError when another
    creator already owns the destination: merging two creators' folders cannot be undone."""
    src, dst = ctx.creator_dir(creator), ctx.creator_dir(creator, group, alias)
    if dst != src:
        for other in ctx.db.all("SELECT * FROM creators WHERE id<>?", (creator["id"],)):
            if ctx.creator_dir(other) == dst:
                name = other["alias"] or other["name"]
                raise ValueError(f"{dst} is already the folder of {name} ({other['id']})")
    return {"from": str(src), "to": str(dst), "moves": str(src) != str(dst), "exists": src.is_dir()}


def _merge(src: Path, dst: Path) -> list[Path]:
    """Move `src` to `dst`, into it when it exists. Returns what was left behind because
    the same name is already there; nothing is overwritten."""
    if not dst.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(src, dst)
        return []
    left: list[Path] = []
    for child in list(src.iterdir()):
        target = dst / child.name
        if not target.exists():
            shutil.move(child, target)
        elif child.is_dir() and target.is_dir():
            left += _merge(child, target)
        else:
            left.append(child)
    if not left:
        src.rmdir()
    return left


def _prune(folder: Path, root: Path):
    """Remove `folder` and its parents while empty, stopping at the download folder."""
    while folder != root and folder.is_relative_to(root) and folder.is_dir():
        try:
            folder.rmdir()
        except OSError:
            return
        folder = folder.parent


def move_creator(
    ctx: Context,
    creator_id: str,
    group: str,
    alias: str | None = None,
    progress: Callable[[str], None] = lambda _m: None,
) -> str:
    creator = ctx.require_creator(creator_id)
    group = clean_group(group)
    new_alias: str = creator["alias"] if alias is None else alias.strip()
    plan = preview(ctx, creator, group, new_alias)
    src, dst = Path(plan["from"]), Path(plan["to"])
    left: list[Path] = []
    if plan["moves"] and plan["exists"]:
        progress(f"Moving {src} -> {dst}")
        if src == dst:
            # Only the letter case differs: Windows sees one folder, so rename it in place.
            os.rename(src, dst)
        else:
            left = _merge(src, dst)
    with ctx.db.tx() as conn:
        if plan["moves"]:
            for row in conn.execute(
                "SELECT post_id, local_dir FROM posts WHERE creator_id=? AND local_dir IS NOT NULL",
                (creator_id,),
            ).fetchall():
                local = Path(row["local_dir"])
                if local.is_relative_to(src):
                    conn.execute(
                        "UPDATE posts SET local_dir=? WHERE creator_id=? AND post_id=?",
                        (str(dst / local.relative_to(src)), creator_id, row["post_id"]),
                    )
        conn.execute(
            "UPDATE creators SET group_path=?, alias=? WHERE id=?", (group, new_alias, creator_id)
        )
    if plan["moves"] and src != dst:
        _prune(src.parent, Path(ctx.settings.download_dir))
    name = new_alias or creator["name"]
    if left:
        ctx.events.log(
            "warning",
            f"Moved {name}, but {len(left)} items were already at the destination and stay in "
            f"{src}: {', '.join(p.name for p in left[:5])}",
            creator_id,
        )
        return f"moved to {group or 'Ungrouped'}; {len(left)} items left in the old folder"
    return f"moved to {group or 'Ungrouped'}" + ("" if plan["exists"] else " (nothing on disk yet)")
