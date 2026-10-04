#!/usr/bin/env python3
"""Novelia Downloader v2 command line."""

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")


def main():
    parser = argparse.ArgumentParser(description="Novelia Downloader v2")
    commands = parser.add_subparsers(dest="command")
    serve = commands.add_parser("serve", help="Start the local Web manager (default)")
    serve.add_argument("--port", type=int, default=8765)
    commands.add_parser("doctor", help="Check access to the light novel catalog without downloading books")
    convert = commands.add_parser("convert-local", help="Convert a local directory of bilingual EPUBs")
    convert.add_argument("directory", type=Path)
    convert.add_argument("--output", type=Path, required=True)
    convert.add_argument("--reference-dir", type=Path, help="Japanese references with the same relative filenames")
    convert.add_argument("--horizontal", action="store_true")
    args = parser.parse_args()
    if args.command in (None, "serve"):
        import uvicorn
        from app.server import create_app
        uvicorn.run(create_app(), host="127.0.0.1", port=getattr(args, "port", 8765), workers=1)
        return 0
    if args.command == "doctor":
        from app.client import Client
        from app.schema import Settings
        client = Client(Settings(page_size=24))
        try:
            payload = client.listing(1, 1)
            print(f"OK: {len(payload['items'])} light novels on page 1; {payload['pageNumber']} pages.")
            return 0
        except Exception as exc:
            print(f"FAILED: {exc}")
            return 1
        finally:
            client.close()
    from app.client import validate_epub
    from app.converter import convert_epub, verify_against_jp
    source_root, output_root = args.directory.resolve(), args.output.resolve()
    if not source_root.is_dir() or output_root == source_root or output_root.is_relative_to(source_root):
        parser.error("Input must be a directory and output must be outside the input directory.")
    sources = sorted(p for p in source_root.rglob("*") if p.suffix.lower() == ".epub")
    reports, failed = [], 0
    for source in sources:
        relative = source.relative_to(source_root)
        reference = args.reference_dir.resolve() / relative if args.reference_dir else None
        destination = output_root / relative.with_name(relative.stem + " [ja].epub")
        try:
            validate_epub(source)
            report = convert_epub(source, destination, vertical=not args.horizontal,
                                  restore_css_from=reference if reference and reference.is_file() else None)
            if report.kept_ja == 0:
                destination.unlink(missing_ok=True)
                raise ValueError("No Japanese paragraph markers found")
            passed, message = verify_against_jp(destination, reference) if reference and reference.is_file() else (
                False, "No reference supplied")
            if not passed:
                suspect = destination.with_name(destination.stem + " [UNVERIFIED].epub")
                destination.replace(suspect)
                destination = suspect
                failed += 1
            reports.append({"source": str(source), "output": str(destination), "verified": passed,
                            "detail": message, "report": asdict(report)})
            print(f"{'Verified' if passed else 'Unverified'}: {relative}")
        except Exception as exc:
            failed += 1
            reports.append({"source": str(source), "error": str(exc)})
            print(f"Failed: {relative}: {exc}")
    output_root.mkdir(parents=True, exist_ok=True)
    (output_root / "conversion-report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Processed {len(sources)} file(s), {failed} unverified or failed. Sources preserved.")
    return 1 if failed or not sources else 0


if __name__ == "__main__":
    raise SystemExit(main())
