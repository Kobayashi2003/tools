import base64
import io
import threading
from pathlib import Path

import pytest
import requests
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from app.domain.links import LinkCheck, LinkError, find_links
from app.engine import links
from app.engine.context import Context
from app.engine.download import save_dir
from app.engine.links import adopt_v1_review, list_links, refresh_links, set_state
from app.sources.linkhosts import dropbox, gdrive, gigafile, mega
from app.sources.linkhosts.common import filename_of

from .test_engine import CID, add_creator, obs, reconcile

DOMAINS = ["drive.google.com", "gigafile.nu"]


def test_links_are_cut_at_the_text_around_them():
    text = (
        "DLはこちら→https://drive.google.com/file/d/AbC/view?usp=sharing。パスは1234\n"
        "(https://26.gigafile.nu/1031-xyz). Shop: https://www.melonbooks.co.jp/x"
    )
    assert [(link.url, link.host) for link in find_links(text, DOMAINS)] == [
        ("https://drive.google.com/file/d/AbC/view?usp=sharing", "drive.google.com"),
        ("https://26.gigafile.nu/1031-xyz", "26.gigafile.nu"),
    ]


def test_links_keep_their_state_and_v1_review_carries_over(ctx: Context):
    add_creator(ctx)
    obs(ctx, "1", "pawchive", "full", "2026-01-01T00:00:00", [])
    obs(ctx, "2", "pawchive", "full", "2026-03-01T00:00:00", [])
    ctx.db.run("UPDATE post_obs SET content='https://drive.google.com/a' WHERE post_id='1'")
    ctx.db.run("UPDATE post_obs SET content='https://drive.google.com/b' WHERE post_id='2'")
    reconcile(ctx)
    with ctx.db.tx() as conn:
        assert refresh_links(conn, CID, DOMAINS, "2026-10-23T00:00:00") == 2
        assert refresh_links(conn, CID, DOMAINS, "2026-10-23T00:00:00") == 0

    # v1 had gone through this creator's links up to 2026-02-10: the newer post stays new.
    assert adopt_v1_review(ctx, {"reviewed_artists": [CID], "reviewed_before": "2026-02-10"}) == 1
    states = {link["url"]: link["state"] for link in list_links(ctx)}
    assert states == {"https://drive.google.com/a": "done", "https://drive.google.com/b": "new"}

    new = [link["id"] for link in list_links(ctx, "new")]
    assert set_state(ctx, new, "skipped") == 1 and not list_links(ctx, "new")


# ---------------------------------------------------------------- hosts


def test_drive_links_are_told_apart():
    file_id, folder_id = "1ZTeTZLTv3IUGTaPJtNSfa-fnmu", "1TSM5Ste2Pl7n5o60aRpl0Av1tymnbV_8"
    assert gdrive.parse(f"https://drive.google.com/file/d/{file_id}/view?usp=sharing") == (
        "file",
        file_id,
    )
    assert gdrive.parse(f"https://drive.google.com/open?id={file_id}") == ("file", file_id)
    assert gdrive.parse(f"https://drive.google.com/uc?export=download&id={file_id}") == (
        "file",
        file_id,
    )
    assert gdrive.parse(f"https://drive.google.com/drive/folders/{folder_id}?usp=sharing") == (
        "folder",
        folder_id,
    )
    assert gdrive.parse(f"https://drive.google.com/drive/u/1/folders/{folder_id}") == (
        "folder",
        folder_id,
    )
    assert gdrive.parse("https://mega.nz/file/abc#def") is None


