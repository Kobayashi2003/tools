"""Read a volume number off a record, then pick the best file per volume.

Volume numbers are written a dozen different ways ("Vol. 3", "第3巻", "v03",
"Sword Art Online 12: ..."), and the three places we can read them from — title,
publisher/edition line, original filename — disagree often enough that order
matters. An explicit marker anywhere beats a bare trailing number anywhere,
because a bare number in a filename path is as likely to be a year or a batch id.
"""

import re
import unicodedata
from typing import Dict, List, Optional

from .models import Record, VolumeGroup

# Punctuation that can sit immediately before a volume number. Japanese titles
# very often end in `!` or `?` and hang the number straight off it
# (「うちの居候が世界を掌握している!11」), and wave dashes close a bracketed
# subtitle the same way (「田中~…~1」).
_BEFORE = r'\s.,:_\-–—）)\]】〉》>»」』!！?？~〜。、'

# Patterns with an unambiguous "this is a volume" marker.
_EXPLICIT = [
    r'\bvol(?:ume|s)?\.?\s*[#＃]?\s*(\d{1,4}(?:\.\d)?(?:\s*[-–]\s*\d{1,4})?)\b',
    r'第\s*(\d{1,4})\s*[巻卷冊册]',
    r'\bbook\s+(\d{1,3})\b',
    r'\btome\s+(\d{1,3})\b',
    r'\bl?v\.?\s?(\d{1,3})\b',          # "Lv.2" is the volume marker in some series
    r'[#＃]\s*(\d{1,4})\b',
    r'(\d{1,4})\s*[巻卷]',
]

# A number sitting where a volume number usually sits: at the end of the name,
# or right before the subtitle separator. Years are excluded by the digit count.
_BARE = [
    # A number at the end of the name, before the subtitle separator, or before a
    # trailing qualifier: "… 12: Alicization Rising", "… 7 (light novel)".
    # "=" covers the library-catalogue form "葬送のフリーレン. 11 = Frieren".
    # A closing bracket counts as a separator too, for the common shape where the
    # series carries a bracketed subtitle: 「落第騎士の英雄譚<キャバルリィ>2」.
    # A trailing "." introduces a subtitle in 「魔界帰りの劣等能力者3.二人の英雄」 —
    # but only when no digit follows, so that "3.5" stays a half volume.
    rf'(?:^|[{_BEFORE}])(\d{{1,3}}(?:\.\d)?)\s*(?=[:：,，=＝]|[.。](?!\d)|[（(\[【]|$)',
    # Japanese/Chinese titles append the number straight to the series name with
    # no separator: 「ソードアート・オンライン16 アリシゼーション…」.
    r'[぀-ヿ㐀-鿿가-힣](\d{1,3}(?:\.\d)?)(?=[\s　（(\[【.。]|$)',
    # After a sentence-ending mark the number is the volume even when a subtitle
    # follows it: 「神は遊戯に飢えている。1 神々に挑む少年の…」.
    r'[。!！?？](\d{1,3}(?:\.\d)?)(?=[\s　]|$)',
]

# Roman numerals are used for volume numbers by a few long-running series
# (「灼眼のシャナXXI」, 「現実主義勇者の王国再建記XIX」). Only counted directly after
# a CJK character, which keeps English words such as "MIX" out of it.
_ROMAN = re.compile(r'[぀-ヿ㐀-鿿가-힣]([IVXLC]{1,8})\s*$')
_ROMAN_VALUES = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100}


def _roman_to_int(text: str):
    """Value of a roman numeral, or None when it is not one."""
    total = 0
    previous = 0
    for char in reversed(text):
        value = _ROMAN_VALUES.get(char)
        if value is None:
            return None
        total += -value if value < previous else value
        previous = max(previous, value)
    # Re-rendering it is the cheap way to reject "IIII" and other non-numerals.
    if total <= 0 or total > 60 or _int_to_roman(total) != text:
        return None
    return total


def _int_to_roman(number: int) -> str:
    pairs = ((50, "L"), (40, "XL"), (10, "X"), (9, "IX"),
             (5, "V"), (4, "IV"), (1, "I"))
    out = []
    for value, glyph in pairs:
        while number >= value:
            out.append(glyph)
            number -= value
    return "".join(out)

# A run of CJK is one token, not one token per character. Per-character tokens
# reduce the relevance filter to a character-set test, where 「ドラゴン」 happily
# matches 「ゴンドラ紀行」 — and CJK series names are the main use case here.
_TOKEN_RE = re.compile(r'[0-9A-Za-zÀ-ɏ]+|[぀-ヿ㐀-鿿가-힯]+')


