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
UPDATE_POLICIES = ("keep", "overwrite")

# Cloud storage creators share files through.
LINK_DOMAINS = (
    "drive.google.com", "mega.nz", "mega.io", "dropbox.com", "onedrive.live.com", "1drv.ms",
    "mediafire.com", "box.com", "wetransfer.com", "anonfiles.com", "pixeldrain.com",
    "gofile.io", "bayfiles.com", "uploadhaven.com", "pan.baidu.com", "cloud.189.cn",
    "weiyun.com", "aliyundrive.com", "alipan.com", "jianguoyun.com", "115.com", "lanzou.com",
    "lanzoux.com", "lanzoui.com", "gigafile.nu",
)  # fmt: skip


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
    # Patreon, for Patreon creators: the same caps as Fanbox, for the same reason.
    patreon_api: str = "https://www.patreon.com/api"
    patreon_requests_per_second: float = 0.5
    patreon_max_concurrent_downloads: int = 2
    # Patreon's own videos are HLS streams; ffmpeg joins them into an .mp4. Empty finds it
    # on PATH.
    ffmpeg_path: str = ""
    # The browser that opens for the Fanbox or Patreon sign-in; empty finds Chrome, then Edge.
    browser_path: str = ""

    # Which source a missing file is fetched from first; a creator may override it. Fanbox
    # serves the creator's own originals.
    source_preference: str = "fanbox-first"
    # When a file already on disk comes back with other bytes (the post was updated):
    # `keep` copies the post folder aside first, named "<folder> [old <date>]", then
    # replaces the file; `overwrite` just replaces it.
    update_policy: str = "keep"

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
    # Links in a post's text worth keeping: a host or URL containing one of these. v1's
    # `links_filter.allowed_domains`.
    link_domains: list[str] = field(default_factory=lambda: list(LINK_DOMAINS))
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


CHOICES = {"source_preference": SOURCE_PREFERENCES, "update_policy": UPDATE_POLICIES}


def _check_choices(values: dict[str, Any]) -> None:
    for key, allowed in CHOICES.items():
        if key in values and values[key] not in allowed:
            raise BadSetting(f"{key} must be one of {', '.join(allowed)}, got {values[key]!r}")


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
        _check_choices(settings.__dict__)
        return settings

    def save(self, changes: dict[str, Any]) -> Settings:
        """Merge `changes` into the file. Values the environment overrides stay on disk as
        they were: persisting an override would bake one machine's values into a shared file."""
        names = {f.name for f in fields(Settings)}
        unknown = set(changes) - names
        if unknown:
            raise BadSetting(f"unknown settings: {', '.join(sorted(unknown))}")
        _check_choices(changes)
        data = read_json(self.path, {}) or {}
        data.update(changes)
        write_json(self.path, data)
        return self.load()

    def overridden(self) -> list[str]:
        return sorted(self.env_overrides())

    # ---- secrets ----

    def _secret(self, env: str, key: str) -> str:
        value = os.environ.get(env, "").strip()
        if value:
            return value
        return str((read_json(self.secrets_path, {}) or {}).get(key) or "").strip()

    def _set_secret(self, key: str, cookie: str, value: str):
        data = read_json(self.secrets_path, {}) or {}
        value = value.strip()
        # Accept a pasted `NAME=…` cookie pair as well as the bare value.
        if value.upper().startswith(cookie.upper() + "="):
            value = value.split("=", 1)[1].split(";", 1)[0].strip()
        if value:
            data[key] = value
        else:
            data.pop(key, None)
        write_json(self.secrets_path, data)

    def fanbox_sessid(self) -> str:
        return self._secret("FANBOX_SESSID", "fanbox_sessid")

    def sessid_from_env(self) -> bool:
        return bool(os.environ.get("FANBOX_SESSID", "").strip())

    def set_fanbox_sessid(self, value: str):
        self._set_secret("fanbox_sessid", "FANBOXSESSID", value)

    def patreon_session(self) -> str:
        """Patreon's `session_id` cookie."""
        return self._secret("PATREON_SESSION_ID", "patreon_session_id")

    def patreon_session_from_env(self) -> bool:
        return bool(os.environ.get("PATREON_SESSION_ID", "").strip())

    def set_patreon_session(self, value: str):
        self._set_secret("patreon_session_id", "session_id", value)


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
