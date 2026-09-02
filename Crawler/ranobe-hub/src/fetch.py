"""Carry out a plan by handing each item back to the project that owns it.

Nothing is downloaded or converted here. An archive volume goes through the
annas downloader (member/libgen/browser fallback, md5 verification); a library
volume goes through the novelia one (bilingual fetch, Japanese-only conversion,
vertical restore, verification against the publisher's original). This module
only decides *where files land* so that two sources can share one folder.
"""

from pathlib import Path
from typing import Dict, List, Tuple

from . import bridge
from .catalog import ARCHIVE, WEB, WENKU, Slot, Work


def work_folder(root: Path, work: Work) -> Path:
    naming = bridge.annas("naming")
    return Path(root) / naming.sanitize(work.title)


def plan_paths(work: Work, folder: Path) -> Dict[str, Path]:
    """Destination for every planned slot, unique within the folder.

    The two projects name files by their own conventions, which is what we want
    — but they know nothing about each other, so a clash between them has to be
    resolved here.
    """
    annas_naming = bridge.annas("naming")
    novelia_naming = bridge.novelia("naming")
    novelia_config = bridge.novelia("config")

    taken = set()
    paths: Dict[str, Path] = {}
    for slot in work.planned():
        offer = slot.offer()
        if offer is None:
            continue
        if offer.source == ARCHIVE:
            name = annas_naming.build_filename(offer.payload, slot.volume)
        elif offer.source == WENKU:
            name = novelia_naming.volume_filename(
                offer.payload, novelia_config.Config().mode, converted=True)
        else:
            name = f"{annas_naming.sanitize(work.title)} [web].epub"
        name = annas_naming.disambiguate(name, taken, f"{offer.source}")
        taken.add(name)
        paths[slot.label] = folder / name
    return paths


def run_plan(work: Work, annas_config, novelia_config, root: Path) -> Tuple[int, int]:
    """Download every selected slot. Returns (ok, total)."""
    folder = work_folder(root, work)
    paths = plan_paths(work, folder)
    slots = work.planned()
    if not slots:
        print("  nothing selected")
        return 0, 0

    archive_slots = [s for s in slots if s.chosen == ARCHIVE]
    wenku_slots = [s for s in slots if s.chosen == WENKU]
    web_slots = [s for s in slots if s.chosen == WEB]

    ok = 0
    if wenku_slots:
        ok += _run_wenku(work, wenku_slots, novelia_config, folder)
    if archive_slots:
        ok += _run_archive(archive_slots, paths, annas_config)
    if web_slots:
        ok += _run_web(work, web_slots, novelia_config, folder)
    return ok, len(slots)


def _run_wenku(work: Work, slots: List[Slot], config, folder: Path) -> int:
    download = bridge.novelia("download")
    session_mod = bridge.novelia("session")
    novel = work.handles.get(WENKU)
    if novel is None:
        print(f"  FAILED  library volumes selected but the work has no {WENKU} handle")
        return 0
    sessions = session_mod.SessionPool(config)
    novel = download.ensure_volumes(sessions.get(), config, novel)
    print(f"  {WENKU} -> {len(slots)} volume(s)")
    ok = 0
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=max(1, config.workers)) as pool:
        for result in pool.map(
                lambda s: download.guarded(download.process_volume, sessions.get(),
                                           config, novel, s.offer().payload, folder),
                slots):
            ok += bool(result)
    return ok


def _run_archive(slots: List[Slot], paths: Dict[str, Path], config) -> int:
    downloader = bridge.annas("downloader")
    session_mod = bridge.annas("session")
    session = session_mod.create_session(config)
    picks = [(s.offer().payload, paths[s.label]) for s in slots if s.label in paths]
    print(f"  {ARCHIVE} -> {len(picks)} file(s)")
    ok, _ = downloader.download_all(session, config, picks)
    return ok


def _run_web(work: Work, slots: List[Slot], config, folder: Path) -> int:
    download = bridge.novelia("download")
    session_mod = bridge.novelia("session")
    novel = work.handles.get(WEB)
    if novel is None:
        print(f"  FAILED  web serialisation selected but the work has no {WEB} handle")
        return 0
    session = session_mod.create_session(config)
    print(f"  {WEB} -> 1 file (whole series)")
    return 1 if download.guarded(download.process_web, session, config, novel, folder) else 0
