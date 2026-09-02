# jable-downloader

Downloads HLS/m3u8 videos (with cover images) from [Jable.tv](https://jable.tv) — either a single video page or every video on a model page. Segments merge with `ffmpeg` and can be spread across a pool of local Clash proxy instances.

## Install

```bash
pip install -r requirements.txt
```

`ffmpeg` must be on `PATH`. Chrome + a matching driver are required (Selenium). Proxy settings live in `config.json` (optional).

## Usage

Interactive menu (no arguments):

```bash
python main.py
```

Direct CLI:

```bash
python main.py <url> [options]
```

| Option | Description | Default |
|---|---|---|
| `url` | Video URL or model page URL (omit for the interactive menu) | — |
| `-p, --path` | Output folder | current dir |
| `--sort` | Model page sort: `best`, `latest`, `views`, `favorites` | site default |
| `--limit` | Max videos to download (model pages) | all |
| `--template` | Folder naming template: `{video_id}`, `{title}`, `{artist}` | `{video_id}` |
| `--no-confirm` | Skip the confirmation prompt (model pages) | off |

### Example

```bash
python main.py https://jable.tv/videos/abcd-123/ -p F:/Download
python main.py https://jable.tv/models/xxx/ --sort favorites --limit 20 --no-confirm
```

Importable: `from main import download_video, download_artist`.
