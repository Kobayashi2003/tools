import sqlite3
import struct
import threading
import time
import zlib
from pathlib import Path

import pytest

from app.domain.match import fanbox_entries, pawchive_entries, plain_text
from app.domain.timefmt import now_utc, to_utc
from app.engine.context import Context
from app.engine.download import Downloader, cover_preference, post_dir, save_dir
from app.engine.jobs import JobRunner
from app.engine.reconcile import entries_json, reconcile_creator
from app.engine.sync import sync_creator
from app.engine.views import creators, post_rows
from app.library.imagesize import image_size
from app.library.migrate import execute_adopt, norm_title, plan_adopt, resolve
from app.sources.fanbox import FanboxListItem
from app.sources.http import PermanentError, TransientError
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


def test_a_downloaded_file_keeps_its_row_when_its_key_changes(ctx: Context):
    """v1 saved Pawchive's main file under its own name; later Pawchive calls it
    `cover.jpeg` (same content hash) or it turns out to be Fanbox's cover. Either way it
    is the file already on disk, not a new one to fetch."""
    add_creator(ctx)
    sha = "d" * 64
    main = {"name": "AsBi.jpeg", "path": f"/dd/ce/{sha}.jpg"}
    obs(ctx, "1", "pawchive", "full", "2020-01-01T00:00:00", pawchive_entries(main, []))
    reconcile(ctx)
    # As v1's import recorded it: under the file's own name.
    ctx.db.run("UPDATE files SET key='n:AsBi.jpeg', state='done', via='pawchive'")
    ctx.db.run("UPDATE posts SET local_done=1, done_at='2020-01-02T00:00:00'")

    renamed = {"name": "cover.jpeg", "path": f"/dd/ce/{sha}.jpeg"}
    obs(ctx, "1", "pawchive", "full", "2020-01-01T00:00:00", pawchive_entries(renamed, []))
    obs(
        ctx,
        "1",
        "fanbox",
        "open",
        "2020-01-01T00:00:00",
        fanbox_entries({"coverImageUrl": "https://pixiv.pximg.net/fanbox/public/c/AsBi.jpeg"}),
        detail=True,
    )
    reconcile(ctx)
    rows = ctx.db.all("SELECT key, state, local_name, ordinal FROM files")
    assert [(r["key"], r["state"], r["local_name"], r["ordinal"]) for r in rows] == [
        ("cover", "done", "0.jpeg", 0)
    ]
    assert post_rows(ctx, CID)[0]["head"]["k"] == "done"


def test_the_cover_never_holds_a_post_open_and_follows_its_files(ctx: Context):
    add_creator(ctx)
    p_entries = pawchive_entries(
        {"name": "cover.jpeg", "path": "/c/" + "c" * 64 + ".jpeg"},
        [{"name": "Hk2p.png", "path": "/a/" + "a" * 64 + ".png"}],
    )
    obs(ctx, "1", "pawchive", "full", "2020-01-01T00:00:00", p_entries)
    reconcile(ctx)
    ctx.db.run("UPDATE files SET state='done', via='pawchive' WHERE role<>'cover'")
    reconcile(ctx)
    row = post_rows(ctx, CID)[0]
    assert row["head"]["k"] == "done" and row["via"] == ["pawchive"] and row["cover"] == "pending"
    main = ctx.db.all("SELECT * FROM files WHERE role<>'cover'")
    assert cover_preference(main, "fanbox-first") == "pawchive-first"
    assert cover_preference([], "fanbox-first") == "fanbox-first"


