"""Command handlers, registered declaratively so parsing, validation and
`help` share one source of truth (see registry.py).

This file is hot-reloaded by path: edit a handler, save, and the next command
uses it. COMMAND_MAP at the bottom is what the shell reads.
"""

import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Optional

from ..common import env
from ..core.api import API
from ..core.cache import Cache
from ..core.downloader import Downloader
from ..core.files import extract_files, get_config_value
from ..core.models import Artist, MigrationConfig
from ..core.scheduler import Scheduler
from ..core.storage import Storage
from ..services.external_links import (ExternalLinksDownloader, ExternalLinksExtractor,
                                       make_link_filter)
from ..services.migrator import Migrator
from ..services.validator import Validator
from .prompt import ask, confirm, prompt_artist
from .registry import Command, CommandError, ExitShell, Param, build_map


class CLIContext:
    """Bundle of services passed to every command handler."""

    def __init__(self, storage: Storage, cache: Cache, api: API,
                 downloader: Downloader, scheduler: Scheduler,
                 migrator: Migrator, validator: Validator,
                 links_extractor: ExternalLinksExtractor,
                 links_downloader: ExternalLinksDownloader):
        self.storage = storage
        self.cache = cache
        self.api = api
        self.downloader = downloader
        self.scheduler = scheduler
        self.migrator = migrator
        self.validator = validator
        self.links_extractor = links_extractor
        self.links_downloader = links_downloader
        self._last_artist: Optional[str] = None


_REGISTRY: List[Command] = []


def _cmd(name, group, summary, params=(), aliases=()):
    def register(fn):
        _REGISTRY.append(Command(name, fn, group, summary, tuple(params), tuple(aliases)))
        return fn
    return register


# Shared parameter specs.
_ARTIST = Param('artist', 'str', '', 'id, name or alias (else prompted)', hint='id/name')
_LISTING = (Param('sort_by', 'str', 'name', 'order',
                  choices=('name', 'recent', 'posts', 'service')),
            Param('service', 'str', '', 'only this service'))
_DEEP = Param('deep', 'bool', False, 'also re-flag edits')

# Which posts a download covers. Each one pairs with the batch command of the
# same name, so one creator and every creator are asked for the same way.
_LOST = Param('lost', 'bool', False, 'force-retry lost posts')
_PENDING = Param('pending', 'bool', False, 'only posts not tried yet')
_FAILED = Param('failed', 'bool', False, 'only posts with failed files')
_RECHECK = Param('lost', 'bool', False, 'also re-check lost posts')


# ============================================================================
# Helpers
# ============================================================================

def _c(text, code):
    """ANSI color, only when stdout is a real terminal."""
    if not sys.stdout.isatty():
        return text
    return f"\033[{code}m{text}\033[0m"


def _status(artist: Artist, corrupt: bool = False) -> str:
    if corrupt:
        return "BROKEN"
    if artist.completed:
        return "DONE"
    if artist.ignore:
        return "IGNORE"
    return "Active"


_TABLE_HEADER = f"{'#':>3}  {'STATUS':<6}  {'DONE/TOTAL':>11}  {'PENDING':>7}  {'FAIL':>4}  {'LOST':>4}  NAME"


def _artist_row(ctx: CLIContext, index: int, artist: Artist) -> str:
    """One aligned artist row. `done/total` is combined before padding so the
    column stays aligned regardless of digit count."""
    s = ctx.cache.stats(artist.id)
    corrupt = s.get('corrupt')
    progress = "?/?" if corrupt else f"{s['done']}/{s['total']}"
    line = (f"{index:>3}  {_status(artist, corrupt):<6}  {progress:>11}  "
            f"{s['pending']:>7}  {s['failed']:>4}  {s['lost']:>4}  {artist.display_name()} [{artist.id}]")
    if corrupt:
        return _c(line, 91)   # red: cache unreadable, state unknown
    if artist.completed:
        return _c(line, 92)   # green
    if artist.ignore:
        return _c(line, 90)   # gray
    if s['total'] == 0 or s['pending'] or s['failed']:
        return _c(line, 91)   # red: nothing cached, or pending/failed work
    return line


def print_artist_table(ctx: CLIContext, artists: List[Artist]):
    print("\n" + _TABLE_HEADER)
    print("-" * 70)
    for i, a in enumerate(artists, 1):
        print(_artist_row(ctx, i, a))


def get_artists(ctx: CLIContext, only_active=False, service="", sort_by="name") -> List[Artist]:
    artists = ctx.storage.get_artists()
    if only_active:
        artists = [a for a in artists if not a.ignore and not a.completed]
    if service:
        artists = [a for a in artists if a.service.lower() == service.lower()]
    if sort_by == "name":
        artists.sort(key=lambda a: a.display_name().lower())
    elif sort_by == "recent":
        artists.sort(key=lambda a: a.last_date or "", reverse=True)
    elif sort_by == "posts":
        artists.sort(key=lambda a: ctx.cache.stats(a.id)['total'], reverse=True)
    elif sort_by == "service":
        artists.sort(key=lambda a: (a.service, a.display_name().lower()))
    return artists


def _match_artist(artists: List[Artist], query: str) -> Optional[Artist]:
    """Exact index/id/name/alias first, then a unique substring of name or id."""
    if query.isdigit() and 1 <= int(query) <= len(artists):
        return artists[int(query) - 1]
    low = query.lower()
    exact = next((a for a in artists if a.id.lower() == low
                  or a.name.lower() == low or a.alias.lower() == low), None)
    if exact:
        return exact
    matches = [a for a in artists if low in a.display_name().lower() or low in a.id.lower()]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        sample = ', '.join(a.display_name() for a in matches[:5])
        raise CommandError(f"'{query}' is ambiguous: {sample}"
                           + (" ..." if len(matches) > 5 else ""))
    return None


def select_artist(ctx: CLIContext, query: str = "") -> Optional[Artist]:
    """Resolve an inline `artist=` value, or prompt with completion."""
    artists = get_artists(ctx)
    if not artists:
        print("No artists. Use 'add' first.")
        return None
    if not query:
        query = prompt_artist("Select artist (id/name, Tab to complete; 'list' to browse): ", artists)
        if not query:
            return None
    artist = _match_artist(artists, query)
    if not artist:
        raise CommandError(f"No artist matches '{query}'.")
    ctx._last_artist = artist.id
    return artist


def _is_active(a: Artist) -> bool:
    return not a.ignore and not a.completed


def _has_work(ctx: CLIContext, a: Artist) -> bool:
    """True if the artist has posts left to fetch/download (or nothing cached)."""
    s = ctx.cache.stats(a.id)
    return s['total'] == 0 or s['pending'] > 0 or s['failed'] > 0


