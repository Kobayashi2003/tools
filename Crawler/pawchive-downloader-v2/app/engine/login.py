"""The Fanbox cookie: stored and verified, or read from a browser this app starts.

A page cannot read another site's cookies, and Chrome refuses a debugging port on your
everyday profile, so the browser runs on its own profile under data/ and the cookie is
read over the DevTools protocol. Sign in there once; the profile stays signed in, so a
later sign-in usually completes without you touching the window.
"""

import json
import os
import re
import shutil
import subprocess
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

import websocket

from ..domain.timefmt import now_utc
from ..sources.fanbox import SessionRejected
from .context import Context
from .sync import refresh_subscriptions

LOGIN_URL = "https://www.fanbox.cc/login"
WAIT_SECONDS = 600
POLL_SECONDS = 1.5
SIGNED_IN = re.compile(r"^\d+_\w+$")
WINDOWS_BROWSERS = (
    r"Google\Chrome\Application\chrome.exe",
    r"Microsoft\Edge\Application\msedge.exe",
)


def apply_sessid(ctx: Context, sessid: str, source: str, keep_previous: bool = False) -> dict:
    """Store `sessid` and verify it by reading your plans. With `keep_previous`, a cookie
    Fanbox refuses is dropped again: a signed-out browser still holds an anonymous cookie,
    and it must not replace a working one or pause Fanbox."""
    sessid = sessid.strip()
    previous_id, previous_state = ctx.store.fanbox_sessid(), ctx.db.kv_get("fanbox_session", {})
    if keep_previous and sessid == previous_id and ctx.session().get("state") == "valid":
        ctx.set_session_state(source=source)
        return ctx.session()
    ctx.store.set_fanbox_sessid(sessid)
    ctx.fanbox.set_session(ctx.store.fanbox_sessid())
    ctx.db.kv_set("fanbox_session", {"source": source})
    if not ctx.store.fanbox_sessid():
        return ctx.session()
    try:
        refresh_subscriptions(ctx)
        if sessid != previous_id:
            # Another account, or the same one signed in again: which posts are open may
            # have changed, so the background check revisits every creator.
            ctx.db.kv_set("fanbox_access_changed", now_utc())
    except SessionRejected:
        if keep_previous:
            ctx.store.set_fanbox_sessid(previous_id)
            ctx.fanbox.set_session(previous_id)
            ctx.db.kv_set("fanbox_session", previous_state)
            return {"state": "rejected", "message": "Fanbox refused the cookie (signed out?)."}
    except Exception as e:
        ctx.set_session_state(state="unchecked", message=f"Could not verify: {e}")
    return ctx.session()


def find_browser(configured: str) -> str | None:
    if configured:
        return configured if Path(configured).is_file() else None
    for root in filter(
        None, map(os.environ.get, ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"))
    ):
        for rel in WINDOWS_BROWSERS:
            if (Path(root) / rel).is_file():
                return str(Path(root) / rel)
    for name in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge"):
        if found := shutil.which(name):
            return found
    return None


class Calls(Protocol):
    def call(self, method: str, **params: object) -> dict: ...


class DevTools:
    """Just enough of the DevTools protocol for request/response calls."""

    def __init__(self, url: str):
        # Chrome refuses DevTools websockets that carry an Origin it was not told to allow.
        self.ws = websocket.create_connection(url, timeout=10, suppress_origin=True)
        self.last_id = 0

    def call(self, method: str, **params: object) -> dict:
        self.last_id += 1
        self.ws.send(json.dumps({"id": self.last_id, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.last_id:
                if "error" in msg:
                    raise RuntimeError(msg["error"].get("message", "DevTools error"))
                return msg.get("result") or {}

    def close(self):
        self.ws.close()


class BrowserLogin:
    """One sign-in at a time. `accept(sessid)` returns the session after storing the
    cookie; one Fanbox refuses (not signed in yet) is skipped and the wait goes on."""

    def __init__(self, profile: Path, accept: Callable[[str], dict]):
        self.profile = profile
        self.accept = accept
        self.status: dict = {"state": "idle"}
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self, browser: str) -> dict:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return self.status
            self._cancel.clear()
            self.status = {
                "state": "waiting",
                "message": "Sign in to Fanbox in the browser window.",
            }
            self._thread = threading.Thread(
                target=self._run, args=(browser,), name="fanbox-login", daemon=True
            )
            self._thread.start()
            return self.status

    def cancel(self):
        self._cancel.set()

    def _run(self, browser: str):
        proc: subprocess.Popen | None = None
        tools: DevTools | None = None
        try:
            proc = self._launch(browser)
            tools = DevTools(self._endpoint(proc))
            self.status = self._wait(tools)
        except Exception as e:
            self.status = {"state": "failed", "message": str(e)}
        finally:
            if tools:
                try:
                    tools.call("Browser.close")
                except Exception:
                    pass
                tools.close()
            if proc:
                try:
                    proc.wait(10)
                except subprocess.TimeoutExpired:
                    proc.kill()

    def _launch(self, browser: str) -> subprocess.Popen:
        self.profile.mkdir(parents=True, exist_ok=True)
        (self.profile / "DevToolsActivePort").unlink(missing_ok=True)
        return subprocess.Popen(
            [
                browser,
                f"--user-data-dir={self.profile}",
                # 0 picks a free port; the browser writes it to DevToolsActivePort.
                "--remote-debugging-port=0",
                "--no-first-run",
                "--no-default-browser-check",
                LOGIN_URL,
            ]
        )

    def _endpoint(self, proc: subprocess.Popen) -> str:
        port_file = self.profile / "DevToolsActivePort"
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(
                    "The browser exited before it was ready. If a sign-in window is still "
                    "open from an earlier try, close it and try again."
                )
            lines = port_file.read_text().split() if port_file.exists() else []
            if len(lines) >= 2:
                return f"ws://127.0.0.1:{lines[0]}{lines[1]}"
            time.sleep(0.2)
        raise RuntimeError("The browser did not open its DevTools port.")

    def _wait(self, tools: Calls) -> dict:
        tried: set[str] = set()
        deadline = time.monotonic() + WAIT_SECONDS
        while not self._cancel.is_set():
            if time.monotonic() > deadline:
                return {"state": "failed", "message": "Gave up waiting for the sign-in."}
            try:
                cookies = tools.call("Storage.getCookies").get("cookies", [])
            except websocket.WebSocketException, OSError:
                return {"state": "failed", "message": "The browser was closed before signing in."}
            sessid = next(
                (
                    c["value"]
                    for c in cookies
                    if c.get("name") == "FANBOXSESSID"
                    and str(c.get("domain", "")).endswith("fanbox.cc")
                ),
                "",
            )
            # A signed-in cookie is `{pixiv userId}_{secret}`; an anonymous one has no
            # user part, and Fanbox may still answer it with an empty plan list.
            if SIGNED_IN.match(sessid) and sessid not in tried:
                tried.add(sessid)
                session = self.accept(sessid)
                if session.get("state") == "valid":
                    plans = session.get("supporting", 0)
                    return {"state": "done", "message": f"Signed in; supporting {plans} plans."}
                if session.get("state") == "unchecked":
                    return {"state": "done", "message": session.get("message", "")}
            self._cancel.wait(POLL_SECONDS)
        return {"state": "failed", "message": "Cancelled."}
