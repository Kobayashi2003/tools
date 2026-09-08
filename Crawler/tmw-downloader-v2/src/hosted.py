"""What the bot's reply leads to.

Two shapes come back from a press. A **hosted** job answers with a one-time
claim on the reader the bot runs:

    https://upload.epubmanga.com:8443/read-claim/<claim>

which is consumed by POSTing to it -- once, and within about ten minutes --
and leaves a session cookie good for roughly an hour. Behind it is a page
listing the job's files, each of which streams with `Accept-Ranges`, so an
interrupted download resumes rather than restarts.

A **third-party** job answers with a link somewhere else entirely, usually
pixeldrain. Those are handed back as links; for the hosts with a direct-download
form the same downloader can fetch them, and for the rest the page offers to
open the link.

Nothing here presses anything or writes to disk: it turns a reply into a
`Claim`, and a `Claim` into a list of files.
"""

import html
import re
import time
from dataclasses import dataclass, field
from typing import List, Optional
from urllib.parse import unquote, urlparse

import requests

from .config import USER_AGENT

CLAIM_RE = re.compile(r"https?://[^\s<>\"']+/read-claim/[A-Za-z0-9_\-]+")
URL_RE = re.compile(r"https?://[^\s<>\"'`]+")
FILE_RE = re.compile(
    r'<div class="file">.*?value="(\d+)".*?<b>(.*?)</b>.*?<span>(.*?)</span>',
    re.S)
TITLE_RE = re.compile(r"<h2>(.*?)</h2>", re.S)
EXPIRY_RE = re.compile(r"Session expires in about (\d+) minute")
SIZE_RE = re.compile(r"([\d.]+)\s*(B|KiB|MiB|GiB|KB|MB|GB)", re.I)
UNITS = {"b": 1, "kib": 1024, "mib": 1024 ** 2, "gib": 1024 ** 3,
         "kb": 1000, "mb": 1000 ** 2, "gb": 1000 ** 3}

# Hosts whose share page has a direct-download form the downloader can use.
# Anything not here is still shown; it is just opened rather than fetched.
PIXELDRAIN_RE = re.compile(r"https?://pixeldrain\.com/u/([A-Za-z0-9]+)")


def _bytes(text: str) -> int:
    match = SIZE_RE.search(text or "")
    if not match:
        return 0
    return int(float(match.group(1)) * UNITS.get(match.group(2).lower(), 1))


@dataclass
class RemoteFile:
    index: int
    name: str
    size: int = 0
    url: str = ""

    def to_json(self) -> dict:
        return {"index": self.index, "name": self.name, "size": self.size}


@dataclass
class Claim:
    """A live reading session, or a set of links somewhere else."""

    job: str
    kind: str = "hosted"              # "hosted" | "external" | "unknown"
    title: str = ""
    note: str = ""                    # what the bot said, verbatim
    files: List[RemoteFile] = field(default_factory=list)
    links: List[str] = field(default_factory=list)
    session: Optional[requests.Session] = None
    opened_at: float = 0.0
    minutes: int = 0                  # the session's own estimate of its life

    @property
    def stale(self) -> bool:
        if self.kind != "hosted":
            return False
        life = (self.minutes or 60) * 60
        return (time.time() - self.opened_at) > max(300, life - 300)

    def to_json(self) -> dict:
        return {
            "job": self.job,
            "kind": self.kind,
            "title": self.title,
            "note": self.note,
            "files": [f.to_json() for f in self.files],
            "links": self.links,
            "minutes": self.minutes,
        }


def _session(config) -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    })
    if config.proxy:
        session.proxies = config.proxies
    return session


def reply_text(reply: dict) -> str:
    """Everything the bot said, message and embeds alike, as one string."""
    bits = [reply.get("content") or ""]
    for embed in reply.get("embeds") or []:
        for key in ("url", "title", "description"):
            if embed.get(key):
                bits.append(str(embed[key]))
    return "\n".join(b for b in bits if b)


def direct_url(url: str) -> str:
    """The download form of a share link, where the host has one."""
    match = PIXELDRAIN_RE.match(url or "")
    if match:
        return f"https://pixeldrain.com/api/file/{match.group(1)}?download"
    return ""


