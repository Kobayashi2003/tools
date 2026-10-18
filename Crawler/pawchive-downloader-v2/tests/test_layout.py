import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import server as server_module
from app.domain.match import fanbox_entries, pawchive_entries
from app.domain.timefmt import now_utc
from app.engine.context import Context
from app.library.layout import clean_group, move_creator, regrouped
from app.library.migrate import execute_adopt, plan_adopt
from app.store.db import load

from .test_engine import CID, add_creator, fanbox_post, obs, png, reconcile


def _post(ctx: Context, post_id: str, folder: Path, files: dict[str, bytes]):
    folder.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        (folder / name).write_bytes(data)
    ctx.db.run(
        "INSERT INTO posts(creator_id, post_id, title, published, local_dir, local_done, first_seen) "
        "VALUES(?, ?, 't', '2020-01-01T00:00:00', ?, 1, ?)",
        (CID, post_id, str(folder), now_utc()),
    )


def _local_dir(ctx: Context, post_id: str) -> str:
    row = ctx.db.one("SELECT local_dir FROM posts WHERE post_id=?", (post_id,))
    assert row is not None
    return row["local_dir"]


def test_group_paths_are_cleaned_and_renamed_by_prefix():
    assert clean_group(" 絵師\\ロリメイン / T0/ ") == "絵師/ロリメイン/T0"
    assert regrouped("絵師/動画メイン", "絵師", "自炊") == "自炊/動画メイン"
    assert regrouped("絵師", "絵師", "") == ""
    # A sibling whose name merely starts the same is not inside the group.
    assert regrouped("絵師2/x", "絵師", "自炊") is None


def test_moving_a_creator_moves_its_folder_and_what_points_into_it(ctx: Context, tmp_path: Path):
    add_creator(ctx)
    creator = ctx.creator(CID)
    assert creator is not None
    old = ctx.creator_dir(creator)
    _post(ctx, "1", old / "[2020.01.01][1] t", {"0.png": b"a"})
    adopted = tmp_path / "J" / "fanbox" / "[2020.01.01][2] t"
    _post(ctx, "2", adopted, {"0.png": b"b"})

    note = move_creator(ctx, CID, "絵師/ロリメイン")

    new = ctx.creator_dir(creator, "絵師/ロリメイン")
    assert note == "moved to 絵師/ロリメイン"
    assert (new / "[2020.01.01][1] t" / "0.png").read_bytes() == b"a"
    assert _local_dir(ctx, "1") == str(new / "[2020.01.01][1] t")
    # Folders outside the creator folder stay, and so do their records.
    assert _local_dir(ctx, "2") == str(adopted) and adopted.is_dir()
    # The emptied group folder goes; the download folder itself stays.
    downloads = Path(ctx.settings.download_dir)
    assert not (downloads / "大量欠落").exists() and downloads.is_dir()
    row = ctx.creator(CID)
    assert row is not None and row["group_path"] == "絵師/ロリメイン"


def test_a_move_into_an_existing_folder_never_overwrites(ctx: Context):
    add_creator(ctx)
    creator = ctx.creator(CID)
    assert creator is not None
    post = "[2020.01.01][1] t"
    _post(ctx, "1", ctx.creator_dir(creator) / post, {"0.png": b"old", "1.png": b"only here"})
    dst = ctx.creator_dir(creator, "絵師") / post
    dst.mkdir(parents=True)
    (dst / "0.png").write_bytes(b"already there")

    note = move_creator(ctx, CID, "絵師")

    assert "1 items left" in note
    assert (dst / "0.png").read_bytes() == b"already there"
    assert (dst / "1.png").read_bytes() == b"only here"
    assert (ctx.creator_dir(creator) / post / "0.png").read_bytes() == b"old"


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("FANBOX_SESSID", raising=False)
    monkeypatch.delenv("PAWCHIVE_DOWNLOAD_DIR", raising=False)
    app = server_module.create_app(tmp_path / "data", start_engine=False)
    ctx: Context = app.state.ctx
    ctx.store.save({"download_dir": str(tmp_path / "downloads")})
    ctx.reload_settings()
    for i, (alias, group) in enumerate([("a", "絵師/動画"), ("b", "絵師/動画/T0"), ("c", "自炊")]):
        ctx.db.run(
            "INSERT INTO creators(id, service, user_id, name, alias, group_path, added_at) "
            "VALUES(?, 'fanbox', ?, ?, ?, ?, ?)",
            (f"fanbox_{i}", str(i), alias, alias, group, now_utc()),
        )
    with TestClient(app) as c:
        yield c, ctx


