"""Persistent task queue and scheduled metadata sweeps, executed by one worker."""

import json
import logging
import re
import threading
from collections.abc import Callable
from dataclasses import asdict
from datetime import UTC, datetime, time, timedelta
from pathlib import Path

from .client import (
    Cancelled,
    Client,
    Deferred,
    NetworkError,
    Rejected,
    ServerError,
    TransientError,
    component,
    fingerprint,
    validate_epub,
)
from .converter import convert_epub, verify_against_jp
from .database import BILINGUAL_MODES, BILINGUAL_SQL, ORIGINAL_JP, ORIGINAL_ZH, iso, now
from .schema import LEVELS, PACING_FIELDS, JobRequest, Settings, normalize_key, parse_range


class VolumeFailures(Exception):
    """Some volumes of a work failed; the others are recorded as done."""

    def __init__(self, failures, total):
        self.failures = failures
        self.retryable = all(is_retryable(e) for e in failures.values())
        self.network = all(is_network(e) for e in failures.values())
        volume, first = next(iter(failures.items()))
        super().__init__(f"{len(failures)} of {total} volume(s) failed. {volume}: {first}")


def is_retryable(exc):
    if isinstance(exc, VolumeFailures):
        return exc.retryable
    # A local write error (disk full, drive briefly gone) is worth another try; HTTP errors
    # from requests are OSErrors too, but the client always wraps those.
    return isinstance(exc, TransientError | OSError)


def is_network(exc):
    return exc.network if isinstance(exc, VolumeFailures) else isinstance(exc, NetworkError)


def in_minutes(minutes):
    return datetime.now(UTC) + timedelta(minutes=minutes)


def window_opens(config, moment=None):
    """None inside active hours; otherwise when the next window starts (local server time)."""
    if not config.active_hours:
        return None
    moment = (moment or datetime.now()).astimezone()
    start, end = time.fromisoformat(config.active_start), time.fromisoformat(config.active_end)
    clock = moment.time().replace(tzinfo=None)
    inside = start <= clock < end if start < end else (clock >= start or clock < end)
    if inside:
        return None
    # Build from naive local wall-clock times so each day gets its own UTC offset across DST changes.
    opens = datetime.combine(moment.date(), start).astimezone()
    return (
        opens
        if opens > moment
        else datetime.combine(moment.date() + timedelta(days=1), start).astimezone()
    )


def natural_key(value):
    return [(1, int(p)) if p.isdigit() else (0, p.casefold()) for p in re.split(r"(\d+)", value)]


def ordered_volumes(key, data):
    """(volume, chinese_only) pairs in the order volume ranges count them."""
    if not key.startswith("wenku/"):
        counts = {k: data.get(k) for k in ("jp", "sakura", "gpt", "youdao", "baidu", "updateAt")}
        return [({"volumeId": "web.epub", "toc": data.get("toc", []), "counts": counts}, False)]
    volumes = [(v, False) for v in data.get("volumeJp", [])]
    volumes += [
        ({"volumeId": v} if isinstance(v, str) else v, True) for v in data.get("volumeZh", [])
    ]
    return sorted(volumes, key=lambda pair: (pair[1], natural_key(pair[0]["volumeId"])))


