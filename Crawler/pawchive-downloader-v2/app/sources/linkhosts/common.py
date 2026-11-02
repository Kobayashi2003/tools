"""What the link hosts share: a session, and saving a response to a file."""

import os
import re
from collections.abc import Callable, Iterator
from pathlib import Path
from urllib.parse import unquote

import requests

from ...domain.naming import sanitize_component
from ..http import Cancelled

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)
TIMEOUT = 60
CHUNK = 1 << 20


def session() -> requests.Session:
    """A plain session: system proxy from the environment, a browser's user agent."""
    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    return s


def filename_of(resp: requests.Response, fallback: str) -> str:
    """The name a response asks to be saved under (RFC 6266), safe for Windows."""
    cd = resp.headers.get("content-disposition", "")
    m = re.search(r"filename\*\s*=\s*[^']*'[^']*'([^;]+)", cd)
    name = unquote(m.group(1).strip()) if m else ""
    if not name:
        m = re.search(r'filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)', cd)
        name = (m.group(1) or m.group(2) or "").strip() if m else ""
        # Many servers send UTF-8 bytes that requests decoded as Latin-1.
        try:
            name = name.encode("latin-1").decode("utf-8")
        except UnicodeError:
            pass
    return sanitize_component(name or fallback)


def done_already(target: Path, size: int | None) -> bool:
    return bool(size) and target.is_file() and target.stat().st_size == size


def save(
    chunks: Iterator[bytes],
    target: Path,
    stopped: Callable[[], bool],
    progress: Callable[[str], None],
    size: int | None = None,
) -> Path:
    """Write `chunks` to `target` through a temporary file, so a cancelled or broken
    transfer never leaves a short file under the real name."""
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(f".{target.name}.part")
    written = 0
    try:
        with open(temp, "wb") as f:
            for chunk in chunks:
                if stopped():
                    raise Cancelled()
                f.write(chunk)
                written += len(chunk)
                if size:
                    progress(f"{target.name}: {written * 100 // size}%")
        if size and written != size:
            raise OSError(f"{target.name}: got {written} of {size} bytes")
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
    return target
