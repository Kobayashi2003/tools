"""Search both catalogues and reconcile the results into `Work`s.

Two judgement calls live here, and both can be wrong, so both are surfaced in
the UI rather than hidden:

  * **Which results are the same work.** Titles are matched after normalisation,
    which is why the work list shows the contributing sources per row — an
    over-eager merge is visible there.
  * **Which volume a file is.** Reused wholesale from the annas volume detector
    rather than written again here, so both projects and this one agree.
"""

import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional, Tuple

from . import bridge
from .catalog import (ARCHIVE, WEB, WENKU, Offer, Slot, Work, volume_sort_key)

_EXT = re.compile(r'\.[A-Za-z0-9]{1,5}$')
# Every bracket style the catalogues actually use. Missing `<>` and `«»` alone
# split 落第騎士の英雄譚 into a dozen separate "works".
_NOISE = re.compile(r'[\s　・･·:：;；,，.。\-–—_/\\\[\]（）()「」『』【】〈〉《》<>«»~〜!！?？"\'’”]+')

# Bracketed labels that describe the *packaging* rather than name the work:
# 【電子特装版】, (GA文庫), 【電子版限定特典付き】. Stripping them lets the same book
# merge across editions.
#
# `コミックス` is deliberately absent: a manga adaptation is a different work,
# not a different edition, so 「(角川コミックス・エース)」 must keep them apart.
_EDITION = re.compile(
    r'[（(\[【〈《<«]\s*[^）)\]】〉》>»]*'
    r'(?:文庫|文库|特装版|特典|限定|新装版|完全版|合本|電子版|电子版)'
    r'[^）)\]】〉》>»]*\s*[）)\]】〉》>»]')


def normalise_title(text: str) -> str:
    """Fold a title down to something two catalogues can agree on."""
    text = unicodedata.normalize("NFKC", text or "")
    text = _EDITION.sub("", text).casefold()
    text = _NOISE.sub("", text)
    # Trailing volume numbers belong to the volume, not to the series.
    text = re.sub(r'\d+$', "", text)
    return text


def series_title(title: str, volume: Optional[str]) -> str:
    """The series part of a volume's title.

    A volume title is usually `<series> <number><subtitle>` — "強くてニューサーガ11
    終わらぬ英雄譚", "Sword Art Online 12: Alicization Rising" — so once the volume
    number is known, cutting the title there leaves the series. Trimming only
    *trailing* digits would leave the subtitle attached and split one series
    across several entries.

    It deliberately keeps what comes *before* the number, so "Sword Art Online
    Progressive 6" stays distinct from "Sword Art Online 6".
    """
    if not title or not volume:
        return title
    head = re.match(r'\d+(?:\.\d+)?', volume)
    if not head:
        return title
    digits = head.group(0)
    # Match the number as its own token, tolerating a leading zero.
    pattern = re.compile(r'(?<![0-9])0*' + re.escape(digits) + r'(?![0-9])')
    match = pattern.search(title)
    if not match or match.start() == 0:
        return title
    return title[:match.start()].strip(" .,:：-–—_/\\")


def volume_of(text: str) -> Optional[str]:
    """Volume number for a title or filename, via the annas detector."""
    models = bridge.annas("models")
    volumes = bridge.annas("volumes")
    stem = _EXT.sub("", text or "")
    return volumes.detect_volume(models.Record(md5="0" * 32, title=stem))


# ---- gathering ----