def test_dropbox_links_download_with_dl_1():
    base = "https://www.dropbox.com"
    assert (
        dropbox.download_url(f"{base}/s/91c0frmgmp9i055/a%20b.zip?dl=0")
        == f"{base}/s/91c0frmgmp9i055/a%20b.zip?dl=1"
    )
    # Copied out of HTML: `&amp;` would hide rlkey.
    folder = f"{base}/scl/fo/1s9rv8z4h/AMpqdsStG?rlkey=fh71&amp;st=d9iv&amp;dl=0"
    assert (
        dropbox.download_url(folder) == f"{base}/scl/fo/1s9rv8z4h/AMpqdsStG?rlkey=fh71&st=d9iv&dl=1"
    )
    assert dropbox.is_folder(folder) and dropbox.is_folder(f"{base}/sh/howmy/AABjy?dl=0")
    assert not dropbox.is_folder(f"{base}/scl/fi/cpkbw9/x.png?rlkey=oz&dl=0")
    assert dropbox.download_url(f"{base}/home") is None
    assert dropbox.download_url("https://drive.google.com/file/d/abc/view") is None


def test_a_gigafile_link_is_dead_once_it_shows_the_upload_page():
    assert gigafile.is_gigafile("https://26.gigafile.nu/0724-e24db1deaebc6986eafbea5474441dde9")
    assert not gigafile.is_gigafile("https://gigafile.nu/about")
    assert gigafile.judge('<a href="https://26.gigafile.nu/download.php?file=0724-e2">').state == (
        "alive"
    )
    assert gigafile.judge('<div id="upload_panel"></div>').state == "dead"
    assert gigafile.judge("<p>maintenance</p>").state == "unknown"


def _response(status: int, headers: dict[str, str], body: bytes = b"") -> requests.Response:
    resp = requests.Response()
    resp.status_code, resp.raw = status, io.BytesIO(body)
    resp.headers.update(headers)
    return resp


def test_a_dropbox_link_is_alive_when_it_answers_with_a_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    answers: list[requests.Response] = []
    host = dropbox.Dropbox()
    monkeypatch.setattr(host.http, "get", lambda url, **kwargs: answers.pop(0))
    url = "https://www.dropbox.com/s/abc/a.zip?dl=0"
    dead = b"<title>Dropbox - File Deleted - Simplify your life</title>"
    answers.append(_response(200, {"content-type": "text/html; charset=utf-8"}, dead))
    assert host.check(url) == LinkCheck("dead", "File Deleted")
    file = {"content-disposition": 'attachment; filename="a.zip"', "content-length": "3"}
    answers.append(_response(200, {**file, "content-type": "application/binary"}, b"zip"))
    assert host.check(url) == LinkCheck("alive", "a.zip (0.0 MB)")
    answers.append(_response(200, {**file, "content-type": "application/binary"}, b"zip"))
    saved = host.fetch(url, tmp_path, lambda _m: None, lambda: False)
    assert [p.read_bytes() for p in saved] == [b"zip"]


def test_a_drive_folder_page_lists_its_entries():
    page = (
        '<title>練習 01 - 10 PSD</title><div class="flip-entries">'
        '<div class="flip-entry" id="entry-1aaaaaaaaaa" tabindex="0"><div class="flip-entry-info">'
        '<a href="https://drive.google.com/file/d/1aaaaaaaaaa/view?usp=drive_web">'
        '<div class="flip-entry-title">01 &amp; 02.psd</div></a></div></div>'
        '<div class="flip-entry" id="entry-1bbbbbbbbbb" tabindex="0"><div class="flip-entry-info">'
        '<a href="https://drive.google.com/drive/folders/1bbbbbbbbbb">'
        '<div class="flip-entry-title">sub</div></a></div></div></div>'
    )
    assert gdrive.page_title(page) == "練習 01 - 10 PSD"
    assert gdrive.page_title("<title>a.zip - Google ドライブ</title>") == "a.zip"
    assert gdrive.folder_entries(page) == [
        ("1aaaaaaaaaa", "01 & 02.psd", False),
        ("1bbbbbbbbbb", "sub", True),
    ]


