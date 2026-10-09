"""Shared test doubles: a fake HTTP client serving canned pages, and an app wired to it."""

import time

import pytest
from fastapi.testclient import TestClient

from app import fc2, paipancon, sukebei
from app.config import Settings
from app.net import FetchError, NotFound
from app.server import create_app
from tests import fixtures


class FakeResponse:
    def __init__(self, body, content_type):
        self.body = body
        self.headers = {"Content-Type": content_type}

    def iter_content(self, size):
        yield self.body

    def close(self):
        pass


class FakeHttp:
    """Serves canned pages by URL. Unknown sukebei searches are empty; anything else is a 404."""

    def __init__(self):
        self.pages = {
            sukebei.search_url("FC2"): fixtures.listing_page(
                [fixtures.listing_row(4732176, "FC2-PPV-4802589 1080p", "22" * 20, seeders=2),
                 fixtures.listing_row(4732175, "fc2-ppv-4802589 first", "11" * 20, seeders=9),
                 fixtures.listing_row(4732100, "FC2 PPV 1289686 old", "33" * 20, seeders=0),
                 fixtures.listing_row(4732099, "No code here", "44" * 20)],
                total=4, has_next=False),
            fc2.article_url("4802589"): fixtures.FC2_ARTICLE,
            fc2.article_url("1289686"): fixtures.FC2_REMOVED,
            paipancon.detail_url("4802589"): fixtures.PAIPANCON,
            sukebei.view_url(4732175): fixtures.VIEW,
        }
        self.json_pages = {f"{fc2.BASE}/api/v2/videos/4802589/sample": {"path": "https://vip.fc2.com/s.mp4?mid=x", "code": 200}}
        self.media = {"https://paipancon.com/fc2daily/data/FC2-PPV-4802589/cover.jpg": (b"\xff\xd8jpeg", "image/jpeg")}
        self.requests = []
        self.last_headers = None

    def text(self, url, **kwargs):
        self.requests.append(url)
        if url in self.pages:
            return self.pages[url]
        if url.startswith(sukebei.BASE + "/?"):
            return fixtures.listing_page([], total=0, has_next=False)
        raise NotFound(f"HTTP 404 for {url}", 404)

    def json(self, url, **kwargs):
        self.last_headers = kwargs.get("headers")
        if url in self.json_pages:
            return self.json_pages[url]
        raise NotFound("HTTP 404", 404)

    def get(self, url, **kwargs):
        self.requests.append(url)
        if url in self.media:
            return FakeResponse(*self.media[url])
        raise FetchError("HTTP 404", 404)

    def close(self):
        pass


@pytest.fixture
def env(tmp_path):
    http = FakeHttp()
    app = create_app(Settings(data_dir=tmp_path, watch_minutes=0), start_worker=False, http=http)
    with TestClient(app) as client:
        yield client, app, http


def run_job(client, **body):
    """Start a crawl job and wait for it; returns the finished job."""
    response = client.post("/api/jobs", json=body)
    assert response.status_code == 200, response.text
    for _ in range(200):
        job = client.get("/api/status").json()["job"]
        if not job["running"]:
            return job
        time.sleep(0.01)
    raise AssertionError("job did not finish")


def drain(crawler):
    """Workers don't run in tests: empty the stage queues."""
    for q in crawler._queues.values():
        while (item := q.get(block=False)) is not None:
            q.done(item)
    crawler._priority.clear()


def crawl(client, app):
    """Update, then fetch both titles' metadata synchronously."""
    run_job(client, kind="update")
    crawler = app.state.crawler
    for fc2_id in ("4802589", "1289686"):
        crawler.enrich(fc2_id)
    drain(crawler)
