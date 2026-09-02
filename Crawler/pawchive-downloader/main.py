"""Entry point: build the object graph, start the scheduler, run the shell."""

import os
import signal
import sys

# Many creator names are Japanese; the default Windows console codec (cp932)
# would raise UnicodeEncodeError when printing them. Force UTF-8 output.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

from src import (
    API, Cache, CLIContext, Downloader, ExternalLinksDownloader, ExternalLinksExtractor,
    Logger, Migrator, Notifier, Scheduler, Storage, Validator,
)
from src.cli import shell
from src.common.env import load_dotenv
from src.common.hotreload import dynamic_get

_shutting_down = False


def get_commands() -> dict:
    """Load the command map fresh each call so edits to src/cli/commands.py hot-reload."""
    from src.cli.commands import COMMAND_MAP
    return dynamic_get('COMMAND_MAP', 'src/cli/commands.py', default=COMMAND_MAP)


def initialize():
    load_dotenv()  # proxies and PAWCHIVE_* overrides, before anything reads them
    storage = Storage()
    config = storage.load_config()
    logger = Logger(config.logs_dir)
    cache = Cache(config.cache_dir, logger, config, storage)
    api = API(logger, config)
    notifier = Notifier(enabled=config.notify)
    downloader = Downloader(config, logger, storage, cache, api, notifier=notifier)
    scheduler = Scheduler(storage, downloader, logger, config.global_timer,
                          max_workers=config.max_concurrent_artists)
    migrator = Migrator(storage, cache)
    validator = Validator(config.data_dir, cache, storage, config, logger)
    links_extractor = ExternalLinksExtractor(cache, logger)
    links_downloader = ExternalLinksDownloader(logger)
    ctx = CLIContext(storage, cache, api, downloader, scheduler, migrator, validator,
                     links_extractor, links_downloader)
    return ctx, scheduler, logger


def main():
    def on_sigint(signum, frame):
        # A second Ctrl+C during shutdown force-quits a hung teardown.
        if _shutting_down:
            os._exit(1)
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, on_sigint)

    ctx, scheduler, logger = initialize()
    scheduler.start()
    logger.app_started(artists=len(ctx.storage.get_artists()))
    print("Pawchive Downloader. Type 'help' for commands, 'exit' to quit.")

    try:
        shell.run(ctx, get_commands, logger)
    finally:
        global _shutting_down
        _shutting_down = True
        print("Stopping... (Ctrl+C to force quit)")
        ctx.downloader.abort_requests()  # unblock in-flight HTTP and retry loops
        scheduler.stop()
        logger.app_stopped()
        print("Bye.")


if __name__ == "__main__":
    main()
