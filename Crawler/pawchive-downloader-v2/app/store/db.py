"""SQLite persistence. Each operation opens its own connection; WAL lets readers and the
download threads' writers overlap, and `busy_timeout` serialises writers instead of failing.

Observations (`post_obs`) are what one source said about a post, and are only ever
written by that source's sync. Conclusions (`posts`, `files`) are derived from them
by `engine/reconcile.py`, so one source's view never overwrites the other's.
"""

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 2

SCHEMA = """
CREATE TABLE creators(
    id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    alias TEXT NOT NULL DEFAULT '',
    group_path TEXT NOT NULL DEFAULT '',
    icon_url TEXT,
    fanbox_creator_id TEXT,
    -- unknown | ok | none (no Fanbox page) | error
    fanbox_state TEXT NOT NULL DEFAULT 'unknown',
    fanbox_checked_at TEXT,
    fanbox_error TEXT,
    -- unknown | ok | gone | error
    pawchive_state TEXT NOT NULL DEFAULT 'unknown',
    pawchive_checked_at TEXT,
    pawchive_error TEXT,
    ignore INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    config TEXT NOT NULL DEFAULT '{}',
    filter TEXT NOT NULL DEFAULT '{}',
    timer TEXT,
    last_date TEXT,
    added_at TEXT NOT NULL,
    synced_at TEXT
);
CREATE TABLE subscriptions(
    creator_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    fee INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    checked_at TEXT NOT NULL,
    PRIMARY KEY(creator_id, plan_id)
);
CREATE TABLE post_obs(
    creator_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    source TEXT NOT NULL,
    -- pawchive: full | meta | gone ; fanbox: open | locked | gone
    state TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    published TEXT NOT NULL DEFAULT '',
    edited TEXT NOT NULL DEFAULT '',
    fee INTEGER,
    content TEXT,
    -- The source's file list as JSON, in its own order (see domain/match.py).
    entries TEXT,
    -- Fanbox: when post.info was last read; NULL means only the list is known.
    detail_at TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    gone_since TEXT,
    PRIMARY KEY(creator_id, post_id, source)
);
CREATE TABLE posts(
    creator_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    published TEXT NOT NULL DEFAULT '',
    edited TEXT NOT NULL DEFAULT '',
    fee INTEGER NOT NULL DEFAULT 0,
    content TEXT,
    p_state TEXT NOT NULL DEFAULT 'none',
    f_state TEXT NOT NULL DEFAULT 'unknown',
    local_dir TEXT,
    local_done INTEGER NOT NULL DEFAULT 0,
    done_at TEXT,
    -- NULL, or 'adopted' when the folder came from another tool (see library/migrate.py)
    origin TEXT,
    stale TEXT,
    time_mismatch INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    PRIMARY KEY(creator_id, post_id)
);
CREATE INDEX posts_published ON posts(creator_id, published);
CREATE TABLE files(
    id INTEGER PRIMARY KEY,
    creator_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    key TEXT NOT NULL,
    role TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,
    p_path TEXT,
    f_url TEXT,
    size INTEGER,
    width INTEGER,
    height INTEGER,
    sha256 TEXT,
    present_p INTEGER NOT NULL DEFAULT 0,
    present_f INTEGER NOT NULL DEFAULT 0,
    local_name TEXT,
    -- pending | done | failed
    state TEXT NOT NULL DEFAULT 'pending',
    -- pawchive | fanbox | adopted | local
    via TEXT,
    local_size INTEGER,
    -- NULL unknown, 1 matches the sources' size / dimensions / hash, 0 does not
    verified INTEGER,
    done_at TEXT,
    error TEXT,
    UNIQUE(creator_id, post_id, key)
);
CREATE INDEX files_post ON files(creator_id, post_id);
CREATE TABLE deferrals(
    source TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    misses INTEGER NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    next TEXT NOT NULL,
    PRIMARY KEY(source, key)
);
CREATE TABLE jobs(
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    creator_id TEXT,
    params TEXT NOT NULL DEFAULT '{}',
    -- queued | running | done | failed | cancelled
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    note TEXT,
    error TEXT
);
CREATE TABLE events(
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    level TEXT NOT NULL,
    creator_id TEXT,
    message TEXT NOT NULL
);
CREATE TABLE migrations(
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    creator_id TEXT,
    params TEXT NOT NULL,
    created_at TEXT NOT NULL,
    summary TEXT NOT NULL,
    items TEXT NOT NULL,
    executed_at TEXT,
    result TEXT
);
CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT);
"""


# Columns added after a database was first created; added on open so it keeps working.
ADDED_COLUMNS = {
    "posts": {"origin": "TEXT"},
    # Fanbox lists a cover thumbnail for every post, paid or not.
    "post_obs": {"cover_url": "TEXT"},
    # When a complete Fanbox listing was last read (an empty one when the creator has no
    # Fanbox page). Only then is a post missing from Fanbox deleted there rather than
    # unchecked. `fanbox_checked_at` is the last attempt, successful or not.
    "creators": {"fanbox_listed_at": "TEXT"},
}

# Run once, right after the column is added, to fill it for an existing database.
BACKFILL = {
    "fanbox_listed_at": """UPDATE creators SET fanbox_listed_at=fanbox_checked_at
        WHERE fanbox_state='none' OR (fanbox_state='ok' AND EXISTS(
            SELECT 1 FROM post_obs o WHERE o.creator_id=creators.id AND o.source='fanbox'))""",
}


def dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def load(text: str | None, default: Any = None) -> Any:
    if not text:
        return default
    return json.loads(text)


class Database:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version == 0:
                db.executescript(SCHEMA)
                db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            elif version > SCHEMA_VERSION:
                raise RuntimeError(
                    f"{path} was written by a newer version (schema {version}); update this copy."
                )
            for table, columns in ADDED_COLUMNS.items():
                have = {r["name"] for r in db.execute(f"PRAGMA table_info({table})")}
                for name, decl in columns.items():
                    if name not in have:
                        db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
                        if name in BACKFILL:
                            db.execute(BACKFILL[name])
            if 0 < version < 2:
                # v1 fetched only from Pawchive, so what it got is shown as such.
                db.execute("UPDATE files SET via='pawchive' WHERE via='v1'")
                db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        """One write transaction, taken eagerly so two writers never deadlock on upgrade."""
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise

    def all(self, sql: str, params: Any = ()) -> list[sqlite3.Row]:
        with self.connect() as conn:
            return conn.execute(sql, params).fetchall()

    def one(self, sql: str, params: Any = ()) -> sqlite3.Row | None:
        with self.connect() as conn:
            return conn.execute(sql, params).fetchone()

    def run(self, sql: str, params: Any = ()) -> int:
        with self.tx() as conn:
            return conn.execute(sql, params).rowcount

    def kv_get(self, key: str, default: Any = None) -> Any:
        row = self.one("SELECT value FROM kv WHERE key=?", (key,))
        return load(row["value"], default) if row else default

    def kv_set(self, key: str, value: Any):
        self.run(
            "INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, dump(value)),
        )
