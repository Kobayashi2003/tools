#!/usr/bin/env python3
"""book-sharing: read a Discord upload channel as a page you can act on.

Reads the channel, groups a multi-message upload back into one share, and serves
a local page with the download links laid out. It downloads nothing itself: the
page is for finding things, bookmarking them, and handing the links to whatever
does the downloading.
"""

import argparse
import sys
import threading
import webbrowser
from datetime import datetime

# Titles and filenames here are Japanese; the default Windows console codec
# (cp936/cp932) would raise UnicodeEncodeError on the first line printed.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from src.api import AuthRequired, NoAccess
from src.config import Config
from src.feed import Feed
from src.models import snowflake_time
from src.parse import why_dropped
from src.server import serve

TOKEN_HELP = """\
No token found. Discord's API does not accept cookies -- every call carries an
account token in an `Authorization` header instead.

  1. copy .env.example to .env
  2. open Discord in the browser, F12 -> Network, click any channel
  3. find a request to /api/v9/... and copy its `Authorization` request header
  4. paste it after TMW_TOKEN= in .env

That token is your whole account. .gitignore already excludes .env; keep it
there. Or run with --offline to read whatever is already cached."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Browse a Discord upload channel as a local page, with a "
                    "searchable index and bookmarks.")
    parser.add_argument("--channel_id", help="Channel to read (default: from config.json)")
    parser.add_argument("--guild_id", help="Server the channel is in")
    parser.add_argument("--port", type=int,
                        help="Local port (default: 8420; the next free one is "
                             "used if it is taken or reserved)")
    parser.add_argument("--proxy", help="HTTP(S) proxy URL")
    parser.add_argument("--config", metavar="FILE", help="Config file (default: config.json)")
    parser.add_argument("--history", metavar="REACH",
                        help="How far back to read: 7d, 2w, 3m, 1y, all, or a "
                             "plain message count. Only ever extends the cache")
    parser.add_argument("--count", type=int, metavar="N",
                        help="Stop after N messages this run. Combines with "
                             "--history, and the walk resumes next time — this "
                             "is how to pace a large backfill across sessions")
    parser.add_argument("--tail", action="store_true",
                        help="Show only what arrives after this launch. The "
                             "cache still fills in the background")
    parser.add_argument("--cap", type=int, metavar="N",
                        help="Most posts the page renders at once (default 0, "
                             "no cap: the page virtualises the list)")
    parser.add_argument("--no-merge", action="store_true",
                        help="Keep every message separate instead of folding "
                             "silent follow-ups into the post above them")
    parser.add_argument("--offline", action="store_true",
                        help="Serve the cache without talking to Discord")
    parser.add_argument("--no-open", action="store_true", help="Do not open a browser")
    parser.add_argument("--migrate-from", metavar="CHANNEL_ID",
                        help="Carry bookmarks and download ticks over from "
                             "another channel's archive, matching on file name "
                             "and size. Safe to repeat as more of the archive "
                             "arrives")
    parser.add_argument("--doctor", action="store_true",
                        help="Test the token step by step and report what "
                             "Discord says at each one")
    parser.add_argument("--print", dest="print_only", action="store_true",
                        help="List the newest shares on the console and exit")
    return parser


REACH_HELP = """--history / --count read one channel's past, and this run would have
read #{name} ({cid}) -- the default, not something you asked for.

  python main.py --channel_id {cid} {flag}

