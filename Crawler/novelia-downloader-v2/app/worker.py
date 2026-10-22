"""Persistent task queue and scheduled metadata sweeps, executed by one worker."""

import json
import logging
import re
import shutil
import threading
from collections.abc import Callable
from dataclasses import asdict
from datetime import UTC, datetime, time, timedelta
from pathlib import Path

from .client import (
    Cancelled,
    Client,
    DamagedUpload,
    Deferred,
    NetworkError,
    Rejected,
    ServerError,
    TransientError,
    component,
    fingerprint,
    validate_epub,
)
from .converter import convert_epub
from .database import (
    BILINGUAL_MODES,
    BILINGUAL_SQL,
    CHINESE,
    ORIGINAL_JP,
    ORIGINAL_ZH,
    iso,
    now,
)
from .schema import (
    ENGINES,
    LEVELS,
    PACING_FIELDS,
    JobRequest,
    Settings,
    normalize_key,
    parse_range,
)
from .storage import EDITION_FOLDERS, PATH_COLUMNS, mode_folder

UNAVAILABLE_RECHECK = timedelta(days=30)
# Failures meaning Novelia cannot supply a format of a volume: another edition may stand in.
UNAVAILABLE = (Rejected, ServerError, DamagedUpload)
STABLE_RUN = 5
# Below this, a task pauses rather than failing item after item on a full disk.
MIN_FREE_SPACE = 2 << 30


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


def ordered_volumes(key, data, chinese=False):
    """(volume, chinese_only) pairs in the order volume ranges count them. Chinese-only uploads
    are included only when `chinese`: Novelia's pages no longer list them, and many are broken."""
    if not key.startswith("wenku/"):
        counts = {k: data.get(k) for k in ("jp", *ENGINES, "updateAt")}
        return [({"volumeId": "web.epub", "toc": data.get("toc", []), "counts": counts}, False)]
    volumes = [(v, False) for v in data.get("volumeJp", [])]
    if chinese:
        volumes += [
            ({"volumeId": v} if isinstance(v, str) else v, True) for v in data.get("volumeZh", [])
        ]
    return sorted(volumes, key=lambda pair: (pair[1], natural_key(pair[0]["volumeId"])))


