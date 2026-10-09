"""paipancon.com "デイリーFC2": preview clips (the animated "GIF" previews), contact sheet, cover.

    https://paipancon.com/fc2daily/detail/FC2-PPV-<id>
    <h2 class="text-center">FC2-PPV-<id> - TITLE</h2>
    /fc2daily/data/FC2-PPV-<id>/{cover,grid,thumbnail_0..7}.jpg
    /fc2daily/data/FC2-PPV-<id>/<hash>.mp4                      short preview clips

The page also lists other titles' media, so URLs are anchored on this id. Unknown ids answer 404.
Titles removed from FC2 usually keep their name here but lose their media. Covers of very new
titles may be a blurred placeholder at first; refreshing later replaces them.
"""

import html
import re

from .fc2id import label, strip_code
from .net import NotFound

BASE = "https://paipancon.com"

_HEADING = re.compile(r'<h2 class="text-center">([^<]*)</h2>')


def detail_url(fc2_id):
    return f"{BASE}/fc2daily/detail/{label(fc2_id)}"


def _rank(url):
    if url.endswith(".mp4"):
        return 1000
    if "/cover." in url:
        return -2
    if "/grid." in url:
        return -1
    thumb = re.search(r"thumbnail_(\d+)\.", url)
    return int(thumb.group(1)) if thumb else 999


def parse_detail(page_html, fc2_id):
    media_re = re.compile(
        r"/fc2daily/data/" + re.escape(label(fc2_id)) + r"/[A-Za-z0-9_\-]+\.(?:jpe?g|png|webp|mp4)",
        re.IGNORECASE)
    urls = sorted({BASE + m for m in media_re.findall(page_html)}, key=lambda u: (_rank(u), u))
    heading = _HEADING.search(page_html)
    return {
        "title": strip_code(html.unescape(heading.group(1))) if heading else "",
        "cover": next((u for u in urls if "/cover." in u), ""),
        "grid": next((u for u in urls if "/grid." in u), ""),
        "thumbnails": [u for u in urls if "/thumbnail_" in u],
        "clips": [u for u in urls if u.endswith(".mp4")],
    }


def fetch_detail(http, fc2_id):
    """Return parsed media, or None when paipancon does not know this id."""
    try:
        return parse_detail(http.text(detail_url(fc2_id)), fc2_id)
    except NotFound:
        return None