Or set channel_id and history together in config.json, where that pair is
deliberate. The page can do it too: open it and press Fetch."""


def reach_needs_a_channel(config: Config, args) -> str:
    """Refuse a reach that never said which channel it is for.

    `--history` and `--count` read down one channel's past, and there is always
    a default channel to fall back on -- so a bare `--history all` quietly walks
    whichever channel config.json happens to name, which is rarely the one the
    person at the terminal had in mind. Naming it costs a flag; a few hundred
    requests spent on the wrong channel costs rather more.

    Only the command-line flags are guarded. `history` written in config.json
    beside `channel_id` is a deliberate pair, and is left alone.
    """
    if not (getattr(args, "history", None) or getattr(args, "count", None)):
        return ""
    if getattr(args, "channel_id", None):
        return ""
    flag = f"--history {config.history}" if config.history else f"--count {config.fetch_limit}"
    return REACH_HELP.format(name=config.channel_name, cid=config.channel_id, flag=flag)


def progress(label: str):
    """Count plus the date reached -- during a long backfill the useful
    question is what year you are in, not how many rows went by."""
    def report(count: int, edge_id: str):
        when = snowflake_time(edge_id).astimezone()
        print(f"\r  {label} {count:,} messages… ({when:%Y-%m-%d}){' ' * 8}",
              end="", flush=True)
    return report


def sync(feed: Feed, config: Config) -> bool:
    """Fill forward, then reach back if this run was asked to. Returns False
    when there is nothing cached and nothing was asked for."""
    if config.offline:
        print(f"Offline: {len(feed.cache)} cached message(s).")
        return True

    who = feed.client.whoami() or {}
    name = who.get("global_name") or who.get("username") or "?"
    print(f"Signed in as {name}. Reading #{feed.display_name}…")

    result = feed.sync(on_progress=progress("new:"))
    if result["fetched"]:
        print(f"\r  {result['fetched']:,} message(s) newer than the cache, "
              f"{result['added']:,} new.{' ' * 20}")
    else:
        print("  nothing newer than the cache.")

    if config.has_reach:
        if config.history in ("all", "full", "everything"):
            print("  reaching back to the start of the channel — "
                  "Ctrl+C is safe, progress is kept.")
        older = feed.backfill(on_progress=progress("back:"))
        note = "reached the start of the channel" if older["done"] else "stopped at the limit"
        print(f"\r  {older['added']:,} older message(s), {note}.{' ' * 20}")
    feed.flush()
    return True


def describe_coverage(coverage: dict) -> str:
    """The fetch reach in one line."""
    if not coverage["messages"]:
        return "empty"
    start = datetime.fromisoformat(coverage["oldest_at"]).astimezone()
    end = datetime.fromisoformat(coverage["newest_at"]).astimezone()
    edge = "complete" if coverage["complete"] else "partial, reaches back further"
    return (f"{start:%Y-%m-%d} → {end:%Y-%m-%d %H:%M} "
            f"({coverage['messages']:,} messages, {edge})")


def doctor(config: Config) -> int:
    """Find out which step Discord refuses, rather than guessing from one 403.

    A 403 on the messages endpoint has several quite different causes and they
    need different fixes, so each is checked on its own. When the refusal turns
    out to be a permission, the channel's overwrites are resolved against the
    account's roles here -- Discord will not say *which* rule denied it, but the
    arithmetic is public and it names the role you are missing.
    """
    from src.api import Discord

    VIEW = 1 << 10
    ADMIN = 1 << 3

    token = config.token
    print("token")
    if not token:
        print("   missing -- put it in .env as TMW_TOKEN")
        return 1
    parts = token.split(".")
    print(f"   {len(token)} chars, {len(parts)} dot-separated part(s)")
    if token.lower().startswith("bearer "):
        print("   ! starts with 'Bearer '. That is an OAuth token from a")
        print("     different request, not the account token.")
        return 1

    client = Discord(config)
    got = {}

    steps = [
        ("me", "who the token belongs to", "GET", "/users/@me", None),
        ("guilds", "the servers it can see", "GET", "/users/@me/guilds", None),
        ("member", "its membership of this server", "GET",
         f"/users/@me/guilds/{config.guild_id}/member", None),
        ("roles", "the roles that exist there", "GET",
         f"/guilds/{config.guild_id}/roles", None),
        ("channels", "the channels it can see there", "GET",
         f"/guilds/{config.guild_id}/channels", None),
        ("channel", "the channel itself", "GET", f"/channels/{config.channel_id}", None),
        ("messages", "one message from it", "GET",
         f"/channels/{config.channel_id}/messages", {"limit": 1}),
    ]

    failed = None
    for key, label, method, path, params in steps:
        status, why, data = client.probe(method, path,
                                         **({"params": params} if params else {}))
        ok = bool(status and 200 <= status < 300)
        got[key] = data if ok else None
        print()
        print(f"{'ok  ' if ok else 'FAIL'} {label}   ({status})")
        if not ok:
            print(f"     {why or 'no reason given'}")
            failed = failed or (label, status, why)
            continue

        if key == "me":
            print(f"     {data.get('username')} ({data.get('id')})")
        elif key == "guilds":
            here = [g for g in data or [] if str(g.get("id")) == config.guild_id]
            print(f"     {len(data or [])} server(s); this one: "
                  f"{'yes -- ' + here[0].get('name') if here else 'NOT PRESENT'}")
        elif key == "member":
            print(f"     joined {str(data.get('joined_at'))[:10]}, "
                  f"{len(data.get('roles') or [])} role(s), pending={data.get('pending')}")
        elif key == "roles":
            print(f"     {len(data or [])} role(s) defined")
        elif key == "channels":
            here = [c for c in data or [] if str(c.get("id")) == config.channel_id]
            print(f"     {len(data or [])} listed; the configured id is "
                  + ("present" if here else "NOT among them"))
            if here and here[0].get("nsfw"):
                print("     ! the channel is marked age-restricted")
        elif key == "channel":
            print(f"     #{data.get('name')}")
        else:
            print(f"     {len(data or [])} message(s) readable")

    # ---- why a permission refusal happened ------------------------------
    chan = next((c for c in (got.get("channels") or [])
                 if str(c.get("id")) == config.channel_id), None)
    if failed and chan and got.get("member") is not None:
        mine = set(str(r) for r in (got["member"].get("roles") or []))
        by_id = {str(r.get("id")): r for r in (got.get("roles") or [])}
        everyone = config.guild_id

        base = 0
        for rid in [everyone] + sorted(mine):
            role = by_id.get(rid)
            if role:
                base |= int(role.get("permissions") or 0)

        overwrites = {str(o.get("id")): o for o in (chan.get("permission_overwrites") or [])}
        blame = []

        def apply(over):
            nonlocal base
            base &= ~int(over.get("deny") or 0)
            base |= int(over.get("allow") or 0)

        if base & ADMIN:
            verdict = "administrator, so everything is allowed"
        else:
            if everyone in overwrites:
                if int(overwrites[everyone].get("deny") or 0) & VIEW:
                    blame.append("@everyone is denied view on this channel")
                apply(overwrites[everyone])

            allow = deny = 0
            for rid in mine:
                over = overwrites.get(rid)
                if over:
                    allow |= int(over.get("allow") or 0)
                    deny |= int(over.get("deny") or 0)
            base &= ~deny
            base |= allow

            me_id = str((got.get("me") or {}).get("id") or "")
            if me_id in overwrites:
                if int(overwrites[me_id].get("deny") or 0) & VIEW:
                    blame.append("this account is denied view individually")
                apply(overwrites[me_id])
            verdict = "view allowed" if base & VIEW else "view NOT allowed"

        print()
        print(f"permission arithmetic for #{chan.get('name')}: {verdict}")
        for line in blame:
            print(f"     {line}")
        grants = [by_id[r].get("name") for r in overwrites
                  if r in by_id and r != everyone
                  and int(overwrites[r].get("allow") or 0) & VIEW]
        if grants:
            have = [by_id[r].get("name") for r in mine if r in by_id]
            print(f"     roles that grant view: {', '.join(grants)}")
            print(f"     roles this account has: {', '.join(have) or 'none'}")
            missing = [g for g in grants if g not in have]
            if missing:
                print(f"     -> missing: {', '.join(missing)}")
                print("        Get that role in Discord (usually a rules or")
                print("        role-picker channel), then Refresh.")

    print()
    if not failed:
        print("Everything the sync needs is working.")
        return 0

    label, status, why = failed
    print(f"First failure: {label} ({status}).")
    if status == 401:
        print("The token is not valid. Read a fresh one and update .env.")
    elif "50001" in (why or ""):
        print("Missing Access. The account is in the server but cannot read")
        print("this channel -- see the permission arithmetic above.")
    elif status == 403:
        print("Discord refused without naming a permission, which usually means")
        print("the edge blocked the request rather than the account.")
    return 1


def report(feed: Feed, count: int = 20) -> int:
    """The console version of the page: the newest shares, and where to get them."""
    payload = feed.payload(cap=0)
    items = payload["posts"][-count:]
    if not items:
        print("\nNothing cached yet.")
        return 0

    marks = {b["id"] for b in payload.get("bookmarks", [])}
    taken = set(payload.get("taken", []))
    print(f"\nNewest {len(items)} of {payload['display']['in_scope']:,} share(s):\n")

    detail = {d["id"]: d for d in feed.detail([i["id"] for i in items])}
    for item in reversed(items):
        kind = f"[{item['category']}] " if item["category"] else ""
        who = f"{item['author']} - " if item["author"] else ""
        flag = "* " if item["id"] in marks else "  "
        when = datetime.fromisoformat(item["ts"]).astimezone()
        print(f"{flag}{when:%Y-%m-%d %H:%M}  {kind}{who}{item['title'] or '(untitled)'}")
        for file in detail.get(item["id"], {}).get("files", []):
            tick = "v" if file["id"] in taken else " "
            print(f"    {tick} {file['size_human']:>10}  {file['filename']}")
            print(f"                     {file['url']}")
        for link in detail.get(item["id"], {}).get("links", []):
            print(f"      {'link':>10}  {link['url']}")
        print()
    return 0


def migrate(config: Config, args) -> int:
    """Move bookmarks and ticks from an older channel's archive into this one."""
    source = Config.load(args.config).apply_args(args)
    source.channel_id = args.migrate_from
    source.offline = True

    here, there = Feed(config), Feed(source)
    if not len(there.cache):
        print(f"No cached archive for channel {args.migrate_from}.")
        return 1
    if not len(here.cache):
        print("This channel has nothing cached yet -- fetch some of it first, "
              "then run this again.")
        return 1

    print(f"from {args.migrate_from}: {len(there.posts()):,} shares, "
          f"{len(there.state.taken):,} ticked file(s), "
          f"{len(there.state.bookmarks):,} bookmark(s)")
    print(f"into {config.channel_id}: {len(here.posts()):,} shares cached")

    moved = here.carry_over(there)
    print(f"\n  ticks carried over : {moved['taken']:,} "
          f"(no match yet: {moved['taken_missed']:,})")
    print(f"  bookmarks carried  : {moved['bookmarks']:,} "
          f"(no match yet: {moved['bookmarks_missed']:,})")
    for title in moved.get("matched", []):
        print(f"      carried  {title[:58]}")
    for title in moved.get("missed", []):
        print(f"      not yet  {title[:58]}")
    if moved["taken_missed"] or moved["bookmarks_missed"]:
        print("\n  What did not match is almost certainly not in the cache yet.")
        print("  Fetch more of the channel and run this again -- it only adds.")
    here.close()
    return 0