def test_mega_links_in_both_forms():
    assert mega.parse("https://mega.nz/file/5XkDSbhC#lun_Jf") == mega.MegaLink(
        "file", "5XkDSbhC", "lun_Jf"
    )
    assert mega.parse("https://mega.nz/#!5XkDSbhC!lun_Jf") == mega.MegaLink(
        "file", "5XkDSbhC", "lun_Jf"
    )
    assert mega.parse("https://mega.nz/folder/CuBmnRaQ") == mega.MegaLink(
        "folder", "CuBmnRaQ", None
    )
    assert mega.parse("https://mega.nz/#F!CuBmnRaQ!Lv!sub1") == mega.MegaLink(
        "folder", "CuBmnRaQ", "Lv", ("folder", "sub1")
    )
    assert mega.parse("https://mega.nz/folder/CuBmnRaQ#Lv/file/node1") == mega.MegaLink(
        "folder", "CuBmnRaQ", "Lv", ("file", "node1")
    )
    assert mega.parse("https://drive.google.com/file/d/x") is None


def test_a_mega_key_is_found_in_the_post_text():
    m = mega.Mega()
    url = "https://mega.nz/folder/AuxUiQZb"
    assert m.needs_key(url) and not m.needs_key(url + "#N8fkV-FoUINJ1qg1Ra62BQ")
    assert m.with_key(url, "#N8fkV-FoUINJ1qg1Ra62BQ") == url + "#N8fkV-FoUINJ1qg1Ra62BQ"
    assert m.with_key("https://mega.nz/#F!AuxUiQZb!!sub", "k" * 22) == (
        "https://mega.nz/folder/AuxUiQZb#" + "k" * 22 + "/folder/sub"
    )
    # Pawchive's HTML links the bare address and shows the full one.
    html = (
        '<a href="https://mega.nz/folder/AuxUiQZb">https://mega.nz/folder/AuxUiQZb#N8fkV-FoUINJ1qg1Ra62BQ</a>'
        " for the png"
    )
    assert m.key_candidates(url, html) == ["N8fkV-FoUINJ1qg1Ra62BQ"]
    # Or the key follows on its own; a plain word of the same length is not taken for one.
    text = "https://mega.nz/folder/AuxUiQZb\nKey: Ry21weMoyNxtVsf9Fk3RJg\nabcdefghijklmnopqrstuv"
    assert m.key_candidates(url, text) == ["Ry21weMoyNxtVsf9Fk3RJg"]
    assert m.key_candidates("https://mega.nz/file/d3ohxL5a", text) == []  # a file key is longer


class FakeKeyed:
    name = "FakeKeyed"
    good = "G00dKeyG00dKeyG00dKey1"

    def handles(self, url: str) -> bool:
        return "keyed.example" in url

    def needs_key(self, url: str) -> bool:
        return "#" not in url

    def with_key(self, url: str, key: str) -> str:
        return f"{url.split('#')[0]}#{key}"

    def key_candidates(self, url: str, text: str) -> list[str]:
        return ["BadKeyBadKeyBadKeyBad1", self.good] if "keys" in text else []

    def key_works(self, url: str) -> bool:
        return url.endswith(self.good)

    def check(self, url: str) -> LinkCheck:
        return (
            LinkCheck("alive", "opened")
            if url.endswith(self.good)
            else LinkCheck("alive", "no key")
        )


