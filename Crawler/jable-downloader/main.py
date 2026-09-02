#!/usr/bin/env python3
"""Jable.tv video downloader.

Downloads m3u8/HLS videos (with cover images) from individual video pages or every
video on a model page. Optionally distributes segment downloads across a pool of
local Clash proxy instances. Site: https://jable.tv
"""

import os
import re
import sys
import json
import time
import atexit
import argparse
import threading
import subprocess
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from bs4 import BeautifulSoup

import m3u8
import tqdm
from Crypto.Cipher import AES

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

SORT_MAP = {
    "best": "近期最佳",
    "latest": "最近更新",
    "views": "最多觀看",
    "favorites": "最高收藏",
}

MAX_WORKERS = 32   # concurrent segment downloads
MAX_RETRIES = 5    # per-segment retries
TS_TIMEOUT = 30    # per-segment request timeout (s)


# ---- helpers ----

def sanitize_filename(name):
    name = re.sub(r'[\\/:*?"<>|]', "_", name)
    name = name.strip(" .")
    return name or "_"


def is_video_url(url):
    return bool(re.match(r"https?://jable\.tv/videos/[^/]+/?$", url))


def is_artist_url(url):
    return bool(re.match(r"https?://jable\.tv/(s1/)?models/[^/]+/?$", url))


def extract_video_id(url):
    return url.rstrip("/").split("/")[-1]


# ---- config / session ----

def create_session(max_retries=3, timeout=30, proxy=None):
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    retry = Retry(total=max_retries, backoff_factor=1,
                  status_forcelist=[500, 502, 503, 504], allowed_methods=["GET"])
    adapter = HTTPAdapter(max_retries=retry, pool_maxsize=32, pool_connections=16)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.timeout = timeout
    if proxy:
        session.proxies.update(proxy)
    return session


def load_config():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_config(config):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)


def get_last_template():
    return load_config().get("template", "{video_id}")


def save_template(template):
    config = load_config()
    config["template"] = template
    save_config(config)


def get_last_input(key, default=""):
    return load_config().get("last_input", {}).get(key, default)


def save_last_input(**kwargs):
    config = load_config()
    last = config.get("last_input", {})
    last.update(kwargs)
    config["last_input"] = last
    save_config(config)


# ---- logger ----

class Logger:
    STATUS_OK = "  OK"
    STATUS_SKIP = "SKIP"
    STATUS_FAIL = "FAIL"

    def __init__(self):
        self.results = []

    def header(self, text):
        width = max(60, len(text) + 4)
        print(f'\n{"=" * width}')
        print(f"  {text}")
        print(f'{"=" * width}')

    def info(self, text):
        print(text)

    def warn(self, text):
        print(f"  [!] {text}", file=sys.stderr)

    def video_start(self, index, total, title):
        print(f"\n[{index}/{total}] {title}")

    def video_done(self, index, total, status, detail=""):
        msg = f"  [{status}] [{index}/{total}]"
        if detail:
            msg += f" {detail}"
        print(msg)

    def record(self, index, video_id, title, status, detail=""):
        self.results.append({"index": index, "video_id": video_id, "title": title,
                             "status": status, "detail": detail})

    def get_failed(self):
        return [r for r in self.results if r["status"] == self.STATUS_FAIL]

    def clear_failed(self):
        self.results = [r for r in self.results if r["status"] != self.STATUS_FAIL]

    def print_summary(self):
        if not self.results:
            return
        ok = [r for r in self.results if r["status"] == self.STATUS_OK]
        skipped = [r for r in self.results if r["status"] == self.STATUS_SKIP]
        failed = self.get_failed()
        print(f'\n{"=" * 60}')
        print(f"  Summary: {len(ok)} done, {len(skipped)} skipped, {len(failed)} failed"
              f"  (total {len(self.results)})")
        if failed:
            print(f'{"─" * 60}')
            print("  Failed:")
            for r in failed:
                print(f'    {r["video_id"]}  {r["detail"]}')
        print(f'{"=" * 60}')


# ---- clash proxy pool ----