def test_a_download_leaves_no_folder_when_nothing_can_be_fetched(
    ctx: Context, monkeypatch: pytest.MonkeyPatch
):
    add_creator(ctx)
    entries = pawchive_entries(
        {"name": "cover.jpeg", "path": "/c/" + "c" * 64 + ".jpeg"},
        [{"name": "Hk2p.png", "path": "/a/" + "a" * 64 + ".png"}],
    )
    # Pawchive knows the files but has only metadata; Fanbox is not checked.
    obs(ctx, "1", "pawchive", "meta", "2020-01-01T00:00:00", entries)
    ctx.db.run("UPDATE post_obs SET content='<p>hi</p>'")
    reconcile(ctx)
    downloader = Downloader(ctx, threading.Event(), lambda _m: None)
    creator = ctx.require_creator(CID)

    def post():
        row = ctx.db.one("SELECT * FROM posts WHERE post_id='1'")
        assert row is not None
        return row

    downloader.post(creator, post())
    folder = post_dir(ctx, creator, post())
    assert not folder.exists()

    # Once Pawchive has the files, they, the cover and the text arrive together.
    ctx.db.run("UPDATE post_obs SET state='full'")
    reconcile(ctx)

    def fetch(creator, source: str, row, target: Path):
        # As HttpClient.download does, the folder comes with the file.
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"x" * 10)

    monkeypatch.setattr(downloader, "_fetch", fetch)
    downloader.post(creator, post())
    assert sorted(p.name for p in folder.iterdir()) == ["0.jpeg", "1.png", "content.txt"]
    assert (folder / "content.txt").read_text(encoding="utf-8") == "hi"
    assert post()["local_done"] == 1 and post()["text_at"]


def test_a_post_moved_away_by_hand_is_never_written_to(
    ctx: Context, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
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
    archive = tmp_path / "archive" / "post"
    archive.mkdir(parents=True)
    ctx.db.run("UPDATE posts SET local_dir=?", (str(archive),))
    downloader = Downloader(ctx, threading.Event(), lambda _m: None)

    def fetch(creator, source: str, row, target: Path):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"x")

    monkeypatch.setattr(downloader, "_fetch", fetch)
    creator = ctx.require_creator(CID)
    post = ctx.db.one("SELECT * FROM posts WHERE post_id='1'")
    assert post is not None
    downloader.post(creator, post)
    assert not any(archive.iterdir())
    saved = save_dir(ctx, creator, post)
    assert [p.read_bytes() for p in saved.iterdir()] == [b"x"]


def test_an_updated_post_keeps_its_old_version_beside_it(
    ctx: Context, monkeypatch: pytest.MonkeyPatch
):
    add_creator(ctx)
    entries = pawchive_entries(
        {"name": "cover.jpeg", "path": "/c/" + "c" * 64 + ".jpeg"},
        [{"name": "Hk2p.png", "path": "/a/" + "a" * 64 + ".png"}],
    )
    obs(ctx, "1", "pawchive", "full", "2020-01-01T00:00:00", entries)
    reconcile(ctx)
    downloader = Downloader(ctx, threading.Event(), lambda _m: None)
    creator = ctx.require_creator(CID)
    served = {"0.jpeg": b"cover", "1.png": b"old"}

    def fetch(creator, source: str, row, target: Path):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(served[row["local_name"]])

    def post():
        row = ctx.db.one("SELECT * FROM posts WHERE post_id='1'")
        assert row is not None
        return row

    monkeypatch.setattr(downloader, "_fetch", fetch)
    downloader.post(creator, post())
    folder = post_dir(ctx, creator, post())
    siblings = lambda: sorted(p.name for p in folder.parent.iterdir())  # noqa: E731

    # The same bytes again, or only a different cover: nothing is copied.
    served["0.jpeg"] = b"other cover"
    downloader.post(creator, post(), redownload=True)
    assert siblings() == [folder.name]

    served["1.png"] = b"new"
    downloader.post(creator, post(), redownload=True)
    old = [n for n in siblings() if n != folder.name]
    assert len(old) == 1 and old[0].startswith(f"{folder.name} [old ")
    assert (folder.parent / old[0] / "1.png").read_bytes() == b"old"
    assert (folder / "1.png").read_bytes() == b"new"
    assert not [p for p in folder.iterdir() if p.name.startswith(".")]

    ctx.settings.update_policy = "overwrite"
    served["1.png"] = b"newer"
    downloader.post(creator, post(), redownload=True)
    assert len(siblings()) == 2 and (folder / "1.png").read_bytes() == b"newer"


