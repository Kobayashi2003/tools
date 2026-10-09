"""Background work: crawl jobs that grow the library, and the two metadata stages.

The library only grows, along two edges, so it stays complete between them:

    newer  "Update" walks sukebei's newest FC2 uploads (newest first) and stops at the first
           torrent it already holds, so a run fetches only what is new. It runs on a timer.
           sukebei answers at most 1000 results (~10 days of FC2 uploads) per query; when more
           than that piled up since the last update, the run reports a gap.
    older  "Older" walks FC2 ids downward one block at a time. A block is a 4-digit id prefix:
           the query "4802*" matches FC2-PPV-4802xxx and the shorter ids starting 4802 (480259,
           48025). The 9000 blocks 1000-9999 therefore cover every id of 5 to 7 digits. The walk
           starts at the newest block, goes down to 1000, then wraps to 9999 and comes down to
           just above where it started, which reads the old 5-6 digit ids whose prefixes are
           larger than the newest 7-digit one (FC2-PPV-958123, prefix 9581). A block holds a few
           hundred torrents, under sukebei's cap, so it is read completely; one that still hits
           the cap (prefixes such as 1080 or 2024 also match "1080p" or years) is split into ten
           5-digit blocks. Progress is saved after every block, so the walk resumes where it
           stopped and never leaves holes.

Metadata per title runs in two stages with separate queues:

    fc2 stage  (several workers)  title, cover, seller, tags, sample images — fills cards quickly
    pp stage   (one worker)       paipancon preview clips and contact sheet

paipancon rate-limits hard (~10 pages per minute sustained), so it gets a single worker and its
own pacing. Each queue is ordered by priority — what the user is looking at, then new uploads,
then history — so a long history walk never delays new titles. A source that errors is retried
automatically a few times, refetching only that source.
"""

import collections
import heapq
import itertools
import threading
import time

from . import fc2, paipancon, sukebei
from .net import FetchError

