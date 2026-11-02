"""GigaFile (gigafile.nu) links: checked, not fetched.

Files are kept for a limited time (7 to 100 days). The link answers 200 either way: while
the file is kept, with a download page whose links go to `download.php?file=`; once it has
expired or was deleted, with the site's upload page. A page that is neither is not
guessed at.
"""

import re
from urllib.parse import urlparse

import requests

from ...domain.links import LinkCheck
from .common import TIMEOUT, session

_PATH = re.compile(r"^/\d{4}-[0-9a-z]+")
_DOWNLOAD = re.compile(r"download\.php\?file=")
_UPLOAD_PAGE = 'id="upload_panel"'


def is_gigafile(url: str) -> bool:
    u = urlparse(url)
    host = u.netloc.lower()
    return (host == "gigafile.nu" or host.endswith(".gigafile.nu")) and bool(_PATH.match(u.path))


def judge(page: str) -> LinkCheck:
    if _DOWNLOAD.search(page):
        return LinkCheck("alive", "download page")
    if _UPLOAD_PAGE in page:
        return LinkCheck("dead", "expired or deleted (GigaFile shows its upload page)")
    return LinkCheck("unknown", "neither a download page nor the upload page")


class GigaFile:
    name = "GigaFile"

    def __init__(self, http: requests.Session | None = None):
        self.http = http or session()

    def handles(self, url: str) -> bool:
        return is_gigafile(url)

    def check(self, url: str) -> LinkCheck:
        try:
            resp = self.http.get(url, timeout=TIMEOUT)
        except requests.RequestException as e:
            return LinkCheck("unknown", f"network: {e}")
        if resp.status_code in (404, 410):
            return LinkCheck("dead", "not found")
        if resp.status_code != 200:
            return LinkCheck("unknown", f"HTTP {resp.status_code}")
        return judge(resp.text)
