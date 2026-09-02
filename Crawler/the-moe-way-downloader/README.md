# the-moe-way-downloader

A reading window onto [TMW Sharing's
#book-sharing](https://discord.com/channels/1539508913102262284/1539512407053967401). It downloads
nothing: it reads the channel, groups a multi-message upload back into one share, and serves a
local page with the links laid out for you to click.

Eleven thousand shares over five years, searchable in a few milliseconds, with **bookmarks** for
the ones worth coming back to and a tick against every file you have already fetched.

## Installation

```bash
pip install -r requirements.txt
cp .env.example .env
```

`requests` is the only dependency. `.env` needs an account token: Discord's API ignores cookies
and authenticates on an `Authorization` header. Open Discord in a browser, F12 → Network, click
any channel, find a request to `/api/v9/…`, and copy its `Authorization` request header into
`TMW_TOKEN`. That string is your whole account; `.gitignore` already excludes `.env`.

## Usage

```bash
python main.py                  # serve the page; it grows as you scroll
python main.py --channel_id ID --history all   # or pull one channel down up front
python main.py --print          # the newest shares on the console, then exit
python main.py --doctor         # test the token step by step
```

```
Bookmarks N   the bookmark list                            /          search
Refresh       ask Discord for anything newer               j / k      share by share
Fetch         read further back, while you keep reading    b          bookmark this share
                                                           Home/End   oldest / newest
                                                           Enter / c  open / copy the share
                                                           ?          the whole list
```

The channel name in the bar is a switcher. The sharing channels were split up — book-sharing,
comic-sharing and their siblings — so the page offers the guild's channels with the ones already
read down listed first and anything named *sharing* next. Switching is a clean reload of a
different archive: cache, bookmarks and ticks are per channel already, so nothing is shared and
nothing needs clearing, and the choice is remembered.

Search covers titles, authors and every filename in the archive at once. `Files` / `Links` splits
uploads from the MEGA links that are a quarter of this channel, since the two are handled
differently. The rail down the left is the channel by month, bar length being how busy it was;
click one to land there. `copy N links` on a share puts its URLs on the clipboard one per line,
which is what a download manager wants. Order is oldest-first, so the newest sits at the bottom
where the channel puts it; `Newest first` flips it.

Press `b`, or `save` on a card, to bookmark a share; bookmarked shares carry a vermilion ribbon
down their edge so they are findable while scrolling, and the list in the bar jumps to any of
them. If a filter is hiding the share you jump to, the filter loses — a "take me there" that
quietly does nothing is worse than one that clears a chip you can see.

`download N files` hands the whole share to the browser at once, spaced out so a burst of twenty
does not look like a runaway, and ticks them all off. Covers open full size in a lightbox — one
cover fills the card and the rest sit behind the count, because three squeezed side by side were
too small to recognise a book by, which is the only thing a cover is for.

Pressing `get` ticks that file off, and the number beside it becomes a `✓` you can click to
change your mind. Bookmarks and ticks both live in `state.json`, not in the browser, so clearing
site data does not lose them.

Narrowing keeps your place and searching does not: a chip trims the list you are already reading,
so the share under the cursor stays under it, while a query builds a different list and starts at
the top. Chips and toggles are remembered between runs; the query is not.

| Option | Description | Default |
|---|---|---|
| `--history` | Reach: `7d`, `2w`, `3m`, `1y`, `all`, or a message count. Needs `--channel_id` | — |
| `--count` | Stop after N messages this run; resumes next run. Needs `--channel_id` | no limit |
| `--tail` | Show only what arrives after this launch | off |
| `--cap` | Cap the posts sent to the page (`0` = all of them) | `0` |
| `--channel_id` / `--guild_id` | Which channel to open on | #book-sharing |
| `--no-merge` | Keep every message separate | off |
| `--offline` | Serve the cache without talking to Discord | off |
| `--port` / `--proxy` / `--config` | | `8420` / — / `config.json` |
| `--migrate-from` | Carry bookmarks and ticks over from another channel | — |
| `--doctor` | Test the token step by step | off |
| `--print` / `--no-open` | List the newest shares on the console / no browser | off |

**Reach** is how much of the channel is cached and only ever grows; **scope** (`--tail`, `--cap`)
is how much of that cache the page draws and touches nothing on disk.

Reach looks after itself: the page fetches what it needs, starting from nothing. It asks for a
page whenever you arrive at either end — scroll up and earlier shares appear, scroll down and it
checks for newer — and keeps asking while the page is still too short to scroll, since a channel
that yields two shares per hundred messages would otherwise have nothing to scroll *with* and so
would never ask. Each request is one page, never more, and a direction that has run out is not
asked again.

**Fetch** is that same walk, asked for deliberately rather than a screenful at a time — because
you find out you want 2021 while you are reading 2023. Press **Fetch** in the page, choose a
direction and a size (1,000 / 5,000 / 20,000 / a year / everything), and it runs on the server
while you keep reading: the bar says how far back it has got, and a Stop button ends it without
losing what it read. One crawl per channel at a time, and the page stops asking for pages of its
own while one is running.

`--history` does the same thing from the command line, before the page opens, and `--count`
composes with it: `--channel_id ID --history all --count 5000` reaches the beginning over several
calm runs. Both flags now require `--channel_id`. A reach reads *one* channel's past and there is
always a default channel to fall back on, so a bare `--history all` used to walk whichever channel
`config.json` happened to name — rarely the one you meant, and several hundred requests spent
finding out. Setting `history` beside `channel_id` in `config.json` is a deliberate pair and is
left alone.

## Configuration

Behaviour lives in `config.json` (copy `config.example.json`); the token, proxy and paths come
from the environment (copy `.env.example`).

```
precedence:  command line  >  environment  >  config.json  >  built-in defaults
```

| Variable | Purpose |
|---|---|
| `TMW_TOKEN` | account token (env only) |
| `TMW_PROXY` / `TMW_PORT` | proxy, local port |
| `TMW_CACHE_DIR` / `TMW_STATE_FILE` | runtime locations |

`page_size` is capped at 100 by Discord and asking for less is worse rather than safer — the same
history then costs proportionally more requests. Slow `page_pause` (default 1.0s) instead. A full
backfill of this channel is around 22k messages, so a few hundred requests and a few minutes,
once.

## Notes

The page never renders the archive. It draws the dozen or so rows around the viewport and places
them by measured offsets, so 11k shares across 2.4 million pixels stay at ~17 elements and ~20 ms
a repaint, a filter change costs ~13 ms, and search runs over everything in single-digit
milliseconds.

Nothing on a card is allowed to size itself: the cover plate, the file rows and the title at two
lines are all pinned in CSS, and `estimate` does arithmetic over counts the index already carried
rather than guessing. What little it still gets wrong cannot be felt, because the correction pass
pins the row that owns the top of the viewport and adjusts the scroll by that row's shift alone.
Measured over 36,000 px of scrolling, cumulative layout shift is 0.

The interface is English throughout. The only Japanese on the page is the titles and filenames,
which are the books themselves.

Parsing 21k messages into 11k shares costs a third of a second, and every request used to pay it
-- `detail` paid it twice. The parse is now held until the message cache actually grows, which
takes a screenful of scrolling from 750 ms to under a millisecond, and the posts handed out are
the same objects each time, so re-signing a link updates every view of it at once.

Attachment links are signed and expire in about a day, and 11k shares hold ~26k of them — with
the links the index is 17 MB, without them under two. So the index carries none, and covers and
links are fetched a screenful at a time. A card is sized from counts the index already knows, so
arriving links never push the page around.

Fresh signatures live in `cache/links_<channel>.json`, not in the messages. Folding them back in
meant rewriting 18 MB to change a few query strings -- a second per screenful -- and it quietly
made the "raw" cache not raw; the overlay is 8 ms, batched, and dropped once entries expire.

A link is only re-signed once it has less than `link_margin_minutes` (default two hours) left, so
scrolling back over what you have already seen costs nothing, and `copy N links` re-signs before
it copies — that list is going into a download queue that may not reach the last item for hours. Where a link cannot be renewed, offline or because the re-sign failed, the row says
`stale` rather than offering a download that would 403.

A message is kept for what it carries, not for who posted it. Bots were dropped wholesale until
that turned out to lose the shares a `File Uploader` bot had been posting — and would have lost a
whole channel to a migration done by one. Forwarded messages are opened as well: a forward has
empty content and no attachments of its own, with the original in a snapshot, so a channel moved
by forwarding reads as completely empty unless the snapshot is unwrapped. Embedded images and
links are picked up the same way.

Discord caps an upload batch, so a long series arrives as a titled message followed by silent
ones. Those are folded into the post above them when the author matches, there is no text of its
own, and the gap from the *previous part* is under `merge_window_minutes`. Merged posts say so
(`+2 follow-ups`); `--no-merge` turns it off.

The channel writes `[author] title` and `(kind)`, so square brackets name an author and round
ones a kind. A bracketed line is sometimes just an aside — `(not my folder)` — so a label counts
as a kind only once `category_min` posts use it, and one spelling is chosen for the ones that
mean the same thing. That takes 110 raw values down to eleven.

Some posts write the kind on a bare line instead, `Light Novel` with the real title under it.
Reading any first line as a label would be guesswork, so that only happens when the line matches
a kind the channel already uses in brackets often enough to have been counted — which recovers
112 shares that were otherwise filed under their own genre.

Only two fetches exist — forward from the newest id held, backward from the oldest — so the cache
is always one contiguous run with no gaps to track, an interrupted backfill resumes, and growing
from the page is the same two operations rather than a third path. Prepending earlier shares
moves every offset below them, so the post at the top of the viewport is remembered by id and put
back on the same pixel: measured, it does not move at all.

Cache and marks are per channel, both gitignored. `state.json` is written aside and moved into
place like the caches are: it is the only file holding anything that cannot be fetched again. The sharing channels moved out of TheMoeWay
into a server of their own on 2026-08-19; the previous archive is still readable with
`--channel_id 819968020012204112 --offline`, since nothing is shared between channels.

A migrated channel shares no ids with the one it came from — every message and attachment was
created afresh — so `--migrate-from` matches on content instead: a file by name and byte size,
which is exact for a re-upload and vanishingly unlikely to collide, and a share by any of its
files landing in the same place, falling back to its title when it has none. It only ever adds,
so it can be run again each time more of the archive arrives.

Reading the API with an account token is self-botting, which Discord's terms disallow even for
read-only traffic. Nothing is ever posted and the pacing is polite, but the risk is your account.
