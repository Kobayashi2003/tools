"""Environment: a .env loader and typed reads of `PAWCHIVE_*` variables.

Env holds what varies per machine -- where files live, which host to talk to,
where an external tool is. Behaviour (templates, concurrency, retries, filters)
belongs in config.json. Precedence is env > config.json > defaults.

`DATA_DIR` is the one setting that *cannot* live in config.json: it says where
config.json is.
"""

import os
from pathlib import Path

PREFIX = "PAWCHIVE_"

# Config fields an env var may override. Keys are `PAWCHIVE_<NAME>`.
OVERRIDABLE = (
    'cache_dir', 'logs_dir', 'download_dir',
    'api_base', 'file_base', 'user_agent',
)


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


def apply_overrides(config) -> list:
    """Overlay `PAWCHIVE_*` vars onto a Config. Returns the names applied."""
    applied = []
    for field in OVERRIDABLE:
        value = get(field)
        if value:
            setattr(config, field, value)
            applied.append(field)
    return applied
