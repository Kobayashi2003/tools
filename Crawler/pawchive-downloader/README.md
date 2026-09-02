# pawchive-downloader

A downloader for [Pawchive](https://pawchive.pw). An interactive shell that tracks
creators, caches their post lists, and downloads new files incrementally and
concurrently, with optional scheduling.

## Installation

```bash
pip install -r requirements.txt
```

`requests` is required; `prompt_toolkit` adds Tab-completion, history and a live
status bar, and degrades gracefully if absent.

## Usage

```bash
python main.py
```

Enter `help` to see all commands, or `help <command>` for one. Basic workflow:

```bash
> add                  # Add a creator by URL
> list                 # List active creators
> download             # Download one creator's pending posts
> download-all         # Queue all active creators
> tasks                # View the download queue
```

### Inline parameters

`command:key=value,key=value` (a single bare value also works, e.g. `download hane`):

```bash
> list:sort_by=recent,service=fanbox
> sync:artist=hane,deep                # a bare bool flag means =true
> links-all:group=artist/domain,details
> reset:after_date=2025-01-01
```

A boolean parameter given with no value is `true` (`:deep` ≡ `:deep=true`).

`links` / `links-all` honor the optional `links_filter` in `data/config.json`
(`allowed_domains`, `reviewed_artists`, `reviewed_before`); `:filtered=false`
bypasses it. `help <command>` lists a command's parameters, their values and
defaults.

## Configuration

Files land in `{download_dir}/{artist_folder}/{post_folder}/{file}`, templated in
`data/config.json` and overridable per creator via `config-artist`. Behavior
(templates, concurrency, retries, filters, timers) lives in `data/config.json`;
machine-specific paths and endpoints come from the environment (copy
`.env.example` to `.env`).

```
precedence:  environment  >  data/config.json  >  built-in defaults
```

| Variable | Purpose |
|---|---|
| `PAWCHIVE_DOWNLOAD_DIR` | where files are written |
| `PAWCHIVE_DATA_DIR` | where `config.json` lives (env only) |
| `PAWCHIVE_CACHE_DIR` / `PAWCHIVE_LOGS_DIR` | runtime locations |
| `PAWCHIVE_API_BASE` / `PAWCHIVE_FILE_BASE` | endpoints |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | standard proxy names |

## Notes

Completeness is prioritized over speed. Files are written to a temp file,
size-checked, then placed with an atomic `os.replace`; failures are recorded so
the post stays pending and the next run retries it. Re-running is always safe —
finished posts are never re-fetched.
