import time

import pytest

from app import paipancon
from app.net import FetchError
from tests.conftest import FakeResponse, crawl, drain, run_job


def test_search_groups_torrents_by_fc2_id(env):
    client, app, http = env
    crawl(client, app)
    status = client.get("/api/status").json()
    assert status["job"]["seen"] == 3 and status["job"]["new_torrents"] == 3 and status["job"]["new_titles"] == 2
    assert status["stats"]["titles"] == 2 and status["stats"]["torrents"] == 3

    listing = client.get("/api/titles").json()
    assert listing["total"] == 2
    by_id = {item["fc2_id"]: item for item in listing["items"]}
    item = by_id["4802589"]
    assert item["torrent_count"] == 2 and item["seeders"] == 9
    assert item["title"] == "美巨乳&JD" and item["seller"] == "美尻ちゃんねる"
    assert item["magnet"].startswith("magnet:?xt=urn:btih:" + "11" * 20)
    assert len(item["clips"]) == 2 and len(item["samples"]) == 2
    assert item["grid"].endswith("/grid.jpg")


def test_removed_article_falls_back_to_torrent_name(env):
    client, app, _ = env
    crawl(client, app)
    title = client.get("/api/titles/1289686").json()
    assert title["fc2_state"] == "removed" and title["pp_state"] == "missing"
    assert title["state"] == "done"
    assert title["title"] == "old"
    assert title["torrents"][0]["view_id"] == 4732100


def test_rate_limited_source_is_retried_alone(env):
    client, app, http = env
    crawl(client, app)
    crawler, store = app.state.crawler, app.state.store
    store.reset_sources("4802589", everything=True)
    real_text = http.text

    def limited(url, **kwargs):
        if "paipancon" in url:
            raise FetchError("HTTP 429", 429)
        return real_text(url, **kwargs)

    http.text = limited
    crawler.enrich("4802589")
    title = client.get("/api/titles/4802589").json()
    assert title["state"] == "failed" and title["fc2_state"] == "ok" and title["pp_state"] == "error"
    assert "429" in title["errors"]["pp"] and title["attempts"] == 1
    assert title["title"] == "美巨乳&JD"          # FC2 data is kept while paipancon is retried
    assert client.get("/api/status").json()["stats"]["failed"] == 1

    http.text = real_text
    http.requests.clear()
    assert client.post("/api/retry-failed", json={}).json() == {"queued": 1}
    assert len(crawler._queues["pp"]) == 1 and len(crawler._queues["fc2"]) == 0
    crawler.fetch_paipancon(crawler._queues["pp"].get(block=False))
    assert http.requests == [paipancon.detail_url("4802589")]
    title = client.get("/api/titles/4802589").json()
    assert title["state"] == "done" and title["errors"] == {} and len(title["clips"]) == 2


def test_new_titles_start_in_the_fc2_stage(env):
    client, app, _ = env
    run_job(client, kind="update")
    status = client.get("/api/status").json()
    assert status["waiting"] == {"fc2": 2, "pp": 0}
    item = client.get("/api/titles").json()["items"][0]
    assert item["state"] == "pending" and item["fc2_state"] == "" and item["title"]  # torrent name fallback


def test_filters_and_flags(env):
    client, app, _ = env
    crawl(client, app)
    assert client.get("/api/titles", params={"q": "JD"}).json()["total"] == 1
    assert client.get("/api/titles", params={"q": "FC2-PPV-1289686"}).json()["items"][0]["fc2_id"] == "1289686"
    assert client.get("/api/titles", params={"min_seeders": 1}).json()["total"] == 1
    assert client.get("/api/titles", params={"media_only": True}).json()["total"] == 1

    client.post("/api/titles/4802589/flags", json={"starred": True})
    client.post("/api/titles/1289686/flags", json={"hidden": True})
    assert [i["fc2_id"] for i in client.get("/api/titles", params={"view": "starred"}).json()["items"]] == ["4802589"]
    assert [i["fc2_id"] for i in client.get("/api/titles").json()["items"]] == ["4802589"]
    assert [i["fc2_id"] for i in client.get("/api/titles", params={"view": "hidden"}).json()["items"]] == ["1289686"]

    client.get("/api/titles/4802589")  # opening marks it viewed
    assert client.get("/api/titles", params={"view": "unseen"}).json()["total"] == 0
    assert client.get("/api/titles", params={"view": "bogus"}).status_code == 400


def test_torrent_file_list_flags_risky_torrents(env):
    client, app, http = env
    crawl(client, app)
    torrent = client.get("/api/torrents/4732175").json()
    assert torrent["risky"] is True
    assert [f["risky"] for f in torrent["files"]] == [True, False, False, True]
    # Cached: a second read does not hit sukebei again.
    before = len(http.requests)
    client.get("/api/torrents/4732175")
    assert len(http.requests) == before
    item = next(i for i in client.get("/api/titles").json()["items"] if i["fc2_id"] == "4802589")
    assert item["risky"] is True
    assert client.get("/api/torrents/1").status_code == 404