class ClashPool:
    """Round-robin pool of local Clash proxy instances for multi-IP downloads."""

    def __init__(self, clash_exe, clash_config, num_instances=5, base_port=7890,
                 skip_keywords=None):
        self.processes = []
        self._proxies = []
        self._index = 0
        self._lock = threading.Lock()

        exe, cfg = Path(clash_exe), Path(clash_config)
        if not exe.exists():
            raise FileNotFoundError(f"Clash not found: {exe}")
        if not cfg.exists():
            raise FileNotFoundError(f"Config not found: {cfg}")

        import yaml

        skip = skip_keywords or ["DIRECT", "REJECT"]
        with open(cfg, "r", encoding="utf-8") as f:
            base = yaml.safe_load(f)

        nodes = [p for p in base.get("proxies", [])
                 if not any(k in p.get("name", "") for k in skip)]
        count = min(num_instances, len(nodes))
        if count == 0:
            print("[proxy] No usable nodes in config.")
            return

        tmp = Path("temp/clash_instances")
        tmp.mkdir(parents=True, exist_ok=True)

        for i in range(count):
            port = base_port + i * 10
            node = nodes[i]
            inst_cfg = {
                **base,
                "port": port,
                "socks-port": port + 1,
                "external-controller": f"127.0.0.1:{9090 + i}",
                "proxies": [node],
                "proxy-groups": [{"name": "PROXY", "type": "select", "proxies": [node["name"]]}],
                "rules": ["MATCH,PROXY"],
            }
            inst_file = tmp / f"clash_{i}.yaml"
            with open(inst_file, "w", encoding="utf-8") as f:
                yaml.dump(inst_cfg, f, allow_unicode=True, default_flow_style=False)
            try:
                proc = subprocess.Popen(
                    [str(exe), "-f", str(inst_file)],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
                self.processes.append(proc)
                self._proxies.append({"http": f"http://127.0.0.1:{port}",
                                      "https": f"http://127.0.0.1:{port}"})
            except Exception as e:
                print(f"[proxy] Instance {i} failed: {e}")

        if self._proxies:
            print(f"[proxy] {len(self._proxies)} instance(s) ready")
        atexit.register(self.cleanup)

    def get_proxy(self):
        if not self._proxies:
            return None
        with self._lock:
            p = self._proxies[self._index]
            self._index = (self._index + 1) % len(self._proxies)
            return p

    def size(self):
        return len(self._proxies)

    def cleanup(self):
        for proc in self.processes:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        self.processes.clear()


def load_proxy_pool(config):
    """Build a ClashPool from config['proxy']. Returns None if not configured."""
    pcfg = config.get("proxy")
    if not pcfg or not pcfg.get("clash_exe"):
        return None
    return ClashPool(
        clash_exe=pcfg["clash_exe"],
        clash_config=pcfg["clash_config"],
        num_instances=pcfg.get("num_instances", 5),
        base_port=pcfg.get("base_port", 7890),
        skip_keywords=pcfg.get("skip_keywords"),
    )


# ---- browser ----

def create_driver(proxy_url=None):
    options = Options()
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-extensions")
    options.add_argument("--headless")
    options.add_argument("--log-level=3")
    options.add_argument("--disable-logging")
    options.add_argument(f"user-agent={USER_AGENT}")
    if proxy_url:
        options.add_argument(f"--proxy-server={proxy_url}")
    options.add_experimental_option("excludeSwitches", ["enable-logging"])
    service = Service(log_output=os.devnull)
    service.creation_flags = subprocess.CREATE_NO_WINDOW
    return webdriver.Chrome(options=options, service=service)


# ---- encoder ----

def ffmpeg_encode(input_path, output_path):
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", input_path,
               "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", output_path]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        print(f'  [!] ffmpeg: {result.stderr.decode(errors="replace").strip()}')
        return False
    return True


# ---- m3u8 / segments ----

def parse_m3u8(page_source):
    urls = re.findall(r"https://[^\s\"']+\.m3u8", page_source)
    return urls[0] if urls else None


