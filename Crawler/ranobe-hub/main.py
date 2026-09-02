#!/usr/bin/env python3
"""ranobe-hub — one console over annas-archive-downloader and novelia-downloader.

Neither downloader can answer the question you actually have: *for this series,
who has volume 7, and in what shape?* That only appears once both catalogues are
lined up against the same volume numbers — which is what this does.

It owns no scraping and no conversion. Both sibling projects are imported and
driven as libraries, so their fixes are inherited rather than copied.
"""

import argparse
import sys
from pathlib import Path

# Titles are Japanese; the default Windows console codec (cp932) would raise
# UnicodeEncodeError when printing them. Force UTF-8 output.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from src import bridge
from src.shell import Shell


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="One console over annas-archive and novelia: merge both "
                    "catalogues per volume, plan by policy, download.")
    parser.add_argument("query", nargs="*",
                        help="Run this search on start-up, then drop into the console")
    parser.add_argument("-o", "--output", metavar="DIR", default="downloads",
                        help="Output directory (default: downloads)")
    parser.add_argument("--policy", help="Planning policy (default: japanese)")
    parser.add_argument("--sources", choices=["both", "annas", "novelia"], default="both",
                        help="Which catalogues to search (default: both)")
    parser.add_argument("--annas-config", metavar="FILE",
                        help="Config file for the annas downloader")
    parser.add_argument("--novelia-config", metavar="FILE",
                        help="Config file for the novelia downloader")
    parser.add_argument("--once", action="store_true",
                        help="Run the start-up search, print the result, and exit")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        bridge.load()
    except bridge.BridgeError as exc:
        print(f"cannot start: {exc}")
        return 1

    annas_config = bridge.annas("config").Config.load(args.annas_config)
    novelia_config = bridge.novelia("config").Config.load(args.novelia_config)

    shell = Shell(annas_config, novelia_config, args.output)
    shell.sources = args.sources
    if args.policy:
        policy_mod = __import__("src.policy", fromlist=["policy"])
        if args.policy not in policy_mod.POLICIES:
            print(f"unknown policy {args.policy!r}; "
                  f"known: {', '.join(policy_mod.POLICIES)}")
            return 1
        shell.policy = args.policy

    query = " ".join(args.query).strip()
    if query:
        shell.cmd_find(query)
        if args.once:
            return 0
    elif args.once:
        print("--once needs a query")
        return 1

    return shell.run()


if __name__ == "__main__":
    sys.exit(main())
