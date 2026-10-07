# tmw-downloader-v2

A reading window onto the TMW Reading Club's recommendation channels — and, unlike the version
before it, something that actually fetches the books.

The club [changed shape][channel] on 2026-09-05. There is no upload channel any more: four clubs
(book, manga, audiobook, visual novel) each have a `*-recommendations` channel, and everything in
them is posted by the **田中先生** bot in one fixed form —

```
Sharing a good one
Recommender: Anon
Type: Light Novel LN ラノベ ライトノベル
Series title: 賢者の弟子を名乗る賢者
Volumes: 20-23
Job: `tp_023e0cbfad`
```

— a cover collage, a few labelled fields, and a **job id**. No file, no link. The files sit behind
a `⋯` button on the message: press it and the bot answers privately with a one-time link that opens
a reading session for about an hour.

So this reads those channels into a local page you can search, filter and bookmark, and presses
that button for you: one job at a time, into `downloads/<club>/<title>/`, resuming rather than
restarting when a transfer breaks.

[channel]: https://discord.com/channels/1545162007354024040/1545185146745921626

## Installation

```bash
pip install -r requirements.txt
cp .env.example .env
cp config.example.json config.json      # optional; the defaults are this server
```

Two dependencies: `requests` for the REST calls, `websocket-client` for the gateway. `.env` needs
an account token — Discord's API ignores cookies and authenticates on an `Authorization` header,
and the gateway takes the same token. Open Discord in a browser, F12 → Network, click any channel,
find a request to `/api/v9/…`, and copy its `Authorization` request header into `TMW_TOKEN`. That
string is your whole account; `.gitignore` already excludes `.env`.

## Usage

```bash
python main.py                     # serve the page; it grows as you scroll
python main.py --print             # the newest recommendations on the console, then exit
python main.py --grab <message>    # download these and exit (ids or Discord links)
python main.py --doctor            # test the token, step by step, gateway included
```

```
Bookmarks N   the bookmark list                       /          search
Downloads N   the queue, with progress                j / k      one by one
Refresh       ask Discord for anything newer          d          download this one
Fetch         read further back, while you read       b          bookmark it
                                                      Enter      look inside without fetching
                                                      c          copy the job id
                                                      Home/End   oldest / newest
                                                      ?          the whole list
```

The channel name in the bar is a switcher, and it offers the four `*-recommendations` channels
first. Switching is a clean reload of a different archive: cache, bookmarks and ticks are per
channel already, so nothing is shared and nothing needs clearing.

Search covers titles, filenames, descriptions, recommenders and job ids at once. `Hosted` /
`Elsewhere` splits the jobs the bot serves itself from the ones that are a link somewhere else,
because the two are fetched differently. `Not yet fetched` hides everything already on disk, which
is the filter a downloader is actually for. The rail down the left is the channel by month.

## Getting a book

Press **get** on a card, or `d` on the one under the cursor. That queues the job; it does not press
anything yet.

**The button is pressed when the queue reaches the job**, and that is the whole design. A claim is
one-time and dies in about ten minutes, so twenty claims taken up front would be nineteen wasted.
Queue as many as you like and they are claimed one at a time, in order, each one at the moment its
files are about to be fetched.

What happens then depends on the job:

| | |
|---|---|
| **hosted** (`hosted_book_download`) | The bot answers with a claim on its own reader. It is consumed once, opens a session for about an hour, and the files stream with HTTP Range — so an interrupted 400 MB set resumes rather than restarts. |
| **elsewhere** (`tp_…`) | The bot answers with a link, usually pixeldrain. Where the host has a direct-download form the same queue fetches it; where it does not, the queue keeps the link and the page offers to open it. |

**look** (or `Enter`) presses the button and lists what the job holds without fetching anything. The
claim stays live on the server, so pressing **get** straight afterwards costs no second press.

Presses are paced — never two within `press_pause` seconds — because each one is a real request the
bot does real work for. A job whose files are all still on disk is finished without a press at all;
**get again** is the deliberate override for a file that was deleted or truncated behind your back.

Files land in `downloads/<club>/<title>/`, written to `<name>.part` and moved into place only when
the byte count matches, so an interrupted run never leaves a half file looking whole. What landed
where is recorded in `downloads/ledger.json`, which is what lets a card say *where* a book is rather
than only that it was fetched — and what makes the second run skip it.

## Reach

**Reach** is how much of the channel is cached and only ever grows; **scope** (`--tail`, `--cap`)
is how much of that cache the page draws, and touches nothing on disk.

Reach looks after itself: the page fetches what it needs, starting from nothing. It asks for a page
whenever you arrive at either end, and keeps asking while the page is still too short to scroll.

**Fetch** is that same walk asked for deliberately — pick a direction and a size (1,000 / 5,000 /
20,000 / a year / everything) and it runs on the server while you keep reading, with a Stop button
that ends it without losing what it read. `--history` does the same from the command line, and
`--count` composes with it: `--channel_id ID --history all --count 5000` reaches the beginning over
several calm runs. Both flags require `--channel_id`, because a reach spends hundreds of requests
and should never land on whichever channel the config happened to name.

