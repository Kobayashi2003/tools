"""Files a host answered 404 for.

A 404 is final for automatic runs: such a file is asked for again only when you download
its post by hand, and the entry is dropped the moment the file arrives. Keyed by content
path, so a file shared between two posts is one entry. (`next` is no longer read; the
column stays for databases that have it.)
"""

from ..domain.timefmt import now_utc
from .db import Database


class Deferrals:
    def __init__(self, db: Database):
        self.db = db

    def missing(self, source: str, key: str) -> bool:
        return bool(key) and bool(
            self.db.one("SELECT 1 FROM deferrals WHERE source=? AND key=?", (source, key))
        )

    def miss(self, source: str, key: str, name: str = "") -> int:
        """Record a 404; returns how many there have been."""
        now = now_utc()
        with self.db.tx() as conn:
            conn.execute(
                """INSERT INTO deferrals(source, key, name, misses, first_seen, last_seen, next)
                   VALUES(?, ?, ?, 1, ?, ?, ?)
                   ON CONFLICT(source, key) DO UPDATE SET
                     misses=deferrals.misses + 1, last_seen=excluded.last_seen,
                     name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE deferrals.name END""",
                (source, key, name, now, now, now),
            )
            row = conn.execute(
                "SELECT misses FROM deferrals WHERE source=? AND key=?", (source, key)
            ).fetchone()
        return int(row["misses"])

    def clear(self, source: str, key: str) -> bool:
        """Forget a file that arrived. True if it had 404ed before."""
        return self.db.run("DELETE FROM deferrals WHERE source=? AND key=?", (source, key)) > 0
