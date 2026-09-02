#!/usr/bin/env python3
"""Anna's Archive series downloader.

Search a keyword, keep the best file for each volume it finds, show them as a
checkbox list, and download whatever the user ticks. "Best" is, in order:
epub before every other format, then the larger file, then the newer date.
Site: https://annas-archive.gl
"""

import argparse
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# Titles are often Japanese; the default Windows console codec (cp932) would
# raise UnicodeEncodeError when printing them. Force UTF-8 output.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from src import volumes as vol
from src.config import DEFAULT_MIRROR, Config
from src.downloader import download_all, human_size
from src.naming import build_filename, disambiguate, sanitize
from src.search import fetch_detail, search
from src.selector import choose
from src.session import create_session


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Search Anna's Archive, pick the best file per volume, download the ones you tick.")
    parser.add_argument("query", nargs="*", help="Search keyword (prompted for if omitted)")
    parser.add_argument("-o", "--output_dir", metavar="DIR", help="Output directory (default: downloads)")
    parser.add_argument("-p", "--pages", type=int, help="Search result pages to read (default: 1, 50 hits each)")
    parser.add_argument("-l", "--language", help="Language filter, e.g. en, zh, ja")
    parser.add_argument("-e", "--extension", help="Restrict the search to one format, e.g. epub")
    parser.add_argument("--mirror", help=f"Anna's Archive mirror (default: {DEFAULT_MIRROR})")
    parser.add_argument("--sort", choices=["", "newest", "oldest", "largest", "smallest",
                                           "newest_added", "oldest_added"],
                        help="Server-side result ordering")
    parser.add_argument("--rank", help="Ranking keys, best first (default: format,size,date)")
    parser.add_argument("--format_priority", metavar="LIST",
                        help="Format preference order (default: epub,azw3,mobi,fb2,djvu,cbz,cbr,pdf)")
    parser.add_argument("--volume_from", choices=["auto", "title", "publisher", "filename"],
                        help="Where to read the volume number from (default: auto)")
    parser.add_argument("--volume_regex", metavar="RE",
                        help="Custom volume pattern with one capturing group; overrides --volume_from")
    parser.add_argument("--loose", dest="strict", action="store_false", default=None,
                        help="Keep hits that do not contain every query word")
    parser.add_argument("--partial", action="store_true", default=None,
                        help="Also take the site's 'partial matches' — hits that fail the "
                             "--language/--extension filters")
    parser.add_argument("--precise_date", action="store_true", default=None,
                        help="Read each candidate's 'date open sourced' before ranking (one request per hit)")
    parser.add_argument("--backend", choices=["auto", "member", "libgen", "browser"],
                        help="Download route (default: auto)")
    parser.add_argument("-k", "--secret_key", metavar="KEY",
                        help="Anna's Archive membership key; also read from ANNAS_SECRET_KEY")
    parser.add_argument("-b", "--browser", choices=["chrome", "edge", "firefox", "auto"],
                        help="Browser for the browser backend (default: auto)")
    parser.add_argument("--headless", action="store_true", default=None,
                        help="Run the browser backend headless")
    parser.add_argument("-w", "--workers", type=int, help="Concurrent downloads (default: 3)")
    parser.add_argument("--proxy", help="HTTP(S) proxy URL")
    parser.add_argument("--config", metavar="FILE", help="Config file (default: config.json)")
    parser.add_argument("-y", "--yes", action="store_true",
                        help="Skip the checkbox list and take every volume")
    parser.add_argument("--dry-run", action="store_true", help="List the picks and stop")
    return parser


def enrich_dates(session, config, records) -> None:
    """Fill in each record's 'date open sourced' so ranking can use real dates."""
    print(f"Reading open-source dates for {len(records)} files…")

    def fetch(record):
        record.date_added = fetch_detail(session, config, record.md5).get("date_added", "")

    with ThreadPoolExecutor(max_workers=max(1, config.workers)) as pool:
        list(pool.map(fetch, records))


def format_row(group, width: int = 62) -> str:
    record = group.best
    title = record.title or record.filename or record.md5
    if len(title) > width:
        title = title[:width - 1] + "…"
    extra = ""
    if len(group.candidates) > 1:
        others = ", ".join(sorted({c.extension.upper() for c in group.candidates[1:] if c.extension}))
        extra = f"  (+{len(group.candidates) - 1} other: {others})" if others else ""
    return f"{group.label:<7} {title:<{width}}  {record.summary()}{extra}"


def run(config: Config, query: str, assume_yes: bool, dry_run: bool) -> int:
    unknown = [key for key in config.rank if key not in vol.RANK_KEYS]
    if unknown:
        print(f"Unknown --rank key(s): {', '.join(unknown)}. "
              f"Valid keys: {', '.join(vol.RANK_KEYS)}.")
        return 1

    session = create_session(config)

    print(f"Searching {config.mirror} for {query!r}…")
    records, partial_dropped = search(session, config, query)
    if not records:
        if partial_dropped:
            print(f"No results under the active filters "
                  f"({partial_dropped} partial match(es) available with --partial).")
        else:
            print("No results.")
        return 1
    print(f"Found {len(records)} files.")
    if partial_dropped:
        print(f"Ignored {partial_dropped} partial match(es) that fail the filters "
              f"(--partial includes them).")

    if config.strict:
        kept = [r for r in records if vol.matches_query(r, query)]
        if not kept:
            # Keeping everything beats showing an empty list, but say so — the
            # filter looking like it ran when it did not is worse than the noise.
            print(f"No hit contains every query word; keeping all {len(records)} "
                  f"(the relevance filter had nothing to keep).")
        elif len(kept) < len(records):
            print(f"Dropped {len(records) - len(kept)} hits that miss a query word (--loose keeps them).")
            records = kept

    if config.precise_date:
        enrich_dates(session, config, records)

    groups = vol.group_by_volume(records, config)
    numbered = sum(1 for g in groups if g.volume is not None)
    print(f"{numbered} volume(s) identified, {len(groups) - numbered} file(s) without a volume number.\n")

    rows = [format_row(group) for group in groups]
    header = (f"{query} — best file per volume "
              f"(rank: {', '.join(config.rank)}; formats: {', '.join(config.format_priority[:3])}…)")

    if assume_yes:
        picked = list(range(len(groups)))
        print(header)
        for row in rows:
            print(f"  [x] {row}")
    else:
        chosen = choose(rows, preselected=[g.volume is not None for g in groups], header=header)
        if chosen is None:
            print("Cancelled.")
            return 1
        picked = chosen

    if not picked:
        print("Nothing selected.")
        return 0

    destination = Path(config.output_dir) / sanitize(query)
    picks = []
    taken = set()
    for index in picked:
        group = groups[index]
        record = group.best
        name = disambiguate(build_filename(record, group.volume), taken, record.md5)
        taken.add(name)
        picks.append((record, destination / name))

    total_size = sum(record.size for record, _ in picks)
    print(f"\n{len(picks)} file(s), about {human_size(total_size)} -> {destination}")
    if dry_run:
        for record, path in picks:
            print(f"  {path.name}  <-  {record.url(config.mirror)}")
        return 0

    ok, total = download_all(session, config, picks)
    print(f"\nDone: {ok}/{total} file(s) downloaded into {destination}")
    return 0 if ok == total else 1


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    config = Config.load(args.config).apply_args(args)

    query = " ".join(args.query).strip()
    if not query:
        try:
            query = input("Search keyword: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 1
    if not query:
        print("A search keyword is required.")
        return 1

    try:
        return run(config, query, args.yes, args.dry_run)
    except KeyboardInterrupt:
        print("\nInterrupted.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
