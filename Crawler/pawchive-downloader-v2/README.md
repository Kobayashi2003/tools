# Pawchive Downloader v2

Archives creators from [Pawchive](https://pawchive.pw) and Fanbox. For every post it shows
which source has it, whether your plan covers it and where each file came from, and fetches
each missing file from whichever source can deliver it.

## Run

Needs [Python 3.14](https://www.python.org/downloads/). The first start sets up `.venv`.

```powershell
.\start.ps1     # http://127.0.0.1:18060/
.\stop.ps1
.venv\Scripts\python main.py import-v1 ..\pawchive-downloader   # bring over v1's state
```

Unfinished jobs resume after a restart.

## Behaviour

- **Downloads** try the preferred source first (Fanbox unless changed in Settings or per
  creator) and the other one in the same run. Pawchive 404s are retried after 1, 2, 4… days
  (max 30). A spent quota pauses without failing.
- **Syncs** read both sources the same way. A list shorter than before is read again, and
  posts count as deleted only when both reads agree.
- **Fanbox status** of every saved creator is checked in the background every 7 days.
- **Folder dates** are UTC.
- **Groups are folders.** Drag a creator or group onto another group in the sidebar, or use
  a group's pencil; after a confirmation the folders move with it (merging, never
  overwriting). Changing a creator's alias moves its folder too.
- **Timers** (imported from v1) fire only once switched on in Settings.

## Fanbox session

Free posts and post lists need no login. For paid posts, click **Sign in with browser** in
Settings: Chrome or Edge opens on its own profile in `data/browser/`, and closes once you are
signed in to Fanbox. You can also paste the `FANBOXSESSID` cookie. It is kept in
`data/secrets.json`; `FANBOX_SESSID` in the environment wins.

A cancelled plan's posts stay open until the paid month ends, and are shown as such.

## Migrations

Plans are previewed before they run. **Adopt** claims folders from the "Pixiv Fanbox
Downloader" extension (`fanbox/{fee}/[YYYY.MM.DD] {title}/`), working out its time zone from
the data. **Rename** re-applies the post folder template.

## Configuration

Settings are edited in the page and saved in `data/config.json`; `PAWCHIVE_<SETTING>` in
`.env` wins (see `.env.example`).

## Checks

```powershell
.venv\Scripts\python -m pip install --group dev
.venv\Scripts\python -m ruff check; .venv\Scripts\python -m ruff format --check
.venv\Scripts\python -m basedpyright; .venv\Scripts\python -m pytest
```