def _queued(ctx: Context) -> dict[str, str]:
    rows = ctx.db.all("SELECT creator_id, params FROM jobs WHERE kind='move'")
    return {r["creator_id"]: json.loads(r["params"])["group"] for r in rows}


def test_moving_a_group_queues_every_creator_inside_it(client):
    c, ctx = client
    res = c.post("api/groups/move", json={"from": "絵師/動画", "to": "自炊/動画"})
    assert res.status_code == 200 and len(res.json()["jobs"]) == 2
    assert _queued(ctx) == {"fanbox_0": "自炊/動画", "fanbox_1": "自炊/動画/T0"}

    assert c.post("api/groups/move", json={"from": "絵師", "to": "絵師/動画/x"}).status_code == 400


def test_a_destination_another_creator_owns_is_refused(client):
    c, ctx = client
    ctx.db.run("UPDATE creators SET alias='a' WHERE id='fanbox_2'")
    res = c.post("api/creators/fanbox_2/move", json={"group": "絵師/動画"})
    assert res.status_code == 409 and "fanbox_0" in res.json()["detail"]
    assert c.get("api/creators/fanbox_2/move", params={"group": "絵師/動画"}).status_code == 409
    assert not _queued(ctx)
    # Saving the same group and alias is not a move.
    assert c.patch("api/creators/fanbox_2", json={"group": "自炊/"}).json()["job"] is None


def test_a_file_no_source_lists_is_shifted_once(ctx: Context):
    add_creator(ctx)
    entries = pawchive_entries(None, [{"name": "a.png", "path": "/a/" + "a" * 64 + ".png"}])
    obs(ctx, "1", "pawchive", "full", "2020-01-01T00:00:00", entries)
    reconcile(ctx)
    ctx.db.run("UPDATE files SET state='done'")
    obs(
        ctx,
        "1",
        "pawchive",
        "full",
        "2020-01-01T00:00:00",
        pawchive_entries(None, [{"name": "b.png", "path": "/b/" + "b" * 64 + ".png"}]),
    )
    for _ in range(3):
        reconcile(ctx)
    row = ctx.db.one("SELECT ordinal FROM files WHERE key='n:a.png'")
    assert row is not None and row["ordinal"] == 10_000


def test_an_adopted_file_that_fails_its_check_stays_to_download(ctx: Context, tmp_path: Path):
    add_creator(ctx)
    images = [{"id": "Hk2p", "extension": "png", "width": 3000, "height": 2000, "originalUrl": "u"}]
    obs(
        ctx,
        "5",
        "fanbox",
        "open",
        "2020-01-01T12:00:00",
        fanbox_entries(fanbox_post(images)),
        title="大判",
        fee=1100,
        detail=True,
    )
    reconcile(ctx)
    folder = tmp_path / "root" / "fanbox" / "1100" / "[2020.01.01] 大判"
    folder.mkdir(parents=True)
    (folder / "0.jpeg").write_bytes(b"\xff\xd8cover")
    png(folder / "1.png", 300, 200)  # a preview, not the original

    plan_id = plan_adopt(ctx, CID, tmp_path / "root", 0)
    plan = ctx.db.one("SELECT items FROM migrations WHERE id=?", (plan_id,))
    assert plan is not None and load(plan["items"])[0]["verified"]["bad"] == 1
    execute_adopt(ctx, plan_id)
    states = {r["key"]: r["state"] for r in ctx.db.all("SELECT key, state FROM files")}
    assert states == {"cover": "done", "n:Hk2p.png": "pending"}
    post = ctx.db.one("SELECT local_done, origin FROM posts WHERE post_id='5'")
    assert post is not None and (post["local_done"], post["origin"]) == (0, "adopted")
