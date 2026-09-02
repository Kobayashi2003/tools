"""Filesystem-safe naming helpers. No project types."""

import re
from datetime import datetime
from pathlib import Path
from typing import List, Sequence

# Windows-forbidden characters mapped to look-alikes, plus invisibles.
_REPLACEMENTS = {
    '/': '／', '\\': '＼', ':': '：', '*': '＊', '?': '？',
    '"': '＂', '<': '＜', '>': '＞', '|': '｜',
    '　': ' ', ' ': ' ', '\t': ' ', '\r': ' ', '\n': ' ',
    '​': '', '‌': '', '‍': '', '﻿': '',
    '‎': '', '‏': '',
}
_CONTROL = re.compile(r'[\x00-\x1F\x7F]')
_SPACES = re.compile(r' +')

# The filesystem refuses a longer name outright (WinError 123), so an overlong
# title would fail to download forever. A template can budget ahead with
# `{title:.60}`; this is the backstop for the ones that don't.
MAX_COMPONENT = 255


def truncate_component(text: str, limit: int = MAX_COMPONENT) -> str:
    """Cap one component's length, keeping any extension."""
    if len(text) <= limit:
        return text
    stem, dot, ext = text.rpartition('.')
    if dot and stem and len(ext) <= 10:
        return stem[:limit - len(ext) - 1].strip(' .') + '.' + ext
    return text[:limit].strip(' .')


def sanitize_component(text: str) -> str:
    """Make one path component safe. Never empty."""
    if not text:
        return "unknown"
    text = _CONTROL.sub('', text)
    for ch, repl in _REPLACEMENTS.items():
        text = text.replace(ch, repl)
    return truncate_component(_SPACES.sub(' ', text).strip(' .')) or "unknown"


def sanitize_path(path_str: str) -> str:
    """Sanitize each component but keep '/' separators, so `{alias}/{service}`
    still produces a hierarchy.

    Empty segments collapse rather than becoming "unknown": a variable that is
    legitimately empty (`{group}` at the download root, `{last_date}` before the
    first download) must drop out of the path, not invent a folder.
    """
    parts = [sanitize_component(s) for s in path_str.replace('\\', '/').split('/') if s]
    return '/'.join(parts)


def unique_names(names: Sequence[str]) -> List[str]:
    """Suffix repeats with `(n)`; two files must never share a target path."""
    seen: dict = {}
    out: List[str] = []
    for name in names:
        count = seen.get(name, 0)
        seen[name] = count + 1
        if count == 0:
            out.append(name)
        else:
            p = Path(name)
            out.append(f"{p.stem} ({count}){p.suffix}")
    return out


def format_date(date_str: str, date_format: str) -> str:
    """Format an ISO timestamp; fall back to its date part."""
    if not date_str:
        return ""
    try:
        return datetime.fromisoformat(date_str.replace('Z', '+00:00')).strftime(date_format)
    except ValueError:
        return date_str[:10]


def human_size(num: int) -> str:
    """Format a byte count for humans."""
    size = float(num or 0)
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if size < 1024 or unit == 'TB':
            return f"{int(size)} B" if unit == 'B' else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"
