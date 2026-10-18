"""The job queue and the timer loop.

Jobs live in the database so a restart resumes them: a job left `running` by a
killed process goes back to `queued`. One creator never runs two jobs at once.
Progress lines are kept in memory only; the outcome is written to the job row.
"""

import threading
import traceback
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from ..domain.timefmt import now_utc
from ..net.limiter import QuotaExceeded
from ..sources.fanbox import SessionRejected
from ..store.db import dump, load
from .context import Context
from .download import Downloader
from .sync import Stopped, refresh_subscriptions, sync_creator

# How often a saved Fanbox creator's status is re-checked in the background, and how long
# a probe that failed waits before the same creator is tried again.
PROBE_EVERY = timedelta(days=7)
PROBE_RETRY = timedelta(hours=6)


class JobRunner:
    def __init__(self, ctx: Context, workers: int):
        self.ctx = ctx
        self.workers = max(1, workers)
        self.progress: dict[int, str] = {}
        self.cancels: dict[int, threading.Event] = {}
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self.handlers: dict[str, Callable[[int, dict, threading.Event], str]] = {
            "sync": self._sync,
            "download": self._download,
            "subscriptions": self._subscriptions,
            "migration": self._migration,
            "probe": self._probe_one,
            "move": self._move,
        }
        self._probed: dict[str, datetime] = {}

    # ---- lifecycle ----

    def start(self):
        # A job interrupted by a stop resumes; one whose cancel was requested stays cancelled.
        self.ctx.db.run(
            "UPDATE jobs SET status='cancelled', finished_at=? WHERE status='running' AND note='cancelling'",
            (now_utc(),),
        )
        self.ctx.db.run("UPDATE jobs SET status='queued', started_at=NULL WHERE status='running'")
        for i in range(self.workers):
            t = threading.Thread(target=self._loop, name=f"job-{i}", daemon=True)
            t.start()
            self._threads.append(t)
        t = threading.Thread(target=self._timers, name="timers", daemon=True)
        t.start()
        self._threads.append(t)

    def shutdown(self):
        self._stop.set()
        for event in list(self.cancels.values()):
            event.set()
        self.ctx.pawchive_http.stop()
        self.ctx.fanbox_http.stop()
        self._wake.set()
        for t in self._threads:
            t.join(timeout=10)

    # ---- queue ----

    def enqueue(
        self, kind: str, creator_id: str | None = None, params: dict | None = None, note: str = ""
    ) -> int:
        if kind not in self.handlers:
            raise ValueError(f"unknown job kind {kind!r}")
        with self._lock:
            same = self.ctx.db.one(
                "SELECT id FROM jobs WHERE kind=? AND IFNULL(creator_id,'')=? AND params=? "
                "AND status='queued'",
                (kind, creator_id or "", dump(params or {})),
            )
            if same:
                return same["id"]
            with self.ctx.db.tx() as conn:
                job_id = conn.execute(
                    "INSERT INTO jobs(kind, creator_id, params, status, created_at, note) "
                    "VALUES(?,?,?,?,?,?)",
                    (kind, creator_id, dump(params or {}), "queued", now_utc(), note or None),
                ).lastrowid
        self._wake.set()
        assert job_id is not None
        return job_id

    def cancel(self, job_id: int) -> bool:
        event = self.cancels.get(job_id)
        if event:
            event.set()
            self.ctx.db.run("UPDATE jobs SET note='cancelling' WHERE id=?", (job_id,))
            return True
        return (
            self.ctx.db.run(
                "UPDATE jobs SET status='cancelled', finished_at=? WHERE id=? AND status='queued'",
                (now_utc(), job_id),
            )
            > 0
        )

    def cancel_all(self) -> int:
        n = self.ctx.db.run(
            "UPDATE jobs SET status='cancelled', finished_at=? WHERE status='queued'", (now_utc(),)
        )
        for job_id, event in list(self.cancels.items()):
            event.set()
            self.ctx.db.run("UPDATE jobs SET note='cancelling' WHERE id=?", (job_id,))
        return n + len(self.cancels)

    def _claim(self) -> tuple[int, str, str | None, dict] | None:
        with self._lock, self.ctx.db.tx() as conn:
            busy = {
                r["creator_id"]
                for r in conn.execute("SELECT creator_id FROM jobs WHERE status='running'")
                if r["creator_id"]
            }
            for row in conn.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY id"):
                if row["creator_id"] and row["creator_id"] in busy:
                    continue
                conn.execute(
                    "UPDATE jobs SET status='running', started_at=? WHERE id=?",
                    (now_utc(), row["id"]),
                )
                return row["id"], row["kind"], row["creator_id"], load(row["params"], {}) or {}
        return None

    def _loop(self):
        while not self._stop.is_set():
            claimed = self._claim()
            if claimed is None:
                self._wake.wait(5)
                self._wake.clear()
                continue
            job_id, kind, creator_id, params = claimed
            cancel = threading.Event()
            self.cancels[job_id] = cancel
            params = {**params, "creator_id": creator_id}
            status, note, error = "done", "", None
            try:
                note = self.handlers[kind](job_id, params, cancel)
            except Stopped:
                status, note = "cancelled", "cancelled"
            except SessionRejected as e:
                status, error = "failed", str(e)
                self.ctx.events.log("error", str(e), creator_id)
            except QuotaExceeded as e:
                status, note = "done", f"quota spent: {e}"
            except Exception as e:
                status, error = "failed", f"{type(e).__name__}: {e}"
                self.ctx.events.log("error", f"Job #{job_id} failed: {error}", creator_id)
                traceback.print_exc()
            finally:
                self.cancels.pop(job_id, None)
                self.progress.pop(job_id, None)
            self.ctx.db.run(
                "UPDATE jobs SET status=?, finished_at=?, note=?, error=? WHERE id=?",
                (status, now_utc(), note, error, job_id),
            )
            # Background probes are routine; only their failures are worth a log line.
            if status == "done" and note and kind != "probe":
                self.ctx.events.log("info", f"{self._label(kind, creator_id)}: {note}", creator_id)

    def _label(self, kind: str, creator_id: str | None) -> str:
        names = {
            "sync": "Sync",
            "download": "Download",
            "subscriptions": "Refresh plans",
            "migration": "Migration",
            "move": "Move",
        }
        if creator_id:
            row = self.ctx.creator(creator_id)
            who = (row["alias"] or row["name"]) if row else creator_id
            return f"{names.get(kind, kind)} {who}"
        return names.get(kind, kind)

    def _reporter(self, job_id: int) -> Callable[[str], None]:
        def report(message: str):
            self.progress[job_id] = message

        return report

    # ---- handlers ----

    def _sync(self, job_id: int, params: dict, cancel: threading.Event) -> str:
        sources = tuple(params.get("sources") or ("pawchive", "fanbox"))
        return sync_creator(
            self.ctx,
            params["creator_id"],
            self._reporter(job_id),
            cancel,
            deep=bool(params.get("deep")),
            sources=sources,
        ).summary()

    def _download(self, job_id: int, params: dict, cancel: threading.Event) -> str:
        notes = []
        if not params.get("skip_sync"):
            notes.append(self._sync(job_id, params, cancel))
        result = Downloader(self.ctx, cancel, self._reporter(job_id)).creator(
            params["creator_id"],
            post_ids=params.get("post_ids"),
            force=params.get("force"),
            redownload=bool(params.get("redownload")),
        )
        return " · ".join([*notes, result.summary()])

    def _subscriptions(self, job_id: int, params: dict, cancel: threading.Event) -> str:
        n = refresh_subscriptions(self.ctx)
        return f"supporting {n} plans"

    def _probe_one(self, job_id: int, params: dict, cancel: threading.Event) -> str:
        return sync_creator(
            self.ctx,
            params["creator_id"],
            self._reporter(job_id),
            cancel,
            sources=("fanbox",),
            details=False,
        ).summary()

    def _probe(self):
        """Keep every saved Fanbox creator's status fresh: one cheap list-only probe at a
        time, and only while nothing else is queued, so it never delays real work."""
        if not self.ctx.fanbox_usable():
            return
        if self.ctx.db.one("SELECT 1 FROM jobs WHERE status='queued'"):
            return
        due = (datetime.now(UTC) - PROBE_EVERY).replace(tzinfo=None).isoformat()
        due = max(due, self.ctx.db.kv_get("fanbox_access_changed", "") or "")
        now = datetime.now()
        for row in self.ctx.db.all(
            "SELECT id FROM creators WHERE service='fanbox' AND ignore=0 "
            "AND (fanbox_listed_at IS NULL OR fanbox_listed_at < ?) "
            "AND id NOT IN (SELECT creator_id FROM jobs WHERE status='running' AND creator_id IS NOT NULL) "
            "ORDER BY fanbox_listed_at IS NOT NULL, fanbox_listed_at",
            (due,),
        ):
            tried = self._probed.get(row["id"])
            if tried and now - tried < PROBE_RETRY:
                continue
            self._probed[row["id"]] = now
            self.enqueue("probe", row["id"], {}, note="Fanbox status")
            return

    def _migration(self, job_id: int, params: dict, cancel: threading.Event) -> str:
        from ..library.migrate import execute

        result = execute(self.ctx, int(params["plan_id"]), self._reporter(job_id))
        return f"{result['done']} done" + (
            f", {result['failed']} failed" if result["failed"] else ""
        )

    def _move(self, job_id: int, params: dict, cancel: threading.Event) -> str:
        # A job, not a request: the creator's own jobs run one at a time, so no download is
        # writing into the folder while it moves.
        from ..library.layout import move_creator

        return move_creator(
            self.ctx,
            params["creator_id"],
            params["group"],
            params.get("alias"),
            self._reporter(job_id),
        )

    # ---- timers ----

    @staticmethod
    def next_run(timer: dict, after: datetime) -> datetime:
        hour, minute = map(int, str(timer.get("time", "00:00")).split(":"))
        base = after.replace(hour=hour, minute=minute, second=0, microsecond=0)
        kind = timer.get("type", "daily")
        if kind == "weekly":
            days = (int(timer.get("day", 0)) - after.weekday()) % 7
            nxt = base + timedelta(days=days)
            return nxt if nxt > after else nxt + timedelta(days=7)
        if kind == "monthly":
            day = min(max(1, int(timer.get("day", 1))), 28)
            nxt = base.replace(day=day)
            if nxt <= after:
                month = nxt.month % 12 + 1
                nxt = nxt.replace(year=nxt.year + (nxt.month == 12), month=month)
            return nxt
        return base if base > after else base + timedelta(days=1)

    def _timers(self):
        """Timers are in local wall time, as v1's were. Each creator remembers when its
        timer last fired, so a restart does not re-run a day's download."""
        while not self._stop.wait(30):
            try:
                self._fire_timers()
                self._probe()
            except Exception:
                traceback.print_exc()

    def _fire_timers(self):
        if not self.ctx.settings.timers_enabled:
            # Forget the bookkeeping, so enabling timers starts from now rather than
            # firing for every slot that passed while they were off.
            if self.ctx.db.kv_get("timers"):
                self.ctx.db.kv_set("timers", {})
            return
        now = datetime.now()
        global_timer = self.ctx.settings.global_timer
        fired = self.ctx.db.kv_get("timers", {}) or {}
        changed = False
        for c in self.ctx.db.all("SELECT id, timer FROM creators WHERE ignore=0 AND completed=0"):
            timer = load(c["timer"]) or global_timer
            if not timer:
                continue
            last = fired.get(c["id"])
            if last is None:
                fired[c["id"]] = now.isoformat(timespec="seconds")
                changed = True
                continue
            if self.next_run(timer, datetime.fromisoformat(last)) <= now:
                self.enqueue("download", c["id"], {}, note="timer")
                fired[c["id"]] = now.isoformat(timespec="seconds")
                changed = True
        if changed:
            self.ctx.db.kv_set("timers", fired)
