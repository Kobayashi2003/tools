"""The queue that actually fetches the files.

The unit of work is a job, not a file, because a claim is: pressing a
recommendation's button spends a one-time link that dies in about ten minutes
and opens a session that lives about an hour. So the button is pressed when the
queue *reaches* the job rather than when it is added to it -- queue twenty and
the twentieth is claimed twenty presses later, by which time a claim taken up
front would long since have expired.

One worker, deliberately. The reader hands out a handful of live sessions per
account and streams each file from a small server, so parallel transfers would
buy nothing and cost goodwill.

Two things make a transfer survivable. Every file is written to `<name>.part`
and moved into place only when its byte count matches, so an interrupted run
never leaves a half file looking whole. And the reader supports HTTP Range, so a
resumed transfer asks for the rest rather than starting again -- which for a
400 MB set of volumes is the difference between an inconvenience and an evening.
"""

import re
import threading
import time
import unicodedata
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional

import requests

from .config import USER_AGENT
from .hosted import Claim
from .models import human_size

CHUNK = 256 * 1024
# Windows keeps a short list of characters a name may not contain, and a name
# may not end in a dot or a space either.
FORBIDDEN = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
RESERVED = {"con", "prn", "aux", "nul", "com1", "com2", "com3", "com4",
            "lpt1", "lpt2", "lpt3"}


def safe_name(text: str, fallback: str = "untitled", limit: int = 110) -> str:
    """A folder or file name a filesystem will accept, still readable.

    Japanese titles are the norm here, so nothing is transliterated away: only
    what Windows refuses is replaced, and the length is capped in characters
    because a path limit is what a long series title actually runs into.
    """
    name = unicodedata.normalize("NFC", str(text or ""))
    name = re.sub(r"\s+", " ", name).strip()
    name = FORBIDDEN.sub("_", name).strip(" .")
    if name.split(".")[0].lower() in RESERVED:
        name = "_" + name
    if len(name) > limit:
        name = name[:limit].strip(" .")
    return name or fallback


@dataclass
class Transfer:
    """One file on its way to disk."""

    key: str
    name: str
    url: str = ""
    index: int = 0
    size: int = 0
    got: int = 0
    state: str = "queued"        # queued active done held failed cancelled
    error: str = ""
    path: str = ""

    @property
    def active(self) -> bool:
        return self.state in ("queued", "active")

    def to_json(self) -> dict:
        return {
            "key": self.key,
            "name": self.name,
            "size": self.size,
            "size_human": human_size(self.size),
            "got": self.got,
            "pct": round(100 * self.got / self.size, 1) if self.size else 0,
            "state": self.state,
            "error": self.error,
            "path": self.path,
        }


@dataclass
class Task:
    """One job: press the button, then fetch what it gives."""

    job: str
    message_id: str
    title: str
    club: str
    force: bool = False          # press again even for a job already on disk
    state: str = "queued"        # queued opening working done failed cancelled
    error: str = ""
    note: str = ""               # what the bot said, for an external job
    links: List[str] = field(default_factory=list)
    transfers: List[Transfer] = field(default_factory=list)
    folder: str = ""
    queued_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None

    @property
    def active(self) -> bool:
        return self.state in ("queued", "opening", "working")

    def to_json(self) -> dict:
        files = [t.to_json() for t in self.transfers]
        size = sum(t.size for t in self.transfers)
        got = sum(t.got for t in self.transfers)
        return {
            "job": self.job,
            "id": self.message_id,
            "title": self.title,
            "state": self.state,
            "error": self.error,
            "note": self.note,
            "links": self.links,
            "folder": self.folder,
            "files": files,
            "size": size,
            "size_human": human_size(size),
            "got": got,
            "pct": round(100 * got / size, 1) if size else 0,
            "done": sum(1 for t in self.transfers if t.state in ("done", "held")),
            "queued_at": self.queued_at,
        }


