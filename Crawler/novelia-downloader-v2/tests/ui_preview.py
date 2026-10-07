"""Isolated UI fixtures: python -m tests.ui_preview. No upstream downloads."""

import json
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import uvicorn

import app.server as server
from app.schema import JobRequest
from tests.conftest import epub


def main():
    with tempfile.TemporaryDirectory(prefix="novelia-ui-qa-") as directory:
        root = Path(directory)
        app = server.create_app(root / "data", root / "books", start_worker=False)
        db = app.state.db
        catalog = []
        for index in range(8):
            key = f"wenku/{index + 1:024x}"
            title = "Japanese library " + str(index + 1)
            data = {"title": title, "titleZh": "Local preview", "authors": ["Example author"],
                    "introduction": "A long introduction for testing expansion. " * 20,
                    "volumeJp": [{"volumeId": "Volume 1.epub"}, {"volumeId": "Volume 2.epub"}]}
            db.save_work(key, data, 1)
            catalog.append({"id": key.split("/")[1], **data})
            if index < 4:
                source = epub(root / "books" / str(index) / "source.epub")
                db.save_file(key, "Volume 1.epub", "jp-zh", "hash", source, source.stat().st_size, "digest")
                if index == 3:
                    source.unlink()
        for status in ("completed", "completed_with_errors", "failed", "interrupted"):
            job_id = db.create_job(JobRequest(kind="manual", keys=["wenku/000000000000000000000001"]))
            db.add_targets(job_id, ["wenku/000000000000000000000001"])
            db.execute("UPDATE jobs SET status=?,listing_done=1,error=? WHERE id=?",
                       (status, "Example error" if status == "failed" else None, job_id))
            db.execute("UPDATE job_items SET status=? WHERE job_id=?", ("done" if status == "completed" else "failed", job_id))
            db.log(job_id, "UI fixture log")
            if status == "completed_with_errors":
                db.execute("UPDATE job_items SET retryable=1,attempts=3,error=?,parts=? WHERE job_id=?",
                           ("1 of 2 volume(s) failed. Volume 2.epub: HTTP 503 after 3 attempts",
                            json.dumps({"done": ["Volume 1.epub"],
                                        "failed": {"Volume 2.epub": "HTTP 503 after 3 attempts"}}), job_id))
        paused = db.create_job(JobRequest(kind="incremental"))
        db.defer(paused, datetime.now(timezone.utc) + timedelta(minutes=25),
                 "Novelia kept refusing requests for 10 min; pausing the task for 30 min.", 1)

        class CatalogClient:
            def __init__(self, config, **_):
                pass

            def listing(self, page, category, query):
                return {"items": [item for item in catalog if query.casefold() in item["title"].casefold()], "pageNumber": 3}

            def close(self):
                pass

        server.Client = CatalogClient
        uvicorn.run(app, host="127.0.0.1", port=18031)


if __name__ == "__main__":
    main()
