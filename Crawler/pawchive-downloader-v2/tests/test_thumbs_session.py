from pathlib import Path

import pytest
import requests
from fastapi.testclient import TestClient
from PIL import Image

from app import server as server_module
from app.domain.timefmt import now_utc
from app.engine import login
from app.engine.context import Context
from app.library.thumbs import WIDTH, Thumbs
from app.sources.fanbox import SessionRejected

CID = "fanbox_1"


def _post(ctx: Context, folder: Path):
    ctx.db.run(
        "INSERT INTO creators(id, service, user_id, name, added_at) VALUES(?, 'fanbox', '1', 'n', ?)",
        (CID, now_utc()),
    )
    ctx.db.run(
        "INSERT INTO posts(creator_id, post_id, title, published, local_dir, first_seen) "
        "VALUES(?, '10', 't', '2020-01-01T00:00:00', ?, ?)",
        (CID, str(folder), now_utc()),
    )
    ctx.db.run(
        "INSERT INTO files(creator_id, post_id, key, role, ordinal, name, local_name, state) "
        "VALUES(?, '10', 'cover', 'cover', 0, 'cover.jpeg', '0.jpeg', 'done')",
        (CID,),
    )


def test_thumbnail_prefers_the_local_cover_and_caches_it(ctx: Context, tmp_path: Path):
    folder = tmp_path / "post"
    folder.mkdir()
    Image.new("RGB", (1200, 630), "red").save(folder / "0.jpeg")
    _post(ctx, folder)
    thumbs = Thumbs(ctx)
    path = thumbs.get(CID, "10")
    assert path is not None and path.parent == ctx.data_dir / "thumbs" / str(WIDTH) / CID
    with Image.open(path) as im:
        assert im.size[0] == WIDTH and abs(im.size[1] - WIDTH * 630 / 1200) <= 1
    (folder / "0.jpeg").unlink()
    assert thumbs.get(CID, "10") == path  # served from the cache


def test_missing_cover_is_remembered(ctx: Context, tmp_path: Path):
    _post(ctx, tmp_path / "nowhere")
    thumbs = Thumbs(ctx)
    assert thumbs.get(CID, "10") is None
    assert thumbs.path(CID, "10").with_suffix(".none").exists()


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("FANBOX_SESSID", raising=False)
    app = server_module.create_app(tmp_path / "data", start_engine=False)
    with TestClient(app) as c:
        yield c, app.state.ctx


def _valid(ctx: Context) -> int:
    ctx.set_session_state(state="valid", supporting=2, message="")
    return 2


def _reject(ctx: Context) -> int:
    ctx.set_session_state(state="rejected", message="401")
    raise SessionRejected("401")


def test_a_refused_browser_cookie_keeps_the_working_one(client, monkeypatch):
    c, ctx = client
    monkeypatch.setattr(login, "refresh_subscriptions", _valid)
    assert c.post("api/fanbox/session", json={"sessid": "123_good"}).json()["state"] == "valid"

    monkeypatch.setattr(login, "refresh_subscriptions", _reject)
    out = login.apply_sessid(ctx, "123_stale", "browser", keep_previous=True)
    assert out["state"] == "rejected"
    assert ctx.store.fanbox_sessid() == "123_good"
    assert ctx.session()["state"] == "valid"
    # The cookie already in use is not verified again.
    again = login.apply_sessid(ctx, "123_good", "browser", keep_previous=True)
    assert again["state"] == "valid" and again["source"] == "browser"


@pytest.mark.parametrize("body", [{"plans": [{"id": "1"}]}, [{"id": "1"}]], ids=["wrapped", "bare"])
def test_supported_plans_read_both_response_shapes(ctx: Context, monkeypatch, body):
    monkeypatch.setattr(ctx.fanbox, "_get", lambda *a, **k: body)
    assert ctx.fanbox.supporting() == [{"id": "1"}]


class FakeCurlResponse:
    def __init__(self, status: int):
        self.status_code = status

    def json(self) -> dict:
        return {"body": {"ok": True}}


def test_impersonated_fanbox_calls_fail_like_requests(ctx: Context, monkeypatch):
    http = ctx.fanbox_http
    assert http.json_session is not None
    sent: dict = {}

    def fake_get(url: str, **kwargs):
        sent.update(kwargs["headers"])
        return FakeCurlResponse(403)

    monkeypatch.setattr(http.json_session, "get", fake_get)
    with pytest.raises(requests.HTTPError) as e:
        http.get_json("https://api.fanbox.cc/post.info")
    assert http.status_of(e.value) == 403
    # The impersonated browser's own User-Agent must not be overridden.
    assert "User-Agent" not in sent and sent["Origin"] == "https://www.fanbox.cc"
    monkeypatch.setattr(http.json_session, "get", lambda url, **kw: FakeCurlResponse(200))
    assert http.get_json("https://api.fanbox.cc/post.info") == {"body": {"ok": True}}


class FakeDevTools:
    def __init__(self, values: list[str]):
        self.values = values

    def call(self, method: str, **params: object) -> dict:
        value = self.values.pop(0) if len(self.values) > 1 else self.values[0]
        return {"cookies": [{"name": "FANBOXSESSID", "domain": ".fanbox.cc", "value": value}]}


def test_browser_sign_in_waits_past_the_anonymous_cookie(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(login, "POLL_SECONDS", 0)
    accepted: list[str] = []

    def accept(sessid: str) -> dict:
        accepted.append(sessid)
        return {"state": "valid", "supporting": 3}

    flow = login.BrowserLogin(tmp_path, accept)
    tools = FakeDevTools(["anonymousvalue", "anonymousvalue", "4242_secret"])
    assert flow._wait(tools)["state"] == "done"
    assert accepted == ["4242_secret"]


def test_signing_in_needs_a_browser(client, monkeypatch):
    c, _ = client
    monkeypatch.setattr(server_module, "find_browser", lambda configured: None)
    res = c.post("api/fanbox/login")
    assert res.status_code == 400 and "browser_path" in res.json()["detail"]
    assert c.get("api/fanbox/login").json() == {"state": "idle"}
