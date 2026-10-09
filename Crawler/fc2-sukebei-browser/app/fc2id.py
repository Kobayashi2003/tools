"""FC2 code matching.

Matches FC2 / FC2 PPV / FC2-PPV / FC2PPV (any separators) followed by the numeric id.
The id is 5-8 digits, which skips resolutions such as "2160p".

    "FC2 PPV 1289686 (UNCENSORED 2160p)" -> 1289686
    "fc2-ppv-4812315 初撮り..."           -> 4812315
    "[FHD]FC2PPV-4907687_1"               -> 4907687
"""

import re

FC2_RE = re.compile(r"FC2[\s_\-‐－]*(?:PPV)?[\s_\-‐－]*(\d{5,8})(?!\d)", re.IGNORECASE)
BARE_ID_RE = re.compile(r"^\s*(\d{5,8})\s*$")


def extract_id(text):
    """Return the FC2 id mentioned in `text`, or None."""
    match = FC2_RE.search(text or "")
    return match.group(1) if match else None


def parse_id(text):
    """Accept either an FC2 code or a bare numeric id (as typed by a user)."""
    match = BARE_ID_RE.match(text or "")
    return match.group(1) if match else extract_id(text)


def label(fc2_id):
    return f"FC2-PPV-{fc2_id}"


_EDGE_JUNK = " \t-_:+*|/.,#=~"
_EMPTY_BRACKETS = re.compile(r"\[\s*\]|\(\s*\)|【\s*】")


def strip_code(text):
    """Remove the FC2 code (and the separators around it) from a title or torrent name.

        "FC2-PPV-123456 Title"            -> "Title"
        "+++ FC2-PPV-4982106 【反省価格】…" -> "【反省価格】…"
    """
    text = (text or "").strip()
    match = FC2_RE.search(text)
    if match:
        text = f"{text[:match.start()].rstrip(_EDGE_JUNK)} {text[match.end():].lstrip(_EDGE_JUNK)}"
    return _EMPTY_BRACKETS.sub("", text).strip(_EDGE_JUNK)
