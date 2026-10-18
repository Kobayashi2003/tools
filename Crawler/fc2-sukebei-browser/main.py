#!/usr/bin/env python3
"""FC2 Sukebei Browser command line."""

import argparse
import io
import sys
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.config import Settings

for stream in (sys.stdout, sys.stderr):
    if isinstance(stream, io.TextIOWrapper):
        stream.reconfigure(encoding="utf-8", errors="replace")


def port_in_use(port):
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        return probe.connect_ex(("127.0.0.1", port)) == 0


def serve(settings, port):
    # Check before the app starts: a second instance would otherwise start crawling the same
    # library and, when its bind fails, remove the running server's PID file on the way out.
    if port_in_use(port):
        print(
            f"Port {port} is already in use — the server is probably running: http://127.0.0.1:{port}/"
        )
        return 1
    import uvicorn

    from app.server import create_app

    uvicorn.run(create_app(settings), host="127.0.0.1", port=port, workers=1)
    return 0


def crawl(
    settings: Settings,
    kind: str,
    query: str = "",
    blocks: int | None = 5,
    block_digits: int = 4,
    stop_on_empty: bool = False,
    id_range: tuple[int, int] | None = None,
) -> int:
    """Run one crawl job and wait until every queued title has its metadata."""
    import dataclasses

    from app.crawler import Crawler
    from app.media import MediaCache
    from app.net import Http
    from app.store import Store

    settings = dataclasses.replace(
        settings, watch_minutes=0
    )  # no timer-started jobs alongside this one
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    store = Store(settings.data_dir / "library.db")
    http = Http(delay=settings.source_delay, delays=settings.host_delays(), proxy=settings.proxy)
    crawler = Crawler(store, http, MediaCache(settings.data_dir / "media", http), settings)
    crawler.start()
    crawler.start_job(
        kind,
        query=query,
        blocks=blocks,
        block_digits=block_digits,
        stop_on_empty=stop_on_empty,
        id_range=id_range,
    )
    shown = 0
    try:
        while True:
            done = crawler.idle()
            lines = list(crawler.log_lines)
            for line in lines[shown:]:
                print(f"[{line['level']}] {line['message']}")
            shown = len(lines)
            if done:
                break
            time.sleep(1)
    except KeyboardInterrupt:
        crawler.cancel()
    finally:
        crawler.close()
        stats = store.stats()
        store.close()
    print(
        f"Library: {stats['titles']} title(s), {stats['torrents']} torrent(s), {stats['failed']} failed."
    )
    return 0


def doctor(settings):
    """Check that every source answers and still parses as expected."""
    from app import fc2, paipancon, sukebei
    from app.net import Http

    http = Http(delay=0.2, attempts=2, proxy=settings.proxy)
    ok = True
    try:
        listing = sukebei.parse_listing(http.text(sukebei.search_url(settings.default_query)))
        sample = next((t for t in listing.torrents if t.fc2_id), None)
        print(f"sukebei   OK  {len(listing.torrents)} rows, {listing.total} results")
        if not sample:
            raise RuntimeError("no row carries an FC2 code")
    except Exception as exc:
        print(f"sukebei   FAIL {exc}")
        return 1
    for name, check in (
        ("fc2", lambda i: fc2.fetch_article(http, i)),
        ("paipancon", lambda i: paipancon.fetch_detail(http, i)),
        ("sample", lambda i: fc2.fetch_sample_video(http, i)),
    ):
        try:
            result = check(sample.fc2_id)
            print(f"{name:<9} OK  FC2-PPV-{sample.fc2_id}: {'found' if result else 'not listed'}")
        except Exception as exc:
            ok = False
            print(f"{name:<9} FAIL {exc}")
    return 0 if ok else 1


def main():
    from app.config import Settings

    settings = Settings.from_env()
    parser = argparse.ArgumentParser(description="FC2 Sukebei Browser")
    commands = parser.add_subparsers(dest="command")
    serve_cmd = commands.add_parser("serve", help="Start the local Web UI (default)")
    serve_cmd.add_argument("--port", type=int, default=settings.port)
    crawl_cmd = commands.add_parser(
        "crawl", help="Grow the library without the UI, then fetch metadata"
    )
    crawl_cmd.add_argument(
        "kind",
        choices=("update", "older", "search"),
        help="update: new uploads; older: history blocks; search: a custom query",
    )
    crawl_cmd.add_argument("query", nargs="?", default="", help="sukebei query for `search`")
    crawl_cmd.add_argument(
        "--blocks", type=int, default=5, help="history blocks for `older` (default 5)"
    )
    crawl_cmd.add_argument("--all", action="store_true", help="`older`: every block that is left")
    crawl_cmd.add_argument(
        "--block-digits",
        type=int,
        choices=(3, 4, 5),
        default=4,
        help="`older`: block size as id-prefix digits: 3, 4 (default) or 5",
    )
    crawl_cmd.add_argument(
        "--stop-on-empty", action="store_true", help="`older`: stop at a block with no results"
    )
    crawl_cmd.add_argument(
        "--range",
        type=int,
        nargs=2,
        metavar=("FROM", "TO"),
        help="`older`: read the blocks between two FC2 ids; the history walk is not moved",
    )
    commands.add_parser("doctor", help="Check that sukebei, FC2 and paipancon answer and parse")
    args = parser.parse_args()

    if args.command == "crawl":
        return crawl(
            settings,
            args.kind,
            args.query,
            blocks=None if args.all or args.range else args.blocks,
            block_digits=args.block_digits,
            stop_on_empty=args.stop_on_empty,
            id_range=(args.range[0], args.range[1]) if args.range else None,
        )
    if args.command == "doctor":
        return doctor(settings)
    return serve(settings, getattr(args, "port", settings.port))


if __name__ == "__main__":
    raise SystemExit(main())
