"""A local page over the feed.

Bound to 127.0.0.1 and unauthenticated. Any site you have open can also reach
127.0.0.1, so requests carrying a foreign `Origin` are refused -- otherwise a
stray tab could move your check mark.
"""

import copy
import gzip
import json
import mimetypes
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .config import parse_history
from .feed import Feed
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
    server_version = "book-sharing/1.0"
    feed = None            # the channel named on the command line
    others = {}            # other channels, built the first time one is asked for
    channel_list = None    # the guild's channels, fetched once
    jobs = {}              # channel id -> the crawl running behind its page
    names = None           # channel id -> name, as far as anything knows
    asked_names = set()    # ids Discord has already been asked about, once

    # This guards the maps above and nothing else. Each Feed serialises its own
    # work, so a crawl of one channel no longer holds the whole server still --
    # which it would, back when every route ran inside this lock.
    lock = threading.RLock()

    # -- channels ---------------------------------------------------------

    def feed_for(self, channel_id):
        """The Feed for a channel, made on demand.

        Cache, bookmarks and ticks are already per channel, so switching is
        only a matter of picking the right Feed: nothing is shared between
        them and nothing has to be cleared.
        """
        cid = str(channel_id or "").strip() or self.feed.config.channel_id
        if cid == self.feed.config.channel_id:
            return self.feed
        with self.lock:
            if cid not in self.others:
                config = copy.copy(self.feed.config)
                config.channel_id = cid
                config.channel_name = self._name_of(cid) or cid
                self.others[cid] = Feed(config)
            return self.others[cid]

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
        """Ask Discord what a channel is called, once per run.

        The guild listing only covers the guild being read, and an archive on
        disk may well come from a server you have since left -- which is how a
        perfectly good cached channel ends up shown as a snowflake. `probe`
        reports rather than raises, so a channel that can no longer be read
        costs one request and stays a snowflake.
        """
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
        # Offline the guild will not say, but a channel already open knows its
        # own name, so at least those read as names rather than as ids.
        if cid == self.feed.config.channel_id and self.feed.config.channel_name:
            return self.feed.config.channel_name
        other = self.others.get(cid)
        if other is not None and other.config.channel_name:
            return other.config.channel_name
        # Whatever a previous run was told. Kept in the state file, so a name
        # learned once survives every offline run after it.
        return self._known_names().get(cid, "")

    def _cached_ids(self):
        found = set()
        for path in Path(self.feed.config.cache_dir).glob("messages_*.json"):
            found.add(path.stem.split("_", 1)[1])
        return found

    def _channels(self):
        """What the switcher offers.

        Channels already cached come first, then anything named *sharing*, then
        the rest -- a hundred channels in one list is otherwise unusable.
        """
        with self.lock:
            if Handler.channel_list is None and self.feed.client is not None:
                try:
                    Handler.channel_list = self.feed.client.guild_channels()
                except Exception:
                    Handler.channel_list = []

        cached = self._cached_ids()
        # The listing is the authority on names, so anything on disk that it
        # covers is written down while we have it.
        for entry in Handler.channel_list or []:
            if entry["id"] in cached:
                self._remember_name(entry["id"], entry.get("name", ""))
        # An archive from another guild is in none of that: ask about it
        # directly, once, and it is a name from then on.
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
                    0 if "sharing" in entry["name"] else 1,
                    entry.get("position", 0), entry["name"])

        return [dict(entry, cached=entry["id"] in cached) for entry in sorted(listed, key=rank)]

    def _index(self, feed, scope: dict) -> dict:
        """The index, plus the switcher's channel list. Both routes that hand
        the page a whole archive answer with exactly this."""
        payload = feed.payload(**scope)
        payload["channels"] = self._channels()
        return payload

    # -- the crawl --------------------------------------------------------

    def _job(self, feed):
        with self.lock:
            return Handler.jobs.get(feed.config.channel_id)

    def _start_job(self, feed, spec: str, direction: str):
        """Begin a crawl of this channel, unless one is already under way.

        One job per channel: two walkers on the same archive would fetch the
        same pages twice and race each other to the same edge.
        """
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
        # The index is megabytes of repetitive JSON and compresses ~4x. Cheap
        # here, and it is the difference between a snappy load and a visible one.
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
        except (BrokenPipeError, ConnectionResetError):
            pass  # The tab was closed or reloaded mid-response.

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

        # The Feed serialises its own work, so the dispatch below runs
        # without the server-wide lock: a crawl on one channel must not
        # hold still the page reading another.
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
            self._json({
                "dir": direction,
                "done": grew.get("done", 0),
                "added": grew.get("added", 0),
                "posts": feed.since(
                    oldest=str(body.get("oldest") or "") if direction == "older" else "",
                    newest=str(body.get("newest") or "") if direction == "newer" else ""),
                "coverage": payload["coverage"],
                "categories": payload["categories"],
                "display": payload["display"],
            })

        elif route == "/api/bookmark":
            feed.state.bookmark(body.get("id"), bool(body.get("on", True)))
            self._json({"bookmarks": feed.bookmarks()})

        elif route == "/api/taken":
            feed.state.take(body.get("ids") or [], bool(body.get("on", True)))
            self._json({"taken": sorted(feed.state.taken)})

        elif route == "/api/detail":
            ids = [str(i) for i in body.get("ids") or []]
            try:
                self._json({"posts": feed.detail(ids)})
            except Exception as exc:
                self._json({"error": str(exc)}, 502)

        elif route == "/api/fetch":
            # Reaching back, asked for from the page rather than from the
            # command line: you find out you want 2021 while reading 2023.
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


def serve(feed, port: int, attempts: int = 20):
    """Start the server. Returns (server, port) running on its own thread.

    A port can be taken, and on Windows it can also be *reserved* -- Hyper-V and
    friends claim ranges of a hundred ports at a time, and binding inside one
    fails with a permission error rather than an address-in-use. Either way the
    answer is the next port up, not a stack trace.
    """
    Handler.feed = feed
    for offset in range(attempts):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port + offset), Handler)
        except (OSError, PermissionError):
            continue
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        return httpd, port + offset
    raise OSError(f"no free port in {port}..{port + attempts - 1}")
