"""Download one work and convert it, for both catalogues.

This is the part another program most wants to reuse, so it lives in the package
rather than in the CLI: a wrapper that had to reimplement it would drift, which
is exactly how the same helper ends up fixed in one copy and broken in the other.
"""

import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, List, Optional

from .api import (BOARD, download_file, download_url, fetch_metadata,
                  fetch_wenku_metadata, wenku_file_url, wenku_original_url)
from .convert import convert_epub, verify_against_jp
from .models import BILINGUAL, WENKU, Novel, Volume
from .naming import build_filename, sanitize, volume_filename
from .session import SessionPool


def parse_volume_spec(spec: str, count: int) -> List[int]:
    """`1,3,5-8` -> zero-based indexes, clamped to what exists."""
    picked = set()
    for part in spec.replace(" ", ",").split(","):
        if not part:
            continue
        bounds = part.split("-")
        if len(bounds) > 2:
            BOARD.write(f"[volumes] ignoring {part!r}: expected N or N-M")
            continue
        try:
            start = int(bounds[0])
            end = int(bounds[1]) if len(bounds) == 2 else start
        except (ValueError, IndexError):
            BOARD.write(f"[volumes] ignoring {part!r}")
            continue
        for number in range(min(start, end), max(start, end) + 1):
            if 1 <= number <= count:
                picked.add(number - 1)
    return sorted(picked)


def guarded(fn: Callable, *args) -> bool:
    """One failing item must not take the rest of the batch with it."""
    try:
        return fn(*args)
    except KeyboardInterrupt:
        raise
    except Exception as exc:
        BOARD.write(f"  FAILED  {type(exc).__name__}: {exc}")
        return False


def process(session, config, novel: Novel, destination: Path) -> bool:
    """Download one work and, when asked, convert it to Japanese-only."""
    if novel.kind == WENKU:
        return process_wenku(session, config, novel, destination)
    return process_web(session, config, novel, destination)


# ---- library (文库) ----

def process_wenku(session, config, novel: Novel, destination: Path) -> bool:
    """Download a published work volume by volume.

    A library volume has no `mode=jp` build — the site answers 400 — so the
    bilingual file is the only route to the Japanese text, and the uploaded
    original serves as both the verification reference and the source of the
    publisher's stylesheets (which the bilingual build ships emptied).
    """
    novel = ensure_volumes(session, config, novel)
    volumes = novel.volumes
    if not volumes:
        BOARD.write(f"  FAILED  {novel.display_title()}: no Japanese volumes listed")
        return False
    if config.volumes:
        picked = parse_volume_spec(config.volumes, len(volumes))
        if not picked:
            BOARD.write(f"  FAILED  {novel.display_title()}: --volumes matched nothing")
            return False
        volumes = [volumes[i] for i in picked]

    if config.file_type != "epub":
        BOARD.write(f"  note    the library endpoint only builds epub; "
              f"--file_type {config.file_type} is ignored here")

    BOARD.write(f"  {novel.display_title()}: {len(volumes)} volume(s)")
    folder = work_folder(config, novel, destination)
    # A work's volumes are independent files, and for a library work that is the
    # whole batch — running them one at a time would leave --workers doing
    # nothing in the common case of downloading a single series.
    sessions = SessionPool(config)
    ok = 0
    with ThreadPoolExecutor(max_workers=max(1, config.workers)) as pool:
        for result in pool.map(
                lambda v: guarded(process_volume, sessions.get(), config, novel, v, folder),
                volumes):
            ok += bool(result)
    return ok == len(volumes)


def ensure_volumes(session, config, novel: Novel) -> Novel:
    """Search results carry no volume list; only the detail endpoint has it."""
    if novel.kind != WENKU or novel.volumes:
        return novel
    detail = fetch_wenku_metadata(session, config, novel.novel_id)
    if detail is None:
        return novel
    # The detail object is freshly built, so the run-unique output name assigned
    # earlier has to be carried across or the folder falls back to the bare title
    # and two same-titled works collide again.
    detail.output_name = novel.output_name
    return detail


def work_folder(config, novel: Novel, destination: Path) -> Path:
    return destination / (novel.output_name or sanitize(novel.display_title()))


