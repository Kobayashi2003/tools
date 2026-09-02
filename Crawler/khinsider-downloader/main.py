#!/usr/bin/env python3
"""KHInsider video game music album downloader.

Downloads albums (MP3/FLAC), booklet images and multi-CD layouts. Scraping is
driven by Selenium; file downloads run concurrently. Site: https://downloads.khinsider.com
"""

import os
import re
import sys
import time
import argparse
import threading
from dataclasses import dataclass, field
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import List, Literal
from urllib.parse import urlparse

import requests
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.edge.options import Options as EdgeOptions
from selenium.webdriver.firefox.options import Options as FirefoxOptions

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
)

_print_lock = threading.Lock()


def _print(*args, **kwargs):
    with _print_lock:
        print(*args, **kwargs)


# ---- config & models ----

@dataclass
class Config:
    output_dir: str = "downloads"
    audio_format: Literal["mp3", "flac", "both"] = "both"
    browser: Literal["chrome", "edge", "firefox", "auto"] = "auto"
    headless: bool = False
    download_delay: float = 1.0
    page_delay: float = 2.0
    download_booklet: bool = True
    retry: bool = False
    max_workers: int = 4
    user_agent: str = USER_AGENT


@dataclass
class TrackInfo:
    cd_number: int
    track_number: int
    title: str
    song_page_url: str
    duration: str = ""


@dataclass
class BookletImage:
    url: str
    filename: str


@dataclass
class AlbumInfo:
    name: str
    tracks: List[TrackInfo] = field(default_factory=list)
    booklet_images: List[BookletImage] = field(default_factory=list)


# ---- helpers ----

def sanitize_filename(name: str) -> str:
    name = requests.utils.unquote(name)
    name = re.sub(r'[<>:"/\\|?*]', "_", name)
    name = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    return name[:200] or "_"


def create_session(user_agent: str = USER_AGENT) -> requests.Session:
    session = requests.Session()
    session.headers["User-Agent"] = user_agent
    return session


# ---- browser ----

_LOCALHOST_BYPASS = "localhost,127.0.0.1,::1"


def create_driver(config: Config):
    # Bypass system proxy for localhost so ChromeDriver <-> DevTools is not
    # intercepted by Clash / VPN / corporate proxies.
    for var in ("NO_PROXY", "no_proxy"):
        existing = os.environ.get(var, "")
        if _LOCALHOST_BYPASS not in existing:
            os.environ[var] = f"{existing},{_LOCALHOST_BYPASS}".lstrip(",")

    setups = {"chrome": _setup_chrome, "edge": _setup_edge, "firefox": _setup_firefox}
    if config.browser == "auto":
        for name, fn in setups.items():
            try:
                print(f"Trying {name}...")
                driver = fn(config)
                print(f"Successfully initialized {name}")
                return driver
            except Exception as e:
                print(f"Failed to initialize {name}: {e}")
        raise RuntimeError("No suitable browser found")

    if config.browser not in setups:
        raise ValueError(f"Unsupported browser: {config.browser}")
    return setups[config.browser](config)


def _setup_chromium(options, config, driver_cls):
    options.add_argument(f"--user-agent={config.user_agent}")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--no-proxy-server")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)
    if config.headless:
        options.add_argument("--headless=new")
    driver = driver_cls(options=options)
    driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
    return driver


def _setup_chrome(config: Config):
    return _setup_chromium(ChromeOptions(), config, webdriver.Chrome)


def _setup_edge(config: Config):
    return _setup_chromium(EdgeOptions(), config, webdriver.Edge)


def _setup_firefox(config: Config):
    options = FirefoxOptions()
    options.set_preference("general.useragent.override", config.user_agent)
    if config.headless:
        options.add_argument("--headless")
    return webdriver.Firefox(options=options)


# ---- scraping ----

def scrape_album(driver, url: str, config: Config) -> AlbumInfo:
    driver.get(url)
    time.sleep(config.page_delay)
    return AlbumInfo(
        name=_get_album_name(driver),
        tracks=_get_tracks(driver),
        booklet_images=_get_booklet_images(driver),
    )


