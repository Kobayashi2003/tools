"""Local FastAPI app: the engine runs in this process, the UI is static files.

Every URL the page uses is relative, so the app works under a gateway path prefix.
One server per data directory (a lock file), since the engine owns the database.
"""

import asyncio
import json
import os
import sys
import time
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    RedirectResponse,
    Response,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import PROJECT, BadSetting
from .domain.match import parse_ref
from .domain.timefmt import now_utc
from .engine.context import Context
from .engine.jobs import JobRunner
from .engine.login import BrowserLogin, apply_sessid, find_browser
from .engine.views import creator_detail, creators, post_detail, post_rows
from .library.layout import clean_group, preview, regrouped
from .library.thumbs import Thumbs
from .sources.fanbox import SessionRejected
from .sources.http import PermanentError
from .store.db import dump

STATIC = Path(__file__).resolve().parent / "static"
JOBS_SHOWN = 200
EVENTS_SHOWN = 300
STREAM_SECONDS = 300


class ProcessLock:
    def __init__(self, path: Path):
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
            raise RuntimeError("Another Pawchive v2 server is using this data directory.") from None

    def release(self):
        if not self.file:
            return
        self.file.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(self.file, fcntl.LOCK_UN)
        self.file.close()


class AddCreator(BaseModel):
    ref: str = Field(min_length=1, max_length=500)
    group: str = ""
    sync: bool = True


class PatchCreator(BaseModel):
    alias: str | None = None
    group: str | None = None
    ignore: bool | None = None
    completed: bool | None = None
    filter: dict | None = None
    timer: dict | None = None
    clear_timer: bool = False
    preference: str | None = None


class JobRequest(BaseModel):
    kind: str
    creator_id: str | None = None
    creator_ids: list[str] | None = None
    params: dict = Field(default_factory=dict)


class PostAction(BaseModel):
    post_ids: list[str] = Field(min_length=1, max_length=20000)
    action: str
    source: str | None = None


class Session(BaseModel):
    sessid: str = Field(max_length=4000)


class AdoptRequest(BaseModel):
    creator_id: str
    root: str = Field(min_length=1, max_length=4096)
    offset: int | None = None


class RelayoutRequest(BaseModel):
    creator_id: str
    offset: int = 0


class Resolve(BaseModel):
    folder: str
    post_id: str | None = None


class MoveCreator(BaseModel):
    group: str = Field(max_length=1000)
    alias: str | None = Field(default=None, max_length=500)


class MoveGroup(BaseModel):
    source: str = Field(alias="from", min_length=1, max_length=1000)
    to: str = Field(max_length=1000)


def _not_found(e: KeyError) -> HTTPException:
    return HTTPException(404, f"Not found: {e.args[0] if e.args else ''}")