def _fresh_count(ctx: CLIContext, artist_id: str) -> int:
    """Undone posts that have never failed -- what `:pending` targets."""
    return sum(1 for p in ctx.cache.get_undone(artist_id) if not p.failed_files)


# ============================================================================
# Creators
# ============================================================================

@_cmd('add', 'CREATORS', 'Track a new creator by URL')
def cmd_add(ctx: CLIContext):
    url = ask("Artist URL (kemono or pawchive): ")
    if url is None:
        return
    if not url:
        print("URL required.")
        return
    parts = url.rstrip('/').split('/')
    if len(parts) < 5:
        raise CommandError("Invalid URL. Expected .../{service}/user/{id}")
    service, user_id = parts[-3], parts[-1]
    artist_id = f"{service}_{user_id}"
    if ctx.storage.get_artist(artist_id):
        print(f"Artist {artist_id} already exists.")
        return

    name = None
    try:
        print("Fetching profile...")
        profile = ctx.api.get_profile(service, user_id)
        name = profile.get('name')
        if name:
            print(f"Name: {name}")
    except Exception as e:
        print(f"Could not fetch profile: {e}")
    if not name:
        name = ask("Artist name: ")
        if name is None:
            return
        name = name or user_id

    alias = ask("Alias (optional): ")
    if alias is None:
        return
    last_date = ask("Skip posts before (YYYY-MM-DDTHH:MM:SS, optional): ")
    if last_date is None:
        return
    if last_date:
        try:
            datetime.fromisoformat(last_date)
        except ValueError:
            raise CommandError("Invalid date format.")

    artist = Artist(
        id=artist_id, service=service, user_id=user_id, name=name,
        url=f"https://pawchive.pw/{service}/user/{user_id}",
        alias=alias, last_date=last_date or None,
    )
    ctx.storage.save_artist(artist)
    ctx._last_artist = artist_id
    print(f"Added: {artist.display_name()} [{artist_id}]")


@_cmd('remove', 'CREATORS', 'Stop tracking a creator', params=(_ARTIST,))
def cmd_remove(ctx: CLIContext, artist):
    artist = select_artist(ctx, artist)
    if not artist:
        return
    if not confirm(f"Remove {artist.display_name()}?"):
        return
    ctx.storage.remove_artist(artist.id)
    print(f"Removed {artist.display_name()}.")


@_cmd('info', 'CREATORS', "Creator details & progress",
      params=(_ARTIST,))
def cmd_info(ctx: CLIContext, artist):
    artist = select_artist(ctx, artist)
    if not artist:
        return
    s = ctx.cache.stats(artist.id)
    print(f"\n{artist.display_name()} [{artist.id}]")
    print(f"  service    {artist.service}   user_id {artist.user_id}")
    print(f"  url        {artist.url or '-'}")
    if artist.alias:
        print(f"  alias      {artist.alias}   (name: {artist.name})")
    print(f"  status     {_status(artist, s.get('corrupt'))}")
    print(f"  last_date  {artist.last_date or '-'}")
    print(f"  timer      {artist.timer or '(global)'}")
    if s.get('corrupt'):
        print("  posts      cache unreadable (corrupt JSON)")
    else:
        lost = f", {s['lost']} lost" if s['lost'] else ""
        print(f"  posts      {s['done']}/{s['total']} done, "
              f"{s['pending']} pending, {s['failed']} with failed files{lost}")
    if artist.config:
        print("  overrides  " + ", ".join(f"{k}={v}" for k, v in artist.config.items()))
    if artist.filter:
        print("  filter     " + ", ".join(f"{k}={v}" for k, v in artist.filter.items()))


def _toggle(ctx: CLIContext, query: str, field: str, value: bool, label: str):
    artist = select_artist(ctx, query)
    if not artist:
        return
    setattr(artist, field, value)
    ctx.storage.save_artist(artist)
    print(f"{artist.display_name()} -> {label}")


@_cmd('ignore', 'CREATORS', 'Hide a creator (skips downloads)', params=(_ARTIST,))
def cmd_ignore(ctx, artist):
    _toggle(ctx, artist, 'ignore', True, 'ignored')


@_cmd('unignore', 'CREATORS', 'Unhide a creator', params=(_ARTIST,))
def cmd_unignore(ctx, artist):
    _toggle(ctx, artist, 'ignore', False, 'active')


@_cmd('complete', 'CREATORS', 'Mark a creator finished', params=(_ARTIST,))
def cmd_complete(ctx, artist):
    _toggle(ctx, artist, 'completed', True, 'completed')


@_cmd('uncomplete', 'CREATORS', 'Mark a creator active again', params=(_ARTIST,))
def cmd_uncomplete(ctx, artist):
    _toggle(ctx, artist, 'completed', False, 'active')


def _bulk_flag(ctx: CLIContext, field: str, value: bool, label: str) -> int:
    count = 0
    for a in ctx.storage.get_artists():
        if getattr(a, field) != value:
            setattr(a, field, value)
            ctx.storage.save_artist(a)
            count += 1
    print(f"{count} artists -> {label}")
    return count


@_cmd('ignore-all', 'CREATORS', 'Ignore every creator')
def cmd_ignore_all(ctx):
    if confirm("Ignore ALL creators?"):
        _bulk_flag(ctx, 'ignore', True, 'ignored')


@_cmd('unignore-all', 'CREATORS', 'Unhide every creator')
def cmd_unignore_all(ctx):
    _bulk_flag(ctx, 'ignore', False, 'active')


@_cmd('complete-all', 'CREATORS', 'Mark every creator finished')
def cmd_complete_all(ctx):
    if confirm("Mark ALL creators as completed?"):
        _bulk_flag(ctx, 'completed', True, 'completed')


@_cmd('uncomplete-all', 'CREATORS', 'Reactivate every finished creator')
def cmd_uncomplete_all(ctx):
    _bulk_flag(ctx, 'completed', False, 'active')


@_cmd('ignore-inactive', 'CREATORS', 'Ignore creators idle for N months',
      params=(Param('months', 'int', 6, 'idle months'),))
def cmd_ignore_inactive(ctx: CLIContext, months):
    cutoff = (datetime.now() - timedelta(days=months * 30)).isoformat()
    stale = [a for a in get_artists(ctx, only_active=True)
             if (a.last_date or "") and a.last_date < cutoff]
    if not stale:
        print(f"No active artists inactive for {months}+ months.")
        return
    print(f"\n{len(stale)} artists inactive since before {cutoff[:10]}:")
    for a in stale:
        print(f"  {a.display_name()} (last {a.last_date[:10]})")
    if not confirm("\nIgnore all of these?"):
        return
    for a in stale:
        a.ignore = True
        ctx.storage.save_artist(a)
    print(f"Ignored {len(stale)} artists.")