def scrape_download_urls(driver, url: str, config: Config) -> List[str]:
    driver.get(url)
    time.sleep(config.page_delay)
    return _get_download_urls(driver, config.audio_format)


def _get_album_name(driver) -> str:
    try:
        return driver.find_element(By.TAG_NAME, "h2").text.strip()
    except Exception:
        return "Unknown Album"


def _has_cd_column(table) -> bool:
    try:
        header = table.find_element(By.ID, "songlist_header")
        return any("CD" in cell.text.upper() for cell in header.find_elements(By.TAG_NAME, "th"))
    except Exception:
        return False


def _get_tracks(driver) -> List[TrackInfo]:
    tracks = []
    try:
        table = driver.find_element(By.ID, "songlist")
        has_cd_col = _has_cd_column(table)
        min_cells = 5 if has_cd_col else 4

        for row in table.find_elements(By.TAG_NAME, "tr"):
            cells = row.find_elements(By.TAG_NAME, "td")
            if len(cells) < min_cells:
                continue
            try:
                if has_cd_col:
                    cd_number = int(cells[1].text.strip())
                    track_text = cells[2].text.strip()
                    title_cell, duration_cell = cells[3], cells[4]
                else:
                    cd_number = 1
                    track_text = cells[1].text.strip()
                    title_cell, duration_cell = cells[2], cells[3]

                track_number = int(track_text.rstrip("."))
                link = title_cell.find_element(By.TAG_NAME, "a")
                song_url = link.get_attribute("href")
                if not song_url or song_url.endswith("#"):
                    continue

                try:
                    duration = duration_cell.find_element(By.TAG_NAME, "a").text.strip()
                except Exception:
                    duration = duration_cell.text.strip()

                tracks.append(TrackInfo(
                    cd_number=cd_number,
                    track_number=track_number,
                    title=link.text.strip(),
                    song_page_url=song_url,
                    duration=duration,
                ))
            except Exception as e:
                print(f"Error parsing track row: {e}")
    except Exception as e:
        print(f"Error extracting tracks: {e}")
    return tracks


def _is_audio_url(url: str, audio_format: str) -> bool:
    url_lower = url.lower()
    if audio_format == "both":
        return ".mp3" in url_lower or ".flac" in url_lower
    return f".{audio_format}" in url_lower


def _get_download_urls(driver, audio_format: str) -> List[str]:
    urls, seen = [], set()

    def add(href: str):
        if href and href not in seen and _is_audio_url(href, audio_format):
            seen.add(href)
            urls.append(href)

    try:
        # Method 1: songDownloadLink spans
        for span in driver.find_elements(By.CLASS_NAME, "songDownloadLink"):
            try:
                add(span.find_element(By.XPATH, "..").get_attribute("href"))
            except Exception:
                continue

        # Method 2: known download domains
        if not urls:
            known = ["vgmsite.com", "eta.vgmtreasurechest.com", "vgmtreasurechest.com"]
            for link in driver.find_elements(By.TAG_NAME, "a"):
                href = link.get_attribute("href") or ""
                if any(d in href for d in known):
                    add(href)

        # Method 3: any audio link
        if not urls:
            print("Falling back to searching all audio links...")
            for link in driver.find_elements(By.TAG_NAME, "a"):
                href = link.get_attribute("href") or ""
                if href.startswith("http"):
                    add(href)
    except Exception as e:
        print(f"Error extracting download URLs: {e}")
    return urls


