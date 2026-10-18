"""Path templates and filesystem-safe names, ported from v1 so existing folders still match."""

import re
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path

# Windows-forbidden characters mapped to look-alikes, plus invisibles.
_REPLACEMENTS = {
    "/": "／",
    "\\": "＼",
    ":": "：",
    "*": "＊",
    "?": "？",
    '"': "＂",
    "<": "＜",
    ">": "＞",
    "|": "｜",
    "　": " ",
    " ": " ",
    "\t": " ",
    "\r": " ",
    "\n": " ",
    "​": "",
    "‌": "",
    "‍": "",
    "﻿": "",
    "‎": "",
    "‏": "",
}
_CONTROL = re.compile(r"[\x00-\x1F\x7F]")
_SPACES = re.compile(r" +")

# The filesystem refuses a longer name outright, so an overlong title would fail forever.
MAX_COMPONENT = 255


def truncate_component(text: str, limit: int = MAX_COMPONENT) -> str:
    if len(text) <= limit:
        return text
    stem, dot, ext = text.rpartition(".")
    if dot and stem and len(ext) <= 10:
        return stem[: limit - len(ext) - 1].strip(" .") + "." + ext
    return text[:limit].strip(" .")


def sanitize_component(text: str) -> str:
    """One path component, safe on Windows. Never empty."""
    if not text:
        return "unknown"
    text = _CONTROL.sub("", text)
    for ch, repl in _REPLACEMENTS.items():
        text = text.replace(ch, repl)
    return truncate_component(_SPACES.sub(" ", text).strip(" .")) or "unknown"


def sanitize_path(path_str: str) -> str:
    """Sanitize each component, keep `/`. Empty segments drop out instead of becoming
    "unknown", so a legitimately empty `{group}` leaves no folder behind."""
    parts = [sanitize_component(s) for s in path_str.replace("\\", "/").split("/") if s]
    return "/".join(parts)


def unique_names(names: Sequence[str], taken: Sequence[str] = ()) -> list[str]:
    """Suffix repeats with `(n)`; two files must never share a target path."""
    # Compared case-insensitively: on Windows `A.jpg` and `a.jpg` are one file.
    used = {n.lower() for n in taken}
    out: list[str] = []
    for name in names:
        candidate, n = name, 0
        p = Path(name)
        while candidate.lower() in used:
            n += 1
            candidate = f"{p.stem} ({n}){p.suffix}"
        used.add(candidate.lower())
        out.append(candidate)
    return out


def format_date(utc: str, date_format: str) -> str:
    if not utc:
        return ""
    try:
        return datetime.fromisoformat(utc).strftime(date_format)
    except ValueError:
        return utc[:10]


def group_values(group: str) -> dict[str, str]:
    """`{group*}` variables. Path-valued: their `/` is real hierarchy."""
    parts = [p for p in group.split("/") if p]
    return {
        "group": sanitize_path(group),
        "group_top": sanitize_path(parts[0]) if parts else "",
        "group_tail": sanitize_path("/".join(parts[1:])),
        "group_leaf": sanitize_path(parts[-1]) if parts else "",
    }


def creator_folder(
    template: str, *, service: str, name: str, alias: str, user_id: str, group: str
) -> str:
    # Names are sanitized before substitution: only a `/` written in the template,
    # or a path-valued {group*}, may create a directory.
    raw = template.format(
        service=sanitize_component(service),
        name=sanitize_component(name),
        alias=sanitize_component(alias or name),
        user_id=sanitize_component(user_id),
        last_date="",
        **group_values(group),
    )
    return sanitize_path(raw)


def post_folder(
    template: str, *, post_id: str, user: str, service: str, title: str, published: str, fmt: str
) -> str:
    raw = template.format(
        id=post_id,
        user=user,
        service=service,
        title=title,
        published=format_date(published, fmt),
    )
    return sanitize_component(raw)


def file_names(
    names: Sequence[str], template: str, rename_images_only: bool, is_image
) -> list[str]:
    """v1's rule: with `rename_images_only`, images get a 0-based `{idx}` counted over
    images only (the cover is image 0), everything else keeps its own name."""
    result = []
    image_index = 0
    for i, original in enumerate(names):
        image = is_image(original)
        if not rename_images_only or image:
            idx = image_index if (rename_images_only and image) else i
            if image:
                image_index += 1
            out = template.format(idx=idx, name=original)
            if "." not in out and "." in original:
                out = f"{out}.{original.rsplit('.', 1)[-1]}"
            result.append(sanitize_component(out))
        else:
            result.append(sanitize_component(original))
    return result
