# jable-downloader

Downloads HLS videos and their covers from [Jable.tv](https://jable.tv): one video page, or every
video on a model page.

## Run

Requires Python 3.14, `ffmpeg` on `PATH` and Chrome; dependencies are in `pyproject.toml`.

```bash
python main.py                    # interactive menu
python main.py <url> [options]
```

| Option | Description | Default |
|---|---|---|
| `url` | Video or model page URL | — |
| `-p, --path` | Output folder | current dir |
| `--sort` | Model page sort: `best`, `latest`, `views`, `favorites` | site default |
| `--limit` | Max videos to download (model pages) | all |
| `--template` | Folder name template: `{video_id}`, `{title}`, `{artist}` | `{video_id}` |
| `--no-confirm` | Skip the confirmation prompt (model pages) | off |

## Configuration

`config.json` (see `config.example.json`) can spread segment downloads over local Clash
instances: each takes three consecutive ports from `base_port` (HTTP, SOCKS, controller).