class Downloads:
    """One queue for the whole run, shared by every channel on the page."""

    def __init__(self, config, ledger, open_job: Callable[[Task], Claim],
                 on_finish: Optional[Callable[[Task], None]] = None):
        self.config = config
        self.ledger = ledger
        # Press the button for this task and hand back a live claim. Supplied
        # from above, because pressing needs a channel and a gateway and this
        # needs neither.
        self.open_job = open_job
        # Told when a task stops, so the tick beside the recommendation is set
        # by the thing that finished rather than by whoever next asks.
        self.on_finish = on_finish or (lambda task: None)

        self.lock = threading.RLock()
        self.tasks: Dict[str, Task] = {}
        self.pending: deque = deque()
        self._wake = threading.Event()
        self._worker: Optional[threading.Thread] = None
        self._stop = False
        self.last_error = ""
        self._plain: Optional[requests.Session] = None

    # -- queueing ---------------------------------------------------------

    def folder_for(self, title: str, club: str, job: str) -> Path:
        """`downloads/<club>/<title>`. The club keeps the four channels apart,
        and the title is the folder because a job is one release."""
        return (self.config.download_path / safe_name(club or "recommendations")
                / safe_name(title, job))

    def queue(self, job: str, message_id: str, title: str, club: str,
              force: bool = False) -> Task:
        """Put a job in the queue, or hand back the one already there."""
        with self.lock:
            held = self.tasks.get(job)
            if held is not None and held.active:
                return held
            task = Task(job=job, message_id=str(message_id), title=title,
                        club=club, force=force)
            task.folder = str(self.folder_for(title, club, job))
            self.tasks[job] = task
            self.pending.append(job)
        self._ensure_worker()
        return task

    def requeue(self, job: str) -> Optional[Task]:
        """Try a failed job again, from wherever its files got to."""
        with self.lock:
            task = self.tasks.get(job)
            if task is None or task.active:
                return task
            task.state = "queued"
            task.error = ""
            task.finished_at = None
            for transfer in task.transfers:
                if transfer.state in ("failed", "cancelled"):
                    transfer.state = "queued"
                    transfer.error = ""
            self.pending.append(job)
        self._ensure_worker()
        return task

    def _ensure_worker(self) -> None:
        with self.lock:
            if self._worker is None or not self._worker.is_alive():
                self._stop = False
                self._worker = threading.Thread(target=self._run, daemon=True,
                                                name="downloads")
                self._worker.start()
        self._wake.set()

    # -- reporting --------------------------------------------------------

    def status(self, limit: int = 60) -> dict:
        with self.lock:
            tasks = list(self.tasks.values())
        tasks.sort(key=lambda t: (not t.active, -t.queued_at))
        shown = tasks[:limit]
        return {
            "tasks": [t.to_json() for t in shown],
            "queued": sum(1 for t in tasks if t.state == "queued"),
            "active": sum(1 for t in tasks if t.active),
            "failed": sum(1 for t in tasks if t.state == "failed"),
            "done": sum(1 for t in tasks if t.state == "done"),
            "bytes": sum(sum(f.got for f in t.transfers) for t in tasks),
            "error": self.last_error,
        }

    def task(self, job: str) -> Optional[Task]:
        return self.tasks.get(job)

    def cancel(self, job: str) -> None:
        with self.lock:
            task = self.tasks.get(job)
            if task is None or not task.active:
                return
            task.state = "cancelled"
            task.finished_at = time.time()
            for transfer in task.transfers:
                if transfer.active:
                    transfer.state = "cancelled"

    def forget_finished(self) -> None:
        with self.lock:
            self.tasks = {k: t for k, t in self.tasks.items() if t.active}
            self.last_error = ""

    # -- the work ---------------------------------------------------------

    def _next(self) -> Optional[Task]:
        with self.lock:
            while self.pending:
                task = self.tasks.get(self.pending.popleft())
                if task is not None and task.state == "queued":
                    return task
        return None

    def _run(self) -> None:
        while not self._stop:
            task = self._next()
            if task is None:
                self._wake.clear()
                if not self._wake.wait(30):
                    with self.lock:
                        if not self.pending:
                            self._worker = None
                            return
                continue
            try:
                self._do(task)
            except Exception as exc:
                task.state = "failed"
                task.error = f"{exc}"
                task.finished_at = time.time()
                self.last_error = f"{task.title or task.job}: {exc}"
            try:
                self.on_finish(task)
            except Exception:
                pass          # a tick is not worth losing the queue over

    def _do(self, task: Task) -> None:
        if task.state == "cancelled":
            return
        if self._already(task):
            return
        task.state = "opening"
        claim = self.open_job(task)          # presses the button
        task.note = claim.note
        task.links = list(claim.links)
        if claim.title:
            task.title = claim.title
            task.folder = str(self.folder_for(task.title, task.club, task.job))

        if not claim.files:
            # An external job on a host with no direct form: the link is the
            # answer, and opening it is the reader's job, not ours.
            task.state = "done" if claim.links else "failed"
            task.error = "" if claim.links else (
                claim.note and "the bot gave no link" or "the bot said nothing")
            task.finished_at = time.time()
            return

        folder = Path(task.folder)
        task.transfers = []
        for file in claim.files:
            target = folder / safe_name(file.name, f"{task.job}-{file.index}")
            task.transfers.append(Transfer(
                key=f"{task.job}:{file.index}", name=file.name, url=file.url,
                index=file.index, size=file.size, path=str(target)))

        task.state = "working"
        for transfer in task.transfers:
            if self._stop or task.state == "cancelled":
                return
            try:
                self._fetch(task, transfer, claim)
            except Exception as exc:
                transfer.state = "failed"
                transfer.error = str(exc)
                # Which file, not just which book: a job can be twenty volumes
                # and nineteen of them fine.
                self.last_error = f"{transfer.name}: {exc}"

        failed = [t for t in task.transfers if t.state == "failed"]
        task.state = "failed" if failed else "done"
        task.error = failed[0].error if failed else ""
        task.finished_at = time.time()

    def _already(self, task: Task) -> bool:
        """Short-circuit a job whose files are all still on disk.

        Reading the listing means pressing the button, and a press is a real
        request to the bot that its rate limit counts -- so a job we can see we
        already hold is finished here rather than claimed again. `force` is what
        the card's "get again" sends, for a file that was deleted or truncated
        behind our back.
        """
        if task.force:
            return False
        record = self.ledger.get(task.job)
        if not record or not record.get("files") or not self.ledger.held(task.job):
            return False
        task.folder = record.get("dir") or task.folder
        task.title = record.get("title") or task.title
        task.transfers = [
            Transfer(key=f"{task.job}:{i}", name=file.get("name", ""),
                     index=i, size=int(file.get("size") or 0),
                     got=int(file.get("size") or 0), state="held",
                     path=file.get("path", ""))
            for i, file in enumerate(record["files"])]
        task.state = "done"
        task.note = "already on disk"
        task.finished_at = time.time()
        return True

    def _held(self, task: Task, transfer: Transfer) -> bool:
        """Whether this file is already on disk, and can be left alone.

        The listing rounds sizes to two decimals of KiB, so the number it gives
        is a few bytes off what the server actually sends -- comparing the two
        exactly meant every second run fetched everything again. What was
        written down at the time is exact, so the ledger is asked first, and the
        listing is only allowed to say "about the same size".
        """
        target = Path(transfer.path)
        if not target.exists():
            return False
        disk = target.stat().st_size
        if not disk:
            return False
        recorded = self.ledger.get(task.job) or {}
        for file in recorded.get("files") or []:
            if file.get("path") == transfer.path and int(file.get("size") or 0) == disk:
                transfer.size = disk
                return True
        if not transfer.size:
            return True                       # nothing to compare it against
        slack = max(1024, transfer.size * 0.001)
        return abs(disk - transfer.size) <= slack

    def _fetch(self, task: Task, transfer: Transfer, claim: Claim) -> None:
        target = Path(transfer.path)
        # Already on disk: say so rather than fetch it again. Every claim counts
        # against the reader's per-account limit.
        if self._held(task, transfer):
            transfer.state = "held"
            transfer.got = target.stat().st_size
            transfer.size = transfer.size or transfer.got
            self._note(task, transfer)
            return

        # The reader is one small machine, and a connection to it drops or
        # times out from time to time -- which is exactly what resuming is for.
        # Each attempt picks up from whatever is already in the `.part` file, so
        # a retry costs the bytes since the break rather than the whole book.
        last = None
        for attempt in range(1, max(1, self.config.retry) + 1):
            if self._stop or task.state == "cancelled":
                return
            try:
                self._attempt(task, transfer, claim)
                return
            except (requests.RequestException, OSError) as exc:
                last = exc
                if attempt >= max(1, self.config.retry):
                    break
                transfer.error = f"{_plainly(exc)} — trying again ({attempt})"
                time.sleep(min(2 ** attempt, 20))
        raise RuntimeError(_plainly(last) if last else "the transfer failed")

    def _attempt(self, task: Task, transfer: Transfer, claim: Claim) -> None:
        """One go at the file, from wherever the last one stopped."""
        target = Path(transfer.path)
        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_name(target.name + ".part")
        transfer.state = "active"
        transfer.error = ""

        have = part.stat().st_size if part.exists() else 0
        session = claim.session or self._session()
        response = session.get(transfer.url,
                               headers={"Range": f"bytes={have}-"} if have else {},
                               stream=True, timeout=self._timeout,
                               allow_redirects=True)

        if have and response.status_code == 200:
            # The server ignored the range and is sending the lot: start again
            # rather than append a second copy onto the first.
            have = 0
            part.unlink(missing_ok=True)
        elif response.status_code not in (200, 206):
            response.close()
            raise RuntimeError(f"HTTP {response.status_code}")

        total = _total_size(response, have)
        if total:
            transfer.size = total
        transfer.got = have

        with open(part, "ab" if have else "wb") as file:
            for chunk in response.iter_content(CHUNK):
                if self._stop or task.state == "cancelled" or transfer.state == "cancelled":
                    response.close()
                    transfer.state = "cancelled"
                    return
                if chunk:
                    file.write(chunk)
                    transfer.got += len(chunk)
        response.close()

        if transfer.size and transfer.got != transfer.size:
            raise RuntimeError(f"short read: {transfer.got:,} of {transfer.size:,} bytes")
        part.replace(target)
        transfer.state = "done"
        transfer.size = transfer.size or transfer.got
        self._note(task, transfer)

    def _note(self, task: Task, transfer: Transfer) -> None:
        self.ledger.record(task.job, task.title, Path(task.folder), [{
            "name": transfer.name,
            "size": transfer.size,
            "path": transfer.path,
            "at": datetime.now(timezone.utc).isoformat(),
        }])

    @property
    def _timeout(self):
        """Separate connect and read limits.

        One number for both is the wrong shape here: a connect that has not
        answered in fifteen seconds never will, while a read on a server sending
        a 400 MB file down a thin pipe is allowed to pause far longer than that.
        """
        return (min(15, self.config.timeout), self.config.read_timeout)

    def _session(self) -> requests.Session:
        """For links that are not on the reader -- pixeldrain and friends."""
        if self._plain is None:
            session = requests.Session()
            session.headers.update({"User-Agent": USER_AGENT})
            if self.config.proxy:
                session.proxies = self.config.proxies
            self._plain = session
        return self._plain

    def close(self) -> None:
        self._stop = True
        self._wake.set()


