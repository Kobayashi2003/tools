import requests

from app.domain.match import parse_ref
from app.domain.status import has_site, site_currency, site_label
from app.domain.timefmt import now_utc
from app.engine.context import Context
from app.engine.sync import resolve_campaign
from app.sources.patreon import content_hash, identity, is_stream, patreon_entries

H1 = "0123456789abcdef0123456789abcdef"
H2 = "fedcba9876543210fedcba9876543210"


def url(h: str, name: str = "1.png") -> str:
    return f"https://c10.patreonusercontent.com/4/patreon-media/p/post/9/{h}/eyJ3/1/{name}?token-time=1"


def media(mid: str, name: str, u: str) -> dict:
    return {"type": "media", "id": mid, "attributes": {"file_name": name, "download_url": u}}


def post(attrs: dict, rels: dict | None = None) -> dict:
    return {"id": "9", "attributes": attrs, "relationships": rels or {}}


def refs(*ids: str) -> dict:
    return {"data": [{"type": "media", "id": i} for i in ids]}


def test_a_header_that_is_one_of_the_images_stays_that_image():
    included = {("media", "1"): media("1", "a.png", url(H1, "a.png"))}
    p = post({"image": {"large_url": url(H1, "header.png")}}, {"images": refs("1")})
    assert [(e.role, e.name) for e in patreon_entries(p, included)] == [("image", "a.png")]


def test_a_header_found_nowhere_else_is_the_cover():
    included = {("media", "1"): media("1", "a.png", url(H1, "a.png"))}
    p = post({"image": {"large_url": url(H2, "h.jpg")}}, {"images": refs("1")})
    assert [(e.role, e.name) for e in patreon_entries(p, included)] == [
        ("cover", "cover.jpg"),
        ("image", "a.png"),
    ]


def test_one_picture_named_several_ways_is_listed_once():
    # The same image as a listed image, the post file and an inline image.
    included = {("media", "1"): media("1", "a.png", url(H1, "a.png"))}
    content = f'<p><img data-media-id="1" src="{url(H1)}"></p><img src="{url(H2)}">'
    p = post(
        {"post_file": {"name": "1.png", "url": url(H1)}, "content": content},
        {"images": refs("1"), "media": refs("1")},
    )
    assert [e.name for e in patreon_entries(p, included)] == ["a.png", f"{H2}.png"]


def test_an_embedded_videos_post_file_is_its_thumbnail_and_skipped():
    p = post({"post_type": "video_embed", "post_file": {"name": "t.jpg", "url": url(H1)}})
    assert patreon_entries(p, {}) == []


def test_a_text_posts_header_only_in_media_is_kept():
    included = {("media", "5"): media("5", "h.jpg", url(H1, "h.jpg"))}
    p = post({"image": {"large_url": url(H1, "h.jpg")}}, {"media": refs("5")})
    assert [(e.role, e.name) for e in patreon_entries(p, included)] == [("image", "h.jpg")]


def test_a_patreon_video_is_saved_as_mp4():
    stream = "https://stream.mux.com/abc.m3u8?token=x"
    p = post({"post_type": "video_external_file", "post_file": {"name": "clip.mov", "url": stream}})
    [entry] = patreon_entries(p, {})
    assert (entry.name, entry.role) == ("clip.mp4", "file")
    assert is_stream(stream) and not is_stream(url(H1))


def test_media_addresses_are_known_by_their_content_hash():
    assert content_hash(url(H1)) == H1
    assert identity(url(H1, "a.png")) == identity(url(H1, "b.png")) == H1
    assert identity("https://x.test/a.png?t=1") == "https://x.test/a.png"


def test_patreon_links_parse():
    assert parse_ref("https://www.patreon.com/user?u=123") is not None
    r = parse_ref("https://www.patreon.com/user/posts?u=123&x=1")
    assert r is not None and (r.kind, r.user_id) == ("patreon_user", "123")
    r = parse_ref("https://www.patreon.com/posts/some-title-98765")
    assert r is not None and (r.kind, r.post_id) == ("patreon_post", "98765")
    r = parse_ref("patreon.com/c/someone/posts")
    assert r is not None and (r.kind, r.creator_id) == ("patreon_vanity", "someone")
    assert parse_ref("https://www.patreon.com/login") is None


def test_both_sites_are_a_creators_own_site():
    assert has_site("fanbox") and has_site("patreon") and not has_site("fantia")
    assert (site_label("patreon"), site_currency("patreon")) == ("Patreon", "$")
    assert (site_label("fanbox"), site_currency("fanbox")) == ("Fanbox", "¥")


def test_a_hidden_patreon_account_has_no_page(ctx: Context, monkeypatch):
    ctx.db.run(
        "INSERT INTO creators(id, service, user_id, name, added_at) "
        "VALUES('patreon_7', 'patreon', '7', 'x', ?)",
        (now_utc(),),
    )
    response = requests.Response()
    response.status_code = 403

    def refuse(user_id: str):
        raise requests.HTTPError(response=response)

    monkeypatch.setattr(ctx.patreon, "campaign_of", refuse)
    creator = ctx.creator("patreon_7")
    assert creator is not None
    assert resolve_campaign(ctx, creator) is None
    after = ctx.creator("patreon_7")
    assert after is not None and after["fanbox_state"] == "none"
