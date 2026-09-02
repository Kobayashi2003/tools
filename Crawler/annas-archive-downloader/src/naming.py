"""Filesystem-safe naming helpers."""

import re

# Windows-forbidden characters mapped to look-alikes, plus invisibles.
_REPLACEMENTS = {
    '/': '／', '\\': '＼', ':': '：', '*': '＊', '?': '？',
    '"': '＂', '<': '＜', '>': '＞', '|': '｜',
    '\t': ' ', '\r': ' ', '\n': ' ',
    '​': '', '‌': '', '‍': '', '﻿': '',
}
_CONTROL = re.compile(r'[\x00-\x1F\x7F]')
_SPACES = re.compile(r' +')

# Windows refuses a longer component outright (WinError 123).
MAX_COMPONENT = 120


def sanitize(text: str, limit: int = MAX_COMPONENT) -> str:
    """Make one path component safe. Never empty."""
    if not text:
        return "unknown"
    text = _CONTROL.sub('', text)
    for char, repl in _REPLACEMENTS.items():
        text = text.replace(char, repl)
    text = _SPACES.sub(' ', text).strip(' .')
    if len(text) > limit:
        text = text[:limit].strip(' .')
    return text or "unknown"


def volume_prefix(volume) -> str:
    """`7` -> `007`, `7.5` -> `007.5`, `1-3` -> `001-003`, None -> ''."""
    if volume is None:
        return ""
    parts = re.split(r'([^0-9.]+)', str(volume))
    out = []
    for part in parts:
        if re.fullmatch(r'\d+(\.\d+)?', part or ''):
            whole, _, frac = part.partition('.')
            out.append(f"{int(whole):03d}" + (f".{frac}" if frac else ""))
        else:
            out.append(part or "")
    return "".join(out)


def build_filename(record, volume=None) -> str:
    """`012 Sword Art Online 12 Alicization Rising.epub`"""
    stem = sanitize(record.title or record.md5)
    prefix = volume_prefix(volume if volume is not None else record.volume)
    if prefix:
        stem = f"{prefix} {stem}"
    ext = re.sub(r'[^A-Za-z0-9]', '', record.extension or '') or 'bin'
    return f"{sanitize(stem)}.{ext.lower()}"


def disambiguate(name: str, taken, discriminator: str) -> str:
    """Make `name` unique against `taken`.

    Records with no volume number routinely share a title — Anna's Archive lists
    the same book from several collections — so two picks can build the same
    filename. Left alone they collapse into one file that the run still counts
    as two successes, which is silent data loss. The md5 keeps them apart.
    """
    if name not in taken:
        return name
    stem, dot, ext = name.rpartition(".")
    # Only split off something that actually looks like an extension. Titles
    # carry dots of their own (「作品 vol.二」), and tearing one apart would put
    # the tag in the middle of the name.
    if not dot or not re.fullmatch(r'[A-Za-z0-9]{1,5}', ext):
        stem, dot, ext = name, "", ""

    def build(width: int) -> str:
        tag = f" [{discriminator[:width]}]"
        # Trim the stem to leave room for the tag: sanitizing the joined string
        # would truncate the tag back off and the name would still collide.
        room = max(1, MAX_COMPONENT - len(tag) - len(dot) - len(ext))
        return f"{sanitize(stem, room)}{tag}{dot}{ext}"

    for width in range(8, 33):
        candidate = build(width)
        if candidate not in taken:
            return candidate
    return build(32)
