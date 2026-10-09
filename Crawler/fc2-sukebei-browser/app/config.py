"""Runtime settings, read from environment variables and an optional `.env` file."""

import os
from dataclasses import dataclass
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent


def load_dotenv(path=PROJECT / ".env"):
    """Fill os.environ from KEY=VALUE lines; real environment variables win."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _float(name, default):
    value = os.environ.get(name, "").strip()
    return float(value) if value else default


def _int(name, default):
    value = os.environ.get(name, "").strip()
    return int(value) if value else default


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    port: int = 18050
    proxy: str | None = None          # None: requests honours HTTP(S)_PROXY on its own
    workers: int = 3                  # parallel metadata lookups
    sukebei_delay: float = 1.5        # seconds between requests to sukebei
    source_delay: float = 0.5         # seconds between page requests to FC2
    paipancon_delay: float = 6.0      # paipancon answers HTTP 429 above ~10 pages per minute
    watch_minutes: int = 30           # run Update when the last one is older than N minutes (0 = off)
    default_query: str = "FC2"

    def host_delays(self):
        return {"sukebei.nyaa.si": self.sukebei_delay, "paipancon.com": self.paipancon_delay}

    @classmethod
    def from_env(cls):
        load_dotenv()
        data_dir = Path(os.environ.get("FC2SB_DATA_DIR") or PROJECT / "data")
        if not data_dir.is_absolute():
            data_dir = PROJECT / data_dir
        return cls(
            data_dir=data_dir,
            port=_int("FC2SB_PORT", 18050),
            proxy=os.environ.get("FC2SB_PROXY", "").strip() or None,
            workers=max(1, _int("FC2SB_WORKERS", 3)),
            sukebei_delay=max(0.0, _float("FC2SB_SUKEBEI_DELAY", 1.5)),
            source_delay=max(0.0, _float("FC2SB_SOURCE_DELAY", 0.5)),
            paipancon_delay=max(0.0, _float("FC2SB_PAIPANCON_DELAY", 6.0)),
            watch_minutes=max(0, _int("FC2SB_WATCH_MINUTES", 30)),
            default_query=os.environ.get("FC2SB_DEFAULT_QUERY", "").strip() or "FC2",
        )