def test_an_image_shown_twice_is_saved_once(ctx: Context, monkeypatch: pytest.MonkeyPatch):
    add_creator(ctx)
    sha = "a" * 64
    # Pawchive: one path under two names; only the first name was ever served.
    entries = pawchive_entries(
        None,
        [
            {"name": "a.png", "path": f"/a/{sha}.png"},
            {"name": "b.png", "path": f"/a/{sha}.png"},
            {"name": "c.png", "path": "/c/" + "c" * 64 + ".png"},
        ],
    )
    obs(ctx, "1", "pawchive", "meta", "2020-01-01T00:00:00", entries)
    # Fanbox lists them all and a fourth, the same bytes as c.png under its own name.
    images = [{"id": i, "extension": "png", "originalUrl": f"u/{i}"} for i in "abcd"]
    obs(
        ctx,
        "1",
        "fanbox",
        "open",
        "2020-01-01T00:00:00",
        fanbox_entries({"body": {"images": images}}),
        detail=True,
    )
    reconcile(ctx)
    ctx.db.run(
        "UPDATE files SET state='done', via='pawchive', verified=1 WHERE name IN ('a.png', 'c.png')"
    )
    downloader = Downloader(ctx, threading.Event(), lambda _m: None)
    creator = ctx.require_creator(CID)
    post = ctx.db.one("SELECT * FROM posts WHERE post_id='1'")
    assert post is not None
    folder = save_dir(ctx, creator, post)
    folder.mkdir(parents=True)
    names = {f["name"]: f["local_name"] for f in ctx.db.all("SELECT * FROM files")}
    (folder / names["a.png"]).write_bytes(b"a")
    (folder / names["c.png"]).write_bytes(b"c")
    fetched = []

    def fetch(creator, source: str, row, target: Path):
        fetched.append(row["name"])
        target.write_bytes(b"c")

    monkeypatch.setattr(downloader, "_fetch", fetch)
    downloader.post(creator, post)
    assert fetched == ["d.png"]
    files = {f["name"]: f for f in ctx.db.all("SELECT * FROM files")}
    assert files["b.png"]["local_name"] == names["a.png"]
    assert files["d.png"]["local_name"] == names["c.png"]
    assert all(f["state"] == "done" and f["via"] == "pawchive" for f in files.values())
    assert sorted(p.name for p in folder.iterdir()) == sorted([names["a.png"], names["c.png"]])


def test_a_pawchive_404_is_retried_only_by_hand(ctx: Context, monkeypatch: pytest.MonkeyPatch):
    add_creator(ctx)
    entries = pawchive_entries(None, [{"name": "a.png", "path": "/a/" + "a" * 64 + ".png"}])
    obs(ctx, "1", "pawchive", "full", "2020-01-01T00:00:00", entries)
    reconcile(ctx)
    downloader = Downloader(ctx, threading.Event(), lambda _m: None)
    asked = []

    def fetch(creator, source: str, row, target: Path):
        asked.append(source)
        raise PermanentError("404")

    monkeypatch.setattr(downloader, "_fetch", fetch)
    downloader.creator(CID)
    downloader.creator(CID)
    assert asked == ["pawchive"]
    row = ctx.db.one("SELECT state, error FROM files")
    assert row is not None and (row["state"], row["error"]) == ("failed", "Pawchive 404")
    assert post_rows(ctx, CID)[0]["head"]["k"] == "failed"
    downloader.creator(CID, post_ids=["1"])
    assert asked == ["pawchive", "pawchive"]


