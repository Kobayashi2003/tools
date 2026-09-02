"""Configuration: defaults, config.json and ANNAS_* environment overrides."""

import json
import os
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import List, Optional

DEFAULT_MIRROR = "https://annas-archive.gl"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
)

# Best format first. Anything not listed sorts after everything listed, so a new
# exotic extension never outranks an epub.
DEFAULT_FORMAT_PRIORITY = [
    "epub", "azw3", "mobi", "fb2", "djvu", "cbz", "cbr", "pdf",
]

# Ranking keys applied in order, best first. See volumes.sort_key().
DEFAULT_RANK = ["format", "size", "date"]


@dataclass
class Config:
    mirror: str = DEFAULT_MIRROR
    output_dir: str = "downloads"
    pages: int = 1
    language: str = ""            # AA `lang` filter, e.g. "en", "zh", "ja"
    extension: str = ""           # AA `ext` filter; usually better left empty
    content: str = "book_fiction,book_nonfiction,book_unknown"
    sort: str = ""                # AA `sort`; "" = most relevant
    rank: List[str] = field(default_factory=lambda: list(DEFAULT_RANK))
    format_priority: List[str] = field(default_factory=lambda: list(DEFAULT_FORMAT_PRIORITY))
    volume_from: str = "auto"     # auto | title | publisher | filename
    volume_regex: str = ""        # user override, one capturing group
    strict: bool = True           # drop hits that miss a query token
    partial: bool = False         # include the site's "partial matches" (they
                                  # ignore the language/format filters)
    precise_date: bool = False    # fetch each candidate's "date open sourced"
    backend: str = "auto"         # auto | member | libgen | browser
    secret_key: str = ""          # Anna's Archive membership key
    browser: str = "auto"         # chrome | edge | firefox | auto
    headless: bool = False
    workers: int = 3
    timeout: int = 60
    retry: int = 3
    proxy: str = ""
    cookies_file: str = "cookies.json"
    max_alternates: int = 4       # extra candidates kept per volume, for --pick

    @classmethod
    def load(cls, path: Optional[str] = None) -> "Config":
        """Defaults, overlaid with config.json, overlaid with ANNAS_* env vars."""
        config = cls()
        config_path = Path(path or "config.json")
        if config_path.exists():
            data = json.loads(config_path.read_text(encoding="utf-8"))
            known = {f.name for f in fields(cls)}
            for key, value in data.items():
                if key in known:
                    setattr(config, key, value)

        for f in fields(cls):
            name = f"ANNAS_{f.name.upper()}"
            raw = os.environ.get(name)
            if raw is None:
                continue
            current = getattr(config, f.name)
            try:
                if isinstance(current, bool):
                    value = raw.strip().lower() in ("1", "true", "yes", "on")
                elif isinstance(current, int):
                    value = int(raw)
                elif isinstance(current, list):
                    value = [p.strip() for p in raw.split(",") if p.strip()]
                else:
                    value = raw
            except ValueError:
                # A typo in the environment should not end the run with a traceback.
                print(f"[config] ignoring {name}={raw!r}: expected {type(current).__name__}")
                continue
            setattr(config, f.name, value)

        # Proxies are usually already in the environment; honour them.
        config.proxy = config.proxy or os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or ""
        return config

    def apply_args(self, args) -> "Config":
        """Overlay non-None argparse values. CLI wins over file and env."""
        for f in fields(self):
            value = getattr(args, f.name, None)
            if value is None:
                continue
            if isinstance(getattr(self, f.name), list) and isinstance(value, str):
                value = [p.strip() for p in value.split(",") if p.strip()]
            setattr(self, f.name, value)
        return self
