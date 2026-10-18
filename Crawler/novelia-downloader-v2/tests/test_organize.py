from pathlib import Path

import pytest

from app.database import Database
from organize import Organizer, volume_number
from tests.conftest import KEY, epub


def saved(db, root, folder, volume, mode, original=False, **paths):
    path = epub(root / folder / f"{volume} [{mode}].epub", not original)
    if mode == "jp-original":
        db.save_original(KEY, volume, "stamp", path, path.stat().st_size, "digest")
    else:
        db.save_file(KEY, volume, mode, "stamp", path, path.stat().st_size, "digest")
    for column, value in paths.items():
        Path(value).parent.mkdir(parents=True, exist_ok=True)
        Path(value).write_bytes(b"x")
        db.execute(
            f"UPDATE files SET {column}=? WHERE volume_id=? AND mode=?", (value, volume, mode)
        )
    return path


def test_japanese_originals_replace_other_editions_and_trees_are_sorted(tmp_path):
    db = Database(tmp_path / "library.sqlite3")
    root = tmp_path / "downloads"
    db.save_work(KEY, {"title": "T", "volumeJp": []}, 1)
    old = root / "wenku_book"
    bilingual = saved(
        db,
        root,
        "Bilingual/wenku_gone",
        "作品 2.epub",
        "jp-zh",
        ja_path=str(root / "Japanese/wenku_book/作品 2 [ja].epub"),
        reference_path=str(root / "Bilingual/wenku_gone/作品 2 [reference].epub"),
    )
    saved(db, root, "Japanese/wenku_book", "作品 2.epub", "jp-original", original=True)
    zh_match = saved(db, root, "Chinese uploads/wenku_book", "作品 02（台）.epub", "zh-original")
    zh_extra = saved(db, root, "Chinese uploads/wenku_book", "作品 短篇集.epub", "zh-original")
    alone = saved(db, root, "wenku_book", "作品 3.epub", "jp-zh")
    organizer = Organizer(db, root, [root], settle=0)

    plan = organizer.plan()
    assert sorted(r["volume_id"] for r, _ in plan.deletions) == [
        "作品 02（台）.epub",
        "作品 2.epub",
    ]
    assert bilingual.exists()  # a plan changes nothing
    organizer.apply(plan)

    assert not bilingual.exists() and not zh_match.exists()
    assert not (root / "Japanese/wenku_book/作品 2 [ja].epub").exists()
    rows = {r["volume_id"]: r for r in db.rows("SELECT * FROM files")}
    assert sorted(rows) == ["作品 2.epub", "作品 3.epub", "作品 短篇集.epub"]
    assert rows["作品 2.epub"]["mode"] == "jp-original"
    moved = Path(rows["作品 短篇集.epub"]["raw_path"])
    assert moved == root / "Chinese/wenku_book" / zh_extra.name and moved.exists()
    assert Path(rows["作品 3.epub"]["raw_path"]) == root / "Bilingual/wenku_book" / alone.name
    assert not old.exists() and not (root / "Chinese uploads").exists()
    assert not (root / "Bilingual/wenku_gone").exists()  # emptied by the deletion
    second = organizer.plan()
    assert not second.deletions and not second.moves


def test_a_broken_original_does_not_replace_anything(tmp_path):
    db = Database(tmp_path / "library.sqlite3")
    root = tmp_path / "downloads"
    db.save_work(KEY, {"title": "T", "volumeJp": []}, 1)
    saved(db, root, "Bilingual/w", "v1.epub", "jp-zh")
    original = saved(db, root, "Japanese/w", "v1.epub", "jp-original", original=True)
    original.write_bytes(original.read_bytes()[:-40])  # cut off
    assert not Organizer(db, root, [root]).plan().deletions


@pytest.mark.parametrize(
    ("name", "number"),
    [
        ("[白石定规].魔女之旅  05（台）.epub", 5),
        ("魔女の旅々05GAノベル.epub", 5),
        ("DATE A LIVE大作战.第17卷.狂三Ragnarok.epub", 17),
        ("デート・ア・ライブ17　狂三ラグナロク (富士見ファンタジア文庫).epub", 17),
        ("落第騎士の英雄譚＜キャバルリィ＞６.epub", 6),
        ("永生之酒(Baccano!大骚动).第19卷.1935-B.Dr.Feelgreed.epub", 19),
        ("魔王学院第三卷.epub", 3),
        ("作品 短篇集.epub", None),
    ],
)
def test_volume_numbers(name, number):
    assert volume_number(name) == number
