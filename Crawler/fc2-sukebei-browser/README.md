# FC2 Sukebei Browser

A local crawler and web UI for FC2 torrents on [sukebei.nyaa.si](https://sukebei.nyaa.si/). It
builds a growing library grouped by FC2 id, enriched from the FC2 Contents Market and paipancon:
covers, preview clips, the official sample video, sample images and magnet links. The UI is in
English or Japanese.

## Run

Requires Python 3.14; dependencies are in `pyproject.toml`.

```bash
python main.py serve --port 18050               # web UI on http://127.0.0.1:18050
python main.py crawl update                     # without the UI: fetch new uploads
python main.py crawl older --blocks 20          # without the UI: 20 history blocks
python main.py crawl search bisirichn           # without the UI: a custom sukebei query
python main.py doctor                           # check every source still answers and parses
```

On Windows, `start.ps1` / `stop.ps1` start and stop the server.

## How the library grows

sukebei returns at most 1000 results per query, so the library grows along two edges instead:

- **Update** reads the newest uploads until it meets a torrent it already holds; it runs every
  30 minutes and on **⟳ Update**. More than 1000 uploads between two updates is reported as a gap.
- **Older** walks FC2 ids downward in blocks of 1000 (`4802*`), each read completely; scrolling
  to the end of the library, **↓ Older**, or **Re-check history** advance it. Progress is saved
  after every block.
- **Search** reads every page of a custom query into the same library.

Metadata is fetched in the background, FC2 first and paipancon after (about 10 titles a minute,
its rate limit); the title you are looking at jumps the queue. Torrents bundling executables
(`.exe`, `.apk`, `.scr`, …) are flagged **⚠ executables** — deselect those files in your client.

## Configuration

Set in the environment or in `.env` (see `.env.example`); the environment wins.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FC2SB_PORT` | `18050` | Port of the web UI |
| `FC2SB_PROXY` | *(empty)* | Proxy for every request; empty uses `HTTP(S)_PROXY` |
| `FC2SB_DATA_DIR` | `data` | SQLite library and media cache |
| `FC2SB_WORKERS` | `3` | Parallel FC2 lookups |
| `FC2SB_SUKEBEI_DELAY` | `1.5` | Seconds between sukebei requests |
| `FC2SB_SOURCE_DELAY` | `0.5` | Seconds between FC2 requests |
| `FC2SB_PAIPANCON_DELAY` | `6` | Seconds between paipancon requests; lower triggers HTTP 429 |
| `FC2SB_WATCH_MINUTES` | `30` | Automatic Update interval (0 = off) |
| `FC2SB_DEFAULT_QUERY` | `FC2` | Query Update reads new uploads from |

## Tests

```bash
pytest
```

The tests never touch the network; `python main.py doctor` shows which parser a site change broke.