# ============================================================================
# Browse
# ============================================================================

def _show_list(ctx: CLIContext, predicate, sort_by, service, label) -> List[Artist]:
    """Print the artist table; returns the listed artists, for callers that
    print more about them afterwards."""
    artists = get_artists(ctx, service=service, sort_by=sort_by)
    if predicate:
        artists = [a for a in artists if predicate(a)]
    if not artists:
        print(f"No {label}.")
        return []
    print_artist_table(ctx, artists)
    print(f"\nTotal: {len(artists)} {label}")
    return artists


@_cmd('list', 'BROWSE', 'Active creators', params=_LISTING, aliases=('ls',))
def cmd_list(ctx, sort_by, service):
    _show_list(ctx, _is_active, sort_by, service, "active artists")


@_cmd('list-all', 'BROWSE', 'Everything, incl. ignored & finished',
      params=_LISTING, aliases=('la',))
def cmd_list_all(ctx, sort_by, service):
    _show_list(ctx, None, sort_by, service, "artists")


@_cmd('list-ignored', 'BROWSE', 'Ignored creators only', params=_LISTING)
def cmd_list_ignored(ctx, sort_by, service):
    _show_list(ctx, lambda a: a.ignore, sort_by, service, "ignored artists")


@_cmd('list-completed', 'BROWSE', 'Finished creators only', params=_LISTING)
def cmd_list_completed(ctx, sort_by, service):
    _show_list(ctx, lambda a: a.completed, sort_by, service, "completed artists")


@_cmd('list-pending', 'BROWSE', 'Active creators with pending posts', params=_LISTING)
def cmd_list_pending(ctx, sort_by, service):
    _show_list(ctx, lambda a: _is_active(a) and _has_work(ctx, a),
               sort_by, service, "artists with pending work")


# `details` lists each matching post under its creator; shared by list-failed/-lost.
_DETAIL_LISTING = _LISTING + (Param('details', 'bool', False,
                                    'also list each matching post, per creator'),)

_FILES_SHOWN = 5   # a post can fail 40+ files; name a few, count the rest


def _failed_files_summary(names: List[str]) -> str:
    extra = len(names) - _FILES_SHOWN
    return ", ".join(names[:_FILES_SHOWN]) + (f" +{extra} more" if extra > 0 else "")


def _post_group_header(artist: Artist, count: int, noun: str):
    print(f"\n{_c(artist.display_name(), 1)} [{artist.id}]  {count} {noun}")


def _post_line(post, tag: str, color: int):
    print(f"  [{(post.published or '')[:10]}] [{post.id}] {post.title[:60]}"
          f"  {_c(f'[{tag}]', color)}")


def _print_failed_posts(ctx: CLIContext, artist: Artist):
    posts = [p for p in ctx.cache.load_posts(artist.id) if p.failed_files]
    if not posts:
        return
    _post_group_header(artist, len(posts), "failed posts")
    for p in sorted(posts, key=lambda p: p.published or ''):
        _post_line(p, f"{len(p.failed_files)} failed", 91)
        print(f"      {_c(_failed_files_summary(p.failed_files), 90)}")


@_cmd('list-failed', 'BROWSE', 'Creators with failed files', params=_DETAIL_LISTING)
def cmd_list_failed(ctx, sort_by, service, details):
    artists = _show_list(ctx, lambda a: ctx.cache.stats(a.id)['failed'] > 0,
                         sort_by, service, "artists with failed files")
    if details:
        for a in artists:
            _print_failed_posts(ctx, a)


def _print_lost_posts(ctx: CLIContext, artist: Artist):
    # Lost posts carry no failed_files; the file count is what upstream withholds.
    posts = ctx.cache.get_lost(artist.id)
    if not posts:
        return
    _post_group_header(artist, len(posts), "lost posts")
    for p in sorted(posts, key=lambda p: p.published or ''):
        _post_line(p, f"{len(extract_files(p))} file(s) upstream has none of", 90)


@_cmd('list-lost', 'BROWSE', 'Creators whose posts upstream has no files for',
      params=_DETAIL_LISTING)
def cmd_list_lost(ctx, sort_by, service, details):
    artists = _show_list(ctx, lambda a: ctx.cache.stats(a.id)['lost'] > 0,
                         sort_by, service, "artists with lost posts")
    if details:
        for a in artists:
            _print_lost_posts(ctx, a)


# ============================================================================
# Download
# ============================================================================

def _subset_label(ctx: CLIContext, artist_id: str, lost, pending, failed) -> str:
    """How many posts the flags select, for the queued message."""
    s = ctx.cache.stats(artist_id)
    if lost:
        return f"{s['lost']} lost"
    if pending and not failed:
        return f"{_fresh_count(ctx, artist_id)} pending"
    if failed and not pending:
        return f"{s['failed']} failed"
    return f"{len(ctx.cache.get_undone(artist_id))} pending"


@_cmd('download', 'DOWNLOAD', "Download one creator's pending posts",
      params=(_ARTIST, _LOST, _PENDING, _FAILED))
def cmd_download(ctx: CLIContext, artist, lost, pending, failed):
    artist = select_artist(ctx, artist)
    if not artist:
        return
    if ctx.scheduler.queue_manual(artist.id, lost=lost, pending=pending, failed=failed):
        label = _subset_label(ctx, artist.id, lost, pending, failed)
        print(f"Queued {artist.display_name()} ({label}). Use 'tasks' to monitor.")
    else:
        print("Already queued or running.")


@_cmd('download-all', 'DOWNLOAD', 'Queue all active creators')
def cmd_download_all(ctx: CLIContext):
    ids = [a.id for a in get_artists(ctx, only_active=True)]
    added = ctx.scheduler.queue_batch(ids)
    print(f"Queued {added}/{len(ids)} active creators.")


# Each batch command is its `download` flag applied to every active creator the
# flag would find work for; queueing the rest would only start empty runs.
def _queue_subset(ctx: CLIContext, has_work, label: str, **flags):
    ids = [a.id for a in get_artists(ctx, only_active=True) if has_work(a.id)]
    print(f"Queued {ctx.scheduler.queue_batch(ids, **flags)} creators with {label}.")


@_cmd('download-pending', 'DOWNLOAD', 'Queue only creators that have pending posts')
def cmd_download_pending(ctx: CLIContext):
    _queue_subset(ctx, lambda aid: _fresh_count(ctx, aid) > 0,
                  "pending posts", pending=True)


