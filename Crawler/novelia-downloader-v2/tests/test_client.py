import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app.client import Client
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
            if self.path == "/denied":
                self.send_response(403)
                self.end_headers()
                return
            payload = b"<html>Not a book</html>" if self.path == "/invalid" else book
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr("app.client.SITE", f"http://127.0.0.1:{server.server_port}")
    client = Client(Settings(request_delay=0.2, retries=2))
    monkeypatch.setattr(client, "sleep", lambda _: None)
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
