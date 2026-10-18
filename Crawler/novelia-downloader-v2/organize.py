#!/usr/bin/env python3
"""Keep one edition of each volume in the download directory, sorted by edition.

A volume whose Japanese original is saved keeps only that: its bilingual file, the editions
converted from it, its reference and Novelia's Chinese build are deleted. A Chinese-only
upload is deleted when a Japanese or bilingual volume of the same work has its number (side
stories never match). What remains goes into `Japanese/`, `Bilingual/` and `Chinese/`, one
folder per work, and the library records follow.

This is not part of the downloader. It can run while the server is idle or downloading; it
waits while a conversion task runs. Without --apply it only reports.

    uv run organize.py
    uv run organize.py --apply
    uv run organize.py --apply --watch 10    # repeat every 10 minutes, e.g. during a sweep
"""

import argparse
import io
import os
import re
import shutil
import sys
import time
import unicodedata
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from app.database import BILINGUAL_MODES, CHINESE, ORIGINAL_JP, ORIGINAL_ZH, Database
from app.storage import (
    BILINGUAL_FOLDER,
    CHINESE_FOLDER,
    JAPANESE_FOLDER,
    PATH_COLUMNS,
    mode_folder,
)

PROJECT = Path(__file__).resolve().parent
TREES = (JAPANESE_FOLDER, BILINGUAL_FOLDER, CHINESE_FOLDER)
# Volumes that are not a numbered main-series book, so a matching number means nothing.
EXTRA = re.compile(
    r"短篇|短編|番外|特典|外传|外傳|前日|合集|合本|全巻|全卷|设定|設定|画集|画册|插图|插畫|特装|"
    r"附录|付録|小册|小冊|特別|特别|SS|IF|EX|BD",
    re.I,
)
ROMAN = dict(zip("ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ", range(1, 11), strict=True))
CHINESE_DIGITS = dict(zip("一二三四五六七八九十", range(1, 11), strict=True))


def volume_number(name: str) -> int | None:
    """The series number in an uploaded file name, in Japanese or Chinese naming styles."""
    text = unicodedata.normalize("NFKC", re.sub(r"\.(epub|txt)$", "", name, flags=re.I))
    text = re.sub(r"\([^)]*(?:文庫|文库|BOOKS|ノベル)[^)]*\)", "", text)  # imprint, may hold digits
    text = re.sub(r"(?:19|20)\d\d", "", text)
    for numeral, value in ROMAN.items():
        text = text.replace(numeral, f" {value} ")
    if digits := re.findall(r"\d{1,3}", text):
        return int(digits[-1])
    if words := re.findall(r"第([一二三四五六七八九十])[巻卷集]", text):
        return CHINESE_DIGITS[words[-1]]
    return None


def chinese_counterpart(volume_id: str, others: list[str]) -> str | None:
    """A saved Japanese or bilingual volume of the same work with the same series number."""
    number = volume_number(volume_id)
    if number is None or EXTRA.search(volume_id):
        return None
    return next((o for o in others if not EXTRA.search(o) and volume_number(o) == number), None)


def exists(value: str | None) -> bool:
    return bool(value) and Path(value).is_file()


def intact(record: dict) -> bool:
    """A saved original that is all there; the downloader checked it when it arrived."""
    path = Path(record["raw_path"])
    try:
        if not path.is_file() or path.stat().st_size != record["size"]:
            return False
        if path.suffix.lower() != ".epub":
            return True
        with zipfile.ZipFile(path) as archive:
            return any(name.lower().endswith(".opf") for name in archive.namelist())
    except OSError, zipfile.BadZipFile:
        return False


def label(record: dict) -> str:
    return "bilingual" if record["mode"] in BILINGUAL_MODES else record["mode"]


def target_folder(record: dict, column: str) -> str:
    if column == "ja_path":
        return JAPANESE_FOLDER
    if column == "zh_path":
        return CHINESE_FOLDER
    return mode_folder(record["mode"])  # a reference stays with its bilingual file


