"""MEGA links: shared files and folders, through MEGA's public API.

Everything on MEGA is encrypted; the key travels in the link after `#` and never reaches
MEGA. A file key is 256 bits: XORed halves give the AES-128 key, and its third quarter is
the CTR nonce. A folder key decrypts each node's own key (AES-ECB); names live in an
attribute block encrypted AES-CBC with a zero IV, as `MEGA{"n": name}`.

  https://mega.nz/file/<handle>#<key>          https://mega.nz/#!<handle>!<key>
  https://mega.nz/folder/<handle>#<key>        https://mega.nz/#F!<handle>!<key>
  …/folder/<handle>#<key>/file/<node>  (one file of a folder; /folder/<node>: a sub-folder)
"""

import base64
import json
import re
import struct
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from itertools import count
from pathlib import Path
from urllib.parse import urlparse

import requests
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from ...domain.links import LinkCheck, LinkError
from ...domain.naming import sanitize_component
from .common import CHUNK, TIMEOUT, done_already, save, session

API = "https://g.api.mega.co.nz/cs"
HOSTS = ("mega.nz", "mega.co.nz", "mega.io")
# API error codes worth a word; any other negative number is shown as it is.
ERRORS = {
    -2: "bad link",
    -3: "MEGA is busy, try again",
    -6: "too many requests, try again later",
    -9: "not found (deleted, or the link was changed)",
    -11: "access denied",
    -16: "taken down or the account is suspended",
    -17: "transfer quota exceeded",
    -18: "temporarily unavailable",
}
# Codes that say nothing about the link itself.
TRANSIENT = {-3, -6, -17, -18}
# A key in base64url: 16 bytes for a folder, 32 for a file.
KEY_LENGTH = {"folder": 22, "file": 43}
_BARE_KEY = re.compile(
    r"(?<![A-Za-z0-9_/.=?&-])#?([A-Za-z0-9_-]{22}(?:[A-Za-z0-9_-]{21})?)(?![A-Za-z0-9_-])"
)
KEY_CLASSES = (r"[a-z]", r"[A-Z]", r"[0-9]")


@dataclass(frozen=True)
class MegaLink:
    kind: str
    """file | folder"""
    handle: str
    key: str | None
    """base64url key from the link; None when the link was posted without it."""
    node: tuple[str, str] | None = None
    """('file' | 'folder', node handle) inside a folder link."""


def parse(url: str) -> MegaLink | None:
    u = urlparse(url)
    if u.netloc.lower().removeprefix("www.") not in HOSTS:
        return None
    path, frag = u.path, u.fragment
    if frag.startswith(("!", "F!")):  # the legacy form keeps everything after '#'
        folder = frag.startswith("F!")
        parts = frag[2 if folder else 1 :].split("!")
        node = ("folder", parts[2]) if folder and len(parts) > 2 and parts[2] else None
        return MegaLink(
            "folder" if folder else "file",
            parts[0],
            parts[1] if len(parts) > 1 and parts[1] else None,
            node,
        )
    m = re.match(r"^/(file|folder)/([A-Za-z0-9_-]+)", path)
    if not m:
        return None
    key, _, rest = frag.partition("/")
    node = None
    if sub := re.match(r"^(file|folder)/([A-Za-z0-9_-]+)", rest):
        node = (sub.group(1), sub.group(2))
    return MegaLink(m.group(1), m.group(2), key or None, node)


# ---------------------------------------------------------------- crypto


def b64(text: str) -> bytes:
    text = text.replace("-", "+").replace("_", "/").replace(",", "")
    return base64.b64decode(text + "=" * (-len(text) % 4))


def a32(data: bytes) -> tuple[int, ...]:
    data += b"\0" * (-len(data) % 4)
    return struct.unpack(f">{len(data) // 4}I", data)


def file_key(raw: bytes) -> tuple[bytes, bytes]:
    """(AES key, CTR nonce) from a 256-bit file key."""
    k = a32(raw)
    if len(k) < 8:
        raise LinkError("the key in the link is too short")
    key = struct.pack(">4I", k[0] ^ k[4], k[1] ^ k[5], k[2] ^ k[6], k[3] ^ k[7])
    return key, struct.pack(">2I", k[4], k[5])


def ecb_decrypt(key: bytes, data: bytes) -> bytes:
    d = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    return d.update(data) + d.finalize()


def attributes(at: str, key: bytes) -> dict:
    """A node's attribute block (its name lives under "n")."""
    data = b64(at)
    data += b"\0" * (-len(data) % 16)
    d = Cipher(algorithms.AES(key), modes.CBC(b"\0" * 16)).decryptor()
    text = (d.update(data) + d.finalize()).rstrip(b"\0")
    if not text.startswith(b"MEGA{"):
        raise LinkError("the key in the link does not open it")
    return json.loads(text[4:].decode("utf-8", "replace"))


