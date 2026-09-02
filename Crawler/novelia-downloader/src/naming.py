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


def build_filename(novel, mode: str, suffix: str = "epub", converted: bool = False) -> str:
    """`強くてニューサーガ [ja].epub` / `強くてニューサーガ [jp-zh].epub`"""
    title = novel.title_jp or novel.title_zh or novel.novel_id
    tag = "ja" if converted else mode
    return f"{sanitize(f'{title} [{tag}]')}.{suffix}"


def disambiguate(name: str, taken, discriminator: str) -> str:
    """Make `name` unique against `taken`.

    Two different works can share a title — the same series republished, or a
    spin-off under the same name — and would otherwise build the same filename,
    so one would silently overwrite or be skipped as "already downloaded".
    """
    if name not in taken:
        return name
    stem, dot, ext = name.rpartition(".")
    # Only split off something that actually looks like an extension. A folder
    # name is passed in whole, and a title may well contain a dot
    # (「Re：ゼロ.第二章」), which would otherwise be torn apart.
    if not dot or not re.fullmatch(r'[A-Za-z0-9]{1,5}', ext):
        stem, dot, ext = name, "", ""

    def build(width: int) -> str:
        tag = f" [{discriminator[:width]}]"
        room = max(1, MAX_COMPONENT - len(tag) - len(dot) - len(ext))
        return f"{sanitize(stem, room)}{tag}{dot}{ext}"

    for width in range(6, 33):
        candidate = build(width)
        if candidate not in taken:
            return candidate
    return build(32)


def volume_filename(volume, mode: str, converted: bool = False) -> str:
    """Keep the publisher's own volume filename, tagged with what it holds.

    `[阿部正行]強くてニューサーガ1.epub` -> `[阿部正行]強くてニューサーガ1 [ja].epub`
    """
    name = volume.volume_id
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, "epub"
    tag = "ja" if converted else mode
    return f"{sanitize(f'{stem} [{tag}]')}.{ext.lower() or 'epub'}"