@dataclass
class Plan:
    deletions: list[tuple[dict, str]] = field(default_factory=list)
    moves: list[tuple[dict, str, Path, Path]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    freed: Counter = field(default_factory=Counter)
    kept: Counter = field(default_factory=Counter)


class Organizer:
    def __init__(self, db: Database, root: Path, roots: list[Path], settle: float = 300):
        self.db, self.root, self.roots = db, root, [r.resolve() for r in roots]
        self.settle = settle
        """Seconds an empty folder must have been left alone before it is removed."""

    def managed(self, value: str) -> Path | None:
        path = Path(value).resolve()
        return path if any(path.is_relative_to(r) and path != r for r in self.roots) else None

    def plan(self) -> Plan:
        plan = Plan()
        works: dict[str, list[dict]] = {}
        for row in self.db.rows("SELECT * FROM files ORDER BY work_key,id"):
            works.setdefault(row["work_key"], []).append(row)
        for rows in works.values():
            japanese = {r["volume_id"] for r in rows if r["mode"] == ORIGINAL_JP and intact(r)}
            bilingual = {
                r["volume_id"]
                for r in rows
                if r["mode"] in BILINGUAL_MODES and (exists(r["raw_path"]) or exists(r["ja_path"]))
            }
            others = sorted(japanese | bilingual)
            for row in rows:
                if row["mode"] in (*BILINGUAL_MODES, CHINESE) and row["volume_id"] in japanese:
                    plan.deletions.append((row, "Japanese original saved"))
                elif row["mode"] == ORIGINAL_ZH and (
                    match := chinese_counterpart(row["volume_id"], others)
                ):
                    plan.deletions.append((row, f"same volume saved: {match}"))
                else:
                    self.plan_moves(row, plan)
        for row, _ in plan.deletions:
            paths = {row[c] for c in PATH_COLUMNS}
            plan.freed[label(row)] += sum(Path(p).stat().st_size for p in paths if exists(p))
        return plan

    def plan_moves(self, row: dict, plan: Plan) -> None:
        if exists(row["raw_path"]) or exists(row["ja_path"]) or exists(row["zh_path"]):
            plan.kept[mode_folder(row["mode"])] += 1
        seen = set()
        for column in PATH_COLUMNS:
            value = row[column]
            if not exists(value) or value in seen:
                continue
            seen.add(value)  # an original is its own Japanese edition: one file, two columns
            source = self.managed(value)
            if source is None:
                plan.warnings.append(f"Outside the download directories, left alone: {value}")
                continue
            dest = self.root / target_folder(row, column) / source.parent.name / source.name
            if dest == source:
                continue
            if dest.exists():
                plan.warnings.append(f"Not moved, the destination exists: {dest}")
                continue
            plan.moves.append((row, column, source, dest))

    def busy(self) -> bool:
        return bool(self.db.row("SELECT id FROM jobs WHERE status='running' AND kind='convert'"))

    def apply(self, plan: Plan) -> None:
        for row, _ in plan.deletions:
            for value in {row[c] for c in PATH_COLUMNS if row[c]}:
                if path := self.managed(value):
                    path.unlink(missing_ok=True)
            self.db.execute("DELETE FROM files WHERE id=?", (row["id"],))
        for row, column, source, dest in plan.moves:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(source, dest)
            # Both columns of an original name the same file.
            for col in PATH_COLUMNS:
                if row[col] == row[column]:
                    self.db.execute(
                        f"UPDATE files SET {col}=? WHERE id=? AND {col}=?",
                        (str(dest), row["id"], row[col]),
                    )
        self.remove_empty_folders()

    def remove_empty_folders(self) -> None:
        """Work folders emptied by deletions and moves. A folder created in the last few
        minutes is left alone: the downloader may be about to write into it."""
        recent = time.time() - self.settle
        for top in self.root.iterdir():
            if not top.is_dir():
                continue
            for folder in sorted((p for p in top.rglob("*") if p.is_dir()), reverse=True):
                if not any(folder.iterdir()) and folder.stat().st_mtime < recent:
                    folder.rmdir()
            if top.name not in TREES and not any(top.iterdir()):
                top.rmdir()


def gigabytes(size: int) -> str:
    return f"{size / 1e9:.1f} GB"


def report(plan: Plan, applied: bool) -> None:
    verb = "Deleted" if applied else "Would delete"
    names = {"bilingual": "bilingual", CHINESE: "Novelia Chinese", ORIGINAL_ZH: "Chinese-only"}
    for kind, count in Counter(label(r) for r, _ in plan.deletions).items():
        print(f"{verb} {count} {names[kind]} file(s), {gigabytes(plan.freed[kind])}")
    moved = Counter(dest.parent.parent.name for *_, dest in plan.moves)
    for folder, count in sorted(moved.items()):
        print(f"{'Moved' if applied else 'Would move'} {count} file(s) into {folder}/")
    kept = ", ".join(f"{plan.kept[t]} in {t}/" for t in TREES)
    print(f"Volumes kept: {kept}")
    for warning in plan.warnings[:20]:
        print("Warning:", warning)
    if len(plan.warnings) > 20:
        print(f"… and {len(plan.warnings) - 20} more warning(s)")
    for row, reason in plan.deletions[:5]:
        print(f"  e.g. {Path(row['raw_path']).name} ({reason})")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    parser = argparse.ArgumentParser(description="Keep one edition of each volume, by edition.")
    parser.add_argument("--apply", action="store_true", help="make the changes")
    parser.add_argument("--watch", type=float, metavar="MINUTES", help="repeat until stopped")
    args = parser.parse_args()
    data = Path(os.environ.get("NOVELIA_DATA_DIR", PROJECT / "data")).resolve()
    db = Database(data / "library.sqlite3")
    default = os.environ.get("NOVELIA_DOWNLOAD_DIR", PROJECT / "downloads")
    root = Path(db.setting("download_root", str(default))).resolve()
    roots = [root, *map(Path, db.setting("previous_download_roots", []))]
    organizer = Organizer(db, root, roots)
    while True:
        if organizer.busy():
            print("A conversion task is running; waiting for it to finish.")
        else:
            plan = organizer.plan()
            if args.apply:
                organizer.apply(plan)
            report(plan, args.apply)
            print(f"Free space: {gigabytes(shutil.disk_usage(root).free)}")
        if not args.watch:
            return 0
        time.sleep(args.watch * 60)


if __name__ == "__main__":
    raise SystemExit(main())