PER_JOB_PAGE_LIMIT = -(-sukebei.MAX_RESULTS // sukebei.PAGE_SIZE)   # 14: sukebei stops at 1000 results
AUTO_RETRY_ATTEMPTS = 3
AUTO_RETRY_SECONDS = 180
STAGES = ("fc2", "pp")
URGENT, NEW, HISTORY = 0, 1, 2              # queue priorities, lowest first
BLOCK_DIGITS = 4                            # history blocks are 4-digit id prefixes,
LAST_BLOCK = 10 ** (BLOCK_DIGITS - 1)       # 1000 ...
FIRST_BLOCK = 10 ** BLOCK_DIGITS - 1        # ... 9999
TOTAL_BLOCKS = FIRST_BLOCK - LAST_BLOCK + 1
MAX_PREFIX_DIGITS = 8
UPDATE_RETRY_SECONDS = 600                  # after a failed or cancelled automatic Update


class Cancelled(Exception):
    pass


def next_block(cursor, top):
    """The block after `cursor` in a walk that started at `top`, or None when it is complete."""
    following = cursor - 1 if cursor > LAST_BLOCK else FIRST_BLOCK
    return None if following == top else following


def blocks_read(top, cursor, done):
    """How many blocks a walk that started at `top` has read when `cursor` is next."""
    if done:
        return TOTAL_BLOCKS
    if top is None or cursor is None:
        return 0
    return top - cursor if cursor <= top else (top - LAST_BLOCK + 1) + (FIRST_BLOCK - cursor)


class StageQueue:
    """Blocking priority queue of FC2 ids.

    Lower priorities come first; within a priority, ids come in the order they were added, or
    newest first when added with `newest_first` (the title the user looked at last leads).
    Adding a queued id again with a better priority (or newest_first) moves it; `unfinished`
    counts ids queued or taken but not yet done.
    """

    def __init__(self):
        self._heap = []
        self._queued = {}                   # id -> (priority, order) of its live heap entry
        self._taken = set()                 # ids handed to a worker and not done yet
        self._order = itertools.count()
        self._cond = threading.Condition()
        self._closed = False
        self.unfinished = 0

    def put(self, item, priority, newest_first=False):
        """Queue `item`; returns True when it was not queued before."""
        with self._cond:
            current = self._queued.get(item)
            if current is not None and (current[0] < priority or (current[0] == priority and not newest_first)):
                return False
            order = next(self._order)
            entry = (priority, -order if newest_first else order)
            self._queued[item] = entry                  # older heap entries for item are now stale
            heapq.heappush(self._heap, (*entry, item))
            if current is None:
                self.unfinished += 1
            self._cond.notify()
            return current is None

    def get(self, block=True):
        """Next id by priority; None when closed (or empty, if not blocking)."""
        with self._cond:
            while True:
                while self._heap:
                    priority, order, item = heapq.heappop(self._heap)
                    if self._queued.get(item) == (priority, order):     # skip superseded entries
                        del self._queued[item]
                        self._taken.add(item)       # atomically: never seen as neither queued nor taken
                        return item
                if self._closed or not block:
                    return None
                self._cond.wait()

    def busy(self, item):
        """True while a worker holds `item`."""
        with self._cond:
            return item in self._taken

    def done(self, item):
        with self._cond:
            self._taken.discard(item)
            self.unfinished -= 1

    def close(self):
        with self._cond:
            self._closed = True
            self._cond.notify_all()

    def ids(self):
        """Queued ids in the order they will be taken."""
        with self._cond:
            return [item for priority, order, item in sorted(self._heap)
                    if self._queued.get(item) == (priority, order)]

    def __len__(self):
        with self._cond:
            return len(self._queued)


class Crawler:
    def __init__(self, store, http, media, settings):
        self.store = store
        self.http = http
        self.media = media
        self.settings = settings
        self.log_lines = collections.deque(maxlen=300)
        self._queues = {stage: StageQueue() for stage in STAGES}
        self._priority = {}          # id -> priority it carries through both stages
        self._active = {}            # worker name -> fc2 id being fetched
        self._reset_at = {}          # id -> monotonic time of its last refresh
        self._stop = threading.Event()
        self._job = None
        self._job_lock = threading.Lock()
        self._job_cancel = threading.Event()
        self._threads = []

    # --- lifecycle ----------------------------------------------------------------------

    def start(self):
        self.http.on_retry = lambda host, error, wait: self.log(
            f"{host}: {error}; retrying in {wait:.0f} s", "warn")
        workers = [("fc2", f"fc2-{i + 1}") for i in range(self.settings.workers)] + [("pp", "paipancon")]
        for stage, name in workers:
            thread = threading.Thread(target=self._worker, args=(stage,), name=name, daemon=True)
            thread.start()
            self._threads.append(thread)
        threading.Thread(target=self._auto_retry, name="auto-retry", daemon=True).start()
        threading.Thread(target=self._watch, name="watch", daemon=True).start()
        unfinished = self.store.unfinished_ids()
        if unfinished:
            self.log(f"Resuming metadata lookup for {len(unfinished)} title(s).")
        self.schedule(unfinished, NEW)

    def close(self, timeout=5):
        """Stop the workers and give in-flight fetches a moment to finish before the store closes."""
        self._stop.set()
        self._job_cancel.set()
        for q in self._queues.values():
            q.close()
        deadline = time.monotonic() + timeout
        for thread in self._threads:
            thread.join(max(0.0, deadline - time.monotonic()))

    def idle(self):
        """True when no job runs and every queued title has been fully processed."""
        with self._job_lock:
            running = bool(self._job and self._job["running"])
        return not running and all(q.unfinished == 0 for q in self._queues.values())

    def log(self, message, level="info"):
        self.log_lines.append({"at": int(time.time()), "level": level, "message": message})

    # --- scheduling ---------------------------------------------------------------------

    def schedule(self, fc2_ids, priority=NEW, force=False):
        """Queue each id for the first stage it still needs. Returns how many were newly queued.

        An id being fetched right now is skipped unless `force` (a refresh discards that fetch).
        """
        added = 0
        for fc2_id, stage in self.store.next_stage(list(fc2_ids)).items():
            if self._queues[stage].busy(fc2_id) and not force:
                continue
            best = min(priority, self._priority.get(fc2_id, priority))
            self._priority[fc2_id] = best
            added += self._queues[stage].put(fc2_id, best, newest_first=priority == URGENT)
        return added

    def prioritize(self, fc2_id):
        """Fetch this title next in every stage it still needs (the user is looking at it)."""
        return self.schedule([fc2_id], URGENT)

    def refresh(self, fc2_id):
        """Re-fetch a title from every source and drop its cached media (e.g. placeholder covers)."""
        title = self.store.title(fc2_id)
        if title:
            self.media.forget([title["cover"], title["cover_full"], title["grid"], *title["clips"],
                               *(s["thumb"] for s in title["samples"]), *(s["full"] for s in title["samples"])])
        # A fetch already in flight for this title started before the reset; its result is dropped.
        self._reset_at[fc2_id] = time.monotonic()
        self.store.reset_sources(fc2_id, everything=True, reset_attempts=True)
        self.schedule([fc2_id], URGENT, force=True)

    def retry_failed(self, max_attempts=None, reset_attempts=True):
        ids = self.store.failed_ids(max_attempts)
        for fc2_id in ids:
            self.store.reset_sources(fc2_id, reset_attempts=reset_attempts)
        return self.schedule(ids, NEW)

    def _auto_retry(self):
        while not self._stop.wait(AUTO_RETRY_SECONDS):
            if any(len(q) for q in self._queues.values()):
                continue
            queued = self.retry_failed(max_attempts=AUTO_RETRY_ATTEMPTS, reset_attempts=False)
            if queued:
                self.log(f"Retrying {queued} title(s) whose sources failed.")

    # --- stages -------------------------------------------------------------------------

    def _worker(self, stage):
        name = threading.current_thread().name
        q = self._queues[stage]
        while not self._stop.is_set():
            fc2_id = q.get()
            if fc2_id is None:
                break
            self._active[name] = fc2_id
            started = time.monotonic()
            try:
                if stage == "fc2":
                    self.fetch_fc2(fc2_id, started)
                else:
                    self.fetch_paipancon(fc2_id, started)
            except Exception as exc:                     # never let one title kill a worker
                if not self._stop.is_set():              # shutting down: the store may be closed
                    self._save(fc2_id, stage, {f"{stage}_state": "error"}, str(exc), started)
                    self.log(f"FC2-PPV-{fc2_id}: {exc}", "error")
            finally:
                self._active.pop(name, None)
                try:
                    if not self._stop.is_set():
                        self._hand_over(fc2_id)
                finally:
                    # Only after the hand-over, so idle() never sees a title between two stages.
                    q.done(fc2_id)

    def _hand_over(self, fc2_id):
        """Queue the next stage (or re-run one whose result a refresh discarded) at the same priority.

        Runs while this worker still holds the id, hence `force` past the busy check.
        """
        if self.store.next_stage([fc2_id]):
            self.schedule([fc2_id], self._priority.get(fc2_id, NEW), force=True)
        else:
            self._priority.pop(fc2_id, None)

    def _save(self, fc2_id, stage, fields, error="", started=None):
        """Store a stage result unless the title was refreshed after this fetch began."""
        if started is not None and self._reset_at.get(fc2_id, 0) > started:
            return False
        self.store.save_source(fc2_id, stage, fields, error=error)
        return True

    def fetch_fc2(self, fc2_id, started=None):
        try:
            article = fc2.fetch_article(self.http, fc2_id)
        except FetchError as exc:
            self._save(fc2_id, "fc2", {"fc2_state": "error"}, str(exc), started)
            self.log(f"FC2-PPV-{fc2_id}: FC2: {exc}", "warn")
            return
        fields = {"fc2_state": "ok" if article else "removed"}
        if article:
            fields.update({k: article[k] for k in (
                "title", "seller", "seller_url", "released", "duration", "rating", "reviews", "tags",
                "cover", "cover_full", "samples")})
        self._save(fc2_id, "fc2", fields, started=started)

    def fetch_paipancon(self, fc2_id, started=None):
        try:
            pp = paipancon.fetch_detail(self.http, fc2_id)
        except FetchError as exc:
            self._save(fc2_id, "pp", {"pp_state": "error"}, str(exc), started)
            self.log(f"FC2-PPV-{fc2_id}: paipancon: {exc}", "warn")
            return
        fields = {"pp_state": "ok" if pp and (pp["clips"] or pp["cover"]) else "missing"}
        if pp:
            fields.update(clips=pp["clips"], grid=pp["grid"])
            # paipancon fills whatever FC2 could not provide (typically removed articles).
            current = self.store.title(fc2_id) or {}
            if current.get("fc2_state") != "ok" and pp["title"]:
                fields["title"] = pp["title"]
            if not current.get("cover") and pp["cover"]:
                fields["cover"] = fields["cover_full"] = pp["cover"]
            if not current.get("samples") and pp["thumbnails"]:
                fields["samples"] = [{"thumb": u, "full": u} for u in pp["thumbnails"]]
        self._save(fc2_id, "pp", fields, started=started)

    def enrich(self, fc2_id):
        """Run both stages synchronously (used by tests and one-off scripts)."""
        self.fetch_fc2(fc2_id)
        self.fetch_paipancon(fc2_id)

    # --- crawl jobs ---------------------------------------------------------------------

    def start_job(self, kind, blocks=5, query="", pages=PER_JOB_PAGE_LIMIT, check_files=False):
        """Start an `update`, `older` (history blocks) or `search` job; one runs at a time."""
        runners = {"update": self._run_update, "older": self._run_older, "search": self._run_search}
        if kind not in runners:
            raise ValueError(f"Unknown job {kind!r}")
        with self._job_lock:
            if self._job and self._job["running"]:
                raise RuntimeError("Another crawl is already running.")
            self._job_cancel.clear()
            self._job = {
                "kind": kind, "query": (query or "").strip() or self.settings.default_query,
                "pages": max(1, min(int(pages), PER_JOB_PAGE_LIMIT)), "blocks": max(1, int(blocks)),
                "check_files": bool(check_files), "page": 0, "pages_read": 0, "block": None,
                "blocks_done": 0, "seen": 0, "new_torrents": 0, "new_titles": 0, "files_checked": 0,
                "gap": False, "running": True, "error": "", "started_at": int(time.time()), "finished_at": None,
            }
            job = self._job
        threading.Thread(target=self._run_job, args=(job, runners[kind]), name=f"job-{kind}", daemon=True).start()
        return dict(job)

    def cancel(self):
        self._job_cancel.set()

    def _run_job(self, job, runner):
        try:
            runner(job)
        except Cancelled:
            self.log("Crawl cancelled.", "warn")
        except Exception as exc:
            job["error"] = str(exc)
            self.log(f"Crawl failed: {exc}", "error")
        finally:
            job.update(running=False, finished_at=int(time.time()))
            self.log(f"{job['kind'].capitalize()} finished: {job['pages_read']} page(s), "
                     f"{job['new_torrents']} new torrent(s), {job['new_titles']} new title(s).")

    def _read_page(self, query, page, priority, job):
        """Fetch one listing page, store its FC2 torrents and queue their titles."""
        if self._job_cancel.is_set():
            raise Cancelled()
        listing = sukebei.parse_listing(self.http.text(sukebei.search_url(query, page)))
        found = [t for t in listing.torrents if t.fc2_id]
        result = self.store.upsert_torrents(found)
        self.schedule(result["ids"], priority)
        job["page"] = page
        job["pages_read"] += 1
        job["seen"] += len(found)
        job["new_torrents"] += result["new_torrents"]
        job["new_titles"] += result["new_titles"]
        if job["check_files"]:
            self._check_files([t.view_id for t in found], job)
        return listing

    def _run_update(self, job):
        """Newest uploads first, until the first torrent already held."""
        self.store.set_meta("last_update_try", int(time.time()))
        frontier = self.store.get_meta("newest_view_id")
        newest, reached = frontier or 0, False
        for page in range(1, PER_JOB_PAGE_LIMIT + 1):
            listing = self._read_page(self.settings.default_query, page, NEW, job)
            newest = max([newest] + [t.view_id for t in listing.torrents])
            if frontier and any(t.view_id <= frontier for t in listing.torrents):
                reached = True
                break
            if not listing.has_next:
                reached = listing.total < sukebei.MAX_RESULTS     # the true end, not the 1000 cap
                break
        # Only a finished walk moves the frontier, so an interrupted one is redone next time.
        self.store.set_meta("newest_view_id", newest)
        self.store.set_meta("last_update_at", int(time.time()))
        if frontier and not reached:
            job["gap"] = True
            self.store.set_meta("update_gap", True)
            self.log("More than 1000 uploads since the last update: some of them could not be listed. "
                     "History blocks still pick them up; use “Re-check history” for blocks already done.", "warn")

    def _run_older(self, job):
        """History: the next `blocks` id blocks of the walk (see the module docstring)."""
        if self.store.get_meta("history_done"):
            return
        top = self.store.get_meta("history_top")
        cursor = self.store.get_meta("history_next")
        if cursor is None:
            newest = self.store.max_fc2_id()
            if not newest:
                raise RuntimeError("The library is empty; run Update first.")
            top = cursor = int(str(newest)[:BLOCK_DIGITS])
            self.store.set_meta("history_top", top)
        for _ in range(job["blocks"]):
            job["block"] = cursor
            self._read_block(str(cursor), job)       # raises on failure: the block stays next
            job["blocks_done"] += 1
            cursor = next_block(cursor, top)
            self.store.set_meta("history_next", cursor)
            if cursor is None:
                self.store.set_meta("history_done", True)
                self.log("History is complete: every FC2 id block has been read.")
                return

    def _read_block(self, prefix, job):
        page = 1
        while True:
            listing = self._read_page(f"{prefix}*", page, HISTORY, job)
            if page == 1 and listing.total >= sukebei.MAX_RESULTS and len(prefix) < MAX_PREFIX_DIGITS:
                for digit in "9876543210":               # too broad for one query: split it
                    self._read_block(prefix + digit, job)
                return
            if not listing.has_next:
                return
            page += 1

    def _run_search(self, job):
        """A custom sukebei query (a seller, a keyword, an id), every page up to the cap."""
        for page in range(1, job["pages"] + 1):
            listing = self._read_page(job["query"], page, NEW, job)
            if not listing.has_next:
                break

    def reset_history(self):
        """Walk history again from the newest block (after an update gap, for instance)."""
        with self._job_lock:
            if self._job and self._job["running"]:
                raise RuntimeError("Wait for the running crawl to finish (or cancel it) first.")
            for key in ("history_next", "history_top", "history_done"):
                self.store.set_meta(key, None)
            self.store.set_meta("update_gap", False)

    def _check_files(self, view_ids, job):
        for view_id in self.store.torrents_without_detail(view_ids):
            if self._job_cancel.is_set():
                raise Cancelled()
            try:
                self.torrent_detail(view_id, refresh=True)
                job["files_checked"] += 1
            except FetchError as exc:
                self.log(f"Torrent {view_id}: {exc}", "warn")

    def torrent_detail(self, view_id, refresh=False):
        torrent = self.store.torrent(view_id)
        if torrent is None:
            return None
        if torrent["files"] is None or refresh:
            detail = sukebei.parse_view(self.http.text(sukebei.view_url(view_id)))
            self.store.save_torrent_detail(view_id, detail)
            torrent = self.store.torrent(view_id)
        return torrent

    def _watch(self):
        """Run Update whenever the last one is older than `watch_minutes` (checked each minute)."""
        while not self._stop.is_set():
            if self.update_due():
                try:
                    self.start_job("update")
                except RuntimeError:
                    pass                                 # another crawl is running; try next minute
            self._stop.wait(60)

    def update_due(self, now=None):
        """An automatic Update is due when the last successful one is older than `watch_minutes`.

        A cancelled or failed Update leaves last_update_at alone, so the last attempt also has to
        be a while ago: otherwise Cancel would be undone within a minute, and a site that is down
        would be retried every minute.
        """
        minutes = self.settings.watch_minutes
        if not minutes:
            return False
        now = time.time() if now is None else now
        since_success = now - self.store.get_meta("last_update_at", 0)
        since_try = now - self.store.get_meta("last_update_try", 0)
        return since_success >= minutes * 60 and since_try >= min(UPDATE_RETRY_SECONDS, minutes * 60)

    # --- status -------------------------------------------------------------------------

    def coverage(self):
        nxt = self.store.get_meta("history_next")
        top = self.store.get_meta("history_top")
        newest = self.store.max_fc2_id()
        done = bool(self.store.get_meta("history_done", False))
        return {
            "top_block": int(str(newest)[:BLOCK_DIGITS]) if newest else None,
            "newest_view_id": self.store.get_meta("newest_view_id"),
            "last_update_at": self.store.get_meta("last_update_at"),
            "update_gap": bool(self.store.get_meta("update_gap", False)),
            "history_top": top,
            "history_next": nxt,
            # "main": newest block down to 1000; "short": 9999 down to just above the start
            "history_phase": "short" if nxt is not None and top is not None and nxt > top else "main",
            "history_blocks": blocks_read(top, nxt, done),
            "history_total": TOTAL_BLOCKS,
            "history_complete": done,
        }

    def status(self):
        with self._job_lock:
            job = dict(self._job) if self._job else None
        waiting = {stage: len(q) for stage, q in self._queues.items()}
        return {
            "job": job,
            "queue": sum(waiting.values()),
            "waiting": waiting,
            "active": sorted(self._active.values()),
            "coverage": self.coverage(),
            "stats": self.store.stats(),
            "log": list(self.log_lines)[-60:],
        }
