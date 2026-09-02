"""Decide, per volume, which source to take from — and be able to say why.

Choosing by hand is the tedious part: eleven volumes is eleven decisions, and
they are nearly always the same decision. So a policy picks, the table shows
what it picked, and the user overrides only where they disagree. A pinned slot
is never re-decided.
"""

from typing import Dict, List, Optional

from .catalog import ARCHIVE, WEB, WENKU, Offer, Slot, Work

POLICIES = {
    "japanese": f"Japanese first, then the untouched file: "
                f"{ARCHIVE} > {WENKU} > {WEB}",
    "archive": f"prefer {ARCHIVE}'s own file even in another language",
    "smallest": "whichever source offers the smallest file",
    "largest": "whichever source offers the largest file",
}
DEFAULT = "japanese"

# Quality order among sources that can all supply Japanese.
#
# The archive holds the publisher's file as released. A library volume is the same
# book taken apart and put back together: the site ships it with every
# stylesheet emptied and the Chinese interleaved, and the downloader rebuilds it
# from the uploaded original. The text is verified identical either way, but a
# reconstruction is still a reconstruction — so an untouched copy wins.
#
# The web catalogue is last: it is the serialisation, not the published book.
SOURCE_QUALITY = {ARCHIVE: 0, WENKU: 1, WEB: 2}


SHORT = {
    "japanese": f"Japanese first, then {ARCHIVE} > {WENKU} > {WEB}",
    "archive": f"{ARCHIVE} first, any language",
    "smallest": "smallest file",
    "largest": "largest file",
}


def describe(name: str) -> str:
    return POLICIES.get(name, "unknown policy")


def short(name: str) -> str:
    """One-line form for the interactive screen, which is width-constrained."""
    return SHORT.get(name, name)


def _rank(name: str, offer: Offer):
    """Lower sorts first."""
    if name == "archive":
        return (0 if offer.source == ARCHIVE else 1,
                0 if offer.japanese else 1,
                0 if offer.extension == "epub" else 1,
                -offer.size)
    if name == "smallest":
        return (offer.size or float("inf"), 0 if offer.japanese else 1)
    if name == "largest":
        return (-offer.size, 0 if offer.japanese else 1)
    # japanese (default): language decides first — an untouched Chinese file is
    # still the wrong book to read. Among the offers that do yield Japanese, the
    # least-handled copy wins (see SOURCE_QUALITY). `translatable` only
    # separates two library offers: one nobody has translated cannot be converted
    # at all, so it must not outrank a working source of the same language.
    return (0 if offer.japanese else 1,
            0 if offer.translatable else 1,
            SOURCE_QUALITY.get(offer.source, 9),
            0 if offer.extension == "epub" else 1,
            -offer.size)


def apply(work: Work, name: str = DEFAULT) -> None:
    """Fill in `chosen` for every slot the user has not pinned."""
    for slot in work.slots:
        if slot.pinned and slot.chosen in slot.offers:
            continue
        if not slot.offers:
            slot.chosen = None
            slot.selected = False
            continue
        best = min(slot.offers.values(), key=lambda o: _rank(name, o))
        slot.chosen = best.source


def reason(work: Work, slot: Slot, name: str = DEFAULT) -> str:
    """One line explaining the choice, for `why`."""
    if slot.pinned:
        return f"pinned to {slot.chosen} by hand"
    if not slot.offers:
        return "no source has this volume"
    ranked = sorted(slot.offers.values(), key=lambda o: _rank(name, o))
    if len(ranked) == 1:
        only = ranked[0]
        return f"{only.source} is the only source"
    best, runner = ranked[0], ranked[1]
    if best.japanese and not runner.japanese:
        return (f"{best.source} is Japanese; {runner.source} is "
                f"{runner.language or 'another language'}")
    if best.source == ARCHIVE and runner.source == WENKU:
        return (f"{ARCHIVE} holds the publisher's file as released; "
                f"{WENKU} is rebuilt from it")
    if best.source == WENKU and runner.source == ARCHIVE:
        if not runner.translatable:
            return f"{WENKU} is the only usable Japanese copy here"
        return f"{WENKU} outranks the archive copy under policy '{name}'"
    if not runner.translatable and best.translatable:
        return f"{runner.source} has no translation to convert from"
    if best.size and runner.size and best.size != runner.size:
        bigger = "larger" if best.size > runner.size else "smaller"
        return f"{best.source} is the {bigger} file under policy '{name}'"
    return f"{best.source} ranks first under policy '{name}'"


def totals(work: Work) -> Dict[str, object]:
    counts: Dict[str, int] = {}
    size = 0
    unsized = 0
    numbered = 0
    extras = 0
    for slot in work.planned():
        offer = slot.offer()
        if offer is None:
            continue
        counts[offer.source] = counts.get(offer.source, 0) + 1
        if offer.size:
            size += offer.size
        else:
            # The library listing has no filesize, so a total that ignored this
            # would read as the whole download when it is only part of it.
            unsized += 1
        if slot.volume is None:
            extras += 1
        else:
            numbered += 1
    return {
        "volumes": numbered,
        "extras": extras,
        "by_source": counts,
        "bytes": size,
        "unsized": unsized,
        "gaps": [s.label for s in work.gaps()],
    }
