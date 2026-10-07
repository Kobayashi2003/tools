import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.client import Deferred, Rejected
from app.database import Database
from app.schema import JobRequest, Settings
from app.worker import window_opens
from tests.conftest import KEY, epub


def run(db, worker, **kwargs):
    job = db.create_job(JobRequest(**kwargs))
    worker.run_job(job)
    return db.job(job)


def test_full_then_incremental_detects_old_work_new_and_changed_volumes(system):
    db, worker, upstream = system
    assert run(db, worker, kind="full")["status"] == "completed"
    assert len(upstream.downloads) == 1
    assert run(db, worker, kind="incremental")["status"] == "completed"
    assert len(upstream.downloads) == 1
    upstream.works[KEY]["volumeJp"].append({"volumeId": "volume2.epub", "sakura": 5})
    upstream.works[KEY]["volumeJp"][0]["sakura"] = 11
    run(db, worker, kind="incremental")
    assert len(upstream.downloads) == 3
    assert len(db.rows("SELECT * FROM files")) == 2
    assert len(upstream.checked) == 3
    assert db.setting("last_incremental_at")


def test_listing_resume_does_not_skip_failed_page(system):
    db, worker, upstream = system
    second = "wenku/688da4c4c923db0b7aa9943f"
    upstream.pages[2] = [second]
    upstream.works[second] = {**upstream.works[KEY], "title": "Second"}
    upstream.fail_page = 2
    job = run(db, worker, kind="full")
    assert job["status"] == "failed" and job["cursor"] == 2
    assert len(db.rows("SELECT * FROM job_items")) == 1
    upstream.fail_page = None
    db.resume(job["id"])
    worker.run_job(job["id"])
    assert db.job(job["id"])["status"] == "completed"
    assert upstream.listed == [(1, 1), (2, 1), (2, 1)]
    assert len(db.rows("SELECT * FROM works")) == 2


def test_partial_volume_failure_reuses_success_on_resume(system):
    db, worker, upstream = system
    upstream.works[KEY]["volumeJp"].append({"volumeId": "volume2.epub"})
    upstream.fail_volume = "volume2.epub"
    job = run(db, worker, kind="manual", keys=[KEY])
    assert job["status"] == "completed_with_errors"
    upstream.fail_volume = None
    db.resume(job["id"])
    worker.run_job(job["id"])
    assert db.job(job["id"])["status"] == "completed"
    assert [d[1] for d in upstream.downloads] == ["volume1.epub", "volume2.epub"]


def test_cancel_preserves_sources_and_resumes_pending_work(system):
    db, worker, upstream = system
    upstream.works[KEY]["volumeJp"].append({"volumeId": "volume2.epub"})
    upstream.cancel_volume = "volume2.epub"
    job = run(db, worker, kind="full")
    assert job["status"] == "cancelled"
    assert db.row("SELECT status FROM job_items")["status"] == "pending"
    upstream.cancel_volume = None
    db.resume(job["id"])
    worker.run_job(job["id"])
    assert db.job(job["id"])["status"] == "completed"
    assert len(upstream.downloads) == 2


def test_bulk_conversion_restores_css_verifies_and_keeps_source(system):
    db, worker, upstream = system
    run(db, worker, kind="full")
    assert run(db, worker, kind="convert")["status"] == "completed"
    file = db.row("SELECT * FROM files")
    assert file["verification"] == "verified"
    assert Path(file["raw_path"]).exists()
    assert Path(file["ja_path"]).exists()
    report = json.loads(file["report"])
    assert report["kept_ja"] == 1 and report["dropped_zh"] == 1 and report["restored_css"] == 1
    run(db, worker, kind="convert")
    assert len(upstream.downloads) == 2


def test_missing_reference_is_not_reported_as_verified(system):
    db, worker, upstream = system
    run(db, worker, kind="full")
    upstream.fail_reference = True
    assert run(db, worker, kind="convert")["status"] == "completed_with_errors"
    file = db.row("SELECT * FROM files")
    assert file["verification"] == "unverified"
    assert "UNVERIFIED" in file["ja_path"]
    assert Path(file["raw_path"]).exists()


def test_mismatch_preserves_raw_and_marks_output(system):
    db, worker, upstream = system
    run(db, worker, kind="full")
    epub(upstream.original, False, paragraph="違う日本語")
    assert run(db, worker, kind="convert")["status"] == "completed_with_errors"
    file = db.row("SELECT * FROM files")
    assert file["verification"] == "unverified"
    assert "differ" in json.loads(file["report"])["verification_detail"]


def test_category_guard_and_metadata_only(system):
    db, worker, upstream = system
    upstream.works[KEY]["level"] = "轻文学"
    run(db, worker, kind="full")
    assert not upstream.downloads
    assert db.row("SELECT category FROM works")["category"] == 2
    run(db, worker, kind="manual", keys=[KEY], download=False)
    assert not upstream.downloads
    run(db, worker, kind="manual", keys=[KEY])
    assert len(upstream.downloads) == 1


