import struct
import threading
import zlib
from pathlib import Path

import pytest

from app.domain.match import fanbox_entries, pawchive_entries
from app.domain.timefmt import now_utc, to_utc
from app.engine.context import Context
from app.engine.jobs import JobRunner
from app.engine.reconcile import entries_json, reconcile_creator
from app.engine.sync import sync_creator
from app.engine.views import post_rows
from app.library.imagesize import image_size
from app.library.migrate import execute_adopt, norm_title, plan_adopt, resolve
from app.sources.http import TransientError
from app.store.db import load

CID = "fanbox_1539728"


def png(path: Path, w: int, h: int):
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        )

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IEND", b""))


def add_creator(ctx: Context):
    ctx.db.run(
        "INSERT INTO creators(id, service, user_id, name, alias, group_path, added_at) "
        "VALUES(?, 'fanbox', '1539728', 'intokuinfo', '遠藤弘土', '大量欠落', ?)",
        (CID, now_utc()),
    )


def obs(
    ctx: Context,
    post_id: str,
    source: str,
    state: str,
    published: str,
    entries,
    *,
    title: str = "t",
    fee: int | None = None,
    detail: bool = False,
):
    ctx.db.run(
        "INSERT OR REPLACE INTO post_obs(creator_id, post_id, source, state, title, published, "
        "edited, fee, entries, detail_at, first_seen, last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            CID,
            post_id,
            source,
            state,
            title,
            published,
            published,
            fee,
            entries_json(entries),
            now_utc() if detail else None,
            now_utc(),
            now_utc(),
        ),
    )


def reconcile(ctx: Context):
    creator = ctx.creator(CID)
    assert creator is not None
    with ctx.db.tx() as conn:
        return reconcile_creator(conn, CID, True, ctx.naming(creator), now_utc())


def fanbox_post(images):
    return {
        "coverImageUrl": "https://pixiv.pximg.net/c/1200x630_90_a2_g5/fanbox/public/images/post/468036/cover/Cov.jpeg",
        "body": {"images": images},
    }


IMAGES = [
    {"id": "Hk2p", "extension": "png", "width": 30, "height": 20, "originalUrl": "https://d/1.png"},
    {"id": "aZ81", "extension": "png", "width": 40, "height": 20, "originalUrl": "https://d/2.png"},
]


def test_reconcile_merges_sources_and_never_renames(ctx: Context):
    add_creator(ctx)
    published = to_utc("2019-07-15T06:31:11+09:00")
    p_entries = pawchive_entries(
        {"name": "cover.jpeg", "path": "/c/" + "c" * 64 + ".jpeg"},
        [{"name": "Hk2p.png", "path": "/a/" + "a" * 64 + ".png"}],
    )
    obs(ctx, "468036", "pawchive", "meta", published, p_entries)
    obs(
        ctx,
        "468036",
        "fanbox",
        "open",
        published,
        fanbox_entries(fanbox_post(IMAGES)),
        fee=540,
        detail=True,
    )
    assert reconcile(ctx)["new"] == 1
    files = ctx.db.all("SELECT * FROM files ORDER BY ordinal")
    assert [(f["key"], f["local_name"]) for f in files] == [
        ("cover", "0.jpeg"),
        ("n:Hk2p.png", "1.png"),
        ("n:aZ81.png", "2.png"),
    ]
    # Pawchive has only metadata, so only Fanbox can deliver; the cover is known to both.
    assert [(f["present_p"], f["present_f"]) for f in files] == [(0, 1), (0, 1), (0, 1)]
    row = post_rows(ctx, CID)[0]
    assert (row["cov"], row["head"]["k"], row["planned"], row["fee"]) == (
        "both",
        "pending",
        "fanbox",
        540,
    )

    # A done file keeps its name and stays even if no source lists it any more.
    ctx.db.run("UPDATE files SET state='done', local_name='custom.png' WHERE key='n:aZ81.png'")
    obs(
        ctx,
        "468036",
        "fanbox",
        "open",
        published,
        fanbox_entries(fanbox_post(IMAGES[:1])),
        fee=540,
        detail=True,
    )
    reconcile(ctx)
    names = {f["key"]: f["local_name"] for f in ctx.db.all("SELECT * FROM files")}
    assert names["n:aZ81.png"] == "custom.png"


def test_a_failed_fanbox_listing_leaves_posts_unchecked(
    ctx: Context, monkeypatch: pytest.MonkeyPatch
):
    add_creator(ctx)
    obs(ctx, "1", "pawchive", "meta", "2020-01-01T00:00:00", [])

    def broken_list(handle: str):
        raise TransientError("503")

    monkeypatch.setattr(ctx.fanbox, "creator_id_of", lambda user_id: "intokuinfo")
    monkeypatch.setattr(ctx.fanbox, "list_posts", broken_list)
    with pytest.raises(TransientError):
        sync_creator(ctx, CID, lambda *_: None, threading.Event(), sources=("fanbox",))
    reconcile(ctx)
    assert post_rows(ctx, CID)[0]["f"] == "unknown"

    # A creator without a Fanbox page has a complete, empty listing.
    monkeypatch.setattr(ctx.fanbox, "creator_id_of", lambda user_id: None)
    ctx.db.run("UPDATE creators SET fanbox_creator_id=NULL")
    sync_creator(ctx, CID, lambda *_: None, threading.Event(), sources=("fanbox",))
    assert post_rows(ctx, CID)[0]["f"] == "gone"