def _name_from(url: str, fallback: str) -> str:
    tail = unquote(urlparse(url or "").path.rsplit("/", 1)[-1] or "")
    return tail if "." in tail else fallback


def open_claim(config, job: str, reply: dict) -> Claim:
    """Turn the bot's reply into something with files or links in it."""
    said = reply_text(reply)
    claim = Claim(job=job, note=said.strip())

    found = CLAIM_RE.search(said)
    if found:
        return _consume(config, job, found.group(0), claim)

    links = [u.rstrip(").,") for u in URL_RE.findall(said)]
    if links:
        claim.kind = "external"
        claim.links = list(dict.fromkeys(links))
        # On pixeldrain and friends the embed titles the *file*, so it names the
        # download -- but not the folder, which belongs to the recommendation.
        # Naming the folder after the file gave `賢者の弟子/賢者の弟子 20-23.zip/`,
        # a directory wearing a .zip extension.
        named = ""
        for embed in reply.get("embeds") or []:
            if embed.get("title"):
                named = str(embed["title"])
                break
        for i, url in enumerate(claim.links):
            direct = direct_url(url)
            if direct:
                claim.files.append(RemoteFile(
                    index=i, name=named or _name_from(url, f"{job}-{i}"), url=direct))
        return claim

    claim.kind = "unknown"
    return claim


def _consume(config, job: str, url: str, claim: Claim) -> Claim:
    """Spend the one-time claim and read the listing behind it.

    One POST, and it is gone: if this fails after the claim was consumed the
    only way back is another press, so the failure says so rather than
    suggesting a retry that cannot work.
    """
    session = _session(config)
    base = f"{urlparse(url).scheme}://{urlparse(url).netloc}"

    # A refused *connection* delivered nothing, so trying again is safe and is
    # usually all this needs -- the reader drops one now and then. A failure
    # after the POST landed is not retried: the claim is one-time, and asking
    # twice would spend it and then report the second answer's refusal.
    response = None
    last = None
    for attempt in range(1, max(1, config.retry) + 1):
        try:
            response = session.post(url + "/consume",
                                    timeout=(min(15, config.timeout), config.read_timeout),
                                    allow_redirects=True)
            break
        except requests.exceptions.ConnectionError as exc:
            last = exc
            if attempt >= max(1, config.retry):
                break
            time.sleep(min(2 ** attempt, 20))
        except Exception as exc:
            raise RuntimeError(f"could not open the reading link: {exc}") from exc
    if response is None:
        raise RuntimeError(
            f"could not reach the reader at {urlparse(url).netloc} "
            f"after {config.retry} tries: {last}")
    if not response.ok:
        raise RuntimeError(f"the reading link answered HTTP {response.status_code}"
                           f" -- claims expire after about ten minutes, so press"
                           f" the button again for a fresh one")

    page = response.text
    claim.kind = "hosted"
    claim.session = session
    claim.opened_at = time.time()
    title = TITLE_RE.search(page)
    if title:
        text = html.unescape(re.sub(r"<[^>]+>", "", title.group(1)))
        # The first line, whitespace collapsed: one name for one folder.
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        claim.title = re.sub(r"\s+", " ", lines[0]) if lines else ""
    minutes = EXPIRY_RE.search(page)
    claim.minutes = int(minutes.group(1)) if minutes else 0

    # The listing names the job in its own links; trust that over the id we
    # asked with, because a claim redirects to whatever job it belongs to.
    landed = (re.search(r"/reading/([A-Za-z0-9_]+)", response.url or "")
              or re.search(r"/reading/([A-Za-z0-9_]+)", page))
    reading = landed.group(1) if landed else job

    for index, name, size in FILE_RE.findall(page):
        claim.files.append(RemoteFile(
            index=int(index),
            name=html.unescape(name).strip(),
            size=_bytes(html.unescape(size)),
            url=f"{base}/reading/{reading}/file/{int(index)}",
        ))
    if not claim.files:
        raise RuntimeError("the reading page listed no files")
    return claim