def search_all(annas_config, novelia_config, query: str,
               use_annas: bool = True, use_novelia: bool = True) -> Tuple[List[Work], List[str]]:
    """Query both catalogues in parallel and merge. Returns (works, notes)."""
    notes: List[str] = []
    results: Dict[str, object] = {}

    def run_annas():
        try:
            return _annas_records(annas_config, query)
        except Exception as exc:
            notes.append(f"annas search failed: {type(exc).__name__}: {exc}")
            return []

    def run_novelia():
        try:
            return _novelia_novels(novelia_config, query, notes)
        except Exception as exc:
            notes.append(f"novelia search failed: {type(exc).__name__}: {exc}")
            return []

    jobs = {}
    with ThreadPoolExecutor(max_workers=2) as pool:
        if use_annas:
            jobs["annas"] = pool.submit(run_annas)
        if use_novelia:
            jobs["novelia"] = pool.submit(run_novelia)
        for name, future in jobs.items():
            results[name] = future.result()

    works: Dict[str, Work] = {}
    for novel in results.get("novelia", []):
        _add_novelia(works, novelia_config, novel)
    for record in results.get("annas", []):
        _add_annas(works, record)

    ordered = consolidate(list(works.values()))
    ordered.sort(key=lambda w: (-len(w.sources()), -len(w.slots), w.title))
    for work in ordered:
        work.slots.sort(key=lambda s: volume_sort_key(s.volume))
    return ordered, notes


# ---- second pass: works that are the same series under a different dress ----

_BRACKETED = re.compile(r'[（(\[【〈《<«「『][^）)\]】〉》>»」』]*[）)\]】〉》>»」』]')


def base_title(title: str) -> str:
    """The title with every bracketed part removed.

    A bracketed segment is decoration — a reading gloss, an alternate name, an
    imprint: 「落第騎士の英雄譚<キャバルリィ>」 is the same series as
    「落第騎士の英雄譚」. Bare words are not: "Sword Art Online Progressive" is a
    different series from "Sword Art Online", and only the brackets tell the two
    situations apart.
    """
    return normalise_title(_BRACKETED.sub("", title or ""))


def _author_keys(work: Work) -> set:
    return {normalise_title(a) for a in work.authors if normalise_title(a)}


def consolidate(works: List[Work]) -> List[Work]:
    """Fuse works that differ only by a bracketed subtitle.

    Matching bare titles alone would merge a manga adaptation into its novel, so
    the authors have to agree as well — that is what keeps 「…(角川コミックス・
    エース)」 (drawn by someone else) out of the novel it is based on.
    """
    by_base: Dict[str, List[Work]] = {}
    for work in works:
        by_base.setdefault(base_title(work.title), []).append(work)

    result: List[Work] = []
    for group in by_base.values():
        if len(group) == 1:
            result.append(group[0])
            continue
        clusters: List[Dict] = []
        for work in group:
            names = _author_keys(work)
            for cluster in clusters:
                # An unknown author is not evidence of sameness; keep it apart.
                if names and cluster["authors"] and (names & cluster["authors"]):
                    cluster["works"].append(work)
                    cluster["authors"] |= names
                    break
            else:
                clusters.append({"works": [work], "authors": names})
        for cluster in clusters:
            result.append(_fuse(cluster["works"]))
    return result


def _fuse(works: List[Work]) -> Work:
    if len(works) == 1:
        return works[0]
    # The shortest title carries the least decoration, so it names the result.
    target = min(works, key=lambda w: len(w.title))
    for other in works:
        if other is target:
            continue
        if not target.title_alt and other.title_alt:
            target.title_alt = other.title_alt
        if not target.authors:
            target.authors = list(other.authors)
        if not target.publisher:
            target.publisher = other.publisher
        target.whole.extend(other.whole)
        for source, handle in other.handles.items():
            if source == ARCHIVE:
                target.handles.setdefault(ARCHIVE, []).extend(handle)
            else:
                target.handles.setdefault(source, handle)
        for slot in other.slots:
            existing = next((s for s in target.slots if s.volume == slot.volume), None)
            if existing is None:
                target.slots.append(slot)
            else:
                for source, offer in slot.offers.items():
                    existing.offers.setdefault(source, offer)
    return target


def _annas_records(config, query: str):
    session_mod = bridge.annas("session")
    search_mod = bridge.annas("search")
    volumes_mod = bridge.annas("volumes")
    session = session_mod.create_session(config)
    records, _ = search_mod.search(session, config, query)
    if config.strict:
        kept = [r for r in records if volumes_mod.matches_query(r, query)]
        if kept:
            records = kept
    return records


