"""How crawl jobs grow the library: Update toward new uploads, Older down through FC2 id blocks."""

from app import sukebei
from app.crawler import HISTORY, NEW, URGENT, StageQueue
from app.net import FetchError
from tests import fixtures
from tests.conftest import drain, run_job


def searched(http):
    """The sukebei queries requested, in order (page 1 only)."""
    from urllib.parse import parse_qs, urlsplit
    out = []
    for url in http.requests:
        if url.startswith(sukebei.BASE + "/?"):
            params = parse_qs(urlsplit(url).query)
            if "p" not in params:
                out.append(params["q"][0])
    return out


def test_update_stops_at_the_newest_torrent_already_held(env):
    client, app, http = env
    first = run_job(client, kind="update")
    assert (first["seen"], first["new_torrents"], first["new_titles"]) == (3, 3, 2)
    assert app.state.store.get_meta("newest_view_id") == 4732176

    http.pages[sukebei.search_url("FC2")] = fixtures.listing_page(
        [fixtures.listing_row(4732300, "FC2-PPV-4900001 new", "55" * 20),
         fixtures.listing_row(4732176, "FC2-PPV-4802589 1080p", "22" * 20)], total=1000, has_next=True)
    http.requests.clear()
    second = run_job(client, kind="update")
    assert second["pages_read"] == 1                     # stopped at a known torrent; page 2 never read
    assert (second["new_torrents"], second["new_titles"]) == (1, 1)
    assert app.state.store.get_meta("newest_view_id") == 4732300
    assert not second["gap"]


def test_repeated_update_counts_nothing_new(env):
    client, app, _ = env
    run_job(client, kind="update")
    again = run_job(client, kind="update")
    assert (again["seen"], again["new_torrents"], again["new_titles"]) == (3, 0, 0)


def test_update_reports_a_gap_when_the_listing_cap_is_hit_before_the_frontier(env):
    client, app, http = env
    app.state.store.set_meta("newest_view_id", 100)
    http.pages[sukebei.search_url("FC2")] = fixtures.listing_page(
        [fixtures.listing_row(4732300, "FC2-PPV-4900001 new", "55" * 20)], total=1000, has_next=False)
    job = run_job(client, kind="update")
    assert job["gap"]
    assert client.get("/api/status").json()["coverage"]["update_gap"]


def test_older_walks_id_blocks_downward_and_resumes(env):
    client, app, http = env
    run_job(client, kind="update")                       # highest id held: 4802589
    http.pages[sukebei.search_url("4802*")] = fixtures.listing_page(
        [fixtures.listing_row(4700001, "FC2-PPV-4802111 older", "66" * 20)], total=1, has_next=False)
    http.requests.clear()

    job = run_job(client, kind="older", blocks=2)
    assert searched(http) == ["4802*", "4801*"]
    assert job["blocks_done"] == 2 and job["new_titles"] == 1
    coverage = client.get("/api/status").json()["coverage"]
    assert (coverage["history_top"], coverage["history_next"]) == (4802, 4800)

    http.requests.clear()
    run_job(client, kind="older", blocks=1)              # continues where it stopped
    assert searched(http) == ["4800*"]
    assert app.state.store.get_meta("history_next") == 4799


def test_a_block_hitting_the_cap_is_split_into_ten(env):
    client, app, http = env
    run_job(client, kind="update")
    http.pages[sukebei.search_url("4802*")] = fixtures.listing_page([], total=1000, has_next=True)
    http.requests.clear()
    run_job(client, kind="older", blocks=1)
    assert searched(http) == ["4802*"] + [f"4802{d}*" for d in "9876543210"]
    assert app.state.store.get_meta("history_next") == 4801


def test_a_failed_block_is_not_marked_done(env):
    client, app, http = env
    run_job(client, kind="update")
    real_text = http.text

    def broken(url, **kwargs):
        if "4801" in url:
            raise FetchError("HTTP 503", 503)
        return real_text(url, **kwargs)

    http.text = broken
    job = run_job(client, kind="older", blocks=3)
    assert job["error"] and job["blocks_done"] == 1
    assert app.state.store.get_meta("history_next") == 4801      # retried from 4801 next time



def test_history_wraps_to_the_short_ids_above_its_start(env):
    """After block 1000 the walk continues at 9999: old 5-6 digit ids such as 958123 (prefix 9581)."""
    client, app, http = env
    run_job(client, kind="update")
    app.state.store.set_meta("history_top", 4802)
    app.state.store.set_meta("history_next", 1000)
    http.requests.clear()
    run_job(client, kind="older", blocks=2)
    assert searched(http) == ["1000*", "9999*"]
    coverage = client.get("/api/status").json()["coverage"]
    assert coverage["history_next"] == 9998 and coverage["history_phase"] == "short"
    assert not coverage["history_complete"]
    assert coverage["history_blocks"] == (4802 - 1000 + 1) + 1


