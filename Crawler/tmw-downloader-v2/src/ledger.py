"""What has actually landed on disk, job by job.

The tick beside a recommendation says "I have this one". That claim is only
worth anything if it can be checked, so what is recorded is not a flag but the
files themselves -- where they went, how big they were, and when. It is what
lets the page say *where* a book is rather than only that it was fetched once,
and what makes a second run skip a file already on disk instead of asking the
bot for another claim.

Kept beside the downloads rather than in the state file: it describes a folder,
and moving the folder should move its record with it.
"""

import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional


class Ledger:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.lock = threading.RLock()
        self.jobs: Dict[str, dict] = {}
        self.load()

    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return
        self.jobs = {str(k): v for k, v in (data.get("jobs") or {}).items()}

    def save(self) -> None:
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            handle, temp = tempfile.mkstemp(dir=str(self.path.parent), suffix=".tmp")
            try:
                with os.fdopen(handle, "w", encoding="utf-8") as file:
                    json.dump({"version": 1, "jobs": self.jobs}, file,
                              ensure_ascii=False, indent=1)
                os.replace(temp, self.path)
            except BaseException:
                Path(temp).unlink(missing_ok=True)
                raise

    def record(self, job: str, title: str, folder: Path, files: List[dict]) -> None:
        """Note what a job left on disk. Repeats merge rather than replace: a
        job fetched in two goes is still one job."""
        with self.lock:
            entry = self.jobs.setdefault(str(job), {
                "title": title, "dir": str(folder),
                "at": datetime.now(timezone.utc).isoformat(), "files": [],
            })
            entry["title"] = title or entry.get("title", "")
            entry["dir"] = str(folder)
            entry["at"] = datetime.now(timezone.utc).isoformat()
            by_name = {f.get("name"): f for f in entry.get("files") or []}
            for file in files:
                by_name[file.get("name")] = file
            entry["files"] = sorted(by_name.values(), key=lambda f: f.get("name") or "")
            self.save()

    def get(self, job: str) -> Optional[dict]:
        return self.jobs.get(str(job))

    def held(self, job: str) -> bool:
        """Whether every file recorded for this job is still where it was."""
        entry = self.get(job)
        if not entry or not entry.get("files"):
            return False
        return all(Path(f.get("path") or "").exists() for f in entry["files"])

    def __contains__(self, job) -> bool:
        return str(job) in self.jobs