def _novelia_novels(config, query: str, notes: List[str]):
    api = bridge.novelia("api")
    session_mod = bridge.novelia("session")
    session = session_mod.create_session(config)
    found = []
    try:
        wenku, _ = api.search_wenku(session, config, query)
        found.extend(wenku)
    except api.AuthRequired as exc:
        notes.append(f"novelia/library search refused: {exc}")
    try:
        web, _ = api.search(session, config, query)
        found.extend(web)
    except api.AuthRequired:
        notes.append("novelia/web search needs a token (token.txt / NOVELIA_TOKEN); "
                     "novelia/library results are unaffected")
    api.enrich_wenku(session, config, found)
    return found


# ---- placing results into works ----

def _work_for(works: Dict[str, Work], title: str, alt: str = "") -> Work:
    key = normalise_title(title) or normalise_title(alt) or title
    work = works.get(key)
    if work is None:
        work = Work(title=title, title_alt=alt)
        works[key] = work
        return work
    if not work.title_alt and alt:
        work.title_alt = alt
    # Contributors reach the same work under different names — a series name
    # from one record, "…4【電子特装版】" from another whose volume number could
    # not be read. The shortest is the one with the least packaging on it, so it
    # is the better label for the merged work.
    if title and len(title) < len(work.title):
        work.title = title
    return work


def _slot_for(work: Work, volume: Optional[str]) -> Slot:
    for slot in work.slots:
        if slot.volume == volume:
            return slot
    slot = Slot(volume=volume)
    work.slots.append(slot)
    return slot


def _add_novelia(works: Dict[str, Work], config, novel) -> None:
    models = bridge.novelia("models")
    title = novel.title_jp or novel.title_zh
    work = _work_for(works, title, novel.title_zh if novel.title_zh != title else "")
    if novel.authors and not work.authors:
        work.authors = list(novel.authors)
    if getattr(novel, "publisher", "") and not work.publisher:
        work.publisher = novel.publisher

    if novel.kind == models.WENKU:
        work.handles[WENKU] = novel
        for volume in novel.volumes:
            slot = _slot_for(work, volume_of(volume.volume_id))
            # The library listing carries no filesize, so the cell shows what it
            # does know: chapter count, and whether a translation exists. That
            # last part matters — the Japanese text is recovered from a bilingual
            # build, so a volume nobody has translated has nothing to convert.
            chapters = volume.total or 0
            label = f"epub {chapters}ch" if chapters else "epub"
            if not volume.translated:
                label += " untranslated"
            slot.offers[WENKU] = Offer(
                source=WENKU, label=label, extension="epub",
                language="Japanese [ja]", payload=volume, size=0,
                translatable=bool(volume.translated))
    else:
        work.handles[WEB] = novel
        chapters = novel.total or novel.jp
        work.whole.append(Offer(
            source=WEB, label=f"{chapters} ch", extension="epub",
            language="Japanese [ja]", payload=novel, whole_series=True))


def _add_annas(works: Dict[str, Work], record) -> None:
    title = record.title or record.filename or record.md5
    volume = volume_of(record.title) or volume_of(record.filename)
    work = _work_for(works, series_title(title, volume))
    if record.author and not work.authors:
        work.authors = [record.author]
    work.handles.setdefault(ARCHIVE, [])
    work.handles[ARCHIVE].append(record)

    slot = _slot_for(work, volume)
    existing = slot.offers.get(ARCHIVE)
    offer = Offer(source=ARCHIVE, label=record.extension or "?",
                  extension=record.extension, size=record.size,
                  language=record.language, payload=record)
    # Several archive files can answer for one volume; keep the better one by
    # the same rule the annas tool itself uses — Japanese first here, since that
    # is what this platform is for.
    if existing is None or _archive_better(offer, existing):
        slot.offers[ARCHIVE] = offer


def _archive_better(new: Offer, old: Offer) -> bool:
    def rank(offer: Offer):
        return (0 if offer.japanese else 1,
                0 if offer.extension == "epub" else 1,
                -offer.size)
    return rank(new) < rank(old)
