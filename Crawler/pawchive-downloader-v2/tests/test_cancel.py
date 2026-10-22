import threading
import time

import pytest
import requests

from app.engine.context import Context
from app.net.limiter import Throttle
from app.net.policy import StatusPolicies
from app.sources.http import Cancelled, HttpClient, RetryShape, cancelled_by


def test_job_cancel_ends_a_backoff_wait():
    """Cancelling one job stops its retries at once; the shared client stays usable."""
    client = HttpClient(
        "Test",
        {},
        Throttle(),
        StatusPolicies(),
        RetryShape(delay=30, factor=1, cap=30, jitter=0, attempts=0),
        timeout=5,
        log=lambda _level, _message: None,
    )

    def unreachable():
        raise requests.exceptions.Timeout("no route")

    cancel = threading.Event()
    threading.Timer(0.3, cancel.set).start()
    started = time.monotonic()
    with cancelled_by(cancel), pytest.raises(Cancelled):
        client.retry(unreachable, "list")
    assert time.monotonic() - started < 5
    assert client.retry(lambda: "ok", "other job") == "ok"


def test_fanbox_retries_a_failed_connection_like_pawchive(
    ctx: Context, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("PAWCHIVE_STATUS_POLICIES", "timeout=retry,attempts=8; 5xx=fail")
    monkeypatch.setenv("PAWCHIVE_FANBOX_STATUS_POLICIES", "connection=retry,attempts=2")
    ctx.reload_settings()
    pawchive, fanbox = ctx.pawchive_http.policies, ctx.fanbox_http.policies
    assert fanbox.match(None, "timeout") == pawchive.match(None, "timeout")
    assert fanbox.match(None, "timeout").limit() == 8
    # Its own table still wins, and HTTP answers keep their per-source rules.
    assert fanbox.match(None, "connection").limit() == 2
    assert fanbox.match(503).action == "retry" and pawchive.match(503).action == "fail"
    assert fanbox.match(403).action == "fail"
