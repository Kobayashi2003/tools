"""Everything a job needs, built once from settings: database, clients, ledgers, log."""

import sqlite3
import sys
import threading
from pathlib import Path

from ..config import Settings, SettingsStore, creator_value
from ..domain.naming import creator_folder
from ..domain.timefmt import now_utc
from ..net.limiter import Throttle
from ..net.policy import StatusPolicies
from ..sources.fanbox import Fanbox
from ..sources.http import HttpClient, RetryShape
from ..sources.pawchive import Pawchive
from ..store.db import Database, load
from ..store.deferrals import Deferrals
from .reconcile import Naming

EVENTS_KEPT = 20_000


class Events:
    """The activity log the UI shows, kept in the database and echoed to the console."""

    def __init__(self, db: Database):
        self.db = db
        self._count = 0

    def log(self, level: str, message: str, creator_id: str | None = None):
        self.db.run(
            "INSERT INTO events(at, level, creator_id, message) VALUES(?, ?, ?, ?)",
            (now_utc(), level, creator_id, message),
        )
        try:
            print(f"[{level}] {message}", file=sys.stderr if level == "error" else sys.stdout)
        except Exception:
            pass
        self._count += 1
        if self._count % 500 == 0:
            self.db.run(
                "DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?", (EVENTS_KEPT,)
            )


class Context:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        data_dir.mkdir(parents=True, exist_ok=True)
        self.store = SettingsStore(data_dir)
        self.settings: Settings = self.store.load()
        self.db = Database(data_dir / "pawchive.sqlite3")
        self.events = Events(self.db)
        self.lock = threading.RLock()
        self.build()

    def build(self):
        s = self.settings
        log = self.events.log
        shape = RetryShape(
            s.retry_delay, s.retry_backoff, s.retry_delay_cap, s.retry_jitter, s.max_retries
        )
        not_found = {"404": {"action": "permanent", "attempts": s.not_found_max_retries}}
        self.pawchive_http = HttpClient(
            "Pawchive",
            {
                "User-Agent": s.user_agent,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.5",
            },
            Throttle(
                max_concurrent=s.max_concurrent_downloads,
                rate=s.max_download_rate,
                burst=s.download_burst,
                quota=s.daily_download_quota,
                # Under data/: a spent budget must survive a restart.
                state_path=self.data_dir / "quota.json",
                window_hours=s.quota_window_hours,
                requests_per_second=s.max_file_requests_per_second,
                request_burst=s.file_request_burst,
            ),
            StatusPolicies.parse(s.status_policies, fallback=not_found),
            shape,
            s.request_timeout,
            log,
        )
        self.fanbox_http = HttpClient(
            "Fanbox",
            {
                "User-Agent": s.fanbox_user_agent,
                "Accept": "application/json, text/plain, */*",
                "Origin": "https://www.fanbox.cc",
                "Referer": "https://www.fanbox.cc/",
            },
            Throttle(
                max_concurrent=s.fanbox_max_concurrent_downloads,
                requests_per_second=s.fanbox_requests_per_second,
                request_burst=1,
            ),
            # Fanbox (or Cloudflare in front of it) answers 403 when it wants a pause; asking
            # forever under your own account is the wrong response, so give up after a few.
            StatusPolicies.parse(
                s.fanbox_status_policies,
                fallback={
                    **not_found,
                    "403": {"action": "fail", "attempts": 3, "delay": 20, "backoff": 2},
                },
            ),
            shape,
            s.request_timeout,
            log,
            api_requests_per_second=s.fanbox_requests_per_second,
            # Fanbox hands an anonymous client a session cookie on its first reply and then
            # answers 403 to every request that sends it back. Your own cookie, when set,
            # goes in the header instead.
            keep_cookies=False,
            impersonate="chrome",
        )
        self.pawchive = Pawchive(self.pawchive_http, s.api_base, s.file_base, s.page_workers)
        self.fanbox = Fanbox(self.fanbox_http, s.fanbox_api, self.store.fanbox_sessid())
        self.deferrals = Deferrals(
            self.db, s.not_found_retry_days, s.not_found_retry_backoff, s.not_found_retry_cap_days
        )

    def reload_settings(self):
        with self.lock:
            self.settings = self.store.load()
            self.build()

    # ---- per-creator helpers ----

    def creator(self, creator_id: str) -> sqlite3.Row | None:
        return self.db.one("SELECT * FROM creators WHERE id=?", (creator_id,))

    def value(self, creator: sqlite3.Row, key: str):
        return creator_value(self.settings, load(creator["config"], {}) or {}, key)

    def naming(self, creator: sqlite3.Row) -> Naming:
        return Naming(
            self.value(creator, "file_template"),
            bool(self.value(creator, "rename_images_only")),
            self.settings.is_image,
        )

    def creator_dir(
        self, creator: sqlite3.Row, group: str | None = None, alias: str | None = None
    ) -> Path:
        """`group` and `alias` give the folder the creator would have after a move."""
        return Path(self.settings.download_dir) / creator_folder(
            self.value(creator, "artist_folder_template"),
            service=creator["service"],
            name=creator["name"],
            alias=creator["alias"] if alias is None else alias,
            user_id=creator["user_id"],
            group=creator["group_path"] if group is None else group,
        )

    def preference(self, creator: sqlite3.Row) -> str:
        return self.value(creator, "source_preference")

    # ---- Fanbox session ----

    def session(self) -> dict:
        state = self.db.kv_get("fanbox_session", {}) or {}
        if not self.store.fanbox_sessid():
            return {"state": "none"}
        return {"state": "unchecked", **state}

    def set_session_state(self, **values):
        self.db.kv_set(
            "fanbox_session",
            {**(self.db.kv_get("fanbox_session", {}) or {}), **values, "checked_at": now_utc()},
        )

    def fanbox_usable(self) -> bool:
        """Fanbox is used anonymously without a cookie, and not at all once the cookie
        was rejected: a rejected cookie would read every paid post as unsubscribed."""
        return self.session().get("state") != "rejected"
