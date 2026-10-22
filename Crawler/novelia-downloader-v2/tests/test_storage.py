from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.server import create_app
from tests.conftest import KEY


@pytest.fixture
def library(tmp_path):
    root = tmp_path / "downloads"
    app = create_app(tmp_path / "data", root, start_worker=False)
    db = app.state.db
    db.save_work(KEY, {"title": "Test", "volumeJp": [{"volumeId": "v"}]}, 1)
    source = root / "book" / "v.epub"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"source")
    db.save_file(KEY, "v", "jp-zh", "hash", source, 6, "digest")
    with TestClient(app) as client:
        yield client, db, source, tmp_path


@pytest.mark.parametrize("delete_files", [False, True])
def test_remove_choice(library, delete_files):
    client, db, source, _ = library
    result = client.post("/api/library/remove", json={"keys": [KEY], "delete_files": delete_files})
    assert result.json()["removed"] == 1
    assert source.exists() is not delete_files
    assert not db.rows("SELECT * FROM files")
    assert not db.rows("SELECT * FROM works")


@pytest.mark.parametrize("delete_files", [False, True])
def test_remove_after_files_deleted_manually(library, delete_files):
    client, db, source, _ = library
    edition = source.with_name("ja.epub")
    reference = source.with_name("reference.epub")
    edition.write_bytes(b"ja")
    reference.write_bytes(b"reference")
    db.execute("UPDATE files SET ja_path=?,reference_path=?", (str(edition), str(reference)))
    for path in (source, edition, reference):
        path.unlink()
    assert client.get(f"/api/works/{KEY}").status_code == 200
    result = client.post("/api/library/remove", json={"keys": [KEY], "delete_files": delete_files})
    assert result.status_code == 200 and result.json()["removed"] == 1
    assert not db.rows("SELECT * FROM works")
    assert not db.rows("SELECT * FROM files")
    assert client.post("/api/library/remove", json={"keys": [KEY]}).json()["removed"] == 0


def test_forgetting_missing_files_keeps_works_and_what_is_on_disk(library):
    client, db, source, root = library
    edition = root / "downloads" / "ja.epub"
    edition.write_bytes(b"ja")
    db.execute("UPDATE files SET ja_path=?", (str(edition),))
    assert client.get("/api/library/missing").json()["items"] == []
    source.unlink()
    # The converted edition is still on disk, so the record stays.
    assert client.get("/api/library/missing").json()["items"] == []
    edition.unlink()
    assert client.get("/api/library/missing?keys=wenku/" + "b" * 24).json()["items"] == []
    [work] = client.get(f"/api/library/missing?keys={KEY}").json()["items"]
    assert (work["key"], work["files"][0]["record"], work["files"][0]["editions"]) == (
        KEY,
        True,
        ["ja"],
    )
    # A file restored after the check is kept.
    source.write_bytes(b"restored")
    assert client.post("/api/library/forget-missing", json={}).json() == {
        "records": 0,
        "editions": 1,
    }
    assert db.row("SELECT ja_path FROM files")["ja_path"] is None
    source.unlink()
    assert client.post("/api/library/forget-missing", json={"keys": [KEY]}).json()["records"] == 1
    assert not db.rows("SELECT * FROM files")
    assert db.row("SELECT key FROM works")["key"] == KEY


def test_migration_and_persistence(library):
    client, db, source, root = library
    edition = source.with_name("ja.epub")
    edition.write_bytes(b"ja")
    db.execute("UPDATE files SET ja_path=?", (str(edition),))
    target = root / "new"
    result = client.put("/api/storage", json={"directory": str(target), "migrate": True})
    assert result.status_code == 200 and result.json()["migrated"] == 2
    assert not source.exists() and not edition.exists()
    assert client.get("/api/files/1/raw").content == b"source"
    assert client.get("/api/files/1/ja").content == b"ja"
    with TestClient(create_app(root / "data", root / "downloads", start_worker=False)) as restarted:
        assert restarted.get("/api/status").json()["download_root"] == str(target.resolve())
        assert restarted.get("/api/files/1/raw").content == b"source"


def test_no_migration_keeps_old_files_accessible(library):
    client, db, source, root = library
    target = root / "new"
    assert (
        client.put("/api/storage", json={"directory": str(target), "migrate": False}).status_code
        == 200
    )
    assert source.exists()
    assert client.get("/api/files/1/raw").content == b"source"
    assert (
        client.put("/api/storage", json={"directory": str(root / "third"), "migrate": True}).json()[
            "migrated"
        ]
        == 1
    )
    assert not source.exists()
    # Returning to a previously used directory is supported too.
    assert (
        client.put(
            "/api/storage", json={"directory": str(root / "downloads"), "migrate": True}
        ).json()["migrated"]
        == 1
    )
    assert source.exists()


def test_new_downloads_use_changed_directory(system, tmp_path):
    from app.schema import JobRequest
    from app.storage import Storage

    db, worker, upstream = system
    target = tmp_path / "changed"
    Storage(db, worker).change_directory(str(target), False)
    worker.run_job(db.create_job(JobRequest(kind="full")))
    assert Path(db.row("SELECT raw_path FROM files")["raw_path"]).is_relative_to(target)


def test_conflicts_and_failed_copy_preserve_sources(library, monkeypatch):
    client, db, source, root = library
    target = root / "new"
    dest = target / "book" / "v.epub"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"existing")
    assert client.put("/api/storage", json={"directory": str(target)}).status_code == 400
    assert dest.read_bytes() == b"existing" and source.exists()
    dest.unlink()

    def fail(*args):
        raise OSError("Disk full")

    monkeypatch.setattr("app.storage.shutil.copyfileobj", fail)
    assert client.put("/api/storage", json={"directory": str(target)}).status_code == 400
    assert not dest.exists() and source.exists()
    assert db.row("SELECT raw_path FROM files")["raw_path"] == str(source)


def test_boundaries_and_busy_tasks(library):
    client, db, source, root = library
    assert client.put("/api/storage", json={"directory": "relative"}).status_code == 400
    assert client.put("/api/storage", json={"directory": str(source.parent)}).status_code == 400
    outside = root / "secret.epub"
    outside.write_bytes(b"secret")
    db.execute("UPDATE files SET reference_path=?", (str(outside),))
    assert (
        client.post("/api/library/remove", json={"keys": [KEY], "delete_files": True}).status_code
        == 400
    )
    assert outside.exists() and source.exists()
    client.post("/api/jobs", json={"kind": "full"})
    assert client.post("/api/library/remove", json={"keys": [KEY]}).status_code == 409
    assert client.put("/api/storage", json={"directory": str(root / "new")}).status_code == 409


def test_chinese_uploads_are_hidden(library):
    client, db, _, root = library
    db.save_work(
        KEY,
        {
            "title": "Test",
            "volumeJp": [{"volumeId": "作品 2.epub"}],
            "volumeZh": ["作品 02（台）.epub", "作品 短篇集.epub"],
        },
        1,
    )
    db.execute("UPDATE files SET volume_id='作品 2.epub'")
    for name in ("作品 02（台）.epub", "作品 短篇集.epub"):
        path = root / "downloads" / "book" / name
        path.write_bytes(b"zh")
        db.save_file(KEY, name, "zh-original", "hash", path, 2, "digest")
    work = client.get("/api/works").json()["items"][0]
    assert (work["volume_count"], work["file_count"]) == (1, 1)  # complete, Chinese hidden
    detail = client.get(f"/api/works/{KEY}").json()
    assert [v["volume_id"] for v in detail["volumes"]] == ["作品 2.epub"]
    assert [f["mode"] for f in detail["files"]] == ["jp-zh"]