def test_recovery_and_schedule_do_not_duplicate_running_sweep(system):
    db, worker, upstream = system
    db.set_setting("config", Settings(incremental_enabled=True).model_dump())
    worker.schedule()
    worker.schedule()
    assert len(db.rows("SELECT * FROM jobs")) == 1
    job = db.row("SELECT * FROM jobs")
    db.execute("UPDATE jobs SET status='running' WHERE id=?", (job["id"],))
    db.add_targets(job["id"], [KEY])
    db.execute("UPDATE job_items SET status='running'")
    db.recover()
    assert db.job(job["id"])["status"] == "interrupted"
    assert db.row("SELECT status FROM job_items")["status"] == "pending"
    db.set_setting("next_incremental_at", None)
    worker.schedule()
    assert len(db.rows("SELECT * FROM jobs")) == 1


def test_range_and_volume_selection(system):
    db, worker, upstream = system
    upstream.pages = {1: [], 2: [KEY], 3: [KEY]}
    upstream.works[KEY]["volumeJp"] = [{"volumeId": "v10.epub"}, {"volumeId": "v2.epub"}, {"volumeId": "v1.epub"}]
    run(db, worker, kind="range", start_page=2, end_page=2, volumes="2")
    assert upstream.listed == [(2, 1)]
    assert [d[1] for d in upstream.downloads] == ["v2.epub"]


def test_changed_source_invalidates_converted_output(system):
    db, worker, upstream = system
    run(db, worker, kind="full")
    run(db, worker, kind="convert")
    upstream.works[KEY]["volumeJp"][0]["sakura"] += 1
    run(db, worker, kind="incremental")
    file = db.row("SELECT * FROM files")
    assert file["ja_path"] is None and file["verification"] is None


def test_web_manual_and_chinese_uploads(system):
    db, worker, upstream = system
    web = "alphapolis/159124863-713069479"
    upstream.works[web] = {"titleJp": "Web novel", "toc": [{"titleJp": "Chapter", "chapterId": "1"}], "jp": 1}
    upstream.works[KEY]["volumeZh"] = ["chinese.epub"]
    run(db, worker, kind="manual", keys=[KEY, web])
    assert len(db.rows("SELECT * FROM files")) == 3
    assert db.row("SELECT * FROM files WHERE mode='zh-original'")
    run(db, worker, kind="convert")
    assert len([d for d in upstream.downloads if d[2]]) == 3


def test_convert_by_work_keys(system):
    db, worker, upstream = system
    job = run(db, worker, kind="convert", keys=[KEY])
    assert job["status"] == "failed" and "no bilingual files" in job["error"]
    run(db, worker, kind="full")
    assert run(db, worker, kind="convert", keys=[KEY])["status"] == "completed"
    assert db.row("SELECT verification FROM files")["verification"] == "verified"


def configure(db, **values):
    db.set_setting("config", Settings(**values).model_dump())


def add_volumes(upstream, *names):
    upstream.works[KEY]["volumeJp"] += [{"volumeId": name} for name in names]


def test_transient_failures_are_retried_automatically(system):
    db, worker, upstream = system
    add_volumes(upstream, "volume2.epub")
    upstream.fail_times["volume2.epub"] = 2
    job = run(db, worker, kind="manual", keys=[KEY])
    assert job["status"] == "completed"
    assert [d[1] for d in upstream.downloads] == ["volume1.epub", "volume2.epub"]
    assert [w[0] for w in upstream.waits] == [60, 120]
    assert db.row("SELECT attempts FROM job_items")["attempts"] == 3


def test_permanent_failures_are_not_retried_automatically(system):
    db, worker, upstream = system
    upstream.raise_on["volume1.epub"] = Rejected("HTTP 404: not found on Novelia.")
    job = run(db, worker, kind="manual", keys=[KEY])
    assert job["status"] == "completed_with_errors" and not upstream.waits
    item = db.row("SELECT * FROM job_items")
    assert item["retryable"] == 0 and "404" in item["error"]
    assert "volume1.epub" in json.loads(item["parts"])["failed"]


def test_forced_retry_skips_volumes_that_already_succeeded(system):
    db, worker, upstream = system
    configure(db, retry_rounds=0)
    add_volumes(upstream, "volume2.epub")
    upstream.fail_volume = "volume2.epub"
    job = run(db, worker, kind="manual", keys=[KEY], force=True)
    assert job["status"] == "completed_with_errors"
    upstream.fail_volume = None
    assert db.retry(job["id"]) == 1
    worker.run_job(job["id"])
    assert db.job(job["id"])["status"] == "completed"
    assert [d[1] for d in upstream.downloads] == ["volume1.epub", "volume2.epub"]


def test_retry_selected_targets_only(system):
    db, worker, upstream = system
    configure(db, retry_rounds=0)
    other = "wenku/688da4c4c923db0b7aa9943f"
    upstream.works[other] = {**upstream.works[KEY], "volumeJp": [{"volumeId": "other.epub"}]}
    upstream.fail_volume = "volume1.epub"
    upstream.raise_on["other.epub"] = Rejected("HTTP 404: not found on Novelia.")
    job = run(db, worker, kind="manual", keys=[KEY, other])
    upstream.fail_volume = None
    assert db.retry(job["id"], [KEY]) == 1
    worker.run_job(job["id"])
    statuses = {r["target"]: r["status"] for r in db.rows("SELECT * FROM job_items")}
    assert statuses == {KEY: "done", other: "failed"}
    assert db.job(job["id"])["status"] == "completed_with_errors"