def process_volume(session, config, novel: Novel, volume: Volume, folder: Path) -> bool:
    raw_path = folder / volume_filename(volume, config.mode)
    if not download_url(session, config,
                        wenku_file_url(config, novel, volume, config.mode), raw_path):
        return False

    if not (config.convert and config.mode in BILINGUAL):
        return True

    # One fetch of the original covers both stylesheet restoration and checking.
    reference = folder / f".original-{sanitize(volume.volume_id)}"
    # The publisher's original is fetched to restore styling and to check the
    # result against; it is not a deliverable, so it does not announce itself.
    has_reference = download_url(session, config,
                                 wenku_original_url(config, novel, volume), reference,
                                 announce=False)
    if not has_reference:
        BOARD.write("          note: original unavailable; using the generated stylesheet")

    out_path = folder / volume_filename(volume, config.mode, converted=True)
    report = convert_epub(raw_path, out_path, vertical=config.vertical,
                          title_jp="", introduction_jp="", authors=novel.authors,
                          toc=[],
                          restore_css_from=reference if has_reference else None)
    BOARD.write(f"  convert {out_path.name}")
    BOARD.write(f"          {report.describe()}")
    for warning in report.warnings:
        BOARD.write(f"          warning: {warning}")

    passed = True
    if config.verify and has_reference:
        passed, detail = verify_against_jp(
            out_path, reference, "the publisher's uploaded original")
        BOARD.write(f"          verify: {'OK — ' if passed else 'MISMATCH — '}{detail}")
    elif config.verify:
        BOARD.write("          verify: skipped (no reference available)")

    _settle(raw_path, out_path, config, passed)
    reference.unlink(missing_ok=True)
    return passed


# ---- web novels (网络) ----

def process_web(session, config, novel: Novel, destination: Path) -> bool:
    raw_name = novel.output_name or build_filename(novel, config.mode, config.file_type)
    raw_path = destination / raw_name

    if not download_file(session, config, novel, config.mode, raw_path):
        return False

    convertible = config.convert and config.mode in BILINGUAL and config.file_type == "epub"
    if not convertible:
        if config.convert and config.mode not in BILINGUAL:
            BOARD.write(f"  note    mode={config.mode} is already single-language; nothing to convert")
        elif config.convert and config.file_type != "epub":
            BOARD.write(f"  note    conversion only handles epub; kept {config.file_type} as-is")
        return True

    # The metadata table of contents supplies the Japanese chapter labels. A
    # search result carries none, so fetch it unless we already have it.
    detail = novel if novel.toc else fetch_metadata(
        session, config, novel.provider_id, novel.novel_id)
    toc, introduction, authors = [], novel.introduction_jp, novel.authors
    if detail is not None:
        toc = detail.toc
        introduction = detail.introduction_jp or introduction
        authors = detail.authors or authors

    # Derive the converted name from the unique raw name, so two same-titled
    # works cannot collide here either.
    out_path = destination / re.sub(r'\[[^\]]*\](?=\.[^.]+$)', "[ja]", raw_name)
    if out_path == raw_path:
        out_path = raw_path.with_name(raw_path.stem + " [ja]" + raw_path.suffix)
    report = convert_epub(raw_path, out_path, vertical=config.vertical,
                          title_jp=novel.title_jp, introduction_jp=introduction,
                          authors=authors, toc=toc)
    BOARD.write(f"  convert {out_path.name}")
    BOARD.write(f"          {report.describe()}")
    for warning in report.warnings:
        BOARD.write(f"          warning: {warning}")

    passed = True
    if config.verify:
        reference = destination / f".verify-{novel.provider_id}-{novel.novel_id}.epub"
        if download_file(session, config, novel, "jp", reference):
            passed, detail_text = verify_against_jp(out_path, reference)
            BOARD.write(f"          verify: {'OK — ' if passed else 'MISMATCH — '}{detail_text}")
            reference.unlink(missing_ok=True)
        else:
            BOARD.write("          verify: skipped (reference download failed)")

    _settle(raw_path, out_path, config, passed)
    return passed


def _settle(raw_path: Path, out_path: Path, config, passed: bool) -> None:
    """On a mismatch the bilingual source is the only way to work out what went
    wrong, so it survives — and the suspect output is renamed rather than left
    looking like a finished book."""
    if passed and not config.keep_original:
        raw_path.unlink(missing_ok=True)
    elif not passed:
        suspect = out_path.with_name(out_path.stem + " [UNVERIFIED]" + out_path.suffix)
        out_path.replace(suspect)
        BOARD.write(f"          kept the source and renamed the output to {suspect.name}")
