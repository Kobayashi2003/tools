# Pawchive Downloader v2

Archives creators from [Pawchive](https://pawchive.pw) and the creator's own site, Fanbox or
Patreon. For every post it shows
which source has it, whether your plan covers it and where each file came from, and fetches
each missing file from whichever source can deliver it.

## Run

Needs [uv](https://docs.astral.sh/uv/). The first start sets up `.venv`.

```powershell
.\start.ps1     # http://127.0.0.1:18060/
.\stop.ps1
uv run main.py serve --port 18060   # the same without the launcher
uv run main.py import-v1 ..\..\..\garbage\crawler\pawchive-downloader   # bring over v1's state
```

Unfinished jobs resume after a restart.

## Behaviour

- **Downloads** try the preferred source first (Fanbox unless changed in Settings or per
  creator) and the other one in the same run. A file Pawchive answers 404 for is failed and
  is not retried by a creator's download or a timer; downloading the post by hand (⋯ →
  Download) asks for it again. A spent quota pauses without failing.
- **Cover and text** come with a post's files: the cover (`0.*`) from the source most of
  them came from, the text (`content.txt`) once, again only when the post is updated. Neither
  holds a post open, and "Got from" counts the files alone. A post folder appears with its
  first saved file.
- **An image shown twice** in a post (two names, the same bytes) is saved once, and both
  files point at it. Pawchive keeps such bytes once and may never serve the second name,
  while Fanbox lists both: a file whose content hash matches a saved one is not fetched,
  and a download that turns out identical to one is dropped.
- **Where files go.** As in v1, every download is saved under the download folder by the
  folder templates. Post folders moved elsewhere by hand (to an archive drive) are never
  written to; a file a moved post still needs lands in a fresh folder under the download
  folder. The last folder a post was saved to is kept for thumbnails and the post page.
- **Updated posts.** A file already on disk is fetched beside it and replaces it only if
  the bytes differ. Under `update_policy` `keep` (the default) the post folder is first
  copied aside once, as `<folder> [old <date of its newest file>]`; `overwrite` replaces in
  place. Covers alone never trigger a copy, since the two sources' covers always differ.
- **Links** to cloud storage (Google Drive, MEGA, gigafile… set in `link_domains`) are
  collected from post text on every sync and listed under Links, to mark done or skipped.
  A check that finds a link dead marks it failed (unless its files were fetched); one that
  finds a failed link alive again makes it new.
  A host plugs in to check a link (alive / dead / unknown) or fetch it, or both; the hooks
  are in `app/domain/links.py`, the hosts in `app/sources/linkhosts/`, listed in
  `app/engine/links.py`. Google Drive, MEGA and Dropbox (files and folders; a Dropbox
  folder arrives as one zip) do both; GigaFile links are checked only (an expired one shows
  the upload page). OneDrive links have no checker. Checks and
  fetches run as jobs; a fetch saves into the post's download folder under `links/` and
  marks the link done. For a MEGA link posted without its key, a check or fetch tries the
  keys the post's text offers (the same link written with its key, or a key-shaped string
  after it) and keeps the one that opens it; otherwise Links asks for the key, the likeliest
  candidate filled in.
  `import-v1` carries over v1's reviewed creators.
- **Syncs** read both sources the same way. A list shorter than before is read again, and
  posts count as deleted only when both reads agree.
- **Site status** (Fanbox or Patreon) of every saved creator is checked in the background
  every 7 days.
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

## Patreon

A `patreon_*` creator's own site is Patreon, read through its JSON API; in the data and the
code it takes Fanbox's place (source `fanbox`, the campaign id in `fanbox_creator_id`), and
the page names it Patreon. Lists and free posts need no login; for paid posts sign in from
Settings (**Patreon session**) or paste the `session_id` cookie (`PATREON_SESSION_ID` in
the environment wins). The cookie is sent to the API only, never to the file hosts. File
addresses expire, so a download asks for the post again first. Videos are HLS streams,
joined into `.mp4` by [ffmpeg](https://ffmpeg.org/) on PATH (or `ffmpeg_path`).

## Migrations

Plans are previewed before they run. **Adopt** claims folders from the "Pixiv Fanbox
Downloader" extension (`fanbox/{fee}/[YYYY.MM.DD] {title}/`), working out its time zone from
the data. **Rename** re-applies the post folder template.

## Configuration

Settings are edited in the page and saved in `data/config.json`; `PAWCHIVE_<SETTING>` in
`.env` wins (see `.env.example`).

## Checks

```powershell
uv run ruff check; uv run ruff format --check
uv run basedpyright; uv run pytest
```
