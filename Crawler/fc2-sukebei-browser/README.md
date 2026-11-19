# FC2 Sukebei Browser

A local crawler and web UI for FC2 torrents on [sukebei.nyaa.si](https://sukebei.nyaa.si/). It
builds a growing library grouped by FC2 id, enriched from the FC2 Contents Market and paipancon:
covers, preview clips, the official sample video, sample images and magnet links. The UI is in
English or Japanese.

## Run

Requires [uv](https://docs.astral.sh/uv/); dependencies are in `pyproject.toml`.

```bash
uv run main.py serve --port 18050               # web UI on http://127.0.0.1:18050
uv run main.py crawl update                     # without the UI: fetch new uploads
uv run main.py crawl older --blocks 20          # without the UI: 20 history blocks
uv run main.py crawl search bisirichn           # without the UI: a custom sukebei query
uv run main.py doctor                           # check every source still answers and parses
```

On Windows, `start.ps1` / `stop.ps1` start and stop the server.

## How the library grows

sukebei returns at most 1000 results per query, so the library grows along two edges instead:

- **Update** reads the newest uploads until it meets a torrent it already holds; it runs every
  30 minutes and on **⟳ Update**. More than 1000 uploads between two updates is reported as a gap.
- **Older** walks FC2 ids downward in blocks (`4802*` = 1000 ids), each read completely;
  scrolling to the end of the library, **↓ Older**, or **Re-check history** advance it. Progress
  is saved after every block. Open the status pill's **Library sync** panel for **↓ Older** and
  its settings: a number of blocks or
  all that are left, the block size (10,000, 1,000 or 100 ids; changing it keeps the position),
  stopping at the first block with no results, or an id range read without moving the walk.
  The same options exist on the command line (`--all`, `--block-digits`, `--stop-on-empty`,
  `--range FROM TO`).
- **Search sukebei**, under **Custom sukebei query** in Library sync, reads every page of a
  custom query into the same library. The search field in the top bar filters the local library.

Metadata is fetched in the background, FC2 first and paipancon after (about 10 titles a minute,
its rate limit); the title you are looking at jumps the queue. Torrents bundling executables
(`.exe`, `.apk`, `.scr`, …) are flagged **⚠ executables** — deselect those files in your client.

## Browsing

Wide title details have independently scrolling media and information columns; narrow windows
use one column. Torrents are sorted by seeders, then size (executable bundles follow safe ones
at the same seeder count). **Best** highlights the first non-executable torrent with seeders;
only its Magnet button is emphasized. Seller and tag filters appear as a removable search chip.

Arrow keys move between cards; Enter opens details. `s` stars, `m` toggles a reading mark, `h`
hides, and `c` copies a magnet (Best in details, otherwise the first torrent). Inside details,
left/right step between titles and `r` refreshes. `/` focuses library search, `[` / `]` move
between reading marks, `?` opens the full key list, and Escape closes the innermost layer.
Flag and mark changes preserve playing media, expanded file lists and scroll positions.

## Configuration

Set in the environment or in `.env` (see `.env.example`); the environment wins.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FC2SB_PORT` | `18050` | Port of the web UI |
| `FC2SB_PROXY` | *(empty)* | Proxy for every request: a URL, or `none` for direct; empty uses `HTTPS_PROXY` / `HTTP_PROXY`, else the Windows system proxy |
| `FC2SB_DATA_DIR` | `data` | SQLite library and media cache |
| `FC2SB_WORKERS` | `3` | Parallel FC2 lookups |
| `FC2SB_SUKEBEI_DELAY` | `1.5` | Seconds between sukebei requests |
| `FC2SB_SOURCE_DELAY` | `0.5` | Seconds between FC2 requests |
| `FC2SB_PAIPANCON_DELAY` | `6` | Seconds between paipancon requests; lower triggers HTTP 429 |
| `FC2SB_WATCH_MINUTES` | `30` | Automatic Update interval (0 = off) |
| `FC2SB_DEFAULT_QUERY` | `FC2` | Query Update reads new uploads from |

## Tests

```bash
uv run pytest
node --test tests/test_frontend.cjs
```

The tests never touch the network; `uv run main.py doctor` shows which parser a site change broke.
