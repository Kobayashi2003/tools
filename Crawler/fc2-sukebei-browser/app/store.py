"""SQLite storage: torrents found on sukebei, and one `titles` row per FC2 id with its metadata.

Each source has its own state, so a slow or rate-limited source never blocks the other:

    fc2_state  '' (not fetched yet) | ok | removed | error
    pp_state   '' (not fetched yet) | ok | missing | error

`state` is derived from both: failed if either errored, pending while either is unfetched, else
done. `errors` holds the last error per source ({"fc2": "...", "pp": "..."}), and `attempts`
counts error rounds so automatic retries can give up.
"""

import json
import sqlite3
import threading
import time

from .fc2id import parse_id, strip_code

SCHEMA = """
CREATE TABLE IF NOT EXISTS torrents (
    view_id     INTEGER PRIMARY KEY,
    fc2_id      TEXT NOT NULL,
    name        TEXT NOT NULL,
    infohash    TEXT NOT NULL,
    magnet      TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT '',
    size_bytes  INTEGER NOT NULL DEFAULT 0,
    uploaded_at INTEGER NOT NULL DEFAULT 0,
    seeders     INTEGER NOT NULL DEFAULT 0,
    leechers    INTEGER NOT NULL DEFAULT 0,
    downloads   INTEGER NOT NULL DEFAULT 0,
    flag        TEXT NOT NULL DEFAULT '',
    seen_at     INTEGER NOT NULL,
    files       TEXT,
    description TEXT,
    risky       INTEGER,
    detail_at   INTEGER
);
CREATE INDEX IF NOT EXISTS torrents_fc2 ON torrents(fc2_id);

CREATE TABLE IF NOT EXISTS titles (
    fc2_id      TEXT PRIMARY KEY,
    state       TEXT NOT NULL DEFAULT 'pending',
    title       TEXT NOT NULL DEFAULT '',
    seller      TEXT NOT NULL DEFAULT '',
    seller_url  TEXT NOT NULL DEFAULT '',
    released    TEXT NOT NULL DEFAULT '',
    duration    TEXT NOT NULL DEFAULT '',
    rating      INTEGER,
    reviews     INTEGER,
    tags        TEXT NOT NULL DEFAULT '[]',
    cover       TEXT NOT NULL DEFAULT '',
    cover_full  TEXT NOT NULL DEFAULT '',
    samples     TEXT NOT NULL DEFAULT '[]',
    grid        TEXT NOT NULL DEFAULT '',
    clips       TEXT NOT NULL DEFAULT '[]',
    fc2_state   TEXT NOT NULL DEFAULT '',
    pp_state    TEXT NOT NULL DEFAULT '',
    errors      TEXT NOT NULL DEFAULT '{}',
    attempts    INTEGER NOT NULL DEFAULT 0,
    added_at    INTEGER NOT NULL,
    fetched_at  INTEGER,
    viewed_at   INTEGER,
    starred     INTEGER NOT NULL DEFAULT 0,
    hidden      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS marks (
    fc2_id     TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

SORTS = {
    "uploaded": "a.uploaded_at DESC",
    "seeders": "a.seeders DESC, a.uploaded_at DESC",
    "released": "t.released DESC, a.uploaded_at DESC",
    "rating": "COALESCE(t.rating, -1) DESC, COALESCE(t.reviews, 0) DESC",
    "size": "a.size_bytes DESC",
    "id": "CAST(t.fc2_id AS INTEGER) DESC",
    "added": "t.added_at DESC, a.uploaded_at DESC",
}
VIEWS = ("all", "unseen", "starred", "hidden")
SOURCES = ("fc2", "pp")
STATE_SQL = ("state = CASE WHEN fc2_state = 'error' OR pp_state = 'error' THEN 'failed' "
             "WHEN fc2_state = '' OR pp_state = '' THEN 'pending' ELSE 'done' END")
JSON_FIELDS = ("tags", "samples", "clips")
TORRENT_FIELDS = ("view_id", "fc2_id", "name", "infohash", "magnet", "category", "size_bytes",
                  "uploaded_at", "seeders", "leechers", "downloads", "flag")


def _now():
    return int(time.time())


class Store:
    def __init__(self, path):
        self.path = path
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.executescript(SCHEMA)
            self._db.commit()

    def close(self):
        with self._lock:
            self._db.close()

    # --- writes -------------------------------------------------------------------------

    def upsert_torrents(self, torrents):
        """Insert or refresh torrents (dicts or objects with to_dict) that carry an fc2_id.

        Torrents already held only get their counters refreshed. Returns
        {"ids": FC2 ids still needing metadata, "new_torrents": int, "new_titles": int}.
        """
        now = _now()
        ids, new_torrents, new_titles = [], 0, 0
        with self._lock:
            for item in torrents:
                row = item.to_dict() if hasattr(item, "to_dict") else dict(item)
                if not row.get("fc2_id"):
                    continue
                known = self._db.execute("SELECT 1 FROM torrents WHERE view_id = ?", (row["view_id"],)).fetchone()
                values = [row[f] for f in TORRENT_FIELDS]
                self._db.execute(
                    f"INSERT INTO torrents ({', '.join(TORRENT_FIELDS)}, seen_at) "
                    f"VALUES ({', '.join('?' * len(TORRENT_FIELDS))}, ?) "
                    "ON CONFLICT(view_id) DO UPDATE SET name=excluded.name, seeders=excluded.seeders, "
                    "leechers=excluded.leechers, downloads=excluded.downloads, flag=excluded.flag, "
                    "magnet=excluded.magnet, seen_at=excluded.seen_at",
                    values + [now])
                new_torrents += not known
                new_titles += self._db.execute("INSERT OR IGNORE INTO titles (fc2_id, added_at) VALUES (?, ?)",
                                               (row["fc2_id"], now)).rowcount
                if row["fc2_id"] not in ids:
                    ids.append(row["fc2_id"])
            self._db.commit()
            pending = set()
            if ids:
                marks = ",".join("?" * len(ids))
                pending = {r[0] for r in self._db.execute(
                    f"SELECT fc2_id FROM titles WHERE state != 'done' AND fc2_id IN ({marks})", ids)}
        return {"ids": [i for i in ids if i in pending], "new_torrents": new_torrents, "new_titles": new_titles}

    # --- crawl progress (key/value) -----------------------------------------------------

    def get_meta(self, key, default=None):
        with self._lock:
            row = self._db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_meta(self, key, value):
        with self._lock:
            self._db.execute("INSERT INTO meta (key, value) VALUES (?, ?) "
                             "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, json.dumps(value)))
            self._db.commit()

    def max_fc2_id(self):
        with self._lock:
            row = self._db.execute("SELECT MAX(CAST(fc2_id AS INTEGER)) FROM titles").fetchone()
        return row[0]

    def ensure_title(self, fc2_id):
        with self._lock:
            self._db.execute("INSERT OR IGNORE INTO titles (fc2_id, added_at) VALUES (?, ?)", (fc2_id, _now()))
            self._db.commit()

    def save_source(self, fc2_id, source, fields, error=""):
        """Store what one source returned. `fields` must include `<source>_state`."""
        fields = dict(fields)
        for key in JSON_FIELDS:
            if key in fields:
                fields[key] = json.dumps(fields[key], ensure_ascii=False)
        fields["fetched_at"] = _now()
        with self._lock:
            row = self._db.execute("SELECT errors FROM titles WHERE fc2_id = ?", (fc2_id,)).fetchone()
            if row is None:
                return
            errors = json.loads(row["errors"] or "{}")
            if error:
                errors[source] = error
            else:
                errors.pop(source, None)
            fields["errors"] = json.dumps(errors, ensure_ascii=False)
            assignments = ", ".join(f"{k} = ?" for k in fields)
            bump = ", attempts = attempts + 1" if error else ""
            self._db.execute(f"UPDATE titles SET {assignments}{bump} WHERE fc2_id = ?", [*fields.values(), fc2_id])
            self._db.execute(f"UPDATE titles SET {STATE_SQL} WHERE fc2_id = ?", (fc2_id,))
            self._db.commit()

    def reset_sources(self, fc2_id, everything=False, reset_attempts=False):
        """Mark sources as unfetched: all of them (refresh) or only those that errored (retry)."""
        with self._lock:
            if everything:
                self._db.execute("UPDATE titles SET fc2_state = '', pp_state = '', errors = '{}' WHERE fc2_id = ?",
                                 (fc2_id,))
            else:
                for source in SOURCES:
                    self._db.execute(f"UPDATE titles SET {source}_state = '' WHERE fc2_id = ? AND {source}_state = 'error'",
                                     (fc2_id,))
            if reset_attempts:
                self._db.execute("UPDATE titles SET attempts = 0 WHERE fc2_id = ?", (fc2_id,))
            self._db.execute(f"UPDATE titles SET {STATE_SQL} WHERE fc2_id = ?", (fc2_id,))
            self._db.commit()

    def set_flags(self, fc2_id, starred=None, hidden=None):
        with self._lock:
            if starred is not None:
                self._db.execute("UPDATE titles SET starred = ? WHERE fc2_id = ?", (int(starred), fc2_id))
            if hidden is not None:
                self._db.execute("UPDATE titles SET hidden = ? WHERE fc2_id = ?", (int(hidden), fc2_id))
            self._db.commit()

    def mark_viewed(self, fc2_id):
        with self._lock:
            self._db.execute("UPDATE titles SET viewed_at = ? WHERE fc2_id = ?", (_now(), fc2_id))
            self._db.commit()

    def save_torrent_detail(self, view_id, detail):
        with self._lock:
            self._db.execute(
                "UPDATE torrents SET files = ?, description = ?, risky = ?, detail_at = ? WHERE view_id = ?",
                (json.dumps(detail["files"], ensure_ascii=False), detail["description"],
                 int(detail["risky"]), _now(), view_id))
            self._db.commit()

    # --- reads --------------------------------------------------------------------------

    def next_stage(self, fc2_ids):
        """Map each id to the source it still needs first ("fc2" or "pp"); finished ids are left out."""
        if not fc2_ids:
            return {}
        marks = ",".join("?" * len(fc2_ids))
        with self._lock:
            rows = self._db.execute(
                f"SELECT fc2_id, fc2_state, pp_state FROM titles WHERE fc2_id IN ({marks})", list(fc2_ids)).fetchall()
        stages = {}
        for row in rows:
            if row["fc2_state"] == "":
                stages[row["fc2_id"]] = "fc2"
            elif row["pp_state"] == "":
                stages[row["fc2_id"]] = "pp"
        return {i: stages[i] for i in fc2_ids if i in stages}

    def unfinished_ids(self):
        with self._lock:
            return [r[0] for r in self._db.execute(
                "SELECT fc2_id FROM titles WHERE fc2_state = '' OR pp_state = '' ORDER BY added_at DESC")]

    def failed_ids(self, max_attempts=None):
        sql = "SELECT fc2_id FROM titles WHERE state = 'failed'"
        args = []
        if max_attempts is not None:
            sql += " AND attempts < ?"
            args.append(max_attempts)
        with self._lock:
            return [r[0] for r in self._db.execute(sql, args)]

    def torrents_without_detail(self, view_ids):
        if not view_ids:
            return []
        marks = ",".join("?" * len(view_ids))
        with self._lock:
            return [r[0] for r in self._db.execute(
                f"SELECT view_id FROM torrents WHERE detail_at IS NULL AND view_id IN ({marks})", list(view_ids))]

    def torrent(self, view_id):
        with self._lock:
            row = self._db.execute("SELECT * FROM torrents WHERE view_id = ?", (view_id,)).fetchone()
        return self._torrent_dict(row) if row else None

    def title(self, fc2_id):
        with self._lock:
            row = self._db.execute("SELECT * FROM titles WHERE fc2_id = ?", (fc2_id,)).fetchone()
            if not row:
                return None
            torrents = self._db.execute(
                "SELECT * FROM torrents WHERE fc2_id = ? ORDER BY seeders DESC, uploaded_at DESC",
                (fc2_id,)).fetchall()
        item = self._title_dict(row)
        item["torrents"] = [self._torrent_dict(t) for t in torrents]
        if not item["title"] and item["torrents"]:
            item["title"] = strip_code(item["torrents"][0]["name"])
        return item

    def _filtered(self, q, view, sort, min_seeders, media):
        """FROM/WHERE clauses, arguments and ORDER BY shared by the list and its id order."""
        where, args = [], []
        if view == "starred":
            where.append("t.starred = 1")
        elif view == "hidden":
            where.append("t.hidden = 1")
        else:
            where.append("t.hidden = 0")
            if view == "unseen":
                where.append("t.viewed_at IS NULL")
        if min_seeders:
            where.append("a.seeders >= ?")
            args.append(int(min_seeders))
        if media:
            where.append("(t.clips != '[]' OR t.samples != '[]')")
        q = (q or "").strip()
        if q:
            fc2_id = parse_id(q)
            if fc2_id:
                where.append("t.fc2_id = ?")
                args.append(fc2_id)
            else:
                like = f"%{q}%"
                where.append("(t.title LIKE ? OR t.seller LIKE ? OR t.tags LIKE ? OR EXISTS "
                             "(SELECT 1 FROM torrents x WHERE x.fc2_id = t.fc2_id AND x.name LIKE ?))")
                args += [like] * 4
        clause = " AND ".join(where) or "1"
        # One pass over torrents: per-title aggregates plus the best-seeded torrent's name and magnet.
        per_title = (
            "SELECT fc2_id, COUNT(*) OVER w AS torrent_count, MAX(seeders) OVER w AS seeders, "
            "MAX(uploaded_at) OVER w AS uploaded_at, MAX(size_bytes) OVER w AS size_bytes, "
            "MAX(COALESCE(risky, 0)) OVER w AS risky, name AS best_name, magnet AS best_magnet, "
            "ROW_NUMBER() OVER (PARTITION BY fc2_id ORDER BY seeders DESC, view_id DESC) AS rank "
            "FROM torrents WINDOW w AS (PARTITION BY fc2_id)")
        base = f"FROM titles t JOIN ({per_title}) a ON a.fc2_id = t.fc2_id AND a.rank = 1 WHERE {clause}"
        # The count needs only the aggregates the filters use, not the ranked window.
        count_base = (f"FROM titles t JOIN (SELECT fc2_id, MAX(seeders) AS seeders FROM torrents GROUP BY fc2_id) a "
                      f"ON a.fc2_id = t.fc2_id WHERE {clause}")
        order = f"{SORTS.get(sort, SORTS['uploaded'])}, t.fc2_id DESC"
        return base, count_base, args, order

    def ordered_ids(self, q="", view="all", sort="uploaded", min_seeders=0, media=False):
        """Every FC2 id of a view in display order (used to find where a mark sits)."""
        base, _, args, order = self._filtered(q, view, sort, min_seeders, media)
        with self._lock:
            return [r[0] for r in self._db.execute(f"SELECT t.fc2_id {base} ORDER BY {order}", args)]

    def list_titles(self, q="", view="all", sort="uploaded", min_seeders=0, media=False,
                    offset=0, limit=60):
        base, count_base, args, order = self._filtered(q, view, sort, min_seeders, media)
        with self._lock:
            total = self._db.execute(f"SELECT COUNT(*) {count_base}", args).fetchone()[0]
            rows = self._db.execute(
                "SELECT t.*, a.torrent_count, a.seeders AS best_seeders, a.uploaded_at AS last_upload, "
                "a.size_bytes AS max_size, a.risky AS any_risky, a.best_name, a.best_magnet "
                f"{base} ORDER BY {order} LIMIT ? OFFSET ?",
                args + [int(limit), int(offset)]).fetchall()
        items = []
        for row in rows:
            item = self._title_dict(row)
            item.update(
                torrent_count=row["torrent_count"], seeders=row["best_seeders"], uploaded_at=row["last_upload"],
                size_bytes=row["max_size"], risky=bool(row["any_risky"]), magnet=row["best_magnet"])
            if not item["title"]:
                item["title"] = strip_code(row["best_name"] or "")
            items.append(item)
        return {"total": total, "items": items}

    # --- reading marks ------------------------------------------------------------------

    def marks(self):
        with self._lock:
            rows = self._db.execute(
                "SELECT m.fc2_id, m.created_at, t.title, t.cover, t.fetched_at, "
                "(SELECT x.name FROM torrents x WHERE x.fc2_id = m.fc2_id ORDER BY x.seeders DESC LIMIT 1) AS best_name "
                "FROM marks m JOIN titles t ON t.fc2_id = m.fc2_id ORDER BY m.created_at").fetchall()
        return [{"fc2_id": r["fc2_id"], "created_at": r["created_at"], "cover": r["cover"], "fetched_at": r["fetched_at"],
                 "title": r["title"] or strip_code(r["best_name"] or "")} for r in rows]

    def set_mark(self, fc2_id, marked):
        with self._lock:
            if marked:
                self._db.execute("INSERT OR IGNORE INTO marks (fc2_id, created_at) "
                                 "SELECT fc2_id, ? FROM titles WHERE fc2_id = ?", (_now(), fc2_id))
            else:
                self._db.execute("DELETE FROM marks WHERE fc2_id = ?", (fc2_id,))
            self._db.commit()

    def stats(self):
        with self._lock:
            row = self._db.execute(
                "SELECT COUNT(*), SUM(state = 'pending'), SUM(state = 'failed'), SUM(starred) FROM titles").fetchone()
            torrents = self._db.execute("SELECT COUNT(*) FROM torrents").fetchone()[0]
        return {"titles": row[0] or 0, "pending": row[1] or 0, "failed": row[2] or 0,
                "starred": row[3] or 0, "torrents": torrents}

    # --- helpers ------------------------------------------------------------------------

    @staticmethod
    def _title_dict(row):
        item = {k: row[k] for k in (
            "fc2_id", "state", "title", "seller", "seller_url", "released", "duration", "rating", "reviews",
            "cover", "cover_full", "grid", "fc2_state", "pp_state", "attempts", "added_at", "fetched_at",
            "viewed_at")}
        for key in JSON_FIELDS:
            item[key] = json.loads(row[key] or "[]")
        item["errors"] = json.loads(row["errors"] or "{}")
        item["starred"] = bool(row["starred"])
        item["hidden"] = bool(row["hidden"])
        return item

    @staticmethod
    def _torrent_dict(row):
        item = {k: row[k] for k in TORRENT_FIELDS}
        item.update(
            seen_at=row["seen_at"],
            files=json.loads(row["files"]) if row["files"] else None,
            description=row["description"],
            risky=None if row["risky"] is None else bool(row["risky"]),
        )
        return item