def _get_booklet_images(driver) -> List[BookletImage]:
    images = []
    try:
        for div in driver.find_elements(By.CLASS_NAME, "albumImage"):
            try:
                full_url = div.find_element(By.TAG_NAME, "a").get_attribute("href")
                if full_url:
                    images.append(BookletImage(url=full_url,
                                               filename=urlparse(full_url).path.split("/")[-1]))
            except Exception as e:
                print(f"Error processing booklet image: {e}")

        if not images:
            for table in driver.find_elements(By.TAG_NAME, "table"):
                for link in table.find_elements(By.TAG_NAME, "a"):
                    href = link.get_attribute("href") or ""
                    path = urlparse(href).path
                    if any(path.lower().endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".gif")):
                        images.append(BookletImage(url=href, filename=path.split("/")[-1]))
    except Exception as e:
        print(f"Error extracting booklet images: {e}")
    return images


# ---- download ----

def _retry_call(fn, label: str):
    """Retry fn() until it returns a truthy value. Only KeyboardInterrupt stops it."""
    attempt = 0
    while True:
        attempt += 1
        try:
            result = fn()
            if result:
                return result
            _print(f"Failed ({label}), retrying (attempt {attempt})...")
        except KeyboardInterrupt:
            raise
        except Exception as e:
            _print(f"Error ({label}) on attempt {attempt}: {e}, retrying...")


def _save_file(url: str, filepath: Path, session: requests.Session) -> bool:
    if filepath.exists():
        _print(f"Already exists: {filepath.name}")
        return True
    tmp = filepath.with_suffix(filepath.suffix + ".tmp")
    try:
        response = session.get(url, stream=True)
        response.raise_for_status()
        filepath.parent.mkdir(parents=True, exist_ok=True)
        with open(tmp, "wb") as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
        tmp.replace(filepath)
        size_mb = filepath.stat().st_size / (1024 * 1024)
        _print(f"Downloaded: {filepath.name} ({size_mb:.2f} MB)")
        return True
    except Exception as e:
        _print(f"Error downloading {url}: {e}")
        if tmp.exists():
            tmp.unlink()
        return False


def _track_filepath(output_dir, album_name, cd_number, fmt, filename, total_cds) -> Path:
    base = Path(output_dir) / sanitize_filename(album_name) / "Music" / fmt.upper()
    return (base / f"CD{cd_number}" / filename) if total_cds > 1 else (base / filename)


def _booklet_filepath(output_dir, album_name, filename) -> Path:
    return Path(output_dir) / sanitize_filename(album_name) / "Booklet" / sanitize_filename(filename)


def _download_booklets(config: Config, album: AlbumInfo):
    _print("\n=== Downloading Booklet Images ===")
    total = len(album.booklet_images)
    successful = 0

    def task(i: int, b: BookletImage) -> bool:
        _print(f"Downloading booklet image {i}/{total}: {b.filename}")
        filepath = _booklet_filepath(config.output_dir, album.name, b.filename)
        session = create_session(config.user_agent)
        if config.retry:
            _retry_call(lambda: _save_file(b.url, filepath, session), f"booklet {b.filename}")
            return True
        return _save_file(b.url, filepath, session)

    with ThreadPoolExecutor(max_workers=config.max_workers) as executor:
        futures = {executor.submit(task, i, b): b for i, b in enumerate(album.booklet_images, 1)}
        for future in as_completed(futures):
            try:
                if future.result():
                    successful += 1
            except Exception as e:
                _print(f"Booklet download error: {e}")

    _print(f"Downloaded {successful}/{total} booklet images")


