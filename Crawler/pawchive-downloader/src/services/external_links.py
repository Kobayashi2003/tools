import re
import subprocess
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional
from urllib.parse import urlparse

from ..core.cache import Cache
from ..common import env
from ..common.logger import Logger
from ..core.models import ExternalLink


def make_link_filter(cfg: Mapping) -> Optional[Callable[[ExternalLink], bool]]:
    """Link predicate built from the `links_filter` config section; None when
    the section is empty (no filtering).

    Keys, all optional:
        allowed_domains   keep only links whose domain/url contains one of these
        reviewed_artists  hide these artists' links -- they were already gone
                          through -- except posts newer than `reviewed_before`,
                          so newly published links still surface
        reviewed_before   the review cutoff date (ISO); without it a reviewed
                          artist's links are hidden entirely
    """
    domains = list(cfg.get('allowed_domains') or [])
    reviewed = set(cfg.get('reviewed_artists') or [])
    cutoff = cfg.get('reviewed_before') or ''
    if not domains and not reviewed:
        return None

    def allowed(link: ExternalLink) -> bool:
        if domains and not any(d in link.domain or d in link.url for d in domains):
            return False
        if link.artist_id in reviewed:
            # `edited` moves forward when a post is updated with a new link.
            date = link.post_edited or link.post_published
            return bool(cutoff and date and date > cutoff)
        return True

    return allowed


class ExternalLinksExtractor:
    """Pull URLs out of cached post content (e.g. mega/gdrive share links)."""

    # Only ASCII URL characters (RFC 3986). A real URL is ASCII; anything else
    # is percent-encoded. Allowing non-ASCII let the match run past the link
    # into the Japanese text that follows it with no separating space, producing
    # a malformed host that urlparse then rejects under NFKC normalization.
    URL_PATTERN = r"https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+"

    def __init__(self, cache: Cache, logger: Logger):
        self.cache = cache
        self.logger = logger

    def extract_from_artist(self, artist_id: str, match: Optional[str] = None,
                            unique: bool = True,
                            filter_func: Optional[Callable[[ExternalLink], bool]] = None
                            ) -> List[ExternalLink]:
        links: Dict[str, ExternalLink] = {}
        ordered: List[ExternalLink] = []
        for post in self.cache.load_posts(artist_id):
            if not post.content:
                continue
            for url in self._urls(post.content, match):
                if unique and url in links:
                    continue
                scheme, netloc = self._parse(url)
                domain = netloc[4:] if netloc.startswith('www.') else netloc
                link = ExternalLink(
                    url=url, domain=domain or 'unknown', protocol=scheme,
                    post_id=post.id, post_title=post.title, post_published=post.published,
                    post_edited=post.edited, artist_id=artist_id,
                )
                if filter_func and not filter_func(link):
                    continue
                if unique:
                    links[url] = link
                ordered.append(link)
        return list(links.values()) if unique else ordered

    def statistics(self, links: List[ExternalLink]) -> Dict:
        domains: Dict[str, int] = {}
        posts, artists = set(), set()
        for link in links:
            domains[link.domain] = domains.get(link.domain, 0) + 1
            posts.add(link.post_id)
            artists.add(link.artist_id)
        top = dict(sorted(domains.items(), key=lambda x: x[1], reverse=True)[:10])
        return {'total_links': len(links), 'unique_domains': len(domains),
                'unique_posts': len(posts), 'unique_artists': len(artists), 'top_domains': top}

    def _urls(self, text: str, match: Optional[str]) -> List[str]:
        urls = re.findall(self.URL_PATTERN, text)
        if match:
            try:
                pat = re.compile(match, re.IGNORECASE)
                urls = [u for u in urls if pat.search(u)]
            except re.error as e:
                self.logger.error(f"Invalid regex '{match}': {e}")
                return []
        return urls

    @staticmethod
    def _parse(url: str):
        """`(scheme, netloc)`, never raising.

        urlparse rejects a netloc that changes under NFKC normalization (a
        homograph guard). Fall back to a plain prefix split so one odd URL can't
        abort the whole extraction.
        """
        try:
            p = urlparse(url)
            return p.scheme, p.netloc
        except ValueError:
            m = re.match(r'(https?)://([^/?#]*)', url)
            return (m.group(1), m.group(2)) if m else ('', '')


class ExternalLinksDownloader:
    """Download extracted links via external tools (Google Drive through gdown)."""

    def __init__(self, logger: Logger, out_dir: str = None):
        self.logger = logger
        self.out_dir = Path(out_dir or env.get('CLOUD_DIR', 'cloud'))
        self.gdown = env.get('GDOWN_BIN', 'gdown')

    @staticmethod
    def _gdrive_id(url: str) -> Optional[str]:
        for pattern in (r"/file/d/([^/]+)", r"[?&]id=([^&]+)", r"/folders/([^/?#]+)",
                        r"/drive/folders/([^/?#]+)", r"/embeddedfolderview\?id=([^&]+)"):
            m = re.search(pattern, url)
            if m:
                return m.group(1)
        return None

    def _download_gdrive(self, url: str):
        file_id = self._gdrive_id(url)
        if not file_id:
            raise ValueError("Could not extract a Google Drive id from URL")
        base = self.out_dir / "google_drive" / file_id
        base.mkdir(parents=True, exist_ok=True)
        is_folder = any(p in url for p in ("/folders/", "/drive/folders/", "embeddedfolderview"))
        if is_folder:
            subprocess.run([self.gdown, "--folder", f"https://drive.google.com/drive/folders/{file_id}"],
                           cwd=base, check=True)
        else:
            subprocess.run([self.gdown, f"https://drive.google.com/uc?export=download&id={file_id}"],
                           cwd=base, check=True)

    def download_gdrive_links(self, urls: List[str]):
        total, ok, fail = len(urls), 0, 0
        for i, url in enumerate(urls, 1):
            print(f"[{i}/{total}] {url}")
            try:
                self._download_gdrive(url)
                print("  ✓ done")
                ok += 1
            except FileNotFoundError:
                print("  ✗ 'gdown' not installed. Run: pip install gdown")
                return
            except Exception as e:
                print(f"  ✗ {e}")
                fail += 1
        print(f"\nDone: {ok} succeeded, {fail} failed.")