| Option | Description | Default |
|---|---|---|
| `--grab POST…` | Download these and exit. Message ids or Discord links | — |
| `--out DIR` | Where downloads land | `downloads/` |
| `--history` | Reach: `7d`, `2w`, `3m`, `1y`, `all`, or a message count. Needs `--channel_id` | — |
| `--count` | Stop after N messages this run; resumes next run. Needs `--channel_id` | no limit |
| `--tail` | Show only what arrives after this launch | off |
| `--cap` | Cap the posts sent to the page (`0` = all of them) | `0` |
| `--channel_id` / `--guild_id` | Which channel to open on | #book-recommendations |
| `--offline` | Serve the cache without talking to Discord | off |
| `--port` / `--proxy` / `--config` | | `18040` / — / `config.json` |
| `--doctor` | Test the token step by step, gateway included | off |
| `--print` / `--no-open` | List the newest on the console / no browser | off |

## Configuration

Behaviour lives in `config.json` (copy `config.example.json`); the token, proxy and paths come from
the environment (copy `.env.example`).

```
precedence:  command line  >  environment  >  config.json  >  built-in defaults
```

| Variable | Purpose |
|---|---|
| `TMW_TOKEN` | The account token. Env only, never `config.json` |
| `TMW_PROXY` | HTTP(S) proxy, used by the REST calls, the gateway and the downloads alike |
| `TMW_PORT` | Local port for the page |
| `TMW_CACHE_DIR` | Raw messages, re-signed cover links, resolved names |
| `TMW_STATE_FILE` | Bookmarks and ticks |
| `TMW_DOWNLOAD_DIR` | Where the files go |

| Setting | Purpose | Default |
|---|---|---|
| `press_pause` | Seconds between two button presses | `2.0` |
| `press_wait` | How long to wait for the bot's reply | `25.0` |
| `link_margin_minutes` | How much life a signed cover link must have to be reused | `120` |
| `timeout` / `read_timeout` | How long a connection may take to open / a transfer may go quiet | `30` / `120` |
| `retry` | Tries per step — the gateway, the claim, and each transfer | `4` |

## When it fails

Three different things can go wrong and they are worth telling apart, because the message names
which one it was.

**"could not reach Discord's gateway"** — the websocket did not come up. Nothing was pressed and
nothing was downloaded. It is retried a few times with backoff before you are told, since a single
long-distance connection does fail now and then; `--doctor` tests it on its own.

**"the reader did not answer in time" / "the connection to the reader dropped"** — `upload.epubmanga.com:8443`
is one small machine, and this is the ordinary weather around it. Each file is retried from the
`.part` it already has, so a break costs the bytes since the break rather than the book. A job that
ran out of tries keeps its part file; **try again** in the Downloads sheet resumes it.

**"claims expire after about ten minutes"** — the claim was opened but spent or timed out before it
was used. Press the button again; there is nothing to salvage.

If the failures are constant rather than occasional, the host is reachable from some networks and
not others: set `TMW_PROXY`, which the REST calls, the gateway and the downloads all go through.

### Behind a proxy

Where Discord is only reachable through a tunnel, everything here uses it — but the two halves find
it differently, and that is worth knowing because of how the failure looks. `requests` reads
`HTTPS_PROXY` (and the Windows system setting) by itself, so the archive, the covers and the file
transfers all tunnel without being told. `websocket-client` reads none of it, so the gateway is
handed the same proxy explicitly. Before that was so, the symptom was peculiar and pointed the wrong
way: the page loaded perfectly, every cover appeared, and only the download button timed out — the
one connection that had never been told about the tunnel being the one the button needs.

`python main.py --doctor` prints the route it will take, and tests the gateway on its own.

### Two copies running

`--doctor` and a fresh run reporting different things usually means an older instance is still
listening. Windows lets a second process bind a port that a first is already serving, so before this
was refused you could have three servers on `127.0.0.1:18040` and no way to tell which one the
browser was talking to. A second run now steps to the next free port, among the ten from the configured
one, and says so in its startup line; if the page is behaving as though a fix never landed, check that
line, and check for a stale `python main.py` from earlier.

## How it fits together

```
main.py          the command line: sync, print, grab, doctor, serve
src/config.py    settings, and the precedence between them
src/api.py       the REST calls: history, re-signing covers, pressing a button
src/gateway.py   the websocket: the only place a press's reply can be heard
src/cache.py     raw messages on disk, exactly as Discord sent them
src/parse.py     a bot message -> a recommendation
src/models.py    what a recommendation is
src/feed.py      cache + api + parse, and the channel registry
src/hosted.py    a bot reply -> a claim -> a list of files
src/download.py  the queue: one job at a time, resumable, ledgered
src/grab.py      the one place that knows the whole route from card to file
src/ledger.py    what actually landed, and where
src/state.py     bookmarks and ticks
src/server.py    the local page and its API
src/job.py       a reach that runs while you read
src/web/         the page itself
```

Two things are worth knowing if you change any of it.

**A press can only be heard on the gateway.** The press itself is an ordinary POST to
`/interactions` that answers `204`; the bot's reply is *ephemeral*, exists only for the account that
pressed, and is never in the channel's history. The connection is held open, and a press is matched
to its answer by the nonce both carry. The same connection answers the other question the REST API
refuses — who a mention belongs to, since `/users/{id}` is `401` for an account token and the bot
posts recommenders with pings suppressed.

**The listing's sizes are rounded.** The reader writes `1018.62 KiB`, which is a few bytes off what
it actually sends, so a file already on disk is matched against the ledger's exact record first and
the listing's number only to within a hair. Comparing the two exactly meant every second run
downloaded everything again.
