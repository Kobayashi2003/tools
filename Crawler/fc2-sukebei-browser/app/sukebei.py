"""sukebei.nyaa.si: search listings (with magnets) and torrent view pages (file lists).

The markup is stable and server-rendered, so it is parsed with anchored regexes:

    <tr class="default|success|danger">              success = trusted, danger = remake
      <td><a href="/?c=2_2" title="Real Life - Videos">
      <td colspan="2"><a href="/view/4732188" title="NAME">       (a "#comments" link may precede it)
      <td><a href="/download/4732188.torrent"> <a href="magnet:?xt=urn:btih:HASH&amp;dn=…">
      <td class="text-center">2.5 GiB</td>
      <td class="text-center" data-timestamp="1791486225">2026-10-08 19:03</td>
      <td class="text-center">seeders</td> <td …>leechers</td> <td …>completed</td>

Listings hold 75 rows per page and the site serves at most 1000 results per query.
"""

import html
import re
from dataclasses import asdict, dataclass
from urllib.parse import urlencode

from .fc2id import extract_id

BASE = "https://sukebei.nyaa.si"
PAGE_SIZE = 75
MAX_RESULTS = 1000
SORTS = ("id", "seeders", "leechers", "downloads", "size", "comments")
FLAGS = {"success": "trusted", "danger": "remake"}

# Extensions that have no business inside a video torrent; usually adware or worse.
RISKY_EXTENSIONS = {
    ".exe", ".scr", ".bat", ".cmd", ".com", ".msi", ".lnk", ".vbs", ".vbe", ".js", ".jse",
    ".jar", ".ps1", ".apk", ".hta", ".pif", ".wsf", ".dll", ".reg",
}

_ROW = re.compile(r'<tr class="(\w*)">(.*?)</tr>', re.S)
_CATEGORY = re.compile(r'href="/\?c=(\d+_\d+)" title="([^"]*)"')
_VIEW = re.compile(r'<a href="/view/(\d+)" title="([^"]*)"')
_MAGNET = re.compile(r'href="(magnet:\?[^"]+)"')
_CELL = re.compile(r'<td class="text-center"([^>]*)>([^<]*)</td>')
_TIMESTAMP = re.compile(r'data-timestamp="(\d+)"')
_BTIH = re.compile(r"urn:btih:([0-9a-zA-Z]+)")
_TOTAL = re.compile(r"out of ([\d,]+) results")
_NEXT = re.compile(r'<li class="next"><a href=')
_SIZE = re.compile(r"([\d.]+)\s*(Bytes|B|KiB|MiB|GiB|TiB)", re.I)
_UNITS = {"b": 1, "bytes": 1, "kib": 1024, "mib": 1024 ** 2, "gib": 1024 ** 3, "tib": 1024 ** 4}

_DESCRIPTION = re.compile(r'id="torrent-description">(.*?)</div>', re.S)
_FILE_LIST = re.compile(r'class="torrent-file-list[^"]*">(.*?)</div>', re.S)
_FILE_TOKEN = re.compile(
    r'<a[^>]*class="folder"[^>]*>(?:<i[^>]*></i>)?([^<]*)</a>'
    r'|<i class="fa fa-file"></i>([^<]*?)\s*<span class="file-size">\(([^)]*)\)</span>'
    r"|(</ul>)"
)


@dataclass
class Torrent:
    view_id: int
    name: str
    fc2_id: str | None
    infohash: str
    magnet: str
    category: str
    size_bytes: int
    uploaded_at: int
    seeders: int
    leechers: int
    downloads: int
    flag: str

    def to_dict(self):
        return asdict(self)


@dataclass
class Listing:
    torrents: list
    total: int
    has_next: bool


def search_url(query, page=1, sort="id", order="desc", category="0_0", filter_="0"):
    params = {"f": filter_, "c": category, "q": query, "s": sort if sort in SORTS else "id",
              "o": "asc" if order == "asc" else "desc"}
    if page > 1:
        params["p"] = page
    return f"{BASE}/?{urlencode(params)}"


def view_url(view_id):
    return f"{BASE}/view/{view_id}"


def torrent_url(view_id):
    return f"{BASE}/download/{view_id}.torrent"


def parse_size(text):
    match = _SIZE.search(text or "")
    if not match:
        return 0
    return int(float(match.group(1)) * _UNITS[match.group(2).lower()])


def _int(text):
    try:
        return int((text or "").strip().replace(",", ""))
    except ValueError:
        return 0


def parse_row(row_class, body):
    view = _VIEW.search(body)
    magnet = _MAGNET.search(body)
    if not view or not magnet:
        return None
    magnet_uri = html.unescape(magnet.group(1))
    infohash = _BTIH.search(magnet_uri)
    name = html.unescape(view.group(2)).strip()
    category = _CATEGORY.search(body)
    cells = _CELL.findall(body)               # size, date, seeders, leechers, completed
    if len(cells) < 5:
        return None
    timestamp = _TIMESTAMP.search(cells[1][0])
    return Torrent(
        view_id=int(view.group(1)),
        name=name,
        fc2_id=extract_id(name),
        infohash=infohash.group(1).lower() if infohash else "",
        magnet=magnet_uri,
        category=html.unescape(category.group(2)) if category else "",
        size_bytes=parse_size(cells[0][1]),
        uploaded_at=int(timestamp.group(1)) if timestamp else 0,
        seeders=_int(cells[2][1]),
        leechers=_int(cells[3][1]),
        downloads=_int(cells[4][1]),
        flag=FLAGS.get(row_class, ""),
    )


def parse_listing(page_html):
    torrents = []
    for row_class, body in _ROW.findall(page_html):
        torrent = parse_row(row_class, body)
        if torrent:
            torrents.append(torrent)
    total = _TOTAL.search(page_html)
    return Listing(
        torrents=torrents,
        total=_int(total.group(1)) if total else len(torrents),
        has_next=bool(_NEXT.search(page_html)),
    )


def is_risky(path):
    lowered = path.lower().rstrip()
    return any(lowered.endswith(ext) for ext in RISKY_EXTENSIONS)


def parse_view(page_html):
    """Return {"description": str, "files": [{"path", "size", "risky"}], "risky": bool}."""
    description = _DESCRIPTION.search(page_html)
    files = []
    block = _FILE_LIST.search(page_html)
    if block:
        folders = []
        for folder, file_name, file_size, closing in _FILE_TOKEN.findall(block.group(1)):
            if closing:
                if folders:
                    folders.pop()
            elif file_name:
                path = "/".join(folders + [html.unescape(file_name).strip()])
                files.append({"path": path, "size": html.unescape(file_size), "risky": is_risky(path)})
            else:
                folders.append(html.unescape(folder).strip())
    return {
        "description": html.unescape(description.group(1)).strip() if description else "",
        "files": files,
        "risky": any(f["risky"] for f in files),
    }