def _plainly(exc) -> str:
    """A network failure in one line a reader can act on.

    requests wraps the real cause two deep, so the useful sentence -- "the host
    did not answer" -- arrives buried in a ConnectionPool repr with the URL, the
    retry count and the urllib3 class names around it. The cause is what matters
    and the URL is already on the card.
    """
    if isinstance(exc, requests.exceptions.ConnectTimeout):
        return "the reader did not answer in time"
    if isinstance(exc, requests.exceptions.ReadTimeout):
        return "the reader stopped sending"
    if isinstance(exc, requests.exceptions.ConnectionError):
        return "the connection to the reader dropped"

    # Anything else: the innermost cause, which is where the real sentence is.
    inner = exc
    for _ in range(5):
        deeper = inner.__cause__ or inner.__context__
        if deeper is None:
            break
        inner = deeper
    kind = type(inner).__name__
    text = str(inner).strip() or kind
    return text if kind in text else f"{kind}: {text}"


def _total_size(response, already: int) -> int:
    """The whole file's size, whether the answer is a range or the lot."""
    span = response.headers.get("Content-Range") or ""
    if "/" in span:
        tail = span.rsplit("/", 1)[-1].strip()
        if tail.isdigit():
            return int(tail)
    length = response.headers.get("Content-Length")
    if length and length.isdigit():
        return already + int(length)
    return 0
