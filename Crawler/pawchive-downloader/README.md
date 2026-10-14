# pawchive-downloader

Interactive shell for [Pawchive](https://pawchive.pw): tracks creators, caches their post lists
and downloads new files incrementally, on demand or on a schedule.

## Run

Requires Python 3.14; dependencies are in `pyproject.toml`.

```bash
python main.py
```

On Windows, `start.ps1` opens the shell and `stop.ps1` ends it from another window.

`help` lists the commands and `help <command>` its parameters. Parameters are written
`command:key=value,...`; a bare flag means `true`.

```bash
> add                                  # add a creator by URL
> download hane                        # download one creator's pending posts
> download-all                         # queue every active creator
> list:sort_by=recent,service=fanbox
> sync:artist=hane,deep
```

## Configuration

Behaviour (folder templates, concurrency, retries, link filters, timers) is in
`data/config.json`, overridable per creator with `config-artist`. Paths and endpoints come from
the environment (see `.env.example`), which takes precedence:

| Variable | Purpose |
|---|---|
| `PAWCHIVE_DOWNLOAD_DIR` | Where files are written |
| `PAWCHIVE_DATA_DIR` | Where `config.json` lives |
| `PAWCHIVE_CACHE_DIR` / `PAWCHIVE_LOGS_DIR` | Runtime locations |
| `PAWCHIVE_API_BASE` / `PAWCHIVE_FILE_BASE` | Endpoints |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | Proxy |

Rerunning is always safe: finished posts are never fetched again, and failed files leave their
post pending for the next run.
