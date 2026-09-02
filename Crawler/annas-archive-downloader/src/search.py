"""Search Anna's Archive and parse the result list.

The site renders each hit as one block holding a title link, an original
filename, author/publisher links and a single metadata line that looks like:

    English [en] · EPUB · 14.2MB · 2019 · 📕 Book (fiction) · 🚀/lgli/lgrs/zlib

Fields in that line are optional and their order is not guaranteed, so each
token is classified by shape rather than by position.
"""

import re
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlencode

from bs4 import BeautifulSoup

from .models import Record
from .session import get

_SIZE_RE = re.compile(r'^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$', re.I)
_YEAR_RE = re.compile(r'^(1[5-9]\d\d|20\d\d)$')
_LANG_RE = re.compile(r'\[[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)?\]')
_EXT_RE = re.compile(r'^[A-Za-z][A-Za-z0-9]{1,5}$')
_MD5_RE = re.compile(r'/md5/([a-f0-9]{32})')
_UNITS = {"B": 1, "KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3, "TB": 1024 ** 4}

# Anna's Archive hides the "partial matches" block inside an HTML comment and
# unwraps it in JS. Unwrap it ourselves so those hits are searchable too.
_COMMENT_RE = re.compile(r'<!--(.*?)-->', re.S)


def search(session, config, query: str) -> Tuple[List[Record], int]:
    """Fetch `config.pages` pages of results. Returns (records, partial_dropped).

    Partial matches are excluded unless `config.partial` is set — they are the
    hits the site itself ruled out under the active filters."""
    records: List[Record] = []
    seen = set()
    dropped_seen = set()
    for page in range(1, max(1, config.pages) + 1):
        url = build_url(config, query, page)
        response = get(session, url, config)
        if response is None or response.status_code != 200:
            code = "no response" if response is None else f"HTTP {response.status_code}"
            print(f"[search] page {page} failed ({code})")
            break
        page_records = parse_results(response.text)
        if not page_records:
            break
        # Count every real result the page carried, not just the ones new to us:
        # a page that merely repeats a few earlier hits is still a full page, and
        # treating it as short would stop paging early.
        primary_on_page = 0
        for record in page_records:
            if not record.partial:
                primary_on_page += 1
            if record.md5 in seen:
                continue
            if record.partial and not config.partial:
                dropped_seen.add(record.md5)  # a set, so re-listings don't inflate
                continue
            seen.add(record.md5)
            records.append(record)
        if primary_on_page < 50:  # a short page of real results is the last page
            break
    return records, len(dropped_seen)


def build_url(config, query: str, page: int = 1) -> str:
    params = [("q", query)]
    if config.language:
        params.append(("lang", config.language))
    if config.extension:
        params.append(("ext", config.extension))
    if config.sort:
        params.append(("sort", config.sort))
    for value in (config.content or "").split(","):
        if value.strip():
            params.append(("content", value.strip()))
    if page > 1:
        params.append(("page", str(page)))
    return f"{config.mirror.rstrip('/')}/search?{urlencode(params)}"


def parse_results(html: str) -> List[Record]:
    """Every hit on the page, each tagged `partial` or not.

    A search page holds the real results in the first list, then — behind a
    "Show N partial matches" toggle, sometimes inside an HTML comment — the hits
    that failed the language/format/content filters. Merging the two silently
    undoes `--language`, so later lists are tagged instead of dropped and the
    caller decides.
    """
    html = _COMMENT_RE.sub(
        lambda m: m.group(1) if "js-aarecord-list-outer" in m.group(1) else "", html)
    soup = BeautifulSoup(html, "html.parser")

    records: List[Record] = []
    for index, outer in enumerate(soup.select(".js-aarecord-list-outer")):
        for block in outer.find_all("div", recursive=False):
            record = _parse_block(block)
            if record is not None:
                record.partial = index > 0
                records.append(record)
    return records


def _parse_block(block) -> Optional[Record]:
    link = block.select_one('a.js-vim-focus[href^="/md5/"]')
    if link is None:
        return None
    match = _MD5_RE.search(link.get("href", ""))
    if match is None:
        return None

    record = Record(md5=match.group(1), title=link.get_text(" ", strip=True))

    filename_el = block.select_one("div.font-mono")
    if filename_el is not None:
        record.filename = filename_el.get_text(" ", strip=True)

    for anchor in block.select('a[href^="/search?q="]'):
        text = anchor.get_text(" ", strip=True)
        if anchor.select_one('[class*="mdi--user-edit"]'):
            record.author = text
        elif anchor.select_one('[class*="mdi--company"]'):
            record.publisher = text

    _apply_meta(record, _find_meta_line(block))
    return record


def _direct_text(element) -> str:
    """Text belonging to this element only, ignoring nested tags."""
    return " ".join(s.strip() for s in element.find_all(string=True, recursive=False) if s.strip())


def _find_meta_line(block) -> str:
    """The shortest own-text that carries a filesize — the metadata line."""
    best = ""
    for div in block.find_all("div"):
        text = _direct_text(div)
        if "·" in text and re.search(r'\d+(\.\d+)?\s*[KMGT]?B\b', text):
            if not best or len(text) < len(best):
                best = text
    return best


_SOURCE_BODY_RE = re.compile(r'[a-z0-9_.]+(?:/[a-z0-9_.]+)*')


def _is_sources(token: str, have_extension: bool = False) -> bool:
    """The collection list — `🚀/lgli/lgrs/zlib`, `lgli/zlib`.

    A slash alone is not enough: content types carry one too ("📕 Comic/Manga",
    "Magazine/Journal"), and swallowing those as sources both loses the real
    source list and breaks the 🚀 fast-download flag.
    """
    body = token.replace("🚀", "").strip().strip("/")
    if "🚀" not in token and "/" not in token:
        # A lone collection name ("lgli"). Only once the extension slot is filled,
        # since both look like a bare word — but the site writes formats upper
        # case (EPUB, FB2) and collections lower case.
        return have_extension and body.islower() and _SOURCE_BODY_RE.fullmatch(body) is not None
    if not body:
        return "🚀" in token
    return _SOURCE_BODY_RE.fullmatch(body) is not None


def _apply_meta(record: Record, meta: str) -> None:
    for token in (t.strip() for t in meta.split("·")):
        if not token:
            continue
        size = _SIZE_RE.match(token)
        if size and not record.size:
            record.size = int(float(size.group(1)) * _UNITS[size.group(2).upper()])
            record.size_text = token
            continue
        if _YEAR_RE.match(token) and record.year is None:
            record.year = int(token)
            continue
        if _LANG_RE.search(token):
            # A record can carry several ("Russian [ru] · Japanese [ja] · FB2 …");
            # keeping only the first mislabels bilingual scans.
            record.language = f"{record.language}, {token}" if record.language else token
            continue
        if _is_sources(token, bool(record.extension)):
            record.sources = record.sources or token
            continue
        if _EXT_RE.match(token) and not record.extension:
            record.extension = token.lower()
            continue
        if not record.content_type:
            record.content_type = token


# ---- detail page ----

_DATE_RE = re.compile(r'date open sourced\s*(\d{4}-\d{2}-\d{2})', re.I)
_EXTERNAL_HOSTS = ("libgen.li", "libgen.is", "libgen.rs", "libgen.st", "libgen.pw",
                   "library.lol", "z-library")


def fetch_detail(session, config, md5: str) -> Dict:
    """Read one /md5/ page for its open-source date and external mirror links."""
    response = get(session, f"{config.mirror.rstrip('/')}/md5/{md5}", config)
    if response is None or response.status_code != 200:
        return {}
    html = response.text
    text = re.sub(r'<[^>]+>', ' ', re.sub(r'<script.*?</script>', ' ', html, flags=re.S))
    text = re.sub(r'\s+', ' ', text)
    date_match = _DATE_RE.search(text)

    mirrors = []
    for href in re.findall(r'href="(https?://[^"]+)"', html):
        if any(host in href for host in _EXTERNAL_HOSTS) and md5.lower() in href.lower():
            if href not in mirrors:
                mirrors.append(href)
    return {"date_added": date_match.group(1) if date_match else "", "mirrors": mirrors}
