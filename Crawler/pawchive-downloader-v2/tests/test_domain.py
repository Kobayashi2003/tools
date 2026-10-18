from dataclasses import replace

from app.domain.filters import FilterTarget, combined, reason
from app.domain.match import (
    Ref,
    fanbox_entries,
    merge,
    original_cover_url,
    parse_ref,
    pawchive_entries,
)
from app.domain.naming import file_names, unique_names
from app.domain.status import PostFacts, coverage, headline, subscription
from app.domain.timefmt import JST, fanbox_cursor, infer_offset, local_date, to_utc


def test_to_utc_normalises_both_sources_to_one_instant():
    # The pair checked by hand: Pawchive stores naive UTC, Fanbox writes JST.
    assert to_utc("2026-09-04T16:08:33") == "2026-09-04T16:08:33"
    assert to_utc("2026-09-05T01:08:33+09:00") == "2026-09-04T16:08:33"
    assert to_utc(None) == "" and to_utc("garbage") == ""


def test_fanbox_cursor_is_jst_wall_time():
    assert fanbox_cursor("2026-10-09T06:56:28") == "2026-10-09 15:56:28"


def test_infer_offset_finds_the_extension_s_utc_plus_8():
    # Real samples from the 遠藤弘土 folder: the first rules out JST, the second UTC.
    samples = [
        ("ちこと先生23", "2018-04-29", to_utc("2018-04-30T00:00:56+09:00")),
        ("シュノン23", "2019-07-15", to_utc("2019-07-15T06:31:11+09:00")),
        ("ちこと先生", "2018-04-26", to_utc("2018-04-26T22:40:03+09:00")),
    ]
    best = infer_offset(samples)[0]
    assert best.minutes == 480 and best.agree == 3
    assert {w[0] for w in best.witnesses} == {"ちこと先生23", "シュノン23"}
    assert local_date(samples[0][2], JST) != "2018-04-29"


def test_pawchive_entries_drop_the_repeated_cover_and_key_by_name():
    cover = {"name": "cover.jpeg", "path": "/a1/37/" + "a" * 64 + ".jpeg"}
    entries = pawchive_entries(
        cover,
        [
            cover,
            {"name": "NWRWjMvlAdJq0ketfb18dXC1.jpeg", "path": "/b/" + "b" * 64 + ".jpeg"},
            {"name": "MyVideo_2.mp4", "path": "/c/" + "c" * 64 + ".mp4"},
        ],
    )
    assert [e.key for e in entries] == [
        "cover",
        "n:NWRWjMvlAdJq0ketfb18dXC1.jpeg",
        "n:MyVideo_2.mp4",
    ]
    assert [e.role for e in entries] == ["cover", "image", "file"]
    assert entries[0].sha256 == "a" * 64


def _fanbox_post(**body):
    return {
        "coverImageUrl": "https://pixiv.pximg.net/c/1200x630_90_a2_g5/fanbox/public/images/post/1/cover/CoverId.jpeg",
        "body": body,
    }


def test_fanbox_entries_use_the_original_cover_and_reading_order():
    assert original_cover_url(_fanbox_post()["coverImageUrl"]).startswith(
        "https://pixiv.pximg.net/fanbox/public/"
    )
    article = _fanbox_post(
        blocks=[
            {"type": "p", "text": "hi"},
            {"type": "file", "fileId": "f1"},
            {"type": "image", "imageId": "i1"},
        ],
        imageMap={
            "i1": {"id": "i1", "extension": "png", "width": 10, "height": 20, "originalUrl": "u1"},
            "i2": {"id": "i2", "extension": "jpg", "originalUrl": "u2"},
        },
        fileMap={"f1": {"name": "doc", "extension": "pdf", "size": 5, "url": "u3"}},
    )
    keys = [e.key for e in fanbox_entries(article)]
    assert keys == ["cover", "n:doc.pdf", "n:i1.png", "n:i2.jpg"]


def test_merge_keeps_pawchive_order_and_appends_fanbox_only_files():
    p = pawchive_entries(
        {"name": "cover.jpeg", "path": "/x/" + "1" * 64 + ".jpeg"},
        [{"name": "b.png", "path": "/y/" + "2" * 64 + ".png"}],
    )
    f = fanbox_entries(
        _fanbox_post(
            images=[
                {"id": "a", "extension": "png", "originalUrl": "ua", "width": 1, "height": 1},
                {"id": "b", "extension": "png", "originalUrl": "ub", "width": 2, "height": 2},
            ]
        )
    )
    merged = merge(p, f)
    assert [e.key for e in merged] == ["cover", "n:b.png", "n:a.png"]
    assert merged[1].sources == {"pawchive", "fanbox"} and merged[1].width == 2
    assert merged[0].url.endswith("CoverId.jpeg") and merged[0].path


