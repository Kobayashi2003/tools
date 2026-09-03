"""Traffic shaping: a byte/second token bucket, a persisted rolling byte quota,
and a global cap on how many transfers may run at once. No project types.

The three limits answer three different questions and none substitutes for
another. Concurrency bounds how many sockets a server sees at one instant; rate
bounds how fast bytes leave it; quota bounds how much is taken over a day. A
pipeline that nests thread pools needs the concurrency cap in particular: the
pools *multiply*, so the only real ceiling is one shared by every transfer.

Sizes are written as text ("8MB", "300GB") because a daily quota expressed in
bytes is a twelve-digit literal nobody can read, let alone check.
"""

import random
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from .jsonio import read_json, write_json

_UNITS = {
    'B': 1,
    'K': 1024, 'KB': 1024,
    'M': 1024 ** 2, 'MB': 1024 ** 2,
    'G': 1024 ** 3, 'GB': 1024 ** 3,
    'T': 1024 ** 4, 'TB': 1024 ** 4,
}

# Longest first: "MB" must win over the "B" that also ends the string.
_SUFFIXES = ('TB', 'GB', 'MB', 'KB', 'T', 'G', 'M', 'K', 'B')


class BadSize(ValueError):
    """A size string could not be read. Never silently treated as 'no limit'."""


def parse_size(value, default: int = 0) -> int:
    """`"8MB"` / `"1.5 GB"` / `500000` / `""` -> bytes. 0 means no limit.

    An unreadable value raises rather than falling back to 0: a typo in a cap
    must not quietly turn into unlimited, which is the one outcome the cap
    exists to prevent.
    """
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        raise BadSize(f"expected a size, got {value!r}")
    if isinstance(value, (int, float)):
        return max(0, int(value))

    text = str(value).strip().replace('_', '').replace(' ', '').upper()
    if not text:
        return default
    for suffix in _SUFFIXES:
        if text.endswith(suffix) and len(text) > len(suffix):
            try:
                return max(0, int(float(text[:-len(suffix)]) * _UNITS[suffix]))
            except ValueError:
                raise BadSize(f"not a size: {value!r}") from None
    try:
        return max(0, int(float(text)))
    except ValueError:
        raise BadSize(f"not a size: {value!r}") from None


def format_size(num: int) -> str:
    """Byte count -> short human string, spelled the way `parse_size` reads."""
    size = float(num or 0)
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if size < 1024 or unit == 'TB':
            return f"{int(size)}B" if unit == 'B' else f"{size:.1f}{unit}"
        size /= 1024
    return f"{size:.1f}TB"


class QuotaExceeded(Exception):
    """The byte budget for the current window is spent.

    Deliberately not a network error: retrying cannot refill a budget, so it
    must never land in a retry loop's `retry_on`.
    """


class RateLimiter:
    """Byte/second token bucket shared by every thread that calls `charge`.

    `rate <= 0` disables it, so the disabled path costs one comparison per
    chunk. `burst` is the bucket size -- the most that may be taken at once
    after an idle spell. It defaults to one second of rate, because a larger
    bucket lets a paused-then-resumed run open with a spike, which is exactly
    the shape a server rate-limits on.
    """

    def __init__(self, rate=0, burst=0):
        self.rate = parse_size(rate)
        self.burst = max(parse_size(burst), self.rate)
        self._tokens = float(self.burst)
        self._updated = time.monotonic()
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self.rate > 0

    def charge(self, amount: int, should_stop=None) -> bool:
        """Block until `amount` bytes have been paid for. False if stopped.

        An amount larger than the bucket is paid in instalments rather than
        deadlocking: how big a chunk is stays the caller's business.
        """
        if not self.enabled or amount <= 0:
            return True
        remaining = int(amount)
        while remaining > 0:
            if should_stop and should_stop():
                return False
            with self._lock:
                now = time.monotonic()
                self._tokens = min(float(self.burst),
                                   self._tokens + (now - self._updated) * self.rate)
                self._updated = now
                # Integer take only: a fractional one would decrement the bucket
                # without decrementing the debt, leaking tokens on every chunk.
                take = int(min(remaining, self._tokens))
                self._tokens -= take
                remaining -= take
                deficit = min(remaining, self.burst) - self._tokens
                wait = max(deficit, 1.0) / self.rate if remaining > 0 else 0.0
            if remaining > 0:
                # Capped so a stop request is still noticed promptly.
                time.sleep(min(max(wait, 0.005), 0.5))
        return True


class RequestLimiter:
    """Requests-per-second token bucket. `rate <= 0` disables it.

    Separate from `RateLimiter` because "no more than one request per second"
    is not a statement about bandwidth. A thousand small files sit far under
    any byte cap while hammering the request count, and it is the request count
    a host counts when it decides you are being rude.

    `burst` defaults to 1, i.e. strict spacing. A bigger bucket permits a clump
    followed by a longer gap -- the same average, but not what a host asking
    for one-per-second is picturing.
    """

    def __init__(self, rate=0, burst=0):
        self.rate = max(0.0, float(rate or 0))
        self.burst = max(1.0, float(burst or 0)) if self.rate else 0.0
        self._tokens = self.burst
        self._updated = time.monotonic()
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self.rate > 0

    def acquire(self, should_stop=None) -> bool:
        """Block until one request may be sent. False if `should_stop` fired."""
        if not self.enabled:
            return True
        while True:
            if should_stop and should_stop():
                return False
            with self._lock:
                now = time.monotonic()
                self._tokens = min(self.burst,
                                   self._tokens + (now - self._updated) * self.rate)
                self._updated = now
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return True
                wait = (1.0 - self._tokens) / self.rate
            # Capped so a stop request is still noticed promptly.
            time.sleep(min(max(wait, 0.005), 0.5))