def test_history_completes_just_above_where_it_started(env):
    client, app, http = env
    run_job(client, kind="update")
    app.state.store.set_meta("history_top", 4802)
    app.state.store.set_meta("history_next", 4803)
    http.requests.clear()
    run_job(client, kind="older", blocks=5)
    assert searched(http) == ["4803*"]
    coverage = client.get("/api/status").json()["coverage"]
    assert coverage["history_complete"] and coverage["history_blocks"] == coverage["history_total"] == 9000
    http.requests.clear()
    run_job(client, kind="older", blocks=5)                # nothing left to read
    assert searched(http) == []


def test_next_block_covers_every_prefix_once():
    from app.crawler import next_block
    seen, cursor = [], 4802
    while cursor is not None:
        seen.append(cursor)
        cursor = next_block(cursor, 4802)
    assert sorted(seen) == list(range(1000, 10000))


def test_older_needs_a_library(env):
    client, _, _ = env
    assert "Update first" in run_job(client, kind="older")["error"]


def test_reset_history_starts_again_from_the_newest_block(env):
    client, app, _ = env
    app.state.store.set_meta("history_next", 4000)
    app.state.store.set_meta("update_gap", True)
    coverage = client.post("/api/history/reset", json={}).json()
    assert coverage["history_next"] is None and not coverage["update_gap"]
    app.state.crawler._job = {"running": True}
    assert client.post("/api/history/reset", json={}).status_code == 409   # an Older run would overwrite it


def test_history_titles_wait_behind_new_uploads(env):
    client, app, http = env
    crawler = app.state.crawler
    run_job(client, kind="update")                       # 4802589, 1289686 queued as new uploads
    http.pages[sukebei.search_url("4802*")] = fixtures.listing_page(
        [fixtures.listing_row(4700001, "FC2-PPV-4802111 older", "66" * 20)], total=1, has_next=False)
    run_job(client, kind="older", blocks=1)
    http.pages[sukebei.search_url("FC2")] = fixtures.listing_page(
        [fixtures.listing_row(4732300, "FC2-PPV-4900001 new", "55" * 20)], total=1, has_next=False)
    run_job(client, kind="update")                       # a later new upload still goes first
    assert crawler._queues["fc2"].ids() == ["4802589", "1289686", "4900001", "4802111"]
    drain(crawler)


def test_custom_search_reads_every_page_until_the_last(env):
    client, app, http = env
    http.pages[sukebei.search_url("bisirichn")] = fixtures.listing_page(
        [fixtures.listing_row(4732400, "FC2-PPV-4700000 seller pick", "77" * 20)], total=76, has_next=True)
    http.requests.clear()
    job = run_job(client, kind="search", query="bisirichn")
    assert job["pages_read"] == 2 and job["new_titles"] == 1


def test_stage_queue_orders_by_priority_then_arrival_with_urgent_newest_first():
    q = StageQueue()
    q.put("history", HISTORY)
    q.put("new-1", NEW)
    q.put("new-2", NEW)
    q.put("look-1", URGENT, newest_first=True)
    q.put("look-2", URGENT, newest_first=True)
    assert q.put("history", NEW) is False                # moved up, not added twice
    assert q.ids() == ["look-2", "look-1", "new-1", "new-2", "history"]
    assert [q.get(block=False) for _ in range(5)] == ["look-2", "look-1", "new-1", "new-2", "history"]
    assert q.get(block=False) is None and q.unfinished == 5


def test_cancelled_update_is_not_relaunched_at_once(env):
    client, app, _ = env
    crawler, store = app.state.crawler, app.state.store
    crawler.settings = crawler.settings.__class__(**{**crawler.settings.__dict__, "watch_minutes": 30})
    assert crawler.update_due(now=10_000)                       # never updated
    store.set_meta("last_update_try", 10_000)                   # an attempt that was cancelled
    assert not crawler.update_due(now=10_000 + 60)
    assert crawler.update_due(now=10_000 + 601)                 # retried after ten minutes
    store.set_meta("last_update_at", 20_000)
    assert not crawler.update_due(now=20_000 + 29 * 60)
    assert crawler.update_due(now=20_000 + 30 * 60)


def test_worker_hands_over_before_marking_the_stage_done(env):
    """idle() must never see a title between its two stages."""
    import threading

    client, app, _ = env
    crawler = app.state.crawler
    run_job(client, kind="update")
    drain(crawler)
    seen = []
    real = crawler._hand_over
    crawler._hand_over = lambda fc2_id: (seen.append(crawler._queues["fc2"].unfinished), real(fc2_id))
    crawler.schedule(["4802589"], NEW)
    worker = threading.Thread(target=crawler._worker, args=("fc2",))
    worker.start()
    for _ in range(200):
        if seen:
            break
        threading.Event().wait(0.01)
    crawler._queues["fc2"].close()
    worker.join(2)
    assert seen == [1]                                          # still counted while handing over
    assert crawler._queues["pp"].ids() == ["4802589"] and not crawler.idle()
    drain(crawler)
