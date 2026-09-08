"""A local page over the feed.

Bound to 127.0.0.1 and unauthenticated. Any site you have open can also reach
127.0.0.1, so requests carrying a foreign `Origin` are refused -- otherwise a
stray tab could press a button in your name.
"""

import gzip
import json
import mimetypes
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .config import parse_history
from .job import FetchJob
from .state import ChannelState, read_channel_names

WEB_ROOT = Path(__file__).parent / "web"


def _scope(query: str) -> dict:
    """Read `tail` and `cap` overrides off a query string. Scope is a
    per-request argument, not server state, so the page owns which slice it
    is looking at and a reload does not depend on earlier clicks."""
    params = parse_qs(query)
    scope = {}
    if "tail" in params:
        scope["tail"] = params["tail"][0] not in ("0", "false", "")
    if "cap" in params:
        try:
            scope["cap"] = max(0, int(params["cap"][0]))
        except ValueError:
            pass
    return scope


class Handler(BaseHTTPRequestHandler):
    server_version = "tmw-recommendations/2.0"
    channels = None        # every channel this run has opened
    grabber = None         # pressing buttons and fetching what they give
    channel_list = None    # the guild's channels, fetched once
    jobs = {}              # channel id -> the crawl running behind its page
    names = None           # channel id -> name, as far as anything knows
    asked_names = set()    # ids Discord has already been asked about, once

    # This guards the maps above and nothing else. Each Feed serialises its own
    # work, so a crawl of one channel no longer holds the whole server still.
    lock = threading.RLock()

    # -- channels ---------------------------------------------------------

    @property
    def feed(self):
        """The channel named on the command line."""
        return self.channels.main

    def feed_for(self, channel_id):
        """The Feed for a channel, made on demand."""
        cid = str(channel_id or "").strip() or self.feed.config.channel_id
        return self.channels.get(cid, self._name_of(cid))

    def _known_names(self) -> dict:
        """Names already on record, kept for the life of the process."""
        if Handler.names is None:
            Handler.names = read_channel_names(self.feed.config.state_path)
        return Handler.names

    def _remember_name(self, cid: str, name: str) -> None:
        name = (name or "").strip()
        if not name or name == cid or self._known_names().get(cid) == name:
            return
        Handler.names[cid] = name
        # Written where the switcher can find it next time, offline included.
        ChannelState(self.feed.config.state_path, cid).note_name(name)

    def _ask_name(self, cid: str) -> str:
        """Ask Discord what a channel is called, once per run."""
        if cid in Handler.asked_names or self.feed.client is None:
            return ""
        Handler.asked_names.add(cid)
        status, _why, body = self.feed.client.probe("GET", f"/channels/{cid}")
        if status and 200 <= status < 300 and isinstance(body, dict):
            name = str(body.get("name") or "")
            self._remember_name(cid, name)
            return name
        return ""

    def _name_of(self, cid):
        for entry in self.channel_list or []:
            if entry["id"] == cid:
                return entry["name"]
        if cid == self.feed.config.channel_id and self.feed.config.channel_name:
            return self.feed.config.channel_name
        other = self.channels.opened(cid)
        if other is not None and other.config.channel_name:
            return other.config.channel_name
        return self._known_names().get(cid, "")

    def _cached_ids(self):
        found = set()
        for path in Path(self.feed.config.cache_dir).glob("messages_*.json"):
            found.add(path.stem.split("_", 1)[1])
        return found

    def _channels(self):
        """What the switcher offers.

        Channels already cached come first, then the four clubs' recommendation
        channels, then the rest -- the sharing is all in the ones named
        *recommendations* and a flat list of the server buries them.
        """
        with self.lock:
            if Handler.channel_list is None and self.feed.client is not None:
                try:
                    Handler.channel_list = self.feed.client.guild_channels()
                except Exception:
                    Handler.channel_list = []

        cached = self._cached_ids()
        for entry in Handler.channel_list or []:
            if entry["id"] in cached:
                self._remember_name(entry["id"], entry.get("name", ""))
        for cid in cached:
            if not self._name_of(cid):
                self._ask_name(cid)

        listed = list(Handler.channel_list or [])
        if not listed:
            # Offline, or the guild would not say: offer what is on disk.
            listed = [{"id": cid, "name": self._name_of(cid) or cid, "position": 0}
                      for cid in sorted(cached | {self.feed.config.channel_id})]

        def rank(entry):
            return (0 if entry["id"] in cached else 1,
                    0 if "recommendation" in entry["name"] else 1,
                    entry.get("position", 0), entry["name"])

        return [dict(entry, cached=entry["id"] in cached)
                for entry in sorted(listed, key=rank)]

    def _index(self, feed, scope: dict) -> dict:
        """The index, plus the switcher's channel list and what is on disk."""
        payload = feed.payload(**scope)
        payload["channels"] = self._channels()
        payload["held"] = self._held(payload["posts"], feed)
        return payload

    def _held(self, posts, feed=None) -> dict:
        """job -> where its files landed, for the posts being sent.

        The ledger and the tick can drift apart -- a state file restored from a
        backup, or one an older run wrote badly -- and of the two the ledger is
        the one that can be checked against the disk. So anything it holds that
        is not ticked gets ticked here, which makes the mark self-healing rather
        than something to be re-earned by downloading the book twice.
        """
        ledger = self.grabber.ledger if self.grabber else None
        if ledger is None:
            return {}
        out, missing = {}, []
        for post in posts:
            entry = ledger.get(post.get("job"))
            if entry:
                out[post["job"]] = {"dir": entry.get("dir", ""),
                                    "n": len(entry.get("files") or [])}
                if feed is not None and post["job"] not in feed.state.taken:
                    missing.append(post["job"])
        if missing:
            feed.state.take(missing, True)
        return out

    # -- the crawl --------------------------------------------------------

    def _job(self, feed):
        with self.lock:
            return Handler.jobs.get(feed.config.channel_id)

    def _start_job(self, feed, spec: str, direction: str):
        """Begin a crawl of this channel, unless one is already under way."""
        with self.lock:
            running = Handler.jobs.get(feed.config.channel_id)
            if running is not None and running.active:
                return running, True
            job = FetchJob(feed, spec, direction)
            Handler.jobs[feed.config.channel_id] = job
            return job.start(), False

    def _fetch_state(self, feed) -> dict:
        """What the page polls: the crawl, and what the archive now covers."""
        job = self._job(feed)
        return {
            "fetch": job.status() if job else None,
            "coverage": feed.coverage(),
            "offline": feed.client is None,
        }

    # -- helpers ----------------------------------------------------------

    def log_message(self, fmt, *args):
        pass  # The console belongs to the sync progress, not to every asset.

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        encoding = None
        if len(body) > 4096 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body, encoding = gzip.compress(body, 5), "gzip"

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (ConnectionError, TimeoutError):
            # The tab was closed, reloaded, or navigated away mid-response --
            # which is ordinary, and happens most often to `/api/reach`, whose
            # answer is a slow one the page is quite willing to abandon. The
            # whole ConnectionError family, not two of its four members: on
            # Windows an abandoned response arrives as ConnectionAbortedError
            # (WinError 10053), which the narrower catch let through as a
            # stack trace across the console.
            pass

    def _json(self, data, status: int = 200) -> None:
        self._send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def _same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True  # Same-origin fetches and plain navigations send none.
        return origin.rstrip("/") in (f"http://127.0.0.1:{self.server.server_port}",
                                      f"http://localhost:{self.server.server_port}")

    def _file(self, name: str) -> None:
        path = (WEB_ROOT / name).resolve()
        if WEB_ROOT.resolve() not in path.parents or not path.is_file():
            self._send(404, b"not found", "text/plain")
            return
        kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if kind.startswith("text/") or kind.endswith(("javascript", "json")):
            kind += "; charset=utf-8"
        self._send(200, path.read_bytes(), kind)

    # -- routes -----------------------------------------------------------

    def do_GET(self):
        parts = urlparse(self.path)
        route = parts.path
        if route in ("/", "/index.html"):
            self._file("index.html")
        elif route.startswith("/static/"):
            self._file(route[len("/static/"):])
        elif route == "/api/feed":
            asked = (parse_qs(parts.query).get("channel") or [""])[0]
            self._json(self._index(self.feed_for(asked), _scope(parts.query)))

        elif route == "/api/fetch":
            asked = (parse_qs(parts.query).get("channel") or [""])[0]
            self._json(self._fetch_state(self.feed_for(asked)))

        elif route == "/api/grabs":
            self._json(self.grabber.status())

        elif route == "/api/channels":
            self._json({"channels": self._channels()})
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        if not self._same_origin():
            self._json({"error": "cross-origin request refused"}, 403)
            return

        parts = urlparse(self.path)
        route = parts.path
        body = self._body()
        # The page passes its scope and its channel back on every call, so an
        # action never lands on a different channel than the one on screen.
        scope = _scope(parts.query)
        asked = (parse_qs(parts.query).get("channel") or [""])[0]
        feed = self.feed_for(asked)

        if route == "/api/sync":
            try:
                result = feed.sync()
            except Exception as exc:
                self._json({"error": str(exc)}, 502)
                return
            payload = self._index(feed, scope)
            payload["synced"] = result
            self._json(payload)

        elif route == "/api/reach":
            direction = "older" if body.get("dir") == "older" else "newer"
            try:
                count = int(body.get("count") or 0)
            except (TypeError, ValueError):
                count = 0
            try:
                grew = feed.reach(direction, count)
            except Exception as exc:
                self._json({"error": str(exc)}, 502)
                return
            payload = feed.payload(**scope)
            fresh = feed.since(
                oldest=str(body.get("oldest") or "") if direction == "older" else "",
                newest=str(body.get("newest") or "") if direction == "newer" else "")
            self._json({
                "dir": direction,
                "done": grew.get("done", 0),
                "added": grew.get("added", 0),
                "posts": fresh,
                "held": self._held(fresh, feed),
                "coverage": payload["coverage"],
                "categories": payload["categories"],
                "display": payload["display"],
            })

        elif route == "/api/bookmark":
            feed.state.bookmark(body.get("id"), bool(body.get("on", True)))
            self._json({"bookmarks": feed.bookmarks()})

        elif route == "/api/detail":
            ids = [str(i) for i in body.get("ids") or []]
            try:
                self._json({"posts": feed.detail(ids)})
            except Exception as exc:
                self._json({"error": str(exc)}, 502)

        elif route == "/api/names":
            # Who the bot's mentions belong to. One gateway round trip, asked
            # for by the page once it knows which ids it is missing.
            try:
                added = feed.learn_names(self.grabber.gateway)
            except Exception as exc:
                self._json({"error": str(exc)}, 502)
                return
            self._json({"added": added, "posts": feed.payload(**scope)["posts"]
                        if added else []})

        # -- pressing the button ------------------------------------------

        elif route == "/api/peek":
            # Press, and say what came back, without fetching anything. The
            # claim stays live, so pressing Get afterwards costs no second press.
            try:
                claim = self.grabber.press(feed, str(body.get("id") or ""))
            except Exception as exc:
                self._json({"error": str(exc)}, 502)
                return
            self._json({"claim": claim.to_json()})

        elif route == "/api/grab":
            try:
                task = self.grabber.grab(feed, str(body.get("id") or ""),
                                         force=bool(body.get("force")))
            except Exception as exc:
                self._json({"error": str(exc)}, 502)
                return
            self._json({"task": task.to_json(), "grabs": self.grabber.status()})

        elif route == "/api/grab/cancel":
            self.grabber.downloads.cancel(str(body.get("job") or ""))
            self._json(self.grabber.status())

        elif route == "/api/grab/retry":
            self.grabber.downloads.requeue(str(body.get("job") or ""))
            self._json(self.grabber.status())

        elif route == "/api/grabs/clear":
            self.grabber.downloads.forget_finished()
            self._json(self.grabber.status())

        elif route == "/api/reveal":
            entry = self.grabber.ledger.get(str(body.get("job") or ""))
            where = (entry or {}).get("dir") or str(self.feed.config.download_path)
            try:
                _reveal(where)
            except Exception as exc:
                self._json({"error": str(exc)}, 502)
                return
            self._json({"opened": where})

        # -- the crawl ----------------------------------------------------

        elif route == "/api/fetch":
            spec = str(body.get("spec") or "").strip()
            direction = "newer" if body.get("dir") == "newer" else "older"
            if not spec:
                self._json({"error": "say how much to read: a count, 7d/3m/1y, or all"}, 400)
                return
            try:
                parse_history(spec)          # complain about the ask itself first
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
                return
            if feed.client is None:
                self._json({"error": "offline: this run cannot reach Discord"}, 400)
                return
            job, already = self._start_job(feed, spec, direction)
            state = self._fetch_state(feed)
            state["already"] = already
            self._json(state)

        elif route == "/api/fetch/stop":
            job = self._job(feed)
            if job is not None:
                job.stop()
            self._json(self._fetch_state(feed))

        else:
            self._send(404, b"not found", "text/plain")