def decrypting(chunks: Iterator[bytes], key: bytes, nonce: bytes) -> Iterator[bytes]:
    d = Cipher(algorithms.AES(key), modes.CTR(nonce + b"\0" * 8)).decryptor()
    for chunk in chunks:
        yield d.update(chunk)
    yield d.finalize()


def _open_node(n: dict, folder_key: bytes) -> tuple[bytes, bytes, str] | None:
    """(key, nonce, name) of a listed node. Its `k` may hold several `owner:key` parts (the
    owner's own, the share's); the one the folder key opens is the share's."""
    for part in str(n["k"]).split("/"):
        if ":" not in part:
            continue
        try:
            raw = ecb_decrypt(folder_key, b64(part.split(":", 1)[1]))
            key, nonce = file_key(raw) if n["t"] == 0 else (raw[:16], b"")
            return key, nonce, attributes(n["a"], key).get("n") or n["h"]
        except LinkError, ValueError:
            continue
    return None


@dataclass
class Node:
    handle: str
    parent: str
    is_folder: bool
    name: str
    size: int
    key: bytes
    nonce: bytes


class Mega:
    name = "MEGA"

    def __init__(self, http: requests.Session | None = None):
        self.http = http or session()
        self._seq = count(1)

    def handles(self, url: str) -> bool:
        return parse(url) is not None

    # ---- keys ----

    def needs_key(self, url: str) -> bool:
        link = parse(url)
        return link is not None and not link.key

    def with_key(self, url: str, key: str) -> str:
        link = parse(url)
        if link is None:
            return url
        node = f"/{link.node[0]}/{link.node[1]}" if link.node else ""
        return f"https://mega.nz/{link.kind}/{link.handle}#{key.strip().lstrip('#!')}{node}"

    def key_candidates(self, url: str, text: str) -> list[str]:
        """The same link written with its key elsewhere in `text` first (Pawchive's HTML
        often links the bare address and shows the full one), then strings shaped like a key
        of the right length that follow the link."""
        link = parse(url)
        if link is None or not text:
            return []
        length = KEY_LENGTH[link.kind]
        found: list[str] = []
        for m in re.finditer(re.escape(link.handle) + r"[#!]([A-Za-z0-9_-]{22,43})", text):
            found.append(m.group(1))
        start = text.find(link.handle)
        for m in _BARE_KEY.finditer(text[start if start >= 0 else 0 :]):
            token = m.group(1)
            # A key is random: it mixes cases or digits; a plain word of that length is not one.
            if (
                len(token) == length
                and sum(map(bool, (re.search(p, token) for p in KEY_CLASSES))) >= 2
            ):
                found.append(token)
        return [k for k in dict.fromkeys(found) if len(k) == length]

    def key_works(self, url: str) -> bool:
        link = parse(url)
        if link is None or not link.key:
            return False
        try:
            if link.kind == "file":
                key, _ = file_key(b64(link.key))
                attributes(self._api({"a": "g", "p": link.handle}).get("at", ""), key)
            else:
                self._nodes(link)
            return True
        except LinkError, MegaError, ValueError, requests.RequestException:
            return False

    def _api(self, request: dict, folder: str | None = None) -> dict:
        params: dict[str, str | int] = {"id": next(self._seq)}
        if folder:
            params["n"] = folder
        resp = self.http.post(API, params=params, json=[request], timeout=TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        result = data[0] if isinstance(data, list) else data
        if isinstance(result, int) and result < 0:
            raise MegaError(result)
        if not isinstance(result, dict):
            raise LinkError(f"MEGA answered {data!r}")
        return result

    # ---- folders ----

    def _nodes(self, link: MegaLink) -> list[Node]:
        if not link.key:
            raise LinkError("the link has no key (it may be posted separately in the text)")
        folder_key = b64(link.key)
        if len(folder_key) != 16:
            raise LinkError("the key in the link is not a folder key")
        listing = self._api({"a": "f", "c": 1, "r": 1, "ca": 1}, folder=link.handle)
        nodes = []
        for n in listing.get("f", []):
            if n.get("t") not in (0, 1) or ":" not in str(n.get("k", "")):
                continue
            opened = _open_node(n, folder_key)
            if opened is None:
                continue
            key, nonce, name = opened
            nodes.append(
                Node(n["h"], n.get("p", ""), n["t"] == 1, name, int(n.get("s") or 0), key, nonce)
            )
        if not nodes:
            if listing.get("f"):
                raise LinkError("the key in the link does not open it")
            raise LinkError("the folder is empty")
        return nodes

    @staticmethod
    def _paths(nodes: list[Node], root: str | None) -> list[tuple[Node, Path]]:
        """Each file under `root` (the whole tree when None), with its path from there."""
        by_handle = {n.handle: n for n in nodes}
        top = root or next((n.handle for n in nodes if n.parent not in by_handle), None)
        out = []
        for n in nodes:
            if n.is_folder:
                continue
            parts, p = [], n.parent
            while p in by_handle and p != top:
                parts.append(sanitize_component(by_handle[p].name))
                p = by_handle[p].parent
            if p != top and n.handle != root:
                continue
            base = Path(sanitize_component(by_handle[top].name)) if top in by_handle else Path()
            out.append((n, base.joinpath(*reversed(parts)) / sanitize_component(n.name)))
        return out

    def _selected(self, link: MegaLink, nodes: list[Node]) -> list[tuple[Node, Path]]:
        if link.node is None:
            return self._paths(nodes, None)
        kind, handle = link.node
        if kind == "file":
            node = next((n for n in nodes if n.handle == handle), None)
            if node is None:
                raise LinkError("the file is not in the folder any more")
            return [(node, Path(sanitize_component(node.name)))]
        picked = self._paths(nodes, handle)
        if not picked:
            raise LinkError("the sub-folder is empty or gone")
        return picked

    # ---- check ----

    def check(self, url: str) -> LinkCheck:
        link = parse(url)
        if link is None:
            return LinkCheck("unknown", "not a MEGA link")
        try:
            if link.kind == "file":
                info = self._api({"a": "g", "p": link.handle, "ssm": 1})
                if not link.key:
                    return LinkCheck("alive", f"{_size(info.get('s'))}; no key in the link")
                key, _ = file_key(b64(link.key))
                name = attributes(info.get("at", ""), key).get("n", "")
                return LinkCheck("alive", f"{name} ({_size(info.get('s'))})")
            if not link.key:
                self._api({"a": "f", "c": 1, "r": 1, "ca": 1}, folder=link.handle)
                return LinkCheck("alive", "folder; no key in the link")
            files = self._selected(link, self._nodes(link))
            return LinkCheck("alive", f"{len(files)} files, {_size(sum(n.size for n, _ in files))}")
        except MegaError as e:
            return LinkCheck("unknown" if e.code in TRANSIENT else "dead", str(e))
        except LinkError as e:
            return LinkCheck("dead" if "empty" in str(e) or "gone" in str(e) else "unknown", str(e))
        except requests.RequestException as e:
            return LinkCheck("unknown", f"network: {e}")

    # ---- fetch ----

    def fetch(
        self,
        url: str,
        folder: Path,
        progress: Callable[[str], None],
        stopped: Callable[[], bool],
    ) -> list[Path]:
        link = parse(url)
        if link is None:
            raise LinkError("not a MEGA link")
        try:
            if link.kind == "file":
                if not link.key:
                    raise LinkError("the link has no key (it may be posted separately in the text)")
                key, nonce = file_key(b64(link.key))
                info = self._api({"a": "g", "g": 1, "p": link.handle, "ssl": 1})
                name = attributes(info.get("at", ""), key).get("n") or link.handle
                target = folder / sanitize_component(name)
                return [self._download(info, target, key, nonce, progress, stopped)]
            saved = []
            for node, rel in self._selected(link, self._nodes(link)):
                info = self._api({"a": "g", "g": 1, "n": node.handle, "ssl": 1}, folder=link.handle)
                saved.append(
                    self._download(info, folder / rel, node.key, node.nonce, progress, stopped)
                )
            return saved
        except MegaError as e:
            raise LinkError(str(e)) from None

    def _download(
        self,
        info: dict,
        target: Path,
        key: bytes,
        nonce: bytes,
        progress: Callable[[str], None],
        stopped: Callable[[], bool],
    ) -> Path:
        size = int(info.get("s") or 0) or None
        if done_already(target, size):
            return target
        if "g" not in info:
            raise LinkError(f"{target.name}: MEGA gave no download address")
        resp = self.http.get(info["g"], stream=True, timeout=TIMEOUT)
        if resp.status_code == 509:
            raise LinkError("MEGA transfer quota exceeded; try again later")
        resp.raise_for_status()
        progress(f"MEGA: {target.name}")
        return save(
            decrypting(resp.iter_content(CHUNK), key, nonce), target, stopped, progress, size
        )


class MegaError(Exception):
    def __init__(self, code: int):
        self.code = code
        super().__init__(ERRORS.get(code, f"MEGA error {code}"))


def _size(n: object) -> str:
    size = float(n) if isinstance(n, int | float | str) and str(n).isdigit() else 0.0
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"
