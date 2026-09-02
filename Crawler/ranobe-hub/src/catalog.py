"""The unified model the two catalogues are merged into.

The whole point of this layer is that the sources disagree about *granularity*:

  annas             one file per volume, mixed languages and formats
  novelia/library   one file per published volume, Japanese after conversion
  novelia/web       one file for the entire serialisation — no volumes at all

So a `Work` holds volume `Slot`s, each with candidate `Offer`s from whichever
sources have that volume, plus `whole` offers that cover the series in one file
and therefore cannot sit in the per-volume table.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional

# Source ids. These are what the interface prints, so they name the site *and*
# which of its two catalogues — mixing scripts in the labels ("文库" next to
# "archive") made the columns hard to read, and the titles are already Japanese.
WENKU = "novelia/library"   # novelia, published volumes
WEB = "novelia/web"         # novelia, web serialisation
ARCHIVE = "annas"           # anna's archive

SOURCE_ORDER = [WENKU, ARCHIVE, WEB]


@dataclass
class Offer:
    """One downloadable thing from one source."""
    source: str
    label: str = ""            # what to show in the cell
    extension: str = ""
    size: int = 0
    language: str = ""
    # Whatever the owning project needs to fetch this; passed straight back.
    payload: object = None
    # A web serialisation covers every volume at once.
    whole_series: bool = False
    # False for a library volume nobody has translated: the Japanese text comes
    # out of a bilingual build, so there would be nothing to convert.
    translatable: bool = True

    @property
    def japanese(self) -> bool:
        """Whether this offer yields Japanese text.

        A novelia offer does after conversion, whichever bilingual build it came
        from; an archive offer only if the file itself is Japanese.
        """
        if self.source in (WENKU, WEB):
            return True
        return "ja]" in self.language or "japanese" in self.language.lower()

    def size_text(self) -> str:
        # Note the local: dividing `self.size` here would shrink the record a
        # little more every time the table was redrawn.
        value = float(self.size or 0)
        if not value:
            return ""
        for unit in ("B", "K", "M", "G"):
            if abs(value) < 1024 or unit == "G":
                return f"{value:.0f}{unit}" if unit == "B" else f"{value:.1f}{unit}"
            value /= 1024.0
        return ""


@dataclass
class Slot:
    """One volume of a work, and every source that can supply it."""
    volume: Optional[str]
    offers: Dict[str, Offer] = field(default_factory=dict)
    # Chosen by the policy, overridable by the user.
    chosen: Optional[str] = None
    pinned: bool = False       # user picked the source by hand
    selected: bool = True      # include in the next `get`

    @property
    def label(self) -> str:
        return f"{self.volume}" if self.volume is not None else "?"

    def offer(self) -> Optional[Offer]:
        return self.offers.get(self.chosen) if self.chosen else None


@dataclass
class Work:
    """One series, as assembled from both catalogues."""
    title: str
    title_alt: str = ""
    authors: List[str] = field(default_factory=list)
    publisher: str = ""
    slots: List[Slot] = field(default_factory=list)
    whole: List[Offer] = field(default_factory=list)
    # Source id -> the object that source's project uses to identify this work.
    handles: Dict[str, object] = field(default_factory=dict)

    def sources(self) -> List[str]:
        found = {s for slot in self.slots for s in slot.offers}
        found.update(o.source for o in self.whole)
        return [s for s in SOURCE_ORDER if s in found]

    def numbered(self) -> List[Slot]:
        return [s for s in self.slots if s.volume is not None]

    def planned(self) -> List[Slot]:
        return [s for s in self.slots if s.selected and s.chosen]

    def gaps(self) -> List[Slot]:
        return [s for s in self.slots if not s.offers]

    def summary(self) -> str:
        bits = []
        for source in self.sources():
            if source == WEB:
                bits.append(f"{WEB} (whole series, no volumes)")
            else:
                count = sum(1 for s in self.slots if source in s.offers)
                bits.append(f"{source} ({count} of {len(self.slots)})")
        return ", ".join(bits) or "nothing"


def volume_sort_key(volume: Optional[str]):
    """Order 1, 2, 7.5, 10 — and push unnumbered entries to the end."""
    if volume is None:
        return (1, 0.0, "")
    head = ""
    for char in volume:
        if char.isdigit() or (char == "." and head and "." not in head):
            head += char
        else:
            break
    try:
        return (0, float(head), volume)
    except ValueError:
        return (0, 0.0, volume)
