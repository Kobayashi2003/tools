"""Durable JSON files: atomic writes, and reads that never lie.

A truncated file must not read as "empty" -- callers overwrite what they read,
so a swallowed parse error silently destroys the state it failed to load.
"""

import json
import os
import uuid
from pathlib import Path
from typing import Any


class CorruptJSON(Exception):
    """The file exists but could not be parsed. Never treat this as 'no data'."""

    def __init__(self, path, cause):
        super().__init__(f"corrupt JSON: {path} ({cause})")
        self.path = Path(path)


def read_json(path, default: Any = None) -> Any:
    """Parse `path`. A missing file yields `default`; a corrupt one raises."""
    path = Path(path)
    if not path.exists():
        return default
    text = path.read_text(encoding='utf-8')
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise CorruptJSON(path, e) from e


def write_json(path, data: Any):
    """Write `data` atomically: a crash mid-write cannot truncate the target."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.parent / f".{path.name}.{uuid.uuid4().hex[:8]}.tmp"
    try:
        temp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')
        os.replace(temp, path)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise


def coerce(cls, item: dict):
    """Build a dataclass from `item`, ignoring keys the class no longer has.

    Without this, adding or removing a field makes every existing file
    unreadable -- which lands on the same silent-loss path.
    """
    valid = cls.__dataclass_fields__.keys()
    return cls(**{k: v for k, v in item.items() if k in valid})