def test_a_key_from_the_text_is_tried_and_kept_and_one_can_be_typed(
    ctx: Context, monkeypatch: pytest.MonkeyPatch
):
    add_creator(ctx)
    obs(ctx, "1", "pawchive", "full", "2026-01-01T00:00:00", [])
    obs(ctx, "2", "pawchive", "full", "2026-01-02T00:00:00", [])
    ctx.db.run("UPDATE post_obs SET content='https://keyed.example/a keys' WHERE post_id='1'")
    ctx.db.run("UPDATE post_obs SET content='https://keyed.example/b' WHERE post_id='2'")
    reconcile(ctx)
    with ctx.db.tx() as conn:
        refresh_links(conn, CID, ["keyed.example"], "2026-10-23T00:00:00")
    host = FakeKeyed()
    monkeypatch.setattr(links, "CHECKERS", [host])
    monkeypatch.setattr(links, "KEYED", [host])
    ctx.store.save({"link_domains": ["keyed.example"]})
    ctx.reload_settings()
    rows = {row["url"]: row for row in list_links(ctx)}
    a, b = rows["https://keyed.example/a"], rows["https://keyed.example/b"]
    assert a["needs_key"] and a["key_hints"][-1] == host.good
    assert b["needs_key"] and b["key_hints"] == []

    links.check_links(ctx, CID, [a["id"], b["id"]], lambda _m: None, threading.Event())
    rows = {row["url"]: row for row in list_links(ctx)}
    assert rows["https://keyed.example/a"]["key"] == host.good
    assert rows["https://keyed.example/a"]["key_source"] == "text"
    assert rows["https://keyed.example/a"]["check_note"] == "opened"
    assert not rows["https://keyed.example/a"]["needs_key"]

    links.set_key(ctx, b["id"], f"#{host.good} ")
    row = ctx.db.one("SELECT * FROM links WHERE id=?", (b["id"],))
    assert row is not None and row["key"] == host.good and row["key_source"] == "manual"
    assert links.usable_url(row) == f"https://keyed.example/b#{host.good}"
    with pytest.raises(ValueError):
        links.set_key(ctx, b["id"], "   ")


def _cbc(key: bytes, data: bytes) -> bytes:
    e = Cipher(algorithms.AES(key), modes.CBC(b"\0" * 16)).encryptor()
    return e.update(data) + e.finalize()


def test_mega_keys_open_names_and_content():
    raw = bytes(range(32))
    key, nonce = mega.file_key(raw)
    assert key == bytes(a ^ b for a, b in zip(raw[:16], raw[16:], strict=True))
    assert nonce == raw[16:24]

    attr = b'MEGA{"n":"\xe7\xb5\xb5.psd"}'
    blob = _cbc(key, attr + b"\0" * (-len(attr) % 16))
    at = base64.urlsafe_b64encode(blob).decode().rstrip("=")
    assert mega.attributes(at, key) == {"n": "絵.psd"}
    with pytest.raises(LinkError):
        mega.attributes(at, b"\x01" * 16)

    plain = b"\x00\x00\x00\x18ftypmp42" * 100
    e = Cipher(algorithms.AES(key), modes.CTR(nonce + b"\0" * 8)).encryptor()
    sealed = e.update(plain) + e.finalize()
    chunks = [sealed[i : i + 7] for i in range(0, len(sealed), 7)]
    assert b"".join(mega.decrypting(iter(chunks), key, nonce)) == plain


def test_a_mega_node_opens_with_the_share_part_of_its_key():
    folder_key, own_key = b"\x11" * 16, b"\x22" * 16

    def ecb(key: bytes, data: bytes) -> bytes:
        e = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
        return e.update(data) + e.finalize()

    def b64u(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).decode().rstrip("=")

    node_key = bytes(range(16))
    attr = b'MEGA{"n":"2024"}'
    node = {
        "t": 1,
        "h": "sub",
        # The owner's own part comes first and does not open with the folder key.
        "k": f"owner:{b64u(ecb(own_key, node_key))}/root:{b64u(ecb(folder_key, node_key))}",
        "a": b64u(_cbc(node_key, attr + b"\0" * (-len(attr) % 16))),
    }
    assert mega._open_node(node, folder_key) == (node_key, b"", "2024")
    assert mega._open_node({**node, "k": node["k"].split("/")[0]}, folder_key) is None


def test_a_mega_folder_lays_out_its_tree():
    def node(h: str, parent: str, folder: bool, name: str) -> mega.Node:
        return mega.Node(h, parent, folder, name, 1, b"", b"")

    nodes = [
        node("r", "", True, "Pack"),
        node("s", "r", True, "sub"),
        node("a", "r", False, "a.png"),
        node("b", "s", False, "b.png"),
    ]
    assert sorted(str(p) for _, p in mega.Mega._paths(nodes, None)) == [
        str(Path("Pack/a.png")),
        str(Path("Pack/sub/b.png")),
    ]
    assert [str(p) for _, p in mega.Mega._paths(nodes, "s")] == [str(Path("sub/b.png"))]


