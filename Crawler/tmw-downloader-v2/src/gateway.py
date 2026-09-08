"""The websocket half of a Discord client, kept for two things it alone can do.

A recommendation carries no link. It carries a button, and the bot answers a
press with an *ephemeral* message -- one that exists only for the account that
pressed and is never in the channel's history. There is no REST call that
returns it: the press is a POST that answers `204`, and the reply arrives on the
gateway. So a connection is held open, a press is matched to its answer by the
nonce both carry, and the caller gets back what the bot said.

The same connection answers the other question the REST API refuses: who a
mention belongs to. The bot posts recommenders as `<@id>` with pings suppressed,
so Discord sends the message with an empty `mentions` array, and `/users/{id}`
is 401 for an account token. Asking the gateway for the members is how the
client itself does it.

One connection, made when something first needs it, kept alive by its heartbeat
and rebuilt if it drops.
"""

import json
import random
import threading
import time
from typing import Dict, List, Optional
from urllib.parse import urlparse

import websocket

from .config import GATEWAY, USER_AGENT
from .models import DISCORD_EPOCH_MS

# Discord closes a connection that misses its heartbeat; these are the codes
# that mean "do not bother trying again with this token".
FATAL_CLOSE = {4004, 4010, 4011, 4012, 4013, 4014}


class GatewayError(RuntimeError):
    """The connection could not be made, or the bot never answered."""


def _nonce() -> str:
    """A snowflake-shaped id. Discord echoes it back on the reply, which is the
    only thing tying an ephemeral message to the press that caused it."""
    ms = int(time.time() * 1000) - DISCORD_EPOCH_MS
    return str((ms << 22) | random.getrandbits(12))


