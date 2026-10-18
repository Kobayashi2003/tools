"""Timestamps. Everything stored or compared is naive UTC, `YYYY-MM-DDTHH:MM:SS`.

Pawchive already writes naive UTC; Fanbox writes JST with an offset. Both become
the same string here, so sorting and `last_date` comparisons stay plain string
comparisons, as they were in v1. Folder dates are rendered from UTC.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

JST = 9 * 60


def to_utc(value: str | None) -> str:
    """Any ISO timestamp -> naive UTC. A naive input is taken to be UTC already."""
    if not value:
        return ""
    text = value.strip().replace("Z", "+00:00")
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return ""
    if moment.tzinfo is not None:
        moment = moment.astimezone(UTC).replace(tzinfo=None)
    return moment.replace(microsecond=0).isoformat()


def shift(utc: str, minutes: int) -> datetime:
    return datetime.fromisoformat(utc) + timedelta(minutes=minutes)


def local_date(utc: str, minutes: int) -> str:
    """The calendar date `YYYY-MM-DD` of a UTC instant at a fixed offset."""
    return shift(utc, minutes).date().isoformat()


def fanbox_cursor(utc: str) -> str:
    """Fanbox's keyset paging wants the JST wall time, `YYYY-MM-DD HH:MM:SS`."""
    return shift(utc, JST).strftime("%Y-%m-%d %H:%M:%S")


def now_utc() -> str:
    return datetime.now(UTC).replace(tzinfo=None, microsecond=0).isoformat()


def format_offset(minutes: int) -> str:
    if minutes == 0:
        return "UTC"
    sign = "+" if minutes > 0 else "-"
    h, m = divmod(abs(minutes), 60)
    return f"UTC{sign}{h}" + (f":{m:02d}" if m else "")


# Whole hours plus the half and quarter-hour zones people actually live in.
CANDIDATE_OFFSETS = sorted(
    {h * 60 for h in range(-12, 15)} | {-570, -210, 210, 270, 330, 345, 390, 570, 630, 765}
)


@dataclass
class OffsetGuess:
    minutes: int
    agree: int
    total: int
    # Samples that this offset explains and at least one of UTC/JST does not:
    # the evidence a person needs to trust the guess.
    witnesses: list[tuple[str, str, str]]


def infer_offset(samples: Iterable[tuple[str, str, str]]) -> list[OffsetGuess]:
    """Rank offsets by how many `(label, folder_date, utc)` samples they explain.

    Only offsets that land a date are distinguishable, so a sample published
    mid-day in every zone agrees with all of them and carries no evidence; the
    ranking is by agreement, and the witnesses are what tells candidates apart.
    """
    samples = [s for s in samples if s[1] and s[2]]
    guesses = []
    for minutes in CANDIDATE_OFFSETS:
        agree = 0
        witnesses = []
        for label, folder, utc in samples:
            if local_date(utc, minutes) != folder:
                continue
            agree += 1
            if len(witnesses) < 5 and (
                local_date(utc, 0) != folder or local_date(utc, JST) != folder
            ):
                witnesses.append((label, folder, utc))
        guesses.append(OffsetGuess(minutes, agree, len(samples), witnesses))
    guesses.sort(key=lambda g: (-g.agree, abs(g.minutes - JST)))
    return guesses
