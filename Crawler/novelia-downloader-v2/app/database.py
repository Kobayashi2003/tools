"""SQLite persistence; each operation owns its connection."""

import json
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from .schema import Settings


def iso(moment):
    return moment.astimezone(UTC).isoformat(timespec="seconds")


def now():
    return iso(datetime.now(UTC))


def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


# File modes. Bilingual files are converted; originals are kept as uploaded.
BILINGUAL_MODES = ("jp-zh", "zh-jp")
ORIGINAL_ZH = "zh-original"  # a volume uploaded only in Chinese
ORIGINAL_JP = "jp-original"  # the uploaded Japanese original
CHINESE = "zh"  # Novelia's Chinese-only build of a Japanese upload
BILINGUAL_SQL = "mode IN ('jp-zh','zh-jp')"

# Display title of a job item `i`; the `?` binds the job kind. Conversion targets are file IDs,
# matched through the files primary key.
ITEM_TITLE = "COALESCE(w.title, fw.title || ' · ' || f.volume_id, i.target)"
ITEM_TITLE_JOINS = """LEFT JOIN works w ON w.key=i.target
    LEFT JOIN files f ON ?='convert' AND f.id=CAST(i.target AS INTEGER)
    LEFT JOIN works fw ON fw.key=f.work_key"""

# Columns added after the first release; created on demand so existing databases keep working.
ADDED_COLUMNS = {
    "jobs": {
        "resume_at": "TEXT",
        "pauses": "INTEGER NOT NULL DEFAULT 0",
        "wait_until": "TEXT",
        "wait_reason": "TEXT",
        # Retry rounds already used, kept across automatic pauses.
        "retry_round": "INTEGER NOT NULL DEFAULT 0",
        # Set by "Start now": the user chose to run outside active hours.
        "ignore_window": "INTEGER NOT NULL DEFAULT 0",
    },
    "job_items": {
        "attempts": "INTEGER NOT NULL DEFAULT 0",
        "retryable": "INTEGER NOT NULL DEFAULT 0",
        "parts": "TEXT",
    },
    "files": {
        # The Chinese edition converted from a bilingual file.
        "zh_path": "TEXT",
        # Downloaded by name rather than by the strategy: never removed as a stand-in.
        "pinned": "INTEGER NOT NULL DEFAULT 0",
    },
}


