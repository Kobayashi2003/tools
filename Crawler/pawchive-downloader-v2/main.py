#!/usr/bin/env python3
"""Pawchive Downloader v2 command line. `serve` (the default) runs the Web UI and engine."""

import argparse
import io
import os
import sys
import threading
from pathlib import Path

from app.config import DEFAULT_PORT, PROJECT, load_dotenv

for stream in (sys.stdout, sys.stderr):
    if isinstance(stream, io.TextIOWrapper):
        stream.reconfigure(encoding="utf-8", errors="replace")


def data_dir() -> Path:
    return Path(os.environ.get("PAWCHIVE_DATA_DIR") or PROJECT / "data").resolve()


def main() -> int:
    load_dotenv(PROJECT / ".env")
    parser = argparse.ArgumentParser(description="Pawchive Downloader v2")
    commands = parser.add_subparsers(dest="command")
    serve = commands.add_parser("serve", help="Start the Web UI on 127.0.0.1 (default)")
    serve.add_argument("--port", type=int, default=DEFAULT_PORT)
    imp = commands.add_parser("import-v1", help="Import a v1 installation's state")
    imp.add_argument("root", type=Path, help="The v1 project directory")
    sync = commands.add_parser("sync", help="Sync one creator from both sources")
    sync.add_argument("creator", help="Creator id, e.g. fanbox_1539728")
    sync.add_argument("--deep", action="store_true", help="Re-read every Fanbox post body")
    dl = commands.add_parser("download", help="Download one creator's undone posts")
    dl.add_argument("creator")
    args = parser.parse_args()

    if args.command in (None, "serve"):
        import uvicorn

        from app.server import create_app

        port = getattr(args, "port", DEFAULT_PORT)
        # Open event streams would otherwise hold a graceful shutdown indefinitely.
        uvicorn.run(
            create_app(data_dir()),
            host="127.0.0.1",
            port=port,
            workers=1,
            timeout_graceful_shutdown=3,
        )
        return 0

    from app.engine.context import Context

    ctx = Context(data_dir())
    if args.command == "import-v1":
        from app.library.import_v1 import import_v1

        stats = import_v1(ctx, args.root, progress=print)
        print(stats)
        return 0
    cancel = threading.Event()
    if args.command == "sync":
        from app.engine.sync import refresh_subscriptions, sync_creator

        if ctx.store.fanbox_sessid():
            print(f"Supporting {refresh_subscriptions(ctx)} plans")
        result = sync_creator(ctx, args.creator, print, cancel, deep=args.deep)
        print(result.summary())
        return 0
    if args.command == "download":
        from app.engine.download import Downloader

        print(Downloader(ctx, cancel, print).creator(args.creator).summary())
        return 0
    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