def fetch_m3u8(m3u8_url, folder_path, video_id, session=None):
    _session = session or create_session()
    if not os.path.exists(folder_path):
        os.makedirs(folder_path)
    m3u8_file = os.path.join(folder_path, f"{video_id}.m3u8")

    resp = _session.get(m3u8_url, timeout=30)
    resp.raise_for_status()
    with open(m3u8_file, "wb") as f:
        f.write(resp.content)

    m3u8_obj = m3u8.load(m3u8_file)
    base_url = "/".join(m3u8_url.split("/")[:-1])

    cipher = None
    for key in m3u8_obj.keys:
        if key:
            key_data = _session.get(base_url + "/" + key.uri, timeout=30).content
            iv = key.iv.replace("0x", "")[:16].encode()
            cipher = AES.new(key_data, AES.MODE_CBC, iv)
            break

    ts_urls = [base_url + "/" + seg.uri for seg in m3u8_obj.segments]

    os.remove(m3u8_file)
    if not os.listdir(folder_path):
        os.rmdir(folder_path)
    return ts_urls, cipher


def download_segments(ts_urls, cipher, folder_path, session=None, proxy_pool=None):
    if not os.path.exists(folder_path):
        os.makedirs(folder_path)
    _session = session or create_session()

    # Build per-proxy sessions for multi-IP distribution
    pool_sz = proxy_pool.size() if proxy_pool else 0
    if pool_sz > 1:
        sessions = [create_session(proxy=proxy_pool.get_proxy()) for _ in range(pool_sz)]
        idx = [0]
        idx_lock = threading.Lock()

        def next_session():
            with idx_lock:
                s = sessions[idx[0]]
                idx[0] = (idx[0] + 1) % len(sessions)
                return s
    else:
        def next_session():
            return _session

    def ts_path(url):
        return os.path.join(folder_path, url.split("/")[-1][:-3] + ".ts")

    pending = [u for u in ts_urls if not os.path.exists(ts_path(u))]
    skipped = len(ts_urls) - len(pending)
    if not pending:
        return 0

    pbar = tqdm.tqdm(total=len(ts_urls), initial=skipped, unit="seg",
                     bar_format="  {l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}]")
    lock = threading.Lock()
    fail_count = 0

    def worker(ts_url):
        nonlocal fail_count
        save_path = ts_path(ts_url)
        success = False
        sess = next_session()
        for _ in range(MAX_RETRIES):
            try:
                resp = sess.get(ts_url, timeout=TS_TIMEOUT)
                if resp.status_code == 200:
                    data = cipher.decrypt(resp.content) if cipher else resp.content
                    with open(save_path, "wb") as f:
                        f.write(data)
                    success = True
                    break
            except Exception:
                sess = next_session()
                continue
        with lock:
            pbar.update(1)
            if not success:
                fail_count += 1

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        list(executor.map(worker, pending))
    pbar.close()
    return fail_count


def merge_segments(ts_urls, ts_folder, output_path):
    with open(output_path, "wb") as out:
        for ts_url in ts_urls:
            ts_path = os.path.join(ts_folder, ts_url.split("/")[-1][:-3] + ".ts")
            with open(ts_path, "rb") as f:
                out.write(f.read())
    for ts_url in ts_urls:
        os.remove(os.path.join(ts_folder, ts_url.split("/")[-1][:-3] + ".ts"))
    if os.path.isdir(ts_folder) and not os.listdir(ts_folder):
        os.rmdir(ts_folder)


# ---- single video download ----

def _scrape_video_page(url, proxy_url=None):
    driver = create_driver(proxy_url=proxy_url)
    try:
        driver.get(url=url)
        page_source = driver.page_source
    finally:
        driver.quit()

    soup = BeautifulSoup(page_source, "html.parser")
    cover_meta = soup.find("meta", property="og:image")
    cover_url = cover_meta["content"] if cover_meta else None
    return cover_url, parse_m3u8(page_source)


def _download_cover(cover_url, folder_path, session):
    if not cover_url:
        return
    if not os.path.exists(folder_path):
        os.makedirs(folder_path)
    cover_path = os.path.join(folder_path, cover_url.split("/")[-1])
    if os.path.exists(cover_path):
        return
    for attempt in range(3):
        try:
            resp = session.get(cover_url, timeout=30)
            resp.raise_for_status()
            with open(cover_path, "wb") as f:
                f.write(resp.content)
            return
        except Exception as e:
            if attempt < 2:
                print(f"  [!] Cover retry ({attempt + 1}/3): {e}")
                time.sleep(2)
            else:
                print(f"  [!] Cover failed: {e}")