@_cmd('download-failed', 'DOWNLOAD', 'Queue only creators that have failed files')
def cmd_download_failed(ctx: CLIContext):
    _queue_subset(ctx, lambda aid: ctx.cache.stats(aid)['failed'] > 0,
                  "failed files", failed=True)


@_cmd('download-lost', 'DOWNLOAD', 'Force-retry lost posts for every creator with any')
def cmd_download_lost(ctx: CLIContext):
    _queue_subset(ctx, lambda aid: ctx.cache.stats(aid)['lost'] > 0,
                  "lost posts", lost=True)


def _ask_date(value: str, label: str) -> Optional[str]:
    """Use the inline date if given, otherwise prompt; None means cancelled."""
    if value:
        return value
    raw = ask(f"{label} (YYYY-MM-DD or ISO): ")
    if raw is None or not raw:
        return None
    try:
        datetime.fromisoformat(raw)
    except ValueError:
        raise CommandError(f"Invalid date '{raw}'.")
    return raw


@_cmd('download-after', 'DOWNLOAD', 'Only posts published after a date',
      params=(_ARTIST, Param('date', 'date', '', 'after this date')))
def cmd_download_after(ctx: CLIContext, artist, date):
    artist = select_artist(ctx, artist)
    if not artist:
        return
    date = _ask_date(date, "Published after")
    if date and ctx.scheduler.queue_manual(artist.id, from_date=date):
        print(f"Queued {artist.display_name()} for posts after {date}.")


@_cmd('download-before', 'DOWNLOAD', 'Only posts published up to a date',
      params=(_ARTIST, Param('date', 'date', '', 'up to this date')))
def cmd_download_before(ctx: CLIContext, artist, date):
    artist = select_artist(ctx, artist)
    if not artist:
        return
    date = _ask_date(date, "Published up to")
    if date and ctx.scheduler.queue_manual(artist.id, until_date=date):
        print(f"Queued {artist.display_name()} for posts up to {date}.")


@_cmd('download-between', 'DOWNLOAD', 'Only posts within a date range',
      params=(_ARTIST, Param('after', 'date', '', 'range start'),
              Param('before', 'date', '', 'range end')))
def cmd_download_between(ctx: CLIContext, artist, after, before):
    artist = select_artist(ctx, artist)
    if not artist:
        return
    if not after and not before:
        after = ask("Published after: ")
        if after is None:
            return
        before = ask("Published up to: ")
        if before is None:
            return
    if ctx.scheduler.queue_manual(artist.id, from_date=after or None, until_date=before or None):
        print(f"Queued {artist.display_name()} [{after or '*'} .. {before or '*'}].")


# ============================================================================
# Sync
# ============================================================================

# Sync runs on the scheduler's pool rather than at the prompt: a full re-page of
# one creator takes minutes, and blocking here froze the shell for all of it.

@_cmd('sync', 'SYNC', "Queue a post-list refresh (no files)",
      params=(_ARTIST, _DEEP, _RECHECK))
def cmd_sync(ctx: CLIContext, artist, deep, lost):
    artist = select_artist(ctx, artist)
    if not artist:
        return
    if ctx.scheduler.queue_sync(artist.id, deep, lost):
        modes = ", ".join(m for m, on in (("deep", deep), ("lost", lost)) if on)
        print(f"Queued sync for {artist.display_name()}"
              + (f" ({modes})" if modes else "") + ". Use 'tasks' to monitor.")
    else:
        print("Already queued or running.")


@_cmd('sync-all', 'SYNC', 'Queue a post-list refresh for every active creator',
      params=(_DEEP,))
def cmd_sync_all(ctx: CLIContext, deep):
    ids = [a.id for a in get_artists(ctx, only_active=True)]
    added = ctx.scheduler.queue_sync_batch(ids, deep)
    print(f"Queued {added}/{len(ids)} syncs" + (" (deep)" if deep else "")
          + ". Use 'tasks' to monitor.")


# A normal sync never un-marks a lost post; `:lost` re-checks them and reclaims
# any the server has since restored, returning them to the download queue.

@_cmd('sync-lost', 'SYNC', 'Re-check lost posts for every creator with any')
def cmd_sync_lost(ctx: CLIContext):
    ids = [a.id for a in get_artists(ctx, only_active=True)
           if ctx.cache.stats(a.id)['lost'] > 0]
    print(f"Queued {ctx.scheduler.queue_sync_batch(ids, lost=True)} creators with lost posts.")


# ============================================================================
# Inspect
# ============================================================================

@_cmd('undone', 'INSPECT', "Show one creator's remaining posts", params=(_ARTIST,))
def cmd_undone(ctx: CLIContext, artist):
    artist = select_artist(ctx, artist)
    if not artist:
        return
    undone = ctx.cache.get_undone(artist.id)
    if not undone:
        print(f"{artist.display_name()} is fully downloaded.")
        return
    print(f"\n{len(undone)} undone posts for {artist.display_name()}:")
    for p in sorted(undone, key=lambda p: p.published or ''):
        flag = f" [{len(p.failed_files)} failed]" if p.failed_files else ""
        print(f"  [{(p.published or '')[:10]}] [{p.id}] {p.title[:60]}{flag}")


_LINKS_PARAMS = (Param('match', 'str', '', 'URL regex filter', hint='regex'),
                 Param('unique', 'bool', True, 'drop repeats'),
                 Param('filtered', 'bool', True, 'apply links_filter'),
                 Param('group', 'str', '', 'nest levels, / = order', hint='artist/domain'),
                 Param('details', 'bool', False, 'show post title, id, date'))


def _links_filter(ctx: CLIContext, filtered: bool):
    """The configured link predicate, or None (filter empty or bypassed)."""
    if not filtered:
        return None
    flt = make_link_filter(ctx.storage.load_config().links_filter)
    if flt:
        print("(links_filter active — 'links-filter' to inspect, :filtered=false to bypass)")
    return flt


@_cmd('links', 'INSPECT', "A creator's external URLs",
      params=(_ARTIST, *_LINKS_PARAMS))
def cmd_links(ctx: CLIContext, artist, match, unique, filtered,
              group, details):
    keys = _group_keys(group)  # validate before any work
    artist = select_artist(ctx, artist)
    if not artist:
        return
    flt = _links_filter(ctx, filtered)
    _print_links(ctx, ctx.links_extractor.extract_from_artist(
        artist.id, match=match or None, unique=unique, filter_func=flt),
        keys=keys, details=details)