class Gateway:
    def __init__(self, config):
        self.config = config
        self.lock = threading.RLock()
        self.ready = threading.Event()
        self.session_id: str = ""
        self.user: dict = {}
        self.error: str = ""

        self._ws: Optional[websocket.WebSocketApp] = None
        self._thread: Optional[threading.Thread] = None
        self._beat: Optional[threading.Thread] = None
        self._closing = False
        self._seq: Optional[int] = None
        # nonce -> {"event": Event, "reply": dict, "error": str}
        self._waiting: Dict[str, dict] = {}
        # Presses are paced against the wall clock, not against each other, so
        # two tabs asking at once still queue politely.
        self._last_press = 0.0

    # -- connection -------------------------------------------------------

    @property
    def live(self) -> bool:
        return self.ready.is_set() and self._thread is not None and self._thread.is_alive()

    def ensure(self, timeout: float = 30.0) -> None:
        """Connect and identify, unless that has already happened.

        Tried more than once. A websocket to Discord is a single TCP connection
        over a long distance and it does fail to come up -- and when it does,
        the download it was for stops with a socket error that reads as though
        the *file* could not be fetched. A few seconds of patience here is worth
        far more than an accurate error message about the wrong thing.
        """
        attempts = max(1, self.config.retry)
        why = ""
        for attempt in range(1, attempts + 1):
            with self.lock:
                if self.live:
                    return
                if self._thread is None or not self._thread.is_alive():
                    self.ready.clear()
                    self.error = ""
                    self._closing = False
                    self._thread = threading.Thread(target=self._run, daemon=True,
                                                    name="gateway")
                    self._thread.start()
            if self.ready.wait(timeout):
                return

            why = self.error or "it did not answer in time"
            # A refused token will be refused again; only a connection is worth
            # a second try.
            if "not valid for the gateway" in why:
                break
            self.close()
            self._closing = False
            with self.lock:
                self._thread = None
            if attempt < attempts:
                time.sleep(min(2 ** attempt, 15))
        raise GatewayError(f"could not reach Discord's gateway: {why}")

    def _identify(self) -> dict:
        return {
            "op": 2,
            "d": {
                "token": self.config.token,
                "capabilities": 161789,
                "properties": {
                    "os": "Windows", "browser": "Chrome", "device": "",
                    "system_locale": "en-US", "browser_user_agent": USER_AGENT,
                    "browser_version": "131.0.0.0", "os_version": "10",
                    "referrer": "", "referring_domain": "",
                    "referrer_current": "", "referring_domain_current": "",
                    "release_channel": "stable", "client_build_number": 361274,
                    "client_event_source": None,
                },
                "presence": {"status": "unknown", "since": 0,
                             "activities": [], "afk": False},
                "compress": False,
                "client_state": {"guild_versions": {}},
            },
        }

    def _proxy_args(self) -> dict:
        """How to reach Discord, in the terms this client understands.

        It has to be told. `requests` finds `HTTPS_PROXY` -- and the Windows
        system setting -- on its own, so behind a tunnel every REST call and
        every download works without a word from us, while this one connection
        goes direct and times out. The archive then loads perfectly and only the
        download button fails, which points the blame at exactly the wrong end.
        """
        url = self.config.proxy_url
        if not url:
            return {}
        proxy = urlparse(url)
        # http, socks5, socks5h -- the last two need `python-socks` installed,
        # and say so plainly if it is not.
        scheme = (proxy.scheme or "http").lower()
        args = {"http_proxy_host": proxy.hostname,
                "http_proxy_port": proxy.port,
                "proxy_type": "http" if scheme in ("http", "https") else scheme}
        if proxy.username:
            args["http_proxy_auth"] = (proxy.username, proxy.password or "")
        if self.config.no_proxy:
            args["http_no_proxy"] = [h.strip() for h in self.config.no_proxy.split(",")
                                     if h.strip()]
        return args

    def _run(self) -> None:
        kwargs = self._proxy_args()
        self._ws = websocket.WebSocketApp(
            GATEWAY,
            on_message=self._on_message,
            on_error=self._on_error,
            on_close=self._on_close,
        )
        try:
            self._ws.run_forever(**kwargs)
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            self.ready.clear()
            # Nobody is left to answer: release whoever was waiting rather than
            # leave them to time out one by one.
            self._fail_waiting("the connection to Discord dropped")

    def _send(self, payload: dict) -> None:
        ws = self._ws
        if ws is None:
            raise GatewayError("not connected")
        ws.send(json.dumps(payload))

    def _heartbeat(self, every: float) -> None:
        while not self._closing:
            # Jittered on the first beat the way a client does, so a restart
            # loop does not land every beat on the same instant.
            time.sleep(every)
            try:
                self._send({"op": 1, "d": self._seq})
            except Exception:
                return

    def _on_error(self, _ws, exc) -> None:
        self.error = f"{type(exc).__name__}: {exc}"

    def _on_close(self, _ws, code, _reason) -> None:
        self.ready.clear()
        if code in FATAL_CLOSE:
            self.error = (f"Discord closed the connection ({code}); the token is "
                          f"not valid for the gateway")

    def _on_message(self, _ws, raw) -> None:
        try:
            packet = json.loads(raw)
        except ValueError:
            return
        op, kind, data = packet.get("op"), packet.get("t"), packet.get("d")
        if packet.get("s") is not None:
            self._seq = packet["s"]

        if op == 10:
            every = (data or {}).get("heartbeat_interval", 41250) / 1000
            self._beat = threading.Thread(target=self._heartbeat, args=(every,),
                                          daemon=True, name="gateway-beat")
            self._beat.start()
            self._send(self._identify())
            return
        if op == 9:                      # invalid session: nothing to resume
            self.error = "Discord rejected the session"
            self.ready.clear()
            return
        if op != 0:
            return

        if kind == "READY":
            self.session_id = (data or {}).get("session_id", "")
            self.user = (data or {}).get("user", {}) or {}
            self.ready.set()
            return
        if kind == "MESSAGE_CREATE":
            self._deliver((data or {}).get("nonce"), data)
            return
        if kind == "INTERACTION_FAILURE":
            self._fail((data or {}).get("nonce"),
                       "the bot refused the press")
            return
        if kind == "GUILD_MEMBERS_CHUNK":
            self._deliver((data or {}).get("nonce"), data)
            return

    # -- waiting for one reply --------------------------------------------

    def _slot(self, nonce: str) -> dict:
        slot = {"event": threading.Event(), "reply": None, "error": ""}
        with self.lock:
            self._waiting[nonce] = slot
        return slot

    def _deliver(self, nonce, data) -> None:
        if not nonce:
            return
        with self.lock:
            slot = self._waiting.get(str(nonce))
        if slot is None:
            return
        # A member chunk can arrive in several parts; keep the first and let
        # the waiter decide, rather than dropping what came after it.
        if slot["reply"] is None:
            slot["reply"] = data
            slot["event"].set()

    def _fail(self, nonce, why: str) -> None:
        if not nonce:
            return
        with self.lock:
            slot = self._waiting.get(str(nonce))
        if slot is not None and slot["reply"] is None:
            slot["error"] = why
            slot["event"].set()

    def _fail_waiting(self, why: str) -> None:
        with self.lock:
            slots = list(self._waiting.values())
        for slot in slots:
            if slot["reply"] is None:
                slot["error"] = why
                slot["event"].set()

    def _forget(self, nonce: str) -> None:
        with self.lock:
            self._waiting.pop(nonce, None)

    # -- the two things this exists for -----------------------------------

    def press(self, client, guild_id: str, channel_id: str, message_id: str,
              custom_id: str, application_id: str) -> dict:
        """Press a button on a message and return what the bot says back.

        `client` is the REST side: the press itself is an ordinary authenticated
        POST, and only the answer comes down the socket.
        """
        if not custom_id:
            raise GatewayError("this post has no button on it")
        self.ensure()

        # Pace them. A burst of presses is the one thing here that looks like a
        # script rather than a reader, and the bot is doing real work for each.
        with self.lock:
            wait = self.config.press_pause - (time.time() - self._last_press)
            if wait > 0:
                time.sleep(wait)
            self._last_press = time.time()

        nonce = _nonce()
        slot = self._slot(nonce)
        try:
            client.interact({
                "type": 3,
                "nonce": nonce,
                "guild_id": str(guild_id),
                "channel_id": str(channel_id),
                "message_flags": 0,
                "message_id": str(message_id),
                "application_id": str(application_id),
                "session_id": self.session_id,
                "data": {"component_type": 2, "custom_id": custom_id},
            })
            if not slot["event"].wait(self.config.press_wait):
                raise GatewayError(
                    f"the bot did not answer within {self.config.press_wait:.0f}s")
            if slot["error"]:
                raise GatewayError(slot["error"])
            return slot["reply"] or {}
        finally:
            self._forget(nonce)

    def members(self, guild_id: str, user_ids: List[str],
                timeout: float = 15.0) -> Dict[str, str]:
        """Resolve user ids to display names, {id: name}.

        `/users/{id}` answers 401 to an account token, so this is the way a
        client does it: ask the guild over the socket and read the chunk.
        Discord takes at most 100 ids per request.
        """
        wanted = [str(u) for u in dict.fromkeys(user_ids) if str(u).isdigit()]
        if not wanted:
            return {}
        self.ensure()
        found: Dict[str, str] = {}
        for start in range(0, len(wanted), 100):
            batch = wanted[start:start + 100]
            nonce = _nonce()[:24]     # Discord rejects a nonce over 32 chars
            slot = self._slot(nonce)
            try:
                self._send({"op": 8, "d": {"guild_id": str(guild_id),
                                           "user_ids": batch,
                                           "nonce": nonce}})
                if not slot["event"].wait(timeout):
                    continue
                for member in (slot["reply"] or {}).get("members") or []:
                    user = member.get("user") or {}
                    name = (member.get("nick") or user.get("global_name")
                            or user.get("username") or "")
                    if user.get("id") and name:
                        found[str(user["id"])] = name
            finally:
                self._forget(nonce)
        return found

    def close(self) -> None:
        self._closing = True
        self.ready.clear()
        ws = self._ws
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass
