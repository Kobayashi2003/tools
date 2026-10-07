"""Settings, split by what they belong to.

`.env` holds what varies per machine and must not be committed -- the token, a
proxy, where files land. `config.json` holds behaviour. Precedence is
CLI > env > config.json > the defaults here.
"""

import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Tuple
from urllib.request import getproxies

PREFIX = "TMW_"
API_BASE = "https://discord.com/api/v9"
GATEWAY = "wss://gateway.discord.gg/?v=9&encoding=json"
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# Config fields an env var may override, as `TMW_<NAME>`.
OVERRIDABLE = ("cache_dir", "state_file", "download_dir", "port", "channel_id",
               "guild_id", "channel_name")

# `m` is 30 days and `y` is 365: this picks a cursor, not an accounting period.
UNIT_DAYS = {"d": 1, "w": 7, "m": 30, "y": 365}
HISTORY_RE = re.compile(r"(\d+)\s*([dwmy]?)")


def parse_history(spec: str) -> Optional[Tuple[Optional[datetime], Optional[int]]]:
    """Read a reach like `7d`, `3m`, `all`, or a plain message count.

    Returns `None` for "do not reach back at all", otherwise `(floor, count)`
    where either may be `None`: `all` is `(None, None)`, `3m` is a date floor,
    `500` is a count.
    """
    text = (spec or "").strip().lower()
    if not text:
        return None
    if text in ("all", "full", "everything"):
        return (None, None)
    match = HISTORY_RE.fullmatch(text)
    if not match:
        raise ValueError(f"unreadable history {spec!r}: "
                         f"use 7d / 2w / 3m / 1y / all, or a plain message count")
    amount, unit = int(match.group(1)), match.group(2)
    if not unit:
        return (None, amount)
    return (datetime.now(timezone.utc) - timedelta(days=amount * UNIT_DAYS[unit]), None)


def load_dotenv(path: str = ".env") -> None:
    """Load KEY=VALUE lines into the environment; real env vars win."""
    p = Path(path)
    if not p.exists():
        return
    for raw in p.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key:
            os.environ.setdefault(key, value.strip().strip('"').strip("'"))


def env(name: str, default: str = "") -> str:
    return os.environ.get(PREFIX + name.upper(), default)


