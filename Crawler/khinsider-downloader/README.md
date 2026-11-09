# khinsider-downloader

Downloads game soundtrack albums from [KHInsider](https://downloads.khinsider.com) in MP3 and/or
FLAC, with booklet images and multi-CD layouts.

## Run

Requires [uv](https://docs.astral.sh/uv/) and Chrome, Edge or Firefox; dependencies are in `pyproject.toml`.

```bash
uv run main.py <album_url> [<album_url> ...] [options]
```

| Option | Description | Default |
|---|---|---|
| `-o, --output` | Output directory | `downloads` |
| `-f, --format` | `mp3`, `flac`, `both` | `both` |
| `-b, --browser` | `chrome`, `edge`, `firefox`, `auto` | `auto` |
| `--headless` | Run the browser headless | off |
| `--no-booklet` | Skip booklet images | off |
| `--no-proxy` | Connect directly (browser and downloads) instead of through the system proxy | off |
| `--retry` | Retry each resource until it succeeds | off |
| `-w, --workers` | Concurrent downloads | `4` |
