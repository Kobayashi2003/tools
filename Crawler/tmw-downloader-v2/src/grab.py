"""Pressing the button, and what follows from it.

This is the only place that knows the whole route from a card to a file: which
message carries the button, that pressing it needs a gateway, that the reply is
a claim, and that a claim is what the download queue wants. Everything either
side of it stays ignorant -- the feed knows nothing about downloading, and the
queue knows nothing about Discord.

A claim, once opened, is kept: a hosted session is good for about an hour and
the reader counts every claim against a per-account limit, so looking at a job's
files and then fetching them is one press, not two.
"""

import threading
from typing import Dict

from .download import Downloads, Task
from .gateway import Gateway, GatewayError
from .hosted import Claim, open_claim
from .ledger import Ledger


class Grabber:
    def __init__(self, config, feed_for):
        self.config = config
        # channel id -> Feed. The page can be looking at any of the four clubs,
        # and a job belongs to the channel its message is in.
        self.feed_for = feed_for
        self.gateway = Gateway(config)
        self.ledger = Ledger(config.ledger_path)
        self.downloads = Downloads(config, self.ledger, self._open_task,
                                   self._finished)
        self.lock = threading.RLock()
        self._claims: Dict[str, Claim] = {}
        # job -> (channel id, message id): where the button that opens it lives.
        self._where: Dict[str, tuple] = {}

    # -- pressing ---------------------------------------------------------

    def press(self, feed, message_id: str) -> Claim:
        """Press one recommendation's button and read what comes back.

        Reuses a claim that is still good. A claim is one-time and the reader
        limits how many an account may hold, so pressing twice for the same job
        is not merely wasteful -- it can be refused.
        """
        rec = feed.post(message_id)
        if rec is None:
            raise LookupError("that recommendation is not in the archive")
        if not rec.job:
            raise LookupError("that post has no job on it")
        if feed.client is None:
            raise RuntimeError("this run is offline: start it without --offline")

        with self.lock:
            held = self._claims.get(rec.job)
            if held is not None and not held.stale:
                return held
            self._where[rec.job] = (feed.config.channel_id, rec.message_id)

        try:
            reply = self.gateway.press(
                feed.client,
                guild_id=feed.config.guild_id,
                channel_id=feed.config.channel_id,
                message_id=rec.message_id,
                custom_id=rec.custom_id or ("hosted_book_download" if rec.hosted
                                            else "third_party_download"),
                application_id=rec.author_id,
            )
        except GatewayError as exc:
            # Which step failed matters: the gateway is Discord, the claim is
            # the reader, and they fail for quite different reasons. Blaming
            # the download for a websocket that never came up sends you looking
            # in the wrong place.
            raise RuntimeError(str(exc)) from exc
        except Exception as exc:
            raise RuntimeError(f"the press was refused: {exc}") from exc

        claim = open_claim(self.config, rec.job, reply)
        if not claim.title:
            claim.title = rec.title or rec.job
        with self.lock:
            self._claims[rec.job] = claim
        return claim

    def _open_task(self, task: Task) -> Claim:
        """What the download worker calls when it reaches a job."""
        with self.lock:
            held = self._claims.get(task.job)
            if held is not None and not held.stale:
                return held
            where = self._where.get(task.job)
        channel_id = where[0] if where else None
        feed = self.feed_for(channel_id) if channel_id else None
        if feed is None:
            raise RuntimeError("lost track of which channel this job came from")
        # Force a fresh press: the held claim, if any, has gone stale.
        with self.lock:
            self._claims.pop(task.job, None)
        return self.press(feed, task.message_id)

    # -- queueing ---------------------------------------------------------

    def grab(self, feed, message_id: str, force: bool = False) -> Task:
        """Queue a recommendation. The button is pressed when its turn comes."""
        rec = feed.post(message_id)
        if rec is None:
            raise LookupError("that recommendation is not in the archive")
        if not rec.job:
            raise LookupError("that post has no job on it")
        with self.lock:
            self._where[rec.job] = (feed.config.channel_id, rec.message_id)
        return self.downloads.queue(rec.job, rec.message_id,
                                    rec.title or rec.job, feed.display_name,
                                    force=force)

    def _finished(self, task: Task) -> None:
        """Tick the recommendation off once its files are down.

        Down, not merely finished. A third-party job on a host with no direct
        form ends as `done` with nothing but a link to show for it, and ticking
        that would put the same mark on a book you have been shown as on one you
        are holding.
        """
        if task.state != "done":
            return
        if not any(t.state in ("done", "held") for t in task.transfers):
            return
        where = self._where.get(task.job)
        feed = self.feed_for(where[0]) if where else None
        if feed is not None:
            feed.state.take([task.job], True)

    # -- what the page shows ----------------------------------------------

    def status(self) -> dict:
        return self.downloads.status()

    def close(self) -> None:
        self.downloads.close()
        self.gateway.close()