def test_filtered_posts_are_not_counted_as_waiting(ctx: Context):
    add_creator(ctx)
    entries = pawchive_entries(None, [{"name": "a.png", "path": "/a/" + "a" * 64 + ".png"}])
    obs(ctx, "1", "pawchive", "full", "2020-01-01T00:00:00", entries, title="【支援者様】お知らせ")
    obs(ctx, "2", "pawchive", "full", "2020-01-02T00:00:00", entries, title="新作")
    reconcile(ctx)
    assert next(c for c in creators(ctx) if c["id"] == CID)["fetchable"] == 2
    ctx.db.run("UPDATE creators SET filter=?", ('{"exclude_keywords": ["支援者様"]}',))
    assert next(c for c in creators(ctx) if c["id"] == CID)["fetchable"] == 1


def test_pawchive_html_becomes_fanbox_plain_text():
    html = "<p>日頃より</p><p>前回</p><p><br></p><p>・a&amp;b</p>"
    assert plain_text(html) == "日頃より\n前回\n\n・a&b"
    assert plain_text("plain\nlines") == "plain\nlines"


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


def test_a_short_listing_is_read_again_before_posts_go(
    ctx: Context, monkeypatch: pytest.MonkeyPatch
):
    add_creator(ctx)
    for pid in ("1", "2", "3"):
        obs(ctx, pid, "fanbox", "open", "2020-01-01T00:00:00", [], detail=True)
    reads: list[list[str]] = []

    def listing(handle: str) -> list[FanboxListItem]:
        return [
            FanboxListItem(p, "t", 0, "2020-01-01T00:00:00", "", False, "", "", "")
            for p in reads.pop(0)
        ]

    def states() -> dict[str, str]:
        return {r["post_id"]: r["state"] for r in ctx.db.all("SELECT post_id, state FROM post_obs")}

    monkeypatch.setattr(ctx.fanbox, "creator_id_of", lambda user_id: "intokuinfo")
    monkeypatch.setattr(ctx.fanbox, "list_posts", listing)

    def sync():
        sync_creator(
            ctx, CID, lambda *_: None, threading.Event(), sources=("fanbox",), details=False
        )

    # Two reads that disagree: a truncated page, so nothing is marked gone.
    reads[:] = [["1"], ["1", "2"]]
    sync()
    assert states() == {"1": "open", "2": "open", "3": "open"}
    # Two reads that agree: post 3 really was deleted.
    reads[:] = [["1", "2"], ["1", "2"]]
    sync()
    assert states() == {"1": "open", "2": "open", "3": "gone"}
    assert not reads


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
    # Adopted files are Fanbox's own and shown as such; the record still says adopted.
    assert row["head"]["k"] == "done" and row["via"] == ["fanbox"]
    kept = ctx.db.one("SELECT via FROM files WHERE post_id='468036' AND state='done'")
    assert kept is not None and kept["via"] == "adopted"


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


def test_a_worker_outlives_a_locked_database(ctx: Context, monkeypatch: pytest.MonkeyPatch):
    runner = JobRunner(ctx, 1)
    claim = runner._claim
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] == 1:
            raise sqlite3.OperationalError("database is locked")
        return claim()

    monkeypatch.setattr(runner, "_claim", flaky)
    monkeypatch.setitem(runner.handlers, "subscriptions", lambda *_: "ran")
    monkeypatch.setattr("app.engine.jobs.traceback.print_exc", lambda: None)
    worker = threading.Thread(target=runner._loop, daemon=True)
    worker.start()
    job = runner.enqueue("subscriptions")
    status = None
    for _ in range(300):
        row = ctx.db.one("SELECT status FROM jobs WHERE id=?", (job,))
        status = row["status"] if row else None
        if status == "done":
            break
        runner._wake.set()
        time.sleep(0.05)
    runner._stop.set()
    runner._wake.set()
    # The first claim failed; the worker carried on and ran the job.
    assert calls["n"] >= 2
    assert status == "done"


def test_norm_title_ignores_width_and_punctuation():
    assert norm_title("ＡＢＣ（縦3840 横2160）") == norm_title("abc(縦3840横2160)")