def _reveal(where: str) -> None:
    """Open a folder in whatever the desktop uses for folders."""
    path = Path(where)
    if not path.exists():
        raise FileNotFoundError(f"{where} is not there any more")
    if sys.platform.startswith("win"):
        os.startfile(str(path))            # noqa: S606 -- a folder, not a command
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


class Server(ThreadingHTTPServer):
    """The same server, quieter about the client hanging up.

    Headers are written before the body and flushed after it, so a tab that goes
    away mid-response can raise anywhere in the handler rather than only where
    the body is written. Catching it once here keeps a page reload from printing
    a stack trace that reads like a fault in the server.
    """

    daemon_threads = True

    # socketserver sets SO_REUSEADDR, which on Windows does not mean what it
    # means elsewhere: a second process may bind a port another is already
    # listening on, both succeed, and which one answers is anyone's guess. A
    # second run then quietly serves an *older* copy of this code on the same
    # URL -- which is a long, bewildering afternoon if the copy predates a fix
    # you are trying to test. Refusing the bind sends `serve` to the next port,
    # which is the behaviour the retry loop was written for.
    allow_reuse_address = False

    def handle_error(self, request, client_address):
        problem = sys.exc_info()[1]
        if isinstance(problem, (ConnectionError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def serve(channels, grabber, port: int, attempts: int = 20):
    """Start the server. Returns (server, port) running on its own thread.

    A port can be taken, and on Windows it can also be *reserved* -- Hyper-V and
    friends claim ranges of a hundred ports at a time, and binding inside one
    fails with a permission error rather than an address-in-use. Either way the
    answer is the next port up, not a stack trace.
    """
    Handler.channels = channels
    Handler.grabber = grabber
    for offset in range(attempts):
        try:
            httpd = Server(("127.0.0.1", port + offset), Handler)
        except (OSError, PermissionError):
            continue
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        return httpd, port + offset
    raise OSError(f"no free port in {port}..{port + attempts - 1}")
