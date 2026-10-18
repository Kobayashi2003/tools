"""Settings: defaults < data/config.json < `PAWCHIVE_*` environment variables.

Field names match v1 wherever v1 had the setting, so `import-v1` can carry its
config.json across and an existing `.env` keeps meaning what it meant. Fanbox
settings are new and all start with `fanbox_`.

The Fanbox session cookie is not a setting: it lives in `data/secrets.json`
(or `FANBOX_SESSID`), because config.json is meant to be shareable.
"""

import os
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

from .jsonio import read_json, write_json

PROJECT = Path(__file__).resolve().parent.parent
ENV_PREFIX = "PAWCHIVE_"
DEFAULT_PORT = 18060

SOURCE_PREFERENCES = ("pawchive-first", "fanbox-first")


class BadSetting(ValueError):
    """A setting could not be read as its declared type. Never silently defaulted."""


@dataclass
class Settings:
    download_dir: str = "downloads"

    # Pawchive. Host bases are settings because Pawchive has moved domains before.
    api_base: str = "https://pawchive.pw/api/v1"
    file_base: str = "https://file.pawchive.pw"
    # Identifiable and deliberately not a browser string: Pawchive answers a
    # browser-impersonating User-Agent with 403 on anything that reaches the origin.
    user_agent: str = "pawchive-downloader/2.0"
    page_workers: int = 4
    max_concurrent_downloads: int = 4
    max_file_requests_per_second: float = 1.0
    file_request_burst: float = 1.0
    max_download_rate: str = "0"
    download_burst: str = "0"
    daily_download_quota: str = "0"
    quota_window_hours: float = 24.0

    # Fanbox. Requests go out under your own account, so the caps are lower.
    fanbox_api: str = "https://api.fanbox.cc"
    fanbox_user_agent: str = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
    )
    fanbox_requests_per_second: float = 0.5
    fanbox_max_concurrent_downloads: int = 2
    # The browser that opens for the Fanbox sign-in; empty finds Chrome, then Edge.
    browser_path: str = ""

    # Which source a missing file is fetched from first; a creator may override it.
    source_preference: str = "pawchive-first"

    # Retries, shared shape for both sources (see net/policy.py).
    request_timeout: int = 30
    retry_delay: float = 5
    retry_backoff: float = 2.0
    retry_delay_cap: float = 60
    retry_jitter: float = 0.2
    max_retries: int = 0
    download_max_retries: int = 5
    not_found_max_retries: int = 3
    status_policies: dict | str = field(default_factory=dict)
    fanbox_status_policies: dict | str = field(default_factory=dict)

    # Pawchive materialises files lazily: a 404 is deferred, never final.
    not_found_retry_days: float = 1.0
    not_found_retry_backoff: float = 2.0
    not_found_retry_cap_days: float = 30.0

    max_concurrent_creators: int = 2
    max_concurrent_files: int = 2

    # Layout. Folder dates are UTC, matching v1's folders.
    date_format: str = "%Y.%m.%d"
    artist_folder_template: str = "{group}/{alias}/{service}"
    post_folder_template: str = "[{published}][{id}] {title}"
    file_template: str = "{idx}"
    save_content: bool = True
    rename_images_only: bool = True
    image_extensions: list[str] = field(
        default_factory=lambda: [".gif", ".jpe", ".jpeg", ".jpg", ".png", ".webp"]
    )

    global_filter: dict = field(default_factory=dict)
    global_timer: dict | None = None
    # Timers (global and per creator) fire only when this is on. Off by default so an
    # imported v1 timer cannot start a second scheduled run next to v1's own.
    timers_enabled: bool = False

    def is_image(self, name: str) -> bool:
        return Path(name).suffix.lower() in {e.lower() for e in self.image_extensions}


# Keys a creator's own `config` may override.
CREATOR_OVERRIDABLE = (
    "artist_folder_template",
    "post_folder_template",
    "file_template",
    "date_format",
    "save_content",
    "rename_images_only",
    "source_preference",
)


def _cast(name: str, value: str, declared: Any) -> Any:
    kind = declared if isinstance(declared, type) else type(declared)
    text = value.strip()
    try:
        if kind is bool:
            if text.lower() in ("1", "true", "yes", "on"):
                return True
            if text.lower() in ("0", "false", "no", "off"):
                return False
            raise ValueError(text)
        if kind is int:
            return int(float(text))
        if kind is float:
            return float(text)
    except ValueError:
        raise BadSetting(f"{ENV_PREFIX}{name.upper()}={value!r} is not a valid value") from None
    return value


class SettingsStore:
    """Loads and saves `config.json`, overlaying the environment on every load."""

    def __init__(self, data_dir: Path):
        self.path = data_dir / "config.json"
        self.secrets_path = data_dir / "secrets.json"

    def env_overrides(self) -> dict[str, str]:
        out = {}
        for f in fields(Settings):
            value = os.environ.get(ENV_PREFIX + f.name.upper())
            if value:
                out[f.name] = value
        return out

    def load(self) -> Settings:
        data = read_json(self.path, {}) or {}
        settings = Settings()
        names = {f.name: f for f in fields(Settings)}
        for key, value in data.items():
            if key in names:
                setattr(settings, key, value)
        defaults = Settings()
        for key, value in self.env_overrides().items():
            setattr(settings, key, _cast(key, value, getattr(defaults, key)))
        if settings.source_preference not in SOURCE_PREFERENCES:
            raise BadSetting(
                f"source_preference must be one of {', '.join(SOURCE_PREFERENCES)}, "
                f"got {settings.source_preference!r}"
            )
        return settings

    def save(self, changes: dict[str, Any]) -> Settings:
        """Merge `changes` into the file. Values the environment overrides stay on disk as
        they were: persisting an override would bake one machine's values into a shared file."""
        names = {f.name for f in fields(Settings)}
        unknown = set(changes) - names
        if unknown:
            raise BadSetting(f"unknown settings: {', '.join(sorted(unknown))}")
        data = read_json(self.path, {}) or {}
        data.update(changes)
        write_json(self.path, data)
        return self.load()

    def overridden(self) -> list[str]:
        return sorted(self.env_overrides())

    # ---- secrets ----

    def fanbox_sessid(self) -> str:
        env = os.environ.get("FANBOX_SESSID", "").strip()
        if env:
            return env
        return str((read_json(self.secrets_path, {}) or {}).get("fanbox_sessid") or "").strip()

    def sessid_from_env(self) -> bool:
        return bool(os.environ.get("FANBOX_SESSID", "").strip())

    def set_fanbox_sessid(self, value: str):
        data = read_json(self.secrets_path, {}) or {}
        value = value.strip()
        # Accept a pasted `FANBOXSESSID=…` cookie pair as well as the bare value.
        if value.upper().startswith("FANBOXSESSID="):
            value = value.split("=", 1)[1].split(";", 1)[0].strip()
        if value:
            data["fanbox_sessid"] = value
        else:
            data.pop("fanbox_sessid", None)
        write_json(self.secrets_path, data)


def creator_value(settings: Settings, creator_config: dict, key: str) -> Any:
    if key in CREATOR_OVERRIDABLE and key in creator_config:
        return creator_config[key]
    return getattr(settings, key)


def load_dotenv(path: Path):
    """KEY=VALUE lines into the environment; real environment variables win."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key.strip():
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
