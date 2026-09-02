import threading
import time
from collections import deque

from .naming import human_size

_SPEED_WINDOW = 5.0  # seconds of byte deltas kept for the throughput estimate


class Notifier:
    """Download progress; `on_download_progress` is the only hook the downloader
    ever calls, and `enabled=False` makes the whole thing a no-op.

    Files download concurrently, so progress is tracked per file and the size is
    printed on the first callback (there is no separate "started" event). The
    printed lines are the plain fallback; an interactive shell additionally reads
    `snapshot()` to render a live status bar off the same state.
    """

    def __init__(self, enabled: bool = False):
        self.enabled = enabled
        self._files: dict = {}    # filename -> [downloaded, total, last printed %]
        self._deltas: deque = deque()  # (timestamp, byte delta)
        self._lock = threading.Lock()

    def on_download_progress(self, filename: str, downloaded: int, total_size: int):
        if not self.enabled or total_size <= 0:
            return
        percent = int(downloaded / total_size * 100)
        now = time.monotonic()
        with self._lock:
            state = self._files.get(filename)
            announce = state is None
            if announce:
                state = self._files[filename] = [0, total_size, -1]
            self._deltas.append((now, downloaded - state[0]))
            while self._deltas and self._deltas[0][0] < now - _SPEED_WINDOW:
                self._deltas.popleft()
            state[0] = downloaded

            report = percent >= state[2] + 25
            if report:
                state[2] = percent
            if downloaded >= total_size:
                del self._files[filename]

        if announce:
            print(f"    v {filename} ({human_size(total_size)})")
        if report:
            print(f"      {filename} - {percent}%")

    def snapshot(self) -> dict:
        """Current files and rolling throughput, for a live status display."""
        with self._lock:
            now = time.monotonic()
            while self._deltas and self._deltas[0][0] < now - _SPEED_WINDOW:
                self._deltas.popleft()
            speed = sum(d for _, d in self._deltas) / _SPEED_WINDOW
            files = [(name, int(got / total * 100))
                     for name, (got, total, _) in self._files.items()]
        return {'files': files, 'speed': speed}