@_cmd('links-all', 'INSPECT', "All creators' external URLs", params=_LINKS_PARAMS)
def cmd_links_all(ctx: CLIContext, match, unique, filtered,
                  group, details):
    keys = _group_keys(group)  # validate before any work
    flt = _links_filter(ctx, filtered)
    all_links = []
    for a in get_artists(ctx):
        all_links.extend(ctx.links_extractor.extract_from_artist(
            a.id, match=match or None, unique=unique, filter_func=flt))
    _print_links(ctx, all_links, keys=keys, details=details)


@_cmd('links-filter', 'INSPECT', 'Show / adjust the links filter',
      params=(Param('cutoff', 'date', '', 'set reviewed_before'),))
def cmd_links_filter(ctx: CLIContext, cutoff):
    config = ctx.storage.load_config()
    lf = dict(config.links_filter or {})
    if cutoff:
        lf['reviewed_before'] = cutoff
        config.links_filter = lf
        ctx.storage.save_config(config)
        print(f"reviewed_before -> {cutoff}")

    domains = lf.get('allowed_domains') or []
    reviewed = lf.get('reviewed_artists') or []
    print(f"\nlinks_filter: {'active' if domains or reviewed else 'inactive (shows everything)'}")
    if domains:
        head = ', '.join(domains[:6]) + (' ...' if len(domains) > 6 else '')
        print(f"  allowed_domains   {len(domains)}: {head}")
    else:
        print("  allowed_domains   (any domain)")
    print(f"  reviewed_before   {lf.get('reviewed_before') or '- (reviewed artists fully hidden)'}")
    print(f"  reviewed_artists  {len(reviewed)}")
    if reviewed:
        known = {a.id: a for a in ctx.storage.get_artists()}
        for aid in reviewed:
            name = known[aid].display_name() if aid in known else '(not tracked here)'
            print(f"    {aid}  {name}")
    print("\nallowed_domains is edited in data/config.json (links_filter section);"
          "\n'links-reviewed' marks a creator's links as gone through.")


@_cmd('links-reviewed', 'INSPECT', "Mark a creator's links reviewed",
      params=(_ARTIST, Param('remove', 'bool', False, 'unmark instead')))
def cmd_links_reviewed(ctx: CLIContext, artist, remove):
    artist = select_artist(ctx, artist)
    if not artist:
        return
    config = ctx.storage.load_config()
    lf = dict(config.links_filter or {})
    reviewed = list(lf.get('reviewed_artists') or [])

    if remove:
        if artist.id not in reviewed:
            print(f"{artist.display_name()} was not marked reviewed.")
            return
        reviewed.remove(artist.id)
        print(f"{artist.display_name()} unmarked; its links show again.")
    else:
        if artist.id in reviewed:
            print(f"{artist.display_name()} is already marked reviewed.")
            return
        reviewed.append(artist.id)
        cutoff = lf.get('reviewed_before')
        if cutoff:
            print(f"{artist.display_name()} marked reviewed; posts after {cutoff} still show.")
        else:
            print(f"{artist.display_name()} marked reviewed; all its links are now hidden "
                  f"(set links-filter:cutoff=... to keep new posts visible).")

    lf['reviewed_artists'] = reviewed
    config.links_filter = lf
    ctx.storage.save_config(config)


_LINK_CAP = 200  # link lines printed before truncating (grouping surfaces more)

# Group keys and their aliases; value is the canonical key.
_GROUP_ALIASES = {'artist': 'artist', 'a': 'artist',
                  'domain': 'domain', 'd': 'domain', 'type': 'domain', 'site': 'domain'}


def _group_keys(spec: str) -> List[str]:
    """Ordered, de-duplicated grouping keys from a `/`-separated spec.

    `/` (not `,`) separates levels because the inline param syntax already
    splits on commas. Order is the nesting order: `artist/domain` groups by
    artist, then domain within each artist.
    """
    keys: List[str] = []
    for raw in spec.replace('\\', '/').split('/'):
        token = raw.strip().lower()
        if not token:
            continue
        key = _GROUP_ALIASES.get(token)
        if key is None:
            raise CommandError(
                f"Unknown group key '{token}'. Use artist and/or domain, "
                f"e.g. group=artist/domain.")
        if key not in keys:
            keys.append(key)
    return keys


def _link_label(key: str, link, names) -> str:
    if key == 'artist':
        return names.get(link.artist_id, link.artist_id)
    return link.domain or 'unknown'


def _print_link(link, details: bool, indent: int):
    pad = "  " * indent
    if not details:
        print(f"{pad}[{link.post_id}] {link.url}")
        return
    date = (link.post_published or link.post_edited or '')[:10]
    edited = ""
    if link.post_edited and link.post_edited[:10] != (link.post_published or '')[:10]:
        edited = f" (edited {link.post_edited[:10]})"
    print(f"{pad}{link.url}")
    print(f"{pad}    [{link.post_id}] {date or '(no date)'}{edited}  "
          f"{link.post_title or '(untitled)'}")


def _emit_grouped(links, keys, details, names, cap) -> int:
    """Print links nested by `keys`; groups ordered by size. Returns lines shown.

    Once `cap` link lines are printed, remaining leaves are skipped but their
    parent headers (already printed) still carry true counts.
    """
    printed = [0]

    def recurse(items, depth):
        buckets: dict = {}
        for link in items:
            buckets.setdefault(_link_label(keys[depth], link, names), []).append(link)
        for label in sorted(buckets, key=lambda l: (-len(buckets[l]), l)):
            group = buckets[label]
            print(f"{'  ' * (depth + 1)}{label}  ({len(group)})")
            if depth + 1 < len(keys):
                recurse(group, depth + 1)
            else:
                for link in group:
                    if printed[0] >= cap:
                        return
                    _print_link(link, details, depth + 2)
                    printed[0] += 1
            if printed[0] >= cap:
                return

    recurse(links, 0)
    return printed[0]


def _print_links(ctx: CLIContext, links, keys=None, details=False):
    if not links:
        print("No links found.")
        return
    stats = ctx.links_extractor.statistics(links)
    print(f"\n{stats['total_links']} links across {stats['unique_posts']} posts "
          f"({stats['unique_domains']} domains). Top:")
    for domain, count in stats['top_domains'].items():
        print(f"  {count:>4}  {domain}")
    print()

    keys = keys or []
    names = ({a.id: f"{a.display_name()} [{a.id}]" for a in ctx.storage.get_artists()}
             if 'artist' in keys else {})
    if keys:
        shown = _emit_grouped(links, keys, details, names, _LINK_CAP)
    else:
        shown = min(len(links), _LINK_CAP)
        for link in links[:_LINK_CAP]:
            _print_link(link, details, indent=1)
    if shown < len(links):
        print(f"  ... and {len(links) - shown} more "
              f"(narrow with match=, or group= to organize)")


