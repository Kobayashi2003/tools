"""Re-signed attachment URLs, kept apart from the raw messages.

Folding fresh signatures back into the message cache meant rewriting 18 MB to
change a few query strings -- a second per screenful of scrolling -- and it
quietly made the "raw" cache not raw. Signatures live here instead: small,
derived, and safe to lose.

Entries are dropped once expired, so the file stays roughly the size of what is
still usable rather than growing with everything ever signed.
"""

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Dict, Optional

from .models import expiry_of

# Signing happens per screenful; writing on each one would trade a big stall for
# a great many small ones. Batched, with a final write on the way out.
WRITE_EVERY = 5.0


class LinkStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.urls: Dict[str, str] = {}
        self._dirty = False
        self._saved_at = 0.0
        self.load()

    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return
        now = time.time()
        for key, url in (data.get("urls") or {}).items():
            moment = expiry_of(url)
            if moment is None or moment.timestamp() > now:
                self.urls[key] = url

    def get(self, attachment_id: str, fallback: str) -> str:
        return self.urls.get(str(attachment_id), fallback)

    def put(self, attachment_id: str, url: str) -> None:
        key = str(attachment_id)
        if self.urls.get(key) != url:
            self.urls[key] = url
            self._dirty = True

    def save(self, force: bool = False) -> None:
        if not self._dirty:
            return
        if not force and time.time() - self._saved_at < WRITE_EVERY:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle, temp = tempfile.mkstemp(dir=str(self.path.parent), suffix=".tmp")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as file:
                json.dump({"version": 1, "urls": self.urls}, file)
            os.replace(temp, self.path)
        except BaseException:
            Path(temp).unlink(missing_ok=True)
            raise
        self._dirty = False
        self._saved_at = time.time()

    def __len__(self) -> int:
        return len(self.urls)