def create_app(data_dir: Path, start_engine: bool = True) -> FastAPI:
    ctx = Context(data_dir)
    runner = JobRunner(ctx, ctx.settings.max_concurrent_creators)
    lock = ProcessLock(data_dir / "server.lock")
    login = BrowserLogin(
        data_dir / "browser",
        lambda sessid: apply_sessid(ctx, sessid, "browser", keep_previous=True),
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if start_engine:
            lock.acquire()
            runner.start()
            (PROJECT / ".running.json").write_text(
                json.dumps({"pid": os.getpid(), "exe": sys.executable, "started": now_utc()}),
                encoding="utf-8",
            )
        try:
            yield
        finally:
            login.cancel()
            if start_engine:
                runner.shutdown()
                lock.release()
                (PROJECT / ".running.json").unlink(missing_ok=True)

    app = FastAPI(title="Pawchive v2", lifespan=lifespan)
    app.state.ctx = ctx
    app.state.runner = runner

    @app.middleware("http")
    async def revalidate_static(request: Request, call_next):
        # Scripts are ES modules imported by name; a cached old module next to a new one
        # breaks the page. `no-cache` still allows 304s, it only forbids reuse unchecked.
        response = await call_next(request)
        if not request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-cache")
        return response

    @app.exception_handler(BadSetting)
    async def bad_setting(_r: Request, e: BadSetting):
        return JSONResponse({"detail": str(e)}, status_code=400)

    # ---------------- overview ----------------

    @app.get("/api/state")
    def state():
        jobs = ctx.db.all("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY id")
        quota = ctx.pawchive_http.throttle.quota.snapshot()
        return {
            "session": ctx.session(),
            "session_from_env": ctx.store.sessid_from_env(),
            "jobs": _jobs(jobs),
            "quota": quota,
            "download_dir": ctx.settings.download_dir,
        }

    def _jobs(rows: list) -> list[dict]:
        names = {
            r["id"]: r["alias"] or r["name"]
            for r in ctx.db.all("SELECT id, alias, name FROM creators")
        }
        out = []
        for j in rows:
            d = dict(j)
            d["params"] = json.loads(d["params"] or "{}")
            d["progress"] = runner.progress.get(j["id"])
            if j["creator_id"]:
                d["creator_name"] = names.get(j["creator_id"], j["creator_id"])
            out.append(d)
        return out

    @app.get("/api/stream")
    async def stream(request: Request):
        """Server-sent events `state`, `jobs` and `events`, each sent only when it changed,
        so a view can update the rows that moved instead of redrawing on a timer. A stream
        ends after a while and the browser reconnects, which keeps shutdown prompt."""

        def snapshot(after: int) -> tuple[dict, list[dict], list[dict]]:
            jobs = _jobs(ctx.db.all("SELECT * FROM jobs ORDER BY id DESC LIMIT ?", (JOBS_SHOWN,)))
            events = ctx.db.all(
                "SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?", (after, EVENTS_SHOWN)
            )
            return state(), jobs, [dict(r) for r in events]

        async def messages():
            yield "retry: 2000\n\n"
            sent: dict[str, str] = {}
            last_event, first = 0, True
            started = quiet = time.monotonic()
            while time.monotonic() - started < STREAM_SECONDS:
                if await request.is_disconnected():
                    return
                current, jobs, events = await asyncio.to_thread(snapshot, last_event)
                out = []
                for kind, value in (("state", current), ("jobs", jobs)):
                    data = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
                    if sent.get(kind) != data:
                        sent[kind] = data
                        out.append(f"event: {kind}\ndata: {data}\n\n")
                if events or first:
                    payload = {"reset": first, "items": events}
                    out.append(
                        f"event: events\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                    )
                    last_event = max([last_event, *(e["id"] for e in events)])
                    first = False
                if out:
                    quiet = time.monotonic()
                    yield "".join(out)
                elif time.monotonic() - quiet > 15:
                    quiet = time.monotonic()
                    yield ": ping\n\n"
                await asyncio.sleep(1)

        return StreamingResponse(
            messages(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
        )

    # ---------------- creators ----------------

    @app.get("/api/creators")
    def list_creators():
        return creators(ctx)

    @app.post("/api/creators")
    def add_creator(body: AddCreator):
        ref = parse_ref(body.ref)
        if ref is None:
            raise HTTPException(
                400,
                "Unrecognised link or id. Paste a Pawchive, Fanbox or pixiv creator or post link.",
            )
        user_id, service, name, handle, icon = ref.user_id, ref.service, "", None, None
        try:
            if ref.kind == "fanbox_creator":
                info = ctx.fanbox.creator(ref.creator_id)
                user_id, handle = str(info["user"]["userId"]), ref.creator_id
                name, icon = info["user"].get("name", ""), info["user"].get("iconUrl")
            elif ref.kind == "fanbox_post":
                detail = ctx.fanbox.post(ref.post_id)
                user_id = detail.user_id
                handle = ref.creator_id or None
        except PermanentError:
            raise HTTPException(404, "No such creator or post on Fanbox.") from None
        cid = f"{service}_{user_id}"
        if ctx.creator(cid):
            return {"id": cid, "existing": True}
        pawchive_state = "unknown"
        try:
            profile = ctx.pawchive.profile(service, user_id)
            name = name or str(profile.get("name") or "")
        except PermanentError:
            pawchive_state = "none"
        if service == "fanbox" and not handle:
            handle = ctx.fanbox.creator_id_of(user_id)
        ctx.db.run(
            """INSERT INTO creators(id, service, user_id, name, group_path, icon_url,
               fanbox_creator_id, fanbox_state, pawchive_state, added_at)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (
                cid,
                service,
                user_id,
                name or handle or user_id,
                clean_group(body.group),
                icon,
                handle,
                "ok" if handle else ("none" if service == "fanbox" else "unknown"),
                pawchive_state,
                now_utc(),
            ),
        )
        ctx.events.log("info", f"Added creator {name or cid}", cid)
        if body.sync:
            runner.enqueue("sync", cid, {})
        return {"id": cid, "existing": False}

    @app.get("/api/creators/{cid}")
    def get_creator(cid: str):
        try:
            return creator_detail(ctx, cid)
        except KeyError as e:
            raise _not_found(e) from None

    def _move(cid: str, group: str | None, alias: str | None) -> int | None:
        """Queue moving a creator's folder to a new group or alias; None if neither changes.
        A destination that another creator owns is refused before anything is queued."""
        creator = ctx.creator(cid)
        if creator is None:
            raise HTTPException(404, "No such creator")
        to: str = creator["group_path"] if group is None else clean_group(group)
        name: str = creator["alias"] if alias is None else alias.strip()
        if to == creator["group_path"] and name == creator["alias"]:
            return None
        try:
            preview(ctx, creator, to, name)
        except ValueError as e:
            raise HTTPException(409, str(e)) from None
        return runner.enqueue("move", cid, {"group": to, "alias": name})

    @app.get("/api/creators/{cid}/move")
    def move_preview(cid: str, group: str, alias: str | None = None):
        creator = ctx.creator(cid)
        if creator is None:
            raise HTTPException(404, "No such creator")
        try:
            return preview(
                ctx, creator, clean_group(group), creator["alias"] if alias is None else alias
            )
        except ValueError as e:
            raise HTTPException(409, str(e)) from None

    @app.post("/api/creators/{cid}/move")
    def move_creator(cid: str, body: MoveCreator):
        return {"job": _move(cid, body.group, body.alias)}

    @app.post("/api/groups/move")
    def move_group(body: MoveGroup):
        """Rename a group, or move it under another: every creator in it (and in its
        subgroups) moves, folders included."""
        source, to = clean_group(body.source), clean_group(body.to)
        if regrouped(to, source, "") is not None:
            raise HTTPException(400, "A group cannot move into itself.")
        moves = []
        for c in ctx.db.all("SELECT id, group_path FROM creators ORDER BY group_path"):
            target = regrouped(c["group_path"], source, to)
            if target is not None:
                moves.append((c["id"], target))
        if not moves:
            raise HTTPException(404, f"No creator is in {source}")
        # Checked as a whole first, so a refused move does not leave the group half moved.
        for cid, target in moves:
            creator = ctx.creator(cid)
            assert creator is not None
            try:
                preview(ctx, creator, target, creator["alias"])
            except ValueError as e:
                raise HTTPException(409, str(e)) from None
        return {"jobs": [job for cid, target in moves if (job := _move(cid, target, None))]}

    @app.patch("/api/creators/{cid}")
    def patch_creator(cid: str, body: PatchCreator):
        if ctx.creator(cid) is None:
            raise HTTPException(404, "No such creator")
        job = _move(cid, body.group, body.alias)
        sets: dict[str, Any] = {}
        if body.ignore is not None:
            sets["ignore"] = int(body.ignore)
        if body.completed is not None:
            sets["completed"] = int(body.completed)
        if body.filter is not None:
            sets["filter"] = dump(body.filter)
        if body.timer is not None or body.clear_timer:
            sets["timer"] = None if body.clear_timer else dump(body.timer)
        if body.preference is not None:
            creator = ctx.creator(cid)
            assert creator is not None
            config = json.loads(creator["config"] or "{}")
            if body.preference in ("", "inherit"):
                config.pop("source_preference", None)
            elif body.preference in ("pawchive-first", "fanbox-first"):
                config["source_preference"] = body.preference
            else:
                raise HTTPException(400, "Unknown source preference")
            sets["config"] = dump(config)
        if sets:
            ctx.db.run(
                f"UPDATE creators SET {', '.join(k + '=?' for k in sets)} WHERE id=?",
                (*sets.values(), cid),
            )
        return {**creator_detail(ctx, cid), "job": job}

    @app.delete("/api/creators/{cid}")
    def delete_creator(cid: str):
        with ctx.db.tx() as conn:
            for table in ("files", "posts", "post_obs", "subscriptions"):
                conn.execute(f"DELETE FROM {table} WHERE creator_id=?", (cid,))
            conn.execute("DELETE FROM creators WHERE id=?", (cid,))
        ctx.events.log("info", f"Removed creator {cid} (files on disk kept)")
        return {"ok": True}

    @app.get("/api/creators/{cid}/posts")
    def get_posts(cid: str):
        try:
            return post_rows(ctx, cid)
        except KeyError as e:
            raise _not_found(e) from None

    @app.get("/api/creators/{cid}/posts/{pid}")
    def get_post(cid: str, pid: str):
        try:
            return post_detail(ctx, cid, pid)
        except KeyError as e:
            raise _not_found(e) from None

    @app.post("/api/creators/{cid}/posts/action")
    def post_action(cid: str, body: PostAction):
        if ctx.creator(cid) is None:
            raise HTTPException(404, "No such creator")
        if body.action in ("download", "redownload"):
            if body.source not in (None, "pawchive", "fanbox"):
                raise HTTPException(400, "Unknown source")
            job = runner.enqueue(
                "download",
                cid,
                {
                    "post_ids": body.post_ids,
                    "force": body.source,
                    "skip_sync": True,
                    "redownload": body.action == "redownload",
                },
            )
            return {"job": job}
        if body.action == "resync":
            return {"job": runner.enqueue("sync", cid, {"deep": True})}
        if body.action in ("mark_done", "mark_undone"):
            done = body.action == "mark_done"
            marks = ",".join("?" * len(body.post_ids))
            ctx.db.run(
                f"UPDATE posts SET local_done=?, done_at=?, origin=CASE WHEN ? THEN 'manual' "
                f"ELSE (CASE WHEN origin='manual' THEN NULL ELSE origin END) END "
                f"WHERE creator_id=? AND post_id IN ({marks})",
                (int(done), now_utc() if done else None, int(done), cid, *body.post_ids),
            )
            return {"ok": True}
        raise HTTPException(400, "Unknown action")

    @app.post("/api/open")
    def open_folder(body: dict):
        path = Path(str(body.get("path") or ""))
        if not path.is_absolute():
            raise HTTPException(400, "An absolute path is required")
        target = path if path.exists() else next((p for p in path.parents if p.exists()), None)
        if target is None:
            raise HTTPException(404, "No such folder")
        # Windows-only; looked up dynamically so the module still imports elsewhere.
        startfile = getattr(os, "startfile", None)
        if startfile is None:
            raise HTTPException(501, "Opening folders only works on Windows")
        startfile(target)
        return {"opened": str(target), "exact": target == path}

    # ---------------- jobs & events ----------------

    @app.get("/api/jobs")
    def list_jobs(limit: int = 60):
        return _jobs(ctx.db.all("SELECT * FROM jobs ORDER BY id DESC LIMIT ?", (limit,)))

    @app.post("/api/jobs")
    def add_job(body: JobRequest):
        ids = body.creator_ids or ([body.creator_id] if body.creator_id else [None])
        if body.kind in ("sync", "download") and ids == [None]:
            ids = [
                c["id"]
                for c in ctx.db.all("SELECT id FROM creators WHERE ignore=0 AND completed=0")
            ]
        try:
            return {"jobs": [runner.enqueue(body.kind, cid, body.params) for cid in ids]}
        except ValueError as e:
            raise HTTPException(400, str(e)) from None

    @app.post("/api/jobs/{job_id}/cancel")
    def cancel_job(job_id: int):
        return {"ok": runner.cancel(job_id)}

    @app.post("/api/jobs/cancel-all")
    def cancel_all():
        return {"cancelled": runner.cancel_all()}

    @app.get("/api/events")
    def events(limit: int = 200):
        return [
            dict(r) for r in ctx.db.all("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,))
        ]

    # ---------------- settings & Fanbox ----------------

    @app.get("/api/settings")
    def get_settings():
        return {"values": asdict(ctx.settings), "env": ctx.store.overridden()}

    @app.patch("/api/settings")
    def patch_settings(body: dict):
        if ctx.db.one("SELECT 1 FROM jobs WHERE status='running'"):
            raise HTTPException(409, "A job is running; change settings once it finishes.")
        ctx.store.save(body)
        ctx.reload_settings()
        return get_settings()

    def _no_env_cookie():
        if ctx.store.sessid_from_env():
            raise HTTPException(
                409,
                "The cookie comes from FANBOX_SESSID in the environment; a value set here would not be used.",
            )

    @app.post("/api/fanbox/session")
    def set_session(body: Session):
        _no_env_cookie()
        return apply_sessid(ctx, body.sessid, "manual")

    @app.post("/api/fanbox/login")
    def start_login():
        _no_env_cookie()
        browser = find_browser(ctx.settings.browser_path)
        if not browser:
            raise HTTPException(
                400, "Chrome or Edge was not found. Set browser_path to the browser's program."
            )
        return login.start(browser)

    @app.get("/api/fanbox/login")
    def login_status():
        return login.status

    @app.delete("/api/fanbox/login")
    def cancel_login():
        login.cancel()
        return login.status

    def _fanbox_cards(items: list[dict], **extra: str) -> list[dict]:
        """Search results and supported plans as one card shape; `extra` maps an output
        field to the item's key."""
        known = {
            r["user_id"] for r in ctx.db.all("SELECT user_id FROM creators WHERE service='fanbox'")
        }
        out = []
        for item in items:
            user_id = str((item.get("user") or {}).get("userId") or "")
            out.append(
                {
                    "user_id": user_id,
                    "creator_id": item.get("creatorId"),
                    "name": (item.get("user") or {}).get("name"),
                    "tracked": user_id in known,
                    **{k: item.get(v) for k, v in extra.items()},
                }
            )
        return out

    @app.get("/api/fanbox/search")
    def search(q: str, page: int = 0):
        cards = _fanbox_cards(ctx.fanbox.search(q, page), description="description")
        for c in cards:
            c["description"] = (c["description"] or "")[:140]
        return cards

    @app.get("/api/fanbox/supporting")
    def supporting():
        if not ctx.store.fanbox_sessid():
            raise HTTPException(400, "No Fanbox cookie is set.")
        try:
            plans = ctx.fanbox.supporting()
        except SessionRejected as e:
            ctx.set_session_state(state="rejected", message=str(e))
            raise HTTPException(401, str(e)) from None
        return _fanbox_cards(plans, fee="fee", title="title")

    # ---------------- migrations ----------------

    @app.post("/api/migrations/adopt")
    def adopt(body: AdoptRequest):
        from .library.migrate import plan_adopt

        try:
            plan_id = plan_adopt(ctx, body.creator_id, Path(body.root), body.offset)
        except (FileNotFoundError, RuntimeError) as e:
            raise HTTPException(400, str(e)) from None
        except KeyError as e:
            raise _not_found(e) from None
        return get_migration(plan_id)

    @app.post("/api/migrations/relayout")
    def relayout(body: RelayoutRequest):
        from .library.migrate import plan_relayout

        try:
            return get_migration(plan_relayout(ctx, body.creator_id, body.offset))
        except KeyError as e:
            raise _not_found(e) from None

    @app.get("/api/migrations")
    def list_migrations(creator_id: str | None = None):
        rows = ctx.db.all(
            "SELECT id, kind, creator_id, created_at, executed_at, summary, result FROM migrations "
            + ("WHERE creator_id=? " if creator_id else "")
            + "ORDER BY id DESC LIMIT 30",
            (creator_id,) if creator_id else (),
        )
        return [
            {
                **dict(r),
                "summary": json.loads(r["summary"]),
                "result": json.loads(r["result"]) if r["result"] else None,
            }
            for r in rows
        ]

    @app.get("/api/migrations/{plan_id}")
    def get_migration(plan_id: int):
        row = ctx.db.one("SELECT * FROM migrations WHERE id=?", (plan_id,))
        if row is None:
            raise HTTPException(404, "No such plan")
        return {
            **dict(row),
            "params": json.loads(row["params"]),
            "summary": json.loads(row["summary"]),
            "items": json.loads(row["items"]),
            "result": json.loads(row["result"]) if row["result"] else None,
        }

    @app.post("/api/migrations/{plan_id}/resolve")
    def resolve_item(plan_id: int, body: Resolve):
        from .library.migrate import resolve

        try:
            return resolve(ctx, plan_id, body.folder, body.post_id)
        except KeyError as e:
            raise _not_found(e) from None
        except RuntimeError as e:
            raise HTTPException(400, str(e)) from None

    @app.post("/api/migrations/{plan_id}/execute")
    def execute_plan(plan_id: int):
        row = ctx.db.one("SELECT creator_id, executed_at FROM migrations WHERE id=?", (plan_id,))
        if row is None:
            raise HTTPException(404, "No such plan")
        if row["executed_at"]:
            raise HTTPException(400, "This plan has already been executed")
        return {"job": runner.enqueue("migration", row["creator_id"], {"plan_id": plan_id})}

    # ---------------- thumbnails ----------------

    thumbs = Thumbs(ctx)

    @app.get("/api/thumbs/{cid}/{pid}")
    def thumb(cid: str, pid: str):
        path = thumbs.get(cid, pid)
        if path is None:
            return Response(status_code=404, headers={"Cache-Control": "max-age=3600"})
        return FileResponse(
            path, media_type="image/jpeg", headers={"Cache-Control": "max-age=604800"}
        )

    # ---------------- static ----------------

    @app.get("/")
    def index():
        return FileResponse(STATIC / "index.html")

    @app.get("/index.html")
    def index_redirect():
        return RedirectResponse("./", status_code=308)

    app.mount("/", StaticFiles(directory=STATIC), name="static")
    return app
