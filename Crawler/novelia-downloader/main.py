#!/usr/bin/env python3
"""novelia downloader.

Search https://n.novelia.cc, pick works from a checkbox list, download them, and
turn the bilingual files into Japanese-only ones laid out for vertical reading.

The site keeps two catalogues and one search covers both: 文库 (published books,
one work is a set of volumes) and 网络 (web novels, one work is a stream of
chapters). Both offer the bilingual builds `zh-jp` and `jp-zh`, which are the
target here — they are downloaded and then stripped back to Japanese.

Only web novels also offer a Japanese-only build; a library volume answers 400
for it, which is why the conversion has to exist at all. Each conversion is
checked against whichever Japanese reference that catalogue does have: the
site's `mode=jp` build for a web novel, the publisher's uploaded original for a
library volume.
"""

import argparse
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import List

# Titles are Japanese; the default Windows console codec (cp932) would raise
# UnicodeEncodeError when printing them. Force UTF-8 output.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from src.api import (AuthRequired, enrich_wenku, fetch_metadata, fetch_wenku_metadata,
                     search, search_wenku)
from src.download import guarded, parse_volume_spec, process
from src.config import ALL_PROVIDERS, ALL_TRANSLATIONS, DEFAULT_SITE, Config
from src.models import BILINGUAL, MODES, WEB, WENKU
from src.naming import build_filename, disambiguate, sanitize, volume_filename
from src.selector import choose
from src.session import SessionPool, create_session


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Search n.novelia.cc, download works, convert bilingual files "
                    "to Japanese-only vertical EPUBs.")
    parser.add_argument("query", nargs="*", help="Search keyword (prompted for if omitted)")
    parser.add_argument("--id", metavar="ID", action="append",
                        help="Skip the search and take this work directly: "
                             "`wenku/688da4c4c923db0b7aa9943e` for a library work, "
                             "`alphapolis/159124863-713069479` for a web novel. "
                             "Repeatable, no token needed.")
    parser.add_argument("-k", "--kind", choices=["both", WENKU, WEB],
                        help="Which catalogue to search (default: both)")
    parser.add_argument("--volumes", metavar="SPEC",
                        help="For library works, which volumes to take: 1,3,5-8 (default: all)")
    parser.add_argument("-o", "--output_dir", metavar="DIR", help="Output directory (default: downloads)")
    parser.add_argument("-m", "--mode", choices=list(MODES),
                        help="Source build to download (default: jp-zh)")
    parser.add_argument("-p", "--pages", type=int, help="Search result pages to read (default: 1)")
    parser.add_argument("--providers", help=f"Sources to search (default: {','.join(ALL_PROVIDERS)})")
    parser.add_argument("--translations", help=f"Translation engines, best first "
                                               f"(default: {','.join(ALL_TRANSLATIONS)})")
    parser.add_argument("--translations_mode", choices=["priority", "parallel"],
                        help="How the site picks between translations (default: priority)")
    parser.add_argument("--file_type", choices=["epub", "txt"], help="File format (default: epub)")
    parser.add_argument("--no-convert", dest="convert", action="store_false", default=None,
                        help="Keep the bilingual file as downloaded")
    parser.add_argument("--no-vertical", dest="vertical", action="store_false", default=None,
                        help="Convert to Japanese-only but leave the layout horizontal")
    parser.add_argument("--keep_original", action="store_true", default=None,
                        help="Also keep the unconverted bilingual download")
    parser.add_argument("--no-verify", dest="verify", action="store_false", default=None,
                        help="Skip checking the result against a Japanese reference build")
    parser.add_argument("--site", help=f"Site root (default: {DEFAULT_SITE})")
    parser.add_argument("-t", "--token", help="Login token; also read from token.txt / NOVELIA_TOKEN")
    parser.add_argument("-w", "--workers", type=int, help="Concurrent downloads (default: 3)")
    parser.add_argument("--proxy", help="HTTP(S) proxy URL")
    parser.add_argument("--config", metavar="FILE", help="Config file (default: config.json)")
    parser.add_argument("-y", "--yes", action="store_true", help="Take every result, skip the list")
    parser.add_argument("--dry-run", action="store_true", help="List what would be downloaded and stop")
    return parser


def format_row(novel, width: int = 42) -> str:
    title = novel.display_title()
    if len(title) > width:
        title = title[:width - 1] + "…"
    zh = novel.title_zh if novel.title_zh != novel.title_jp else ""
    if zh and len(zh) > 20:
        zh = zh[:19] + "…"
    return f"[{novel.label}] {title:<{width}}  {novel.summary():<30}  {zh}"