def download_video(url, folder_path, folder_name=None, proxy_pool=None):
    video_id = extract_video_id(url)
    folder_name = folder_name or video_id
    video_folder = os.path.join(folder_path, folder_name)

    ts_folder = os.path.join(video_folder, "ts")
    video_file = os.path.join(video_folder, video_id + ".mp4")
    encode_file = os.path.join(video_folder, "f_" + video_id + ".mp4")

    if os.path.exists(video_file):
        return "skipped"

    proxy = proxy_pool.get_proxy() if proxy_pool else None
    proxy_url = proxy.get("http") if proxy else None
    session = create_session(proxy=proxy)

    cover_url, m3u8_url = _scrape_video_page(url, proxy_url=proxy_url)
    if not m3u8_url:
        raise RuntimeError("m3u8 URL not found on page")

    _download_cover(cover_url, video_folder, session)

    ts_urls, cipher = fetch_m3u8(m3u8_url, video_folder, video_id, session=session)

    fail_count = download_segments(ts_urls, cipher, ts_folder, session=session,
                                   proxy_pool=proxy_pool)
    if fail_count:
        raise RuntimeError(f"{fail_count} segment(s) failed after retries")

    print("  Merging...", end=" ", flush=True)
    merge_segments(ts_urls, ts_folder, video_file)
    print("done.")

    print("  Encoding...", end=" ", flush=True)
    if ffmpeg_encode(video_file, encode_file):
        os.remove(video_file)
        os.rename(encode_file, video_file)
        print("done.")
    else:
        if os.path.exists(encode_file):
            os.remove(encode_file)
        print("failed (raw file kept).")
    return "ok"


# ---- artist / model page ----

def parse_videos_from_html(html):
    soup = BeautifulSoup(html, "html.parser")
    videos, seen = [], set()
    for card in soup.select(".video-img-box"):
        link = card.select_one("h6.title a") or card.select_one('a[href*="/videos/"]')
        if not link:
            continue
        href = link.get("href", "")
        if not re.match(r"https?://jable\.tv/videos/[^/]+/", href) or href in seen:
            continue
        seen.add(href)
        title_tag = card.select_one("h6.title a")
        title = title_tag.get_text(strip=True) if title_tag else href.rstrip("/").split("/")[-1]
        videos.append({"title": title, "url": href})
    return videos


def get_total_pages(html):
    soup = BeautifulSoup(html, "html.parser")
    pages = set()
    for a in soup.select("ul.pagination a"):
        match = re.search(r"/(\d+)/?$", a.get("href", ""))
        if match:
            pages.add(int(match.group(1)))
    return max(pages) if pages else 1


def apply_sort(driver, sort_key):
    sort_text = SORT_MAP.get(sort_key)
    if not sort_text:
        return
    try:
        tabs = driver.find_elements(By.LINK_TEXT, sort_text)
        if not tabs:
            print(f'Warning: Sort tab "{sort_text}" not found.')
            return
        parent = tabs[0].find_element(By.XPATH, "..")
        if "active" in (parent.get_attribute("class") or ""):
            return

        soup_before = BeautifulSoup(driver.page_source, "html.parser")
        first_el = soup_before.select_one(".video-img-box h6.title a")
        old_title = first_el.get_text(strip=True) if first_el else None

        driver.execute_script("arguments[0].click();", tabs[0])
        for _ in range(20):
            time.sleep(0.5)
            soup_after = BeautifulSoup(driver.page_source, "html.parser")
            first_after = soup_after.select_one(".video-img-box h6.title a")
            new_title = first_after.get_text(strip=True) if first_after else None
            if new_title and new_title != old_title:
                break
        else:
            time.sleep(2)
    except Exception as e:
        print(f'Warning: Could not apply sort "{sort_text}": {e}')


