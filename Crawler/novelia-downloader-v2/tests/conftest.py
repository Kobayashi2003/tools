import copy
import shutil
import zipfile

import pytest

from app.client import Cancelled, fingerprint
from app.database import Database
from app.worker import Worker

KEY = "wenku/688da4c4c923db0b7aa9943e"


def epub(path, bilingual=True, paragraph="日本語の本文", css=b""):
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>')
        z.writestr("OPS/book.opf", '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:language>zh</dc:language><dc:title>Test</dc:title></metadata><manifest></manifest><spine></spine></package>')
        z.writestr("OPS/Styles/book.css", css)
        body = f'<p style="opacity:0.4">{paragraph}</p><p>测试译文</p><p/>' if bilingual else f'<p>{paragraph}</p><p/>'
        z.writestr("OPS/chapter.xhtml", f'<html><head><title>Test</title><link href="Styles/book.css" rel="stylesheet"/></head><body>{body}</body></html>')
    return path


class Upstream:
    def __init__(self, root):
        self.root = root
        self.raw = epub(root / "raw.epub")
        self.original = epub(root / "original.epub", False, css=b"html{writing-mode:vertical-rl}")
        self.works = {KEY: {"title": "Test novel", "titleZh": "Test", "authors": ["Author"],
                           "level": "一般向", "volumeJp": [{"volumeId": "volume1.epub", "sakura": 10, "total": 10}],
                           "volumeZh": []}}
        self.pages = {1: [KEY]}
        self.downloads = []
        self.checked = []
        self.listed = []
        self.fail_page = None
        self.fail_volume = None
        self.fail_reference = False
        self.cancel_volume = None
        self.clients = []

    def client(self, config, check):
        upstream = self

        class FakeClient:
            def __init__(self):
                self.closed = False

            def listing(self, page, category, query=""):
                check()
                upstream.listed.append((page, category))
                if upstream.fail_page == page:
                    raise RuntimeError("Temporary listing error")
                return {"items": [{"id": k.split("/", 1)[1]} for k in upstream.pages.get(page, [])],
                        "pageNumber": max(upstream.pages)}

            def metadata(self, key):
                check()
                upstream.checked.append(key)
                return copy.deepcopy(upstream.works[key])

            def source(self, key, volume, destination, original=False):
                check()
                if volume == upstream.cancel_volume:
                    raise Cancelled("Test interruption")
                if volume == upstream.fail_volume or (original and upstream.fail_reference):
                    raise RuntimeError("Temporary download error")
                upstream.downloads.append((key, volume, original))
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(upstream.original if original else upstream.raw, destination)
                return destination.stat().st_size, fingerprint(destination.read_bytes().hex())

            def close(self):
                self.closed = True

        client = FakeClient()
        self.clients.append(client)
        return client


@pytest.fixture
def system(tmp_path):
    db = Database(tmp_path / "data" / "library.sqlite3")
    upstream = Upstream(tmp_path / "upstream")
    worker = Worker(db, tmp_path / "downloads", upstream.client)
    return db, worker, upstream
