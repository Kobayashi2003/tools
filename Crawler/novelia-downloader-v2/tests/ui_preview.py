"""Isolated UI fixtures: python -m tests.ui_preview. No upstream downloads."""

import json
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import uvicorn

import app.server as server
from app.schema import JobRequest, Settings
from app.worker import Worker
from tests.conftest import epub


def main():
    with tempfile.TemporaryDirectory(prefix="novelia-ui-qa-") as directory:
        root = Path(directory)
        app = server.create_app(root / "data", root / "books", start_worker=False)
        db = app.state.db
        catalog = []
        for index in range(10):
            key = f"wenku/{index + 1:024x}"
            title = "Japanese library " + str(index + 1)
            data = {
                "title": title,
                "titleZh": "Local preview",
                "authors": ["Example author"],
                "introduction": "A long introduction for testing expansion. " * 20,
                "volumeJp": [
                    {"volumeId": "Volume 1.epub", "sakura": 40, "total": 40},
                    {"volumeId": "Volume 2.epub", "total": 40},
                ],
            }
            catalog.append({"id": key.split("/")[1], **data})
            if index >= 8:
                continue  # in the catalog only
            db.save_work(key, data, 1)
            if index < 4:
                source = epub(root / "books" / str(index) / "source.epub")
                db.save_file(
                    key, "Volume 1.epub", "jp-zh", "hash", source, source.stat().st_size, "digest"
                )
                if index == 3:
                    source.unlink()
                if index == 0:
                    original = epub(root / "books" / "0" / "original.epub", False)
                    db.save_original(
                        key, "Volume 1.epub", "hash", original, original.stat().st_size, "d"
                    )
                    stamp = Worker.stamp(data["volumeJp"][1], "jp-original", Settings())
                    db.mark_unavailable(key, "Volume 2.epub", "jp-original", stamp, "Empty.", 1)
        for status in ("completed", "completed_with_errors", "failed", "interrupted"):
            job_id = db.create_job(
                JobRequest(kind="manual", keys=["wenku/000000000000000000000001"])
            )
            db.add_targets(job_id, ["wenku/000000000000000000000001"])
            db.execute(
                "UPDATE jobs SET status=?,listing_done=1,error=? WHERE id=?",
                (status, "Example error" if status == "failed" else None, job_id),
            )
            db.execute(
                "UPDATE job_items SET status=? WHERE job_id=?",
                ("done" if status == "completed" else "failed", job_id),
            )
            db.log(job_id, "UI fixture log")
            if status == "completed_with_errors":
                db.execute(
                    "UPDATE job_items SET retryable=1,attempts=3,error=?,parts=? WHERE job_id=?",
                    (
                        "1 of 2 volume(s) failed. Volume 2.epub: HTTP 503 after 3 attempts",
                        json.dumps(
                            {
                                "done": ["Volume 1.epub"],
                                "failed": {"Volume 2.epub": "HTTP 503 after 3 attempts"},
                            }
                        ),
                        job_id,
                    ),
                )
        running = db.create_job(JobRequest(kind="full"))
        keys = [f"wenku/{index + 1:024x}" for index in range(3)]
        db.add_targets(running, keys)
        db.execute("UPDATE jobs SET status='running',listing_done=1 WHERE id=?", (running,))
        for key, retryable, error in (
            (keys[0], 1, "Network SSLError after 3 attempts"),
            (keys[1], 0, "HTTP 404: not found on Novelia."),
        ):
            db.execute(
                "UPDATE job_items SET status='failed',retryable=?,error=?,attempts=1 "
                "WHERE job_id=? AND target=?",
                (retryable, error, running, key),
            )
        db.execute(
            "UPDATE job_items SET status='running' WHERE job_id=? AND target=?", (running, keys[2])
        )
        start = datetime.now(UTC) - timedelta(days=1, minutes=5)
        for index in range(400):
            key = f"wenku/{index + 10:024x}"
            lines = [("info", f"Checking {key}")]
            if index % 3:
                lines.append(
                    (
                        "info",
                        f"Downloaded ソードアート・オンライン 第{index}巻.epub ({1800 + index * 37} KB).",
                    )
                )
            else:
                lines.append(("info", f"Unchanged: 魔女の旅々{index:02d}GAノベル.epub"))
            if index % 41 == 0:
                lines.append(
                    ("warning", f"{key}: category changed; excluded from light novel downloads.")
                )
            if index % 57 == 0:
                lines.append(
                    (
                        "error",
                        f"{key}: 1 of 2 volume(s) failed. 第二巻.epub: Network SSLError after 3 attempts",
                    )
                )
            for level, message in lines:
                stamp = (start + timedelta(minutes=index * 4)).isoformat(timespec="seconds")
                db.execute(
                    "INSERT INTO logs(job_id,created_at,level,message) VALUES (?,?,?,?)",
                    (running, stamp, level, message),
                )
        paused = db.create_job(JobRequest(kind="incremental"))
        db.defer(
            paused,
            datetime.now(UTC) + timedelta(minutes=25),
            "Novelia kept refusing requests for 10 min; pausing the task for 30 min.",
            1,
        )

        class CatalogClient:
            def __init__(self, config, **_):
                pass

            def listing(self, page, category, query):
                return {
                    "items": [
                        item for item in catalog if query.casefold() in item["title"].casefold()
                    ],
                    "pageNumber": 3,
                }

            def metadata(self, key):
                return next(item for item in catalog if item["id"] == key.split("/")[1])

            def close(self):
                pass

        server.Client = CatalogClient
        uvicorn.run(app, host="127.0.0.1", port=18031)


if __name__ == "__main__":
    main()
