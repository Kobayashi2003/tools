"""v1's post filter, returning *why* a post is filtered so the UI can say so.

Keys (global `global_filter`, overridden key by key by a creator's `filter`):

    include_keywords      keep if the title contains ANY
    exclude_keywords      drop if the title contains ANY
    require_all_keywords  keep only if the title contains ALL
    require_files         keep only posts with any file
    require_attachments   keep only posts with a non-cover file
    published_after       "YYYY-MM-DD", exclusive
    published_before      "YYYY-MM-DD", exclusive
"""

from dataclasses import dataclass

KEYS = (
    "include_keywords",
    "exclude_keywords",
    "require_all_keywords",
    "require_files",
    "require_attachments",
    "published_after",
    "published_before",
)


@dataclass
class FilterTarget:
    title: str
    published: str
    files: int
    attachments: int
    """Files other than the cover."""


def combined(global_filter: dict, creator_filter: dict) -> tuple[dict, dict[str, str]]:
    """The effective filter, and which level each key came from."""
    cfg = {k: v for k, v in (global_filter or {}).items() if k in KEYS and v}
    origin = dict.fromkeys(cfg, "global")
    for k, v in (creator_filter or {}).items():
        if k in KEYS:
            if v:
                cfg[k] = v
                origin[k] = "creator"
            else:
                cfg.pop(k, None)
                origin.pop(k, None)
    return cfg, origin


def reason(target: FilterTarget, cfg: dict, origin: dict[str, str] | None = None) -> str | None:
    """None if the post is kept, else a short sentence naming the rule that dropped it."""
    if not cfg:
        return None
    origin = origin or {}
    title = target.title.lower()

    def tag(key: str, text: str) -> str:
        return f"{text} · {origin[key]}" if key in origin else text

    include = cfg.get("include_keywords") or []
    if include and not any(k.lower() in title for k in include):
        return tag("include_keywords", "Title has none of " + ", ".join(f'"{k}"' for k in include))
    for k in cfg.get("exclude_keywords") or []:
        if k.lower() in title:
            return tag("exclude_keywords", f'Title has "{k}"')
    for k in cfg.get("require_all_keywords") or []:
        if k.lower() not in title:
            return tag("require_all_keywords", f'Title lacks "{k}"')
    if cfg.get("require_files") and not target.files:
        return tag("require_files", "No files")
    if cfg.get("require_attachments") and not target.attachments:
        return tag("require_attachments", "No files besides the cover")
    day = target.published[:10]
    after, before = cfg.get("published_after"), cfg.get("published_before")
    if after and not day > after:
        return tag("published_after", f"Published on or before {after}")
    if before and not day < before:
        return tag("published_before", f"Published on or after {before}")
    return None