def test_a_saved_name_comes_from_the_response():
    resp = requests.Response()
    resp.headers["content-disposition"] = (
        "attachment; filename=\"x.zip\"; filename*=UTF-8''%E7%B5%B5.zip"
    )
    assert filename_of(resp, "fallback") == "絵.zip"
    resp.headers["content-disposition"] = 'attachment; filename="a/b.zip"'
    assert "/" not in filename_of(resp, "fallback")


class FakeHost:
    name = "Fake"

    def __init__(self):
        self.fetched: list[Path] = []

    def handles(self, url: str) -> bool:
        return "fake.example" in url

    def check(self, url: str) -> LinkCheck:
        return LinkCheck("dead", "gone") if "gone" in url else LinkCheck("alive", "1 file")

    def fetch(self, url, folder, progress, stopped) -> list[Path]:
        if "gone" in url:
            raise LinkError("not found")
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / "a.bin"
        path.write_bytes(b"x")
        self.fetched.append(path)
        return [path]


def test_links_are_checked_and_fetched_into_the_download_folder(
    ctx: Context, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    add_creator(ctx)
    obs(ctx, "1", "pawchive", "full", "2026-01-01T00:00:00", [])
    ctx.db.run("UPDATE post_obs SET content='https://fake.example/ok https://fake.example/gone'")
    reconcile(ctx)
    # The post was moved to an archive by hand: links still go to the download folder.
    ctx.db.run("UPDATE posts SET local_dir=?", (str(tmp_path / "archive"),))
    with ctx.db.tx() as conn:
        refresh_links(conn, CID, ["fake.example"], "2026-10-23T00:00:00")
    host = FakeHost()
    monkeypatch.setattr(links, "CHECKERS", [host])
    monkeypatch.setattr(links, "FETCHERS", [host])
    ctx.store.save({"link_domains": ["fake.example"]})
    ctx.reload_settings()
    ids = [row["id"] for row in list_links(ctx)]
    cancel = threading.Event()

    assert links.check_links(ctx, CID, ids, lambda _m: None, cancel) == "1 alive · 1 dead"
    assert (
        links.fetch_links(ctx, CID, ids, lambda _m: None, cancel)
        == "1 fetched · 1 files · 1 failed"
    )
    rows = {row["url"]: row for row in list_links(ctx)}
    ok, gone = rows["https://fake.example/ok"], rows["https://fake.example/gone"]
    assert ok["state"] == "done" and ok["fetched_at"] and ok["fetch_error"] is None
    assert (
        gone["state"] == "failed"
        and gone["fetch_error"] == "not found"
        and gone["check_state"] == "dead"
    )
    # A dead link marked done by hand is failed too; a fetched one stays done.
    ctx.db.run("UPDATE links SET state='done' WHERE url LIKE '%gone'")
    links.check_links(ctx, CID, ids, lambda _m: None, cancel)
    rows = {row["url"]: row["state"] for row in list_links(ctx)}
    assert rows == {"https://fake.example/ok": "done", "https://fake.example/gone": "failed"}
    # Alive again: back to new.
    ctx.db.run("UPDATE links SET url='https://fake.example/back' WHERE url LIKE '%gone'")
    links.check_links(ctx, CID, ids, lambda _m: None, cancel)
    assert {row["url"]: row["state"] for row in list_links(ctx)}[
        "https://fake.example/back"
    ] == "new"
    post = ctx.db.one("SELECT * FROM posts WHERE post_id='1'")
    assert post is not None
    expected = save_dir(ctx, ctx.require_creator(CID), post) / "links" / "a.bin"
    assert host.fetched == [expected] and not (tmp_path / "archive").exists()
