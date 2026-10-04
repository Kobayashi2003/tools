import json
import shutil
import tempfile
from pathlib import Path


PATH_COLUMNS = ("raw_path", "ja_path", "reference_path")


class Storage:
    def __init__(self, db, worker):
        self.db, self.worker = db, worker

    def roots(self):
        return [self.worker.root, *map(Path, self.db.setting("previous_download_roots", []))]

    def safe_path(self, value):
        path = Path(value).resolve()
        if not any(path.is_relative_to(root.resolve()) and path != root.resolve() for root in self.roots()):
            raise ValueError("A recorded file is outside the managed download directories.")
        return path

    def remove(self, keys, delete_files=False):
        keys = list(dict.fromkeys(keys))
        if not keys:
            return {"removed": 0}
        marks = ",".join("?" for _ in keys)
        records = self.db.rows(f"SELECT * FROM files WHERE work_key IN ({marks})", keys)
        paths = {self.safe_path(row[col]) for row in records for col in PATH_COLUMNS if row[col]} if delete_files else set()
        for path in paths:
            if path.is_file():
                path.unlink(missing_ok=True)
        with self.db.connect() as conn:
            conn.execute(f"DELETE FROM files WHERE work_key IN ({marks})", keys)
            count = conn.execute(f"DELETE FROM works WHERE key IN ({marks})", keys).rowcount
        return {"removed": count}

    def missing(self):
        keys = []
        for work in self.db.rows("SELECT key,title FROM works ORDER BY title"):
            records = self.db.rows("SELECT * FROM files WHERE work_key=?", (work["key"],))
            if records and not any(row[col] and Path(row[col]).is_file()
                                   for row in records for col in ("raw_path", "ja_path")):
                keys.append(work)
        return keys

    def change_directory(self, value, migrate):
        target = Path(value).expanduser()
        if not target.is_absolute():
            raise ValueError("Enter an absolute download directory.")
        target = target.resolve()
        old = self.worker.root
        if target == old:
            return {"download_root": str(old), "migrated": 0, "warnings": []}
        if any(target != r.resolve() and (target.is_relative_to(r.resolve()) or r.resolve().is_relative_to(target))
               for r in self.roots()):
            raise ValueError("Choose a directory separate from the current and previous download directories.")
        if target == self.db.path.parent or self.db.path.is_relative_to(target):
            raise ValueError("The download directory cannot contain the database directory.")
        rows = self.db.rows("SELECT * FROM files")
        plans = {}
        if migrate:
            for row in rows:
                for col in PATH_COLUMNS:
                    if not row[col]:
                        continue
                    source = self.safe_path(row[col])
                    if not source.is_file():
                        continue
                    root = next(r for r in self.roots() if source.is_relative_to(r.resolve()))
                    dest = target / source.relative_to(root.resolve())
                    if dest == source:
                        continue
                    if dest.exists() or (dest in plans.values() and plans.get(source) != dest):
                        raise ValueError(f"Destination already contains a conflicting file: {dest.name}")
                    plans[source] = dest
        target.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryFile(dir=target) as probe:
            probe.write(b"0")
        # Copy first; commit paths only after every copy succeeds. Originals survive failures.
        copied = []
        try:
            for source, dest in plans.items():
                dest.parent.mkdir(parents=True, exist_ok=True)
                with source.open("rb") as src, dest.open("xb") as out:
                    copied.append(dest)
                    shutil.copyfileobj(src, out)
            with self.db.connect() as conn:
                for row in rows:
                    for col in PATH_COLUMNS:
                        if row[col] and Path(row[col]).resolve() in plans:
                            conn.execute(f"UPDATE files SET {col}=? WHERE id=?",
                                         (str(plans[Path(row[col]).resolve()]), row["id"]))
                roots = list(dict.fromkeys(str(r) for r in self.roots() if r.resolve() != target))
                for key, val in (("download_root", str(target)), ("previous_download_roots", roots)):
                    conn.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                                 (key, json.dumps(val)))
        except Exception:
            for dest in copied:
                dest.unlink(missing_ok=True)
            raise
        self.worker.root = target
        warnings = []
        for source in plans:
            try:
                source.unlink()
            except OSError:
                warnings.append(f"Copied successfully; could not remove original: {source}")
        return {"download_root": str(target), "migrated": len(plans), "warnings": warnings}
