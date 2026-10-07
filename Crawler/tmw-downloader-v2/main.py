#!/usr/bin/env python3
"""tmw-downloader-v2: read the reading club's recommendations, and fetch them.

The club posts through a bot. Every recommendation is a title, a cover collage
and a job id, with the files behind a button on the message -- press it and the
bot answers privately with a one-time link that opens for about an hour.

So this reads the channel into a local page you can search and bookmark, and
presses that button for you: one job at a time, into `downloads/<club>/<title>`,
resuming rather than restarting when a transfer breaks.
"""

import argparse
import re
import sys
import threading
import time
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
from src.feed import Channels, Feed
from src.grab import Grabber
from src.models import human_size, snowflake_time
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
        description="Browse the reading club's recommendation channels as a "
                    "local page, and download what they point at.")
    parser.add_argument("--channel_id", help="Channel to read (default: #book-recommendations)")
    parser.add_argument("--guild_id", help="Server the channel is in")
    parser.add_argument("--port", type=int,
                        help="Local port (default: 18040; if it is taken or reserved, "
                             "the next free one of the ten from it)")
    parser.add_argument("--proxy", help="HTTP(S) proxy URL")
    parser.add_argument("--config", metavar="FILE", help="Config file (default: config.json)")
    parser.add_argument("--out", metavar="DIR",
                        help="Where downloads land (default: downloads/)")
    parser.add_argument("--history", metavar="REACH",
                        help="How far back to read: 7d, 2w, 3m, 1y, all, or a "
                             "plain message count. Only ever extends the cache")
    parser.add_argument("--count", type=int, metavar="N",
                        help="Stop after N messages this run. Combines with "
                             "--history, and the walk resumes next time")
    parser.add_argument("--tail", action="store_true",
                        help="Show only what arrives after this launch. The "
                             "cache still fills in the background")
    parser.add_argument("--cap", type=int, metavar="N",
                        help="Most posts the page renders at once (default 0, "
                             "no cap: the page virtualises the list)")
    parser.add_argument("--grab", metavar="POST", nargs="+",
                        help="Download these recommendations and exit. Takes "
                             "message ids or Discord message links")
    parser.add_argument("--offline", action="store_true",
                        help="Serve the cache without talking to Discord")
    parser.add_argument("--no-open", action="store_true", help="Do not open a browser")
    parser.add_argument("--doctor", action="store_true",
                        help="Test the token step by step and report what "
                             "Discord says at each one")
    parser.add_argument("--print", dest="print_only", action="store_true",
                        help="List the newest recommendations on the console and exit")
    return parser


REACH_HELP = """--history / --count read one channel's past, and this run would have
read #{name} ({cid}) -- the default, not something you asked for.

  python main.py --channel_id {cid} {flag}

Or set channel_id and history together in config.json, where that pair is
deliberate. The page can do it too: open it and press Fetch."""


