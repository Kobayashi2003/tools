"""Local FastAPI application, library queries, task controls, and artifact delivery."""

import csv
import io
import json
import os
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .client import Client, Deferred
from .database import Database, now
from .schema import CATEGORIES, JobRequest, RetryRequest, Settings
from .storage import Storage
from .worker import Worker, ordered_volumes

PROJECT = Path(__file__).resolve().parent.parent
FILE_STATS = """(SELECT COUNT(DISTINCT volume_id) FROM files f WHERE f.work_key=w.key) AS file_count,
    (SELECT COUNT(DISTINCT volume_id) FROM files f WHERE f.work_key=w.key AND f.ja_path IS NOT NULL) AS ja_count,
    (SELECT COUNT(*) FROM files f WHERE f.work_key=w.key AND f.mode!='zh-original' AND f.ja_path IS NULL)
        AS pending_count,
    (SELECT COUNT(*) FROM files f WHERE f.work_key=w.key AND f.verification='unverified') AS unverified_count"""
STATE_FILTERS = {"saved": "file_count>0", "partial": "file_count>0 AND file_count<volume_count",
                 "metadata": "file_count=0", "japanese": "ja_count>0", "pending": "pending_count>0",
                 "unverified": "unverified_count>0"}
SORTS = {"checked": "checked_at DESC", "added": "first_seen DESC", "title": "title COLLATE NOCASE",
         "volumes": "volume_count DESC"}


class RemoveWorks(BaseModel):
    keys: list[str] = Field(min_length=1, max_length=10000)
    delete_files: bool = False


class StorageRequest(BaseModel):
    directory: str = Field(min_length=1, max_length=4096)
    migrate: bool = True


class ProcessLock:
    """One server per data directory."""
    def __init__(self, path):
        self.path, self.file = path, None

    def acquire(self):
        self.file = self.path.open("a+b")
        try:
            if self.path.stat().st_size == 0:
                self.file.write(b"0")
                self.file.flush()
            self.file.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            self.file = None
            raise RuntimeError("Another Novelia server is already using this data directory.") from None

    def release(self):
        if self.file:
            self.file.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file, fcntl.LOCK_UN)
            self.file.close()


