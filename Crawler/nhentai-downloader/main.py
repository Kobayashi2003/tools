#!/usr/bin/env python3
"""nhentai / imhentai gallery image downloader.

Downloads sequentially numbered gallery images ({base_url}{n}.{ext}) with async
concurrency, batching and rate limiting. Site: https://nhentai.net / https://imhentai.xxx
"""

import asyncio
import json
import time
from pathlib import Path

import aiohttp
import aiofiles

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)


# ---- helpers ----

def load_cookies(cookies_file):
    """Load cookies from a JSON file (browser-export list or simple dict). Returns a dict or None."""
    path = Path(cookies_file)
    if not path.exists():
        print(f"Cookies file not found: {cookies_file}")
        return None

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        print(f"Error reading cookies file: {e}")
        return None

    if isinstance(data, list):
        cookies = {c["name"]: c["value"] for c in data if "name" in c and "value" in c}
    elif isinstance(data, dict):
        cookies = data
    else:
        print(f"Unknown cookies format in {cookies_file}")
        return None

    print(f"Loaded {len(cookies)} cookie(s) from {cookies_file}")
    return cookies


def image_url(base_url, page_num, ext):
    base = base_url if base_url.endswith("/") else base_url + "/"
    return f"{base}{page_num}.{ext}"


# ---- download ----

async def download_image(session, base_url, ext, download_dir, page_num, semaphore,
                         timeout=30, retry_times=3):
    async with semaphore:
        url = image_url(base_url, page_num, ext)
        filename = f"{page_num}.{ext}"
        filepath = download_dir / filename

        if filepath.exists():
            print(f"Skip (exists): {filename}")
            return True

        for attempt in range(retry_times):
            try:
                print(f"Downloading: {url}")
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as response:
                    if response.status == 429:
                        print("Rate limited, waiting 10s...")
                        await asyncio.sleep(10)
                        continue
                    response.raise_for_status()

                    async with aiofiles.open(filepath, "wb") as f:
                        async for chunk in response.content.iter_chunked(8192):
                            await f.write(chunk)

                print(f"OK: {filename} ({filepath.stat().st_size} bytes)")
                return True
            except Exception as e:
                print(f"Failed ({attempt + 1}/{retry_times}): {url} — {e}")
                if attempt < retry_times - 1:
                    await asyncio.sleep(5)

        print(f"Giving up on page {page_num}")
        return False


async def download_range(base_url, start_page, end_page, ext="jpg", download_dir="downloads",
                         cookies=None, max_concurrent=5, delay=1, batch_size=5, batch_delay=1):
    download_dir = Path(download_dir)
    download_dir.mkdir(parents=True, exist_ok=True)

    print(f"Pages {start_page}-{end_page} | dir: {download_dir} | "
          f"concurrency: {max_concurrent} | batch: {batch_size}")
    print("-" * 50)

    semaphore = asyncio.Semaphore(max_concurrent)
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "image/jpeg,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    connector = aiohttp.TCPConnector(limit=max_concurrent, limit_per_host=max_concurrent,
                                     keepalive_timeout=60, enable_cleanup_closed=True)

    cookie_jar = None
    if cookies:
        cookie_jar = aiohttp.CookieJar()
        cookie_jar.update_cookies(cookies)

    all_pages = list(range(start_page, end_page + 1))
    total_success = 0

    async with aiohttp.ClientSession(headers=headers, connector=connector,
                                     cookie_jar=cookie_jar) as session:
        for i in range(0, len(all_pages), batch_size):
            batch = all_pages[i:i + batch_size]
            batch_num = i // batch_size + 1
            total_batches = (len(all_pages) + batch_size - 1) // batch_size
            print(f"\nBatch {batch_num}/{total_batches} (pages {batch[0]}-{batch[-1]})")

            tasks = []
            for j, page in enumerate(batch):
                if j > 0:
                    await asyncio.sleep(delay)
                tasks.append(asyncio.create_task(
                    download_image(session, base_url, ext, download_dir, page, semaphore)))

            results = await asyncio.gather(*tasks, return_exceptions=True)
            total_success += sum(1 for r in results if r is True)

            if i + batch_size < len(all_pages):
                await asyncio.sleep(batch_delay)

    print("-" * 50)
    print(f"Done. Success: {total_success}/{len(all_pages)}")


# ---- CLI ----

def main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(description="nhentai / imhentai gallery image downloader")
    parser.add_argument("base_url", help="Gallery image base URL (e.g. https://host/path/)")
    parser.add_argument("-o", "--output", default="downloads", help="Output directory")
    parser.add_argument("-e", "--ext", default="jpg", help="Image extension (jpg, webp, png, ...)")
    parser.add_argument("-s", "--start", type=int, default=1, help="First page number")
    parser.add_argument("-n", "--end", type=int, required=True, help="Last page number")
    parser.add_argument("--cookies", default=None, help="Path to a cookies.json file")
    parser.add_argument("--concurrency", type=int, default=5, help="Max concurrent downloads")
    parser.add_argument("--delay", type=float, default=1, help="Delay between downloads in a batch (s)")
    parser.add_argument("--batch-size", type=int, default=5, help="Images per batch")
    parser.add_argument("--batch-delay", type=float, default=1, help="Delay between batches (s)")
    args = parser.parse_args(argv)

    cookies = load_cookies(args.cookies) if args.cookies else None

    start = time.time()
    asyncio.run(download_range(
        args.base_url, args.start, args.end, ext=args.ext, download_dir=args.output,
        cookies=cookies, max_concurrent=args.concurrency, delay=args.delay,
        batch_size=args.batch_size, batch_delay=args.batch_delay))
    print(f"Total time: {time.time() - start:.2f}s")


if __name__ == "__main__":
    main()