@dataclass
class Config:
    # The reading club's four recommendation channels live in one server; the
    # page's switcher offers all of them and #book-recommendations is where it
    # opens. Sharing itself moved here on 2026-09-05: the old channel posted
    # files, this one posts a job id and a button.
    guild_id: str = "1545162007354024040"
    channel_id: str = "1545185146745921626"
    channel_name: str = "book-recommendations"

    # how much to fetch.  `history` is the reach (a date floor, or `all`);
    # `fetch_limit` is a budget of messages for one run. They compose: reaching
    # back to the beginning 5000 messages at a time is several calm runs rather
    # than one long one, and the walk resumes where it stopped.
    history: str = ""            # 7d / 2w / 3m / 1y / all / a plain count
    fetch_limit: int = 0         # 0 = no budget

    # How much life a signed cover link must have left to be handed out as-is.
    link_margin_minutes: int = 120

    # how much to show
    tail: bool = False           # only what arrives after this launch
    display_cap: int = 0         # 0 = send the lot; the page virtualises it

    # http.  `page_size` is capped at 100 by Discord, and asking for less is
    # worse rather than safer: the same history then costs proportionally more
    # requests. Slow the cadence with `page_pause` instead.
    timeout: int = 30
    # How long a transfer may go quiet before it is treated as broken. Separate
    # from `timeout`, which is a connect limit: the reader is one small machine
    # and a big file can pause for a while without the connection being dead.
    read_timeout: int = 120
    retry: int = 4
    page_size: int = 100
    page_pause: float = 1.0
    proxy: str = ""

    # Pressing a recommendation's button is a real interaction with the bot, so
    # it is paced like one: never two within `press_pause` seconds, and never
    # more than `press_wait` spent waiting for the bot's reply.
    press_pause: float = 2.0
    press_wait: float = 25.0

    # local
    token: str = ""
    port: int = 18040
    cache_dir: str = "cache"
    state_file: str = "state.json"
    download_dir: str = "downloads"

    # not from disk
    open_browser: bool = True
    offline: bool = False

    # The channel `channel_name` actually belongs to, so a --channel_id pointing
    # somewhere else does not get labelled with it.
    _named_channel: str = ""

    _sources: list = field(default_factory=list)

    @classmethod
    def load(cls, path: str = "config.json") -> "Config":
        load_dotenv()
        config = cls()

        file = Path(path or "config.json")
        if file.exists():
            data = json.loads(file.read_text(encoding="utf-8"))
            known = {f for f in cls.__dataclass_fields__ if not f.startswith("_")}
            for key, value in data.items():
                if key in known:
                    setattr(config, key, value)
            config._sources.append(str(file))

        for name in OVERRIDABLE:
            value = env(name)
            if value:
                current = getattr(config, name)
                setattr(config, name, type(current)(value) if isinstance(current, int) else value)

        # The token is env-only on purpose: config.json is the file people paste
        # into a chat window when something breaks.
        config.token = env("token").strip()
        config.proxy = env("proxy", config.proxy)
        config._named_channel = config.channel_id
        return config

    def apply_args(self, args) -> "Config":
        for name in ("channel_id", "guild_id", "port", "proxy", "history"):
            value = getattr(args, name, None)
            if value:
                setattr(self, name, value)
        # `channel_name` describes the configured channel and nothing else.
        if self.channel_id != self._named_channel:
            self.channel_name = ""
        cap = getattr(args, "cap", None)
        if cap is not None:
            self.display_cap = max(0, cap)
        count = getattr(args, "count", None)
        if count is not None:
            self.fetch_limit = max(0, count)
        if getattr(args, "tail", False):
            self.tail = True
        if getattr(args, "no_open", False):
            self.open_browser = False
        if getattr(args, "offline", False):
            self.offline = True
        where = getattr(args, "out", None)
        if where:
            self.download_dir = where
        # Reaching back is a multi-page walk; reaching back to the beginning is
        # hundreds of them. Verify the spec before a single request goes out.
        parse_history(self.history)
        return self

    @property
    def has_reach(self) -> bool:
        """Whether this run was told how far back to read at all."""
        return bool(self.history) or self.fetch_limit > 0

    @property
    def cache_path(self) -> Path:
        return Path(self.cache_dir) / f"messages_{self.channel_id}.json"

    @property
    def links_path(self) -> Path:
        return Path(self.cache_dir) / f"links_{self.channel_id}.json"

    @property
    def names_path(self) -> Path:
        """Display names for the ids the bot mentions, learned once and kept."""
        return Path(self.cache_dir) / f"names_{self.guild_id}.json"

    @property
    def state_path(self) -> Path:
        return Path(self.state_file)

    @property
    def download_path(self) -> Path:
        return Path(self.download_dir)

    @property
    def ledger_path(self) -> Path:
        return self.download_path / "ledger.json"

    def channel_url(self, message_id: str = "") -> str:
        base = f"https://discord.com/channels/{self.guild_id}/{self.channel_id}"
        return f"{base}/{message_id}" if message_id else base

    @property
    def proxies(self) -> dict:
        return {"http": self.proxy, "https": self.proxy} if self.proxy else {}

    @property
    def proxy_url(self) -> str:
        """The proxy everything should go through, explicit or inherited.

        `requests` reads `HTTPS_PROXY` -- and on Windows the system setting --
        entirely by itself, so the REST calls and the downloads tunnel without
        being told to. `websocket-client` reads none of it and connects direct
        unless handed a host and a port. Left as two different answers, that
        split is invisible until the exact moment it matters: behind a proxy
        that is the only route to Discord, the archive loads perfectly and the
        download button times out, because the one connection that was never
        told about the tunnel is the one the button needs.

        So both sides ask this. `TMW_PROXY` still wins where it is set.
        """
        if self.proxy:
            return self.proxy
        found = getproxies()
        return found.get("https") or found.get("http") or ""

    @property
    def no_proxy(self) -> str:
        """Hosts to reach directly, in the form the websocket client wants."""
        return os.environ.get("no_proxy") or os.environ.get("NO_PROXY") or ""
