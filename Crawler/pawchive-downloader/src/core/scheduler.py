import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from queue import Empty, Queue
from typing import Dict, List, Optional

from ..common.logger import Logger
from .downloader import Downloader
from .models import DownloadTask, TaskStatus, TaskType
from .storage import Storage


class Scheduler:
    """Runs downloads and post-list syncs on a bounded thread pool.

    Tasks arrive either manually (``queue_manual``/``queue_batch``/``queue_sync``)
    or from per-artist / global timers checked once a second in a background loop.
    One artist is never queued twice concurrently, whatever the task type.
    """

    def __init__(self, storage: Storage, downloader: Downloader, logger: Logger,
                 global_timer: Optional[Dict], max_workers: int = 3):
        self.storage = storage
        self.downloader = downloader
        self.logger = logger
        self.global_timer = global_timer
        self.max_workers = max_workers

        self.running = False
        self._thread: Optional[threading.Thread] = None
        self._executor: Optional[ThreadPoolExecutor] = None
        self._next_runs: Dict[str, datetime] = {}

        self.queue: "Queue[DownloadTask]" = Queue()
        self.queued: set = set()
        self.active: Dict[str, DownloadTask] = {}
        self.completed: List[DownloadTask] = []
        self.lock = threading.Lock()
        self._cancelling = False

    # ==================== Lifecycle ====================

    def start(self):
        if self.running:
            return
        self.running = True
        self._executor = ThreadPoolExecutor(max_workers=self.max_workers)
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        self.logger.scheduler_started(max_workers=self.max_workers)

    def stop(self):
        self.running = False
        if self._thread:
            self._thread.join(timeout=5)
        if self._executor:
            self._executor.shutdown(wait=False, cancel_futures=True)
        self.logger.scheduler_stopped()

    # ==================== Cancellation ====================
    # Marking the artist is what cancels it; the downloader keeps that flag until
    # the run itself clears it, so a wait that times out here still leaves the
    # task cancelled. Aborting in-flight HTTP only makes it land sooner, and is
    # reserved for `cancel_all`: doing it for one artist would also interrupt the
    # requests of every other artist still downloading.

    CANCEL_TIMEOUT = 30

    def _drain_queue(self, artist_id: Optional[str] = None):
        """Remove one queued task, or all of them. Caller holds the lock."""
        kept = []
        while True:
            try:
                task = self.queue.get_nowait()
            except Empty:
                break
            if artist_id is not None and task.artist_id != artist_id:
                kept.append(task)
        for task in kept:
            self.queue.put(task)
        self.queued = set(kept)

    def _await_exit(self, artist_ids: List[str]) -> List[str]:
        """Wait for these artists to leave `active`; returns those still running."""
        deadline = time.time() + self.CANCEL_TIMEOUT
        while time.time() < deadline:
            with self.lock:
                remaining = [a for a in artist_ids if a in self.active]
            if not remaining:
                return []
            time.sleep(0.1)
        return remaining

    def cancel(self, artist_id: str) -> Optional[str]:
        """Cancel one artist. Returns 'queued', 'running', or None if neither."""
        with self.lock:
            if any(t.artist_id == artist_id for t in self.queued):
                self._drain_queue(artist_id)
                self.logger.scheduler_cancelled(artist_id=artist_id, state='queued')
                return 'queued'
            if artist_id not in self.active:
                return None

        self.downloader.cancel(artist_id)
        if self._await_exit([artist_id]):
            self.logger.scheduler_cancel_timeout(artist_id=artist_id, level='warning')
        self.logger.scheduler_cancelled(artist_id=artist_id, state='running')
        return 'running'

    def cancel_all(self) -> int:
        """Cancel every queued and running download. Returns how many were running."""
        with self.lock:
            self._cancelling = True
            self._drain_queue()
            active = list(self.active)
        try:
            if not active:
                return 0
            self.downloader.cancel(*active)
            self.downloader.abort_requests()
            try:
                stuck = self._await_exit(active)
                if stuck:
                    self.logger.scheduler_cancel_timeout(remaining=len(stuck), level='warning')
            finally:
                self.downloader.resume_requests()
            self.logger.scheduler_cancelled_all(running=len(active))
            return len(active)
        finally:
            self._cancelling = False

    # ==================== Queueing ====================

    # Which posts a download covers is carried as flags on the task, so one pair
    # of methods serves the plain queue and every subset (lost/pending/failed).

    def queue_manual(self, artist_id: str, from_date: str = None, until_date: str = None,
                     lost: bool = False, pending: bool = False, failed: bool = False) -> bool:
        return self._add(DownloadTask(artist_id, from_date, until_date, lost=lost,
                                      pending=pending, failed=failed,
                                      task_type=TaskType.MANUAL))

    def queue_batch(self, artist_ids: List[str], lost: bool = False,
                    pending: bool = False, failed: bool = False) -> int:
        return sum(self.queue_manual(aid, lost=lost, pending=pending, failed=failed)
                   for aid in artist_ids)

    def queue_sync(self, artist_id: str, deep: bool = False, lost: bool = False) -> bool:
        """Queue a post-list refresh. A sync and a download write the same
        cache, so the one-task-per-artist rule has to cover both.

        `lost` reclaims lost posts the server has restored."""
        return self._add(DownloadTask(artist_id, deep=deep, recover_lost=lost,
                                      task_type=TaskType.SYNC))

    def queue_sync_batch(self, artist_ids: List[str], deep: bool = False,
                         lost: bool = False) -> int:
        return sum(self.queue_sync(aid, deep, lost) for aid in artist_ids)

    def _add(self, task: DownloadTask) -> bool:
        with self.lock:
            if task.artist_id in self.active:
                return False
            if any(t.artist_id == task.artist_id for t in self.queued):
                return False
            self.queued.add(task)
            self.queue.put(task)
            self.logger.scheduler_queued(artist_id=task.artist_id, type=task.task_type)
            return True

    # ==================== Status ====================

    def status(self) -> Dict[str, int]:
        with self.lock:
            return {'queued': self.queue.qsize(), 'running': len(self.active),
                    'completed': len(self.completed)}

    def list_active(self) -> List[DownloadTask]:
        with self.lock:
            return list(self.active.values())

    def list_queued(self) -> List[DownloadTask]:
        with self.lock:
            return list(self.queue.queue)

    # ==================== Loop ====================

    def _loop(self):
        while self.running:
            try:
                self._check_timers()
                self._process()
                time.sleep(1)
            except Exception as e:
                self.logger.scheduler_error(error=str(e), level='error')
                time.sleep(5)

    def _process(self):
        with self.lock:
            # Starting a task mid-cancel would meet the request abort and finish
            # as a no-op that looks successful.
            if self._cancelling or len(self.active) >= self.max_workers or self.queue.empty():
                return
            task = self.queue.get_nowait()
            self.queued.discard(task)
            self.active[task.artist_id] = task
        future = self._executor.submit(self._execute, task)
        future.add_done_callback(lambda f: self._finish(task))

    def _execute(self, task: DownloadTask):
        task.status = TaskStatus.RUNNING
        task.started_at = datetime.now()
        try:
            artist = self.storage.get_artist(task.artist_id)
            if not artist:
                raise Exception(f"Artist {task.artist_id} not found")
            if task.task_type == TaskType.SYNC:
                # Outcome goes on the task: nobody is waiting at the prompt.
                counts = self.downloader.update_posts(
                    artist, detect_edits=task.deep, recover_lost=task.recover_lost)
                task.note = self._sync_note(counts, task)
            else:
                self.downloader.download_artist(
                    artist, task.from_date, task.until_date, lost=task.lost,
                    pending=task.pending, failed=task.failed)
            task.status = TaskStatus.COMPLETED
        except Exception as e:
            task.status = TaskStatus.FAILED
            task.error = str(e)
            self.logger.scheduler_task_failed(artist_id=task.artist_id, error=str(e), level='error')
        finally:
            task.finished_at = datetime.now()

    @staticmethod
    def _sync_note(counts: Dict[str, int], task: DownloadTask) -> str:
        parts = [f"{counts['new']} new"]
        if task.deep:
            parts.append(f"{counts['edited']} edited")
        if counts['lost']:
            parts.append(f"{counts['lost']} now lost")
        if task.recover_lost:
            parts.append(f"{counts['recovered']} recovered")
        return ", ".join(parts)

    def _finish(self, task: DownloadTask):
        with self.lock:
            self.active.pop(task.artist_id, None)
            self.completed.append(task)
            self.completed = self.completed[-100:]

    # ==================== Timers ====================

    def _check_timers(self):
        for artist in self.storage.get_artists():
            if artist.ignore or artist.completed:
                continue
            timer = artist.timer or self.global_timer
            if timer and self._due(artist.id, timer):
                self._add(DownloadTask(artist.id, task_type=TaskType.SCHEDULED))

    def _due(self, artist_id: str, timer: Dict) -> bool:
        now = datetime.now()
        if artist_id not in self._next_runs:
            self._next_runs[artist_id] = self._next(timer, now)
            return False
        if now >= self._next_runs[artist_id]:
            self._next_runs[artist_id] = self._next(timer, now)
            return True
        return False

    @staticmethod
    def _next(timer: Dict, frm: datetime) -> datetime:
        hour, minute = map(int, timer.get("time", "00:00").split(":"))
        nxt = frm.replace(hour=hour, minute=minute, second=0, microsecond=0)
        kind = timer.get("type", "daily")
        if kind == "daily":
            if nxt <= frm:
                nxt += timedelta(days=1)
        elif kind == "weekly":
            days = (timer.get("day", 0) - frm.weekday()) % 7 or 7
            nxt += timedelta(days=days)
        elif kind == "monthly":
            nxt = nxt.replace(day=timer.get("day", 1))
            if nxt <= frm:
                nxt = (nxt.replace(year=frm.year + 1, month=1) if frm.month == 12
                       else nxt.replace(month=frm.month + 1))
        return nxt
