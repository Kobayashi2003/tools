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
| `--retry` | Retry each resource until it succeeds | off |
| `-w, --workers` | Concurrent downloads | `4` |

`KHINSIDER_PROXY` is the proxy for the browser and the downloads alike: a URL, or `none` for
direct; empty (the default) uses `HTTPS_PROXY` / `HTTP_PROXY`, else the Windows system proxy.
