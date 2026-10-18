"""Files a host does not have *yet*, and when it is worth asking again.

Pawchive materialises files onto its CDN lazily; v1's logs show URLs that 404ed on
six or seven separate days serving real bytes weeks later. So a 404 is never final:
each miss pushes the next attempt out (1, 2, 4… days, capped), and the entry is
dropped the moment the file arrives. Keyed by content path, so a file shared
between two posts is one entry.
"""

from datetime import datetime, timedelta

from ..domain.timefmt import now_utc
from .db import Database


class Deferrals:
    def __init__(self, db: Database, first_days: float, backoff: float, cap_days: float):
        self.db = db
        self.first = max(0.0, float(first_days or 0))
        self.backoff = max(1.0, float(backoff or 1.0))
        self.cap = max(self.first, float(cap_days or 0))

    @property
    def enabled(self) -> bool:
        return self.first > 0

    def wait_days(self, misses: int) -> float:
        return min(self.first * (self.backoff ** max(0, misses - 1)), self.cap)

    def due(self, source: str, key: str) -> bool:
        """An unknown file is always due: the ledger only delays, it never gates a first try."""
        if not self.enabled or not key:
            return True
        row = self.db.one("SELECT next FROM deferrals WHERE source=? AND key=?", (source, key))
        return row is None or row["next"] <= now_utc()

    def miss(self, source: str, key: str, name: str = "") -> dict:
        now = now_utc()
        with self.db.tx() as conn:
            row = conn.execute(
                "SELECT misses, first_seen FROM deferrals WHERE source=? AND key=?", (source, key)
            ).fetchone()
            misses = (row["misses"] if row else 0) + 1
            wait = self.wait_days(misses)
            nxt = (datetime.fromisoformat(now) + timedelta(days=wait)).isoformat()
            conn.execute(
                """INSERT INTO deferrals(source, key, name, misses, first_seen, last_seen, next)
                   VALUES(?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(source, key) DO UPDATE SET
                     misses=excluded.misses, last_seen=excluded.last_seen, next=excluded.next,
                     name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE deferrals.name END""",
                (source, key, name, misses, row["first_seen"] if row else now, now, nxt),
            )
        return {"misses": misses, "wait_days": round(wait, 3), "next": nxt}

    def clear(self, source: str, key: str) -> bool:
        """Forget a file that arrived. True if it had been deferred: proof of lateness."""
        return self.db.run("DELETE FROM deferrals WHERE source=? AND key=?", (source, key)) > 0
