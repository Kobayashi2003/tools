import threading
import time
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app.client import Client, Deferred, Rejected, Throttle, TransientError, retry_after
from app.schema import Settings
from tests.conftest import epub


@pytest.fixture
def http_client(tmp_path, monkeypatch):
    book = epub(tmp_path / "valid.epub").read_bytes()
    hits = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            hits.append(self.path)
            if self.path == "/retry" and hits.count(self.path) == 1:
                self.send_response(429)
                self.send_header("Retry-After", "0")
                self.end_headers()
                return
            if self.path in ("/denied", "/missing", "/broken", "/limited"):
                self.send_response({"/denied": 403, "/missing": 404, "/broken": 500, "/limited": 429}[self.path])
                self.end_headers()
                return
            payload = b"<html>Not a book</html>" if self.path == "/invalid" else book
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            if self.path == "/truncated" and hits.count(self.path) == 1:
                self.wfile.write(payload[:100])  # connection closes before Content-Length is reached
                return
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr("app.client.SITE", f"http://127.0.0.1:{server.server_port}")
    clock = [1000.0]  # sleeping advances a fake clock instead of real time
    client = Client(Settings(request_delay=0.2, retries=2, rate_limit_patience=1),
                    throttle=Throttle(clock=lambda: clock[0]))

    def sleep(seconds):
        clock[0] += seconds

    monkeypatch.setattr(client, "sleep", sleep)
    try:
        yield client, hits, tmp_path
    finally:
        client.close()
        server.shutdown()
        server.server_close()
        thread.join()


def test_rate_limit_retry_and_atomic_download(http_client):
    client, hits, root = http_client
    target = root / "out.epub"
    size, digest = client.download("/retry", target)
    assert hits == ["/retry", "/retry"]
    assert size == target.stat().st_size and len(digest) == 64
    assert not target.with_suffix(".epub.part").exists()


def test_bad_payload_preserves_previous_source(http_client):
    client, _, root = http_client
    target = root / "out.epub"
    target.write_bytes(b"previous")
    with pytest.raises(Exception):
        client.download("/invalid", target)
    assert target.read_bytes() == b"previous"
    assert not target.with_suffix(".epub.part").exists()


def test_access_refusal_is_not_retried(http_client):
    client, hits, _ = http_client
    with pytest.raises(PermissionError):
        client.get("/denied")
    assert hits == ["/denied"]


def test_volume_url_encodes_path_and_repeats_translation_parameters(tmp_path):
    from urllib.parse import urlencode
    client = Client(Settings())
    captured = []
    client.download = lambda path, dest, params: captured.append((path, params))
    client.source("wenku/688da4c4c923db0b7aa9943e", "volume 1/2.epub", tmp_path / "out")
    path, params = captured[0]
    assert path.endswith("volume%201%2F2.epub")
    query = urlencode(params)
    assert query.count("translations=") == 3 and "filename=" in query
    client.close()


def test_rate_limit_slows_down_then_recovers(http_client):
    client, _, root = http_client
    client.download("/retry", root / "out.epub")
    throttle = client.throttle
    assert throttle.penalty > 0 and throttle.cooling() == 0 and throttle.strikes == 0
    penalty = throttle.penalty
    client.get("/ok").close()
    assert throttle.penalty < penalty


def test_persistent_rate_limit_defers_instead_of_failing(http_client, monkeypatch):
    client, hits, _ = http_client
    with pytest.raises(Deferred) as caught:
        client.get("/limited")
    assert caught.value.counts and caught.value.until > datetime.now(timezone.utc)
    assert 1 < len(hits) < 20


def test_interactive_client_reports_cooldown_quickly():
    throttle = Throttle()
    throttle.limited(Settings(backoff_base=60, backoff_max=60))
    client = Client(Settings(), throttle=throttle, interactive=True)
    with pytest.raises(Deferred, match="try again"):
        client.get("/anything")
    client.close()


def test_server_errors_are_transient_and_not_found_is_permanent(http_client):
    client, hits, _ = http_client
    with pytest.raises(TransientError):
        client.get("/broken")
    assert hits.count("/broken") == 2
    with pytest.raises(Rejected, match="404"):
        client.get("/missing")
    assert hits.count("/missing") == 1


def test_interrupted_transfer_is_retried(http_client):
    client, hits, root = http_client
    size, _ = client.download("/truncated", root / "out.epub")
    assert hits.count("/truncated") == 2 and size == (root / "out.epub").stat().st_size


def test_pause_lasts_at_least_as_long_as_the_sites_cooldown(http_client):
    client, _, _ = http_client
    client.throttle.limited(client.config, hint=7200)
    with pytest.raises(Deferred) as caught:
        client.get("/ok")
    assert caught.value.until - datetime.now(timezone.utc) > timedelta(minutes=119)


def test_rest_happens_before_the_next_request_not_inside_download(http_client):
    client, _, root = http_client
    client.config = client.config.model_copy(update={"rest_every": 1, "rest_seconds": 30})
    waits = []
    client.wait = lambda seconds, reason: waits.append(reason)
    client.download("/ok", root / "a.epub")
    assert not waits and client.rest_due
    client.get("/ok").close()
    assert waits == ["Resting after 1 downloads"] and not client.rest_due


def test_invalid_json_and_unchecked_broken_archives_are_transient(http_client):
    client, hits, root = http_client
    with pytest.raises(TransientError):
        client.json("/invalid")
    with pytest.raises(ValueError, match="valid EPUB"):  # complete by Content-Length: permanent
        client.download("/invalid", root / "out.epub")
    assert hits.count("/invalid") == 2


def test_interactive_requests_do_not_wait_for_a_long_slot():
    throttle = Throttle()
    throttle.next_at = time.monotonic() + 300
    client = Client(Settings(), throttle=throttle, interactive=True)
    with pytest.raises(Deferred):
        client.get("/anything")
    client.close()


def test_retry_after_accepts_seconds_and_dates():
    assert retry_after("12") == 12
    assert retry_after("") is None and retry_after("soon") is None
    later = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=90), usegmt=True)
    assert 80 < retry_after(later) <= 90