def run(config: Config, args) -> int:
    if getattr(args, "migrate_from", None):
        return migrate(config, args)
    if getattr(args, "doctor", False):
        if not config.token:
            print(TOKEN_HELP)
            return 1
        return doctor(config)

    feed = Feed(config)

    if not config.offline and not config.token:
        print(TOKEN_HELP)
        return 1

    try:
        if not sync(feed, config):
            return 1
    except (AuthRequired, NoAccess) as exc:
        print(f"\n{exc}")
        return 1
    except Exception as exc:
        # A network hiccup should still let you read the cache.
        print(f"\nSync failed: {exc}")
        if not len(feed.cache):
            return 1
        print("Serving the cache instead.")

    if args.print_only:
        code = report(feed)
        feed.close()
        return code

    posts = feed.posts()
    # A poor yield is worth explaining rather than leaving as a mystery: the
    # commonest cause is a channel reposted by a webhook, which the bot rule
    # drops wholesale.
    if len(feed.cache) and len(posts) * 8 < len(feed.cache):
        t = why_dropped(feed.cache.all())
        print(f"  only {t['kept']:,} of {t['total']:,} messages carry files or links "
              f"(bot: {t['bot']:,}, system: {t['system']:,}, no files: {t['no_payload']:,})")
    httpd, port = serve(feed, config.port)
    url = f"http://127.0.0.1:{port}/"
    print(f"\n{len(posts):,} share(s) from {len(feed.cache):,} message(s).")
    print(f"  archive: {describe_coverage(feed.coverage())}")
    if config.tail:
        print("  showing only what arrives after this launch (--tail); "
              "the cache keeps filling.")
    elif config.display_cap and len(posts) > config.display_cap:
        print(f"  the page renders {config.display_cap:,} at a time; "
              f"widen it there or with --cap.")
    print(f"  {url}   (Ctrl+C to stop)")

    if config.open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.shutdown()
        # Both stores write on a timer while a crawl is in flight; this is what
        # makes the last of it durable.
        feed.flush()
    return 0


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        config = Config.load(args.config).apply_args(args)
    except ValueError as exc:
        print(exc)
        return 1
    if not (args.doctor or args.migrate_from):
        complaint = reach_needs_a_channel(config, args)
        if complaint:
            print(complaint)
            return 1
    try:
        return run(config, args)
    except KeyboardInterrupt:
        print("\nInterrupted.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