def test_manual_done_survives_a_sync(ctx: Context):
    add_creator(ctx)
    obs(
        ctx,
        "1",
        "pawchive",
        "full",
        "2020-01-01T00:00:00",
        pawchive_entries(None, [{"name": "a.png", "path": "/a/" + "a" * 64 + ".png"}]),
    )
    reconcile(ctx)
    ctx.db.run("UPDATE posts SET local_done=1, origin='manual', done_at=?", (now_utc(),))
    reconcile(ctx)
    assert post_rows(ctx, CID)[0]["head"]["k"] == "done"


def test_adopt_extension_folder_end_to_end(ctx: Context, tmp_path: Path):
    add_creator(ctx)
    published = to_utc("2019-07-15T06:31:11+09:00")  # 2019-07-14 in UTC, 07-15 at UTC+8
    title = "【チャンネル特典】シュノン23　支援者向け超高解像度版（縦3840 横2160）"
    obs(
        ctx,
        "468036",
        "fanbox",
        "open",
        published,
        fanbox_entries(fanbox_post(IMAGES)),
        title=title,
        fee=540,
        detail=True,
    )
    obs(ctx, "999", "fanbox", "locked", "2019-08-01T00:00:00", [], title="未下载", fee=540)
    reconcile(ctx)

    root = tmp_path / "遠藤弘土"
    folder = root / "fanbox" / "540" / f"[2019.07.15] {title}"
    folder.mkdir(parents=True)
    (folder / "0.jpeg").write_bytes(b"\xff\xd8cover")
    png(folder / "1.png", 30, 20)
    png(folder / "2.png", 40, 20)
    (folder / "0.txt").write_text("本文", encoding="utf-8")
    other = root / "fanbox" / "540" / "[2018.01.01] 消えた投稿"
    other.mkdir()

    plan_id = plan_adopt(ctx, CID, root)
    plan = ctx.db.one("SELECT * FROM migrations WHERE id=?", (plan_id,))
    assert plan is not None
    summary, items = load(plan["summary"]), load(plan["items"])
    assert summary["counts"] == {"matched": 1, "unmatched": 1}
    assert summary["missing_locally"] == 1
    item = next(i for i in items if i["status"] == "matched")
    assert item["verified"] == {"ok": 2, "bad": 0, "unknown": 1}
    assert Path(item["target"]).name.startswith("[2019.07.14][468036] ")

    assert execute_adopt(ctx, plan_id) == {"done": 1, "failed": 0}
    target = Path(item["target"])
    assert sorted(p.name for p in target.iterdir()) == ["0.jpeg", "1.png", "2.png", "content.txt"]
    assert image_size(target / "2.png") == (40, 20)
    assert not folder.exists() and other.exists()
    row = next(r for r in post_rows(ctx, CID) if r["id"] == "468036")
    assert row["head"]["k"] == "done" and row["via"] == ["adopted"]


def test_resolve_settles_an_ambiguous_folder(ctx: Context, tmp_path: Path):
    add_creator(ctx)
    for pid in ("1", "2"):
        obs(
            ctx,
            pid,
            "fanbox",
            "locked",
            "2024-03-02T03:00:00",
            [],
            title="《チャンネル》更新",
            fee=550,
        )
    reconcile(ctx)
    folder = tmp_path / "fanbox" / "550" / "[2024.03.02] 《チャンネル》更新"
    folder.mkdir(parents=True)
    (folder / "0.jpeg").write_bytes(b"x")
    plan_id = plan_adopt(ctx, CID, tmp_path, offset=480)
    plan = ctx.db.one("SELECT items FROM migrations WHERE id=?", (plan_id,))
    assert plan is not None
    (item,) = load(plan["items"])
    assert item["status"] == "ambiguous" and len(item["candidates"]) == 2
    settled = resolve(ctx, plan_id, item["folder"], "2")
    assert settled["status"] == "matched" and settled["post_id"] == "2"


def test_timers_do_nothing_until_enabled(ctx: Context):
    add_creator(ctx)
    ctx.store.save({"global_timer": {"type": "daily", "time": "00:00"}})
    ctx.reload_settings()
    runner = JobRunner(ctx, 1)
    ctx.db.kv_set("timers", {CID: "2000-01-01T00:00:00"})
    runner._fire_timers()
    assert ctx.db.all("SELECT * FROM jobs") == []
    assert ctx.db.kv_get("timers") == {}


def test_norm_title_ignores_width_and_punctuation():
    assert norm_title("ＡＢＣ（縦3840 横2160）") == norm_title("abc(縦3840横2160)")
