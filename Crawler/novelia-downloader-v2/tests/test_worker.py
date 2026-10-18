import copy
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.client import DamagedUpload, Deferred, NetworkError, Rejected, ServerError
from app.database import Database
from app.schema import JobRequest, Settings
from app.worker import CatalogTail, window_opens
from tests.conftest import KEY


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


def test_catalog_tail_finds_works_moved_to_the_front():
    old = [f"w{i}" for i in range(6000)]
    # The catalog on 2026-10-16: four works got new volumes; the rest kept their order.
    listing = ["w59", "w1898", "w4812", "w3905", *[k for k in old if k not in ("w59",)][:20]]
    tail = CatalogTail(old, [])
    assert tail.feed(listing[:12]) == (["w59", "w1898", "w4812", "w3905"], True)
    # A brand-new work is checked; a run broken by a moved work is checked too, to be safe.
    tail = CatalogTail(old, [])
    assert tail.feed(["new", "w0", "w1", "w900", "w2", "w3", "w4", "w5", "w6"]) == (
        ["new", "w0", "w1", "w900"],
        True,
    )


def test_update_sweep_reads_only_until_the_previous_order(system):
    db, worker, upstream = system
    keys = [f"wenku/{i:024x}" for i in range(1, 31)]
    for key in keys:
        upstream.works[key] = copy.deepcopy(upstream.works[KEY])
    upstream.pages = {1: keys[:10], 2: keys[10:20], 3: keys[20:]}
    assert run(db, worker, kind="full")["status"] == "completed"
    upstream.checked.clear()
    upstream.listed.clear()
    order = [keys[25], keys[12], *[k for k in keys if k not in (keys[25], keys[12])]]
    upstream.pages = {1: order[:10], 2: order[10:20], 3: order[20:]}
    upstream.works[keys[25]]["volumeJp"].append({"volumeId": "new.epub", "sakura": 1})
    assert run(db, worker, kind="incremental")["status"] == "completed"
    assert upstream.listed == [(1, 1)]
    assert upstream.checked == [keys[25], keys[12]]
    assert (keys[25], "new.epub", False) in upstream.downloads
    assert db.setting("catalog_order") == order
    upstream.checked.clear()
    assert run(db, worker, kind="incremental")["status"] == "completed"
    assert upstream.checked == []


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


def test_bulk_conversion_keeps_source_and_downloads_nothing(system):
    db, worker, upstream = system
    run(db, worker, kind="full")
    assert run(db, worker, kind="convert")["status"] == "completed"
    file = db.row("SELECT * FROM files")
    assert Path(file["raw_path"]).exists()
    assert Path(file["ja_path"]).parent.parent.name == "Japanese"
    report = json.loads(file["report"])
    assert report["kept_ja"] == 1 and report["dropped_zh"] == 1 and report["vertical"]
    run(db, worker, kind="convert")
    assert len(upstream.downloads) == 1
    configure(db, vertical=False)
    run(db, worker, kind="convert")  # the layout changed, so it is built again
    assert not json.loads(db.row("SELECT report FROM files")["report"])["vertical"]


def test_download_formats_and_chinese_conversion(system):
    db, worker, upstream = system
    configure(db, download_japanese=True, download_chinese=True)
    assert run(db, worker, kind="manual", keys=[KEY])["status"] == "completed"
    modes = sorted(r["mode"] for r in db.rows("SELECT mode FROM files"))
    assert modes == ["jp-original", "jp-zh", "zh"]
    upstream.works[KEY]["volumeJp"][0]["sakura"] += 1
    run(db, worker, kind="manual", keys=[KEY])
    # Translation progress changes Novelia's builds, not the upload.
    assert [d[2] for d in upstream.downloads[3:]] == [False, "zh"]
    downloads = len(upstream.downloads)
    job = run(db, worker, kind="convert", convert_japanese=False, convert_chinese=True)
    assert job["status"] == "completed" and len(upstream.downloads) == downloads
    file = db.row("SELECT * FROM files WHERE mode='jp-zh'")
    assert file["ja_path"] is None and Path(file["raw_path"]).exists()
    assert Path(file["zh_path"]).parent.parent.name == "Chinese"


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
    upstream.works[KEY]["volumeJp"] = [
        {"volumeId": "v10.epub"},
        {"volumeId": "v2.epub"},
        {"volumeId": "v1.epub"},
    ]
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
    upstream.works[web] = {
        "titleJp": "Web novel",
        "toc": [{"titleJp": "Chapter", "chapterId": "1"}],
        "jp": 1,
    }
    upstream.works[KEY]["volumeZh"] = ["chinese.epub"]
    run(db, worker, kind="manual", keys=[KEY, web])
    assert len(db.rows("SELECT * FROM files")) == 2  # Chinese-only uploads are off by default
    configure(db, download_chinese_uploads=True)
    run(db, worker, kind="manual", keys=[KEY])
    chinese = db.row("SELECT * FROM files WHERE mode='zh-original'")
    assert Path(chinese["raw_path"]).parent.parent.name == "Chinese"
    run(db, worker, kind="convert")
    assert [d[1] for d in upstream.downloads if d[2]] == ["chinese.epub"]
    assert len(db.rows("SELECT * FROM files WHERE ja_path IS NOT NULL")) == 2