class CatalogTail:
    """Where a catalog listing rejoins the previous sweep's order.

    Novelia sorts the catalog by latest upload (translation progress does not move a work).
    Works uploaded to since the last sweep come first; once STABLE_RUN works in a row follow
    each other as they did then, everything after them is unchanged too."""

    def __init__(self, previous: list[str], moved: list[str]):
        self.previous = previous
        self.index = {key: i for i, key in enumerate(previous)}
        self.moved = set(moved)
        self.run: list[str] = []

    def follows(self, before: str, key: str) -> bool:
        at = self.index[before] + 1
        while at < len(self.previous) and self.previous[at] in self.moved:
            at += 1
        return at < len(self.previous) and self.previous[at] == key

    def flush(self) -> list[str]:
        """The pending run turned out not to be the old order: those works moved too."""
        run, self.run = self.run, []
        self.moved.update(run)
        return run

    def feed(self, keys: list[str]) -> tuple[list[str], bool]:
        """Works on this page that need checking, and whether the old order was reached."""
        moved = []
        for key in keys:
            if key in self.moved or key in self.run:
                continue  # listed twice: a new upload shifted the pages while reading
            if key in self.index and self.run and self.follows(self.run[-1], key):
                self.run.append(key)
                if len(self.run) >= STABLE_RUN:
                    return moved, True
                continue
            moved += self.flush()
            if key in self.index:
                self.run = [key]
            else:
                self.moved.add(key)
                moved.append(key)
        return moved, False


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
        config = self.job_config(job).model_copy(update=request.conversion())
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
        # An update sweep only reads the catalog down to where it matches the last sweep's order.
        baseline = self.catalog_order() if request.kind == "incremental" else None
        try:
            self.check(job_id)
            self.check_window(job_id, request, config)
            self.discover(job_id, request, config, client, baseline)
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
            if request.kind in ("full", "incremental"):
                self.remember_catalog_order(job_id, baseline)
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
            free = shutil.disk_usage(self.root).free
        except OSError:
            raise Deferred(
                f"The download directory {self.root} is unavailable; waiting for it to return.",
                in_minutes(5),
                counts=False,
            ) from None
        if free < MIN_FREE_SPACE:
            raise Deferred(
                f"Only {free / 2**30:.1f} GB is free on the download drive; "
                "free some space or move the library, then the task continues.",
                in_minutes(15),
                counts=False,
            )

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

    def catalog_order(self):
        """The catalog order at the start of the last finished sweep, every work of which was
        checked afterwards. Before any sweep recorded it, a finished full scan's list stands in."""
        order = self.db.setting("catalog_order")
        if order:
            return order
        job = self.db.row(
            "SELECT id FROM jobs WHERE kind IN ('full','incremental') AND listing_done=1 "
            "AND status IN ('completed','completed_with_errors') ORDER BY id DESC LIMIT 1"
        )
        if not job:
            return None
        return [
            row["target"]
            for row in self.db.rows(
                "SELECT target FROM job_items WHERE job_id=? ORDER BY rowid", (job["id"],)
            )
        ] or None

    def remember_catalog_order(self, job_id, baseline):
        targets = [
            row["target"]
            for row in self.db.rows(
                "SELECT target FROM job_items WHERE job_id=? ORDER BY rowid", (job_id,)
            )
        ]
        # A quick sweep listed only the works uploaded to since; they moved to the front.
        listed = set(targets)
        tail = [key for key in baseline or [] if key not in listed]
        self.db.set_setting("catalog_order", targets + tail)

    def discover(self, job_id, request, config, client, baseline=None):
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
            tail = None
            if baseline:
                listed = self.db.rows("SELECT target FROM job_items WHERE job_id=?", (job_id,))
                tail = CatalogTail(baseline, [row["target"] for row in listed])
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
                last = page >= page_count or bool(request.end_page and page >= request.end_page)
                if tail:
                    targets, caught_up = tail.feed(targets)
                    if last and not caught_up:
                        targets += tail.flush()
                    self.db.add_targets(job_id, targets, page + 1, page_count)
                    self.db.log(
                        job_id,
                        f"Catalog page {page}/{page_count}: {len(targets)} work(s) with uploads "
                        "since the last sweep.",
                    )
                    if caught_up:
                        self.db.log(
                            job_id,
                            "The rest of the catalog is unchanged since the last sweep; "
                            "run Everything to also pick up translation progress.",
                        )
                        break
                else:
                    self.db.add_targets(job_id, targets, page + 1, page_count)
                    self.db.log(
                        job_id,
                        f"Catalog page {page}/{page_count}: discovered {len(targets)} work(s).",
                    )
                if last:
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
        volumes = ordered_volumes(key, data, config.download_chinese_uploads)
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
            try:
                self.process_volume(
                    job_id, key, data, volume, chinese_only, request, config, client
                )
            except Cancelled, Deferred, PermissionError:
                raise
            except Exception as exc:
                failures[volume_id] = exc
                self.db.mark_part(job_id, key, volume_id, str(exc))
            else:
                self.db.mark_part(job_id, key, volume_id)
        if failures:
            raise VolumeFailures(failures, len(picked))

    def known_unavailable(self, job_id, key, volume_id, mode, stamp):
        """A format an earlier task found Novelia cannot supply. Retrying it in the same task,
        or a month later in case it was replaced under the same name, downloads it again."""
        known = self.db.unavailable(key, volume_id, mode)
        if (
            known
            and known["job_id"] != job_id
            and known["fingerprint"] == stamp
            and datetime.fromisoformat(known["checked_at"])
            > datetime.now(UTC) - UNAVAILABLE_RECHECK
        ):
            return known
        return None

    def note_repairs(self, job_id, volume_id, client):
        if client.repaired:
            self.db.log(
                job_id,
                f"{volume_id}: Novelia's copy had {len(client.repaired)} broken part(s) "
                f"({', '.join(client.repaired[:3])}); saved a repaired copy.",
                "warning",
            )

    def file_record(self, key, volume_id, mode):
        return self.db.row(
            "SELECT * FROM files WHERE work_key=? AND volume_id=? AND mode=?",
            (key, volume_id, mode),
        )

    @staticmethod
    def is_current(record, stamp, restore=False):
        """Whether the saved copy is of this upload and settings. A file deleted from disk stays
        downloaded, since that may have been on purpose, unless the task restores files."""
        if not record or record["fingerprint"] != stamp:
            return False
        raw = Path(record["raw_path"])
        if not raw.is_file():
            return not restore
        return raw.stat().st_size == record["size"]

    @staticmethod
    def stamp(volume, mode, config):
        """What a saved file depends on. An original changes only with its upload; Novelia's
        builds also change with translation progress and the translation settings."""
        if mode == ORIGINAL_JP:
            upload = {k: v for k, v in volume.items() if k not in ENGINES}
            return fingerprint({"volume": upload, "mode": mode})
        return fingerprint(
            {
                "volume": volume,
                "mode": mode,
                "translations": config.translations,
                "translations_mode": config.translations_mode,
            }
        )

    def destination(self, key, data, volume_id, mode):
        folder = self.root / mode_folder(mode) / component(key.replace("/", "_"), 50)
        wenku = key.startswith("wenku/")
        name = component(Path(volume_id).stem if wenku else data.get("titleJp") or key, 55)
        extension = ".txt" if wenku and volume_id.lower().endswith(".txt") else ".epub"
        return folder / f"{name}_{fingerprint(volume_id)[:10]} [{mode}]{extension}"

    def edition_path(self, source, edition):
        """Where an edition converted from bilingual `source` goes: its language's tree, in a
        folder named like the source's."""
        return (
            self.root
            / EDITION_FOLDERS[edition]
            / source.parent.name
            / f"{source.stem} [{edition}]{source.suffix}"
        )

    @staticmethod
    def edition_modes(config, request):
        """The modes to try, most wanted first, and how many of them a volume keeps."""
        modes = {"japanese": ORIGINAL_JP, "bilingual": config.source_mode, "chinese": CHINESE}
        if request.editions:
            return [modes[edition] for edition in request.editions], len(request.editions)
        return [modes[edition] for edition in config.editions], config.wanted_editions()

    def process_volume(self, job_id, key, data, volume, chinese_only, request, config, client):
        """Apply the download strategy: keep the first wanted editions Novelia can supply.

        An edition Novelia cannot supply is remembered and passed over for the next one; one that
        failed otherwise (a network error) keeps its place, so nothing stands in for it. Once
        every place is taken, the editions after the kept ones are stand-ins no longer needed."""
        volume_id = volume["volumeId"]
        modes, wanted = ([ORIGINAL_ZH], 1) if chinese_only else self.edition_modes(config, request)
        kept, failed, errors = [], 0, []
        for mode in modes:
            if len(kept) + failed == wanted:
                break
            stamp = self.stamp(volume, mode, config)
            record = self.file_record(key, volume_id, mode)
            current = self.is_current(record, stamp, request.restore)
            if (
                not request.force
                and not request.editions  # asked for by name: always try
                and not current
                and (known := self.known_unavailable(job_id, key, volume_id, mode, stamp))
            ):
                self.db.log(
                    job_id,
                    f"Skipped {volume_id} [{mode}]: {known['error']} Checked "
                    f"{known['checked_at'][:10]}; tried again when it changes.",
                    "warning",
                )
                continue
            try:
                kept.append(self.fetch(job_id, key, data, volume, mode, request, config, client))
            except Cancelled, Deferred, PermissionError:
                raise
            except UNAVAILABLE as exc:
                self.db.mark_unavailable(key, volume_id, mode, stamp, str(exc), job_id)
                self.db.log(job_id, f"{volume_id} [{mode}]: {exc}", "warning")
                errors.append(exc)
            except Exception as exc:
                self.db.log(job_id, f"{volume_id} [{mode}]: {exc}", "error")
                errors.append(exc)
                failed += 1
        if request.editions:
            for record in kept:
                self.db.pin(record["id"])
        elif len(kept) == wanted:
            self.drop_stand_ins(job_id, key, volume_id, modes, kept)
        for record in kept:
            if (
                config.auto_convert
                and record["mode"] in BILINGUAL_MODES
                and Path(record["raw_path"]).is_file()
            ):
                self.convert_file(job_id, record["id"], config, client, request.force)
        if len(kept) < wanted and errors:
            raise next((e for e in errors if is_retryable(e)), errors[0])
        if errors:
            stand_ins = ", ".join(f"[{r['mode']}]" for r in kept)
            self.db.log(job_id, f"{volume_id}: kept {stand_ins} instead.", "warning")

    def drop_stand_ins(self, job_id, key, volume_id, modes, kept):
        last = max(modes.index(record["mode"]) for record in kept)
        for mode in modes[last + 1 :]:
            record = self.file_record(key, volume_id, mode)
            if not record or record["pinned"]:
                continue
            try:
                for column in PATH_COLUMNS:
                    if record[column]:
                        Path(record[column]).unlink(missing_ok=True)
            except OSError as exc:
                # Often open in a reader. Caught here because a PermissionError would otherwise
                # stop the task as if Novelia refused access; the next check tries again.
                self.db.log(job_id, f"Could not remove {volume_id} [{mode}] yet: {exc}", "warning")
                continue
            self.db.execute("DELETE FROM files WHERE id=?", (record["id"],))
            self.db.log(job_id, f"Removed {volume_id} [{mode}]: no longer needed as a stand-in.")

    def fetch(self, job_id, key, data, volume, mode, request, config, client):
        """Download one format of a volume unless the saved copy is current; return its record."""
        volume_id = volume["volumeId"]
        stamp = self.stamp(volume, mode, config)
        record = self.file_record(key, volume_id, mode)
        if not request.force and self.is_current(record, stamp, request.restore):
            gone = (
                ""
                if Path(record["raw_path"]).is_file()
                else " (deleted from disk; kept as downloaded)"
            )
            self.db.log(job_id, f"Unchanged: {volume_id} [{mode}]{gone}")
            return record
        destination = self.destination(key, data, volume_id, mode)
        size, sha = client.source(
            key,
            volume_id,
            destination,
            original=mode in (ORIGINAL_JP, ORIGINAL_ZH),
            chinese=mode == CHINESE,
        )
        self.note_repairs(job_id, volume_id, client)
        if mode == ORIGINAL_JP:
            self.db.save_original(key, volume_id, stamp, destination, size, sha)
        else:
            self.db.save_file(key, volume_id, mode, stamp, destination, size, sha)
        self.db.log(job_id, f"Downloaded {volume_id} [{mode}] ({size // 1024} KB).")
        self.db.clear_unavailable(key, volume_id, mode)
        return self.file_record(key, volume_id, mode)

    def convert_file(self, job_id, file_id, config, client, force=False):
        """Build the chosen editions of a bilingual file, for volumes Novelia has no usable
        original of."""
        record = self.db.row("SELECT * FROM files WHERE id=?", (file_id,))
        if not record:
            raise ValueError(f"File {file_id} does not exist.")
        if record["mode"] not in BILINGUAL_MODES:
            reason = {
                ORIGINAL_JP: "is already the Japanese original",
                CHINESE: "is already Novelia's Chinese edition",
            }.get(record["mode"], "is a Chinese-only upload with no Japanese text")
            self.db.log(job_id, f"File {file_id} {reason}; nothing to convert.")
            return
        text = Path(record["raw_path"]).suffix.lower() == ".txt"
        if config.convert_japanese and not self.supplied(job_id, record, ORIGINAL_JP, force):
            if text:
                self.convert_text(job_id, record, client, force)
            else:
                self.convert_japanese(job_id, record, config, force)
        if config.convert_chinese and not self.supplied(job_id, record, CHINESE, force):
            if text:
                self.convert_text(job_id, record, client, force, chinese=True)
            else:
                self.convert_chinese(job_id, record, force)

    def supplied(self, job_id, record, mode, force):
        """Whether Novelia's own edition of the volume is saved: it beats a converted one,
        unless one is asked for anyway."""
        saved = self.file_record(record["work_key"], record["volume_id"], mode)
        if force or not saved or not Path(saved["raw_path"]).is_file():
            return False
        self.db.log(job_id, f"{record['volume_id']}: [{mode}] is saved; not converted.")
        return True

    def source_of(self, job_id, record):
        source = Path(record["raw_path"])
        if not source.is_file():
            raise FileNotFoundError("Source file is missing. Run a download task to restore it.")
        self.check(job_id)
        validate_epub(source)
        return source

    def convert_japanese(self, job_id, record, config, force):
        file_id = record["id"]
        previous = json.loads(record["report"] or "{}")
        if (
            not force
            and record["ja_path"]
            and Path(record["ja_path"]).is_file()
            and previous.get("vertical") == config.vertical
        ):
            self.db.log(job_id, f"File {file_id}: Japanese output already up to date.")
            return
        source = self.source_of(job_id, record)
        work = self.db.row("SELECT * FROM works WHERE key=?", (record["work_key"],))
        data = json.loads(work["metadata"])
        output = self.edition_path(source, "ja")
        report = convert_epub(
            source,
            output,
            vertical=config.vertical,
            title_jp=data.get("titleJp", "") if work["kind"] == "web" else "",
            introduction_jp=data.get("introductionJp", ""),
            authors=json.loads(work["authors"]),
            toc=data.get("toc", []),
        )
        if report.kept_ja == 0:
            output.unlink(missing_ok=True)
            raise ValueError("No Japanese paragraph markers found; source was preserved.")
        validate_epub(output)
        if record["ja_path"] and Path(record["ja_path"]) != output:
            Path(record["ja_path"]).unlink(missing_ok=True)
        self.db.execute(
            "UPDATE files SET ja_path=?,status='converted',verification=NULL,report=?,updated_at=? "
            "WHERE id=?",
            (str(output), json.dumps(asdict(report)), now(), file_id),
        )
        self.db.log(job_id, f"Converted file {file_id}: {report.describe()}")

    def convert_chinese(self, job_id, record, force):
        """The translations alone; Japanese lines without one stay as they are."""
        file_id = record["id"]
        if not force and record["zh_path"] and Path(record["zh_path"]).is_file():
            self.db.log(job_id, f"File {file_id}: Chinese output already up to date.")
            return
        source = self.source_of(job_id, record)
        output = self.edition_path(source, "zh")
        report = convert_epub(
            source, output, chinese=True, translation_first=record["mode"] == "zh-jp"
        )
        if report.kept_zh == 0:
            output.unlink(missing_ok=True)
            raise ValueError("No translated paragraphs found; source was preserved.")
        validate_epub(output)
        self.db.execute(
            "UPDATE files SET zh_path=?,updated_at=? WHERE id=?", (str(output), now(), file_id)
        )
        self.db.log(job_id, f"Converted file {file_id} to Chinese: {report.describe()}")

    def convert_text(self, job_id, record, client, force, chinese=False):
        """A text volume's bilingual file interleaves Japanese and Chinese lines without markers,
        so its editions are Novelia's own: the uploaded original, or its Chinese build."""
        source = Path(record["raw_path"])
        column, label = ("zh_path", "Chinese") if chinese else ("ja_path", "Japanese")
        output = self.edition_path(source, column[:2])
        if (
            not force
            and record[column]
            and Path(record[column]).is_file()
            and (chinese or record["verification"] == "original")
        ):
            self.db.log(job_id, f"File {record['id']}: {label} text already saved.")
            return
        client.source(
            record["work_key"], record["volume_id"], output, original=not chinese, chinese=chinese
        )
        if chinese:
            self.db.execute(
                "UPDATE files SET zh_path=?,updated_at=? WHERE id=?",
                (str(output), now(), record["id"]),
            )
        else:
            self.db.execute(
                "UPDATE files SET ja_path=?,status='converted',verification='original',report=NULL,"
                "updated_at=? WHERE id=?",
                (str(output), now(), record["id"]),
            )
        self.db.log(job_id, f"Saved the {label} text of file {record['id']}.")
