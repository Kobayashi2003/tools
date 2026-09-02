#!/usr/bin/env python3
"""X (Twitter) timeline image downloader.

Scrapes a user's timeline with Playwright and downloads full-resolution images,
skipping reposts/ads and de-duplicating via a JSON log. Site: https://x.com
"""

import os
import re
import json
import random
import asyncio
from datetime import datetime

import httpx
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright, expect

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)


# ---- helpers ----

def sanitize_filename(name):
    name = re.sub(r'[\\/:*?"<>|]', "_", name)
    return re.sub(r"\s+", " ", name).strip(" .") or "_"


def load_cookies(cookies_path):
    """Load Playwright cookies from a browser-export JSON file, normalizing sameSite."""
    with open(cookies_path, "r", encoding="utf-8") as f:
        cookies = json.load(f)

    valid = {"strict": "Strict", "lax": "Lax", "none": "None"}
    normalized = []
    for cookie in cookies:
        cookie = dict(cookie)
        same_site = cookie.get("sameSite")
        if same_site is not None:
            mapped = valid.get(str(same_site).lower())
            if mapped:
                cookie["sameSite"] = mapped
            else:
                cookie.pop("sameSite", None)
        normalized.append(cookie)
    return normalized


def read_log(log_path):
    if os.path.exists(log_path):
        with open(log_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def write_log(log_path, log_data):
    with open(log_path, "w", encoding="utf-8") as f:
        json.dump(log_data, f, ensure_ascii=False, indent=2)


async def _remove_article(article):
    await article.locator("xpath=../../..").first.evaluate("(el) => el.remove()")


# ---- scraping / download ----

async def download_images(publish_images, author, publish_time, save_path):
    save_folder = os.path.join(save_path, sanitize_filename(author))
    os.makedirs(save_folder, exist_ok=True)
    date = datetime.strptime(publish_time, "%Y-%m-%dT%H:%M:%S.%fZ").strftime("%Y-%m-%d")

    async with httpx.AsyncClient() as client:
        for image in publish_images:
            image = image[:image.rfind("?")]
            image_name = image[image.rfind("/") + 1:]
            image_url = image + "?format=jpg&name=orig"
            save_name = f"{sanitize_filename(author)}_{date}_{image_name}.jpg"
            response = await client.get(image_url)
            with open(os.path.join(save_folder, save_name), "wb") as f:
                f.write(response.content)


async def scrape_timeline(context, url, cookies_path, save_path, log_path):
    await context.add_cookies(load_cookies(cookies_path))
    page = await context.new_page()
    await page.goto(url)

    while True:
        await expect(page.locator("article").nth(0)).to_be_visible(timeout=100000)
        article_count = await page.locator("article").count()

        for _ in range(article_count):
            article = page.locator("article").first
            try:
                if await article.locator('[data-testid="socialContext"]').count() > 0:
                    print("Skipping repost")
                    await _remove_article(article)
                    await asyncio.sleep(random.randint(1, 3))
                    continue

                soup = BeautifulSoup(await article.inner_html(), "lxml")
                if 'style="text-overflow: unset;">Ad</span>' in str(soup):
                    raise ValueError("This is an advertisement.")

                time_element = soup.find("time")
                publish_time = time_element.get("datetime")
                publish_url = "https://x.com" + time_element.find_parent().get("href")

                tweet_text = soup.find("div", attrs={"data-testid": "tweetText"})
                publish_content = tweet_text.get_text() if tweet_text else ""

                photos = soup.find_all("div", attrs={"data-testid": "tweetPhoto"})
                publish_images = [img.get("src") for photo in photos for img in photo.find_all("img")]

                name_spans = soup.find("div", attrs={"data-testid": "User-Name"}).find_all("span")
                author = name_spans[0].get_text() + name_spans[-2].get_text()

                print(f"Article: {publish_url} | {author} | {publish_time} | images: {len(publish_images)}")

                log_data = read_log(log_path)
                if publish_url in log_data:
                    print(f"Skipping (already logged): {publish_url}")
                    await _remove_article(article)
                    await asyncio.sleep(random.randint(1, 2))
                    continue

                log_data[publish_url] = {
                    "url": publish_url,
                    "author": author,
                    "publish_time": publish_time,
                    "content": publish_content,
                    "has_image": bool(publish_images),
                    "images": publish_images,
                    "fetched_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                }
                write_log(log_path, log_data)

                if publish_images:
                    await download_images(publish_images, author, publish_time, save_path)
            except Exception as e:
                print(f"Error: {e}")

            await _remove_article(article)
            await asyncio.sleep(random.randint(5, 10))


async def run(urls, cookies_path="cookies.json", save_path="images", log_path="log.json",
              headless=False):
    if not os.path.exists(cookies_path):
        raise FileNotFoundError(f"cookies file not found: {cookies_path}")
    os.makedirs(save_path, exist_ok=True)

    random.seed(datetime.now().timestamp())
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=headless)
        context = await browser.new_context()
        try:
            await asyncio.gather(*(
                scrape_timeline(context, url, cookies_path, save_path, log_path) for url in urls))
        finally:
            await browser.close()


# ---- CLI ----

def main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(description="X (Twitter) timeline image downloader")
    parser.add_argument("urls", nargs="+", help="Target user timeline URL(s), e.g. https://x.com/<user>")
    parser.add_argument("-c", "--cookies", default="cookies.json", help="Path to cookies.json")
    parser.add_argument("-o", "--output", default="images", help="Output directory")
    parser.add_argument("-l", "--log", default="log.json", help="Path to the dedup log file")
    parser.add_argument("--headless", action="store_true", help="Run the browser headless")
    args = parser.parse_args(argv)

    asyncio.run(run(args.urls, cookies_path=args.cookies, save_path=args.output,
                    log_path=args.log, headless=args.headless))


if __name__ == "__main__":
    main()