def test_rate_limit_pause_requeues_and_resumes_later(system):
    db, worker, upstream = system
    add_volumes(upstream, "volume2.epub")
    later = datetime.now(timezone.utc) + timedelta(minutes=30)
    upstream.raise_on["volume2.epub"] = Deferred("Rate limited.", later)
    job = run(db, worker, kind="manual", keys=[KEY])
    assert job["status"] == "queued" and job["resume_at"] and job["pauses"] == 1
    assert db.row("SELECT status FROM job_items")["status"] == "pending"
    assert db.next_job() is None
    db.resume(job["id"])  # "Start now"
    assert db.next_job()["id"] == job["id"]
    upstream.raise_on.clear()
    worker.run_job(job["id"])
    assert db.job(job["id"])["status"] == "completed"
    assert [d[1] for d in upstream.downloads] == ["volume1.epub", "volume2.epub"]


def test_repeated_rate_limit_pauses_give_up(system):
    db, worker, upstream = system
    configure(db, max_pauses=1)
    upstream.raise_on["volume1.epub"] = Deferred("Rate limited.", datetime.now(timezone.utc))
    job = run(db, worker, kind="manual", keys=[KEY])
    assert job["status"] == "queued"
    worker.run_job(job["id"])
    job = db.job(job["id"])
    assert job["status"] == "failed" and "Gave up" in job["error"]


def test_active_hours_window():
    config = Settings(active_hours=True, active_start="23:00", active_end="06:00")
    noon = datetime(2026, 1, 1, 12, 0).astimezone()
    assert window_opens(config, noon).hour == 23
    assert window_opens(config, noon.replace(hour=2)) is None
    assert window_opens(Settings(), noon) is None
    office = Settings(active_hours=True, active_start="09:00", active_end="17:00")
    assert window_opens(office, noon.replace(hour=18)).day == 2


def test_outside_active_hours_defers_without_counting_a_pause(system, monkeypatch):
    db, worker, upstream = system
    opens = datetime.now(timezone.utc) + timedelta(hours=3)
    monkeypatch.setattr("app.worker.window_opens", lambda config: opens)
    job = run(db, worker, kind="manual", keys=[KEY])
    assert job["status"] == "queued" and job["pauses"] == 0 and not upstream.downloads


def test_start_now_overrides_active_hours(system, monkeypatch):
    db, worker, upstream = system
    monkeypatch.setattr("app.worker.window_opens", lambda config: datetime.now(timezone.utc) + timedelta(hours=3))
    job = run(db, worker, kind="manual", keys=[KEY])
    assert job["status"] == "queued"
    db.resume(job["id"])
    worker.run_job(job["id"])
    assert db.job(job["id"])["status"] == "completed" and upstream.downloads


def test_retry_rounds_are_not_restarted_by_an_automatic_pause(system):
    db, worker, upstream = system
    upstream.fail_volume = "volume1.epub"
    job = run(db, worker, kind="manual", keys=[KEY])
    assert job["retry_round"] == 2 and len(upstream.waits) == 2
    db.execute("UPDATE job_items SET status='pending'")
    db.execute("UPDATE jobs SET status='queued' WHERE id=?", (job["id"],))  # as after an automatic pause
    worker.run_job(job["id"])
    assert len(upstream.waits) == 2
    db.retry(job["id"])  # a manual retry grants fresh rounds
    assert db.job(job["id"])["retry_round"] == 0


def test_chinese_uploads_can_be_skipped(system):
    db, worker, upstream = system
    configure(db, download_chinese_uploads=False)
    upstream.works[KEY]["volumeZh"] = ["chinese.epub"]
    run(db, worker, kind="manual", keys=[KEY])
    assert [d[1] for d in upstream.downloads] == ["volume1.epub"]


def test_pacing_follows_current_settings_but_content_is_snapshotted(system):
    db, worker, _ = system
    job_id = db.create_job(JobRequest(kind="full"))
    configure(db, request_delay=5, source_mode="zh-jp")
    config = worker.job_config(db.job(job_id))
    assert config.request_delay == 5 and config.source_mode == "jp-zh"


def test_existing_database_gains_new_columns(tmp_path):
    path = tmp_path / "old.sqlite3"
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE jobs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, "
                     "request TEXT NOT NULL, config TEXT NOT NULL, cursor INTEGER NOT NULL)")
        conn.execute("CREATE TABLE job_items (job_id INTEGER NOT NULL, target TEXT NOT NULL, "
                     "status TEXT NOT NULL DEFAULT 'pending', error TEXT, PRIMARY KEY(job_id, target))")
    conn.close()
    db = Database(path)
    assert {"resume_at", "pauses"} <= {r["name"] for r in db.rows("PRAGMA table_info(jobs)")}
    assert {"attempts", "parts"} <= {r["name"] for r in db.rows("PRAGMA table_info(job_items)")}