def test_convert_by_work_keys(system):
    db, worker, upstream = system
    job = run(db, worker, kind="convert", keys=[KEY])
    assert job["status"] == "failed" and "no bilingual files" in job["error"]
    run(db, worker, kind="full")
    assert run(db, worker, kind="convert", keys=[KEY])["status"] == "completed"
    assert db.row("SELECT ja_path FROM files")["ja_path"]


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
    later = datetime.now(UTC) + timedelta(minutes=30)
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
    upstream.raise_on["volume1.epub"] = Deferred("Rate limited.", datetime.now(UTC))
    job = run(db, worker, kind="manual", keys=[KEY])
    assert job["status"] == "queued"
    worker.run_job(job["id"])
    job = db.job(job["id"])
    assert job["status"] == "failed" and "Gave up" in job["error"]


def test_active_hours_window():
    config = Settings(active_hours=True, active_start="23:00", active_end="06:00")
    noon = datetime(2026, 1, 1, 12, 0).astimezone()
    opens = window_opens(config, noon)
    assert opens is not None and opens.hour == 23
    assert window_opens(config, noon.replace(hour=2)) is None
    assert window_opens(Settings(), noon) is None
    office = Settings(active_hours=True, active_start="09:00", active_end="17:00")
    opens = window_opens(office, noon.replace(hour=18))
    assert opens is not None and opens.day == 2


def test_outside_active_hours_defers_without_counting_a_pause(system, monkeypatch):
    db, worker, upstream = system
    opens = datetime.now(UTC) + timedelta(hours=3)
    monkeypatch.setattr("app.worker.window_opens", lambda config: opens)
    job = run(db, worker, kind="manual", keys=[KEY])
    assert job["status"] == "queued" and job["pauses"] == 0 and not upstream.downloads


def test_start_now_overrides_active_hours(system, monkeypatch):
    db, worker, upstream = system
    monkeypatch.setattr(
        "app.worker.window_opens", lambda config: datetime.now(UTC) + timedelta(hours=3)
    )
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
    db.execute(
        "UPDATE jobs SET status='queued' WHERE id=?", (job["id"],)
    )  # as after an automatic pause
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
        conn.execute(
            "CREATE TABLE jobs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, "
            "request TEXT NOT NULL, config TEXT NOT NULL, cursor INTEGER NOT NULL)"
        )
        conn.execute(
            "CREATE TABLE job_items (job_id INTEGER NOT NULL, target TEXT NOT NULL, "
            "status TEXT NOT NULL DEFAULT 'pending', error TEXT, PRIMARY KEY(job_id, target))"
        )
    conn.close()
    db = Database(path)
    assert {"resume_at", "pauses"} <= {r["name"] for r in db.rows("PRAGMA table_info(jobs)")}
    assert {"attempts", "parts"} <= {r["name"] for r in db.rows("PRAGMA table_info(job_items)")}


def test_text_volumes_are_saved_and_their_japanese_text_is_the_original(system):
    db, worker, upstream = system
    configure(db, auto_convert=True)
    upstream.works[KEY]["volumeJp"] = [{"volumeId": "volume1.txt"}]
    assert run(db, worker, kind="manual", keys=[KEY])["status"] == "completed"
    file = db.row("SELECT * FROM files")
    assert file["raw_path"].endswith("[jp-zh].txt") and file["ja_path"].endswith("[ja].txt")
    assert Path(file["ja_path"]).read_text(encoding="utf-8") == "日本語\n"
    assert file["verification"] == "original"
    run(db, worker, kind="convert")
    assert len(upstream.downloads) == 2  # the Japanese text is not fetched again


def test_original_is_kept_when_bilingual_build_fails(system):
    db, worker, upstream = system
    upstream.bilingual_errors["volume1.epub"] = ServerError("HTTP 500 after 3 attempts")
    assert run(db, worker, kind="manual", keys=[KEY])["status"] == "completed"
    file = db.row("SELECT * FROM files")
    assert file["mode"] == "jp-original" and file["ja_path"] == file["raw_path"]
    assert upstream.downloads == [(KEY, "volume1.epub", True)]
    run(db, worker, kind="incremental")
    assert len(upstream.downloads) == 1  # unchanged volume: no repeated bilingual attempts
    assert run(db, worker, kind="convert")["status"] == "completed"
    upstream.bilingual_errors.clear()
    upstream.works[KEY]["volumeJp"][0]["sakura"] += 1
    run(db, worker, kind="incremental")
    assert [r["mode"] for r in db.rows("SELECT mode FROM files")] == ["jp-zh"]
    assert not Path(file["raw_path"]).exists()