def test_sample_video_is_fetched_on_demand(env):
    client, app, http = env
    response = client.get("/api/titles/4802589/sample", headers={"User-Agent": "ViewerBrowser/1.0"})
    assert response.json()["url"].startswith("https://vip.fc2.com/")
    # The signed URL only plays for the UA that requested it, so the browser's UA is forwarded.
    assert http.last_headers == {"User-Agent": "ViewerBrowser/1.0"}
    assert client.get("/api/titles/1289686/sample").status_code == 404


def test_media_proxy_caches_and_rejects_other_hosts(env):
    client, app, http = env
    url = "https://paipancon.com/fc2daily/data/FC2-PPV-4802589/cover.jpg"
    first = client.get("/media", params={"u": url})
    assert first.status_code == 200 and first.content == b"\xff\xd8jpeg"
    assert first.headers["content-type"] == "image/jpeg"
    fetched = http.requests.count(url)
    assert client.get("/media", params={"u": url}).status_code == 200
    assert http.requests.count(url) == fetched
    assert client.get("/media", params={"u": "https://example.com/a.jpg"}).status_code == 403
    assert client.get("/media", params={"u": "https://evil.paipancon.com.example.org/a.jpg"}).status_code == 403
    assert client.get("/media", params={"u": "https://evilpaipancon.com/a.jpg"}).status_code == 403
    assert client.get("/media", params={"u": "file:///C:/Windows/win.ini"}).status_code == 403
    assert client.get("/media", params={"u": "https://paipancon.com/missing.jpg"}).status_code == 404


def test_refresh_requeues_and_clears_cached_media(env):
    client, app, http = env
    crawl(client, app)
    url = "https://paipancon.com/fc2daily/data/FC2-PPV-4802589/cover.jpg"
    app.state.store.save_source("4802589", "pp", {"pp_state": "ok", "cover": url})
    client.get("/media", params={"u": url})
    assert app.state.media.path_for(url).exists()
    assert client.post("/api/titles/4802589/refresh", json={}).json() == {"ok": True}
    assert not app.state.media.path_for(url).exists()
    assert client.get("/api/titles/4802589").json()["state"] == "pending"
    assert client.post("/api/titles/9999999/refresh", json={}).status_code == 404


def test_opening_a_waiting_title_moves_it_to_the_front(env):
    client, app, _ = env
    crawler, store = app.state.crawler, app.state.store
    for fc2_id in ("1111111", "2222222", "3333333"):
        store.ensure_title(fc2_id)
        store.save_source(fc2_id, "fc2", {"fc2_state": "ok"})
    crawler.schedule(["1111111", "2222222", "3333333"])
    assert crawler._queues["pp"].ids() == ["1111111", "2222222", "3333333"]

    store.upsert_torrents([{"view_id": 1, "fc2_id": "3333333", "name": "FC2-PPV-3333333 x", "infohash": "a",
                            "magnet": "magnet:?", "category": "", "size_bytes": 0, "uploaded_at": 0,
                            "seeders": 0, "leechers": 0, "downloads": 0, "flag": ""}])
    client.get("/api/titles/3333333")
    assert crawler._queues["pp"].ids() == ["3333333", "1111111", "2222222"]
    assert client.post("/api/titles/2222222/prioritize", json={}).json() == {"queued": 0}   # moved, not duplicated
    assert crawler._queues["pp"].ids() == ["2222222", "3333333", "1111111"]


def test_prioritized_title_stays_first_when_handed_to_paipancon(env):
    client, app, _ = env
    crawler, store = app.state.crawler, app.state.store
    crawl(client, app)
    for fc2_id in ("1111111", "2222222"):
        store.ensure_title(fc2_id)
        store.save_source(fc2_id, "fc2", {"fc2_state": "ok"})
    crawler.schedule(["1111111", "2222222"])
    store.reset_sources("4802589", everything=True)
    crawler.prioritize("4802589")
    assert crawler._queues["fc2"].get(block=False) == "4802589"
    crawler.fetch_fc2("4802589")
    crawler._hand_over("4802589")
    assert crawler._queues["pp"].ids()[0] == "4802589"
    crawler.fetch_paipancon(crawler._queues["pp"].get(block=False))
    crawler._hand_over("4802589")
    assert "4802589" not in crawler._priority


