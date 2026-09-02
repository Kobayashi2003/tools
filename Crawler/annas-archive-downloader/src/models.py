"""Data models. No I/O, no project imports."""

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class Record:
    """One search hit — a single file on Anna's Archive, keyed by its md5."""
    md5: str
    title: str = ""
    author: str = ""
    publisher: str = ""
    filename: str = ""
    language: str = ""
    extension: str = ""
    size: int = 0
    size_text: str = ""
    year: Optional[int] = None
    content_type: str = ""
    sources: str = ""
    # Filled in by volumes.detect_volume(); None when no volume could be read.
    volume: Optional[str] = None
    # Filled in only when --precise-date is on; "YYYY-MM-DD" from the detail page.
    date_added: str = ""
    # True for hits the site listed under "Show N partial matches" — they failed
    # the language/format/content filters and are only offered as a fallback.
    partial: bool = False

    def url(self, mirror: str) -> str:
        return f"{mirror.rstrip('/')}/md5/{self.md5}"

    @property
    def fast_download(self) -> bool:
        """The 🚀 marker: the file sits on Anna's own fast partner servers."""
        return "🚀" in self.sources

    def summary(self) -> str:
        bits = [self.extension.upper() or "?", self.size_text or "?"]
        if self.year:
            bits.append(str(self.year))
        if self.date_added:
            bits.append(f"+{self.date_added}")
        if self.language:
            bits.append(self.language)
        return " · ".join(bits)


@dataclass
class VolumeGroup:
    """All candidate files judged to be the same volume, best first."""
    volume: Optional[str]
    candidates: List[Record] = field(default_factory=list)

    @property
    def best(self) -> Record:
        return self.candidates[0]

    @property
    def label(self) -> str:
        return f"Vol.{self.volume}" if self.volume is not None else "?"
