# tmw-downloader-v2

Reads the TMW Reading Club's Discord recommendation channels (book, manga, audiobook, visual
novel) into a local page you can search, filter and bookmark, and fetches the books. Each post
carries a job id; its files sit behind a button that makes the bot reply privately with a
one-time link, which this presses for you.

## Setup

Requires Python 3.14; dependencies are in `pyproject.toml`. Copy `.env.example` to `.env` and
set `TMW_TOKEN` to your Discord account token: open Discord in a browser, F12 → Network, and copy
the `Authorization` header of any `/api/v9/…` request. The token is your whole account; keep it
out of version control.

## Run

```bash
python main.py                     # serve the page on http://127.0.0.1:18040
python main.py --print             # print the newest recommendations and exit
python main.py --grab <message>    # download these (ids or Discord links) and exit
python main.py --doctor            # test the token and the gateway step by step
```

On Windows, `start.ps1` / `stop.ps1` start and stop the server.

**get** (or `d`) queues a job; its button is pressed only when the queue reaches it, because a
claim is one-time and expires in about ten minutes. Files are written to
`downloads/<club>/<title>/` via `<name>.part`, so a broken transfer resumes, and recorded in
`downloads/ledger.json`, so a fetched book is never fetched twice. **look** (`Enter`) lists a
job's files without downloading. `?` shows every keyboard shortcut.

| Option | Description | Default |
|---|---|---|
| `--grab POST…` | Download these and exit | — |
| `--out DIR` | Where downloads land | `downloads/` |
| `--history` | Read back `7d`, `2w`, `3m`, `1y`, `all`, or N messages; needs `--channel_id` | — |
| `--count` | Stop after N messages this run; needs `--channel_id` | no limit |
| `--tail` | Show only what arrives after this launch | off |
| `--cap` | Cap the posts sent to the page (`0` = all) | `0` |
| `--channel_id` / `--guild_id` | Channel to open | #book-recommendations |
| `--offline` | Serve the cache without contacting Discord | off |
| `--port` / `--proxy` / `--config` | | `18040` / — / `config.json` |
| `--print` / `--no-open` | List the newest on the console / don't open a browser | off |

## Configuration

Behaviour is in `config.json` (see `config.example.json`); the token, proxy and paths come from
the environment. The command line wins, then the environment, then `config.json`.

| Variable | Purpose |
|---|---|
| `TMW_TOKEN` | Account token (environment only) |
| `TMW_PROXY` | HTTP(S) proxy for every connection, gateway included |
| `TMW_PORT` | Local port |
| `TMW_CACHE_DIR` / `TMW_STATE_FILE` / `TMW_DOWNLOAD_DIR` | Message cache / bookmarks / downloads |

| Setting | Purpose | Default |
|---|---|---|
| `press_pause` | Seconds between two button presses | `2.0` |
| `press_wait` | How long to wait for the bot's reply | `25.0` |
| `link_margin_minutes` | Remaining life a signed cover link needs to be reused | `120` |
| `timeout` / `read_timeout` | Connect / idle-transfer timeout | `30` / `120` |
| `retry` | Tries per step: gateway, claim, transfer | `4` |

## Troubleshooting

- **"could not reach Discord's gateway"**: nothing was pressed. Run `--doctor`; if Discord needs
  a tunnel, set `TMW_PROXY` (the gateway does not read system proxy settings).
- **"the reader did not answer in time"**: the file host is flaky; **try again** resumes from the
  `.part` file.
- **"claims expire after about ten minutes"**: press the button again.
- A second instance steps to the next free port and says so at startup; if the page behaves like
  an old version, look for a stale server.