def test_fetch_in_flight_during_refresh_is_discarded(env):
    client, app, _ = env
    crawler = app.state.crawler
    crawl(client, app)
    started = time.monotonic()
    time.sleep(0.01)
    crawler.refresh("4802589")
    crawler.fetch_paipancon("4802589", started)        # began before the refresh: result dropped
    title = client.get("/api/titles/4802589?mark_viewed=false").json()
    assert title["pp_state"] == "" and title["fc2_state"] == ""
    crawler.fetch_paipancon("4802589", time.monotonic())
    assert client.get("/api/titles/4802589?mark_viewed=false").json()["pp_state"] == "ok"


def test_idle_waits_for_items_taken_but_unfinished(env):
    client, app, _ = env
    crawler = app.state.crawler
    assert crawler.idle()
    app.state.store.ensure_title("1111111")
    crawler.schedule(["1111111"])
    taken = crawler._queues["fc2"].get(block=False)      # a worker took it but has not finished
    assert not crawler.idle()
    crawler._queues["fc2"].done(taken)
    assert crawler.idle()


def test_media_download_dropped_midway_is_a_502_without_leftovers(env):
    import requests

    client, app, http = env
    url = "https://paipancon.com/fc2daily/data/FC2-PPV-4802589/clip.mp4"

    class Dropping(FakeResponse):
        def iter_content(self, size):
            yield b"partial"
            raise requests.exceptions.ChunkedEncodingError("connection reset")

    http.get = lambda u, **kw: Dropping(b"", "video/mp4")
    assert client.get("/media", params={"u": url}).status_code == 502
    path = app.state.media.path_for(url)
    assert not path.exists() and not list(path.parent.glob("*.part"))


def test_sample_api_answering_html_is_a_502(env):
    client, app, http = env

    def html_instead_of_json(url, **kwargs):
        raise ValueError("Expecting value: line 1 column 1")

    http.json = html_instead_of_json
    assert client.get("/api/titles/4802589/sample").status_code == 502


def test_second_search_while_running_conflicts(env):
    client, app, _ = env
    crawler = app.state.crawler
    crawler._job = {"running": True}
    assert client.post("/api/jobs", json={"kind": "update"}).status_code == 409


def test_media_redirects_only_to_allowed_hosts(env):
    client, app, http = env

    class Redirect(FakeResponse):
        is_redirect = True

        def __init__(self, location):
            super().__init__(b"", "text/html")
            self.headers["Location"] = location

    def get(url, **kwargs):
        http.requests.append(url)
        if url == "https://someone.blog.fc2.com/a.jpg":
            return Redirect("http://127.0.0.1:18050/api/status")
        if url == "https://someone.blog.fc2.com/b.jpg":
            return Redirect("https://paipancon.com/fc2daily/data/FC2-PPV-4802589/cover.jpg")
        if url == "https://paipancon.com/fc2daily/data/FC2-PPV-4802589/cover.jpg":
            return FakeResponse(b"\xff\xd8jpeg", "image/jpeg")
        raise FetchError("HTTP 404", 404)

    http.get = get
    assert client.get("/media", params={"u": "https://someone.blog.fc2.com/a.jpg"}).status_code == 502
    assert "http://127.0.0.1:18050/api/status" not in http.requests
    followed = client.get("/media", params={"u": "https://someone.blog.fc2.com/b.jpg"})
    assert followed.status_code == 200 and followed.content == b"\xff\xd8jpeg"


def test_form_posts_from_other_sites_are_refused(env):
    client, _, _ = env
    form = client.post("/api/jobs/cancel", data={"x": "1"})
    assert form.status_code == 415
    assert client.post("/api/jobs/cancel", json={}).status_code == 200


def test_reading_marks(env):
    client, app, _ = env
    crawl(client, app)
    assert client.get("/api/marks").json() == []
    marks = client.post("/api/marks", json={"fc2_id": "FC2-PPV-1289686"}).json()
    assert [m["fc2_id"] for m in marks] == ["1289686"] and marks[0]["title"] == "old"
    client.post("/api/marks", json={"fc2_id": "4802589"})
    client.post("/api/marks", json={"fc2_id": "4802589"})              # marking twice keeps one mark
    assert [m["fc2_id"] for m in client.get("/api/marks").json()] == ["1289686", "4802589"]
    client.post("/api/marks", json={"fc2_id": "7777777"})              # unknown titles are ignored
    assert len(client.get("/api/marks").json()) == 2
    assert [m["fc2_id"] for m in client.delete("/api/marks/1289686").json()] == ["4802589"]


def test_title_order_matches_the_list(env):
    client, app, _ = env
    crawl(client, app)
    for sort in ("uploaded", "seeders", "id"):
        listed = [i["fc2_id"] for i in client.get("/api/titles", params={"sort": sort}).json()["items"]]
        assert client.get("/api/titles/order", params={"sort": sort}).json()["ids"] == listed
    client.post("/api/titles/1289686/flags", json={"hidden": True})
    assert client.get("/api/titles/order").json()["ids"] == ["4802589"]
