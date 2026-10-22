from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.schema import JobRequest, Settings, normalize_key, parse_range
from app.server import ProcessLock, create_app
from app.worker import Worker
from tests.conftest import KEY


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path / "data", tmp_path / "downloads", start_worker=False)
    with TestClient(app) as client:
        yield client


def test_job_validation_and_cancellation(client):
    assert (
        client.post("/api/jobs", json={"kind": "range", "start_page": 3, "end_page": 2}).status_code
        == 422
    )
    assert (
        client.post(
            "/api/jobs", json={"kind": "manual", "keys": ["https://evil.example/wenku/abc"]}
        ).status_code
        == 422
    )
    result = client.post("/api/jobs", json={"kind": "full", "category": 5})
    assert result.status_code == 201
    job_id = result.json()["id"]
    job = client.get(f"/api/jobs/{job_id}").json()
    assert job["request"]["category"] == 1
    assert client.post(f"/api/jobs/{job_id}/cancel").status_code == 200
    assert client.post(f"/api/jobs/{job_id}/resume").status_code == 200
    assert client.post(f"/api/jobs/{job_id}/resume").status_code == 409


def test_retry_failed_items_and_start_paused_task(client):
    db = client.app.state.db
    job_id = client.post("/api/jobs", json={"kind": "manual", "keys": [KEY]}).json()["id"]
    assert client.post(f"/api/jobs/{job_id}/retry").status_code == 409  # still queued
    db.add_targets(job_id, [KEY])
    db.execute("UPDATE job_items SET status='failed',error='HTTP 500 after 3 attempts',retryable=1")
    db.execute("UPDATE jobs SET status='completed_with_errors' WHERE id=?", (job_id,))
    detail = client.get(f"/api/jobs/{job_id}").json()
    assert detail["items"][0]["retryable"] == 1 and detail["items"][0]["parts"] == {}
    assert client.post(f"/api/jobs/{job_id}/retry", json={"targets": [KEY]}).json() == {
        "retried": 1
    }
    assert client.get(f"/api/jobs/{job_id}").json()["status"] == "queued"
    db.execute("UPDATE jobs SET resume_at='2999-01-01T00:00:00+00:00' WHERE id=?", (job_id,))
    assert client.get("/api/status").json()["paused"]["id"] == job_id
    assert client.post(f"/api/jobs/{job_id}/resume").status_code == 200
    assert client.get(f"/api/jobs/{job_id}").json()["resume_at"] is None


def test_settings_validation(client):
    assert (
        client.put("/api/settings", json={"backoff_base": 60, "backoff_max": 30}).status_code == 422
    )
    assert (
        client.put(
            "/api/settings", json={"active_hours": True, "active_start": "25:00"}
        ).status_code
        == 422
    )
    assert (
        client.put("/api/settings", json={"request_delay": 40, "max_delay": 30}).status_code == 422
    )
    assert (
        client.put(
            "/api/settings", json={"request_delay": 40, "max_delay": 30, "adaptive_delay": False}
        ).status_code
        == 200
    )
    saved = client.put(
        "/api/settings", json={"active_hours": True, "active_start": "23:30", "rest_every": 20}
    )
    assert saved.status_code == 200 and saved.json()["active_end"] == "07:00"


def test_origin_and_host_protection(client):
    assert (
        client.post(
            "/api/jobs", json={"kind": "full"}, headers={"Origin": "https://evil.example"}
        ).status_code
        == 403
    )
    assert client.get("/api/status", headers={"Host": "evil.example"}).status_code == 400
    assert (
        client.post(
            "/api/jobs", json={"kind": "full"}, headers={"Origin": "http://testserver"}
        ).status_code
        == 201
    )


def test_settings_snapshot_and_csv(client):
    job_id = client.post("/api/jobs", json={"kind": "full"}).json()["id"]
    assert client.put("/api/settings", json={"request_delay": 2}).status_code == 200
    assert client.get(f"/api/jobs/{job_id}").json()["config"]["request_delay"] == 1
    db = client.app.state.db
    db.save_work(KEY, {"title": "=1+1", "authors": [], "volumeJp": [], "titleZh": "Test"}, 1)
    assert "'=1+1" in client.get("/api/export.csv").text
    assert client.get("/api/works?query=Test").json()["total"] == 1
    assert client.get(f"/api/works/{KEY}").json()["files"] == []


