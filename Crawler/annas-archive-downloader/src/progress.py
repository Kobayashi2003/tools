"""Live multi-line progress: one bar per file, redrawn in place.

Printing a fresh line per tick buries everything else — a handful of concurrent
downloads emit thousands of lines and the actual results scroll away. Here each
active file owns one line that is rewritten as it advances, and a finished file
prints one permanent line and gives its slot back.

Falls back to a single completion line per file when stdout is not a terminal,
so piping to a log stays readable.

NOTE: kept byte-identical with novelia-downloader/src/progress.py. The two
projects share no package, so this and `selector.py` are duplicated on purpose;
`diff` the pairs after touching either — fixing one copy and forgetting the
other is how `disambiguate` ended up correct in one project and wrong in the
other.
"""

import shutil
import sys
import threading
import time

_BLOCKS = "▏▎▍▌▋▊▉█"


def human(size: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(size) < 1024 or unit == "GB":
            return f"{size:.0f}{unit}" if unit == "B" else f"{size:.1f}{unit}"
        size /= 1024.0
    return f"{size:.1f}GB"


def _bar(fraction: float, width: int = 22) -> str:
    fraction = max(0.0, min(1.0, fraction))
    filled = fraction * width
    whole = int(filled)
    out = "█" * whole
    if whole < width:
        part = int((filled - whole) * len(_BLOCKS))
        out += _BLOCKS[part] if part else " "
        out = out.ljust(width)
    return out


class Board:
    """Tracks in-flight downloads and repaints them as a block."""

    def __init__(self, stream=None, min_interval: float = 0.2):
        self.stream = stream or sys.stdout
        self.lock = threading.RLock()
        self.rows = {}          # key -> [label, done, total]
        self.order = []
        self.painted = 0
        self.min_interval = min_interval
        self._last_paint = 0.0
        try:
            self.live = self.stream.isatty()
        except Exception:
            self.live = False

    # ---- public ----

    def start(self, key, label: str, total: int = 0) -> None:
        with self.lock:
            self.rows[key] = [label, 0, total]
            if key not in self.order:
                self.order.append(key)
            self._paint(force=True)

    def update(self, key, done: int, total: int = 0) -> None:
        with self.lock:
            row = self.rows.get(key)
            if row is None:
                return
            row[1] = done
            if total:
                row[2] = total
            self._paint()

    def finish(self, key, message: str) -> None:
        """Retire the row and leave `message` behind permanently."""
        with self.lock:
            self.rows.pop(key, None)
            if key in self.order:
                self.order.remove(key)
            self._clear()
            self.stream.write(message.rstrip("\n") + "\n")
            self.stream.flush()
            self._paint(force=True)

    def write(self, message: str) -> None:
        """Print something that must not be overwritten by the bars."""
        with self.lock:
            self._clear()
            self.stream.write(message.rstrip("\n") + "\n")
            self.stream.flush()
            self._paint(force=True)

    def close(self) -> None:
        with self.lock:
            self._clear()
            self.rows.clear()
            self.order.clear()

    # ---- painting ----

    def _clear(self) -> None:
        if not self.live or not self.painted:
            self.painted = 0
            return
        # Up one line at a time, wiping each, so nothing above is disturbed.
        self.stream.write("\x1b[1A\x1b[2K" * self.painted + "\r")
        self.stream.flush()
        self.painted = 0

    def _paint(self, force: bool = False) -> None:
        if not self.live:
            return
        now = time.time()
        if not force and now - self._last_paint < self.min_interval:
            return
        self._last_paint = now
        self._clear()
        width = shutil.get_terminal_size((100, 24)).columns
        for key in self.order:
            label, done, total = self.rows[key]
            self.stream.write(self._line(label, done, total, width) + "\n")
        self.painted = len(self.order)
        self.stream.flush()

    def _line(self, label: str, done: int, total: int, width: int) -> str:
        if total:
            pct = done / total
            meter = f"{_bar(pct)} {pct * 100:3.0f}%  {human(done)}/{human(total)}"
        else:
            # Length unknown: show what has arrived rather than a fake fraction.
            meter = f"{' ' * 22}   ??  {human(done)}"
        room = max(10, width - len(meter) - 6)
        if len(label) > room:
            label = label[:room - 1] + "…"
        return f"  {meter}  {label}"
