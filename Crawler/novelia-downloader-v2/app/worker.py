"""Persistent task queue and scheduled metadata sweeps, executed by one worker."""

import json
import logging
import re
import threading
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .client import Cancelled, Client, component, fingerprint, validate_epub
from .converter import convert_epub, verify_against_jp
from .database import now
from .schema import LEVELS, JobRequest, Settings, normalize_key, parse_range


def natural_key(value):
    return [(1, int(p)) if p.isdigit() else (0, p.casefold()) for p in re.split(r"(\d+)", value)]


def ordered_volumes(key, data):
    """(volume, chinese_only) pairs in the order volume ranges count them."""
    if not key.startswith("wenku/"):
        counts = {k: data.get(k) for k in ("jp", "sakura", "gpt", "youdao", "baidu", "updateAt")}
        return [({"volumeId": "web.epub", "toc": data.get("toc", []), "counts": counts}, False)]
    volumes = [(v, False) for v in data.get("volumeJp", [])]
    volumes += [({"volumeId": v} if isinstance(v, str) else v, True) for v in data.get("volumeZh", [])]
    return sorted(volumes, key=lambda pair: (pair[1], natural_key(pair[0]["volumeId"])))


class Worker:
    def __init__(self, db, download_root: Path, client_factory=Client):
        self.db, self.root, self.client_factory = db, download_root.resolve(), client_factory
        self.maintenance_lock = threading.RLock()
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.thread = None

    def start(self):
        self.db.recover()
        self.thread = threading.Thread(target=self.loop, name="novelia-worker", daemon=True)
        self.thread.start()

    def shutdown(self):
        self.stop.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=20)

    def schedule(self):
        config = self.db.settings()
        if not config.incremental_enabled:
            return
        stamp = self.db.setting("next_incremental_at")
        if stamp and datetime.fromisoformat(stamp) > datetime.now(timezone.utc):
            return
        job_id = self.db.create_job(JobRequest(kind="incremental"), scheduled=True)
        if job_id:
            self.db.set_setting("next_incremental_at", (datetime.now(timezone.utc) + timedelta(
                hours=config.interval_hours)).isoformat(timespec="seconds"))
            self.db.log(job_id, "Scheduled light novel sweep queued.")

    def loop(self):
        while not self.stop.is_set():
            try:
                self.schedule()
                job = self.db.row("SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1")
                if job:
                    self.run_job(job["id"])
                    continue
            except Exception:
                logging.getLogger(__name__).exception("Worker loop failed")
            self.wake.wait(5)
            self.wake.clear()

    def check(self, job_id):
        if self.stop.is_set():
            raise Cancelled("Server is stopping")
        job = self.db.job(job_id)
        if not job or job["cancel_requested"]:
            raise Cancelled("Task cancelled")

    def run_job(self, job_id):
        with self.maintenance_lock:
            self._run_job(job_id)

    def _run_job(self, job_id):
        job = self.db.job(job_id)
        request = JobRequest.model_validate_json(job["request"])
        config = Settings.model_validate_json(job["config"])
        self.db.execute("UPDATE jobs SET status='running',started_at=COALESCE(started_at,?),error=NULL WHERE id=?",
                        (now(), job_id))
        self.db.log(job_id, "Task started; existing completed items are preserved.")
        client = self.client_factory(config, lambda: self.check(job_id))
        try:
            self.check(job_id)
            self.discover(job_id, request, config, client)
            for item in self.db.rows("SELECT * FROM job_items WHERE job_id=? AND status='pending' ORDER BY rowid", (job_id,)):
                self.check(job_id)
                target = item["target"]
                self.db.execute("UPDATE job_items SET status='running' WHERE job_id=? AND target=?", (job_id, target))
                try:
                    if request.kind == "convert":
                        self.convert_file(job_id, int(target), config, client, request.force)
                    else:
                        self.process_work(job_id, target, request, config, client)
                    self.check(job_id)
                    self.db.execute("UPDATE job_items SET status='done',error=NULL WHERE job_id=? AND target=?", (job_id, target))
                except Cancelled:
                    self.db.execute("UPDATE job_items SET status='pending' WHERE job_id=? AND target=?", (job_id, target))
                    raise
                except Exception as exc:
                    message = str(exc)
                    self.db.execute("UPDATE job_items SET status='failed',error=? WHERE job_id=? AND target=?",
                                    (message, job_id, target))
                    self.db.log(job_id, f"{target}: {message}", "error")
                    if isinstance(exc, PermissionError):
                        raise
            self.check(job_id)
            failed = self.db.row("SELECT COUNT(*) AS n FROM job_items WHERE job_id=? AND status='failed'", (job_id,))["n"]
            status = "completed_with_errors" if failed else "completed"
            self.db.execute("UPDATE jobs SET status=?,finished_at=? WHERE id=?", (status, now(), job_id))
            self.db.log(job_id, f"Task finished with {failed} failed item(s).")
            if request.kind == "incremental" and not failed:
                self.db.set_setting("last_incremental_at", now())
        except Cancelled as exc:
            status = "interrupted" if self.stop.is_set() else "cancelled"
            self.db.execute("UPDATE jobs SET status=?,finished_at=?,error=? WHERE id=?", (status, now(), str(exc), job_id))
            self.db.log(job_id, str(exc), "warning")
        except Exception as exc:
            self.db.execute("UPDATE jobs SET status='failed',finished_at=?,error=? WHERE id=?", (now(), str(exc), job_id))
            self.db.log(job_id, str(exc), "error")
        finally:
            client.close()

    def discover(self, job_id, request, config, client):
        job = self.db.job(job_id)
        if job["listing_done"]:
            return
        if request.kind == "convert":
            ids = request.file_ids
            if request.keys:
                marks = ",".join("?" * len(request.keys))
                ids = [f["id"] for f in self.db.rows(
                    f"SELECT id FROM files WHERE mode!='zh-original' AND work_key IN ({marks}) ORDER BY work_key,id",
                    request.keys)]
                if not ids:
                    raise ValueError("The selected works have no bilingual files. Download them first.")
            elif not ids:
                ids = [f["id"] for f in self.db.rows("SELECT id FROM files WHERE mode!='zh-original' ORDER BY id")]
            for file_id in ids:
                if not self.db.row("SELECT id FROM files WHERE id=?", (file_id,)):
                    raise ValueError(f"File {file_id} does not exist.")
            self.db.add_targets(job_id, [str(i) for i in ids])
        elif request.kind == "manual":
            self.db.add_targets(job_id, request.keys)
        else:
            page = job["cursor"]
            while True:
                self.check(job_id)
                result = client.listing(page, request.category, request.query)
                page_count = result["pageNumber"]
                items = result["items"]
                targets = [normalize_key("wenku/" + item["id"]) for item in items]
                if not items and page <= page_count:
                    raise ValueError(f"Catalog page {page} is unexpectedly empty; resume to retry.")
                self.db.add_targets(job_id, targets, page + 1, page_count)
                self.db.log(job_id, f"Catalog page {page}/{page_count}: discovered {len(targets)} work(s).")
                if page >= page_count or (request.end_page and page >= request.end_page):
                    break
                page += 1
        self.db.execute("UPDATE jobs SET listing_done=1 WHERE id=?", (job_id,))

    def process_work(self, job_id, key, request, config, client):
        self.db.log(job_id, f"Checking {key}")
        data = client.metadata(key)
        category = LEVELS.get(data.get("level")) if key.startswith("wenku/") else None
        self.db.save_work(key, data, category)
        if request.kind in ("full", "incremental") and category != 1:
            self.db.log(job_id, f"{key}: category changed; excluded from light novel downloads.", "warning")
            return
        if not request.download:
            return
        volumes = ordered_volumes(key, data)
        picked = parse_range(request.volumes, len(volumes))
        if request.volumes and not picked:
            raise ValueError("Volume range matched no available files.")
        if not volumes:
            self.db.log(job_id, f"{key}: no uploaded volumes available.", "warning")
        failures = []
        for index in picked:
            self.check(job_id)
            volume, chinese_only = volumes[index - 1]
            try:
                self.process_volume(job_id, key, data, volume, chinese_only, request, config, client)
            except (Cancelled, PermissionError):
                raise
            except Exception as exc:
                failures.append(str(exc))
                self.db.log(job_id, f"{volume['volumeId']}: {exc}", "error")
        if failures:
            raise RuntimeError(f"{len(failures)} volume(s) failed. First error: {failures[0]}")

    def process_volume(self, job_id, key, data, volume, chinese_only, request, config, client):
        volume_id = volume["volumeId"]
        mode = "zh-original" if chinese_only else config.source_mode
        stamp = fingerprint({"volume": volume, "mode": mode,
                             "translations": config.translations, "translations_mode": config.translations_mode})
        record = self.db.row("SELECT * FROM files WHERE work_key=? AND volume_id=? AND mode=?", (key, volume_id, mode))
        exists = record and Path(record["raw_path"]).is_file() and Path(record["raw_path"]).stat().st_size == record["size"]
        if request.force or not exists or record["fingerprint"] != stamp:
            folder = self.root / component(key.replace("/", "_"), 50)
            name = component(Path(volume_id).stem if key.startswith("wenku/") else data.get("titleJp") or key, 55)
            suffix = fingerprint(volume_id)[:10]
            destination = folder / f"{name}_{suffix} [{mode}].epub"
            size, sha = client.source(key, volume_id, destination, original=chinese_only)
            self.db.save_file(key, volume_id, mode, stamp, destination, size, sha)
            self.db.log(job_id, f"Downloaded {volume_id} ({size // 1024} KB).")
            record = self.db.row("SELECT * FROM files WHERE work_key=? AND volume_id=? AND mode=?", (key, volume_id, mode))
        else:
            self.db.log(job_id, f"Unchanged: {volume_id}")
        if config.auto_convert and not chinese_only:
            self.convert_file(job_id, record["id"], config, client, request.force)

    def convert_file(self, job_id, file_id, config, client, force=False):
        record = self.db.row("SELECT * FROM files WHERE id=?", (file_id,))
        if not record:
            raise ValueError(f"File {file_id} does not exist.")
        if record["mode"] not in ("jp-zh", "zh-jp"):
            self.db.log(job_id, f"File {file_id}: Chinese-only upload has no Japanese source.", "warning")
            return
        source = Path(record["raw_path"])
        if not source.is_file():
            raise FileNotFoundError("Source EPUB is missing. Run a download task to restore it.")
        previous = json.loads(record["report"] or "{}")
        if not force and record["ja_path"] and Path(record["ja_path"]).is_file() and (
            record["verification"] == "verified" or (not config.verify and record["verification"] == "disabled")
        ) and previous.get("vertical") == config.vertical:
            self.db.log(job_id, f"File {file_id}: Japanese output already up to date.")
            return
        self.check(job_id)
        validate_epub(source)
        work = self.db.row("SELECT * FROM works WHERE key=?", (record["work_key"],))
        data = json.loads(work["metadata"])
        reference = source.with_name(source.stem + " [reference].epub")
        has_reference = bool(record["reference_path"] and Path(record["reference_path"]).is_file())
        if has_reference:
            reference = Path(record["reference_path"])
        reference_error = ""
        if (config.verify or (config.vertical and work["kind"] == "wenku")) and not has_reference:
            try:
                client.source(work["key"], record["volume_id"], reference, original=True)
                has_reference = True
                self.db.execute("UPDATE files SET reference_path=? WHERE id=?", (str(reference), file_id))
            except (Cancelled, PermissionError):
                raise
            except Exception as exc:
                reference_error = str(exc)
                self.db.log(job_id, f"Reference unavailable: {reference_error}", "warning")
        output = source.with_name(source.stem + " [ja].epub")
        report = convert_epub(source, output, vertical=config.vertical,
            title_jp=data.get("titleJp", "") if work["kind"] == "web" else "",
            introduction_jp=data.get("introductionJp", ""), authors=json.loads(work["authors"]),
            toc=data.get("toc", []), restore_css_from=reference if has_reference else None)
        if report.kept_ja == 0:
            output.unlink(missing_ok=True)
            raise ValueError("No Japanese paragraph markers found; source was preserved.")
        validate_epub(output)
        passed, detail, verification = True, "Verification disabled by settings.", "disabled"
        if config.verify:
            if has_reference:
                passed, detail = verify_against_jp(output, reference, "the Japanese reference")
            else:
                passed, detail = False, "Reference unavailable: " + reference_error
            verification = "verified" if passed else "unverified"
        if not passed:
            suspect = output.with_name(output.stem + " [UNVERIFIED].epub")
            output.replace(suspect)
            output = suspect
        if record["ja_path"] and Path(record["ja_path"]) != output:
            Path(record["ja_path"]).unlink(missing_ok=True)
        self.db.execute("UPDATE files SET ja_path=?,status=?,verification=?,report=?,updated_at=? WHERE id=?",
                        (str(output), "converted" if passed else "unverified", verification,
                         json.dumps({**asdict(report), "verification_detail": detail}), now(), file_id))
        self.db.log(job_id, f"Converted file {file_id}: {report.describe()}; {detail}", "info" if passed else "warning")
        if not passed:
            raise ValueError(detail)