def test_catalog_marks_local_works(client, monkeypatch):
    class Catalog:
        def __init__(self, *_, **__):
            pass

        def listing(self, page, category, query):
            return {"items": [{"id": KEY.split("/")[1]}], "pageNumber": 1}

        def close(self):
            pass

    monkeypatch.setattr("app.server.Client", Catalog)
    db = client.app.state.db
    db.save_work(
        KEY, {"title": "T", "volumeJp": [{"volumeId": "v.epub"}], "volumeZh": ["zh.epub"]}, 1
    )
    local = client.get("/api/catalog").json()["items"][0]["local"]
    assert (local["volume_count"], local["file_count"]) == (1, 0)


def test_work_detail_marks_unavailable_formats_and_decodes_entities(client):
    db = client.app.state.db
    volume = {"volumeId": "v1.epub", "total": 3}
    db.save_work(
        KEY,
        {"title": "T", "authors": [], "introduction": "大赏&lt；银赏&gt；", "volumeJp": [volume]},
        1,
    )
    stamp = Worker.stamp(volume, "jp-original", Settings())
    db.mark_unavailable(KEY, "v1.epub", "jp-original", stamp, "Empty.", 1)
    work = client.get(f"/api/works/{KEY}").json()
    assert work["metadata"]["introduction"] == "大赏<；银赏>；"
    assert work["volumes"][0]["unavailable"] == {"jp-original": "Empty."}
    db.mark_unavailable(KEY, "v1.epub", "jp-original", "an older upload", "Empty.", 1)
    assert client.get(f"/api/works/{KEY}").json()["volumes"][0]["unavailable"] == {}


def test_catalog_works_open_live_without_joining_the_library(client, monkeypatch):
    class Live:
        def __init__(self, *_, **__):
            pass

        def metadata(self, key):
            return {"title": "Live", "level": "一般向", "volumeJp": [{"volumeId": "v.epub"}]}

        def close(self):
            pass

    monkeypatch.setattr("app.server.Client", Live)
    assert client.get(f"/api/works/{KEY}").status_code == 404
    work = client.get(f"/api/works/{KEY}?live=true").json()
    assert (work["title"], work["local"], work["category"]) == ("Live", False, 1)
    assert [v["volume_id"] for v in work["volumes"]] == ["v.epub"]
    assert work["strategy"]["editions"] == Settings().editions
    assert client.get("/api/works").json()["total"] == 0


def test_open_reports_a_deleted_file_and_keeps_its_record(client, tmp_path, monkeypatch):
    opened = []
    monkeypatch.setattr("app.server.open_path", opened.append)
    db = client.app.state.db
    db.save_work(KEY, {"title": "T", "volumeJp": [{"volumeId": "v"}]}, 1)
    path = tmp_path / "downloads" / "Bilingual" / "work" / "v.epub"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"epub")
    db.save_file(KEY, "v", "jp-zh", "hash", path, 4, "digest")
    assert client.post("/api/files/1/raw/open").json()["opened"]
    [folder] = client.get(f"/api/works/{KEY}").json()["folders"]
    assert folder["name"] == "Bilingual"
    assert (
        client.post(f"/api/works/{KEY}/folder", json={"folder": folder["path"]}).status_code == 200
    )
    outside = {"folder": str(tmp_path)}
    assert client.post(f"/api/works/{KEY}/folder", json=outside).status_code == 404
    assert opened == [path.resolve(), path.parent.resolve()]
    assert client.post("/api/files/1/forget").status_code == 409  # still on disk
    path.unlink()
    result = client.post("/api/files/1/raw/open").json()
    assert (result["opened"], result["missing"]) == (False, True)
    assert db.row("SELECT id FROM files")  # still recorded as downloaded
    assert client.post("/api/files/1/forget").json() == {"records": 1, "editions": 0}
    assert not db.rows("SELECT * FROM files")


def test_file_delivery_rejects_outside_root(client, tmp_path):
    db = client.app.state.db
    db.save_work(KEY, {"title": "Test", "authors": [], "volumeJp": []}, 1)
    outside = tmp_path / "secret.epub"
    outside.write_bytes(b"secret")
    db.save_file(KEY, "v.epub", "jp-zh", "hash", outside, 6, "digest")
    assert client.get("/api/files/1/raw").status_code == 404
    assert client.get("/api/files/1/ja").status_code == 404
    assert client.get("/api/files/1/other").status_code == 404