class ByteQuota:
    """A byte budget for a rolling window, surviving restarts.

    Kept on disk because the point is to bound a *day*: a counter that reset
    when the process did would let a restart loop spend the same budget over
    and over -- precisely the failure a quota is meant to catch.
    `limit <= 0` disables it.
    """

    # Flushing every chunk would put a file write inside the download loop.
    FLUSH_EVERY = 16 * 1024 * 1024

    def __init__(self, limit=0, state_path=None, window_hours: float = 24.0):
        self.limit = parse_size(limit)
        self.window = max(60.0, float(window_hours or 24.0) * 3600.0)
        self.path = Path(state_path) if state_path else None
        self._lock = threading.Lock()
        self._used = 0
        self._started = time.time()
        self._pending = 0
        self._reported = False
        self._load()

    @property
    def enabled(self) -> bool:
        return self.limit > 0

    # ==================== State ====================

    def _load(self):
        if not (self.path and self.enabled):
            return
        try:
            data = read_json(self.path, None) or {}
        except Exception:
            return  # A corrupt counter starts a fresh window; it never blocks.
        started = float(data.get('started') or 0)
        if started and 0 <= (time.time() - started) < self.window:
            self._started = started
            self._used = max(0, int(data.get('used') or 0))

    def _save(self):
        if not self.path:
            return
        try:
            write_json(self.path, {'started': self._started, 'used': self._used,
                                   'limit': self.limit})
        except Exception:
            pass  # Advisory bookkeeping; never fail a download over it.

    def _roll(self):
        """Open a new window once the old one elapsed. Caller holds the lock."""
        if time.time() - self._started >= self.window:
            self._started = time.time()
            self._used = 0
            self._pending = 0
            self._reported = False
            self._save()

    # ==================== Accounting ====================

    def check(self):
        """Raise `QuotaExceeded` if the window is spent. Costs no network."""
        if not self.enabled:
            return
        with self._lock:
            self._roll()
            if self._used >= self.limit:
                raise QuotaExceeded(self._spent_message())

    def take(self, amount: int):
        """Charge `amount` bytes, raising once the window is spent."""
        if not self.enabled or amount <= 0:
            return
        with self._lock:
            self._roll()
            self._used += int(amount)
            self._pending += int(amount)
            spent = self._used >= self.limit
            if self._pending >= self.FLUSH_EVERY or spent:
                self._pending = 0
                self._save()
            if spent:
                raise QuotaExceeded(self._spent_message())

    def mark_reported(self) -> bool:
        """True the first time it is called in a window.

        Exhaustion hits every queued file at once; without a latch, one spent
        budget writes thousands of identical log lines.
        """
        with self._lock:
            if self._reported:
                return False
            self._reported = True
            return True

    def _spent_message(self) -> str:
        return (f"quota spent: {format_size(self._used)} of "
                f"{format_size(self.limit)}, resets in {self._resets_in_locked()}")

    def _resets_in_locked(self) -> str:
        left = max(0, int(self._started + self.window - time.time()))
        return f"{left // 3600}h{(left % 3600) // 60:02d}m"

    def snapshot(self) -> dict:
        with self._lock:
            return {'enabled': self.enabled, 'used': self._used, 'limit': self.limit,
                    'remaining': max(0, self.limit - self._used) if self.enabled else 0,
                    'resets_in': self._resets_in_locked()}


class Throttle:
    """Concurrency cap + rate limiter + quota, as the one object call sites hold.

    Bundled rather than passed around separately so a transfer cannot observe
    one limit and miss the others.
    """

    def __init__(self, max_concurrent=0, rate=0, burst=0, quota=0,
                 state_path=None, window_hours: float = 24.0,
                 requests_per_second=0, request_burst=0):
        self.max_concurrent = max(0, int(max_concurrent or 0))
        self._semaphore = (threading.BoundedSemaphore(self.max_concurrent)
                           if self.max_concurrent else None)
        self.rate = RateLimiter(rate, burst)
        self.requests = RequestLimiter(requests_per_second, request_burst)
        self.quota = ByteQuota(quota, state_path, window_hours)

    @contextmanager
    def slot(self):
        """Hold one of the global transfer slots for the length of a transfer."""
        if self._semaphore is None:
            yield
            return
        self._semaphore.acquire()
        try:
            yield
        finally:
            self._semaphore.release()

    def request(self, should_stop=None) -> bool:
        """Wait for permission to make one file request. False if stopped.

        Called before the request goes out, unlike `charge`, which accounts for
        bytes already received: a request that was never allowed costs the host
        nothing, and that is the whole point of a request cap.
        """
        return self.requests.acquire(should_stop)

    def charge(self, amount: int, should_stop=None) -> bool:
        """Account and pace `amount` delivered bytes. False if stopped.

        Quota first: bytes already off the wire are spent whether or not the
        pacing sleep gets to finish.
        """
        self.quota.take(amount)
        return self.rate.charge(amount, should_stop)

    def describe(self) -> str:
        rate = f"{format_size(self.rate.rate)}/s" if self.rate.enabled else 'unlimited'
        quota = format_size(self.quota.limit) if self.quota.enabled else 'unlimited'
        reqs = f"{self.requests.rate:g}/s" if self.requests.enabled else 'unlimited'
        return (f"concurrency={self.max_concurrent or 'unlimited'}, "
                f"requests={reqs}, rate={rate}, quota={quota}")


def jittered(delay: float, jitter: float) -> float:
    """`delay` scaled by +/- `jitter` (0..1).

    Workers that failed together would otherwise retry together, so the load
    they are backing off from arrives again as one spike.
    """
    if jitter <= 0:
        return delay
    span = delay * min(1.0, float(jitter))
    return max(0.0, delay + random.uniform(-span, span))
