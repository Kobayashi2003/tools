"""FastAPI app: JSON API, media proxy, and the static single-page UI."""

import os
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import fc2
from .config import PROJECT, Settings
from .crawler import PER_JOB_PAGE_LIMIT, Crawler
from .fc2id import parse_id
from .media import MediaCache
from .net import FetchError, Http
from .store import SORTS, VIEWS, Store

STATIC = PROJECT / "app" / "static"


class JobRequest(BaseModel):
    kind: Literal["update", "older", "search"] = "update"
    blocks: int = Field(5, ge=1, le=500)                  # older: id blocks to read
    query: str = ""                                       # search: sukebei query
    pages: int = Field(PER_JOB_PAGE_LIMIT, ge=1, le=PER_JOB_PAGE_LIMIT)
    check_files: bool = False


class MarkRequest(BaseModel):
    fc2_id: str


class FlagsRequest(BaseModel):
    starred: bool | None = None
    hidden: bool | None = None


def _fc2_id(value):
    fc2_id = parse_id(value)
    if not fc2_id:
        raise HTTPException(400, "Not an FC2 id")
    return fc2_id


def create_app(settings=None, start_worker=True, http=None):
    settings = settings or Settings.from_env()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    store = Store(settings.data_dir / "library.db")
    http = http or Http(delay=settings.source_delay, delays=settings.host_delays(), proxy=settings.proxy)
    # Media gets its own lightly paced client so image loading never waits behind page crawling.
    media_http = Http(delay=0.05, attempts=2, timeout=60, proxy=settings.proxy) if start_worker else http
    media = MediaCache(settings.data_dir / "media", media_http)
    crawler = Crawler(store, http, media, settings)

    @asynccontextmanager
    async def lifespan(app):
        pid_file = settings.data_dir / "server.pid"
        if start_worker:
            pid_file.write_text(str(os.getpid()), encoding="ascii")
            crawler.start()
        try:
            yield
        finally:
            crawler.close()
            store.close()
            # Only our own: another instance's file must survive this one shutting down.
            try:
                if start_worker and pid_file.read_text(encoding="ascii").strip() == str(os.getpid()):
                    pid_file.unlink()
            except OSError:
                pass

    app = FastAPI(title="FC2 Sukebei Browser", version="1.0.0", lifespan=lifespan)
    app.state.store, app.state.crawler, app.state.media = store, crawler, media

    @app.middleware("http")
    async def json_posts_only(request, call_next):
        # Another site's page can make the browser POST a plain form to 127.0.0.1, but it cannot
        # send a JSON content type without a CORS preflight, which this app never grants.
        if request.method == "POST" and not request.headers.get("content-type", "").startswith("application/json"):
            return JSONResponse({"detail": "POST requests must send JSON"}, status_code=415)
        return await call_next(request)

    @app.middleware("http")
    async def revalidate_static(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-cache"   # ETag revalidation; UI updates show at once
        return response

    @app.get("/api/titles")
    def list_titles(q: str = "", view: str = "all", sort: str = "uploaded", min_seeders: int = 0,
                    media_only: bool = False, offset: int = Query(0, ge=0), limit: int = Query(60, ge=1, le=1000)):
        if view not in VIEWS or sort not in SORTS:
            raise HTTPException(400, "Unknown view or sort")
        return store.list_titles(q=q, view=view, sort=sort, min_seeders=min_seeders, media=media_only,
                                 offset=offset, limit=limit)

    @app.get("/api/titles/order")
    def title_order(q: str = "", view: str = "all", sort: str = "uploaded", min_seeders: int = 0,
                    media_only: bool = False):
        """Every FC2 id of the view in display order, so the UI can find where a mark sits."""
        if view not in VIEWS or sort not in SORTS:
            raise HTTPException(400, "Unknown view or sort")
        return {"ids": store.ordered_ids(q=q, view=view, sort=sort, min_seeders=min_seeders, media=media_only)}

    @app.get("/api/marks")
    def list_marks():
        return store.marks()

    @app.post("/api/marks")
    def add_mark(body: MarkRequest):
        store.set_mark(_fc2_id(body.fc2_id), True)
        return store.marks()

    @app.delete("/api/marks/{fc2_id}")
    def remove_mark(fc2_id: str):
        store.set_mark(_fc2_id(fc2_id), False)
        return store.marks()

    @app.get("/api/titles/{fc2_id}")
    def get_title(fc2_id: str, mark_viewed: bool = True):
        fc2_id = _fc2_id(fc2_id)
        if mark_viewed:
            store.mark_viewed(fc2_id)
        title = store.title(fc2_id)
        if not title:
            raise HTTPException(404, "Unknown title")
        if title["fc2_state"] == "" or title["pp_state"] == "":
            crawler.prioritize(fc2_id)               # someone is looking at it: fetch it next
        return title

    @app.post("/api/titles/{fc2_id}/prioritize")
    def prioritize_title(fc2_id: str):
        return {"queued": crawler.prioritize(_fc2_id(fc2_id))}

    @app.post("/api/titles/{fc2_id}/flags")
    def set_flags(fc2_id: str, body: FlagsRequest):
        fc2_id = _fc2_id(fc2_id)
        store.set_flags(fc2_id, starred=body.starred, hidden=body.hidden)
        return store.title(fc2_id) or {}

    @app.post("/api/titles/{fc2_id}/refresh")
    def refresh_title(fc2_id: str):
        fc2_id = _fc2_id(fc2_id)
        if not store.title(fc2_id):
            raise HTTPException(404, "Unknown title")
        crawler.refresh(fc2_id)
        return {"ok": True}

    @app.get("/api/titles/{fc2_id}/sample")
    def sample_video(fc2_id: str, request: Request):
        """Official FC2 sample video URL, signed for the browser's own User-Agent; never stored."""
        try:
            url = fc2.fetch_sample_video(http, _fc2_id(fc2_id), request.headers.get("user-agent"))
        except FetchError as exc:
            raise HTTPException(502, str(exc))
        if not url:
            raise HTTPException(404, "No sample video")
        return {"url": url}

    @app.get("/api/torrents/{view_id}")
    def torrent_detail(view_id: int, refresh: bool = False):
        try:
            torrent = crawler.torrent_detail(view_id, refresh=refresh)
        except FetchError as exc:
            raise HTTPException(502, str(exc))
        if not torrent:
            raise HTTPException(404, "Unknown torrent")
        return torrent

    @app.post("/api/jobs")
    def start_job(body: JobRequest):
        """update: new uploads · older: the next history blocks · search: a custom sukebei query."""
        try:
            return crawler.start_job(body.kind, blocks=body.blocks, query=body.query, pages=body.pages,
                                     check_files=body.check_files)
        except RuntimeError as exc:
            raise HTTPException(409, str(exc))

    @app.post("/api/jobs/cancel")
    def cancel_job():
        crawler.cancel()
        return {"ok": True}

    @app.post("/api/history/reset")
    def reset_history():
        try:
            crawler.reset_history()
        except RuntimeError as exc:
            raise HTTPException(409, str(exc))
        return crawler.coverage()

    @app.post("/api/retry-failed")
    def retry_failed():
        return {"queued": crawler.retry_failed()}

    @app.get("/api/status")
    def status():
        return {**crawler.status(), "default_query": settings.default_query, "watch_minutes": settings.watch_minutes}

    @app.get("/media")
    def proxy_media(u: str):
        try:
            path = media.get(u)
        except PermissionError:
            raise HTTPException(403, "Host not allowed")
        except FetchError as exc:
            raise HTTPException(404 if exc.status == 404 else 502, str(exc))
        return FileResponse(path, media_type=media.media_type(path),
                            headers={"Cache-Control": "public, max-age=604800"})

    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/")
    def index():
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})

    return app
