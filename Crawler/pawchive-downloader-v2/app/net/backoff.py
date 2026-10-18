"""Retry with capped exponential backoff. No project types."""

import time
from collections.abc import Callable, Iterable

from .limiter import jittered


class Cancelled(Exception):
    """Raised when `should_stop` asks the retry loop to abort."""


def wait_for(
    attempt: int, delay: float, factor: float = 2.0, cap: float = 60, jitter: float = 0.0
) -> float:
    """The wait after the `attempt`-th failure (1-based), before the next try.

    Exposed separately so a caller that varies the ladder per failure kind can
    reuse the same arithmetic rather than growing a second, subtly different
    one. `factor <= 1` keeps the wait flat, which is the right shape when a host
    is signalling a fixed cooldown rather than asking you to yield.
    """
    delay = max(0.0, float(delay))
    ceiling = max(delay, float(cap))
    base = delay if factor <= 1 else min(delay * (factor ** max(0, attempt - 1)), ceiling)
    return jittered(base, jitter)


def retry(
    func: Callable,
    *,
    retry_on: Iterable[type[Exception]],
    attempts: int = 0,
    delay: float = 5,
    factor: float = 2.0,
    cap: float = 60,
    jitter: float = 0.0,
    decide: Callable[[Exception, int], float | None] | None = None,
    should_stop: Callable[[], bool] | None = None,
    on_retry: Callable[[Exception, int, float], None] | None = None,
    on_give_up: Callable[[Exception, int], None] | None = None,
):
    """Call `func` until it succeeds.

    By default: `attempts=0` retries forever, a positive value re-raises after
    `on_give_up`, and the wait follows `wait_for(delay, factor, cap, jitter)`.

    `decide(exception, attempt)` replaces that judgement when given. It returns
    the number of seconds to wait before the next try, or None to give up now --
    letting the caller vary both the verdict and the ladder by what actually
    failed, which is the whole point when different errors mean different
    things. It may also raise, to substitute its own exception for the original.

    `should_stop` is polled before every attempt and after every failure, and
    during the wait, so a long backoff stays cancellable.
    """
    retry_on = tuple(retry_on)
    attempt = 0
    while True:
        attempt += 1
        if should_stop and should_stop():
            raise Cancelled()
        try:
            return func()
        except retry_on as e:
            if should_stop and should_stop():
                raise Cancelled() from e
            if decide is not None:
                slept = decide(e, attempt)
                if slept is None:
                    if on_give_up:
                        on_give_up(e, attempt)
                    raise
            else:
                if attempts and attempt >= attempts:
                    if on_give_up:
                        on_give_up(e, attempt)
                    raise
                slept = wait_for(attempt, delay, factor, cap, jitter)
            if on_retry:
                on_retry(e, attempt, round(slept, 2))
            _sleep(slept, should_stop)


def _sleep(seconds: float, should_stop: Callable[[], bool] | None):
    """Sleep in slices so a minute-long backoff still stops on request."""
    if not should_stop:
        time.sleep(seconds)
        return
    deadline = time.monotonic() + seconds
    while True:
        left = deadline - time.monotonic()
        if left <= 0 or should_stop():
            return
        time.sleep(min(left, 0.25))
