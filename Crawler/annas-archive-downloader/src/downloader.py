"""Resolve a record to a direct file URL, then fetch it.

Three ways in, tried in this order under `--backend auto`:

  member  Anna's Archive membership API (`/dyn/api/fast_download.json`). One
          request, no browser, no waitlist. Needs `--key`.
  libgen  The Libgen mirror the record's own page links to. Free, plain HTTP.
  browser Selenium drives the site's slow-download page: it clears DDoS-Guard,
          sits out the waitlist, and reads the final link. Last resort — it is
          slow and needs a real browser.
"""

import hashlib
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import List, Optional, Tuple
from urllib.parse import urljoin

from .search import fetch_detail
from .session import create_session, get

from .progress import Board

#: One live progress area for the process. Bars are rewritten in place; anything
#: printed through `_print` is flushed above them so it survives.
BOARD = Board()


def _print(*args, **kwargs):
    BOARD.write(" ".join(str(a) for a in args))


def human_size(num: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(num) < 1024 or unit == "GB":
            return f"{num:.1f}{unit}"
        num /= 1024
    return f"{num:.1f}GB"


# ---- backends ----

def resolve_member(session, config, record) -> Optional[str]:
    if not config.secret_key:
        if config.backend == "member":
            _print("[member] no membership key — pass -k / set ANNAS_SECRET_KEY, "
                   "or use --backend auto")
        return None
    url = (f"{config.mirror.rstrip('/')}/dyn/api/fast_download.json"
           f"?md5={record.md5}&key={config.secret_key}")
    response = get(session, url, config)
    if response is None:
        return None
    try:
        payload = response.json()
    except ValueError:
        _print(f"[member] {record.md5}: unexpected response (HTTP {response.status_code})")
        return None
    if payload.get("download_url"):
        return payload["download_url"]
    _print(f"[member] {record.md5}: {payload.get('error') or 'no download_url'}")
    return None


def resolve_libgen(session, config, record) -> Optional[str]:
    """Follow the record's Libgen mirror to the keyed `get.php` URL."""
    detail = fetch_detail(session, config, record.md5)
    pages = [m for m in detail.get("mirrors", []) if "libgen" in m or "library.lol" in m]
    # ads.php is the page that mints the download key; try it even when the
    # record only links to a fiction/index page on the same host.
    pages.insert(0, f"https://libgen.li/ads.php?md5={record.md5}")

    for page_url in pages:
        response = get(session, page_url, config, allow_redirects=True,
                       headers={"Referer": record.url(config.mirror)})
        if response is None or response.status_code != 200:
            continue
        match = re.search(r'href=["\']((?:[^"\']*/)?get\.php\?[^"\']+)["\']', response.text)
        if match:
            return urljoin(response.url, match.group(1).replace("&amp;", "&"))
        # library.lol and some mirrors expose the file link directly.
        match = re.search(r'href=["\'](https?://[^"\']+/main/[^"\']+)["\']', response.text)
        if match:
            return match.group(1).replace("&amp;", "&")
    return None


def resolve_browser(config, record, driver_holder) -> Optional[str]:
    """Drive the site's slow-download page with Selenium and read the final link."""
    # One browser, one page at a time: concurrent driver.get() calls on a shared
    # driver interleave, and a thread then reads the link off another thread's
    # page — which silently downloads the wrong book.
    with driver_holder.driving():
        return _resolve_browser(config, record, driver_holder)


def _resolve_browser(config, record, driver_holder) -> Optional[str]:
    driver = driver_holder.get()
    if driver is None:
        return None
    base = config.mirror.rstrip("/")
    _print(f"[browser] {record.md5}: waiting on the slow-download page (verification + "
           "countdown, up to a few minutes) — finish any challenge in the window if one appears")
    deadline = time.time() + RECORD_BUDGET
    for server in range(0, 6):
        if time.time() >= deadline:
            _print(f"[browser] {record.md5}: gave up after {RECORD_BUDGET}s")
            return None
        url = f"{base}/slow_download/{record.md5}/0/{server}"
        try:
            driver.get(url)
        except Exception as exc:
            # A timeout here is one dead server, not a dead run — try the next.
            _print(f"[browser] {record.md5}: server #{server + 1}: "
                   f"{type(exc).__name__}")
            continue
        link = _wait_for_download_link(driver, config, base,
                                       limit=max(10, int(deadline - time.time())))
        if link:
            return link
        _print(f"[browser] {record.md5}: server #{server + 1} gave nothing, trying the next one")
    return None


_FILE_HREF_RE = re.compile(r'\.(epub|pdf|mobi|azw3|cbz|cbr|djvu|fb2|zip|txt)(\?|$)', re.I)


def _wait_for_download_link(driver, config, base, limit: int = 300) -> Optional[str]:
    """The page holds a countdown (and sometimes a DDoS-Guard check) before it
    swaps in the real link, so poll until an off-site file link shows up."""
    from selenium.webdriver.common.by import By

    deadline = time.time() + limit
    while time.time() < deadline:
        try:
            elements = (driver.find_elements(By.CSS_SELECTOR, "a.js-download-link[href]")
                        or driver.find_elements(By.CSS_SELECTOR, "a[href]"))
            for element in elements:
                href = element.get_attribute("href") or ""
                if not href or href.startswith(base) or href.startswith("/"):
                    continue
                text = (element.text or "").lower()
                if "download now" in text or _FILE_HREF_RE.search(href):
                    return href
        except Exception:
            pass
        time.sleep(2)
    return None


class DriverHolder:
    """Lazily creates one Selenium driver. `driving()` serializes use of it — the
    slow-download flow is inherently serial anyway."""

    def __init__(self, config):
        self.config = config
        self.lock = threading.Lock()
        self.drive_lock = threading.Lock()
        self._driver = None
        self._failed = False

    def driving(self):
        return self.drive_lock

    def get(self):
        with self.lock:
            if self._driver is None and not self._failed:
                try:
                    self._driver = _create_driver(self.config)
                except Exception as exc:
                    self._failed = True
                    _print(f"[browser] could not start a browser: {exc}")
            return self._driver

    def quit(self):
        with self.lock:
            if self._driver is not None:
                try:
                    self._driver.quit()
                except Exception:
                    pass
                self._driver = None


#: Longest any single browser page load may take.
PAGE_TIMEOUT = 90
#: Longest the browser backend may spend on one record, across all its servers.
RECORD_BUDGET = 420

_LOCALHOST_BYPASS = "localhost,127.0.0.1,::1"


def _create_driver(config):
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options as ChromeOptions
    from selenium.webdriver.edge.options import Options as EdgeOptions
    from selenium.webdriver.firefox.options import Options as FirefoxOptions

    # Bypass the system proxy for localhost so the driver <-> DevTools channel is
    # not intercepted by Clash / VPN / corporate proxies.
    for var in ("NO_PROXY", "no_proxy"):
        existing = os.environ.get(var, "")
        if _LOCALHOST_BYPASS not in existing:
            os.environ[var] = f"{existing},{_LOCALHOST_BYPASS}".lstrip(",")

    def arm(driver):
        """Nothing here may block forever.

        Selenium waits on the browser with no deadline by default, so a driver
        whose browser never came up leaves the whole run parked — a batch of this
        stalled for hours on one dead chromedriver with no output at all.
        """
        driver.set_page_load_timeout(PAGE_TIMEOUT)
        driver.set_script_timeout(PAGE_TIMEOUT)
        return driver

    def chromium(options, driver_cls):
        options.add_argument("--disable-blink-features=AutomationControlled")
        options.add_experimental_option("excludeSwitches", ["enable-automation"])
        options.add_experimental_option("useAutomationExtension", False)
        if config.headless:
            options.add_argument("--headless=new")
        driver = arm(driver_cls(options=options))
        driver.execute_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        return driver

    def firefox():
        options = FirefoxOptions()
        if config.headless:
            options.add_argument("--headless")
        return arm(webdriver.Firefox(options=options))

    setups = {
        "chrome": lambda: chromium(ChromeOptions(), webdriver.Chrome),
        "edge": lambda: chromium(EdgeOptions(), webdriver.Edge),
        "firefox": firefox,
    }
    if config.browser != "auto":
        return setups[config.browser]()
    errors = []
    for name, setup in setups.items():
        try:
            return setup()
        except Exception as exc:
            errors.append(f"{name}: {exc}")
    raise RuntimeError("; ".join(errors))


# ---- driving ----

def resolve(session, config, record, driver_holder) -> Tuple[Optional[str], str]:
    order = ({"member": ["member"], "libgen": ["libgen"], "browser": ["browser"]}
             .get(config.backend, ["member", "libgen", "browser"]))
    for name in order:
        if name == "member":
            url = resolve_member(session, config, record)
        elif name == "libgen":
            url = resolve_libgen(session, config, record)
        else:
            url = resolve_browser(config, record, driver_holder)
        if url:
            return url, name
    return None, ""


def save(session, config, url: str, path: Path, expected: int = 0,
         expect_md5: str = "") -> bool:
    if path.exists() and path.stat().st_size > 0:
        _print(f"  exists  {path.name}")
        return True
    temp = path.with_suffix(path.suffix + ".part")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        response = get(session, url, config, stream=True, allow_redirects=True)
        if response is None:
            return False
        response.raise_for_status()
        total = int(response.headers.get("Content-Length") or expected or 0)
        written = 0
        digest = hashlib.md5()
        BOARD.start(path, path.name, total)
        with open(temp, "wb") as handle:
            for chunk in response.iter_content(chunk_size=65536):
                if not chunk:
                    continue
                handle.write(chunk)
                digest.update(chunk)
                written += len(chunk)
                BOARD.update(path, written, total)
        if total and written < total * 0.98:
            raise IOError(f"truncated: {written} of {total} bytes")
        # Anna's Archive keys every record by the file's own md5, so this catches
        # a mirror that answered with the wrong book.
        if expect_md5 and digest.hexdigest() != expect_md5.lower():
            raise IOError(f"wrong file: md5 {digest.hexdigest()} != {expect_md5}")
        temp.replace(path)
        BOARD.finish(path, f"  saved   {path.name} ({human_size(written)})")
        return True
    except Exception as exc:
        BOARD.finish(path, f"  FAILED  {path.name}: {exc}")
        if temp.exists():
            temp.unlink()
        return False


def download_all(session, config, picks: List[Tuple[object, Path]]) -> Tuple[int, int]:
    """`picks` is a list of (record, destination path). Returns (ok, total)."""
    driver_holder = DriverHolder(config)
    # Libgen mints the download key against a session cookie, not just the md5 in
    # the URL, so threads sharing one cookie jar overwrite each other and get
    # handed somebody else's book. Every worker gets its own session.
    local = threading.local()

    def worker_session():
        if not hasattr(local, "session"):
            local.session = create_session(config)
        return local.session

    # Two picks writing to one path would let the second silently inherit the
    # first one's file and report success. The caller is expected to hand over
    # unique paths; refuse the batch rather than lose a file quietly.
    clashes = _duplicate_paths(picks)
    if clashes:
        for path, count in clashes:
            _print(f"  FAILED  {path.name}: {count} records map to this same path")
        return 0, len(picks)

    ok = 0
    try:
        def task(item):
            record, path = item
            try:
                if path.exists() and path.stat().st_size > 0:
                    _print(f"  exists  {path.name}")
                    return True
                own = worker_session()
                url, backend = resolve(own, config, record, driver_holder)
                if not url:
                    _print(f"  FAILED  {path.name}: no download link found "
                           f"({record.md5})")
                    return False
                _print(f"  via {backend}: {path.name}")
                return save(own, config, url, path, record.size, record.md5)
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                # One bad record must not take the rest of the batch with it.
                _print(f"  FAILED  {path.name}: {type(exc).__name__}: {exc}")
                return False

        with ThreadPoolExecutor(max_workers=max(1, config.workers)) as pool:
            for result in pool.map(task, picks):
                ok += bool(result)
    finally:
        driver_holder.quit()
    return ok, len(picks)


def _duplicate_paths(picks) -> List[Tuple[Path, int]]:
    counts = {}
    for _, path in picks:
        key = str(path).casefold()  # Windows paths are case-insensitive
        counts.setdefault(key, [path, 0])[1] += 1
    return [(path, count) for path, count in counts.values() if count > 1]
