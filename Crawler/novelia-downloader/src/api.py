"""The site's endpoints, across both of its catalogues.

Web novels (网络小说) — serialised online, one work is a stream of chapters:

    GET /api/novel?page=&pageSize=&query=&provider=&type=&level=&translate=&sort=
        Search. The only endpoint here that needs the bearer token.
    GET /api/novel/{provider}/{novelId}
        Metadata: titles, authors, introduction, table of contents.
    GET /api/novel/{provider}/{novelId}/file?mode=&translationsMode=&type=
                                            &filename=&translations=...
        The built file. 302s to a pre-rendered copy under /files-temp/.
        `filename` is not optional — without it the endpoint answers 404.

Library novels (文库小说) — published books, one work is a set of volume files:

    GET /api/wenku?page=&pageSize=&query=&level=
        Search. Needs no token, but returns only id/title/titleZh/cover.
    GET /api/wenku/{id}
        Metadata, including `volumeJp` — the Japanese volumes — and `volumeZh`.
    GET /api/wenku/{id}/file/{volumeId}?mode=&translationsMode=&filename=
                                       &translations=...
        The built file for one volume. Note there is no `type` parameter, and
        `mode=jp` does not exist here — it answers 400.
    GET /files-wenku/{id}/{volumeId}
        The uploaded Japanese book, untouched.
"""

from concurrent.futures import ThreadPoolExecutor
from typing import List, Optional, Tuple
from urllib.parse import quote, urlencode

from .models import WENKU, Novel, Volume
from .progress import Board
from .session import SessionPool, get

#: One live progress area for the process.
BOARD = Board()


class AuthRequired(Exception):
    """Search rejected the request; the token is missing or expired."""


def search(session, config, query: str) -> Tuple[List[Novel], bool]:
    """Search works. Returns (novels, truncated) — `truncated` when more pages exist."""
    novels: List[Novel] = []
    seen = set()
    truncated = False
    for page in range(0, max(1, config.pages)):          # the API is 0-based
        params = {
            "page": page,
            "pageSize": config.page_size,
            "query": query,
            "provider": ",".join(config.providers),
            "type": 0, "level": 0, "translate": 0, "sort": 0,
        }
        url = f"{config.site.rstrip('/')}/api/novel?{urlencode(params)}"
        response = get(session, url, config)
        if response is None:
            break
        if response.status_code in (401, 403):
            raise AuthRequired(
                "search needs a login token — see README (token.txt / NOVELIA_TOKEN)")
        if response.status_code != 200:
            print(f"[search] page {page + 1} failed (HTTP {response.status_code})")
            break
        payload = response.json()
        items = payload.get("items") or []
        for item in items:
            novel = _novel_from_item(item)
            if novel.key not in seen:
                seen.add(novel.key)
                novels.append(novel)
        if len(items) < config.page_size:
            break
        truncated = page + 1 >= config.pages
    return novels, truncated


def _novel_from_item(item: dict) -> Novel:
    return Novel(
        provider_id=item.get("providerId", ""),
        novel_id=item.get("novelId", ""),
        title_jp=item.get("titleJp", ""),
        title_zh=item.get("titleZh", ""),
        type=item.get("type", ""),
        attentions=item.get("attentions") or [],
        keywords=item.get("keywords") or [],
        total=item.get("total", 0),
        jp=item.get("jp", 0),
        baidu=item.get("baidu", 0),
        youdao=item.get("youdao", 0),
        gpt=item.get("gpt", 0),
        sakura=item.get("sakura", 0),
        update_at=item.get("updateAt", 0),
    )


def search_wenku(session, config, query: str) -> Tuple[List[Novel], bool]:
    """Search published books. Unlike the web-novel search this needs no token."""
    novels: List[Novel] = []
    seen = set()
    truncated = False
    for page in range(0, max(1, config.pages)):
        params = {"page": page, "pageSize": config.page_size, "query": query, "level": 0}
        url = f"{config.site.rstrip('/')}/api/wenku?{urlencode(params)}"
        response = get(session, url, config)
        if response is None:
            break
        if response.status_code in (401, 403):
            raise AuthRequired("library search was refused; the token may be expired")
        if response.status_code != 200:
            print(f"[wenku] page {page + 1} failed (HTTP {response.status_code})")
            break
        items = (response.json() or {}).get("items") or []
        for item in items:
            novel = Novel(
                provider_id="", novel_id=item.get("id", ""), kind=WENKU,
                title_jp=item.get("title", ""), title_zh=item.get("titleZh", ""),
            )
            if novel.novel_id and novel.key not in seen:
                seen.add(novel.key)
                novels.append(novel)
        if len(items) < config.page_size:
            break
        truncated = page + 1 >= config.pages
    return novels, truncated


def enrich_wenku(session, config, novels: List[Novel]) -> None:
    """Fill in volume lists for library search results.

    The library search returns only id/title/cover — no volume count, no author —
    so the selection list would have nothing useful to show. The detail endpoint
    is unauthenticated and cheap, so each result is looked up in parallel.
    """
    targets = [n for n in novels if n.kind == WENKU and not n.volumes]
    if not targets:
        return
    sessions = SessionPool(config)

    def fill(novel: Novel) -> None:
        detail = fetch_wenku_metadata(sessions.get(), config, novel.novel_id)
        if detail is not None:
            novel.volumes = detail.volumes
            novel.authors = detail.authors
            novel.publisher = detail.publisher
            novel.keywords = detail.keywords

    with ThreadPoolExecutor(max_workers=max(1, config.workers)) as pool:
        list(pool.map(fill, targets))