@_cmd('download-gdrive', 'INSPECT', 'Download found Google Drive links (needs gdown)',
      params=(Param('match', 'str', '', 'extra URL regex', hint='regex'),))
def cmd_download_gdrive(ctx: CLIContext, match):
    all_links = []
    for a in get_artists(ctx):
        all_links.extend(ctx.links_extractor.extract_from_artist(
            a.id, match=match or None,
            filter_func=lambda l: 'drive.google.com' in l.url or 'drive.google.com' in l.domain))
    urls = list(dict.fromkeys(l.url for l in all_links))
    if not urls:
        print("No Google Drive links found.")
        return
    print(f"Found {len(urls)} Google Drive links.")
    if not confirm("Download them with gdown?"):
        return
    ctx.links_downloader.download_gdrive_links(urls)


# ============================================================================
# Maintain
# ============================================================================

_AFTER_DATE = Param('after_date', 'date', '', 'only after this date')


@_cmd('reset', 'MAINTAIN', "Mark one creator's posts undone",
      params=(_ARTIST, _AFTER_DATE))
def cmd_reset(ctx: CLIContext, artist, after_date):
    artist = select_artist(ctx, artist)
    if not artist:
        return
    n = ctx.cache.reset_after_date(artist.id, after_date or None)
    print(f"Reset {n} posts for {artist.display_name()}.")


@_cmd('reset-all', 'MAINTAIN', "Mark every creator's posts undone", params=(_AFTER_DATE,))
def cmd_reset_all(ctx: CLIContext, after_date):
    if not confirm("Reset posts for ALL artists?"):
        return
    total = sum(ctx.cache.reset_after_date(a.id, after_date or None)
                for a in ctx.storage.get_artists())
    print(f"Reset {total} posts.")


@_cmd('reset-conflicts', 'MAINTAIN', 'Undo posts whose output paths collide',
      params=(_ARTIST,))
def cmd_reset_conflicts(ctx: CLIContext, artist):
    artist = select_artist(ctx, artist)
    if not artist:
        return
    n = ctx.validator.reset_conflicts(artist)
    print(f"Reset {n} conflicting posts to undone.")


@_cmd('reset-conflicts-all', 'MAINTAIN', 'Undo colliding posts for every creator')
def cmd_reset_conflicts_all(ctx: CLIContext):
    total = sum(ctx.validator.reset_conflicts(a) for a in ctx.storage.get_artists())
    print(f"Reset {total} conflicting posts across all artists.")


@_cmd('dedupe', 'MAINTAIN', 'Remove duplicate cached posts', params=(_ARTIST,))
def cmd_dedupe(ctx: CLIContext, artist):
    artist = select_artist(ctx, artist)
    if not artist:
        return
    print(f"Removed {ctx.cache.deduplicate(artist.id)} duplicates.")


@_cmd('dedupe-all', 'MAINTAIN', 'Remove duplicate cached posts for every creator')
def cmd_dedupe_all(ctx: CLIContext):
    total = sum(ctx.cache.deduplicate(a.id) for a in ctx.storage.get_artists())
    print(f"Removed {total} duplicates total.")


def _print_conflicts(conflicts):
    if not conflicts:
        print("No path conflicts. ✓")
        return
    print(f"\n{len(conflicts)} conflicting output paths:")
    for path, ids in conflicts[:50]:
        print(f"  {path}")
        print(f"      <- {', '.join(ids)}")
    if len(conflicts) > 50:
        print(f"  ... and {len(conflicts) - 50} more")


@_cmd('validate', 'MAINTAIN', "Report one creator's colliding output paths",
      params=(_ARTIST,))
def cmd_validate(ctx: CLIContext, artist):
    artist = select_artist(ctx, artist)
    if not artist:
        return
    _print_conflicts(ctx.validator.find_conflicts([artist]))


@_cmd('validate-all', 'MAINTAIN', 'Report colliding output paths everywhere')
def cmd_validate_all(ctx: CLIContext):
    print("Checking all artists for output-path collisions...")
    _print_conflicts(ctx.validator.find_conflicts(ctx.storage.get_artists()))


_CLEAN_PARAMS = (Param('quarantine', 'str', '_invalid', 'target folder'),
                 Param('dry', 'bool', True, 'preview only'))


@_cmd('clean-folders', 'MAINTAIN', 'Quarantine orphan download folders',
      params=(_ARTIST, *_CLEAN_PARAMS))
def cmd_clean_folders(ctx: CLIContext, artist, quarantine, dry):
    artist = select_artist(ctx, artist)
    if not artist:
        return
    _clean_one(ctx, artist, quarantine, dry)


@_cmd('clean-folders-all', 'MAINTAIN', 'Quarantine orphan folders for every active creator',
      params=_CLEAN_PARAMS)
def cmd_clean_folders_all(ctx: CLIContext, quarantine, dry):
    for a in get_artists(ctx, only_active=True):
        _clean_one(ctx, a, quarantine, dry)


def _clean_one(ctx: CLIContext, artist, quarantine, dry):
    moves = ctx.validator.clean_post_folders(artist, quarantine=quarantine, dry=dry)
    if not moves:
        return
    verb = "Would move" if dry else "Moved"
    print(f"{artist.display_name()}: {verb} {len(moves)} orphan folder(s) -> {quarantine}/")
    for src, _dst in moves[:10]:
        print(f"    {Path(src).name}")
    if dry:
        print("    (dry run; re-run with :dry=false to apply)")


def _migration_config(ctx: CLIContext, artist, prompt_label) -> Optional[MigrationConfig]:
    """Prompt for the templates of one side of a migration, defaulting to the
    artist's effective (config-merged) templates. None means cancelled."""
    cv = lambda k: get_config_value(artist, ctx.storage.load_config(), k)
    print(f"\n{prompt_label} templates (blank = current effective value):")
    values = {}
    for key in ('artist_folder_template', 'post_folder_template', 'file_template'):
        raw = ask(f"  {key} [{cv(key)}]: ", default=cv(key))
        if raw is None:
            return None
        values[key] = raw
    return MigrationConfig(
        download_dir=cv('download_dir'),
        artist_folder_template=values['artist_folder_template'],
        post_folder_template=values['post_folder_template'],
        file_template=values['file_template'],
        date_format=cv('date_format'), rename_images_only=cv('rename_images_only'),
        image_extensions=ctx.storage.load_config().image_extensions,
    )


def _run_migration(ctx: CLIContext, kind: str, query: str):
    artist = select_artist(ctx, query)
    if not artist:
        return
    old = _migration_config(ctx, artist, "OLD (where files are now)")
    if old is None:
        return
    new = _migration_config(ctx, artist, "NEW (where they should go)")
    if new is None:
        return
    plan = (ctx.migrator.plan_posts if kind == "post" else ctx.migrator.plan_files)(artist, old, new)
    _apply_plan(ctx, plan)