def collect_all_videos(url, sort_by=None, limit=None, proxy_pool=None):
    proxy = proxy_pool.get_proxy() if proxy_pool else None
    proxy_url = proxy.get("http") if proxy else None
    driver = create_driver(proxy_url=proxy_url)
    all_videos = []
    artist_name = url.rstrip("/").split("/")[-1]

    try:
        url = url.rstrip("/") + "/"
        driver.get(url)
        time.sleep(3)

        soup = BeautifulSoup(driver.page_source, "html.parser")
        h2 = soup.select_one("h2")
        if h2 and h2.get_text(strip=True):
            artist_name = h2.get_text(strip=True)

        if sort_by:
            apply_sort(driver, sort_by)

        total_pages = get_total_pages(driver.page_source)
        print(f"Found {total_pages} page(s)")

        videos = parse_videos_from_html(driver.page_source)
        all_videos.extend(videos)
        print(f"  Page 1: {len(videos)} video(s)")

        if limit and len(all_videos) >= limit:
            all_videos = all_videos[:limit]
        else:
            for page in range(2, total_pages + 1):
                driver.get(f"{url}{page}/")
                time.sleep(3)
                if sort_by:
                    apply_sort(driver, sort_by)
                videos = parse_videos_from_html(driver.page_source)
                all_videos.extend(videos)
                print(f"  Page {page}: {len(videos)} video(s)")
                if limit and len(all_videos) >= limit:
                    all_videos = all_videos[:limit]
                    break
    finally:
        driver.quit()
    return all_videos, artist_name


def _download_one(index, total, video, folder_path, template, artist_name, log, proxy_pool=None):
    video_id = extract_video_id(video["url"])
    folder_name = template.replace("{video_id}", video_id)
    folder_name = folder_name.replace("{title}", video["title"])
    folder_name = folder_name.replace("{artist}", artist_name)
    folder_name = sanitize_filename(folder_name)

    log.video_start(index, total, video["title"])
    try:
        result = download_video(video["url"], folder_path, folder_name=folder_name,
                                proxy_pool=proxy_pool)
        status = Logger.STATUS_SKIP if result == "skipped" else Logger.STATUS_OK
        log.video_done(index, total, status, folder_name if result == "skipped" else "")
        log.record(index, video_id, video["title"], status)
    except Exception as e:
        log.video_done(index, total, Logger.STATUS_FAIL, str(e))
        log.record(index, video_id, video["title"], Logger.STATUS_FAIL, str(e))


def download_artist(url, folder_path=None, sort_by=None, template=None, limit=None,
                    no_confirm=False, proxy_pool=None, log=None):
    """Collect and download every video on a model page, with an interactive retry loop."""
    log = log or Logger()
    template = template or get_last_template()
    save_template(template)
    folder_path = folder_path or os.getcwd()

    log.header("Jable Artist Downloader")
    log.info(f"  URL:      {url}")
    if sort_by:
        log.info(f"  Sort:     {SORT_MAP[sort_by]}")
    if limit:
        log.info(f"  Limit:    {limit}")
    log.info(f"  Template: {template}")
    log.info(f"  Output:   {folder_path}")
    if proxy_pool:
        log.info(f"  Proxy:    {proxy_pool.size()} node(s)")
    print()

    videos, artist_name = collect_all_videos(url, sort_by=sort_by, limit=limit,
                                             proxy_pool=proxy_pool)
    if not videos:
        print("No videos found.")
        return

    log.header(f"Found {len(videos)} video(s)")
    for i, v in enumerate(videos, 1):
        print(f'  {i:3d}. {v["title"]}')
        print(f'       {v["url"]}')

    if not no_confirm:
        if input("\nStart downloading? [y/N]: ").strip().lower() != "y":
            print("Cancelled.")
            return

    total = len(videos)
    for i, v in enumerate(videos, 1):
        _download_one(i, total, v, folder_path, template, artist_name, log, proxy_pool)
    log.print_summary()

    while log.get_failed():
        failed = log.get_failed()
        if input(f"\n{len(failed)} video(s) failed. Retry? [y/N]: ").strip().lower() != "y":
            break
        failed_ids = {r["video_id"] for r in failed}
        retry_videos = [v for v in videos if extract_video_id(v["url"]) in failed_ids]
        log.clear_failed()
        for i, v in enumerate(retry_videos, 1):
            _download_one(i, len(retry_videos), v, folder_path, template, artist_name, log, proxy_pool)
        log.print_summary()


# ---- interactive CLI ----

