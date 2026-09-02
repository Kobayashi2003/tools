"""Rendering. The coverage table is the reason this platform exists.

Neither downloader can show you "who has volume 7, and in what shape" — that
only appears once both catalogues are lined up against the same volume numbers.
Everything here is plain text on purpose: it has to survive a Windows console
and copy-paste into a note.
"""

from typing import List, Optional

from .catalog import ARCHIVE, SOURCE_ORDER, WEB, WENKU, Offer, Slot, Work
from . import policy as policy_mod

HAVE = "●"
MISS = "·"


def _width(text: str) -> int:
    """Display width, counting CJK as two columns."""
    import unicodedata
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def _pad(text: str, width: int) -> str:
    return text + " " * max(0, width - _width(text))


def _clip(text: str, width: int) -> str:
    if _width(text) <= width:
        return text
    out = ""
    for char in text:
        if _width(out) + _width(char) > width - 1:
            return out + "…"
        out += char
    return out


# ---- work list ----

def work_list(works: List[Work]) -> str:
    """One block per work, titles in full.

    A column layout had to cut the titles, and for a light novel the part that
    gets cut is exactly the part that tells you what the entry *is* — the
    「(1) (角川コミックス・エース)」 that marks a manga adaptation, or a
    「【電子版限定特典付き】」 bonus edition, both of which sit at an end. So the
    title gets its own line and is never shortened.
    """
    lines = []
    for index, work in enumerate(works, 1):
        lines.append(f"  [{index}] {work.title}")
        if work.title_alt:
            lines.append(f"      {work.title_alt}")
        if work.authors:
            lines.append(f"      author  : {', '.join(work.authors)}")
        lines.append(f"      sources : {work.summary()}")
        volumes = work.numbered()
        if volumes:
            lines.append(f"      volumes : {len(volumes)}"
                         f"  ({_volume_span(volumes)})")
        elif work.slots:
            lines.append(f"      volumes : {len(work.slots)} (no volume numbers found)")
        lines.append("")
    return "\n".join(lines).rstrip()


def _volume_span(slots) -> str:
    """`1-14`, or `1-3, 5, 7-9` when the run has holes."""
    labels = [s.label for s in slots]
    numbers = []
    for label in labels:
        try:
            numbers.append(float(label))
        except ValueError:
            return ", ".join(labels)
    numbers.sort()
    parts, start, previous = [], numbers[0], numbers[0]
    for value in numbers[1:]:
        if value == previous + 1:
            previous = value
            continue
        parts.append(_span(start, previous))
        start = previous = value
    parts.append(_span(start, previous))
    return ", ".join(parts)


def _span(start: float, end: float) -> str:
    def fmt(x: float) -> str:
        return str(int(x)) if x == int(x) else str(x)
    return fmt(start) if start == end else f"{fmt(start)}-{fmt(end)}"


# ---- coverage table ----

def _cell_text(offer: Optional[Offer]) -> str:
    """One grid cell, unpadded — shared with the interactive picker."""
    if offer is None:
        return f"  {MISS}"
    bits = [offer.label]
    size = offer.size_text()
    if size:
        bits.append(size)
    lang = offer.language
    if lang and offer.source == ARCHIVE:
        code = lang.split("[")[-1].rstrip("]") if "[" in lang else lang
        bits.append(code)
    return f"{HAVE} " + " ".join(bits)


def _cell(offer: Optional[Offer], width: int) -> str:
    return _pad(_cell_text(offer), width)


def coverage(work: Work, policy_name: str) -> str:
    columns = [s for s in SOURCE_ORDER if s != WEB and
               any(s in slot.offers for slot in work.slots)]
    if not columns:
        columns = [WENKU, ARCHIVE]
    widths = {WENKU: 18, ARCHIVE: 20}
    for column in columns:
        widths[column] = max(widths.get(column, 18), _width(column) + 2)

    head = " ".join(_pad(c, widths.get(c, 18)) for c in columns)
    lines = []
    title = work.title + (f" / {work.title_alt}" if work.title_alt else "")
    meta = " · ".join(x for x in [", ".join(work.authors), work.publisher] if x)
    lines.append(f"  {title}" + (f"\n  {meta}" if meta else ""))
    lines.append(f"  policy: {policy_name} — {policy_mod.describe(policy_name)}")
    lines.append("")
    lines.append(f"  {'':>2} {'vol':>4} │ {head}│ plan")
    lines.append("  " + "─" * (9 + sum(widths.get(c, 18) + 1 for c in columns) + 7))

    for index, slot in enumerate(work.slots, 1):
        mark = "x" if slot.selected and slot.chosen else " "
        cells = " ".join(_cell(slot.offers.get(c), widths.get(c, 18)) for c in columns)
        plan = slot.chosen or "—"
        if slot.pinned:
            plan += "*"
        lines.append(f"  [{mark}] {slot.label:>4} │ {cells}│ {plan}")

    lines.append("  " + "─" * (9 + sum(widths.get(c, 18) + 1 for c in columns) + 7))
    for offer in work.whole:
        lines.append(f"  whole series: {offer.source} · {offer.label} · "
                     f"{offer.extension} (one file, not per volume)")

    stats = policy_mod.totals(work)
    by_source = " · ".join(f"{k} {v}" for k, v in stats["by_source"].items()) or "nothing"
    size, unsized = stats["bytes"], stats["unsized"]
    if size and unsized:
        # Say the total is partial rather than quietly under-reporting it.
        size_text = f"≥{size / 1024 / 1024:.0f} MB (+{unsized} of unknown size)"
    elif size:
        size_text = f"~{size / 1024 / 1024:.0f} MB"
    elif unsized:
        size_text = "size not published"
    else:
        size_text = "nothing to fetch"
    count = f"{stats['volumes']} volume(s)"
    if stats["extras"]:
        count += f" + {stats['extras']} unnumbered"
    gaps = ", ".join(stats["gaps"]) or "none"
    lines.append(f"  plan: {count} · {by_source} · gaps: {gaps} · {size_text}")
    untranslated = [s.label for s in work.planned()
                    if s.offer() is not None and not s.offer().translatable]
    if untranslated:
        lines.append(f"  untranslated (nothing to convert from, these will fail): "
                     f"{', '.join(untranslated)}")
    if any(s.pinned for s in work.slots):
        lines.append("  (* = pinned by hand; `policy` will not move it)")
    return "\n".join(lines)


def notes_block(notes: List[str]) -> str:
    return "\n".join(f"  note: {n}" for n in notes)