def _download_tracks(config: Config, driver, album: AlbumInfo):
    _print("\n=== Downloading Music Tracks ===")
    total_tracks = len(album.tracks)

    cd_tracks: dict = {}
    for t in album.tracks:
        cd_tracks.setdefault(t.cd_number, []).append(t)
    total_cds = len(cd_tracks)
    _print(f"Album has {total_cds} CD(s)")

    # Scraping (Selenium) is sequential; file downloads run in parallel. We pipeline
    # both: a download task is submitted as soon as its URL is scraped.
    successful = 0
    completed_count = 0
    futures: dict = {}

    def download_task(track: TrackInfo, file_url: str) -> bool:
        fmt = "mp3" if ".mp3" in file_url.lower() else "flac"
        filename = f"{track.track_number:02d}. {sanitize_filename(track.title)}.{fmt}"
        filepath = _track_filepath(config.output_dir, album.name, track.cd_number,
                                   fmt, filename, total_cds)
        session = create_session(config.user_agent)
        if config.retry:
            _retry_call(lambda: _save_file(file_url, filepath, session), f"track {filename}")
            return True
        return _save_file(file_url, filepath, session)

    def drain_completed():
        nonlocal successful, completed_count
        for f in [f for f in list(futures) if f.done()]:
            completed_count += 1
            try:
                if f.result():
                    successful += 1
            except Exception as e:
                _print(f"Download error: {e}")
            _print(f"Progress: {completed_count} done")
            del futures[f]

    with ThreadPoolExecutor(max_workers=config.max_workers) as executor:
        current = 0
        for cd_number in sorted(cd_tracks):
            for track in cd_tracks[cd_number]:
                current += 1
                label = (f"CD{track.cd_number}-{track.track_number:02d}. {track.title}"
                         if total_cds > 1 else f"{track.track_number:02d}. {track.title}")
                _print(f"Scraping {current}/{total_tracks}: {label}")
                try:
                    if config.retry:
                        while True:
                            try:
                                urls = scrape_download_urls(driver, track.song_page_url, config)
                                break  # page loaded; empty list is a valid result
                            except KeyboardInterrupt:
                                raise
                            except Exception as e:
                                _print(f"Error getting URLs for track {current}: {e}, retrying...")
                    else:
                        urls = scrape_download_urls(driver, track.song_page_url, config)
                    for url in (urls or []):
                        futures[executor.submit(download_task, track, url)] = (track, url)
                    time.sleep(config.page_delay)
                except Exception as e:
                    _print(f"Error scraping track {current}: {e}")

                drain_completed()

        for f in as_completed(futures):
            completed_count += 1
            try:
                if f.result():
                    successful += 1
            except Exception as e:
                _print(f"Download error: {e}")
            _print(f"Progress: {completed_count} done")

    _print("\n=== Download Summary ===")
    _print(f"Successfully downloaded: {successful} file(s)")
    _print(f"Tracks processed: {total_tracks}")


def download_album(config: Config, album_url: str):
    driver = create_driver(config)
    try:
        _print("Extracting album information...")
        album = scrape_album(driver, album_url, config)
        _print(f"Album: {album.name}")
        _print(f"Found {len(album.tracks)} tracks, {len(album.booklet_images)} booklet images")

        if config.download_booklet and album.booklet_images:
            _download_booklets(config, album)

        if album.tracks:
            _download_tracks(config, driver, album)
        else:
            _print("No tracks found!")
    finally:
        driver.quit()


# ---- CLI ----

def main(argv=None):
    parser = argparse.ArgumentParser(description="KHInsider video game music downloader")
    parser.add_argument("url", nargs="+", help="Album URL(s) to download")
    parser.add_argument("-o", "--output", default="downloads", help="Output directory")
    parser.add_argument("-f", "--format", choices=["mp3", "flac", "both"], default="both",
                        help="Audio format to download")
    parser.add_argument("-b", "--browser", choices=["chrome", "edge", "firefox", "auto"],
                        default="auto", help="Browser to use")
    parser.add_argument("--headless", action="store_true", help="Run browser headless")
    parser.add_argument("--no-booklet", action="store_true", help="Skip booklet images")
    parser.add_argument("--retry", action="store_true", help="Retry each resource until it succeeds")
    parser.add_argument("-w", "--workers", type=int, default=4, help="Max concurrent download threads")
    args = parser.parse_args(argv)

    config = Config(
        output_dir=args.output,
        audio_format=args.format,
        browser=args.browser,
        headless=args.headless,
        download_booklet=not args.no_booklet,
        retry=args.retry,
        max_workers=args.workers,
    )

    try:
        for url in args.url:
            download_album(config, url)
    except KeyboardInterrupt:
        print("\nDownload interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