def fetch_wenku_metadata(session, config, novel_id: str) -> Optional[Novel]:
    """Read one published work, including its list of volumes."""
    url = f"{config.site.rstrip('/')}/api/wenku/{novel_id}"
    response = get(session, url, config)
    if response is None or response.status_code != 200:
        code = "no response" if response is None else f"HTTP {response.status_code}"
        print(f"[wenku] {novel_id} failed ({code})")
        return None
    data = response.json()
    novel = Novel(
        provider_id="", novel_id=novel_id, kind=WENKU,
        title_jp=data.get("title", ""), title_zh=data.get("titleZh", ""),
        authors=list(data.get("authors") or []),
        keywords=list(data.get("keywords") or []),
        publisher=data.get("publisher", ""),
        introduction_jp="",   # the site stores only a Chinese blurb for these
    )
    # `volumeJp` holds the Japanese originals; `volumeZh` holds Chinese-only
    # uploads, which have no Japanese side to recover and are skipped.
    for entry in (data.get("volumeJp") or []):
        novel.volumes.append(Volume(
            volume_id=entry.get("volumeId", ""),
            total=entry.get("total", 0), baidu=entry.get("baidu", 0),
            youdao=entry.get("youdao", 0), gpt=entry.get("gpt", 0),
            sakura=entry.get("sakura", 0)))
    novel.volumes.sort(key=lambda v: v.order())
    return novel


def wenku_file_url(config, novel: Novel, volume: Volume, mode: str) -> str:
    """Built file for one volume. Note there is no `type` parameter here."""
    params = [
        ("mode", mode),
        ("translationsMode", config.translations_mode),
        ("filename", f"{mode}.{volume.volume_id}"),
    ]
    for name in config.translations:
        params.append(("translations", name))
    base = config.site.rstrip("/")
    return (f"{base}/api/wenku/{novel.novel_id}/file/"
            f"{quote(volume.volume_id)}?{urlencode(params)}")


def wenku_original_url(config, novel: Novel, volume: Volume) -> str:
    """The uploaded Japanese book, untouched — the reference for verification
    and the source of the publisher's stylesheets."""
    base = config.site.rstrip("/")
    return f"{base}/files-wenku/{novel.novel_id}/{quote(volume.volume_id)}"


def download_url(session, config, url: str, destination, announce: bool = True) -> bool:
    response = get(session, url, config, stream=True, allow_redirects=True)
    if response is None:
        return False
    if response.status_code != 200:
        print(f"  FAILED  {destination.name}: HTTP {response.status_code}")
        return False
    temp = destination.with_suffix(destination.suffix + ".part")
    destination.parent.mkdir(parents=True, exist_ok=True)
    total = int(response.headers.get("Content-Length") or 0)
    try:
        written = 0
        BOARD.start(destination, destination.name, total)
        with open(temp, "wb") as handle:
            for chunk in response.iter_content(chunk_size=65536):
                if chunk:
                    handle.write(chunk)
                    written += len(chunk)
                    BOARD.update(destination, written, total)
        if written == 0:
            raise IOError("empty response")
        temp.replace(destination)
        BOARD.finish(destination,
                     f"  got     {destination.name} ({written / 1024:.0f} KB)"
                     if announce else "")
        return True
    except Exception as exc:
        BOARD.finish(destination, f"  FAILED  {destination.name}: {exc}")
        if temp.exists():
            temp.unlink()
        return False


def fetch_metadata(session, config, provider_id: str, novel_id: str) -> Optional[Novel]:
    """Read one work's detail page. Works without a token."""
    url = f"{config.site.rstrip('/')}/api/novel/{provider_id}/{novel_id}"
    response = get(session, url, config)
    if response is None or response.status_code != 200:
        code = "no response" if response is None else f"HTTP {response.status_code}"
        print(f"[meta] {provider_id}/{novel_id} failed ({code})")
        return None
    data = response.json()
    novel = Novel(
        provider_id=provider_id,
        novel_id=novel_id,
        title_jp=data.get("titleJp", ""),
        title_zh=data.get("titleZh", ""),
        type=data.get("type", ""),
        attentions=data.get("attentions") or [],
        keywords=data.get("keywords") or [],
        jp=data.get("jp", 0),
        baidu=data.get("baidu", 0),
        youdao=data.get("youdao", 0),
        gpt=data.get("gpt", 0),
        sakura=data.get("sakura", 0),
        authors=[a.get("name", "") for a in (data.get("authors") or []) if isinstance(a, dict)]
                or list(data.get("authors") or []),
        introduction_jp=data.get("introductionJp", ""),
    )
    novel.toc = data.get("toc") or []
    novel.total = sum(1 for entry in novel.toc if entry.get("chapterId"))
    return novel


def file_url(config, novel: Novel, mode: str, filename: str = "") -> str:
    filename = filename or f"{mode}.{novel.novel_id}.{config.file_type}"
    params = [
        ("mode", mode),
        ("translationsMode", config.translations_mode),
        ("type", config.file_type),
        # Required. The endpoint 404s when it is absent, which is easy to mistake
        # for an auth failure.
        ("filename", filename),
    ]
    if mode != "jp":
        # Ignored for the Japanese-only export; the site needs to know which
        # translation to pair for every other mode.
        for name in config.translations:
            params.append(("translations", name))
    base = config.site.rstrip("/")
    return f"{base}/api/novel/{novel.provider_id}/{novel.novel_id}/file?{urlencode(params)}"


def download_file(session, config, novel: Novel, mode: str, destination) -> bool:
    """Fetch one built web-novel file. No token needed."""
    return download_url(session, config, file_url(config, novel, mode), destination)