def _apply_plan(ctx: CLIContext, plan):
    """Preview a migration plan, confirm it, then execute it."""
    print(f"\nPlan: {plan.success_count} to move, {len(plan.conflicts)} conflicts, "
          f"{len(plan.skipped)} skipped (of {plan.total_items}).")
    for src, dst, _id in plan.mappings[:10]:
        print(f"  {src}\n    -> {dst}")
    if plan.success_count > 10:
        print(f"  ... and {plan.success_count - 10} more")
    if not plan.mappings:
        return
    if not confirm(f"\nApply {plan.success_count} moves?"):
        return
    result = ctx.migrator.execute(plan)
    print(f"Moved {result.success}/{result.total}. Failed: {len(result.failed)}.")
    for _old, _new, item_id, error in result.failed[:5]:
        print(f"  {item_id}: {error}")


@_cmd('relayout-posts', 'MAINTAIN', 'Move post folders to match new templates',
      params=(_ARTIST,))
def cmd_relayout_posts(ctx: CLIContext, artist):
    _run_migration(ctx, "post", artist)


@_cmd('relayout-files', 'MAINTAIN', 'Rename files to match new templates',
      params=(_ARTIST,))
def cmd_relayout_files(ctx: CLIContext, artist):
    _run_migration(ctx, "file", artist)


# Path settings an artist may override; a shared plan would move their folders
# to the wrong place, so they are left alone (use relayout-posts for those).
_SHARED_PATH_KEYS = ('download_dir', 'artist_folder_template')


@_cmd('relayout-artists', 'MAINTAIN',
      "Move creator folders to match the current templates")
def cmd_relayout_artists(ctx: CLIContext):
    config = ctx.storage.load_config()
    artists = get_artists(ctx)

    skipped = [a for a in artists if set(_SHARED_PATH_KEYS) & set(a.config or {})]
    if skipped:
        print(f"Skipping {len(skipped)} creator(s) with their own path config: "
              + ", ".join(a.display_name() for a in skipped[:5]))
        ids = {a.id for a in skipped}
        artists = [a for a in artists if a.id not in ids]

    if '{id}' not in config.post_folder_template:
        raise CommandError(
            "post_folder_template has no {id}, so existing folders cannot be "
            "identified. Add {id} to it, or use relayout-posts.")

    print("Scanning the download tree for existing creator folders...")
    plan = ctx.migrator.plan_artists(artists, _effective_migration_config(config))
    _apply_plan(ctx, plan)


def _effective_migration_config(config) -> MigrationConfig:
    """The global config's templates, as a MigrationConfig."""
    return MigrationConfig(
        download_dir=config.download_dir,
        artist_folder_template=config.artist_folder_template,
        post_folder_template=config.post_folder_template,
        file_template=config.file_template,
        date_format=config.date_format,
        rename_images_only=config.rename_images_only,
        image_extensions=config.image_extensions,
    )


# ============================================================================
# Tasks & Config
# ============================================================================

@_cmd('tasks', 'TASKS & CONFIG', 'Show the task queue (downloads & syncs)')
def cmd_tasks(ctx: CLIContext):
    st = ctx.scheduler.status()
    print(f"\nQueued: {st['queued']}  Running: {st['running']}  Completed: {st['completed']}")
    active = ctx.scheduler.list_active()
    if active:
        print("\nRunning:")
        for t in active:
            print(f"  [{t.task_type}] {_task_label(ctx, t)}")
    queued = ctx.scheduler.list_queued()
    if queued:
        print("\nQueued:")
        for t in queued[:20]:
            print(f"  [{t.task_type}] {_task_label(ctx, t)}")
    recent = ctx.scheduler.completed[-10:]
    if recent:
        print("\nRecent:")
        for t in reversed(recent):
            # A sync leaves no files behind, so its counts are the only feedback.
            outcome = f" ({t.error})" if t.error else (f" — {t.note}" if t.note else "")
            print(f"  [{t.status}] {_task_label(ctx, t)}{outcome}")


def _task_label(ctx: CLIContext, task) -> str:
    artist = ctx.storage.get_artist(task.artist_id)
    return artist.display_name() if artist else task.artist_id


@_cmd('cancel', 'TASKS & CONFIG', 'Cancel one queued or running task',
      params=(Param('artist', 'str', '', 'task id/name (else pick from list)'),))
def cmd_cancel(ctx: CLIContext, artist):
    active = ctx.scheduler.list_active()
    queued = ctx.scheduler.list_queued()
    tasks = [('running', t) for t in active] + [('queued', t) for t in queued]
    if not tasks:
        print("Nothing to cancel.")
        return

    raw = artist
    if not raw:
        print("\nCancellable tasks:")
        for i, (state, t) in enumerate(tasks, 1):
            print(f"  {i}. [{state}] [{t.task_type}] {_task_label(ctx, t)}")
        raw = ask("\nCancel which (number/id, Enter to abort): ")
        if raw is None or not raw:
            return

    if raw.isdigit() and 1 <= int(raw) <= len(tasks):
        artist_id = tasks[int(raw) - 1][1].artist_id
    else:
        low = raw.lower()
        artist_id = next((t.artist_id for _, t in tasks
                          if t.artist_id.lower() == low or _task_label(ctx, t).lower() == low), None)
        if not artist_id:
            raise CommandError(f"No queued or running task matches '{raw}'.")

    state = ctx.scheduler.cancel(artist_id)
    if state:
        print(f"Cancelled {artist_id} ({state}).")
    else:
        print(f"{artist_id} was no longer active.")


@_cmd('cancel-all', 'TASKS & CONFIG', 'Cancel every queued & running task')
def cmd_cancel_all(ctx: CLIContext):
    n = ctx.scheduler.cancel_all()
    print(f"Cancelled all. {n} were running.")


@_cmd('config', 'TASKS & CONFIG', 'Edit global settings')
def cmd_config(ctx: CLIContext):
    config = ctx.storage.load_config()
    editable = [
        'download_dir', 'date_format', 'artist_folder_template', 'post_folder_template',
        'file_template', 'save_content', 'save_empty_posts', 'rename_images_only',
        'max_concurrent_artists', 'max_concurrent_posts', 'max_concurrent_files',
        'retry_delay', 'request_timeout', 'notify',
    ]
    print("\nGlobal config (blank = keep):")
    changed = False
    for key in editable:
        current = getattr(config, key)
        if env.get(key):
            # An env var wins, so editing here would be silently discarded.
            print(f"  {key} [{current}]  (from {env.PREFIX}{key.upper()}; not editable)")
            continue
        val = ask(f"  {key} [{current}]: ")
        if val is None:
            print("Cancelled; nothing saved.")
            return
        if val == "":
            continue
        if isinstance(current, bool):
            val = val.lower() in ("true", "1", "yes")
        elif isinstance(current, int):
            try:
                val = int(val)
            except ValueError:
                print("    skipped (not an int)")
                continue
        setattr(config, key, val)
        changed = True
    if changed:
        ctx.storage.save_config(config)
        print("Saved. Restart to apply concurrency changes.")
    else:
        print("No changes.")