class Worker:
    def __init__(self, db, download_root: Path, client_factory: Callable[..., Client] = Client):
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
        if stamp and datetime.fromisoformat(stamp) > datetime.now(UTC):
            return
        job_id = self.db.create_job(JobRequest(kind="incremental"), scheduled=True)
        if job_id:
            self.db.set_setting(
                "next_incremental_at",
                (datetime.now(UTC) + timedelta(hours=config.interval_hours)).isoformat(
                    timespec="seconds"
                ),
            )
            self.db.log(job_id, "Scheduled light novel sweep queued.")

    def loop(self):
        while not self.stop.is_set():
            try:
                self.schedule()
                job = self.db.next_job()
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

    def job_config(self, job):
        """The task's settings snapshot, with pacing taken from the current settings."""
        config = Settings.model_validate_json(job["config"])
        current = self.db.settings()
        return config.model_copy(update={name: getattr(current, name) for name in PACING_FIELDS})

    def check_window(self, job_id, request, config):
        if request.kind == "convert" or self.db.job(job_id)["ignore_window"]:
            return
        if opens := window_opens(config):
            raise Deferred(
                f"Outside active hours; waiting until {opens:%H:%M}.", opens, counts=False
            )

    def _run_job(self, job_id):
        job = self.db.job(job_id)
        request = JobRequest.model_validate_json(job["request"])
        config = self.job_config(job)
        self.db.execute(
            "UPDATE jobs SET status='running',started_at=COALESCE(started_at,?),error=NULL,"
            "resume_at=NULL,wait_until=NULL,wait_reason=NULL WHERE id=?",
            (now(), job_id),
        )
        self.db.log(job_id, "Task started; existing completed items are preserved.")
        client = self.client_factory(
            config,
            lambda: self.check(job_id),
            lambda until, reason: self.db.set_wait(job_id, until, reason),
        )
        try:
            self.check(job_id)
            self.check_window(job_id, request, config)
            self.discover(job_id, request, config, client)
            self.process_pending(job_id, request, config, client)
            self.retry_rounds(job_id, request, config, client)
            self.process_pending(job_id, request, config, client)  # retried by the user meanwhile
            self.check(job_id)
            failed = self.db.row(
                "SELECT COUNT(*) AS n FROM job_items WHERE job_id=? AND status='failed'", (job_id,)
            )["n"]
            status = "completed_with_errors" if failed else "completed"
            self.db.execute(
                "UPDATE jobs SET status=?,finished_at=? WHERE id=?", (status, now(), job_id)
            )
            self.db.log(job_id, f"Task finished with {failed} failed item(s).")
            if request.kind == "incremental" and not failed:
                self.db.set_setting("last_incremental_at", now())
        except Deferred as exc:
            pauses = self.db.job(job_id)["pauses"] + exc.counts
            if exc.counts and pauses > config.max_pauses:
                message = f"{exc} Gave up after {config.max_pauses} automatic pause(s); resume the task later."
                self.db.execute(
                    "UPDATE jobs SET status='failed',finished_at=?,error=? WHERE id=?",
                    (now(), message, job_id),
                )
                self.db.log(job_id, message, "error")
            else:
                self.db.defer(job_id, exc.until, str(exc), pauses)
                self.db.log(job_id, f"{exc} Resumes automatically at {iso(exc.until)}.", "warning")
        except Cancelled as exc:
            status = "interrupted" if self.stop.is_set() else "cancelled"
            self.db.execute(
                "UPDATE jobs SET status=?,finished_at=?,error=? WHERE id=?",
                (status, now(), str(exc), job_id),
            )
            self.db.log(job_id, str(exc), "warning")
        except Exception as exc:
            self.db.execute(
                "UPDATE jobs SET status='failed',finished_at=?,error=? WHERE id=?",
                (now(), str(exc), job_id),
            )
            self.db.log(job_id, str(exc), "error")
        finally:
            client.close()

    def check_storage(self):
        """Pause instead of failing every remaining item while the download drive is gone."""
        try:
            self.root.mkdir(parents=True, exist_ok=True)
        except OSError:
            raise Deferred(
                f"The download directory {self.root} is unavailable; waiting for it to return.",
                in_minutes(5),
                counts=False,
            ) from None

    def set_pending(self, job_id, targets):
        for target in targets:
            self.db.execute(
                "UPDATE job_items SET status='pending' WHERE job_id=? AND target=?",
                (job_id, target),
            )

    def process_pending(self, job_id, request, config, client):
        # Fetch one item at a time, in list order, so items retried while the task runs
        # (made pending again by the user) are picked up next.
        streak = []  # consecutive items that failed with network errors
        while item := self.db.row(
            "SELECT target FROM job_items WHERE job_id=? AND status='pending' ORDER BY rowid LIMIT 1",
            (job_id,),
        ):
            self.check(job_id)
            self.check_window(job_id, request, config)
            self.check_storage()
            target = item["target"]
            self.db.execute(
                "UPDATE job_items SET status='running',attempts=attempts+1 WHERE job_id=? AND target=?",
                (job_id, target),
            )
            try:
                if request.kind == "convert":
                    self.convert_file(job_id, int(target), config, client, request.force)
                else:
                    self.process_work(job_id, target, request, config, client)
                self.check(job_id)
                self.db.execute(
                    "UPDATE job_items SET status='done',error=NULL,retryable=0 WHERE job_id=? AND target=?",
                    (job_id, target),
                )
                self.db.execute("UPDATE jobs SET pauses=0 WHERE id=? AND pauses>0", (job_id,))
                streak.clear()
            except Cancelled, Deferred:
                self.set_pending(job_id, [target])
                raise
            except Exception as exc:
                if isinstance(exc, OSError) and not isinstance(exc, PermissionError):
                    try:
                        self.check_storage()
                    except Deferred:
                        self.set_pending(job_id, [target])
                        raise
                self.db.execute(
                    "UPDATE job_items SET status='failed',error=?,retryable=? WHERE job_id=? AND target=?",
                    (str(exc), int(is_retryable(exc)), job_id, target),
                )
                self.db.log(job_id, f"{target}: {exc}", "error")
                if isinstance(exc, PermissionError):
                    raise
                streak = [*streak, target] if is_network(exc) else []
                if config.network_streak and len(streak) >= config.network_streak:
                    # The connection is down, not these works: give them back and wait.
                    self.set_pending(job_id, streak)
                    raise Deferred(
                        f"{len(streak)} items in a row failed with network errors; "
                        f"pausing for {config.network_pause:g} min.",
                        in_minutes(config.network_pause),
                    ) from exc

    def retry_rounds(self, job_id, request, config, client):
        """Give temporarily failed items more chances after a growing cooldown.
        Rounds used are stored, so an automatic pause does not restart the count."""
        for round_number in range(self.db.job(job_id)["retry_round"] + 1, config.retry_rounds + 1):
            count = self.db.row(
                "SELECT COUNT(*) AS n FROM job_items WHERE job_id=? AND status='failed' AND retryable=1",
                (job_id,),
            )["n"]
            if not count:
                return
            delay = config.retry_round_delay * round_number
            self.db.log(
                job_id,
                f"Retry round {round_number}/{config.retry_rounds}: "
                f"{count} temporarily failed item(s) in {delay:g} s.",
            )
            client.wait(delay, f"Retry round {round_number} of {config.retry_rounds} starts soon")
            self.db.execute("UPDATE jobs SET retry_round=? WHERE id=?", (round_number, job_id))
            self.db.execute(
                "UPDATE job_items SET status='pending' WHERE job_id=? AND status='failed' AND retryable=1",
                (job_id,),
            )
            self.process_pending(job_id, request, config, client)

    def discover(self, job_id, request, config, client):
        job = self.db.job(job_id)
        if job["listing_done"]:
            return
        if request.kind == "convert":
            ids = request.file_ids
            if request.keys:
                marks = ",".join("?" * len(request.keys))
                ids = [
                    f["id"]
                    for f in self.db.rows(
                        f"SELECT id FROM files WHERE {BILINGUAL_SQL} AND work_key IN ({marks}) ORDER BY work_key,id",
                        request.keys,
                    )
                ]
                if not ids:
                    raise ValueError(
                        "The selected works have no bilingual files. Download them first."
                    )
            elif not ids:
                ids = [
                    f["id"]
                    for f in self.db.rows(f"SELECT id FROM files WHERE {BILINGUAL_SQL} ORDER BY id")
                ]
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
                try:
                    result = client.listing(page, request.category, request.query)
                except TransientError as exc:
                    # The checkpoint stays on this page; pause instead of failing the whole sweep.
                    delay = max(60.0, config.retry_round_delay)
                    raise Deferred(
                        f"Catalog page {page} failed ({exc}); retrying in {delay:g} s.",
                        datetime.now(UTC) + timedelta(seconds=delay),
                    ) from exc
                page_count = result["pageNumber"]
                items = result["items"]
                targets = [normalize_key("wenku/" + item["id"]) for item in items]
                if not items and page <= page_count:
                    raise ValueError(f"Catalog page {page} is unexpectedly empty; resume to retry.")
                self.db.add_targets(job_id, targets, page + 1, page_count)
                self.db.log(
                    job_id, f"Catalog page {page}/{page_count}: discovered {len(targets)} work(s)."
                )
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
            self.db.log(
                job_id, f"{key}: category changed; excluded from light novel downloads.", "warning"
            )
            return
        if not request.download:
            return
        volumes = ordered_volumes(key, data)
        picked = parse_range(request.volumes, len(volumes))
        if request.volumes and not picked:
            raise ValueError("Volume range matched no available files.")
        if not volumes:
            self.db.log(job_id, f"{key}: no uploaded volumes available.", "warning")
        done = set(self.db.parts(job_id, key)["done"])
        failures = {}
        for index in picked:
            self.check(job_id)
            volume, chinese_only = volumes[index - 1]
            volume_id = volume["volumeId"]
            if volume_id in done:
                continue  # finished by an earlier attempt of this task; never fetched twice, even when forced
            if chinese_only and not config.download_chinese_uploads:
                continue
            try:
                self.process_volume(
                    job_id, key, data, volume, chinese_only, request, config, client
                )
            except Cancelled, Deferred, PermissionError:
                raise
            except Exception as exc:
                failures[volume_id] = exc
                self.db.mark_part(job_id, key, volume_id, str(exc))
                self.db.log(job_id, f"{volume_id}: {exc}", "error")
            else:
                self.db.mark_part(job_id, key, volume_id)
        if failures:
            raise VolumeFailures(failures, len(picked))

    def file_record(self, key, volume_id, mode):
        return self.db.row(
            "SELECT * FROM files WHERE work_key=? AND volume_id=? AND mode=?",
            (key, volume_id, mode),
        )

    @staticmethod
    def is_current(record, stamp):
        return bool(
            record
            and record["fingerprint"] == stamp
            and Path(record["raw_path"]).is_file()
            and Path(record["raw_path"]).stat().st_size == record["size"]
        )

    def destination(self, key, data, volume_id, mode):
        folder = self.root / component(key.replace("/", "_"), 50)
        wenku = key.startswith("wenku/")
        name = component(Path(volume_id).stem if wenku else data.get("titleJp") or key, 55)
        extension = ".txt" if wenku and volume_id.lower().endswith(".txt") else ".epub"
        return folder / f"{name}_{fingerprint(volume_id)[:10]} [{mode}]{extension}"

    def process_volume(self, job_id, key, data, volume, chinese_only, request, config, client):
        volume_id = volume["volumeId"]
        mode = ORIGINAL_ZH if chinese_only else config.source_mode
        stamp = fingerprint(
            {
                "volume": volume,
                "mode": mode,
                "translations": config.translations,
                "translations_mode": config.translations_mode,
            }
        )
        record = self.file_record(key, volume_id, mode)
        if not request.force and self.is_current(record, stamp):
            self.db.log(job_id, f"Unchanged: {volume_id}")
        else:
            original = self.file_record(key, volume_id, ORIGINAL_JP)
            original_stamp = fingerprint({"volume": volume, "mode": ORIGINAL_JP})
            if not request.force and self.is_current(original, original_stamp):
                # Same upload and counters as when the bilingual build failed: it would fail again.
                self.db.log(job_id, f"Unchanged: {volume_id} (Japanese original kept)")
                return
            destination = self.destination(key, data, volume_id, mode)
            try:
                size, sha = client.source(key, volume_id, destination, original=chinese_only)
            except Rejected, ServerError:
                if chinese_only or not config.original_fallback or not key.startswith("wenku/"):
                    raise
                self.save_original(job_id, key, data, volume, original_stamp, client)
                return
            self.db.save_file(key, volume_id, mode, stamp, destination, size, sha)
            self.db.log(job_id, f"Downloaded {volume_id} ({size // 1024} KB).")
            if original:
                self.db.execute("DELETE FROM files WHERE id=?", (original["id"],))
                Path(original["raw_path"]).unlink(missing_ok=True)
            record = self.file_record(key, volume_id, mode)
        if config.auto_convert and not chinese_only:
            self.convert_file(job_id, record["id"], config, client, request.force)

    def save_original(self, job_id, key, data, volume, stamp, client):
        """Novelia could not build the bilingual file (a persistent HTTP 500 or 404 for some
        uploads). The Japanese original is what conversion would produce, so keep that."""
        volume_id = volume["volumeId"]
        self.db.log(
            job_id,
            f"{volume_id}: Novelia could not build the bilingual file; saving the Japanese original.",
            "warning",
        )
        destination = self.destination(key, data, volume_id, ORIGINAL_JP)
        size, sha = client.source(key, volume_id, destination, original=True)
        self.db.save_original(key, volume_id, stamp, destination, size, sha)
        self.db.log(job_id, f"Saved the Japanese original of {volume_id} ({size // 1024} KB).")

    def convert_file(self, job_id, file_id, config, client, force=False):
        record = self.db.row("SELECT * FROM files WHERE id=?", (file_id,))
        if not record:
            raise ValueError(f"File {file_id} does not exist.")
        if record["mode"] not in BILINGUAL_MODES:
            reason = (
                "is already the Japanese original"
                if record["mode"] == ORIGINAL_JP
                else "is a Chinese-only upload with no Japanese text"
            )
            self.db.log(job_id, f"File {file_id} {reason}; nothing to convert.")
            return
        source = Path(record["raw_path"])
        if not source.is_file():
            raise FileNotFoundError("Source file is missing. Run a download task to restore it.")
        if source.suffix.lower() == ".txt":
            self.convert_text(job_id, record, client, force)
            return
        previous = json.loads(record["report"] or "{}")
        if (
            not force
            and record["ja_path"]
            and Path(record["ja_path"]).is_file()
            and (
                record["verification"] == "verified"
                or (not config.verify and record["verification"] == "disabled")
            )
            and previous.get("vertical") == config.vertical
        ):
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
        reference_error, reference_transient = "", False
        if (config.verify or (config.vertical and work["kind"] == "wenku")) and not has_reference:
            try:
                client.source(work["key"], record["volume_id"], reference, original=True)
                has_reference = True
                self.db.execute(
                    "UPDATE files SET reference_path=? WHERE id=?", (str(reference), file_id)
                )
            except Cancelled, Deferred, PermissionError:
                raise
            except Exception as exc:
                reference_error, reference_transient = str(exc), is_retryable(exc)
                self.db.log(job_id, f"Reference unavailable: {reference_error}", "warning")
        output = source.with_name(source.stem + " [ja].epub")
        report = convert_epub(
            source,
            output,
            vertical=config.vertical,
            title_jp=data.get("titleJp", "") if work["kind"] == "web" else "",
            introduction_jp=data.get("introductionJp", ""),
            authors=json.loads(work["authors"]),
            toc=data.get("toc", []),
            restore_css_from=reference if has_reference else None,
        )
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
        self.db.execute(
            "UPDATE files SET ja_path=?,status=?,verification=?,report=?,updated_at=? WHERE id=?",
            (
                str(output),
                "converted" if passed else "unverified",
                verification,
                json.dumps({**asdict(report), "verification_detail": detail}),
                now(),
                file_id,
            ),
        )
        self.db.log(
            job_id,
            f"Converted file {file_id}: {report.describe()}; {detail}",
            "info" if passed else "warning",
        )
        if not passed:
            # A reference that failed to download may succeed later; a real mismatch will not.
            raise (TransientError if reference_transient else ValueError)(detail)

    def convert_text(self, job_id, record, client, force):
        """A text volume's bilingual file interleaves Japanese and Chinese lines without markers,
        so the Japanese edition is the uploaded original text itself."""
        source = Path(record["raw_path"])
        output = source.with_name(source.stem + " [ja].txt")
        if (
            not force
            and record["verification"] == "original"
            and record["ja_path"]
            and Path(record["ja_path"]).is_file()
        ):
            self.db.log(job_id, f"File {record['id']}: Japanese text already saved.")
            return
        work = self.db.row("SELECT key FROM works WHERE key=?", (record["work_key"],))
        client.source(work["key"], record["volume_id"], output, original=True)
        detail = "Japanese text is the uploaded original."
        self.db.execute(
            "UPDATE files SET ja_path=?,status='converted',verification='original',report=?,"
            "updated_at=? WHERE id=?",
            (str(output), json.dumps({"verification_detail": detail}), now(), record["id"]),
        )
        self.db.log(job_id, f"Saved the Japanese text of file {record['id']}.")
