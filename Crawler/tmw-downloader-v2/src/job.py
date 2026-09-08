"""A reach that runs while you read.

The CLI reaches back before it serves anything: you decide how much of the
channel you want, wait for it, and then the page opens. That is the wrong shape
for the question it answers -- you find out you want 2021 while you are reading
2023, and by then the run has already been configured.

So the same walk is available from the page, on a thread of its own. One job per
channel at a time, reporting how far it has reached, and stoppable: a crawl of a
five-year channel is hundreds of requests, and the answer to "this is taking too
long" should be a button rather than killing the process.

The walk is done in short passes rather than one long one. A pass holds the
feed's lock for a page or two, so the page it is running behind stays answerable
-- and the message cache is written on a timer instead of once per page.
"""

import threading
from datetime import datetime, timezone
from typing import Optional

from .config import parse_history
from .models import snowflake_time

# Messages per pass. Short enough that a reader never waits long for the lock,
# long enough that the per-pass bookkeeping stays in the noise.
PASS_SIZE = 200


class FetchJob:
    """One channel's crawl. Built stopped; `start` puts it on a thread."""

    def __init__(self, feed, spec: str, direction: str = "older"):
        self.feed = feed
        self.spec = (spec or "").strip()
        self.direction = "newer" if direction == "newer" else "older"

        # Raises ValueError on nonsense, before a thread or a request exists.
        reach = parse_history(self.spec)
        floor, count = reach if reach else (None, None)
        # A date floor has to go back to `backfill` on every pass; a plain count
        # is this job's own budget, and the passes are drawn from it.
        self.floor_spec = self.spec if floor is not None else ""
        self.total: Optional[int] = count

        self.fetched = 0
        self.added = 0
        self.edge: Optional[datetime] = None   # the oldest (or newest) id reached
        self.done = False                      # the channel had no more to give
        self.error = ""
        self.started_at = datetime.now(timezone.utc)
        self.finished_at: Optional[datetime] = None

        self._base = 0                         # messages fetched before this pass
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # -- state ------------------------------------------------------------

    @property
    def active(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @property
    def stopped(self) -> bool:
        return self._stop.is_set()

    def status(self) -> dict:
        return {
            "active": self.active,
            "dir": self.direction,
            "spec": self.spec,
            "target": self.total,
            "fetched": self.fetched,
            "added": self.added,
            "edge": self.edge.isoformat() if self.edge else None,
            "done": self.done,
            "stopped": self.stopped,
            "error": self.error,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
        }

    # -- running ----------------------------------------------------------

    def start(self) -> "FetchJob":
        if self.active:
            return self
        self._thread = threading.Thread(target=self._run, daemon=True,
                                        name=f"fetch-{self.feed.config.channel_id}")
        self._thread.start()
        return self

    def stop(self) -> "FetchJob":
        self._stop.set()
        return self

    def _page_seen(self, count: int, edge_id: str):
        """Called by the walk after each page. Returning False calls it off."""
        self.fetched = self._base + count
        self.edge = snowflake_time(edge_id)
        return not self._stop.is_set()

    def _pass(self, step: int) -> dict:
        if self.direction == "newer":
            return self.feed.sync(limit=step, on_progress=self._page_seen)
        return self.feed.backfill(spec=self.floor_spec, limit=step,
                                  on_progress=self._page_seen)

    def _run(self) -> None:
        remaining = self.total
        try:
            while not self._stop.is_set():
                step = PASS_SIZE if remaining is None else min(PASS_SIZE, remaining)
                if step <= 0:
                    break

                self._base = self.fetched
                result = self._pass(step)

                if result.get("offline"):
                    self.error = "not connected to Discord"
                    break

                self.added += result.get("added", 0)
                self.fetched = self._base + result.get("fetched", 0)
                if remaining is not None:
                    remaining -= result.get("fetched", 0)

                if result.get("done"):
                    # Walking back reached the start of the channel.
                    self.done = True
                    break
                if not result.get("fetched"):
                    # Nothing came back: a date floor was reached, the archive is
                    # already complete, or forward has nothing newer. Either way
                    # there is no more to have on this pass or any later one.
                    self.done = self.direction == "newer" or bool(result.get("done"))
                    break
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            self.finished_at = datetime.now(timezone.utc)
            try:
                self.feed.flush()
            except Exception as exc:
                self.error = self.error or f"could not write the cache: {exc}"