def detect_volume(record: Record, source: str = "auto", override: str = "") -> Optional[str]:
    """Return the volume as a normalized string ("7", "7.5", "1-3") or None."""
    if override:
        for text in _texts(record, "auto", with_filename=True):
            match = re.search(override, text, re.I)
            if not match:
                continue
            # A group that did not participate is None; take the first that did,
            # and fall back to the whole match for a pattern with no groups.
            value = next((g for g in match.groups() if g), None) or (
                match.group(0) if not match.groups() else "")
            if value:
                return _normalize(value)
        return None

    # An explicit "Vol. N" in the title is authoritative, so that pass reads the
    # title first. A bare number is only a guess, and there the edition line is
    # the better guess: it is structured ("publisher, series N, year") where a
    # title may carry a catalogue id instead. Filenames are excluded from the
    # bare pass entirely — their paths are full of years and batch numbers.
    for patterns, texts in ((_EXPLICIT, _texts(record, source, with_filename=True)),
                            (_BARE, _texts(record, source, publisher_first=True))):
        for text in texts:
            for pattern in patterns:
                match = re.search(pattern, text, re.I)
                if match:
                    return _normalize(match.group(1))
    # Last, because a roman numeral is the least common form and the easiest to
    # read into a title that merely ends in the right letters.
    for text in _texts(record, source, publisher_first=True):
        match = _ROMAN.search(text)
        if match:
            value = _roman_to_int(match.group(1).upper())
            if value is not None:
                return str(value)
    return None


def _texts(record: Record, source: str, with_filename: bool = False,
           publisher_first: bool = False) -> List[str]:
    by_name = {
        "title": [record.title],
        "publisher": [record.publisher],
        "filename": [_basename(record.filename)],
    }
    if source in by_name:
        return [t for t in by_name[source] if t]
    ordered = ([record.publisher, record.title] if publisher_first
               else [record.title, record.publisher])
    if with_filename:
        ordered.append(_basename(record.filename))
    return [t for t in ordered if t]


def _basename(path: str) -> str:
    return re.split(r'[\\/]', path)[-1] if path else ""


def _normalize(raw: str) -> str:
    raw = re.sub(r'\s+', '', raw)
    parts = re.split(r'([\-–])', raw)
    out = []
    for part in parts:
        if re.fullmatch(r'\d+(\.\d+)?', part or ''):
            whole, _, frac = part.partition('.')
            out.append(str(int(whole)) + (f".{frac}" if frac else ""))
        else:
            out.append('-' if part in ('-', '–') else (part or ''))
    return "".join(out)


# ---- relevance ----

def normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "").casefold()
    return " ".join(_TOKEN_RE.findall(text))


def tokens(text: str) -> List[str]:
    return normalize_text(text).split()


def matches_query(record: Record, query: str) -> bool:
    """Keep a hit only if every query token shows up somewhere in it."""
    haystack = normalize_text(" ".join([record.title, record.author,
                                        record.publisher, record.filename]))
    return all(token in haystack for token in tokens(query))


# ---- ranking ----

RANK_KEYS = ("format", "size", "date", "fast")


def sort_key(record: Record, config):
    """Ranking tuple, smaller is better. Order comes from `config.rank`."""
    priority = [e.lower() for e in config.format_priority]
    extension = (record.extension or "").lower()
    format_rank = priority.index(extension) if extension in priority else len(priority)

    date = record.date_added or (f"{record.year}-00-00" if record.year else "")

    parts = {
        "format": (format_rank,),
        "size": (-record.size,),
        "date": (_negated_date(date),),
        "fast": (0 if record.fast_download else 1,),
    }
    key = []
    for name in config.rank:
        key.extend(parts.get(name, ()))
    # Deterministic tie-break so repeated runs pick the same file.
    key.append(record.md5)
    return tuple(key)


def _negated_date(date: str):
    """Sort newer first: turn "2019-07-04" into a descending-comparable number."""
    if not date:
        return 0
    digits = re.sub(r'\D', '', date).ljust(8, "0")[:8]
    return -int(digits)


def group_by_volume(records: List[Record], config) -> List[VolumeGroup]:
    """One group per volume, candidates best-first. Records with no readable
    volume each become their own group so nothing silently disappears."""
    for record in records:
        record.volume = detect_volume(record, config.volume_from, config.volume_regex)

    numbered: Dict[str, List[Record]] = {}
    unknown: List[Record] = []
    for record in records:
        if record.volume is None:
            unknown.append(record)
        else:
            numbered.setdefault(record.volume, []).append(record)

    groups = []
    for volume, candidates in numbered.items():
        candidates.sort(key=lambda r: sort_key(r, config))
        groups.append(VolumeGroup(volume=volume,
                                  candidates=candidates[:1 + max(0, config.max_alternates)]))
    groups.sort(key=lambda g: _volume_order(g.volume))

    unknown.sort(key=lambda r: sort_key(r, config))
    groups.extend(VolumeGroup(volume=None, candidates=[r]) for r in unknown)
    return groups


def _volume_order(volume: Optional[str]):
    if volume is None:
        return (1, 0.0, "")
    head = re.match(r'\d+(\.\d+)?', volume)
    return (0, float(head.group(0)) if head else 0.0, volume)
