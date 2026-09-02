"""Retry with capped exponential backoff. No project types."""

import time
from typing import Callable, Iterable, Optional


class Cancelled(Exception):
    """Raised when `should_stop` asks the retry loop to abort."""


def retry(func: Callable, *,
          retry_on: Iterable[type],
          attempts: int = 0,
          delay: float = 5,
          cap: float = 60,
          should_stop: Optional[Callable[[], bool]] = None,
          on_retry: Optional[Callable[[Exception, int, float], None]] = None,
          on_give_up: Optional[Callable[[Exception, int], None]] = None):
    """Call `func` until it succeeds.

    `attempts=0` retries forever; a positive value re-raises after `on_give_up`.
    `should_stop` is polled before every attempt so a long backoff stays
    cancellable.
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
                raise Cancelled()
            if attempts and attempt >= attempts:
                if on_give_up:
                    on_give_up(e, attempt)
                raise
            if on_retry:
                on_retry(e, attempt, delay)
            time.sleep(delay)
            delay = min(delay * 2, cap)
