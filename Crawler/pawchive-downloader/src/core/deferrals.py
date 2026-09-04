"""Files the host does not have *yet*, and when it is worth asking again.

A 404 here is not the end of the story. Pawchive materialises files onto its
CDN lazily, and the logs prove the gap closes: URLs that answered 404 on six or
seven separate days in July serve real image bytes now. So abandoning a 404
permanently would silently drop files that were only ever late -- exactly the
kind of quiet loss the rest of this codebase is built to avoid.

Retrying every run is the opposite mistake. 4618 distinct URLs were 404ing, and
each scheduled run asked for all of them again; that is thousands of requests a
day spent re-confirming something that changes on a scale of weeks.

So neither: each miss pushes the next attempt further out (a day, then two,
four, eight...) up to a ceiling, and the entry is forgotten the moment the file
arrives. Nothing is ever given up on, and nothing is asked about more often than
it plausibly changes.

Keyed by the content-hash path, so a file shared between two posts is one entry.
"""

import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Optional

from ..common.jsonio import read_json, write_json

_DAY = 86400.0


class Deferrals:
    """The ledger. Safe to call from every download thread."""

    # Writing on every miss would rewrite the whole file up to once a second;
    # losing a few recent entries to a crash only costs one early retry.
    FLUSH_EVERY = 16
    FLUSH_SECONDS = 30.0

    def __init__(self, path, first_days: float = 1.0, backoff: float = 2.0,
                 cap_days: float = 30.0, logger=None):
        self.path = Path(path)
        self.first = max(0.0, float(first_days or 0))
        self.backoff = max(1.0, float(backoff or 1.0))
        self.cap = max(self.first, float(cap_days or 0))
        self.logger = logger
        self._lock = threading.Lock()
        self._entries: Dict[str, dict] = {}
        self._pending = 0
        self._flushed = time.monotonic()
        self._skipped = 0
        self._load()

    @property
    def enabled(self) -> bool:
        return self.first > 0

    # ==================== State ====================

    def _load(self):
        try:
            data = read_json(self.path, None) or {}
        except Exception:
            return  # A corrupt ledger costs one extra round of retries, nothing more.
        if isinstance(data, dict):
            self._entries = {k: v for k, v in data.items() if isinstance(v, dict)}

    def _save_locked(self):
        try:
            write_json(self.path, self._entries)
        except Exception:
            pass  # Advisory scheduling; never fail a run over it.
        self._pending = 0
        self._flushed = time.monotonic()

    def _maybe_flush_locked(self):
        if (self._pending >= self.FLUSH_EVERY
                or time.monotonic() - self._flushed >= self.FLUSH_SECONDS):
            self._save_locked()

    def flush(self):
        """Write pending changes. Called at shutdown so a clean exit loses none."""
        with self._lock:
            if self._pending:
                self._save_locked()

    # ==================== Scheduling ====================

    def _wait_days(self, misses: int) -> float:
        return min(self.first * (self.backoff ** max(0, misses - 1)), self.cap)

    def due(self, key: str) -> bool:
        """True if this file may be asked for now.

        An unknown file is always due -- the ledger only ever *delays* a retry,
        it never gates a first attempt.
        """
        if not self.enabled or not key:
            return True
        with self._lock:
            entry = self._entries.get(key)
            if not entry:
                return True
            nxt = _parse(entry.get('next'))
            if nxt is None or nxt <= datetime.now():
                return True
            self._skipped += 1
            return False

    def miss(self, key: str, name: str = "") -> Optional[dict]:
        """Record a 404 and push the next attempt out. Returns the new entry."""
        if not self.enabled or not key:
            return None
        now = datetime.now()
        with self._lock:
            entry = self._entries.get(key) or {'first_seen': now.isoformat(), 'misses': 0}
            entry['misses'] = int(entry.get('misses', 0)) + 1
            entry['last_seen'] = now.isoformat()
            wait = self._wait_days(entry['misses'])
            entry['next'] = (now + timedelta(days=wait)).isoformat()
            entry['wait_days'] = round(wait, 3)
            if name:
                entry['name'] = name
            self._entries[key] = entry
            self._pending += 1
            self._maybe_flush_locked()
            return dict(entry)

    def clear(self, key: str) -> bool:
        """Forget a file that arrived. True if it had been deferred."""
        if not key:
            return False
        with self._lock:
            if self._entries.pop(key, None) is None:
                return False
            self._pending += 1
            self._maybe_flush_locked()
            return True

    # ==================== Reporting ====================

    def take_skipped(self) -> int:
        """How many `due` checks said "not yet" since the last call.

        Reported once per run rather than per file: a run that skips two
        thousand deferred files should say so in one line, not two thousand.
        """
        with self._lock:
            n, self._skipped = self._skipped, 0
            return n

    def snapshot(self) -> dict:
        with self._lock:
            now = datetime.now()
            waiting = sum(1 for e in self._entries.values()
                          if (_parse(e.get('next')) or now) > now)
            return {'enabled': self.enabled, 'tracked': len(self._entries),
                    'waiting': waiting, 'due': len(self._entries) - waiting,
                    'first_days': self.first, 'backoff': self.backoff,
                    'cap_days': self.cap}

    def describe(self) -> str:
        if not self.enabled:
            return 'disabled'
        return (f"{self.first:g}d x{self.backoff:g} cap {self.cap:g}d, "
                f"{len(self._entries)} tracked")


def _parse(value) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(value) if value else None
    except (TypeError, ValueError):
        return None
