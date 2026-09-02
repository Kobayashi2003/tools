"""Configuration: defaults, config.json and NOVELIA_* environment overrides."""

import json
import os
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import List, Optional

DEFAULT_SITE = "https://n.novelia.cc"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
)

ALL_PROVIDERS = ["kakuyomu", "syosetu", "novelup", "hameln", "pixiv", "alphapolis"]

# Machine-translation engines, best first — the same three the site's own
# download button sends. A bilingual file pairs the Japanese source with
# whichever of these exist, so the choice only affects the Chinese half, which
# the converter discards anyway. `baidu` still works if asked for explicitly.
ALL_TRANSLATIONS = ["sakura", "gpt", "youdao"]


@dataclass
class Config:
    site: str = DEFAULT_SITE
    output_dir: str = "downloads"
    token: str = ""               # JWT from the site; only /api/novel search needs it
    providers: List[str] = field(default_factory=lambda: list(ALL_PROVIDERS))
    translations: List[str] = field(default_factory=lambda: list(ALL_TRANSLATIONS))
    page_size: int = 20
    pages: int = 1
    kind: str = "both"            # both | wenku | web — which catalogue to search
    volumes: str = ""             # library volume filter, e.g. "1,3,5-8"
    # Bilingual by default: the user's stated target. `jp` is the site's own
    # Japanese-only export and needs no conversion.
    mode: str = "jp-zh"
    translations_mode: str = "priority"   # priority | parallel
    file_type: str = "epub"               # epub | txt
    convert: bool = True                  # bilingual -> Japanese only
    vertical: bool = True                 # Japanese vertical reading layout
    keep_original: bool = False           # also keep the unconverted download
    # Compare the conversion against a Japanese reference build: `mode=jp` for a
    # web novel, the publisher's uploaded original for a library volume.
    verify: bool = True
    workers: int = 3
    timeout: int = 120
    retry: int = 3
    proxy: str = ""

    @classmethod
    def load(cls, path: Optional[str] = None) -> "Config":
        """Defaults, overlaid with config.json, overlaid with NOVELIA_* env vars."""
        config = cls()
        config_path = Path(path or "config.json")
        if config_path.exists():
            try:
                data = json.loads(config_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                # A stray comma in the config should not end the run with a
                # traceback; say which file is at fault and carry on.
                print(f"[config] ignoring {config_path}: {exc}")
                data = {}
            if not isinstance(data, dict):
                print(f"[config] ignoring {config_path}: expected a JSON object")
                data = {}
            known = {f.name for f in fields(cls)}
            for key, value in data.items():
                if key in known:
                    setattr(config, key, value)

        for f in fields(cls):
            name = f"NOVELIA_{f.name.upper()}"
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
                print(f"[config] ignoring {name}={raw!r}: expected {type(current).__name__}")
                continue
            setattr(config, f.name, value)

        # A token file keeps the JWT out of shell history and out of config.json.
        if not config.token:
            token_file = Path("token.txt")
            if token_file.exists():
                config.token = token_file.read_text(encoding="utf-8").strip()

        config.proxy = config.proxy or os.environ.get("HTTPS_PROXY") or \
            os.environ.get("https_proxy") or ""
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