def test_process_lock_prevents_multiple_workers(tmp_path):
    a, b = ProcessLock(tmp_path / "lock"), ProcessLock(tmp_path / "lock")
    a.acquire()
    try:
        with pytest.raises(RuntimeError):
            b.acquire()
    finally:
        a.release()
    b.acquire()
    b.release()


def test_url_and_range_validation():
    assert normalize_key("https://n.novelia.cc/" + KEY + "?x=1") == KEY
    assert parse_range("1,3,5-8", 6) == [1, 3, 5, 6]
    with pytest.raises(ValueError):
        parse_range("5-3", 6)
    with pytest.raises(ValueError):
        JobRequest(kind="full", volumes="1")


def test_library_filters_and_task_removal(client):
    db = client.app.state.db
    db.save_work(
        KEY,
        {"title": "Alpha", "authors": [], "volumeJp": [{"volumeId": "a"}, {"volumeId": "b"}]},
        1,
    )
    db.save_file(KEY, "a", "jp-zh", "hash", Path("a.epub"), 1, "digest")
    assert client.get("/api/works?state=partial").json()["total"] == 1
    item = client.get("/api/works?state=bilingual").json()["items"][0]
    assert (item["bilingual_count"], item["ja_count"], item["zh_count"]) == (1, 0, 0)
    db.save_original(KEY, "a", "hash", Path("a [jp-original].epub"), 1, "digest")
    assert client.get("/api/works?state=japanese").json()["items"][0]["ja_count"] == 1
    assert client.get("/api/works?sort=title_zh").status_code == 200
    assert client.get("/api/works?state=metadata").json()["total"] == 0
    assert client.get("/api/works?sort=title").status_code == 200
    assert client.get("/api/works?state=bogus").status_code == 422
    assert client.get("/api/status").json()["files"] == 2
    job_id = client.post("/api/jobs", json={"kind": "full"}).json()["id"]
    assert client.delete(f"/api/jobs/{job_id}").status_code == 409
    db.execute("UPDATE jobs SET status='completed' WHERE id=?", (job_id,))
    db.log(job_id, "done")
    assert client.post("/api/jobs/clear").json()["removed"] == 1
    assert client.get(f"/api/jobs/{job_id}").status_code == 404


def test_retry_while_running_only_temporary(client):
    db = client.app.state.db
    other = "wenku/688da4c4c923db0b7aa9943f"
    job_id = client.post("/api/jobs", json={"kind": "manual", "keys": [KEY, other]}).json()["id"]
    db.add_targets(job_id, [KEY, other])
    db.execute("UPDATE jobs SET status='running' WHERE id=?", (job_id,))
    db.execute("UPDATE job_items SET status='failed',retryable=(target=?)", (KEY,))
    response = client.post(f"/api/jobs/{job_id}/retry", json={"only_retryable": True})
    assert response.json() == {"retried": 1}
    assert client.get(f"/api/jobs/{job_id}").json()["status"] == "running"
    statuses = {r["target"]: r["status"] for r in db.rows("SELECT * FROM job_items")}
    assert statuses == {KEY: "pending", other: "failed"}


def test_log_pages_open_on_latest_lines_and_filter_problems(client):
    db = client.app.state.db
    job_id = client.post("/api/jobs", json={"kind": "full"}).json()["id"]
    for index in range(700):
        db.log(job_id, f"line {index}", "error" if index % 100 == 0 else "info")
    latest = client.get(f"/api/jobs/{job_id}").json()
    assert latest["logs"][-1]["message"] == "line 699" and len(latest["logs"]) == 300
    assert latest["log_earlier"] is True
    earlier = client.get(f"/api/jobs/{job_id}?before={latest['logs'][0]['id']}").json()
    assert earlier["logs"][-1]["id"] == latest["logs"][0]["id"] - 1
    newer = client.get(f"/api/jobs/{job_id}?after={latest['logs'][-2]['id']}").json()
    assert [line["message"] for line in newer["logs"]] == ["line 699"]
    problems = client.get(f"/api/jobs/{job_id}?problems=true").json()
    assert [line["message"] for line in problems["logs"]] == [
        f"line {i}" for i in range(0, 700, 100)
    ]
    assert problems["log_earlier"] is False