def _prompt(label, last="", show_last=True):
    """Prompt with a default from the last run. Enter reuses the last value."""
    if last and show_last:
        val = input(f"{label} [{last}]: ").strip()
    else:
        val = input(f"{label}: ").strip()
    return val if val else last


def _interactive_videos(proxy_pool):
    urls_input = _prompt("Enter video URL(s) (space-separated)",
                         get_last_input("video_urls", "")).split()
    if not urls_input:
        print("No URLs provided.")
        sys.exit(1)

    folder_path = _prompt("Output folder (Enter = current dir)",
                          get_last_input("video_folder", "")) or os.getcwd()
    os.makedirs(folder_path, exist_ok=True)
    save_last_input(mode="1", video_urls=" ".join(urls_input), video_folder=folder_path)

    for url in urls_input:
        if not is_video_url(url):
            print(f"Invalid jable video URL: {url}")
            continue
        print(f"\nDownloading: {url}")
        download_video(url, folder_path, proxy_pool=proxy_pool)


def _interactive_artist(proxy_pool):
    url = _prompt("Enter artist page URL", get_last_input("artist_url", ""))
    if not url:
        print("No URL provided.")
        sys.exit(1)
    if not is_artist_url(url):
        print(f"Invalid Jable artist URL: {url}")
        sys.exit(1)

    folder_path = _prompt("Output folder (Enter = current dir)", get_last_input("artist_folder", ""))
    sort_order = _prompt("Sort order (best/latest/views/favorites)", get_last_input("artist_sort", ""))
    template = _prompt("Naming template ({video_id}, {title}, {artist})",
                       get_last_input("artist_template", ""))
    limit = _prompt("Max videos to download (Enter = all)", get_last_input("artist_limit", ""))
    no_confirm = _prompt("Skip confirmation? [y/N]",
                         get_last_input("artist_no_confirm", "")).lower() == "y"

    save_last_input(mode="2", artist_url=url, artist_folder=folder_path, artist_sort=sort_order,
                    artist_template=template, artist_limit=limit,
                    artist_no_confirm="y" if no_confirm else "n")

    download_artist(
        url,
        folder_path=folder_path or None,
        sort_by=sort_order if sort_order in SORT_MAP else None,
        template=template or None,
        limit=int(limit) if limit else None,
        no_confirm=no_confirm,
        proxy_pool=proxy_pool,
    )


def main(argv=None):
    parser = argparse.ArgumentParser(description="Jable.tv video downloader")
    parser.add_argument("url", nargs="?", help="Video or model page URL (omit for interactive menu)")
    parser.add_argument("-p", "--path", default=None, help="Output folder")
    parser.add_argument("--sort", choices=list(SORT_MAP), default=None,
                        help="Model page sort order")
    parser.add_argument("--limit", type=int, default=None, help="Max videos (model pages)")
    parser.add_argument("--template", default=None,
                        help="Naming template: {video_id}, {title}, {artist}")
    parser.add_argument("--no-confirm", action="store_true", help="Skip confirmation (model pages)")
    args = parser.parse_args(argv)

    proxy_pool = load_proxy_pool(load_config())
    try:
        if args.url:
            if is_video_url(args.url):
                folder = args.path or os.getcwd()
                os.makedirs(folder, exist_ok=True)
                download_video(args.url, folder, proxy_pool=proxy_pool)
            elif is_artist_url(args.url):
                download_artist(args.url, folder_path=args.path, sort_by=args.sort,
                                template=args.template, limit=args.limit,
                                no_confirm=args.no_confirm, proxy_pool=proxy_pool)
            else:
                print(f"Unrecognized Jable URL: {args.url}")
                sys.exit(1)
        else:
            _interactive_menu(proxy_pool)
    finally:
        if proxy_pool:
            proxy_pool.cleanup()


def _interactive_menu(proxy_pool):
    print("Jable Downloader")
    print("=" * 40)
    print("  1. Download video(s) by URL")
    print("  2. Download all videos from a model page")
    print("=" * 40)

    choice = _prompt("Select mode [1/2]", get_last_input("mode", ""))
    if choice == "1":
        _interactive_videos(proxy_pool)
    elif choice == "2":
        _interactive_artist(proxy_pool)
    else:
        print("Invalid choice.")
        sys.exit(1)


if __name__ == "__main__":
    main()