def test_damaged_uploads_are_skipped_until_they_change(system):
    db, worker, upstream = system
    upstream.raise_on["volume1.epub"] = DamagedUpload(
        "Novelia's copy of this volume is cut off at 2.0 MB (damaged upload)."
    )
    assert run(db, worker, kind="full")["status"] == "completed_with_errors"
    sweep = run(db, worker, kind="incremental")
    assert sweep["status"] == "completed"  # broken upstream files no longer fail every sweep
    skipped = (
        "SELECT COUNT(*) AS n FROM logs WHERE job_id=? AND message LIKE 'Skipped volume1.epub:%'"
    )
    assert db.row(skipped, (sweep["id"],))["n"] == 1
    upstream.raise_on.clear()
    upstream.works[KEY]["volumeJp"][0]["total"] = 11  # uploaded again
    assert run(db, worker, kind="incremental")["status"] == "completed"
    assert upstream.downloads == [(KEY, "volume1.epub", False)]
    assert not db.rows("SELECT * FROM damaged")


def test_original_fallback_can_be_turned_off(system):
    db, worker, upstream = system
    configure(db, original_fallback=False)
    upstream.bilingual_errors["volume1.epub"] = Rejected("HTTP 404: not found on Novelia.")
    assert run(db, worker, kind="manual", keys=[KEY])["status"] == "completed_with_errors"
    assert not db.rows("SELECT * FROM files")


def test_network_outage_pauses_instead_of_failing_every_item(system):
    db, worker, upstream = system
    configure(db, network_streak=3, retry_rounds=0)
    keys = [f"wenku/{i:024x}" for i in range(1, 6)]
    for key in keys:
        upstream.works[key] = {
            **upstream.works[KEY],
            "volumeJp": [{"volumeId": f"{key[-3:]}.epub"}],
        }
        upstream.raise_on[f"{key[-3:]}.epub"] = NetworkError("Network SSLError after 3 attempts")
    job = run(db, worker, kind="manual", keys=keys)
    assert job["status"] == "queued" and job["resume_at"] and "network" in job["wait_reason"]
    statuses = [r["status"] for r in db.rows("SELECT status FROM job_items ORDER BY rowid")]
    assert statuses == ["pending"] * 5  # the three that failed went back in the queue
    upstream.raise_on.clear()
    db.resume(job["id"])
    worker.run_job(job["id"])
    assert db.job(job["id"])["status"] == "completed"


def test_permanent_failures_do_not_count_as_a_network_outage(system):
    db, worker, upstream = system
    configure(db, network_streak=2, retry_rounds=0)
    keys = [f"wenku/{i:024x}" for i in range(1, 4)]
    for key in keys:
        upstream.works[key] = {
            **upstream.works[KEY],
            "volumeJp": [{"volumeId": f"{key[-3:]}.epub"}],
        }
        upstream.raise_on[f"{key[-3:]}.epub"] = ValueError("Novelia's copy is damaged.")
    assert run(db, worker, kind="manual", keys=keys)["status"] == "completed_with_errors"


def test_missing_download_drive_pauses_the_task(system, tmp_path):
    db, worker, upstream = system
    blocker = tmp_path / "not-a-directory"
    blocker.write_text("x")
    worker.root = blocker / "downloads"  # cannot be created, like a disconnected drive
    job = run(db, worker, kind="manual", keys=[KEY])
    assert job["status"] == "queued" and "unavailable" in job["wait_reason"] and job["pauses"] == 0
    assert db.row("SELECT status FROM job_items")["status"] == "pending"


def test_failed_items_can_be_retried_while_the_task_runs(system):
    db, worker, upstream = system
    configure(db, retry_rounds=0)
    other = "wenku/688da4c4c923db0b7aa9943f"
    upstream.works[other] = {**upstream.works[KEY], "volumeJp": [{"volumeId": "other.epub"}]}
    upstream.fail_volume = "volume1.epub"
    job_id = db.create_job(JobRequest(kind="manual", keys=[KEY, other]))
    real_source = upstream.client

    def client(config, check, on_wait=None):
        fake = real_source(config, check, on_wait)
        original = fake.source

        def source(key, volume, destination, original_file=False, **kwargs):
            if (
                volume == "other.epub"
                and db.row("SELECT status FROM job_items WHERE target=?", (KEY,))["status"]
                == "failed"
            ):
                upstream.fail_volume = None
                assert db.retry(job_id) == 1  # the user clicks Retry while #1 is running
                assert db.job(job_id)["status"] == "running"
            return original(key, volume, destination, kwargs.get("original", original_file))

        fake.source = source
        return fake

    worker.client_factory = client
    worker.run_job(job_id)
    assert db.job(job_id)["status"] == "completed"
    assert {r["status"] for r in db.rows("SELECT status FROM job_items")} == {"done"}