def reach_needs_a_channel(config: Config, args) -> str:
    """Refuse a reach that never said which channel it is for.

    There is always a default channel to fall back on, so a bare `--history all`
    quietly walks whichever channel config.json happens to name -- rarely the
    one the person at the terminal had in mind, and several hundred requests
    spent finding out.
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
    """Fill forward, then reach back if this run was asked to."""
    if config.offline:
        print(f"Offline: {len(feed.cache)} cached message(s).")
        return True

    who = feed.client.whoami() or {}
    name = who.get("global_name") or who.get("username") or "?"
    print(f"Signed in as {name}. Reading #{feed.display_name}…")

    # An empty cache has no forward edge to sync from, so a cold run would
    # otherwise report "nothing newer" and show an empty channel. One page back
    # is enough to have something; the page grows the rest as you scroll.
    if not len(feed.cache) and not config.has_reach:
        first = feed.backfill(spec="", limit=config.page_size,
                              on_progress=progress("first:"))
        print("\r  {:,} message(s) to start with.{}".format(first["added"], " " * 20))

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
    """Find out which step Discord refuses, rather than guessing from one 403."""
    from src.api import Discord
    from src.gateway import Gateway

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

    # Both halves have to agree on the route. They are separate libraries and
    # only one of them finds a proxy by itself, so behind a tunnel this line is
    # the difference between "everything works" and "everything works except
    # the download button".
    print()
    print("route")
    if config.proxy:
        print(f"   {config.proxy}   (TMW_PROXY)")
    elif config.proxy_url:
        print(f"   {config.proxy_url}   (inherited from the environment)")
    else:
        print("   direct, no proxy")
    print("   used by the REST calls, the downloads and the gateway alike")

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
        elif key == "channel":
            print(f"     #{data.get('name')}")
        else:
            print(f"     {len(data or [])} message(s) readable")

    # The gateway is its own credential path, and downloading needs it: a token
    # that reads the channel perfectly well can still be refused a socket.
    print()
    gateway = Gateway(config)
    try:
        gateway.ensure(timeout=25)
        who = gateway.user.get("username") or "?"
        print(f"ok   the gateway, which the download button needs   ({who})")
    except Exception as exc:
        print("FAIL the gateway, which the download button needs")
        print(f"     {exc}")
        failed = failed or ("the gateway", 0, str(exc))
    finally:
        gateway.close()

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

    print()
    if not failed:
        print("Everything the page and the downloads need is working.")
        return 0

    label, status, why = failed
    print(f"First failure: {label} ({status}).")
    if status == 401:
        print("The token is not valid. Read a fresh one and update .env.")
    elif "50001" in (why or ""):
        print("Missing Access. The account is in the server but cannot read")
        print("this channel -- see the permission arithmetic above.")
    return 1


def report(feed: Feed, count: int = 20) -> int:
    """The console version of the page: the newest recommendations."""
    payload = feed.payload(cap=0)
    items = payload["posts"][-count:]
    if not items:
        print("\nNothing cached yet.")
        return 0

    marks = {b["id"] for b in payload.get("bookmarks", [])}
    taken = set(payload.get("taken", []))
    print(f"\nNewest {len(items)} of {payload['display']['in_scope']:,} recommendation(s):\n")

    for item in reversed(items):
        kind = f"[{item['kind']}] " if item["kind"] else ""
        flag = "* " if item["id"] in marks else "  "
        tick = "v" if item["job"] in taken else " "
        when = datetime.fromisoformat(item["ts"]).astimezone()
        vols = f"  {item['volumes']}" if item["volumes"] else ""
        print(f"{flag}{tick} {when:%Y-%m-%d %H:%M}  {kind}{item['title'] or '(untitled)'}{vols}")
        who = item["who"] or "Anon"
        where = "hosted" if item["hosted"] else "elsewhere"
        print(f"       job {item['job']}  ({where})  rec. by {who}")
        for title in item["titles"][1:]:
            print(f"         {title}")
        if item["body"]:
            print(f"       {item['body'].splitlines()[0][:70]}")
        print()
    return 0


MESSAGE_RE = re.compile(r"(\d{15,25})\s*$")


def grab(feed: Feed, grabber: Grabber, wanted, config: Config) -> int:
    """Download some recommendations from the command line and wait for them."""
    ids = []
    for text in wanted:
        found = MESSAGE_RE.search(str(text).strip().rstrip("/"))
        if not found:
            print(f"not a message id or link: {text}")
            return 1
        ids.append(found.group(1))

    tasks = []
    for message_id in ids:
        try:
            task = grabber.grab(feed, message_id)
        except Exception as exc:
            print(f"{message_id}: {exc}")
            return 1
        tasks.append(task)
        print(f"queued {task.title or task.job}  ({task.job})")

    print(f"\ninto {config.download_path.resolve()}\n")
    # A line per state change, and per whole percent while one is moving.
    # Printing on every poll turned a 60 MB download into two hundred
    # identical lines.
    seen = {}
    while any(t.active for t in tasks):
        for task in tasks:
            line = "{:>8}  {}".format(task.state, task.title or task.job)
            step = task.state
            if task.transfers:
                done = sum(1 for f in task.transfers if f.state in ("done", "held"))
                got = sum(f.got for f in task.transfers)
                size = sum(f.size for f in task.transfers)
                pct = int(100 * got / size) if size else 0
                line += "  {}/{} files  {}".format(
                    done, len(task.transfers), human_size(got))
                if size:
                    line += " of {}  {}%".format(human_size(size), pct)
                step = "{} {} {}".format(task.state, done, pct)
            if seen.get(task.job) != step:
                seen[task.job] = step
                print(line)
        time.sleep(1.0)

    print()
    bad = 0
    for task in tasks:
        where = task.folder if task.transfers else (task.links and task.links[0] or "")
        print(f"{task.state:>8}  {task.title or task.job}  {where}")
        if task.error:
            print(f"          {task.error}")
        bad += task.state == "failed"
    return 1 if bad else 0


def run(config: Config, args) -> int:
    if getattr(args, "doctor", False):
        if not config.token:
            print(TOKEN_HELP)
            return 1
        return doctor(config)

    channels = Channels(config)
    feed = channels.main
    grabber = Grabber(config, channels.opened)

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

    if args.grab:
        try:
            code = grab(feed, grabber, args.grab, config)
        finally:
            grabber.close()
            feed.close()
        return code

    posts = feed.posts()
    # A poor yield is worth explaining rather than leaving as a mystery.
    if len(feed.cache) and len(posts) * 4 < len(feed.cache):
        t = why_dropped(feed.cache.all())
        print(f"  {t['kept']:,} of {t['total']:,} messages are recommendations "
              f"(chatter: {t['human']:,}, system: {t['system']:,}, "
              f"no job: {t['no_job']:,})")

    httpd, port = serve(channels, grabber, config.port)
    url = f"http://127.0.0.1:{port}/"
    print(f"\n{len(posts):,} recommendation(s) from {len(feed.cache):,} message(s).")
    print(f"  archive: {describe_coverage(feed.coverage())}")
    print(f"  downloads: {config.download_path.resolve()}")
    if config.tail:
        print("  showing only what arrives after this launch (--tail); "
              "the cache keeps filling.")
    print(f"  {url}   (Ctrl+C to stop)")

    if config.open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.shutdown()
        grabber.close()
        channels.close()
    return 0


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        config = Config.load(args.config).apply_args(args)
    except ValueError as exc:
        print(exc)
        return 1
    if not args.doctor:
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