def test_merge_pairs_uuid_named_old_posts_by_position():
    # 2018 post 【みんな向け】新刊表紙: Pawchive has two UUID names, Fanbox a cover and an image.
    p = pawchive_entries(
        None,
        [
            {"name": "22b56cf4-2f84-4af2-9a63-65baccc3cd70.jpg", "path": "/a/" + "1" * 64 + ".jpg"},
            {"name": "02263c5c-74b0-49ef-9418-10a57dafb88b.jpg", "path": "/b/" + "2" * 64 + ".jpg"},
        ],
    )
    f = fanbox_entries(
        _fanbox_post(
            images=[
                {"id": "EW64", "extension": "jpeg", "originalUrl": "u", "width": 5, "height": 6},
            ]
        )
    )
    merged = merge(p, f)
    assert [e.key for e in merged] == [p[0].key, p[1].key]
    assert merged[0].role == "cover" and merged[1].width == 5
    # Unequal leftovers: pair what lines up, keep Fanbox's extra file at the end.
    extra = fanbox_entries(
        _fanbox_post(
            images=[
                {"id": "a", "extension": "png", "originalUrl": "u1"},
                {"id": "b", "extension": "png", "originalUrl": "u2"},
            ]
        )
    )
    assert [e.key for e in merge(p, extra)] == [p[0].key, p[1].key, "n:b.png"]


def test_merge_recognises_a_pawchive_cover_named_with_fanbox_s_id():
    p = pawchive_entries({"name": "CoverId.jpeg", "path": "/x/" + "1" * 64 + ".jpeg"}, [])
    merged = merge(p, fanbox_entries(_fanbox_post(images=[])))
    assert [e.key for e in merged] == ["cover"]


def test_v1_naming_numbers_images_only():
    names = ["cover.jpeg", "a.png", "doc.pdf", "b.jpg"]
    out = file_names(names, "{idx}", True, lambda n: not n.endswith(".pdf"))
    assert out == ["0.jpeg", "1.png", "doc.pdf", "2.jpg"]
    assert unique_names(["0.jpg", "0.jpg", "x.png"], taken=["X.PNG"]) == [
        "0.jpg",
        "0 (1).jpg",
        "x (1).png",
    ]


def _ref(text: str) -> Ref:
    r = parse_ref(text)
    assert r is not None, text
    return r


def test_parse_ref_understands_every_link_kind():
    assert _ref("https://pawchive.pw/fanbox/user/273185/post/12548332").user_id == "273185"
    r = _ref("https://www.fanbox.cc/@dksha19/posts/12548332")
    assert (r.kind, r.creator_id, r.post_id) == ("fanbox_post", "dksha19", "12548332")
    assert _ref("https://dksha19.fanbox.cc/").creator_id == "dksha19"
    assert _ref("https://www.pixiv.net/users/273185").kind == "fanbox_user"
    assert _ref("@dksha19").kind == "fanbox_creator"
    assert _ref("patreon_10443513").service == "patreon"
    assert parse_ref("nonsense!") is None


def test_filter_reason_names_the_rule_and_its_origin():
    cfg, origin = combined({"exclude_keywords": ["お知らせ"]}, {"published_after": "2020-01-01"})
    t = FilterTarget("今日の更新延期のお知らせ", "2021-05-01T00:00:00", 1, 0)
    assert reason(t, cfg, origin) == 'Title has "お知らせ" · global'
    t2 = FilterTarget("新作", "2019-05-01T00:00:00", 1, 0)
    assert reason(t2, cfg, origin) == "Published on or before 2020-01-01 · creator"
    # A creator can switch a global key off.
    cfg3, _ = combined({"exclude_keywords": ["お知らせ"]}, {"exclude_keywords": []})
    assert reason(t, cfg3) is None


def test_headline_priorities():
    base = PostFacts(p="meta", f="open", fee=550, plan_fee=550, total=3)
    assert headline(base)["k"] == "pending"
    assert headline(base)["why"] == "Next: Fanbox"
    assert headline(replace(base, filtered="x"))["k"] == "filtered"
    assert headline(replace(base, done=1, failed=1))["k"] == "failed"
    assert (
        headline(replace(base, f="locked"))["why"] == "Needs a ¥550 plan · Pawchive metadata only"
    )
    waiting = PostFacts(
        p="full",
        f="locked",
        fee=550,
        plan_fee=0,
        total=2,
        deferred=2,
        deferred_until="2026-10-19T00:00:00",
    )
    assert headline(waiting)["k"] == "wait"
    # v1 recorded these as failed, but they are all inside their 404 deferral.
    assert headline(replace(waiting, failed=2))["k"] == "wait"
    adopted = replace(base, local_done=True, via=["adopted"], unverified=1)
    assert headline(adopted)["why"] == "Adopted · unverified"
    assert coverage("meta", "open") == "both" and coverage("none", "locked") == "fonly"
    assert coverage("full", "na") == "ponly" and coverage("gone", "gone") == "local"
    assert subscription(1100, 550, "unknown") == "no" and subscription(0, None, "na") == "free"
    assert subscription(550, None, "unknown") == "unknown"
    # A cancelled plan is gone from your plan list, yet Fanbox keeps the month's posts open.
    assert subscription(1100, 0, "open") == "yes"
    assert subscription(550, 1100, "locked") == "no"
