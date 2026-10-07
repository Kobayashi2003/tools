# Novelia Downloader v2

A local crawler and library manager for [Novelia](https://n.novelia.cc/wenku). It collects
library novels (light novels by default), tracks upstream changes, and builds verified
Japanese-only EPUBs from the bilingual downloads.

## Run

Requires Python 3.11+.

```powershell
.\start.ps1              # creates .venv, installs dependencies, serves http://127.0.0.1:18030
.\start.ps1 -Port 18032
.\stop.ps1               # stops a server started in the background
```

The server binds to loopback only, and one instance may use a data directory at a time.
Tasks interrupted by a restart can be resumed from **Tasks**.

## Using it

- **Library**: your shelf. Filter by state (missing volumes, needs conversion, unverified…),
  sort, switch between cover grid and list, and select works to download or convert in bulk.
  Click a work to see each volume: download a missing one, convert, or save the files.
- **Catalog**: the live site catalog. Works already in your library are marked; select covers
  to download them.
- **New download**: catalog page range, specific works (IDs or URLs, one per line), an update
  sweep, or the whole light novel collection. Page and volume ranges are one-based and
  inclusive (`1,3,5-8`). Volumes are counted in filename order, Japanese uploads first.
- **Tasks**: progress, logs and controls. *Resume* continues a stopped task; *Retry failed*
  (on the card, or per item in the log) re-queues only failed items; *Start now* ends a pause.
- **Settings**: automatic sweeps, conversion, translation engines and their priority, pacing
  presets, backoff and retry policy, active hours, and whether to save Chinese-only uploads.

Accepted work references:

```text
wenku/688da4c4c923db0b7aa9943e
https://n.novelia.cc/wenku/688da4c4c923db0b7aa9943e
alphapolis/159124863-713069479
https://n.novelia.cc/novel/alphapolis/159124863-713069479
```

Web providers: kakuyomu, syosetu, novelup, hameln, pixiv, alphapolis (manual only).

## How updates work

A sweep reads every light novel catalog page, refreshes each work's metadata, and downloads a
volume only when its ID, translation counters, or download settings changed, or when the local
file is missing or has a different size. A changed source invalidates its Japanese edition.
Uploads replaced without changing their ID or counters can't be detected; use
**Download again even if unchanged** for those.

Catalog checkpoints and per-item progress live in SQLite, so resuming never skips a page or
repeats a finished work. Each work also records which of its volumes succeeded, so retrying a
partly failed work fetches only the missing volumes, even with **Download again** ticked.

## Failures, retries and rate limits

| Situation | What happens |
| --- | --- |
| Network error, 5xx, 408, interrupted transfer | Retried up to *Attempts per request* with exponential backoff and jitter |
| 429 / 503 | All requests in the process cool down together (honouring `Retry-After`, seconds or date); the delay between requests grows and shrinks back after successes |
| Still refused after *Keep trying for* | The task returns to the queue paused, resumes by itself after *Then pause the task for*, and gives up after *Pauses in a row* pauses without progress |
| Catalog page fails temporarily | The sweep pauses on that page instead of failing |
| Item failed temporarily | Tried again in up to *Automatic retry rounds* at the end of the task, after 1×, 2×, 3×… *Wait before a round* |
| 404, invalid EPUB, verification mismatch | Marked permanent; not retried automatically. Use *Retry* when the cause is fixed |
| 401 / 403 | Stops the task; check the token or network |

Pacing and retry settings apply to a task whenever it starts or resumes; content settings
(translations, order, page size) stay as they were when the task was created. *Rest every* takes
a break after a number of downloads, and *Active hours* limits downloads to a daily window
(server local time; conversion is not limited). The catalog browser shares the same pacing and
answers with "try again in N s" instead of waiting through a long cooldown.

## Japanese conversion

Japanese paragraphs are identified by the site's dimming marker, Chinese paragraphs are removed,
and the publisher's CSS and vertical, right-to-left layout are restored from the uploaded
original. The output is then compared paragraph by paragraph with that original (or with the
site's Japanese export for web novels). Mismatches or missing references are saved with an
`[UNVERIFIED]` filename. Bilingual sources are always kept.

Convert a folder outside the library:

```powershell
.\.venv\Scripts\python.exe main.py convert-local D:\Books\Bilingual --output D:\Books\Japanese --reference-dir D:\Books\Originals
```

References must share relative filenames. A `conversion-report.json` is written to the output,
and the exit code is 1 if any file is unverified or failed.

## Storage and environment

| Path / variable | Purpose |
| --- | --- |
| `data/library.sqlite3` | Works, files, tasks, logs, settings |
| `downloads/<kind_ID>/` | Bilingual sources, Japanese editions, references |
| `NOVELIA_DATA_DIR`, `NOVELIA_DOWNLOAD_DIR` | Override the two directories above |
| `NOVELIA_TOKEN` / `NOVELIA_TOKEN_FILE` | Optional bearer token (default file: `token.txt`) |
| `NOVELIA_PROXY` | Optional HTTP(S) proxy |

Use Settings → Download directory to choose an absolute path. Enable migration to move
all existing files recorded in the library (sources, Japanese editions, references). Without
migration, old files remain accessible. Same-name conflicts stop migration without overwriting;
copy failures leave originals and recorded paths intact. Untracked files stay where they are.
The saved directory persists across restarts and takes precedence over NOVELIA_DOWNLOAD_DIR.

Select works → Remove, or open a work → Remove from library. Files are kept by default;
tick the deletion option to delete recorded EPUBs too. Library → Clean missing files previews
works whose recorded source and Japanese files are all gone. Metadata-only works are kept.
Future sweeps can discover removed works again. Finish or cancel active tasks before storage
maintenance. Back up the database and all download directories together. Tokens are never
stored or returned by the API.

## Development

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe main.py doctor   # checks access to the live catalog
```

API docs: http://127.0.0.1:18030/docs. The frontend in `app/static` is plain HTML/CSS/JS with
no build step.

Upstream endpoints used: `GET /api/wenku?page&pageSize&query&level` (zero-based page;
`pageNumber` is the page count), `/api/wenku/{id}`, `/api/wenku/{id}/file/{volumeId}`,
`/files-wenku/{id}/{volumeId}` (original upload), and `/api/novel/{provider}/{id}[/file]`.