def assign_output_names(novels, config) -> None:
    """Give every work a path component that is unique within this run.

    A library work becomes a folder and a web novel becomes a file, but both
    derive their name from the title — so two same-titled works would land on
    one path and the second would look like it had already been downloaded.
    """
    taken = set()
    for novel in novels:
        if novel.kind == WENKU:
            base = sanitize(novel.display_title())
        else:
            base = build_filename(novel, config.mode, config.file_type)
        # The id is what actually distinguishes two same-titled works.
        novel.output_name = disambiguate(base, taken, novel.novel_id)
        taken.add(novel.output_name)


def collect(config: Config, query: str, ids, assume_yes: bool):
    """Resolve the works to act on, either from --id or from a search."""
    session = create_session(config)

    if ids:
        novels = []
        for raw in ids:
            if "/" not in raw:
                print(f"--id must look like wenku/<id> or <provider>/<novelId>, got {raw!r}")
                continue
            head, rest = raw.split("/", 1)
            if head.strip().lower() == WENKU:
                novel = fetch_wenku_metadata(session, config, rest.strip())
            else:
                novel = fetch_metadata(session, config, head.strip(), rest.strip())
            if novel:
                novels.append(novel)
        return session, novels

    print(f"Searching {config.site} for {query!r}…")
    novels: List = []
    notes: List[str] = []

    # The two catalogues are separate; a work often exists in both, as the
    # serialised version and as the published books.
    if config.kind in ("both", WENKU):
        try:
            found, truncated = search_wenku(session, config, query)
            novels.extend(found)
            if truncated:
                notes.append("more library pages exist")
        except AuthRequired as exc:
            notes.append(f"library search unavailable: {exc}")
    if config.kind in ("both", WEB):
        try:
            found, truncated = search(session, config, query)
            novels.extend(found)
            if truncated:
                notes.append("more web pages exist")
        except AuthRequired as exc:
            notes.append(f"web search needs a token ({exc}); library results still shown")

    for note in notes:
        print(f"  note: {note}")
    if not novels:
        print("No results.")
        return session, []

    # Library search returns only a title, so the volume counts that make the
    # list worth reading have to be looked up.
    enrich_wenku(session, config, novels)

    # Library volumes are the published books, so they lead.
    novels.sort(key=lambda n: (n.kind != WENKU, n.display_title()))
    wenku_count = sum(1 for n in novels if n.kind == WENKU)
    print(f"Found {len(novels)} work(s): {wenku_count} 文库 (published), "
          f"{len(novels) - wenku_count} 网络 (web).")

    rows = [format_row(n) for n in novels]
    header = (f"{query} — one row per work "
              f"(mode: {config.mode}"
              + ("; converted to Japanese-only" if config.convert else "")
              + ("; vertical" if config.convert and config.vertical else "") + ")")
    if assume_yes:
        print(header)
        for row in rows:
            print(f"  [x] {row}")
        return session, novels

    # Preselect the published editions — those are what a Japanese reader wants.
    chosen = choose(rows, preselected=[n.kind == WENKU for n in novels], header=header)
    if chosen is None:
        print("Cancelled.")
        return session, None
    return session, [novels[i] for i in chosen]


def run(config: Config, query: str, ids, assume_yes: bool, dry_run: bool) -> int:
    session, novels = collect(config, query, ids, assume_yes)
    if novels is None:
        return 1
    if not novels:
        return 1

    destination = Path(config.output_dir) / sanitize(query or "by-id")
    # Two works can share a title, and each kind builds its output path from
    # that title — so hand every work a name that is unique within this run.
    assign_output_names(novels, config)

    print(f"\n{len(novels)} work(s) -> {destination}")
    if dry_run:
        for novel in novels:
            print(f"  [{novel.label}] {novel.display_title()}  <-  {novel.url(config.site)}")
            if novel.kind != WENKU:
                print(f"      {build_filename(novel, config.mode, config.file_type)}")
                continue
            # A library work is one file per volume, so list them individually.
            if not novel.volumes:
                detail = fetch_wenku_metadata(session, config, novel.novel_id)
                if detail is not None:
                    novel = detail
            volumes = novel.volumes
            if config.volumes:
                volumes = [volumes[i] for i in parse_volume_spec(config.volumes, len(volumes))]
            for volume in volumes:
                print(f"      {volume_filename(volume, config.mode)}")
        return 0

    sessions = SessionPool(config)
    ok = 0
    with ThreadPoolExecutor(max_workers=max(1, config.workers)) as pool:
        for result in pool.map(
                lambda n: guarded(process, sessions.get(), config, n, destination),
                novels):
            ok += bool(result)
    print(f"\nDone: {ok}/{len(novels)} work(s) into {destination}")
    return 0 if ok == len(novels) else 1


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    config = Config.load(args.config).apply_args(args)

    query = " ".join(args.query).strip()
    if not query and not args.id:
        try:
            query = input("Search keyword: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 1
    if not query and not args.id:
        print("A search keyword or --id is required.")
        return 1

    try:
        return run(config, query, args.id, args.yes, args.dry_run)
    except KeyboardInterrupt:
        print("\nInterrupted.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