class Database:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS works (
                    key TEXT PRIMARY KEY, kind TEXT NOT NULL, category INTEGER,
                    title TEXT NOT NULL, title_zh TEXT NOT NULL, cover TEXT NOT NULL,
                    authors TEXT NOT NULL, publisher TEXT NOT NULL, metadata TEXT NOT NULL,
                    volume_count INTEGER NOT NULL, first_seen TEXT NOT NULL, checked_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS files (
                    id INTEGER PRIMARY KEY, work_key TEXT NOT NULL REFERENCES works(key),
                    volume_id TEXT NOT NULL, mode TEXT NOT NULL, fingerprint TEXT NOT NULL,
                    raw_path TEXT NOT NULL, ja_path TEXT, reference_path TEXT,
                    size INTEGER NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL,
                    verification TEXT, report TEXT, updated_at TEXT NOT NULL,
                    UNIQUE(work_key, volume_id, mode)
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
                    request TEXT NOT NULL, config TEXT NOT NULL, cursor INTEGER NOT NULL,
                    listing_done INTEGER NOT NULL DEFAULT 0, page_count INTEGER,
                    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
                    cancel_requested INTEGER NOT NULL DEFAULT 0, error TEXT,
                    scheduled INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS job_items (
                    job_id INTEGER NOT NULL REFERENCES jobs(id), target TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending', error TEXT,
                    PRIMARY KEY(job_id, target)
                );
                CREATE TABLE IF NOT EXISTS logs (
                    id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id),
                    created_at TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL
                );
                DROP TABLE IF EXISTS damaged;
                CREATE TABLE IF NOT EXISTS unavailable (
                    work_key TEXT NOT NULL, volume_id TEXT NOT NULL, mode TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, error TEXT NOT NULL, job_id INTEGER NOT NULL,
                    checked_at TEXT NOT NULL, PRIMARY KEY(work_key, volume_id, mode)
                );
                CREATE INDEX IF NOT EXISTS log_job_idx ON logs(job_id, id);
                CREATE INDEX IF NOT EXISTS item_status_idx ON job_items(job_id, status);
                CREATE INDEX IF NOT EXISTS file_work_idx ON files(work_key);
            """)
            for table, columns in ADDED_COLUMNS.items():
                present = {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}
                for name, kind in columns.items():
                    if name not in present:
                        db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {kind}")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def rows(self, sql, args=()):
        with self.connect() as db:
            return [dict(r) for r in db.execute(sql, args)]

    def row(self, sql, args=()):
        rows = self.rows(sql, args)
        return rows[0] if rows else None

    def execute(self, sql, args=()):
        with self.connect() as db:
            return db.execute(sql, args).lastrowid

    def setting(self, key, default=None):
        row = self.row("SELECT value FROM settings WHERE key=?", (key,))
        return json.loads(row["value"]) if row else default

    def set_setting(self, key, value):
        self.execute(
            "INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, dump(value)),
        )

    def settings(self):
        return Settings.model_validate(self.setting("config", {}))

    def create_job(self, request, scheduled=False):
        config = self.settings().model_dump()
        with self.connect() as db:
            if (
                scheduled
                and db.execute(
                    "SELECT id FROM jobs WHERE kind IN ('full','incremental') "
                    "AND status IN ('queued','running','interrupted')"
                ).fetchone()
            ):
                return None
            return db.execute(
                "INSERT INTO jobs(kind,status,request,config,cursor,created_at,scheduled) VALUES (?,?,?,?,?,?,?)",
                (
                    request.kind,
                    "queued",
                    dump(request.model_dump()),
                    dump(config),
                    request.start_page,
                    now(),
                    int(scheduled),
                ),
            ).lastrowid

    def jobs(self, limit=60, status=None):
        where, args = ("WHERE j.status=?", (status, limit)) if status else ("", (limit,))
        return self.rows(
            f"""SELECT j.*, COUNT(i.target) AS total,
            COALESCE(SUM(i.status='done'),0) AS done, COALESCE(SUM(i.status='failed'),0) AS failed,
            (SELECT {ITEM_TITLE} FROM job_items i {ITEM_TITLE_JOINS.replace("?", "j.kind")}
                WHERE i.job_id=j.id AND i.status='running' LIMIT 1) AS current
            FROM jobs j LEFT JOIN job_items i ON i.job_id=j.id {where}
            GROUP BY j.id ORDER BY j.id DESC LIMIT ?""",
            args,
        )

    def stats(self):
        return self.rows("""SELECT (SELECT COUNT(*) FROM works) AS works,
            (SELECT COUNT(*) FROM files) AS files,
            (SELECT COUNT(*) FROM files WHERE ja_path IS NOT NULL) AS converted,
            (SELECT COALESCE(SUM(size),0) FROM files) AS bytes,
            (SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')) AS active_jobs""")[0]

    def delete_jobs(self, where, args=()):
        with self.connect() as db:
            ids = [
                r["id"]
                for r in db.execute(
                    f"SELECT id FROM jobs WHERE status NOT IN ('queued','running') AND {where}",
                    args,
                )
            ]
            for table, column in (("logs", "job_id"), ("job_items", "job_id"), ("jobs", "id")):
                db.executemany(f"DELETE FROM {table} WHERE {column}=?", [(i,) for i in ids])
        return len(ids)

    def job(self, job_id):
        return self.row("SELECT * FROM jobs WHERE id=?", (job_id,))

    def logs(
        self, job_id: int, after: int = 0, before: int = 0, problems: bool = False, limit: int = 300
    ) -> tuple[list[dict], bool]:
        """Log lines in id order, and whether older lines exist before the first one returned."""
        where = "job_id=?" + (" AND level IN ('warning','error')" if problems else "")
        if after:
            rows = self.rows(
                f"SELECT * FROM logs WHERE {where} AND id>? ORDER BY id LIMIT ?",
                (job_id, after, limit),
            )
            return rows, False
        bound = " AND id<?" if before else ""
        args = (job_id, before, limit) if before else (job_id, limit)
        rows = self.rows(f"SELECT * FROM logs WHERE {where}{bound} ORDER BY id DESC LIMIT ?", args)[
            ::-1
        ]
        earlier = bool(
            rows
            and self.row(
                f"SELECT 1 FROM logs WHERE {where} AND id<? LIMIT 1", (job_id, rows[0]["id"])
            )
        )
        return rows, earlier

    def open_items(self, job_id, kind, limit=500):
        """Running and failed items with a display title (work title, or work · volume for conversions)."""
        items = self.rows(
            f"""SELECT i.target,i.status,i.error,i.attempts,i.retryable,i.parts,
            {ITEM_TITLE} AS title FROM job_items i {ITEM_TITLE_JOINS}
            WHERE i.job_id=? AND i.status IN ('running','failed') ORDER BY i.rowid LIMIT ?""",
            (kind, job_id, limit),
        )
        for item in items:
            item["parts"] = json.loads(item["parts"] or "{}")
        return items

    def log(self, job_id, message, level="info"):
        self.execute(
            "INSERT INTO logs(job_id,created_at,level,message) VALUES (?,?,?,?)",
            (job_id, now(), level, message[:4000]),
        )

    def add_targets(self, job_id, targets, next_page=None, page_count=None):
        # One transaction for targets and checkpoint, so a failed page is never skipped.
        with self.connect() as db:
            db.executemany(
                "INSERT OR IGNORE INTO job_items(job_id,target) VALUES (?,?)",
                [(job_id, t) for t in targets],
            )
            if next_page is not None:
                db.execute(
                    "UPDATE jobs SET cursor=?,page_count=? WHERE id=?",
                    (next_page, page_count, job_id),
                )

    @staticmethod
    def work_fields(key, data):
        """The `works` columns taken from Novelia's metadata."""
        kind = "wenku" if key.startswith("wenku/") else "web"
        title = data.get("title", "") if kind == "wenku" else data.get("titleJp", "")
        return {
            "key": key,
            "kind": kind,
            "title": title or key,
            "title_zh": data.get("titleZh", ""),
            "cover": data.get("cover", ""),
            "authors": [
                a.get("name", "") if isinstance(a, dict) else str(a)
                for a in data.get("authors", [])
            ],
            "publisher": data.get("publisher", ""),
            "volume_count": (
                len(data.get("volumeJp", [])) + len(data.get("volumeZh", []))
                if kind == "wenku"
                else sum(bool(c.get("chapterId")) for c in data.get("toc", []))
            ),
        }

    def save_work(self, key, data, category=None):
        work = self.work_fields(key, data)
        self.execute(
            """INSERT INTO works VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(key) DO UPDATE SET category=COALESCE(excluded.category,works.category),
            title=excluded.title,title_zh=excluded.title_zh,cover=excluded.cover,
            authors=excluded.authors,publisher=excluded.publisher,metadata=excluded.metadata,
            volume_count=excluded.volume_count,checked_at=excluded.checked_at""",
            (
                key,
                work["kind"],
                category,
                work["title"],
                work["title_zh"],
                work["cover"],
                dump(work["authors"]),
                work["publisher"],
                dump(data),
                work["volume_count"],
                now(),
                now(),
            ),
        )

    def save_file(self, key, volume, mode, fingerprint, path, size, sha256):
        self.execute(
            """INSERT INTO files(work_key,volume_id,mode,fingerprint,raw_path,size,sha256,
            status,updated_at) VALUES (?,?,?,?,?,?,?,'downloaded',?)
            ON CONFLICT(work_key,volume_id,mode) DO UPDATE SET fingerprint=excluded.fingerprint,
            raw_path=excluded.raw_path,size=excluded.size,sha256=excluded.sha256,
            ja_path=NULL,zh_path=NULL,verification=NULL,report=NULL,status='downloaded',
            updated_at=excluded.updated_at""",
            (key, volume, mode, fingerprint, str(path), size, sha256, now()),
        )

    def save_original(self, key, volume, fingerprint, path, size, sha256):
        """Record a Japanese original. It is its own Japanese edition: nothing to convert."""
        self.save_file(key, volume, ORIGINAL_JP, fingerprint, path, size, sha256)
        self.execute(
            "UPDATE files SET ja_path=raw_path,status='original',verification='original' "
            "WHERE work_key=? AND volume_id=? AND mode=?",
            (key, volume, ORIGINAL_JP),
        )

    def pin(self, file_id):
        self.execute("UPDATE files SET pinned=1 WHERE id=?", (file_id,))

    def unavailable(self, key, volume, mode):
        return self.row(
            "SELECT * FROM unavailable WHERE work_key=? AND volume_id=? AND mode=?",
            (key, volume, mode),
        )

    def mark_unavailable(self, key, volume, mode, fingerprint, error, job_id):
        """Remember a format Novelia could not supply (a broken upload, or a build that fails
        every time), so later sweeps skip it until it changes."""
        self.execute(
            "INSERT OR REPLACE INTO unavailable(work_key,volume_id,mode,fingerprint,error,job_id,"
            "checked_at) VALUES (?,?,?,?,?,?,?)",
            (key, volume, mode, fingerprint, error, job_id, now()),
        )

    def clear_unavailable(self, key, volume, mode):
        self.execute(
            "DELETE FROM unavailable WHERE work_key=? AND volume_id=? AND mode=?",
            (key, volume, mode),
        )

    def next_job(self):
        """The oldest queued task that is not paused until later."""
        return self.row(
            "SELECT * FROM jobs WHERE status='queued' AND (resume_at IS NULL OR resume_at<=?) "
            "ORDER BY id LIMIT 1",
            (now(),),
        )

    def set_wait(self, job_id, until, reason):
        self.execute(
            "UPDATE jobs SET wait_until=?,wait_reason=? WHERE id=?",
            (iso(until) if until else None, reason, job_id),
        )

    def defer(self, job_id, until, reason, pauses):
        self.execute(
            "UPDATE jobs SET status='queued',resume_at=?,wait_reason=?,wait_until=NULL,pauses=? WHERE id=?",
            (iso(until), reason, pauses, job_id),
        )

    def parts(self, job_id, target):
        row = self.row("SELECT parts FROM job_items WHERE job_id=? AND target=?", (job_id, target))
        parts = json.loads(row["parts"]) if row and row["parts"] else {}
        return {"done": parts.get("done", []), "failed": parts.get("failed", {})}

    def mark_part(self, job_id, target, volume, error=None):
        """Record one volume's outcome so retries skip volumes that already succeeded."""
        parts = self.parts(job_id, target)
        parts["failed"].pop(volume, None)
        if error is None:
            parts["done"] = [*dict.fromkeys([*parts["done"], volume])]
        else:
            parts["failed"][volume] = error
        self.execute(
            "UPDATE job_items SET parts=? WHERE job_id=? AND target=?",
            (dump(parts), job_id, target),
        )

    def _requeue(self, db, job_id, ignore_window=0):
        """Queue a task again at the user's request, with fresh pause and retry-round budgets."""
        db.execute(
            "UPDATE jobs SET status='queued',cancel_requested=0,error=NULL,finished_at=NULL,resume_at=NULL,"
            "wait_until=NULL,wait_reason=NULL,pauses=0,retry_round=0,ignore_window=? WHERE id=?",
            (ignore_window, job_id),
        )

    def resume(self, job_id):
        """Continue a stopped task, or start a paused one now (even outside active hours)."""
        with self.connect() as db:
            row = db.execute("SELECT status,resume_at FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise KeyError(job_id)
            if row["status"] == "queued" and row["resume_at"]:
                self._requeue(db, job_id, ignore_window=1)
                return
            if row["status"] in ("running", "queued", "completed"):
                raise ValueError(
                    "Only cancelled, interrupted, failed, or paused tasks can be resumed."
                )
            db.execute(
                "UPDATE job_items SET status='pending',error=NULL WHERE job_id=? AND status!='done'",
                (job_id,),
            )
            self._requeue(db, job_id)

    def retry(self, job_id, targets=(), only_retryable=False):
        """Make failed items (all, only `targets`, or only temporary ones) pending again.
        A stopped task is queued; a queued or running one picks them up next."""
        with self.connect() as db:
            row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise KeyError(job_id)
            sql = "UPDATE job_items SET status='pending',error=NULL WHERE job_id=? AND status='failed'"
            args = [job_id]
            if only_retryable:
                sql += " AND retryable=1"
            if targets:
                sql += f" AND target IN ({','.join('?' * len(targets))})"
                args.extend(targets)
            count = db.execute(sql, args).rowcount
            if not count:
                raise ValueError("No failed items to retry.")
            if row["status"] not in ("running", "queued"):
                self._requeue(db, job_id)
            return count

    def recover(self):
        with self.connect() as db:
            db.execute(
                "UPDATE jobs SET status='interrupted',error='Server stopped before completion',"
                "wait_until=NULL,wait_reason=NULL WHERE status='running'"
            )
            db.execute("UPDATE job_items SET status='pending' WHERE status='running'")