@_cmd('config-artist', 'TASKS & CONFIG', 'Edit per-creator overrides', params=(_ARTIST,))
def cmd_config_artist(ctx: CLIContext, artist):
    artist = select_artist(ctx, artist)
    if not artist:
        return
    keys = ['artist_folder_template', 'post_folder_template', 'file_template',
            'date_format', 'save_content', 'download_dir']
    print(f"\nOverrides for {artist.display_name()} (blank = keep, '-' = clear):")
    for key in keys:
        current = artist.config.get(key, "(inherit)")
        val = ask(f"  {key} [{current}]: ")
        if val is None:
            print("Cancelled; nothing saved.")
            return
        if val == "":
            continue
        if val == "-":
            artist.config.pop(key, None)
        elif val.lower() in ("true", "false"):
            artist.config[key] = val.lower() == "true"
        else:
            artist.config[key] = val
    ctx.storage.save_artist(artist)
    print("Saved.")


@_cmd('config-conflicts', 'TASKS & CONFIG', 'Manage muted path conflicts')
def cmd_config_conflicts(ctx: CLIContext):
    data = ctx.validator.load_ignores()
    ignored = data.get('ignored_paths', [])
    print(f"\nMuted conflict paths: {len(ignored)}")
    for p in ignored[:50]:
        print(f"  {p}")
    print("\nActions: [c]lear all, [a]dd current conflicts, [Enter] cancel")
    choice = (ask("> ") or "").lower()
    if choice == 'c':
        ctx.validator.clear_ignores()
        print("Cleared.")
    elif choice == 'a':
        conflicts = ctx.validator.find_conflicts(ctx.storage.get_artists())
        ctx.validator.ignore_paths([p for p, _ in conflicts])
        print(f"Muted {len(conflicts)} current conflicts.")


# ============================================================================
# Session
# ============================================================================

@_cmd('history', 'SESSION', 'Recent commands',
      params=(Param('limit', 'int', 10, 'entries'),))
def cmd_history(ctx: CLIContext, limit):
    for r in ctx.storage.get_history(limit):
        mark = "ok " if r.success else "ERR"
        extra = f" {r.params}" if r.params else ""
        print(f"  [{mark}] {r.timestamp[:19]} {r.command}{extra}")


@_cmd('test', 'SESSION', 'Verify the plugin system is loading')
def cmd_test(ctx: CLIContext):
    from ..common.hotreload import dynamic_call
    try:
        result = dynamic_call('test_plugin', 'src/plugins/test_plugin.py',
                              default=lambda: "(no plugin)")
        print(f"Plugin test result: {result() if callable(result) else result}")
    except Exception as e:
        print(f"Plugin test failed: {e}")


# One-line description of each command group, shown dim after the header.
_GROUP_TAGLINES = {
    'CREATORS': 'manage the tracked list',
    'BROWSE': 'list creators by state',
    'DOWNLOAD': 'fetch and save files',
    'SYNC': 'refresh the cached post list (no files)',
    'INSPECT': 'look at posts and links',
    'MAINTAIN': 'fix the cache and files',
    'TASKS & CONFIG': 'the queue and settings',
    'SESSION': 'the shell itself',
}


def _param_hint(cmd) -> str:
    """Compact param hint for the overview: `key=values` for params with real
    choices or a placeholder, a bare name otherwise (so plain bools/ints don't
    add `true|false`/`N` noise). Full values and defaults live in `help <cmd>`."""
    return " ".join(f"{p.name}={p.values()}" if (p.choices or p.hint) else p.name
                    for p in cmd.params)


def _cmd_display(cmd) -> str:
    """Command name plus any aliases, e.g. `list · ls`."""
    return " · ".join((cmd.name, *cmd.aliases))


@_cmd('help', 'SESSION', 'This overview, or one command in detail',
      params=(Param('command', 'str', '', 'command to detail'),))
def cmd_help(ctx: CLIContext, command):
    if command:
        _help_detail(command)
        return
    print(_c("\nPawchive Downloader", '1'))
    print("  Run a command by name; add params as " + _c(":key=value,key=value", '36')
          + " (or " + _c("command value", '36') + ").")
    print(_c("  Unique prefixes and Tab-completion work; 'help <command>' details one.", '2'))

    # One aligned line per command: name column, summary, then a dim param hint.
    name_w = max(len(_cmd_display(c)) for c in _REGISTRY)
    group = None
    for cmd in _REGISTRY:
        if cmd.group != group:
            group = cmd.group
            tag = _GROUP_TAGLINES.get(group, "")
            header = _c(group, '1;33') + (_c(f"  {tag}", '2') if tag else "")
            print(f"\n{header}")
        name = _cmd_display(cmd).ljust(name_w)
        line = f"  {_c(name, '36')}  {cmd.summary}"
        hint = _param_hint(cmd)
        if hint:
            line += _c(f"   ·   {hint}", '2')
        print(line)


def _help_detail(name: str):
    from .registry import resolve
    cmd = resolve(COMMAND_MAP, name)
    print(f"\n{_c(cmd.name, '1;36')} — {cmd.summary}")
    if cmd.aliases:
        print(_c(f"  aliases: {', '.join(cmd.aliases)}", '2'))
    if not cmd.params:
        print(_c("  no parameters", '2'))
        return
    print(_c(f"  usage: {cmd.signature()}", '2'))
    name_w = max(len(p.name) for p in cmd.params)
    val_w = max(len(p.values()) for p in cmd.params)
    for p in cmd.params:
        default = _c(f"  (default {p.default!r})", '2') if p.default not in ('', None) else ""
        print(f"    {_c(p.name.ljust(name_w), '36')}  {p.values():<{val_w}}  {p.help}{default}")


@_cmd('clear', 'SESSION', 'Clear the screen')
def cmd_clear(ctx: CLIContext):
    print("\033[2J\033[H", end="")


@_cmd('exit', 'SESSION', 'Quit', aliases=('quit',))
def cmd_exit(ctx: CLIContext):
    raise ExitShell()


COMMAND_MAP = build_map(_REGISTRY)
