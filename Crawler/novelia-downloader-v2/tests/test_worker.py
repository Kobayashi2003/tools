import json
from pathlib import Path

from app.database import now
from app.schema import JobRequest, Settings
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
