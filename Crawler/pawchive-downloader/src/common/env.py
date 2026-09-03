"""Environment: a .env loader and typed reads of `PAWCHIVE_*` variables.

Env holds what varies per machine -- where files live, which host to talk to,
where an external tool is, and *how hard this machine is allowed to pull*. The
last one belongs here rather than in config.json because a rate cap, a transfer
count and a daily quota are properties of your link, your proxy and your
agreement with the server, not of the archive: config.json is meant to be
shareable, and one machine's bandwidth budget is not another's.

Everything else about behaviour (templates, filters, timers) stays in
config.json. Precedence is env > config.json > defaults.

`DATA_DIR` is the one setting that *cannot* live in config.json: it says where
config.json is.
"""

import os
from pathlib import Path

PREFIX = "PAWCHIVE_"

# Config fields an env var may override. Keys are `PAWCHIVE_<NAME>`; the value
# is read as the type the Config field declares -- see `_cast`.
OVERRIDABLE = (
    'cache_dir', 'logs_dir', 'download_dir',
    'api_base', 'file_base', 'user_agent',
    # Concurrency caps.
    'max_concurrent_artists', 'max_concurrent_posts', 'max_concurrent_files',
    'max_concurrent_downloads',
    # Traffic caps (sizes: "8MB", "300GB"; 0 = unlimited).
    'max_download_rate', 'download_burst', 'daily_download_quota',
    'quota_window_hours', 'max_file_requests_per_second', 'file_request_burst',
    # Retry attempts and backoff shape.
    'request_timeout', 'max_retries', 'download_max_retries',
    'not_found_max_retries', 'retry_delay', 'retry_backoff', 'retry_delay_cap',
    'retry_jitter',
    # Per-status measures, one line: "404=permanent,attempts=3; 429=retry,delay=60".
    'status_policies',
)


class BadEnvValue(Exception):
    """A `PAWCHIVE_*` variable could not be read as its field's type.

    Raised rather than ignored: a mistyped cap that silently fell back to the
    default would leave the machine pulling at a rate the operator thought they
    had already turned down.
    """


def load_dotenv(path: str = ".env"):
    """Load KEY=VALUE lines into the environment; real env vars win."""
    p = Path(path)
    if not p.exists():
        return
    for raw in p.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        key = key.strip()
        if key:
            os.environ.setdefault(key, value.strip().strip('"').strip("'"))


def get(name: str, default: str = "") -> str:
    """Read `PAWCHIVE_<name>`."""
    return os.environ.get(PREFIX + name.upper(), default)


def _cast(field: str, value: str, declared):
    """Read `value` as the type `declared`. Size fields stay text on purpose.

    A field declared `str` keeps whatever was written, so `max_download_rate`
    can hold "8MB" and be parsed once, where the limiter is built.
    """
    name = getattr(declared, '__name__', str(declared))
    try:
        if name == 'bool':
            lowered = value.strip().lower()
            if lowered in ('1', 'true', 'yes', 'on'):
                return True
            if lowered in ('0', 'false', 'no', 'off'):
                return False
            raise ValueError(value)
        if name == 'int':
            return int(float(value.strip()))
        if name == 'float':
            return float(value.strip())
    except ValueError:
        raise BadEnvValue(
            f"{PREFIX}{field.upper()}={value!r} is not a valid {name}") from None
    return value


def apply_overrides(config) -> list:
    """Overlay `PAWCHIVE_*` vars onto a Config. Returns the names applied."""
    fields = getattr(type(config), '__dataclass_fields__', {})
    applied = []
    for field in OVERRIDABLE:
        value = get(field)
        if not value:
            continue
        declared = getattr(fields.get(field), 'type', str)
        setattr(config, field, _cast(field, value, declared))
        applied.append(field)
    return applied
