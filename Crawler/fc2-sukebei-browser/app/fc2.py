"""FC2 Contents Market (adult.contents.fc2.com): the official article page and sample video.

Article markup (verified against live pages):

    <meta property="og:title" content="FC2-PPV-<id> TITLE">
    <div class="items_article_MainitemThumb"><span><img src="//contents-thumbnail2.fc2.com/w276/…">
        <p class="items_article_info">01:36:30</p>                  duration
    <a href="https://adult.contents.fc2.com/users/<seller>/" data-article-seller-name>NAME</a>
    <li class="items_article_StarA">… <span class="items_article_Star5">  rating (0-5)
    <a class="tag tagTag" … data-tag="TAG">
    <p>販売日 : 2025/11/23</p>
    <a href="//contents-thumbnail2.fc2.com/w1280/…" data-image-slideshow="sample-images">
    <h3>商品レビュー<span>(81)</span></h3>

Removed or unknown articles answer 200 with the title "お探しの商品が見つかりませんでした".
The sample-video API returns {"path": "<signed mp4 url>", "code": 200}; the signature expires and
only works for the User-Agent that requested it, so it is fetched on demand with the viewer's UA.
"""

import html
import re

from .fc2id import strip_code
from .net import FetchError, NotFound

BASE = "https://adult.contents.fc2.com"
NOT_FOUND_MARK = "お探しの商品が見つかりませんでした"

_OG_TITLE = re.compile(r'<meta property="og:title" content="([^"]*)"')
_MAIN_THUMB = re.compile(r'items_article_MainitemThumb.{0,400}?<img[^>]+src="([^"]+)"', re.S)
_DURATION = re.compile(r'<p class="items_article_info">\s*([\d:]+)\s*</p>')
_SELLER = re.compile(r'href="([^"]*/users/[^"]+)"[^>]*data-article-seller-name[^>]*>([^<]*)<')
_RATING = re.compile(r'items_article_StarA.{0,400}?items_article_Star(\d)', re.S)
_TAG = re.compile(r'data-tag="([^"]+)"')
_RELEASED = re.compile(r"(?:販売日|Sale Day|Release Date)\s*[:：]\s*(\d{4}/\d{1,2}/\d{1,2})")
_SAMPLE = re.compile(r'href="([^"]+)"[^>]*data-image-slideshow="sample-images"')
_REVIEWS = re.compile(r"商品レビュー\s*<span>\((\d+)\)")
_SIZE_SEGMENT = re.compile(r"/w\d+(?:h\d+)?/")


def article_url(fc2_id):
    return f"{BASE}/article/{fc2_id}/"


def _absolute(url):
    return "https:" + url if url.startswith("//") else url


def _resize(url, width):
    """contents-thumbnail2.fc2.com serves any listed width: /w276/ -> /w480/."""
    return _SIZE_SEGMENT.sub(f"/w{width}/", url, count=1)


def parse_article(page_html):
    """Parse an article page. Returns None when the article is removed or unknown."""
    title = _OG_TITLE.search(page_html)
    if NOT_FOUND_MARK in page_html[:4000] or not title:
        return None
    thumb = _MAIN_THUMB.search(page_html)
    cover = _absolute(thumb.group(1)) if thumb else ""
    seller = _SELLER.search(page_html)
    rating = _RATING.search(page_html)
    released = _RELEASED.search(page_html)
    reviews = _REVIEWS.search(page_html)
    duration = _DURATION.search(page_html)

    tags, seen = [], set()
    for tag in _TAG.findall(page_html):
        tag = html.unescape(tag)
        if tag not in seen:
            seen.add(tag)
            tags.append(tag)

    samples, seen = [], set()
    for href in _SAMPLE.findall(page_html):
        full = _absolute(html.unescape(href))
        if full not in seen:
            seen.add(full)
            samples.append({"thumb": _resize(full, 480), "full": full})

    return {
        "title": strip_code(html.unescape(title.group(1))),
        "cover": _resize(cover, 480) if cover else "",
        "cover_full": _resize(cover, 1280) if cover else "",
        "duration": duration.group(1) if duration else "",
        "seller": html.unescape(seller.group(2)).strip() if seller else "",
        "seller_url": _absolute(seller.group(1)) if seller else "",
        "rating": int(rating.group(1)) if rating else None,
        "reviews": int(reviews.group(1)) if reviews else None,
        "released": released.group(1).replace("/", "-") if released else "",
        "tags": tags,
        "samples": samples,
    }


def fetch_article(http, fc2_id):
    try:
        return parse_article(http.text(article_url(fc2_id)))
    except NotFound:
        return None


def fetch_sample_video(http, fc2_id, user_agent=None):
    """Return a freshly signed URL of the official sample video, or None.

    The signature is bound to the User-Agent that asked for it (not the IP), so pass the UA of
    whoever will play the video — another UA gets 403.
    """
    headers = {"User-Agent": user_agent} if user_agent else None
    try:
        data = http.json(f"{BASE}/api/v2/videos/{fc2_id}/sample", headers=headers)
    except NotFound:
        return None
    except ValueError as exc:            # 200 with an HTML age gate / maintenance page instead of JSON
        raise FetchError(f"Sample API did not return JSON: {exc}") from exc
    path = data.get("path") if isinstance(data, dict) else None
    return path if path and data.get("code") == 200 else None
