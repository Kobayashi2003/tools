# FC2 Sukebei Browser

A local crawler and Web UI for FC2 torrents on [sukebei.nyaa.si](https://sukebei.nyaa.si/).
It collects FC2 torrents from sukebei into a library that keeps growing — new uploads on a timer,
and history further back on demand — groups them by FC2 id, looks each title up on the official FC2
Contents Market and on paipancon, and shows everything as a browsable library: covers, animated
preview clips, the official sample video, sample images, and the magnet links.

The UI is in English or Japanese (toggle in the top right).

## Run

Requires Python 3.11+.

```powershell
.\start.ps1              # creates .venv, installs dependencies, serves http://127.0.0.1:18050
.\start.ps1 -Port 18052
.\stop.ps1               # stops a server started in the background
```

The server binds to loopback only. Other commands:

```powershell
.venv\Scripts\python.exe main.py doctor                    # check every source still answers and parses
.venv\Scripts\python.exe main.py crawl update              # without the UI: fetch new uploads
.venv\Scripts\python.exe main.py crawl older --blocks 20   # without the UI: 20 history blocks
.venv\Scripts\python.exe main.py crawl search bisirichn    # without the UI: a custom sukebei query
```

Each `crawl` waits until the metadata of everything it found has been fetched.

## How the library grows

sukebei answers at most 1000 results per query (14 pages, about 10 days of FC2 uploads), so a
fixed "read N pages" crawl can neither keep up reliably nor reach older torrents. Instead the
library only grows, along two edges, and stays complete between them:

- **Update — new uploads.** Reads sukebei's newest FC2 torrents, newest first, and stops at the
  first torrent the library already holds, so a run reads only what is new (usually one page). It
  runs automatically when the last one is older than 30 minutes, and on the **⟳ Update** button.
  The very first run reads all 14 pages. If more than 1000 uploads arrive between two updates
  (the server was off for over a week), the status panel reports a gap.
- **Older — history.** Walks FC2 ids downward in blocks of 1000 ids: the query `4802*` returns every
  torrent of FC2-PPV-4802000…4802999 (plus the shorter ids starting 4802). A block holds a few
  hundred torrents, under sukebei's cap, so it is read completely; a block that still reaches the
  cap (prefixes such as `1080` or `2024` also match "1080p" or years) is split into ten smaller
  ones. Where the walk stopped is saved after every block, so it resumes after a restart and never
  leaves holes. It starts at the block of the highest id in the library and goes down to block
  1000; then it wraps to 9999 and comes down to just above where it started, which picks up the
  old 5–6 digit ids whose prefix is larger than the newest id's (FC2-PPV-958123 is in block 9581).
  The 9000 blocks 1000–9999 cover every id of 5 to 7 digits.
  - **Scroll to the end of the library** (no filters) and it loads the next history blocks by
    itself, as long as you stay there; the newest blocks overlap what Update already found, so
    up to three empty runs in a row are tried before it waits for you.
  - **↓ Older** in the top bar (or at the end of the grid) reads the next 5 blocks.
  - **Re-check history** (status panel) reads every block again from the newest one, e.g. after
    an update gap.
- **Search** (the box in the top bar) runs a custom sukebei query — a seller, a keyword, an id —
  and reads all of its pages. Its torrents join the same library.

Torrents already held only get their seeders and downloads refreshed; job counts report new
torrents and new titles separately (several torrents of one FC2 id are one title).

The status panel shows the counts, when new uploads were last synced, a bar of how many of the
9000 id blocks history has read, and which id range that is ("FC2 ids 4966xxx–4989xxx read; next
block 4965").

## Using it

- **Top bar**: **⟳ Update**, **↓ Older** and the search box (see above). Only torrents whose name
  carries an FC2 code (`FC2-PPV-1234567`, `fc2 ppv 1234567`, `FC2PPV_1234567`…) are kept.
  **Check files** (in the status panel) also reads each new torrent's file list (one extra
  request per torrent) so bundled executables are flagged right away.
- **Library**: one card per FC2 id. **Hover a card** to play its preview clips back to back like a
  GIF (or flip through sample images when there are no clips). The 🧲 opens the magnet of the
  best-seeded torrent in your BitTorrent client; ⧉ copies it. Click the code to copy `FC2-PPV-…`.
- **Filters**: free text (title, seller, tag, torrent name, or an FC2 id), All / Unseen / Starred /
  Hidden, sort, minimum seeders, and *With previews*. Press `/` to jump to the filter box. Sorted
  by upload or by addition, the grid is split into days. The slider on the right sets the card
  size. A dot before the code marks titles added since your previous visit.
- **Reading marks**: the bookmark on a card (or in the detail view, or **M** with the pointer on
  a card) marks it as "read up to here". Add as many as you like; **]** and **[** — or the arrows
  in the bar at the bottom right — jump to the next and previous mark, loading the grid as far as
  needed. The middle of the bar counts the marks above your position and opens the list of marks
  (click one to jump there, × to remove it). Marks belong to titles, not scroll positions, so
  they stay put through new uploads and other sort orders; a mark whose title the current
  filters hide is listed as not in this view.
- **Detail view** (click a card): all torrents for that id with magnet, copy, `.torrent` and
  **Files**; preview clips; **Play official sample** (FC2's own ~1 min sample); sample images and
  paipancon's contact sheet (click to enlarge, ←/→ to page through); seller, release date,
  duration, rating, and tags (click a tag to filter by it). ←/→ moves to the previous/next title,
  Esc closes. **Refresh** re-fetches the title and drops its cached media, which also replaces
  paipancon's blurred placeholder covers on very new titles.
- **Status pill**: progress of the current job and of both metadata stages. Click it for the counts,
  coverage, the log, **Retry failed** and **Re-check history**.

### Bundled executables

Many FC2 torrents ship adware next to the video: `.exe` "address publishers", `.apk` games, `.url`
and `.html` link spam. A torrent whose file list contains executables or installers (`.exe`,
`.apk`, `.scr`, `.bat`, `.msi`, `.lnk`, `.vbs`, `.js`…) is marked **⚠ executables** on its card
and in the detail view, and those files are listed in red. Link-spam files are dimmed. When you
download such a torrent, deselect those files in your client.

## Sources

| Source | Used for | Notes |
| --- | --- | --- |
| sukebei.nyaa.si | Search, magnets, seeders, file lists | Listing pages hold 75 rows; at most 1000 results per query |
| adult.contents.fc2.com | Title, cover, seller, release date, duration, rating, tags, sample images, official sample video | Removed articles answer "お探しの商品が見つかりませんでした"; many titles on sukebei are already removed |
| paipancon.com | Preview clips (the animated "GIF" previews), contact sheet, cover/title fallback | Rate-limited: about 10 pages per minute sustained, then HTTP 429 |

Sites behind a Cloudflare challenge (fc2ppvdb, missav, supjav, javdb…) can't be read without a
real browser and are not used.

### How metadata is fetched

Each title goes through two stages with separate queues, so the slow source never holds back the
fast one. Both queues are ordered by priority: the title you are looking at first, then new
uploads, then history — a long history walk never delays new titles.

1. **FC2 stage**, 3 workers, 0.5 s between requests: cards get their title, cover and details within
   seconds of a crawl.
2. **paipancon stage**, 1 worker, 6 s between requests: preview clips trail behind at about
   10 titles per minute (the first Update's ~550 titles take about an hour). Cards show `▶ …`
   until then. **Opening a title, or resting the pointer on its card, moves it to the
   front of the queue**, so what you are looking at is fetched next.

When a source fails (network error, 5xx, 429), the title keeps what the other source returned and
is marked failed for that source only. Rate limits put the host on a cooldown (honouring
`Retry-After`, or 20 s, 40 s, … when the site sends none). Failed sources are retried
automatically every 3 minutes, up to 3 rounds; **Retry failed** retries them all again. Retries
only re-fetch the source that failed. Unfinished titles resume when the server restarts.

### Media

Covers, sample images and preview clips load through `/media?u=…`, which fetches them once into
`data/media/` and serves them from disk afterwards, so the grid is fast on later visits and doesn't
depend on hotlink rules. Only paipancon.com and fc2.com hosts are allowed. The official sample
video (~50–100 MB) is not cached. Its URL is signed for the User-Agent that requested it, so the
server requests it with your browser's User-Agent and the browser streams it directly from FC2.

## Configuration

Copy `.env.example` to `.env` to change defaults; real environment variables win over the file.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FC2SB_PORT` | `18050` | Port of the Web UI |
| `FC2SB_PROXY` | *(empty)* | Proxy for every request, e.g. `http://127.0.0.1:7890`. Empty uses `HTTP(S)_PROXY` |
| `FC2SB_DATA_DIR` | `data` | SQLite library (`library.db`) and media cache |
| `FC2SB_WORKERS` | `3` | Parallel FC2 lookups |
| `FC2SB_SUKEBEI_DELAY` | `1.5` | Seconds between sukebei requests |
| `FC2SB_SOURCE_DELAY` | `0.5` | Seconds between FC2 requests |
| `FC2SB_PAIPANCON_DELAY` | `6` | Seconds between paipancon page requests. Lower values trigger HTTP 429 |
| `FC2SB_WATCH_MINUTES` | `30` | Run Update automatically when the last one is older than N minutes (0 = off) |
| `FC2SB_DEFAULT_QUERY` | `FC2` | Query Update reads new uploads from |

## Files

| Path | Role |
| --- | --- |
| `main.py` | CLI: `serve` (default), `crawl` (update / older / search), `doctor` |
| `app/server.py` | FastAPI app: JSON API, media proxy, static UI |
| `app/crawler.py` | Update / Older / Search jobs, priority queues, the two metadata stages |
| `app/sukebei.py` | sukebei listing / view-page parser (rows, magnets, file trees, risky files) |
| `app/fc2.py` | FC2 article parser and sample-video API |
| `app/paipancon.py` | paipancon detail parser (clips, contact sheet, cover) |
| `app/store.py` | SQLite storage and library queries |
| `app/media.py` | Allow-listed disk cache for images and clips |
| `app/net.py` | Shared HTTP session: per-host pacing, retries, cooldowns |
| `app/fc2id.py` | FC2 code matching |
| `app/static/` | Single-page UI (`app.js`, `controls.js` for the styled select, `i18n.js`, `style.css`) |
| `tests/` | Parser tests on markup samples; API and crawl-job tests with a fake HTTP client |

## Tests

```powershell
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.venv\Scripts\python.exe -m pytest
```

The tests never touch the network. If a site changes its markup, `main.py doctor` is the quickest
way to see which parser broke.