def create_app(data_root=None, download_root=None, start_worker=True):
    data_root = Path(data_root or os.environ.get("NOVELIA_DATA_DIR", PROJECT / "data")).resolve()
    download_root = Path(download_root or os.environ.get("NOVELIA_DOWNLOAD_DIR", PROJECT / "downloads")).resolve()
    db = Database(data_root / "library.sqlite3")
    download_root = Path(db.setting("download_root", str(download_root))).resolve()
    worker = Worker(db, download_root)
    storage = Storage(db, worker)
    lock = ProcessLock(data_root / "server.lock")

    @asynccontextmanager
    async def lifespan(app):
        if start_worker:
            lock.acquire()
            worker.start()
            (data_root / "server.pid").write_text(str(os.getpid()), encoding="ascii")
        try:
            yield
        finally:
            if start_worker:
                worker.shutdown()
                if not worker.thread.is_alive():
                    (data_root / "server.pid").unlink(missing_ok=True)
                    lock.release()

    app = FastAPI(title="Novelia Downloader v2", version="2.0.0", lifespan=lifespan)
    app.state.db, app.state.worker = db, worker
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "[::1]", "testserver"])

    @app.middleware("http")
    async def local_origin(request: Request, call_next):
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            origin = request.headers.get("origin")
            if origin and origin != str(request.base_url).rstrip("/"):
                return JSONResponse({"detail": "Cross-origin writes are blocked."}, status_code=403)
            if request.headers.get("sec-fetch-site") == "cross-site":
                return JSONResponse({"detail": "Cross-site writes are blocked."}, status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' https:; style-src 'self'; script-src 'self'; "
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
        if request.url.path in ("/docs", "/redoc"):
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; img-src 'self' https: data:; "
                "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; "
                "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; "
                "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
        response.headers["Cache-Control"] = "no-store"
        return response

    @contextmanager
    def maintenance():
        if not worker.maintenance_lock.acquire(blocking=False):
            raise HTTPException(409, "Wait for the running task to finish before managing storage.")
        try:
            if db.row("SELECT id FROM jobs WHERE status IN ('running','queued') LIMIT 1"):
                raise HTTPException(409, "Finish or cancel active tasks before managing storage.")
            yield
        except (ValueError, OSError) as exc:
            raise HTTPException(400, str(exc)) from exc
        finally:
            worker.maintenance_lock.release()

    @app.post("/api/library/remove")
    def remove_works(request: RemoveWorks):
        with maintenance():
            return storage.remove(request.keys, request.delete_files)

    @app.get("/api/library/missing")
    def missing_works():
        return {"items": storage.missing()}

    @app.post("/api/library/cleanup")
    def cleanup_works(request: RemoveWorks):
        with maintenance():
            missing = {w["key"] for w in storage.missing()}
            return storage.remove([key for key in request.keys if key in missing])

    @app.put("/api/storage")
    def change_storage(request: StorageRequest):
        with maintenance():
            return storage.change_directory(request.directory.strip(), request.migrate)

    @app.get("/api/status")
    def status():
        settings = db.settings()
        running = db.jobs(1, "running")
        paused = db.row("SELECT id,kind,resume_at,wait_reason FROM jobs WHERE status='queued' "
                        "AND resume_at IS NOT NULL ORDER BY resume_at LIMIT 1")
        return {**db.stats(), "running": running[0] if running else None, "paused": paused,
                "capabilities": ["library_remove", "library_cleanup", "storage_migration", "job_retry"],
                "incremental_enabled": settings.incremental_enabled, "interval_hours": settings.interval_hours,
                "last_incremental_at": db.setting("last_incremental_at"),
                "next_incremental_at": db.setting("next_incremental_at"),
                "download_root": str(worker.root), "data_root": str(data_root),
                "categories": CATEGORIES, "site": "https://n.novelia.cc", "server_time": now()}

    @app.get("/api/settings")
    def get_settings():
        return db.settings().model_dump()

    @app.put("/api/settings")
    def save_settings(settings: Settings):
        # Checked here rather than on the model so older saved settings still load.
        if settings.adaptive_delay and settings.max_delay <= settings.request_delay:
            raise HTTPException(422, "The slowest delay must be longer than the delay between requests, "
                                     "or turn off slowing down when refused.")
        old = db.settings()
        db.set_setting("config", settings.model_dump())
        if old.interval_hours != settings.interval_hours or old.incremental_enabled != settings.incremental_enabled:
            db.set_setting("next_incremental_at", None)
        worker.wake.set()
        return settings.model_dump()

    @app.get("/api/catalog")
    def catalog(page: int = Query(1, ge=1, le=100000), category: int = Query(1, ge=0, le=6),
                query: str = Query("", max_length=300)):
        client = Client(db.settings(), interactive=True)
        try:
            result = client.listing(page, category, query)
        except Deferred as exc:
            raise HTTPException(429, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(502, str(exc)) from exc
        finally:
            client.close()
        keys = ["wenku/" + str(item.get("id", "")).lower() for item in result["items"]]
        local = {r["key"]: r for r in db.rows(
            f"SELECT key,volume_count,{FILE_STATS} FROM works w WHERE key IN ({','.join('?' * len(keys))})", keys)
        } if keys else {}
        for item, key in zip(result["items"], keys):
            item["local"] = local.get(key)
        return result

    @app.get("/api/works")
    def works(query: str = "", category: int | None = None, kind: str = "",
              state: Literal["", "saved", "partial", "metadata", "japanese", "pending", "unverified"] = "",
              sort: Literal["checked", "added", "title", "volumes"] = "checked",
              page: int = Query(1, ge=1), page_size: int = Query(48, ge=1, le=200)):
        clauses, params = [], []
        if query:
            clauses.append("(title LIKE ? OR title_zh LIKE ? OR key LIKE ? OR authors LIKE ?)")
            params.extend([f"%{query}%"] * 4)
        if category is not None:
            clauses.append("category=?")
            params.append(category)
        if kind:
            clauses.append("kind=?")
            params.append(kind)
        if state:
            clauses.append(STATE_FILTERS[state])
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        inner = f"SELECT w.*,{FILE_STATS} FROM works w"
        total = db.row(f"SELECT COUNT(*) AS n FROM ({inner}){where}", params)["n"]
        items = db.rows(f"""SELECT key,kind,category,title,title_zh,cover,authors,publisher,volume_count,
            first_seen,checked_at,file_count,ja_count,pending_count,unverified_count
            FROM ({inner}){where} ORDER BY {SORTS[sort]},key LIMIT ? OFFSET ?""",
            [*params, page_size, (page - 1) * page_size])
        for row in items:
            row["authors"] = json.loads(row["authors"])
        return {"items": items, "total": total, "page": page, "page_size": page_size}

    @app.get("/api/works/{key:path}")
    def detail(key: str):
        work = db.row("SELECT * FROM works WHERE key=?", (key,))
        if not work:
            raise HTTPException(404, "Work not found.")
        work["metadata"] = json.loads(work["metadata"])
        work["authors"] = json.loads(work["authors"])
        work["files"] = db.rows("SELECT * FROM files WHERE work_key=? ORDER BY id", (key,))
        for file in work["files"]:
            file["report"] = json.loads(file["report"] or "null")
            file["raw_available"] = Path(file["raw_path"]).is_file()
            file["ja_available"] = bool(file["ja_path"] and Path(file["ja_path"]).is_file())
        work["volumes"] = [{"index": i, "volume_id": v["volumeId"], "chinese_only": zh,
                            "translated": {k: v[k] for k in ("sakura", "gpt", "youdao", "baidu", "total") if k in v}}
                           for i, (v, zh) in enumerate(ordered_volumes(key, work["metadata"]), 1)]
        return work

    @app.get("/api/jobs")
    def jobs():
        result = db.jobs()
        for job in result:
            job["request"] = json.loads(job["request"])
            job["config"] = json.loads(job["config"])
        return result

    @app.post("/api/jobs", status_code=201)
    def queue_job(request: JobRequest):
        job_id = db.create_job(request)
        db.log(job_id, "Task queued.")
        worker.wake.set()
        return {"id": job_id}

    @app.get("/api/jobs/{job_id}")
    def job_detail(job_id: int, after: int = Query(0, ge=0)):
        job = db.job(job_id)
        if not job:
            raise HTTPException(404, "Task not found.")
        job["request"], job["config"] = json.loads(job["request"]), json.loads(job["config"])
        job["logs"] = db.rows("SELECT * FROM logs WHERE job_id=? AND id>? ORDER BY id LIMIT 500", (job_id, after))
        job["items"] = db.open_items(job_id, job["kind"])
        return job

    @app.delete("/api/jobs/{job_id}")
    def delete_job(job_id: int):
        if not db.job(job_id):
            raise HTTPException(404, "Task not found.")
        if not db.delete_jobs("id=?", (job_id,)):
            raise HTTPException(409, "Cancel the task before removing it.")
        return {"ok": True}

    @app.post("/api/jobs/clear")
    def clear_jobs():
        return {"removed": db.delete_jobs("status='completed'")}

    @app.post("/api/jobs/{job_id}/cancel")
    def cancel(job_id: int):
        job = db.job(job_id)
        if not job:
            raise HTTPException(404, "Task not found.")
        if job["status"] not in ("queued", "running"):
            raise HTTPException(409, "Task is not queued or running.")
        if job["status"] == "queued":
            db.execute("UPDATE jobs SET status='cancelled',finished_at=?,cancel_requested=1 WHERE id=?", (now(), job_id))
        else:
            db.execute("UPDATE jobs SET cancel_requested=1 WHERE id=?", (job_id,))
        worker.wake.set()
        return {"ok": True}

    @app.post("/api/jobs/{job_id}/resume")
    def resume(job_id: int):
        try:
            db.resume(job_id)
        except KeyError:
            raise HTTPException(404, "Task not found.") from None
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        worker.wake.set()
        return {"ok": True}

    @app.post("/api/jobs/{job_id}/retry")
    def retry(job_id: int, request: RetryRequest | None = None):
        try:
            count = db.retry(job_id, request.targets if request else [])
        except KeyError:
            raise HTTPException(404, "Task not found.") from None
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        db.log(job_id, f"Retrying {count} failed item(s).")
        worker.wake.set()
        return {"retried": count}

    @app.get("/api/files/{file_id}/{variant}")
    def artifact(file_id: int, variant: str):
        if variant not in ("raw", "ja", "reference"):
            raise HTTPException(404, "File variant not found.")
        row = db.row("SELECT * FROM files WHERE id=?", (file_id,))
        raw = row and row[variant + "_path"]
        if not raw:
            raise HTTPException(404, "File not available.")
        path = Path(raw).resolve()
        if not any(path.is_relative_to(r.resolve()) for r in storage.roots()) or not path.is_file():
            raise HTTPException(404, "File is missing from the download directory.")
        return FileResponse(path, filename=path.name, media_type="application/epub+zip")

    @app.get("/api/export.csv")
    def export():
        stream = io.StringIO(newline="")
        writer = csv.writer(stream)
        writer.writerow(["key", "category", "title", "title_zh", "authors", "publisher", "volumes", "checked_at"])
        for row in db.rows("SELECT * FROM works ORDER BY key"):
            values = [row[k] for k in ("key", "category", "title", "title_zh", "authors", "publisher", "volume_count", "checked_at")]
            # Titles are remote data; prevent spreadsheet formula execution on export.
            writer.writerow(["'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@", "\t", "\r")) else v for v in values])
        return Response("\ufeff" + stream.getvalue(), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": 'attachment; filename="novelia-library.csv"'})

    app.mount("/static", StaticFiles(directory=PROJECT / "app" / "static"), name="static")

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(PROJECT / "app" / "static" / "index.html")

    return app
