import pytest

from app import fc2, paipancon, sukebei
from app.fc2id import extract_id, parse_id, strip_code
from tests import fixtures


@pytest.mark.parametrize("text, expected", [
    ("FC2 PPV 1289686 (UNCENSORED 2160p)", "1289686"),
    ("FC2 4902562 初撮", "4902562"),
    ("FC2PPV-4907687-", "4907687"),
    ("FC2-PPV-4823894", "4823894"),
    ("fc2-ppv-4812315 初撮り", "4812315"),
    ("[FHD]FC2PPV‐4907687_1", "4907687"),
    ("Some release 2160p", None),
    ("FC2 123", None),
    ("FC2-PPV-123456789", None),
])
def test_extract_id(text, expected):
    assert extract_id(text) == expected


def test_parse_id_accepts_bare_numbers():
    assert parse_id(" 4802589 ") == "4802589"
    assert parse_id("FC2-PPV-4802589") == "4802589"
    assert parse_id("hello") is None


def test_strip_code():
    assert strip_code("FC2-PPV-4802589 - Title") == "Title"
    assert strip_code("Title only") == "Title only"
    assert strip_code("+++ FC2-PPV-4982106 【反省価格】あの") == "【反省価格】あの"
    assert strip_code("[FHD] FC2 PPV 1289686 (UNCENSORED)") == "[FHD] (UNCENSORED)"
    assert strip_code("[FC2-PPV-1289686] 浴衣") == "浴衣"


def test_listing_rows():
    listing = sukebei.parse_listing(fixtures.LISTING)
    assert listing.total == 1000 and listing.has_next
    first, second, third = listing.torrents
    assert first.view_id == 4732175
    assert first.fc2_id == "4802589"
    assert first.name == "fc2-ppv-4802589 藻梨特典有 & more"
    assert first.infohash == "68b8f9604d16dae11cb76c52990c54bddb80b070"
    assert first.magnet.startswith("magnet:?xt=urn:btih:") and "&amp;" not in first.magnet
    assert first.size_bytes == int(1.8 * 1024 ** 3)
    assert (first.seeders, first.leechers, first.downloads) == (5, 11, 3)
    assert first.uploaded_at == 1791484390
    assert first.category == "Real Life - Videos"
    assert second.fc2_id == "1289686" and second.flag == "trusted" and second.seeders == 0
    assert third.fc2_id is None and third.flag == "remake"


def test_listing_last_page():
    listing = sukebei.parse_listing(fixtures.listing_page([], total=0, has_next=False))
    assert listing.torrents == [] and not listing.has_next


def test_search_url():
    assert sukebei.search_url("FC2") == "https://sukebei.nyaa.si/?f=0&c=0_0&q=FC2&s=id&o=desc"
    assert sukebei.search_url("FC2", page=3, sort="bogus").endswith("s=id&o=desc&p=3")


def test_view_file_tree_and_risk():
    view = sukebei.parse_view(fixtures.VIEW)
    paths = [f["path"] for f in view["files"]]
    assert paths == [
        "fc2-ppv-4802589 root/ads/installer.exe",
        "fc2-ppv-4802589 root/ads/site.url",
        "fc2-ppv-4802589 root/FC2-PPV-4802589.mp4",
        "fc2-ppv-4802589 root/game.apk",
    ]
    assert [f["risky"] for f in view["files"]] == [True, False, False, True]
    assert view["risky"] is True
    assert view["files"][2]["size"] == "1.6 GiB"
    assert view["description"] == "https://imagetwist.com/x/y.png & notes"


def test_fc2_article():
    article = fc2.parse_article(fixtures.FC2_ARTICLE)
    assert article["title"] == "美巨乳&JD"
    assert article["cover"].startswith("https://contents-thumbnail2.fc2.com/w480/")
    assert article["cover_full"].startswith("https://contents-thumbnail2.fc2.com/w1280/")
    assert article["duration"] == "01:36:30"
    assert article["seller"] == "美尻ちゃんねる"
    assert article["seller_url"] == "https://adult.contents.fc2.com/users/bisirichn/"
    assert article["rating"] == 4 and article["reviews"] == 81
    assert article["released"] == "2025-11-23"
    assert article["tags"] == ["ハメ撮り", "JD"]
    assert len(article["samples"]) == 2
    assert article["samples"][0]["thumb"].startswith("https://contents-thumbnail2.fc2.com/w480/")
    assert all("other" not in s["full"] for s in article["samples"])


def test_fc2_removed():
    assert fc2.parse_article(fixtures.FC2_REMOVED) is None


def test_paipancon_media_is_anchored_and_ordered():
    detail = paipancon.parse_detail(fixtures.PAIPANCON, "4802589")
    base = "https://paipancon.com/fc2daily/data/FC2-PPV-4802589/"
    assert detail["title"] == "美巨乳JD"
    assert detail["cover"] == base + "cover.jpg"
    assert detail["grid"] == base + "grid.jpg"
    assert detail["thumbnails"] == [base + "thumbnail_0.jpg", base + "thumbnail_1.jpg"]
    assert detail["clips"] == [base + "aaa.mp4", base + "bbb.mp4"]
